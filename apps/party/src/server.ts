import type * as Party from 'partykit/server';
import {
  BOT,
  BOT_PROFILES,
  COFFEE,
  DEFAULT_MAP_ID,
  GAME_CHANGES,
  MATCH,
  MAX_PLAYERS,
  NPCS,
  PLAYER,
  SOCIAL,
  SNAPSHOT_MS,
  TICK_MS,
  WEAPON,
  decode,
  encode,
  horizontalDistanceToCoffee,
  isBotDifficulty,
  isMapId,
  npcById,
  setActiveMap,
  type BotDifficulty,
  type ClientMessage,
  type GameEvent,
  type GameSnapshot,
  type NpcDef,
  type Pose,
  type ServerMessage,
  type TranscriptLine,
  type Vec3,
  raycastObstacles,
} from '@slipstream-npc/shared';
import {
  advancePoseTransition,
  applyAgentPose,
  applyInput,
  clearPose,
  finishReload,
  integrateIdle,
  maybeRespawn,
  pushPositionHistory,
  regenHealth,
  tickVault,
  tryDrinkCoffee,
  tryFire,
  type NpcAlert,
} from './simulation.js';
import { initialPlayer, randomSpawn, type ServerPlayer } from './state.js';
import { ensureBotDefaults, tickBot } from './bots/controller.js';
import { adoptHostility, clearHostility, pruneHostility } from './social.js';
import { GameStorage, type NpcStateEntry } from './storage.js';
import { VoiceOrchestrator, npcDefToCandidate } from './voice/orchestrator.js';
import type { ArbCandidate } from './voice/arbitration.js';

export const CONSENT_VERSION = 'v1';

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const constantTimeEqual = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
};

// Structured-event sink for the feedback pipeline. One JSON line per event
// goes to stdout with a `[EVENT]` prefix so the report parser (which greps
// PartyKit's mixed stdout) can extract them cleanly. In prod this becomes a
// real telemetry sink; in dev we tee `pnpm dev` to a JSONL file.
type FeedbackEvent =
  | { kind: 'tool_call'; tool: string; npcId: string; playerName: string; args?: Record<string, unknown>; ok: boolean }
  | { kind: 'voice_session'; phase: 'start' | 'end'; npcId: string; playerName: string; sessionId: string; durationMs?: number; reason?: string }
  | { kind: 'hostility_change'; npcId: string; towardsName: string; op: 'set' | 'clear' | 'expire' | 'cascade'; source: 'damage' | 'tool' | 'tick'; until?: number }
  | { kind: 'shot_fired'; shooterId: string; shooterIsBot: boolean; shooterNpcId?: string | null; targetName: string | null; hit: boolean; killed: boolean }
  | { kind: 'friendship_change'; npcId: string; playerName: string; delta: number; newScore: number; becameFriend: boolean }
  | { kind: 'nav_blocked'; npcId: string; goal: readonly [number, number, number]; state: string }
  | { kind: 'feedback_signal'; playerName: string; trigger: string; text: string; npcId?: string; sessionId?: string }
  // Phase 2 scene-transcript line. Emitted on every finalized utterance from
  // any human player's Deepgram stream, regardless of which NPC (if any) is
  // in conversation with them. Distinct from a ConvAI `transcript` ringing
  // through the legacy path — those are stored as per-(npc, player) memory.
  // This event is the source of truth for "who said what when" in a
  // multi-speaker room and feeds the Phase 3 arbitration prompt.
  | { kind: 'scene_transcript'; speakerName: string; text: string; at: number }
  // Phase 3 decoupled-NPC turn telemetry. arbitration_pick fires when the
  // turn-state machine picks an NPC; npc_turn_start fires when the LLM
  // request is issued; npc_first_audio carries the silence→first-audio
  // latency; npc_turn_end / cancelled / error close the bracket. All five
  // are useful in the feedback report and the verification latency target
  // (1.8s p50 silence→first audio) is measured off npc_first_audio.t.
  | { kind: 'arbitration_pick'; npcId: string; score: number; reasons: string[] }
  | { kind: 'arbitration_empty'; sceneLineCount: number; candidateCount: number }
  | { kind: 'arbitration_no_winner'; sceneLineCount: number; candidateCount: number; sceneSample: string }
  | { kind: 'vad_transition'; playerName: string; speaking: boolean }
  | { kind: 'npc_turn_start'; npcId: string; utteranceId: string; sceneLineCount: number }
  | { kind: 'npc_first_audio'; npcId: string; utteranceId: string; firstChunkMs: number }
  | { kind: 'npc_turn_end'; npcId: string; utteranceId: string; durationMs: number; text?: string }
  | { kind: 'npc_turn_cancelled'; npcId: string; utteranceId: string; reason: string }
  | { kind: 'npc_turn_aborted'; npcId: string; utteranceId: string; reason: string }
  | { kind: 'npc_turn_error'; npcId: string; utteranceId: string; message: string };

// Ring buffer caps. Each lives on the Server instance (per-room) — in
// prod each Cloudflare DO is its own isolate so module-level state is
// already per-room, but `partykit dev` runs every room in one shared
// workerd process, so module-level state bleeds across rooms (fps_shooter
// utterances showing up in arena's session:last output, etc.). Instance
// fields fix the dev experience without changing prod behavior.
const RECENT_EVENT_CAP = 1000;
const SCENE_LINE_CAP = 500;
const BOT_COFFEE_TRAVEL_TIMEOUT_MS = 60_000;

// Phase 2 scene transcript line — one entry per finalized Deepgram result.
// Partials (low-latency interim hypotheses) are not persisted; they're
// useful for live captions but would saturate the buffer.
interface SceneLine {
  at: number;
  speakerName: string;
  text: string;
}

// Per-connection cooldown for Deepgram token mints. The Deepgram token TTL
// is ~30s; minting more often than that just burns API calls and would let
// a misbehaving client churn the project budget. 25s gives a small renewal
// overlap window before each token expires. This map IS still module-level
// — connection ids are globally unique so no bleed between rooms.
const STT_TOKEN_MIN_INTERVAL_MS = 25_000;
const lastSttMint = new Map<string, number>();

// Trigger phrases that flag a player utterance for the feedback report. Each
// entry is a /pattern/ + short label; the report's LLM pass refines these
// into structured items. Conservative on purpose — false negatives are fine
// (the LLM picks them up), false positives clutter the report.
const FEEDBACK_TRIGGERS: { re: RegExp; label: string }[] = [
  { re: /\b(bug|broken|busted)\b/i, label: 'bug' },
  { re: /\b(stuck|wedge|wedged|pinned)\b/i, label: 'stuck' },
  { re: /\b(doesn'?t work|not working|isn'?t working|won'?t work)\b/i, label: 'not-working' },
  { re: /\b(need(s)? to fix|gotta fix|have to fix|got to fix)\b/i, label: 'fix-needed' },
  { re: /\b(should (probably|just|really|maybe)|i should)\b/i, label: 'should' },
  { re: /\b(issue with|problem with|trouble with)\b/i, label: 'issue' },
  // Bare `wrong` over-matches in-character roleplay ("what's wrong with your
  // shoulder?"). Require a contextual modifier so the trigger fires on dev
  // observations, not roleplay questions.
  { re: /\b(something|that(?:'s| is)?|this is)\s+(weird|strange|odd|wrong|broken|off)\b/i, label: 'anomaly' },
  { re: /\b(want(s)? to (be able to|have)|wish|it would be (cool|nice|great))\b/i, label: 'feature' },
];

const matchFeedbackTrigger = (text: string): string | null => {
  for (const { re, label } of FEEDBACK_TRIGGERS) if (re.test(text)) return label;
  return null;
};

// Human-friendly elapsed time for the memoryBlob "## Time since you last
// talked" section. The LLM uses this to phrase the gap naturally; the client
// independently uses the raw ms for greeting-bucket selection.
const formatElapsed = (ms: number): string => {
  if (ms < 60_000) return `${Math.round(ms / 1000)} seconds`;
  if (ms < 3600_000) return `${Math.round(ms / 60_000)} minutes`;
  if (ms < 24 * 3600_000) return `${Math.round(ms / 3600_000)} hours`;
  return `${Math.round(ms / (24 * 3600_000))} days`;
};

// Format a per-NPC voice-session alert into a system-message string that the
// agent will receive via sendContextualUpdate. Square-bracketed prefix keeps
// these visually distinct from player speech in the transcript log.
const formatNpcAlert = (a: NpcAlert): string | null => {
  switch (a.kind) {
    case 'damaged':
      return a.killed
        ? `[System: ${a.shooterName} just killed you. You'll respawn shortly. React in character — your last words now.]`
        : `[System: ${a.shooterName} just shot you for ${a.damage} damage. You have ${a.hpAfter} HP left. They are now hostile to you. React in character.]`;
    case 'shot_fired': {
      const who = a.victimName ?? 'someone in the arena';
      if (a.killed) return `[System: You just killed ${who}. Recall why — either they attacked you/a friend, or you decided to attack them after a conversation. React accordingly.]`;
      if (a.hit) return `[System: You just shot ${who} and hit them. Recall why you're shooting: either they (or one of their friends) attacked you or a friend, or you decided to attack them after a conversation.]`;
      return `[System: You just fired at ${who} and missed. Recall why you're shooting: either they (or one of their friends) attacked you or a friend, or you decided to attack them after a conversation.]`;
    }
    case 'friend_attacked':
      return `[System: Your friend ${a.friendName} was just shot by ${a.attackerName}. You are now hostile to ${a.attackerName} on instinct. You may defend ${a.friendName}.]`;
    case 'kill_witnessed':
      return `[System: ${a.killerName} just killed ${a.victimName} somewhere else on the map. You noticed — gunfire carries. React only if it matters to you (a friend died, an enemy was put down, you have an opinion about either of them); otherwise just register it and move on.]`;
    case 'hostility_ended':
      return `[System: Your hostility toward ${a.targetName} has worn off. You're no longer angry at them. Resume normal conversation if they're in front of you.]`;
    case 'npc_befriended_player':
      return `[System: ${a.npcName} just became friends with ${a.playerName}. You know ${a.npcName} — react in character if it matters (suspicion, approval, indifference), or don't bring it up at all.]`;
    case 'player_reloaded':
      return `[System: ${a.playerName} just started reloading their rifle. They'll be defenseless for about a second and a half. You can comment on it or ignore it — but don't pretend you didn't hear the magazine drop.]`;
    case 'player_joined':
      return `[System: ${a.playerName} just walked into the arena. New face. You hear footsteps but they're not next to you yet.]`;
    case 'player_left':
      return `[System: ${a.playerName} just left the arena. The room got quieter.]`;
    case 'self_follow_started':
      return `[System: Your body just started following ${a.playerName}. You'll automatically walk to stay near them — you don't need to do anything to keep up. If asked whether you're following, say yes. If your feet "feel stuck," that perception is wrong; trust this system message.]`;
    case 'self_follow_stopped':
      if (a.source === 'auto') {
        return `[System: You've stopped following ${a.playerName} so you can take another physical action. You are no longer tethered to them.]`;
      }
      return `[System: You've stopped following ${a.playerName}. You're standing still or patrolling again.]`;
    case 'self_flee_started':
      return `[System: You've started fleeing from ${a.playerName}. Your body is moving away from them for ~30 seconds.]`;
    case 'self_attack_started':
      return a.source === 'damaged'
        ? `[System: You are now hostile to ${a.targetName} (they just attacked you). Your body will engage them on sight for ~30 seconds.]`
        : `[System: You're now hostile to ${a.targetName} after agreeing to attack them. Your body will engage them on sight for ~30 seconds.]`;
    case 'self_attack_stopped':
      return a.source === 'expire'
        ? `[System: Your hostility toward ${a.targetName} has worn off (the 30-second window expired). You're not angry at them anymore.]`
        : `[System: You've lowered your weapon for ${a.targetName}. They're no longer a threat from your side.]`;
    case 'self_befriended_player':
      return `[System: You and ${a.playerName} are now friends. This persists across sessions and across rounds.]`;
    case 'self_patrol_started':
      return a.sprint
        ? `[System: You're now sprint-patrolling — moving fast between waypoints across the map, exploring. Any prior follow / flee / lean was cleared. Don't say you're stuck or still doing the old thing; you are now patrolling at a run.]`
        : `[System: You're now patrolling — walking the map naturally, exploring. Any prior follow / flee / lean / sprint was cleared. Don't say you're stuck or still doing the old thing; you are now patrolling.]`;
    case 'self_lean_started':
      return `[System: You're walking ${a.distM.toFixed(1)}m to the nearest wall to lean against it. Once you arrive your body will be committed to the lean pose — back to the wall, weight shifted, casual. Don't claim you're already leaning until this resolves.]`;
    case 'self_lean_no_wall':
      return `[System: You wanted to lean against a wall, but there's no wall close enough to walk to. Tell the player honestly that there's nothing to lean on right here.]`;
    case 'coffee_consumed':
      // Per-NPC tailoring is dispatched in dispatchNpcAlert — Guts gets a
      // line that calls back to his coffee-price grumble. This default fires
      // for everyone else.
      return `[System: You see ${a.drinkerName} drinking from the free coffee maker. React naturally if it fits — short observation, dry comment, a question — or just register it.]`;
    case 'self_coffee_started':
      return `[System: You are now physically walking to the free coffee maker. Your body has disengaged from the conversation/follow state for this action. Do not say you are stuck or still following the player; you are on your way. Do not claim you drank until the next system message confirms it.]`;
    case 'self_drank_coffee':
      return `[System: You just walked over to the free coffee maker and had a cup. Brief restorative buzz, a bit of health back. React in character if it fits the moment — savor it, complain about how it tastes free, deflect — or move on.]`;
    case 'self_coffee_unreachable':
      return `[System: You tried to go drink coffee but couldn't reach the maker in time (path blocked, or something pulled you away). The drink didn't happen.]`;
    default:
      return null;
  }
};

// Guts has been complaining about coffee prices in his persona since day one
// (see npc-roster.ts — Topics: "the price of coffee"). When he sees someone
// drinking from the free maker, that's the narrative beat to lean into.
const formatCoffeeAlertForGuts = (drinkerName: string): string => {
  return `[System: ${drinkerName} is at the free coffee maker. Free. You've been complaining about the price of coffee for as long as anyone wants to hear, and now there's one for free in the middle of the arena. React in character — dry, suspicious, maybe quietly satisfied without admitting it.]`;
};

export default class SlipstreamServer implements Party.Server {
  readonly options: Party.ServerOptions = {
    hibernate: false,
  };

  private players = new Map<string, ServerPlayer>();
  // Pending fires queued during input dispatch, drained once per tick. We
  // hold the camera-resolved aim alongside the player id so tryFire can
  // cast from the camera origin instead of the player's eye, fixing the
  // third-person parallax that lets ledges block what the reticle clears.
  // null payload → fall back to eye + yaw/pitch (older clients, bots, or
  // any frame whose camera ray we couldn't compute).
  private pendingFire = new Map<string, { aimOrigin: Vec3; aim: Vec3 } | null>();
  private events: GameEvent[] = [];
  private tick = 0;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private snapshotTimer: ReturnType<typeof setInterval> | null = null;
  private startedAt = 0;
  // Match-mode state. killTarget is locked the moment the room first gets
  // a player (the first joiner picks via ?killTarget=); subsequent joiners
  // can't change it. Winner+resetAt set together when someone hits the
  // target; resetAt fires once and clears both, starting a fresh round.
  private killTarget: number = MATCH.defaultKillTarget;
  private killTargetLocked = false;
  // Bot count is locked alongside killTarget by the first joiner. Locked
  // separately so refreshing the host doesn't change the in-progress match.
  private botCount: number = MATCH.defaultBotCount;
  private botCountLocked = false;
  private botDifficulty: BotDifficulty = MATCH.defaultBotDifficulty;
  // Locked alongside botCount. Empty until first joiner — spawnBots reads it
  // for slot order. URL param ?npcIds=a,b,c; missing/empty falls back to
  // NPCS.slice(0, botCount).
  private roster: NpcDef[] = [];
  private rosterLocked = false;
  private winnerId: string | null = null;
  private resetAt: number | null = null;
  // Voice state lives in PartyKit room.storage (Cloudflare Durable Object).
  // Survives room restarts and reconnects. GameStorage is a thin write-back
  // cache; reads are cheap once warm, writes go through to disk.
  private store: GameStorage;
  // Local cache of "this player has agreed in this connection" — separate
  // from store.consent so we don't do an async lookup on the hot transcript
  // path. Cleared on disconnect. The storage record is the source of truth.
  private liveConsent = new Set<string>();
  // sessionId → wall-clock start, used to compute durationMs at session end
  // for the feedback pipeline. Not part of game state — pure telemetry.
  private voiceSessionStarts = new Map<string, number>();
  // Per-room feedback-event ring buffer. Was module-level; moved to
  // instance state so partykit dev (which shares one workerd across all
  // rooms) doesn't mix events from fps_shooter into arena. In prod each
  // DO is its own isolate so behavior is identical.
  private recentEvents: (FeedbackEvent & { t: number })[] = [];
  // Per-room scene transcript ring buffer (same reasoning as above).
  private sceneTranscript: SceneLine[] = [];
  // Phase 3 decoupled NPC orchestrator. Owns the turn-state machine + the
  // LLM/TTS pipeline + audio broadcast. Created in onStart so room.env is
  // available; disposed in onClose-when-empty-room flows.
  private voice: VoiceOrchestrator;

  // Instance-scoped event emitter. Same contract as the previous module
  // function but pushes onto this room's buffer instead of a shared one.
  // The [EVENT] stdout line is left as-is so the dev-log grep workflow
  // still works.
  private emit(event: FeedbackEvent & { t?: number }): void {
    const full = { t: event.t ?? Date.now(), ...event };
    console.log('[EVENT]', JSON.stringify(full));
    this.recentEvents.push(full);
    if (this.recentEvents.length > RECENT_EVENT_CAP) this.recentEvents.shift();
  }

  constructor(readonly room: Party.Room) {
    this.store = new GameStorage(room.storage);
    this.voice = new VoiceOrchestrator({
      broadcast: (msg) => this.room.broadcast(encode<ServerMessage>(msg)),
      getDecoupledCandidates: () => this.decoupledArbCandidates(),
      getOtherNpcNames: (excludeId) => this.otherNpcNames(excludeId),
      buildSelfStateLine: (npcId) => this.buildSelfStateLine(npcId),
      getFriendshipScore: async (npcId, playerName) =>
        (await this.store.getFriendship(npcId, playerName)).score,
      getPersonaDeltas: (npcId) => this.store.getNpcState(npcId),
      getSpeakerPosition: (speakerName) => this.findSpeakerPosition(speakerName),
      getApiKeys: () => ({
        anthropic: this.room.env.ANTHROPIC_API_KEY as string | undefined,
        elevenlabs: this.room.env.ELEVENLABS_API_KEY as string | undefined,
      }),
      getMapId: () => (isMapId(this.room.id) ? this.room.id : DEFAULT_MAP_ID),
      emit: (event) => this.emit(event as FeedbackEvent),
      dispatchTool: (npcId, playerName, toolName, args) =>
        this.dispatchTool(npcId, playerName, toolName, args),
    });
  }

  onStart(): void {
    this.startedAt = Date.now();
    // The PartyKit room id IS the map id — Lobby's dropdown maps directly
    // onto room name. Unknown ids fall back to the default map so dev/test
    // rooms with arbitrary names still boot something playable.
    setActiveMap(isMapId(this.room.id) ? this.room.id : DEFAULT_MAP_ID);
    this.startTimers();
    // Fire-and-forget: seed any GAME_CHANGES not yet applied to this room's
    // NPC state. Idempotent — each change runs once per room thanks to
    // seeded:<id> flags. Async because storage writes are async; awaiting
    // isn't necessary since the seeded entries become visible on the next
    // session start's memoryBlob build.
    void this.seedGameChanges();
  }

  // Walk GAME_CHANGES, write any unseeded entries into each in-scope NPC's
  // state:<npcId> as persona deltas, then mark seeded:<id> so the next boot
  // doesn't re-fire them. The agent reads these at session start via
  // memoryBlob and treats them as authoritative current knowledge. See
  // packages/shared/src/game-changes.ts for the workflow.
  private async seedGameChanges(): Promise<void> {
    for (const change of GAME_CHANGES) {
      if (await this.store.isGameChangeSeeded(change.id)) continue;
      const targets =
        change.scope === 'all' ? NPCS.map((n) => n.id) : change.scope;
      for (const npcId of targets) {
        await this.store.appendNpcState(npcId, {
          at: change.at,
          summary: change.summary,
          ...(change.evidence ? { evidence: change.evidence } : {}),
          source: `game-change:${change.id}`,
        });
      }
      await this.store.markGameChangeSeeded(change.id);
      console.log(
        `[game-change] seeded ${change.id} → ${targets.length} NPC(s) in room ${this.room.id}`,
      );
    }
  }

  onConnect(conn: Party.Connection, ctx: Party.ConnectionContext): void {
    const url = new URL(ctx.request.url);

    // Reject mismatched map ids up front so the client can't silently end
    // up in a room whose physics differ from what the lobby promised.
    const queryMap = url.searchParams.get('mapId');
    const expected = isMapId(this.room.id) ? this.room.id : DEFAULT_MAP_ID;
    if (queryMap && queryMap !== expected) {
      conn.close(4002, `wrong map: room is ${expected}`);
      return;
    }

    // Optional access-code gate. If ACCESS_CODE is set in the room's env
    // (apps/party/.env in dev, `partykit env add` in prod), every
    // connection must present a matching ?accessCode= or the socket is
    // closed with code 4003. Unset = no gate (handy in CI / private LAN).
    // PartyKit exposes env on Room — process.env is NOT populated in the
    // Workers runtime, so reading from this.room.env is the only path that
    // works in both dev and prod.
    const required = (this.room.env.ACCESS_CODE as string | undefined) ?? '';
    if (required) {
      const provided = url.searchParams.get('accessCode') ?? '';
      if (provided !== required) {
        conn.close(4003, 'invalid access code');
        return;
      }
    }

    if (this.players.size >= MAX_PLAYERS) {
      conn.close(4001, 'room full');
      return;
    }
    const name = (url.searchParams.get('name') ?? 'Player').slice(0, 24) || 'Player';
    if (!this.killTargetLocked) {
      const raw = url.searchParams.get('killTarget');
      const parsed = raw == null ? NaN : Math.floor(Number(raw));
      if (Number.isFinite(parsed)) {
        this.killTarget = Math.max(
          MATCH.minKillTarget,
          Math.min(MATCH.maxKillTarget, parsed),
        );
      }
      this.killTargetLocked = true;
    }
    if (!this.botCountLocked) {
      const raw = url.searchParams.get('botCount');
      const parsed = raw == null ? NaN : Math.floor(Number(raw));
      if (Number.isFinite(parsed)) {
        this.botCount = Math.max(
          MATCH.minBotCount,
          Math.min(MATCH.maxBotCount, parsed),
        );
      }
      const rawDiff = url.searchParams.get('botDifficulty') ?? '';
      if (isBotDifficulty(rawDiff)) this.botDifficulty = rawDiff;
      const rawIds = url.searchParams.get('npcIds') ?? '';
      const parsedRoster: NpcDef[] = [];
      const seenIds = new Set<string>();
      for (const raw of rawIds.split(',')) {
        const id = raw.trim();
        if (!id || seenIds.has(id)) continue;
        const def = npcById(id);
        if (!def) continue;
        parsedRoster.push(def);
        seenIds.add(id);
        if (parsedRoster.length >= this.botCount) break;
      }
      this.roster =
        parsedRoster.length > 0 ? parsedRoster : NPCS.slice(0, this.botCount);
      this.rosterLocked = true;
      // Difficulty is locked alongside botCount — refreshing the host can't
      // soften live opponents mid-match.
      this.botCountLocked = true;
    }
    const player = initialPlayer(conn.id, conn.id, name, randomSpawn(), this.serverTime(), {
      isBot: false,
      characterId: 'soldier',
    });
    this.players.set(conn.id, player);
    this.spawnBots(this.serverTime());
    void this.hydrateFriendships(player);

    // If the room had emptied out, timers were stopped — restart them now.
    this.startTimers();

    this.send(conn, {
      type: 'welcome',
      you: player.id,
      serverTime: this.serverTime(),
    });
    this.broadcastSnapshot();

    // Anyone currently mid-session would notice a new human walking in.
    for (const bot of this.activeSessionBots()) {
      this.dispatchNpcAlert({
        kind: 'player_joined',
        targetConnId: bot.botConversationWith!,
        npcId: bot.npcId!,
        sessionId: bot.botActiveSessionId!,
        playerName: player.name,
      });
    }
  }

  private startTimers(): void {
    if (this.tickTimer === null) {
      this.tickTimer = setInterval(() => this.runTick(), TICK_MS);
    }
    if (this.snapshotTimer === null) {
      this.snapshotTimer = setInterval(() => this.broadcastSnapshot(), SNAPSHOT_MS);
    }
  }

  onMessage(raw: string, sender: Party.Connection): void {
    const player = this.players.get(sender.id);
    if (!player) return;

    let msg: ClientMessage;
    try {
      msg = decode<ClientMessage>(raw);
    } catch {
      return;
    }

    switch (msg.type) {
      case 'hello': {
        player.name = (msg.name ?? 'Player').slice(0, 24) || 'Player';
        return;
      }
      case 'input': {
        const now = this.serverTime();
        const frozen = this.winnerId !== null;
        for (const frame of msg.frames) {
          if (frame.seq <= player.lastSeenSeq) continue;
          // No firing while sprinting — silently demote sprint when fire is
          // pressed. Player walks-while-firing instead of running-while-firing.
          // Reloading at sprint speed is allowed; the client picks ReloadRun.
          // Also drop fire entirely while the round is in victory-freeze.
          let effectiveFrame =
            frame.fire && frame.sprint ? { ...frame, sprint: false } : frame;
          if (frozen && effectiveFrame.fire) {
            effectiveFrame = { ...effectiveFrame, fire: false };
          }
          // Casual mode: trigger is a no-op. Drop fire here so applyInput
          // never sees it, no pendingFire is recorded, no shot fires, and
          // the auto-engage-combat fire→clearPose path stays off. Players
          // explicitly switch to combat (Y on keyboard / B on gamepad)
          // before they can shoot. Mirrors the client-side gate in
          // LocalPlayer.tsx so haptic/dry-fire stay quiet too.
          if (effectiveFrame.fire && player.pose === 'casual_idle') {
            effectiveFrame = { ...effectiveFrame, fire: false };
          }
          const wasReloading = player.reloading;
          applyInput(player, effectiveFrame, now);
          // Reload start (false → true). If this human is mid-conversation
          // with any NPC, tell that agent — the magazine drop is audible
          // and the player is briefly defenseless.
          if (!wasReloading && player.reloading && !player.isBot) {
            for (const bot of this.activeSessionBots()) {
              if (bot.botConversationWith !== sender.id) continue;
              this.dispatchNpcAlert({
                kind: 'player_reloaded',
                targetConnId: bot.botConversationWith,
                npcId: bot.npcId!,
                sessionId: bot.botActiveSessionId!,
                playerName: player.name,
              });
            }
          }
          if (effectiveFrame.fire) {
            const aim =
              effectiveFrame.aimOrigin && effectiveFrame.aim
                ? { aimOrigin: effectiveFrame.aimOrigin, aim: effectiveFrame.aim }
                : null;
            this.pendingFire.set(player.id, aim);
          }
          if (effectiveFrame.interact) {
            void this.handleInteract(player, now);
          }
        }
        return;
      }
      case 'chat': {
        const text = (msg.text ?? '').slice(0, 200);
        if (!text.trim()) return;
        this.events.push({
          type: 'chat',
          fromId: player.id,
          fromName: player.name,
          text,
          at: this.serverTime(),
        });
        return;
      }
      case 'ping': {
        this.send(sender, { type: 'pong', t: msg.t, serverTime: this.serverTime() });
        return;
      }
      case 'consent': {
        if (!msg.agreed) return;
        const playerName = player.name;
        this.liveConsent.add(playerName);
        void this.store.setConsent(playerName, {
          version: msg.version,
          agreedAt: Date.now(),
        });
        return;
      }
      case 'voice_session_start': {
        // Bind the player to the NPC immediately so the bot freezes and
        // faces them on the next tick — don't wait for handleVoiceSessionStart
        // to finish minting the signed URL.
        for (const p of this.players.values()) {
          if (p.isBot && p.npcId === msg.npcId) {
            p.botConversationWith = sender.id;
            p.botActiveSessionId = msg.sessionId;
          }
        }
        this.voiceSessionStarts.set(msg.sessionId, Date.now());
        this.emit({
          kind: 'voice_session',
          phase: 'start',
          npcId: msg.npcId,
          playerName: player.name,
          sessionId: msg.sessionId,
        });
        void this.handleVoiceSessionStart(player.name, msg.npcId, msg.sessionId, sender);
        return;
      }
      case 'voice_session_end': {
        const startedAt = this.voiceSessionStarts.get(msg.sessionId);
        this.voiceSessionStarts.delete(msg.sessionId);
        const endedAt = Date.now();
        for (const p of this.players.values()) {
          if (p.isBot && p.botConversationWith === sender.id) {
            this.emit({
              kind: 'voice_session',
              phase: 'end',
              npcId: p.npcId ?? 'unknown',
              playerName: player.name,
              sessionId: msg.sessionId,
              reason: msg.reason ?? 'manual',
              ...(startedAt ? { durationMs: endedAt - startedAt } : {}),
            });
            if (p.npcId) {
              void this.store.setLastSessionEnd(p.npcId, player.name, endedAt);
            }
            p.botConversationWith = null;
            p.botActiveSessionId = null;
          }
        }
        return;
      }
      case 'transcript': {
        const playerName = player.name;
        const handle = (): void => {
          if (msg.npcId) {
            // Legacy ConvAI per-NPC transcript path. Persists to durable
            // per-(npc, player) storage so the NPC remembers across sessions.
            this.acceptTranscript(msg.npcId, playerName, msg.line);
            return;
          }
          // Phase 2 scene transcript: room-wide, multi-speaker. Only finals
          // go into the ring buffer — partials are useful for live captions
          // and (future) interrupt detection but would flood the buffer.
          if (msg.final !== false) {
            this.acceptSceneTranscript(
              msg.speakerName ?? playerName,
              msg.line,
            );
          }
        };
        if (!this.liveConsent.has(playerName)) {
          void this.store.getConsent(playerName).then((rec) => {
            if (!rec) return;
            this.liveConsent.add(playerName);
            handle();
          });
          return;
        }
        handle();
        return;
      }
      case 'stt_token_request': {
        void this.handleSttTokenRequest(sender);
        return;
      }
      case 'set_pose': {
        // Local-player pose change. Uses the same smart-transition helper as
        // the /tools/set_pose webhook so the client doesn't have to know to
        // play stand_up before sit→null — the server derives it from the
        // current pose. The explicit `transition` field on the message is
        // ignored; applyAgentPose owns the transition state machine.
        applyAgentPose(
          player,
          msg.pose,
          msg.danceVariant ?? 0,
          this.serverTime(),
        );
        return;
      }
      case 'voice_state': {
        // Mirror the sender's VAD + mute state into their PlayerState. The
        // values ride along on the next snapshot so every other client can
        // drive the SpeakerHUD + nameplate badges. Sent debounced from the
        // client (transitions only), so this is cheap.
        const livelySpeaking = msg.speaking && !msg.mutedManual;
        player.voiceSpeaking = livelySpeaking;
        player.voiceMutedByVad = msg.mutedByVad;
        player.voiceMutedManual = msg.mutedManual;
        // Phase 3: the same transition drives the decoupled-NPC turn-state
        // machine. Manual-mute suppresses VAD entirely so we don't trigger
        // arbitration while the player is intentionally silent.
        this.voice.onSpeakingChange(sender.id, livelySpeaking);
        // Diagnostic: emit on every VAD transition so pnpm session:last
        // surfaces whether the player's speech is reaching the server at
        // all. Phase 5 will remove this once the pipeline is verified.
        this.emit({
          kind: 'vad_transition',
          playerName: player.name,
          speaking: livelySpeaking,
        });
        return;
      }
      case 'webrtc_signal': {
        // Dumb relay: forward to the addressed peer if they're connected and
        // human. PartyKit's getConnection returns the Connection by id; the
        // peers' connection ids are the same as PlayerState.id (assigned in
        // onConnect). Drop silently for bots or unknown peers — there's no
        // peer to negotiate with.
        const targetConn = this.room.getConnection(msg.to);
        if (!targetConn) return;
        const targetPlayer = this.players.get(msg.to);
        if (!targetPlayer || targetPlayer.isBot) return;
        this.send(targetConn, {
          type: 'webrtc_signal',
          from: sender.id,
          signal: msg.signal,
        });
        return;
      }
    }
  }

  onClose(conn: Party.Connection): void {
    // Drop the closer from the Phase 3 turn-state machine so a crashed
    // client doesn't pin the room in HUMAN_SPEAKING forever waiting on
    // silence from a dead VAD.
    this.voice.onCloseConnection(conn.id);
    // Release any bot still bound to this player as a conversation partner,
    // and break any follow/flee bindings keyed off this conn.
    const closer = this.players.get(conn.id);
    const closerName = closer?.name ?? 'unknown';
    // Tell every bot in a live session — except the one whose session is
    // about to end because the closer was its conversation partner — that
    // this player just left. The "their partner left" case is signaled by
    // the existing voice_session end event, not a player_left alert.
    if (closer && !closer.isBot) {
      for (const bot of this.activeSessionBots()) {
        if (bot.botConversationWith === conn.id) continue;
        this.dispatchNpcAlert({
          kind: 'player_left',
          targetConnId: bot.botConversationWith!,
          npcId: bot.npcId!,
          sessionId: bot.botActiveSessionId!,
          playerName: closerName,
        });
      }
    }
    for (const p of this.players.values()) {
      if (p.isBot && p.botConversationWith === conn.id) {
        // Voice session was in flight when the WS dropped. Emit a synthetic
        // end event so the feedback pipeline doesn't silently lose it, and
        // record the end time for the sense-of-time bucket.
        const sid = p.botActiveSessionId;
        const endedAt = Date.now();
        if (sid) {
          const startedAt = this.voiceSessionStarts.get(sid);
          this.voiceSessionStarts.delete(sid);
          this.emit({
            kind: 'voice_session',
            phase: 'end',
            npcId: p.npcId ?? 'unknown',
            playerName: closerName,
            sessionId: sid,
            reason: 'connection_closed',
            ...(startedAt ? { durationMs: endedAt - startedAt } : {}),
          });
          if (p.npcId && closer && !closer.isBot) {
            void this.store.setLastSessionEnd(p.npcId, closerName, endedAt);
          }
        }
        p.botConversationWith = null;
        p.botActiveSessionId = null;
      }
      if (p.isBot && p.botFollowing === conn.id) {
        p.botFollowing = null;
        p.botFollowMoving = false;
        p.botFollowHoldUntil = undefined;
      }
      if (p.isBot && p.botFleeingFrom?.id === conn.id) {
        p.botFleeingFrom = null;
      }
    }
    this.players.delete(conn.id);
    this.pendingFire.delete(conn.id);
    // If the only humans are gone, drop the bots too — no point simulating an
    // empty arena. They respawn with the next human via spawnBots().
    if (this.humanCount() === 0) {
      this.removeAllBots();
    }
    if (this.players.size === 0) {
      this.stopTimers();
      // Empty room — release the killTarget and botCount locks so the next
      // first-joiner can pick fresh values.
      this.killTargetLocked = false;
      this.botCountLocked = false;
      this.winnerId = null;
      this.resetAt = null;
    }
  }

  // Iterate every bot that currently has a live voice session. Used by the
  // mid-session alert paths (kill_witnessed, hostility_ended, etc.) to find
  // which agents need to be notified.
  private *activeSessionBots(): Generator<ServerPlayer> {
    for (const p of this.players.values()) {
      if (p.isBot && p.botConversationWith && p.botActiveSessionId) yield p;
    }
  }

  // Send one npc_alert to the connection that owns this bot's voice session.
  // No-ops if the conn dropped between alert emission and dispatch, or if
  // the formatter doesn't recognize the alert kind.
  private dispatchNpcAlert(alert: NpcAlert): void {
    const conn = this.room.getConnection(alert.targetConnId);
    if (!conn) return;
    const text =
      alert.kind === 'coffee_consumed' && alert.npcId === 'guts'
        ? formatCoffeeAlertForGuts(alert.drinkerName)
        : formatNpcAlert(alert);
    if (!text) return;
    this.send(conn, {
      type: 'npc_alert',
      npcId: alert.npcId,
      sessionId: alert.sessionId,
      text,
    });
  }

  private humanCount(): number {
    let n = 0;
    for (const p of this.players.values()) {
      if (!p.isBot) n += 1;
    }
    return n;
  }

  // Coffee-maker interaction. Drives the DrinkEvent broadcast, NPC alerts to
  // anyone in earshot or in an active session with the drinker, the caffeine
  // contextual update for the drinker's own live session (if any), and the
  // first-drink persona-delta cascade across the whole roster.
  //
  // tryDrinkCoffee owns the rules (proximity) and the state mutation; this
  // method owns the side effects.
  private async handleInteract(player: ServerPlayer, now: number): Promise<void> {
    this.doCoffeeDrink(player, now);
  }

  // Shared drink path used by both human-input and bot-tool flows. Runs
  // tryDrinkCoffee (the gameplay effect: heal + buff), then fans
  // out the side effects:
  //   - broadcast DrinkEvent so every client animates the drinker
  //   - dispatch coffee_consumed alerts to NPCs in nearby active sessions
  //   - if the drinker IS a bot, push self_drank_coffee to its own session
  //     so the agent confirms its body just had coffee
  //   - if the drinker is a human in a live session, push the caffeine
  //     talk-faster contextual update to their voice partner
  // The persona-delta "the maker exists" is seeded once at onStart via
  // GAME_CHANGES — this method only emits live event reactions.
  private doCoffeeDrink(drinker: ServerPlayer, now: number): boolean {
    const result = tryDrinkCoffee(drinker, now);
    if (!result) return false;
    this.events.push(result.event);

    const seenBots = new Set<string>();
    for (const bot of this.activeSessionBots()) {
      if (!bot.npcId) continue;
      // Skip the drinker itself when fanning out the "I saw it" reaction —
      // bots that drank get a self_drank_coffee alert instead.
      if (bot.id === drinker.id) continue;
      const isPartner = bot.botConversationWith === drinker.connectionId;
      const dist = horizontalDistanceToCoffee(bot.position);
      const inEarshot = dist <= COFFEE.observationRadius;
      if (!isPartner && !inEarshot) continue;
      if (seenBots.has(bot.id)) continue;
      seenBots.add(bot.id);
      this.dispatchNpcAlert({
        kind: 'coffee_consumed',
        targetConnId: bot.botConversationWith!,
        npcId: bot.npcId,
        sessionId: bot.botActiveSessionId!,
        drinkerName: drinker.name,
      });
    }

    if (drinker.isBot && drinker.npcId && drinker.botConversationWith && drinker.botActiveSessionId) {
      // Bot drank while in a live session — close its perception loop so
      // the LLM knows the body just had coffee.
      this.pushSelfStateAlert(drinker, { kind: 'self_drank_coffee' });
    }
    if (!drinker.isBot) {
      // Caffeine talk-faster nudge for the human drinker's voice partner.
      for (const bot of this.activeSessionBots()) {
        if (bot.botConversationWith !== drinker.connectionId) continue;
        if (!bot.npcId || !bot.botActiveSessionId) continue;
        const conn = this.room.getConnection(drinker.connectionId);
        if (!conn) continue;
        this.send(conn, {
          type: 'npc_alert',
          npcId: bot.npcId,
          sessionId: bot.botActiveSessionId,
          text:
            '[System: Your conversation partner just took a hit of caffeine. For the next two minutes, match their energy — talk faster, shorter sentences, more clipped responses. This is a stylistic note. Do not mention the coffee unless they bring it up.]',
        });
      }
    }
    return true;
  }

  // Per-tick check: each bot that called drink_coffee gets a bounded travel
  // window to reach the maker. On arrival within COFFEE.interactRadius we
  // invoke doCoffeeDrink (same side effects as a human press). On expiry we
  // fire a self_coffee_unreachable alert so the agent knows the drink
  // didn't happen and clears the goal so the bot returns to patrol.
  private tickBotCoffeeGoals(now: number): void {
    for (const p of this.players.values()) {
      if (!p.isBot) continue;
      if (p.botGoingForCoffeeUntil === undefined) continue;
      const deadline = p.botGoingForCoffeeUntil;
      const wallNow = Date.now();
      const dist = horizontalDistanceToCoffee(p.position);
      if (dist <= COFFEE.interactRadius) {
        const drank = this.doCoffeeDrink(p, now);
        p.botGoingForCoffeeUntil = undefined;
        if (!drank) {
          // tryDrinkCoffee bounced (e.g. reloading / vaulting / dead) —
          // surface that to the agent so it doesn't think the drink landed.
          if (p.npcId && p.botConversationWith && p.botActiveSessionId) {
            this.pushSelfStateAlert(p, { kind: 'self_coffee_unreachable' });
          }
        }
        continue;
      }
      if (wallNow >= deadline) {
        p.botGoingForCoffeeUntil = undefined;
        p.botGoal = null;
        p.botPath = undefined;
        p.botPathIdx = 0;
        if (p.npcId && p.botConversationWith && p.botActiveSessionId) {
          this.pushSelfStateAlert(p, { kind: 'self_coffee_unreachable' });
        }
      }
    }
  }

  private spawnBots(now: number): void {
    const desired = Math.min(this.botCount, MAX_PLAYERS - this.humanCount());
    let existingBots = 0;
    for (const p of this.players.values()) if (p.isBot) existingBots += 1;
    const toAdd = Math.max(0, desired - existingBots);
    // Each NPC is pinned to a specific character model (NpcDef.characterId),
    // so identity is stable across matches — Mira is always the Eve body,
    // Guts is always the Soldier body, etc. Skip personas that already have
    // a bot in the room. Iterate the locked roster (chosen by the first
    // joiner) so the lobby's slot order is authoritative.
    const taken = new Set<string>();
    for (const p of this.players.values()) {
      if (p.isBot && p.npcId !== undefined) taken.add(p.npcId);
    }
    const roster = this.roster.length > 0 ? this.roster : NPCS;
    const free: NpcDef[] = roster.filter((n) => !taken.has(n.id));
    const slots = Math.min(toAdd, free.length);
    for (let i = 0; i < slots; i++) {
      const def = free[i]!;
      const id = `bot-${def.id}-${Math.random().toString(36).slice(2, 7)}`;
      const friendNames = def.startingFriends
        .map((fid) => npcById(fid)?.name)
        .filter((n): n is string => typeof n === 'string');
      const bot = initialPlayer(id, id, def.name, randomSpawn(), now, {
        isBot: true,
        characterId: def.characterId,
      });
      bot.npcId = def.id;
      bot.friendsWith = friendNames;
      ensureBotDefaults(bot, now);
      this.players.set(id, bot);
      void this.hydrateBotFriendships(bot);
    }
  }

  // For each human currently in the room, check whether this bot's persona
  // has a persisted friendship score past threshold and add them to the
  // bot's friendsWith. Also mirrors into the human's friendsWith so the next
  // snapshot's pip + the social hostility propagation both see it.
  private async hydrateBotFriendships(bot: ServerPlayer): Promise<void> {
    if (!bot.npcId) return;
    const humans = Array.from(this.players.values()).filter((p) => !p.isBot);
    for (const human of humans) {
      const f = await this.store.getFriendship(bot.npcId, human.name);
      if (f.score < SOCIAL.friendThreshold) continue;
      if (!bot.friendsWith.includes(human.name)) bot.friendsWith.push(human.name);
      if (!human.friendsWith.includes(bot.name)) human.friendsWith.push(bot.name);
    }
  }

  // For each NPC in the roster, check whether this human's persisted
  // friendship is past threshold and add the NPC name to their friendsWith.
  // Bots may not be spawned yet at this point — hydrateBotFriendships catches
  // the reverse direction once they spawn.
  private async hydrateFriendships(human: ServerPlayer): Promise<void> {
    for (const npc of NPCS) {
      const f = await this.store.getFriendship(npc.id, human.name);
      if (f.score < SOCIAL.friendThreshold) continue;
      if (!human.friendsWith.includes(npc.name)) human.friendsWith.push(npc.name);
      const liveBot = Array.from(this.players.values()).find(
        (p) => p.isBot && p.npcId === npc.id,
      );
      if (liveBot && !liveBot.friendsWith.includes(human.name)) {
        liveBot.friendsWith.push(human.name);
      }
    }
  }

  private removeAllBots(): void {
    for (const [id, p] of this.players) {
      if (p.isBot) {
        this.players.delete(id);
        this.pendingFire.delete(id);
      }
    }
  }

  onError(_conn: Party.Connection, err: Error): void {
    console.error('connection error', err);
  }

  async onRequest(req: Party.Request): Promise<Response> {
    const url = new URL(req.url);

    // Public lobby-state probe. Returns the room's locked settings (or
    // unlocked defaults) plus the live human count so the lobby UI can
    // decide whether the joining player gets to pick settings (empty room)
    // or has to accept the host's choices (in-progress game). No auth —
    // anyone who can see the room knows whether it's busy. CORS-open so
    // the Vercel-hosted client can hit the PartyKit prod host directly.
    if (req.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'access-control-allow-origin': '*',
          'access-control-allow-methods': 'GET, POST, PATCH, DELETE, OPTIONS',
          'access-control-allow-headers': 'content-type',
          'access-control-max-age': '86400',
        },
      });
    }
    if (req.method === 'GET' && url.pathname.endsWith('/lobby-state')) {
      const humanCount = this.humanCount();
      const body = {
        ok: true,
        room: this.room.id,
        humanCount,
        locked: this.killTargetLocked && this.botCountLocked,
        killTarget: this.killTarget,
        botCount: this.botCount,
        botDifficulty: this.botDifficulty,
        npcIds: this.roster.map((n) => n.id),
      };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'access-control-allow-origin': '*',
        },
      });
    }

    const expected = (this.room.env.ELEVENLABS_AGENT_TOOL_SECRET as string | undefined) ?? '';
    if (!expected) return jsonResponse({ error: 'tools disabled' }, 503);

    // Parse body once (POST/PATCH only); GET/DELETE use query string only.
    const q = url.searchParams;
    let body: {
      npcId?: string;
      playerName?: string;
      sessionId?: string;
      secret?: string;
      targetName?: string;
      summary?: string;
      evidence?: string;
      source?: string;
      pose?: string;
      danceVariant?: number;
    } = {};
    if (
      (req.method === 'POST' || req.method === 'PATCH') &&
      req.headers.get('content-type')?.includes('application/json')
    ) {
      try {
        body = (await req.json()) as typeof body;
      } catch {
        // ignore — fall through to query-string-only path
      }
    }
    const secret = q.get('secret') ?? body.secret ?? '';
    if (!constantTimeEqual(secret, expected)) {
      return jsonResponse({ error: 'unauthorized' }, 401);
    }

    // Admin: persona-delta CRUD. Secret-gated, no consent check (these are
    // operator actions, not player interactions). Used by scripts/set-npc-state.mjs
    // and any future in-fiction tools that propose changes to an NPC's self-state.
    if (url.pathname.endsWith('/admin/npc-state')) {
      const adminNpcId = q.get('npcId') ?? body.npcId ?? '';
      if (!adminNpcId || !npcById(adminNpcId)) {
        return jsonResponse({ error: 'unknown npcId' }, 400);
      }
      if (req.method === 'GET') {
        const list = await this.store.getNpcState(adminNpcId);
        return jsonResponse({ ok: true, npcId: adminNpcId, entries: list });
      }
      if (req.method === 'DELETE') {
        await this.store.clearNpcState(adminNpcId);
        return jsonResponse({ ok: true, cleared: true });
      }
      if (req.method === 'POST') {
        const summary = (body.summary ?? q.get('summary') ?? '').trim();
        if (!summary) return jsonResponse({ error: 'summary required' }, 400);
        const entry = {
          at: Date.now(),
          summary,
          ...(body.evidence ? { evidence: body.evidence } : {}),
          source: body.source ?? q.get('source') ?? 'manual',
        };
        await this.store.appendNpcState(adminNpcId, entry);
        return jsonResponse({ ok: true, entry });
      }
      return jsonResponse({ error: 'method not allowed' }, 405);
    }

    // Recent sessions in this room, decoded + joined with events.
    if (req.method === 'GET' && url.pathname.endsWith('/admin/sessions')) {
      const count = Math.max(1, Math.min(20, parseInt(q.get('count') ?? '1', 10) || 1));
      const playerFilter = q.get('player');
      const since = parseInt(q.get('since') ?? '0', 10) || 0;
      return jsonResponse(await this.collectSessions({ count, playerFilter, since }));
    }

    // All NPC persona-delta state in this room, in one call.
    if (req.method === 'GET' && url.pathname.endsWith('/admin/state')) {
      const out: Record<string, NpcStateEntry[]> = {};
      for (const def of NPCS) {
        const entries = await this.store.getNpcState(def.id);
        if (entries.length > 0) out[def.id] = entries;
      }
      return jsonResponse({ ok: true, room: this.room.id, state: out });
    }

    // Live snapshot — who's in the room right now, hostility, follow targets,
    // current health/ammo. Useful for "is Mira hostile right now?" questions.
    if (req.method === 'GET' && url.pathname.endsWith('/admin/snapshot')) {
      const now = this.serverTime();
      const players = Array.from(this.players.values()).map((p) => ({
        id: p.id,
        name: p.name,
        isBot: p.isBot,
        npcId: p.npcId ?? null,
        alive: p.alive,
        health: p.health,
        ammo: p.ammo,
        position: p.position,
        botState: p.botState ?? null,
        botFollowing: p.botFollowing ?? null,
        botFleeingFrom: p.botFleeingFrom ?? null,
        botConversationWith: p.botConversationWith ?? null,
        friendsWith: p.friendsWith,
        hostility: p.hostility
          .filter((h) => h.until > now)
          .map((h) => ({ towardsName: h.towardsName, msRemaining: h.until - now })),
      }));
      return jsonResponse({ ok: true, room: this.room.id, serverTime: now, players });
    }

    // Tool routes — POST only, require npcId + playerName + recorded consent.
    // Some already-published agent tools may omit playerName but include the
    // active sessionId. Infer the human from that live session so the tool
    // still drives the body instead of failing while the agent talks as if it
    // succeeded.
    if (req.method !== 'POST') return jsonResponse({ error: 'method not allowed' }, 405);
    const npcId = q.get('npcId') ?? body.npcId ?? '';
    const sessionId = q.get('sessionId') ?? body.sessionId ?? '';
    let playerName = q.get('playerName') ?? body.playerName ?? '';
    const npc = npcById(npcId);
    if (npc && !playerName && sessionId) {
      playerName = this.playerNameForNpcSession(npc.id, sessionId) ?? '';
    }
    if (!npc || !playerName) return jsonResponse({ error: 'bad params' }, 400);
    if (!(await this.store.getConsent(playerName))) {
      return jsonResponse({ error: 'no consent on record' }, 403);
    }

    if (url.pathname.endsWith('/tools/make_friend')) {
      return this.handleMakeFriendTool(npc, playerName);
    }
    if (url.pathname.endsWith('/tools/follow_player')) {
      return this.handleFollowTool(npc, playerName, true);
    }
    if (url.pathname.endsWith('/tools/stop_following')) {
      return this.handleFollowTool(npc, playerName, false);
    }
    if (url.pathname.endsWith('/tools/flee_from')) {
      return this.handleFleeTool(npc, playerName);
    }
    if (url.pathname.endsWith('/tools/stop_attacking')) {
      const target =
        q.get('targetName') ?? body.targetName ?? playerName;
      return this.handleStopAttackingTool(npc, target);
    }
    if (url.pathname.endsWith('/tools/start_attacking')) {
      const target = q.get('targetName') ?? body.targetName ?? '';
      if (!target) return jsonResponse({ error: 'targetName required' }, 400);
      return this.handleStartAttackingTool(npc, target);
    }
    if (url.pathname.endsWith('/tools/set_pose')) {
      const poseRaw = (q.get('pose') ?? body.pose ?? '').trim();
      const variant = parseInt(
        q.get('danceVariant') ?? String(body.danceVariant ?? 0),
        10,
      );
      return this.handleSetPoseTool(npc, poseRaw, isNaN(variant) ? 0 : variant);
    }
    if (url.pathname.endsWith('/tools/drink_coffee')) {
      return this.handleDrinkCoffeeTool(npc, playerName);
    }
    if (url.pathname.endsWith('/tools/patrol')) {
      return this.handlePatrolTool(npc, playerName, false);
    }
    if (url.pathname.endsWith('/tools/sprint_patrol')) {
      return this.handlePatrolTool(npc, playerName, true);
    }
    if (url.pathname.endsWith('/tools/lean_wall')) {
      return this.handleLeanWallTool(npc, playerName);
    }
    return jsonResponse({ error: 'not found' }, 404);
  }

  private playerNameForNpcSession(npcId: string, sessionId: string): string | null {
    const bot = Array.from(this.players.values()).find(
      (p) => p.isBot && p.npcId === npcId && p.botActiveSessionId === sessionId,
    );
    if (!bot?.botConversationWith) return null;
    const human = this.players.get(bot.botConversationWith);
    return human && !human.isBot ? human.name : null;
  }

  private async handleMakeFriendTool(npc: NpcDef, playerName: string): Promise<Response> {
    const result = await this.store.addFriendshipScore(
      npc.id,
      playerName,
      SOCIAL.friendBoost,
      SOCIAL.friendThreshold,
    );
    if (result.becameFriend) {
      const bot = Array.from(this.players.values()).find((p) => p.isBot && p.npcId === npc.id);
      if (bot) this.pushSelfStateAlert(bot, { kind: 'self_befriended_player', playerName });
      for (const p of this.players.values()) {
        if (p.name === playerName && !p.friendsWith.includes(npc.name)) {
          p.friendsWith.push(npc.name);
        }
        if (p.isBot && p.npcId === npc.id && !p.friendsWith.includes(playerName)) {
          p.friendsWith.push(playerName);
        }
      }
      // Tell every OTHER NPC currently in a voice session that this NPC
      // just made a new friend. They all know each other on sight, so a
      // friendship shift is a social event worth noticing.
      for (const observer of this.activeSessionBots()) {
        if (observer.npcId === npc.id) continue;
        this.dispatchNpcAlert({
          kind: 'npc_befriended_player',
          targetConnId: observer.botConversationWith!,
          npcId: observer.npcId!,
          sessionId: observer.botActiveSessionId!,
          npcName: npc.name,
          playerName,
        });
      }
    }
    this.emit({ kind: 'tool_call', tool: 'make_friend', npcId: npc.id, playerName, ok: true });
    this.emit({
      kind: 'friendship_change',
      npcId: npc.id,
      playerName,
      delta: SOCIAL.friendBoost,
      newScore: result.score,
      becameFriend: result.becameFriend,
    });
    return jsonResponse({ ok: true, score: result.score, becameFriend: result.becameFriend });
  }

  // Mark the bot for this NPC as following (or stop following) the named
  // human player. tickBot reads botFollowing and overrides its patrol goal
  // when set. Only effective while a live human with that name exists.
  private handleFollowTool(npc: NpcDef, playerName: string, follow: boolean): Response {
    const tool = follow ? 'follow_player' : 'stop_following';
    const human = Array.from(this.players.values()).find(
      (p) => !p.isBot && p.name === playerName,
    );
    if (!human) {
      this.emit({ kind: 'tool_call', tool, npcId: npc.id, playerName, ok: false });
      return jsonResponse({ error: 'player not in room' }, 404);
    }
    const bot = Array.from(this.players.values()).find(
      (p) => p.isBot && p.npcId === npc.id,
    );
    if (!bot) {
      this.emit({ kind: 'tool_call', tool, npcId: npc.id, playerName, ok: false });
      return jsonResponse({ error: 'npc not spawned' }, 404);
    }
    bot.botFollowing = follow ? human.id : null;
    // Reset follow state machine on every transition so the next time the
    // bot enters FOLLOWING it starts fresh: turn-first delay applied, no
    // stale hold timer.
    bot.botFollowMoving = false;
    bot.botFollowHoldUntil = undefined;
    this.emit({ kind: 'tool_call', tool, npcId: npc.id, playerName, ok: true });
    this.pushSelfStateAlert(
      bot,
      follow
        ? { kind: 'self_follow_started', playerName, source: 'tool' }
        : { kind: 'self_follow_stopped', playerName, source: 'tool' },
    );
    return jsonResponse({ ok: true, following: !!bot.botFollowing });
  }

  // Mark the bot for this NPC as fleeing from the named human for the next
  // SOCIAL.hostilityMs window. tickBot reads botFleeingFrom and steers the
  // path away from that player. Doesn't override engage (hostility wins).
  private handleFleeTool(npc: NpcDef, playerName: string): Response {
    const human = Array.from(this.players.values()).find(
      (p) => !p.isBot && p.name === playerName,
    );
    if (!human) {
      this.emit({ kind: 'tool_call', tool: 'flee_from', npcId: npc.id, playerName, ok: false });
      return jsonResponse({ error: 'player not in room' }, 404);
    }
    const bot = Array.from(this.players.values()).find(
      (p) => p.isBot && p.npcId === npc.id,
    );
    if (!bot) {
      this.emit({ kind: 'tool_call', tool: 'flee_from', npcId: npc.id, playerName, ok: false });
      return jsonResponse({ error: 'npc not spawned' }, 404);
    }
    bot.botFleeingFrom = { id: human.id, until: this.serverTime() + SOCIAL.hostilityMs };
    this.emit({ kind: 'tool_call', tool: 'flee_from', npcId: npc.id, playerName, ok: true });
    this.pushSelfStateAlert(bot, { kind: 'self_flee_started', playerName });
    return jsonResponse({ ok: true });
  }

  // Clear this bot's hostility toward a named target — the agent has decided
  // to forgive / de-escalate / spare them. Also drops the bot's current
  // engage target if it matches, so the next tick exits the engage state.
  private handleStopAttackingTool(npc: NpcDef, targetName: string): Response {
    const bot = Array.from(this.players.values()).find(
      (p) => p.isBot && p.npcId === npc.id,
    );
    if (!bot) {
      this.emit({ kind: 'tool_call', tool: 'stop_attacking', npcId: npc.id, playerName: targetName, args: { targetName }, ok: false });
      return jsonResponse({ error: 'npc not spawned' }, 404);
    }
    const cleared = clearHostility(bot, targetName);
    const target = Array.from(this.players.values()).find((p) => p.name === targetName);
    if (target && bot.botTargetId === target.id) bot.botTargetId = null;
    this.emit({ kind: 'tool_call', tool: 'stop_attacking', npcId: npc.id, playerName: targetName, args: { targetName }, ok: true });
    if (cleared) this.emit({ kind: 'hostility_change', npcId: npc.id, towardsName: targetName, op: 'clear', source: 'tool' });
    this.pushSelfStateAlert(bot, { kind: 'self_attack_stopped', targetName, source: 'tool' });
    return jsonResponse({ ok: true, cleared, targetName });
  }

  // Conversationally-induced hostility — the agent has been convinced to
  // attack someone. Sets hostility for the standard 30s window. Next tick,
  // findVisibleHostileTarget will pick the target up and the bot will
  // transition into engage if it has LOS. Returns 404 if the target isn't
  // present in the room (can't attack someone who isn't here).
  private handleStartAttackingTool(npc: NpcDef, targetName: string): Response {
    const bot = Array.from(this.players.values()).find(
      (p) => p.isBot && p.npcId === npc.id,
    );
    if (!bot) {
      this.emit({ kind: 'tool_call', tool: 'start_attacking', npcId: npc.id, playerName: targetName, args: { targetName }, ok: false });
      return jsonResponse({ error: 'npc not spawned' }, 404);
    }
    const target = Array.from(this.players.values()).find((p) => p.name === targetName);
    if (!target) {
      this.emit({ kind: 'tool_call', tool: 'start_attacking', npcId: npc.id, playerName: targetName, args: { targetName }, ok: false });
      return jsonResponse({ error: 'target not in room' }, 404);
    }
    if (target.id === bot.id) {
      this.emit({ kind: 'tool_call', tool: 'start_attacking', npcId: npc.id, playerName: targetName, args: { targetName }, ok: false });
      return jsonResponse({ error: 'cannot target self' }, 400);
    }
    const now = this.serverTime();
    adoptHostility(bot, targetName, now);
    this.emit({ kind: 'tool_call', tool: 'start_attacking', npcId: npc.id, playerName: targetName, args: { targetName }, ok: true });
    this.emit({ kind: 'hostility_change', npcId: npc.id, towardsName: targetName, op: 'set', source: 'tool', until: now + SOCIAL.hostilityMs });
    this.pushSelfStateAlert(bot, { kind: 'self_attack_started', targetName, source: 'tool' });
    return jsonResponse({ ok: true, targetName });
  }

  private handleSetPoseTool(npc: NpcDef, poseRaw: string, danceVariant: number): Response {
    const VALID_POSES = ['casual_idle', 'lean_wall', 'sit', 'lay', 'dance', 'clear'] as const;
    const ok = (VALID_POSES as readonly string[]).includes(poseRaw);
    const bot = Array.from(this.players.values()).find(
      (p) => p.isBot && p.npcId === npc.id,
    );
    if (!ok) {
      this.emit({ kind: 'tool_call', tool: 'set_pose', npcId: npc.id, playerName: '', args: { pose: poseRaw }, ok: false });
      return jsonResponse({ error: `pose must be one of ${VALID_POSES.join(', ')}` }, 400);
    }
    if (!bot) {
      this.emit({ kind: 'tool_call', tool: 'set_pose', npcId: npc.id, playerName: '', args: { pose: poseRaw }, ok: false });
      return jsonResponse({ error: 'npc not spawned' }, 404);
    }
    const target: Pose = poseRaw === 'clear' ? null : (poseRaw as Pose);
    applyAgentPose(bot, target, danceVariant, this.serverTime());
    this.emit({
      kind: 'tool_call',
      tool: 'set_pose',
      npcId: npc.id,
      playerName: '',
      args: { pose: poseRaw, danceVariant },
      ok: true,
    });
    return jsonResponse({ ok: true, pose: target, danceVariant: bot.danceVariant });
  }

  // Diagnostic helper for the npc-not-spawned failure path. Without this,
  // the failure emit has no signal for WHY the bot was missing (was it
  // never spawned? died mid-session? wrong room?). Returns the npcIds of
  // bots currently in this room so the report can show what was actually
  // present when the lookup failed.
  private botInventory(): string[] {
    return Array.from(this.players.values())
      .filter((p) => p.isBot && p.npcId)
      .map((p) => p.npcId as string);
  }

  // Apply patrol/sprint_patrol state mutations to a bot. Used by both the
  // tool route and the regex fallback in applyTranscriptIntent so the two
  // entry points stay in lockstep.
  private applyPatrolToBot(bot: ServerPlayer, sprint: boolean): void {
    bot.botFollowing = null;
    bot.botFollowMoving = false;
    bot.botFollowHoldUntil = undefined;
    bot.botFleeingFrom = null;
    bot.botLeanTarget = null;
    bot.botForceSprint = sprint;
    // Drop any committed pose so the bot can actually walk. applyAgentPose
    // handles the sit/lay stand-up transition; lean/dance/casual_idle just
    // clear immediately.
    applyAgentPose(bot, null, 0, this.serverTime());
  }

  // Resume normal patrol. Clears every "I'm doing something else" binding
  // — follow target, flee target, lean target, force-sprint, committed pose,
  // coffee deadline — so the controller falls back to its default
  // exploration loop. If `sprint` is true, also sets botForceSprint so the
  // bot sprints between every waypoint (the standard patrol only sprints
  // when the next waypoint is >12m away). Self-state alert tells the agent
  // what changed so its perception stays aligned.
  private handlePatrolTool(npc: NpcDef, playerName: string, sprint: boolean): Response {
    const tool = sprint ? 'sprint_patrol' : 'patrol';
    const bot = Array.from(this.players.values()).find(
      (p) => p.isBot && p.npcId === npc.id,
    );
    if (!bot) {
      const botsInRoom = this.botInventory();
      this.emit({
        kind: 'tool_call', tool, npcId: npc.id, playerName,
        args: { reason: 'npc_not_spawned', botsInRoom },
        ok: false,
      });
      return jsonResponse({ error: 'npc not spawned', botsInRoom }, 404);
    }
    this.applyPatrolToBot(bot, sprint);
    this.emit({ kind: 'tool_call', tool, npcId: npc.id, playerName, ok: true });
    this.pushSelfStateAlert(bot, { kind: 'self_patrol_started', sprint });
    return jsonResponse({ ok: true, sprint });
  }

  // Compute nearest-wall lean target + write it to bot.botLeanTarget. Returns
  // { walkDist, wallDist } on success, null when no wall is within range.
  // Shared between the tool handler and the regex fallback — the bot does
  // the same thing whichever entry point triggered it. Caller is responsible
  // for emit + self-state alert (so the two callers can tag source).
  private applyLeanTargetToBot(bot: ServerPlayer): { walkDist: number; wallDist: number } | null {
    const chest: Vec3 = [bot.position[0], bot.position[1], bot.position[2]];
    let bestDist: number | null = null;
    let bestAngle = 0;
    for (let i = 0; i < BOT.leanSearchRays; i++) {
      const angle = (i / BOT.leanSearchRays) * Math.PI * 2;
      const dir: Vec3 = [Math.sin(angle), 0, -Math.cos(angle)];
      const dist = raycastObstacles(chest, dir, BOT.leanSearchDist);
      if (dist !== null && (bestDist === null || dist < bestDist)) {
        bestDist = dist;
        bestAngle = angle;
      }
    }
    if (bestDist === null) return null;
    const walkDist = Math.max(0, bestDist - BOT.leanStandoffDist);
    const rayDx = Math.sin(bestAngle);
    const rayDz = -Math.cos(bestAngle);
    bot.botLeanTarget = {
      position: [
        bot.position[0] + rayDx * walkDist,
        bot.position[1],
        bot.position[2] + rayDz * walkDist,
      ],
      yaw: bestAngle + Math.PI, // face away from wall (back to wall)
    };
    bot.botFollowing = null;
    bot.botFleeingFrom = null;
    bot.botForceSprint = false;
    return { walkDist, wallDist: bestDist };
  }

  // Find the nearest obstacle face, set the bot a lean target a short
  // standoff back from it with yaw pointed away (back-to-wall). The bot
  // path-finds there and the controller's top-of-tick lean-arrival check
  // applies the pose when it arrives. Returns 404 if no wall is within
  // BOT.leanSearchDist — the agent should tell the player there's nothing
  // to lean against.
  private handleLeanWallTool(npc: NpcDef, playerName: string): Response {
    const bot = Array.from(this.players.values()).find(
      (p) => p.isBot && p.npcId === npc.id,
    );
    if (!bot) {
      const botsInRoom = this.botInventory();
      this.emit({
        kind: 'tool_call', tool: 'lean_wall', npcId: npc.id, playerName,
        args: { reason: 'npc_not_spawned', botsInRoom },
        ok: false,
      });
      return jsonResponse({ error: 'npc not spawned', botsInRoom }, 404);
    }
    const result = this.applyLeanTargetToBot(bot);
    if (result === null) {
      this.emit({ kind: 'tool_call', tool: 'lean_wall', npcId: npc.id, playerName, args: { reason: 'no_wall' }, ok: false });
      this.pushSelfStateAlert(bot, { kind: 'self_lean_no_wall' });
      return jsonResponse({ error: 'no wall within search radius', searchDist: BOT.leanSearchDist }, 404);
    }
    this.emit({
      kind: 'tool_call', tool: 'lean_wall', npcId: npc.id, playerName,
      args: { walkDist: Number(result.walkDist.toFixed(2)), wallDist: Number(result.wallDist.toFixed(2)) },
      ok: true,
    });
    this.pushSelfStateAlert(bot, { kind: 'self_lean_started', distM: result.walkDist });
    return jsonResponse({ ok: true, ...result });
  }

  // Agent-initiated coffee drink. The LLM decides whether the NPC's persona
  // would drink — Guts might (defying his complaints), Vex would for fun,
  // Vicky might decline, etc. Calling this sets a bounded travel deadline by
  // which the bot must reach the maker; the bot controller picks up
  // botGoingForCoffeeUntil and overrides patrol with the coffee navigation
  // target. On arrival, the runTick loop invokes tryDrinkCoffee for the bot
  // (same path as a human) and pushes a self_drank_coffee alert. If the
  // deadline elapses, the bot gives up and a self_coffee_unreachable alert
  // fires so the agent knows the drink didn't happen.
  private handleDrinkCoffeeTool(npc: NpcDef, playerName: string): Response {
    const result = this.startBotCoffeeRun(npc, playerName, 'tool');
    if (!result.ok) return jsonResponse(result.body, result.status);
    return jsonResponse({
      ok: true,
      status: result.alreadyGoing ? 'already_walking_to_coffee' : 'walking_to_coffee',
      instruction:
        'You have started walking to the coffee maker. Do not say you drank coffee until you receive the system message confirming you just had a cup.',
    });
  }

  private startBotCoffeeRun(
    npc: NpcDef,
    playerName: string,
    source: 'tool' | 'transcript',
  ):
    | { ok: true; alreadyGoing: boolean }
    | { ok: false; status: number; body: Record<string, unknown> } {
    const bot = Array.from(this.players.values()).find(
      (p) => p.isBot && p.npcId === npc.id,
    );
    if (!bot) {
      this.emit({ kind: 'tool_call', tool: 'drink_coffee', npcId: npc.id, playerName, args: { source }, ok: false });
      return { ok: false, status: 404, body: { error: 'npc not spawned' } };
    }
    // Coffee maker only exists on the fps_shooter map. The room id is the
    // map id (see onStart). Refuse the tool on other maps so the bot doesn't
    // path off into the void.
    if (this.room.id !== 'fps_shooter') {
      this.emit({ kind: 'tool_call', tool: 'drink_coffee', npcId: npc.id, playerName, args: { source }, ok: false });
      return { ok: false, status: 400, body: { error: 'no coffee maker on this map' } };
    }
    // Optional per-bot cooldown. Currently disabled for quick test loops, but
    // keep the branch so a future nonzero cooldown works consistently.
    if (COFFEE.cooldownMs > 0 && bot.lastCoffeeDrinkAt !== undefined) {
      const sinceMs = Date.now() - bot.lastCoffeeDrinkAt;
      if (sinceMs < COFFEE.cooldownMs) {
        this.emit({ kind: 'tool_call', tool: 'drink_coffee', npcId: npc.id, playerName, args: { source }, ok: false });
        return {
          ok: false,
          status: 429,
          body: { error: 'still on cooldown', msRemaining: COFFEE.cooldownMs - sinceMs },
        };
      }
    }
    const alreadyGoing =
      bot.botGoingForCoffeeUntil !== undefined &&
      Date.now() < bot.botGoingForCoffeeUntil;
    bot.botGoingForCoffeeUntil = Date.now() + BOT_COFFEE_TRAVEL_TIMEOUT_MS;
    const stoppedFollowing = bot.botFollowing !== null && bot.botFollowing !== undefined;
    bot.botFollowing = null;
    bot.botFleeingFrom = null;
    bot.botFollowMoving = false;
    bot.botFollowHoldUntil = undefined;
    bot.botTargetId = null;
    bot.botEngagedAt = undefined;
    bot.botLastSawTargetAt = undefined;
    bot.botGoal = null;
    bot.botPath = undefined;
    bot.botPathIdx = 0;
    bot.botLastReplanAt = undefined;
    if (bot.pose !== 'casual_idle' || bot.poseTransition !== null) {
      clearPose(bot);
      bot.pose = 'casual_idle';
    }
    if (stoppedFollowing && bot.npcId && bot.botConversationWith && bot.botActiveSessionId) {
      this.pushSelfStateAlert(bot, {
        kind: 'self_follow_stopped',
        playerName,
        source: 'auto',
      });
    }
    this.pushSelfStateAlert(bot, {
      kind: 'self_coffee_started',
      source,
    });
    this.emit({
      kind: 'tool_call',
      tool: 'drink_coffee',
      npcId: npc.id,
      playerName,
      args: { source },
      ok: true,
    });
    return { ok: true, alreadyGoing };
  }

  private runTick(): void {
    // Drive the voice orchestrator's deferred work (transcript-arb hold,
    // NPC turn finalize) off this setInterval-based tick. Standalone
    // setTimeouts inside DO request handlers don't reliably fire in
    // Cloudflare prod once the request returns; setInterval timers
    // anchored in onStart survive. See CLAUDE.md gotcha #11 for the
    // sibling rule about room.env.
    this.voice.tick();
    const now = this.serverTime();
    const all = Array.from(this.players.values());

    for (const p of all) {
      finishReload(p, now);
      maybeRespawn(p, now);
      regenHealth(p, now);
      advancePoseTransition(p, now);
      const expired = pruneHostility(p, now);
      // If a bot's hostility timer ran out and it's mid-session, tell the
      // agent — otherwise it has no way to know it should stop being angry.
      if (
        expired.length > 0 &&
        p.isBot &&
        p.npcId &&
        p.botConversationWith &&
        p.botActiveSessionId
      ) {
        for (const targetName of expired) {
          this.dispatchNpcAlert({
            kind: 'hostility_ended',
            targetConnId: p.botConversationWith,
            npcId: p.npcId,
            sessionId: p.botActiveSessionId,
            targetName,
          });
        }
      }
      // Vault tween (if any) drives position; must run before integrateIdle
      // since integrateIdle is no-op while vaulting and we want position fresh.
      tickVault(p, now);
    }

    // Bots produce input frames here, BEFORE integrateIdle so their applyInput
    // call updates lastIntegratedAt — otherwise integrateIdle would slap a
    // duplicate physics step on top of the controller's frame.
    if (this.winnerId === null) {
      const profile =
        BOT_PROFILES[this.botDifficulty] ?? BOT_PROFILES[MATCH.defaultBotDifficulty];
      for (const p of all) {
        if (!p.isBot) continue;
        const fired = tickBot(p, all, now, profile);
        // Bots have no camera; null payload routes server through the
        // eye-from-yaw/pitch fallback in tryFire.
        if (fired) this.pendingFire.set(p.id, null);
      }
    }

    for (const p of all) {
      // Run physics for any time gap that hasn't already been integrated by an
      // arriving input — keeps idle/AFK/just-spawned players from floating.
      integrateIdle(p, now);
      // Stamp position into the rewind buffer AFTER all this tick's physics
      // is final, so the buffer reflects the same positions broadcast in the
      // upcoming snapshot. tryFire below uses these to rewind hit detection.
      pushPositionHistory(p, now);
    }

    // Coffee-bound bots: arrived at the maker? fire the drink. Deadline
    // elapsed? give up and tell the agent. Runs after the controller tick
    // so the bot's position for this frame is final.
    this.tickBotCoffeeGoals(now);

    if (this.winnerId === null && this.pendingFire.size > 0) {
      const npcAlerts: NpcAlert[] = [];
      for (const [id, aim] of this.pendingFire) {
        const shooter = this.players.get(id);
        if (!shooter) continue;
        const fired = tryFire(shooter, all, now, aim, (a) => npcAlerts.push(a));
        if (fired.length > 0) {
          this.events.push(...fired);
          for (const ev of fired) {
            if (ev.type !== 'shot') continue;
            const victim = ev.hit ? this.players.get(ev.hit) : null;
            const wasKill = ev.hit
              ? fired.some((k) => k.type === 'kill' && k.victimId === ev.hit)
              : false;
            this.emit({
              kind: 'shot_fired',
              shooterId: shooter.id,
              shooterIsBot: !!shooter.isBot,
              shooterNpcId: shooter.npcId ?? null,
              targetName: victim?.name ?? null,
              hit: ev.hit !== null,
              killed: wasKill,
            });
          }
        }
      }
      this.pendingFire.clear();

      // Witnessed kills: any kill not already covered by damaged / shot_fired
      // / friend_attacked. We emit one alert per (kill, observer) pair where
      // the observer is a bot with a live voice session and is neither the
      // killer nor the victim, and the victim isn't one of the observer's
      // friends (friend_attacked already fired for those).
      for (const ev of this.events) {
        if (ev.type !== 'kill') continue;
        if (!ev.killerId) continue;
        const killer = this.players.get(ev.killerId);
        const victim = this.players.get(ev.victimId);
        if (!killer || !victim) continue;
        for (const observer of this.activeSessionBots()) {
          if (observer.id === killer.id || observer.id === victim.id) continue;
          if (observer.friendsWith.includes(victim.name)) continue;
          npcAlerts.push({
            kind: 'kill_witnessed',
            targetConnId: observer.botConversationWith!,
            npcId: observer.npcId!,
            sessionId: observer.botActiveSessionId!,
            killerName: killer.name,
            victimName: victim.name,
          });
        }
      }

      for (const a of npcAlerts) this.dispatchNpcAlert(a);

      // Did anyone hit the kill target this tick? Pick the highest-scoring
      // player as the winner (ties broken by player insertion order).
      let winner: ServerPlayer | null = null;
      for (const p of all) {
        if (p.kills >= this.killTarget && (winner === null || p.kills > winner.kills)) {
          winner = p;
        }
      }
      if (winner) {
        this.winnerId = winner.id;
        this.resetAt = now + MATCH.victoryHoldMs;
        this.events.push({
          type: 'gameover',
          winnerId: winner.id,
          winnerName: winner.name,
          killTarget: this.killTarget,
          at: now,
        });
      }
    } else {
      this.pendingFire.clear();
    }

    if (this.resetAt !== null && now >= this.resetAt) {
      this.resetRound(now, all);
    }

    this.tick += 1;
  }

  private resetRound(now: number, all: ServerPlayer[]): void {
    for (const p of all) {
      p.kills = 0;
      p.deaths = 0;
      p.health = PLAYER.maxHealth;
      p.alive = true;
      p.respawnAt = null;
      p.position = randomSpawn();
      p.velocity = [0, 0, 0];
      p.ammo = WEAPON.magazineSize;
      p.reloading = false;
      p.reloadDoneAt = null;
      p.lastDamagedAt = 0;
      p.lastIntegratedAt = now;
      p.grounded = true;
      if (p.isBot) ensureBotDefaults(p, now);
    }
    this.winnerId = null;
    this.resetAt = null;
  }

  private broadcastSnapshot(): void {
    if (this.players.size === 0) return;

    const snapshot: GameSnapshot = {
      serverTime: this.serverTime(),
      tick: this.tick,
      players: Array.from(this.players.values()).map(stripServerOnly),
      killTarget: this.killTarget,
      winnerId: this.winnerId,
    };
    this.room.broadcast(encode<ServerMessage>({ type: 'snapshot', snapshot }));

    if (this.events.length > 0) {
      this.room.broadcast(encode<ServerMessage>({ type: 'events', events: this.events }));
      this.events = [];
    }
  }

  private send(conn: Party.Connection, msg: ServerMessage): void {
    conn.send(encode(msg));
  }

  // Push a self-state alert to the bot's active voice session, if any. Closes
  // the agent's perception loop: when ANY code path changes the bot's
  // follow/flee/hostility state (tool handler, regex fallback, damage
  // cascade, timer expire), the LLM gets a system message describing what
  // just happened to its body. Without this, the agent's mental model drifts
  // from server-side reality and the agent confidently denies its own
  // actions (B8 / Mira's "my feet are stuck" complaint).
  private pushSelfStateAlert(
    bot: ServerPlayer,
    alert: NpcAlert extends infer A
      ? A extends NpcAlert
        ? Omit<A, 'targetConnId' | 'npcId' | 'sessionId'>
        : never
      : never,
  ): void {
    if (!bot.npcId || !bot.botConversationWith || !bot.botActiveSessionId) return;
    const conn = this.room.getConnection(bot.botConversationWith);
    if (!conn) return;
    const full = {
      targetConnId: bot.botConversationWith,
      npcId: bot.npcId,
      sessionId: bot.botActiveSessionId,
      ...alert,
    } as NpcAlert;
    const text = formatNpcAlert(full);
    if (!text) return;
    this.send(conn, {
      type: 'npc_alert',
      npcId: bot.npcId,
      sessionId: bot.botActiveSessionId,
      text,
    });
  }

  // Decode all transcripts in this room, group into sessions by 5-min gap
  // per player, join with the in-memory event ring buffer, attach
  // NPC-state snapshots that were active when each session started.
  // Returns the most recent `count` sessions in this room.
  private async collectSessions(opts: {
    count: number;
    playerFilter: string | null;
    since: number;
  }): Promise<{
    room: string;
    sessions: Array<{
      room: string;
      player: string;
      startedAt: number;
      endedAt: number;
      durationMs: number;
      npcs: string[];
      lineCount: number;
      userLineCount: number;
      agentLineCount: number;
      transcript: { npcId: string; role: 'user' | 'agent'; text: string; at: number }[];
      events: (FeedbackEvent & { t: number })[];
      npcState: Record<string, NpcStateEntry[]>;
    }>;
    scene: Array<{ at: number; speakerName: string; text: string; kind: 'human' | 'npc' }>;
  }> {
    const SESSION_GAP_MS = 5 * 60_000;
    // List all transcript keys in this DO. Returns Map<key, value>.
    const all = await this.room.storage.list<{ role: 'user' | 'agent'; text: string; at: number }[]>(
      { prefix: 'tx:' },
    );
    type Line = { npcId: string; player: string; role: 'user' | 'agent'; text: string; at: number };
    const byPlayer = new Map<string, Line[]>();
    for (const [key, lines] of all) {
      const parts = key.split(':');
      const npcId = parts[1];
      const player = parts.slice(2).join(':');
      if (opts.playerFilter && player !== opts.playerFilter) continue;
      const arr = byPlayer.get(player) ?? [];
      for (const l of lines) {
        if (opts.since && l.at < opts.since) continue;
        arr.push({ npcId: npcId!, player, role: l.role, text: l.text, at: l.at });
      }
      byPlayer.set(player, arr);
    }

    type Session = {
      player: string;
      lines: Line[];
    };
    const sessions: Session[] = [];
    for (const [player, lines] of byPlayer) {
      lines.sort((a, b) => a.at - b.at);
      let cur: Line[] = [];
      for (let i = 0; i < lines.length; i++) {
        if (i > 0 && lines[i]!.at - lines[i - 1]!.at > SESSION_GAP_MS) {
          if (cur.length) sessions.push({ player, lines: cur });
          cur = [];
        }
        cur.push(lines[i]!);
      }
      if (cur.length) sessions.push({ player, lines: cur });
    }
    sessions.sort((a, b) => b.lines[0]!.at - a.lines[0]!.at);
    const top = sessions.slice(0, opts.count);

    // Cache NPC state per npcId so we don't re-fetch for every session.
    const stateCache = new Map<string, NpcStateEntry[]>();

    const enriched = await Promise.all(
      top.map(async (s) => {
        const startedAt = s.lines[0]!.at;
        const endedAt = s.lines[s.lines.length - 1]!.at;
        const npcs = [...new Set(s.lines.map((l) => l.npcId))];
        // Events whose timestamps fall within ±10s of the session window.
        // Captures the voice_session start/end and any tool_calls during.
        const events = this.recentEvents.filter(
          (e) => e.t >= startedAt - 10_000 && e.t <= endedAt + 10_000,
        );
        // NPC state as of session start — entries with at <= startedAt
        const npcState: Record<string, NpcStateEntry[]> = {};
        for (const id of npcs) {
          if (!stateCache.has(id)) {
            stateCache.set(id, await this.store.getNpcState(id));
          }
          const entries = (stateCache.get(id) ?? []).filter((e) => e.at <= startedAt);
          if (entries.length > 0) npcState[id] = entries;
        }
        return {
          room: this.room.id,
          player: s.player,
          startedAt,
          endedAt,
          durationMs: endedAt - startedAt,
          npcs,
          lineCount: s.lines.length,
          userLineCount: s.lines.filter((l) => l.role === 'user').length,
          agentLineCount: s.lines.filter((l) => l.role === 'agent').length,
          transcript: s.lines.map((l) => ({ npcId: l.npcId, role: l.role, text: l.text, at: l.at })),
          events,
          npcState,
        };
      }),
    );

    // Tail of the scene transcript so multi-speaker rooms surface in
    // pnpm session:last alongside legacy ConvAI sessions. Includes both
    // human utterances (from Deepgram scene transcripts) and NPC turns
    // (from npc_turn_end events) so the CLI renders the full dialogue,
    // not just the player's side. Filter by player and since-window when
    // provided to keep the response targeted.
    const humanLines = this.sceneTranscript
      .filter((l) => (opts.since ? l.at >= opts.since : true))
      .filter((l) => (opts.playerFilter ? l.speakerName === opts.playerFilter : true))
      .map((l) => ({ at: l.at, speakerName: l.speakerName, text: l.text, kind: 'human' as const }));
    const npcLines = this.recentEvents
      .filter((e): e is FeedbackEvent & { t: number; kind: 'npc_turn_end' } => e.kind === 'npc_turn_end')
      .filter((e) => (opts.since ? e.t >= opts.since : true))
      .map((e) => ({
        at: e.t,
        speakerName: npcById(e.npcId)?.name ?? e.npcId,
        text: e.text ?? '',
        kind: 'npc' as const,
      }));
    const scene = [...humanLines, ...npcLines]
      .sort((a, b) => a.at - b.at)
      .slice(-200);

    return { room: this.room.id, sessions: enriched, scene };
  }

  private acceptTranscript(npcId: string, playerName: string, line: TranscriptLine): void {
    const text = (line.text ?? '').slice(0, 500);
    if (!text.trim()) return;
    void this.store.appendTranscript(npcId, playerName, {
      role: line.role,
      text,
      at: line.at,
    });
    if (line.role === 'user') {
      // Fallback intent detection: until the ElevenLabs agent is wired with
      // follow_player / stop_following webhook tools, parse the player's
      // spoken transcript for these intents and trigger the actions directly.
      this.applyTranscriptIntent(npcId, playerName, text);
      // Lightweight bug/feedback regex sweep. The CLI report layers a Haiku
      // pass on top for richer extraction; this just flags trigger phrases
      // so the report doesn't have to re-scan every transcript line.
      const sessionId = Array.from(this.players.values()).find(
        (p) => p.isBot && p.npcId === npcId,
      )?.botActiveSessionId;
      const trigger = matchFeedbackTrigger(text);
      if (trigger) {
        this.emit({
          kind: 'feedback_signal',
          playerName,
          trigger,
          text,
          npcId,
          ...(sessionId ? { sessionId } : {}),
        });
      }
    } else if (line.role === 'agent') {
      // Belt-and-suspenders for ConvAI tool misses: if the NPC itself says
      // it is heading to the coffee maker, make the body do that even if the
      // platform did not emit the webhook.
      this.applyAgentTranscriptIntent(npcId, playerName, text);
    }
  }

  // Phase 2 scene-transcript accumulator. Pushes a finalized utterance into
  // the room-wide ring buffer (used in Phase 3 by the arbitration engine to
  // pick which NPC responds next), runs the feedback-regex trigger pass so
  // bug-report keywords still show up in pnpm session:last, and emits a
  // structured [EVENT] log line so the feedback report can attribute speech
  // to the right speaker across players. No persistent storage — scene
  // transcripts are live-only in v1; per-(npc, player) memory still flows
  // through the legacy ConvAI path in the same case branch.
  private acceptSceneTranscript(speakerName: string, line: TranscriptLine): void {
    const text = (line.text ?? '').slice(0, 500).trim();
    if (!text) return;
    const entry: SceneLine = { at: line.at, speakerName, text };
    this.sceneTranscript.push(entry);
    if (this.sceneTranscript.length > SCENE_LINE_CAP) this.sceneTranscript.shift();
    this.emit({
      kind: 'scene_transcript',
      speakerName,
      text,
      at: line.at,
    });
    // Phase 3: feed the orchestrator so arbitration sees this utterance
    // the next time silence triggers a turn.
    this.voice.onSceneTranscript({ at: line.at, speakerName, text });
    const trigger = matchFeedbackTrigger(text);
    if (trigger) {
      this.emit({
        kind: 'feedback_signal',
        playerName: speakerName,
        trigger,
        text,
      });
    }
  }

  // Reply with a Deepgram-usable token over the same socket. The intended
  // flow is to mint a short-lived access token via `/v1/auth/grant`, which
  // keeps the project key server-side. In practice that endpoint requires
  // a scope many keys don't have (Jeff's key 403s), so we fall back to
  // returning the project key directly. That key reaches the browser —
  // acceptable for local playtests but NOT for a public deploy. Track as
  // a v1 limitation; the long-term fix is either a scoped key or a
  // server-side proxy that keeps audio off PartyKit.
  private async handleSttTokenRequest(sender: Party.Connection): Promise<void> {
    const apiKey = this.room.env.DEEPGRAM_API_KEY as string | undefined;
    if (!apiKey) {
      this.send(sender, { type: 'stt_token', reason: 'deepgram-not-configured' });
      return;
    }
    const last = lastSttMint.get(sender.id) ?? 0;
    const sinceMs = Date.now() - last;
    if (sinceMs < STT_TOKEN_MIN_INTERVAL_MS) {
      this.send(sender, {
        type: 'stt_token',
        reason: `rate-limited; retry in ${Math.ceil((STT_TOKEN_MIN_INTERVAL_MS - sinceMs) / 1000)}s`,
      });
      return;
    }
    lastSttMint.set(sender.id, Date.now());
    // Try the temp-token endpoint first. If it works (key has the
    // auth:grant scope), we get a 30s TTL token. If it doesn't, fall
    // back to the raw project key so the client can still stream.
    try {
      const res = await fetch('https://api.deepgram.com/v1/auth/grant', {
        method: 'POST',
        headers: {
          Authorization: `Token ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: '{}',
      });
      if (res.ok) {
        const body = (await res.json()) as { access_token?: string; expires_in?: number };
        if (body.access_token) {
          this.send(sender, {
            type: 'stt_token',
            token: body.access_token,
            expiresInS: body.expires_in,
          });
          return;
        }
      } else {
        const body = await res.text().catch(() => '');
        console.warn(
          `[stt] auth/grant ${res.status}: ${body.slice(0, 200)} — falling back to project key (local-dev only)`,
        );
      }
    } catch (err) {
      console.warn('[stt] auth/grant threw, falling back to project key:', err);
    }
    // Fallback: hand the project key to the client. Sufficient for the
    // playtest path; replace with a scoped key or proxied audio path
    // before public deploy.
    this.send(sender, {
      type: 'stt_token',
      token: apiKey,
      expiresInS: 0,
    });
  }

  private isCoffeeCommitment(lower: string): boolean {
    const mentionsCoffee = /\b(coffee|coffee maker|cup of coffee|cup of joe)\b/.test(lower);
    if (!mentionsCoffee) return false;
    if (/\b(can'?t|cannot|unable|not letting|stuck)\b/.test(lower)) return false;
    return (
      /\b(i'?m|i am|i'll|i will)\s+(going|heading|walking|making|trying|getting|grabbing|having|drinking)\b/.test(
        lower,
      ) ||
      /\b(on my way|heading over|make my way|making my way|going for it|go for it)\b/.test(lower)
    );
  }

  private applyAgentTranscriptIntent(npcId: string, playerName: string, text: string): void {
    const npc = npcById(npcId);
    if (!npc) return;
    if (this.isCoffeeCommitment(text.toLowerCase())) {
      this.startBotCoffeeRun(npc, playerName, 'transcript');
    }
  }

  private applyTranscriptIntent(npcId: string, playerName: string, text: string): void {
    const lower = text.toLowerCase();
    const npc = npcById(npcId);
    if (!npc) return;
    const bot = Array.from(this.players.values()).find(
      (p) => p.isBot && p.npcId === npc.id,
    );
    const human = Array.from(this.players.values()).find(
      (p) => !p.isBot && p.name === playerName,
    );
    if (!bot || !human) return;
    const stop =
      /\b(stop following|stop follow|don'?t follow|wait here|stay here|hold on|hold up|stop|wait)\b/.test(
        lower,
      );
    const follow =
      /\b(follow me|come with me|come along|let'?s go|walk with me|come on|with me)\b/.test(
        lower,
      );
    if (stop && bot.botFollowing) {
      bot.botFollowing = null;
      bot.botFollowMoving = false;
      bot.botFollowHoldUntil = undefined;
      this.pushSelfStateAlert(bot, {
        kind: 'self_follow_stopped',
        playerName,
        source: 'regex',
      });
      return;
    }
    if (follow) {
      const wasAlready = bot.botFollowing === human.id;
      bot.botFollowing = human.id;
      bot.botFollowMoving = false;
      bot.botFollowHoldUntil = undefined;
      if (!wasAlready) {
        this.pushSelfStateAlert(bot, {
          kind: 'self_follow_started',
          playerName,
          source: 'regex',
        });
      }
      return;
    }
    // Lean-wall / patrol / sprint_patrol regex fallbacks. These exist for the
    // Vicky-style failure mode where the agent verbally refuses or stalls
    // ("It seems I can't quite manage that right now") instead of calling the
    // webhook tool. The server applies the same state mutation the tool would
    // have, and emits a tool_call event tagged source:'transcript' so the
    // feedback report shows the regex path triggered. Order matters:
    // sprint_patrol checked before patrol (the phrase "sprint patrol" contains
    // "patrol"); lean_wall checked first because its phrasing is distinct and
    // we don't want a stray "wall" to fall through to patrol.
    const leanWall =
      /\b(lean (against|on) (the |a )?wall|lean on (the |a )?wall|take cover (on|against|behind) (the |a )?wall|back (to|against) (the |a )?wall|put your back (to|against) (the |a )?wall)\b/.test(
        lower,
      );
    if (leanWall) {
      const result = this.applyLeanTargetToBot(bot);
      if (result === null) {
        this.emit({
          kind: 'tool_call', tool: 'lean_wall', npcId: npc.id, playerName,
          args: { source: 'transcript', reason: 'no_wall' },
          ok: false,
        });
        this.pushSelfStateAlert(bot, { kind: 'self_lean_no_wall' });
      } else {
        this.emit({
          kind: 'tool_call', tool: 'lean_wall', npcId: npc.id, playerName,
          args: {
            source: 'transcript',
            walkDist: Number(result.walkDist.toFixed(2)),
            wallDist: Number(result.wallDist.toFixed(2)),
          },
          ok: true,
        });
        this.pushSelfStateAlert(bot, {
          kind: 'self_lean_started',
          distM: result.walkDist,
        });
      }
      return;
    }
    const sprintPatrol =
      /\b(sprint patrol|run patrol|patrol fast|patrol (and|while) running|run around|hustle (around|the )|move (fast|quick) (around|on patrol))\b/.test(
        lower,
      );
    const patrol =
      /\b(patrol|walk around|wander|pace around|make rounds|do (a )?(lap|round)|keep (watch|an eye out)|stretch your legs)\b/.test(
        lower,
      );
    if (sprintPatrol) {
      this.applyPatrolToBot(bot, true);
      this.emit({
        kind: 'tool_call', tool: 'sprint_patrol', npcId: npc.id, playerName,
        args: { source: 'transcript' },
        ok: true,
      });
      this.pushSelfStateAlert(bot, { kind: 'self_patrol_started', sprint: true });
      return;
    }
    if (patrol) {
      this.applyPatrolToBot(bot, false);
      this.emit({
        kind: 'tool_call', tool: 'patrol', npcId: npc.id, playerName,
        args: { source: 'transcript' },
        ok: true,
      });
      this.pushSelfStateAlert(bot, { kind: 'self_patrol_started', sprint: false });
      return;
    }
  }

  private async handleVoiceSessionStart(
    playerName: string,
    npcId: string,
    sessionId: string,
    sender: Party.Connection,
  ): Promise<void> {
    if (!this.liveConsent.has(playerName)) {
      const stored = await this.store.getConsent(playerName);
      if (stored) this.liveConsent.add(playerName);
    }
    if (!this.liveConsent.has(playerName)) {
      this.send(sender, { type: 'consent_required', version: CONSENT_VERSION });
      return;
    }
    const npc = npcById(npcId);
    if (!npc) return;
    // Phase 3: NPCs flagged useDecoupledStack do NOT open a ConvAI session.
    // Their voice flows through the server-orchestrated turn-state machine
    // (Anthropic LLM + ElevenLabs TTS streaming) instead. Reply with a
    // shaped npc_context that has no agentId/signedUrl — the client's
    // ConvAI manager treats that as "no session, just leave proximity UI
    // alone." Drop silently here; mesh + STT + audio playback still work.
    if (npc.useDecoupledStack) {
      return;
    }
    const agentId = this.resolveAgentId(npc);
    if (!agentId) {
      console.warn(
        `[voice] no agent id for npc ${npcId}: roster placeholder + env ELEVENLABS_AGENT_ID not set`,
      );
      return;
    }
    const friendship = (await this.store.getFriendship(npcId, playerName)).score;
    const lastEnd = await this.store.getLastSessionEnd(npcId, playerName);
    const elapsedSinceLastMs = lastEnd === null ? undefined : Date.now() - lastEnd;
    const memoryBlob = await this.buildMemoryBlob(npc, playerName, elapsedSinceLastMs);
    // Try minting a signed URL — works for both public and private agents
    // and keeps the API key off the client. If the API call fails, fall back
    // to handing the raw agentId to the client (works for public agents).
    const signedUrl = await this.mintSignedUrl(agentId);
    this.send(sender, {
      type: 'npc_context',
      npcId,
      sessionId,
      ...(signedUrl ? { signedUrl } : { agentId }),
      memoryBlob,
      friendship,
      ...(elapsedSinceLastMs !== undefined ? { elapsedSinceLastMs } : {}),
    });
  }

  private resolveAgentId(npc: NpcDef): string | null {
    if (npc.agentId && !npc.agentId.startsWith('TODO_AGENT_ID_')) return npc.agentId;
    // Per-NPC env var first, then a single-agent catch-all. Lets prod keep
    // the real agent IDs in PartyKit env (room.env) and ship empty
    // placeholders in source. Set via:
    //   npx partykit env add ELEVENLABS_AGENT_ID_MIRA <agent_…>
    const perNpcKey = `ELEVENLABS_AGENT_ID_${npc.id.toUpperCase()}`;
    const perNpc = (this.room.env as Record<string, unknown>)[perNpcKey];
    if (typeof perNpc === 'string' && perNpc.trim()) return perNpc.trim();
    const fallback = this.room.env.ELEVENLABS_AGENT_ID as string | undefined;
    return fallback && fallback.trim() ? fallback : null;
  }

  private async mintSignedUrl(agentId: string): Promise<string | null> {
    const apiKey = this.room.env.ELEVENLABS_API_KEY as string | undefined;
    // Diagnostic: log what we can see about the env at the moment of need.
    // Tail with `npx partykit tail` to read this from prod.
    const envKeys = Object.keys(this.room.env as Record<string, unknown>);
    console.log(
      `[voice] mintSignedUrl: agent=${agentId} apiKey_present=${Boolean(apiKey)} apiKey_len=${apiKey?.length ?? 0} envKeys=[${envKeys.join(',')}]`,
    );
    if (!apiKey) return null;
    try {
      const res = await fetch(
        `https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?agent_id=${encodeURIComponent(agentId)}`,
        { headers: { 'xi-api-key': apiKey } },
      );
      if (!res.ok) {
        console.warn(`[voice] get-signed-url failed ${res.status} for agent ${agentId}: ${await res.text()}`);
        return null;
      }
      const body = (await res.json()) as { signed_url?: string };
      console.log(`[voice] get-signed-url ok, url_present=${Boolean(body.signed_url)}`);
      return body.signed_url ?? null;
    } catch (err) {
      console.warn('[voice] get-signed-url threw:', err);
      return null;
    }
  }

  private async buildMemoryBlob(
    npc: NpcDef,
    playerName: string,
    elapsedSinceLastMs?: number,
  ): Promise<string> {
    const friendship = await this.store.getFriendship(npc.id, playerName);
    const ours = await this.store.getTranscript(npc.id, playerName);
    const recentOurs = ours.slice(-10);
    const cutoff = Date.now() - 5 * 60_000;
    const others = await this.store.listRecentForNpc(npc.id, playerName, cutoff);
    others.sort((a, b) => a.line.at - b.line.at);
    const tail = others.slice(-5);

    // Live game state: persona-relevant context the agent should know about
    // when the conversation opens. Updated only at session start; mid-session
    // events come through as npc_alert → sendContextualUpdate.
    const liveBot = Array.from(this.players.values()).find(
      (p) => p.isBot && p.npcId === npc.id,
    );
    const livePlayer = Array.from(this.players.values()).find(
      (p) => !p.isBot && p.name === playerName,
    );
    const otherNpcs = Array.from(this.players.values()).filter(
      (p) => p.isBot && p.npcId !== npc.id && p.alive,
    );
    const hostileTowardPlayer =
      liveBot?.hostility.some(
        (h) => h.towardsName === playerName && h.until > this.serverTime(),
      ) ?? false;

    // Persona lives on the per-NPC agent itself (system prompt baked in at
    // agent creation). This blob carries only the dynamic per-session
    // context — game world, current state, friendships, recent transcripts —
    // and is sent via sendContextualUpdate so it layers on the persona
    // instead of replacing it.
    const lines: string[] = [];

    // Persona deltas — durable changes to your self-knowledge that override
    // the baked persona where they conflict. Front-loaded so the LLM weighs
    // them above the persona's static facts when answering.
    const npcState = await this.store.getNpcState(npc.id);
    if (npcState.length > 0) {
      lines.push("## What's changed about you (authoritative — overrides your persona)");
      lines.push(
        'The following facts about you have changed since your persona was written. ' +
          'When you talk about yourself, these are TRUE NOW; the persona text is the prior baseline. ' +
          'You still remember the prior state and the events that caused each change — your chat history corroborates them — but the current truth is below.',
      );
      lines.push('');
      for (const e of npcState) {
        const when = formatElapsed(Date.now() - e.at);
        lines.push(`- (${when} ago) ${e.summary}`);
        if (e.evidence) lines.push(`  Evidence: ${e.evidence}`);
      }
      lines.push('');
    }

    lines.push('## The game you live in');
    lines.push(
      'Slipstream is a 3D arena where players can shoot each other. You are an NPC who patrols the map. ' +
        'You do not have to fight, but you can defend yourself if attacked. The arena has corridors, ramps, ' +
        'crates and an open central area. Other players may walk in and out of earshot at any time.',
    );
    lines.push('');
    if (elapsedSinceLastMs !== undefined) {
      lines.push('## Time since you last talked');
      lines.push(
        `${formatElapsed(elapsedSinceLastMs)} since you last spoke with ${playerName}. ` +
          (elapsedSinceLastMs < 90_000
            ? 'This is essentially a continuation — pick up where you left off, do NOT open with a greeting.'
            : elapsedSinceLastMs < 10 * 60_000
              ? 'A short pause. Acknowledge the gap naturally if it fits, but you can also just keep going.'
              : elapsedSinceLastMs < 24 * 3600_000
                ? "It's been a while today. Reference the gap if it fits your persona."
                : 'It has been more than a day. Greet them like someone you know but haven\'t seen recently.'),
      );
      lines.push('');
    }
    lines.push('## Right now');
    lines.push(
      'Coffee maker rule: there is no cooldown right now. You may drink again whenever your persona wants to and your body can reach the maker.',
    );
    if (liveBot) {
      lines.push(
        `Your health: ${liveBot.health}/100. Your ammo: ${liveBot.ammo}. ` +
          (liveBot.botFollowing ? `You are currently following ${playerName}. ` : '') +
          (liveBot.botFleeingFrom ? `You are currently fleeing from someone. ` : '') +
          (hostileTowardPlayer
            ? `You are HOSTILE to ${playerName} right now — they attacked you recently.`
            : ''),
      );
    }
    if (livePlayer) {
      lines.push(
        `${playerName}'s health: ${livePlayer.health}/100. They have ${livePlayer.kills} kills and ${livePlayer.deaths} deaths this round.`,
      );
      // Caffeine talk-faster nudge: if the player has an active coffee buff,
      // tell the agent to match their energy for the remainder of the window.
      if (
        livePlayer.coffeeBuffUntil !== undefined &&
        Date.now() < livePlayer.coffeeBuffUntil
      ) {
        const remaining = livePlayer.coffeeBuffUntil - Date.now();
        lines.push(
          `${playerName} recently used the free coffee maker and is currently caffeinated (about ${formatElapsed(remaining)} remaining). For that window, match their energy — talk faster, shorter sentences, more clipped responses. Do not mention the coffee unless they bring it up.`,
        );
      }
    }
    if (otherNpcs.length > 0) {
      lines.push(
        `Other NPCs in the arena: ${otherNpcs.map((p) => p.name).join(', ')}. ` +
          (liveBot && liveBot.friendsWith.length > 0
            ? `Your friends: ${liveBot.friendsWith.join(', ')}.`
            : 'You currently have no friends in the arena.'),
      );
    }
    lines.push('');
    lines.push(
      `Friendship score with ${playerName}: ${friendship.score} (threshold ${SOCIAL.friendThreshold}).` +
        (friendship.score >= SOCIAL.friendThreshold ? ' They are your friend.' : ''),
    );
    if (recentOurs.length > 0) {
      lines.push('');
      lines.push(`Recent conversation with ${playerName}:`);
      for (const l of recentOurs) {
        const who = l.role === 'user' ? playerName : npc.name;
        lines.push(`  ${who}: ${l.text}`);
      }
    }
    if (tail.length > 0) {
      lines.push('');
      lines.push('Other players you have spoken with recently:');
      for (const o of tail) {
        const who = o.line.role === 'user' ? o.playerName : npc.name;
        lines.push(`  ${who}: ${o.line.text}`);
      }
    }

    lines.push('');
    lines.push('## Don\'t repeat yourself');
    lines.push(
      'Look at the recent conversation history above. Do NOT reuse the same hook, observation, or anecdote you used before. ' +
        'If you already talked about a topic in a previous session, pick a different angle — your persona has many ' +
        'dimensions, use a different one. The same phrase twice is a bug. The same story twice in a session is a bug. ' +
        'Vary your phrasing, vary your interests, vary your questions. If you find yourself reaching for the same line, stop and pick something else.',
    );

    lines.push('');
    lines.push('## Reacting to in-game events');
    lines.push(
      'During this conversation you may receive a system message in [brackets like this]. ' +
        'Treat it as a thing you just observed in the world (e.g. taking damage, a player walking away). ' +
        'React in character in voice, then continue the conversation. Short reactions.',
    );
    lines.push('');
    lines.push('## Tools you can call (each is a separate webhook the game enforces)');
    lines.push(
      '- make_friend: only after a real moment of trust/shared experience. Not on greetings.',
    );
    lines.push(
      `- follow_player: call this when ${playerName} explicitly asks you to follow them AND you agree (most often if you are friends). The game will then path you toward them.`,
    );
    lines.push(
      `- stop_following: call this when you want to stop following the player.`,
    );
    lines.push(
      `- flee_from: call this when you genuinely want to physically retreat from ${playerName} (e.g. they insulted or threatened you and your persona would back off). The game paths you away from them.`,
    );
    lines.push(
      `- drink_coffee: call this when your persona naturally would walk over to the free coffee maker for a cup. You decide whether to drink — your persona, your mood, the moment. The game will path you to the maker; you don't need to keep walking yourself. There is no cooldown right now. The tool starts the walk; do not claim you drank until a [System: You just walked over...] message confirms it landed.`,
    );
    lines.push('');
    lines.push(
      'Calling a tool produces a physical action in the game world. The player will SEE you start following / running / walking to the coffee maker. Use them when the conversation warrants it; do not announce that you are calling a tool, just do the action and react.',
    );

    return lines.join('\n').slice(0, 8192);
  }

  // Phase 3 orchestrator context helpers. Each returns the slice of server
  // state the VoiceOrchestrator needs for one decision or one prompt build.

  // Bots whose NpcDef has useDecoupledStack=true, returned in ArbCandidate
  // shape so the arbitration scoring function can consume them directly.
  private decoupledArbCandidates(): ArbCandidate[] {
    const out: ArbCandidate[] = [];
    for (const p of this.players.values()) {
      if (!p.isBot || !p.npcId) continue;
      const def = npcById(p.npcId);
      if (!def || !def.useDecoupledStack) continue;
      out.push(npcDefToCandidate(def, p.position, p.alive));
    }
    return out;
  }

  // Display names of every alive bot except the one we're building a
  // prompt for. Used so the chosen NPC's prompt can list its neighbors
  // and chain-reaction detection has names to match against.
  private otherNpcNames(excludeId: string): string[] {
    const out: string[] = [];
    for (const p of this.players.values()) {
      if (!p.isBot || !p.npcId) continue;
      if (p.npcId === excludeId) continue;
      if (!p.alive) continue;
      out.push(p.name);
    }
    return out;
  }

  // One-paragraph live-state summary for the prompt's "## Right now"
  // section. Mirrors the equivalent block in buildMemoryBlob but as a
  // single paragraph since scene-prompt.ts treats it as a unit.
  private buildSelfStateLine(npcId: string): string {
    const bot = Array.from(this.players.values()).find(
      (p) => p.isBot && p.npcId === npcId,
    );
    if (!bot) return '';
    const parts: string[] = [];
    parts.push(`Your health: ${bot.health}/100. Your ammo: ${bot.ammo}.`);
    if (bot.botFollowing) {
      const target = this.players.get(bot.botFollowing);
      if (target) parts.push(`You are following ${target.name}.`);
    }
    if (bot.botFleeingFrom) parts.push(`You are fleeing from someone.`);
    if (bot.hostility.some((h) => h.until > this.serverTime())) {
      parts.push(`You are HOSTILE to someone — they attacked you recently.`);
    }
    return parts.join(' ');
  }

  // Look up the position of the player who said something — by display
  // name, since the scene-transcript wire format identifies speakers by
  // name (not connection id). Used by arbitration's proximity scoring.
  private findSpeakerPosition(speakerName: string): Vec3 | undefined {
    for (const p of this.players.values()) {
      if (p.isBot) continue;
      if (p.name === speakerName) return p.position;
    }
    return undefined;
  }

  // Phase 4 tool dispatcher. Routes a Claude tool_use call into the same
  // handlers the HTTP webhook routes use, with the (npc, playerName) pair
  // resolved from args. Fire-and-forget — the orchestrator doesn't await
  // a result; the handlers do their own [EVENT] emits + self-state alerts.
  // Falls back to the primarySpeaker when args don't carry a player_name
  // (some tools don't require one).
  private dispatchTool(
    npcId: string,
    primarySpeaker: string | null,
    toolName: string,
    args: unknown,
  ): void {
    const npc = npcById(npcId);
    if (!npc) return;
    const argObj = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>;
    const playerName =
      (typeof argObj.player_name === 'string' && argObj.player_name) ||
      (typeof argObj.target_name === 'string' && argObj.target_name) ||
      primarySpeaker ||
      '';
    try {
      switch (toolName) {
        case 'follow_player':
          if (playerName) this.handleFollowTool(npc, playerName, true);
          return;
        case 'stop_following':
          if (playerName) this.handleFollowTool(npc, playerName, false);
          return;
        case 'flee_from':
          if (playerName) this.handleFleeTool(npc, playerName);
          return;
        case 'start_attacking':
          if (playerName) this.handleStartAttackingTool(npc, playerName);
          return;
        case 'stop_attacking':
          if (playerName) this.handleStopAttackingTool(npc, playerName);
          return;
        case 'make_friend':
          if (playerName) void this.handleMakeFriendTool(npc, playerName);
          return;
        case 'patrol':
          this.handlePatrolTool(npc, primarySpeaker ?? '', false);
          return;
        case 'sprint_patrol':
          this.handlePatrolTool(npc, primarySpeaker ?? '', true);
          return;
        case 'lean_wall':
          this.handleLeanWallTool(npc, primarySpeaker ?? '');
          return;
        case 'drink_coffee':
          this.handleDrinkCoffeeTool(npc, primarySpeaker ?? '');
          return;
        default:
          console.warn(`[dispatchTool] unknown tool ${toolName} from ${npcId}`);
      }
    } catch (err) {
      console.warn(`[dispatchTool] ${toolName} for ${npcId} threw:`, err);
    }
  }

  private serverTime(): number {
    return Date.now() - this.startedAt;
  }

  private stopTimers(): void {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    if (this.snapshotTimer) {
      clearInterval(this.snapshotTimer);
      this.snapshotTimer = null;
    }
  }
}

const stripServerOnly = (p: ServerPlayer) => ({
  id: p.id,
  name: p.name,
  position: p.position,
  velocity: p.velocity,
  yaw: p.yaw,
  pitch: p.pitch,
  health: p.health,
  alive: p.alive,
  respawnAt: p.respawnAt,
  ammo: p.ammo,
  reloading: p.reloading,
  reloadDoneAt: p.reloadDoneAt,
  vaulting: p.vaulting,
  kills: p.kills,
  deaths: p.deaths,
  lastSeenSeq: p.lastSeenSeq,
  isBot: p.isBot,
  characterId: p.characterId,
  npcId: p.npcId,
  friendsWith: p.friendsWith,
  pose: p.pose,
  poseTransition: p.poseTransition,
  danceVariant: p.danceVariant,
  // Wire-visible coffee state. coffeeBuffUntil drives client prediction's
  // sprint speed multiplier; drinkingUntil drives the client's movement
  // lock during the animation so prediction matches server-authoritative
  // freeze and there's no rubber-banding.
  coffeeBuffUntil: p.coffeeBuffUntil,
  drinkingUntil: p.drinkingUntil,
  // Voice state mirrored from the player's last `voice_state` ClientMessage.
  // Bots leave these unset → undefined on the wire → other clients render as
  // not speaking. The SpeakerHUD + nameplate badges consume these directly.
  voiceSpeaking: p.voiceSpeaking,
  voiceMutedByVad: p.voiceMutedByVad,
  voiceMutedManual: p.voiceMutedManual,
});
