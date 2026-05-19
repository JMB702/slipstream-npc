import {
  NPC_VOICE,
  npcById,
  type ClientMessage,
  type ServerMessage,
  type Vec3,
} from '@slipstream-npc/shared';
import { useGame } from '../store.js';
import { getMicStream } from './mic.js';
import { isMuted, onMuteChange } from './mute.js';
import { ConvAISession } from './ConvAISession.js';
import { getMicLevel, installMicLevelProbe } from './level.js';

interface PendingContext {
  resolve: (msg: Extract<ServerMessage, { type: 'npc_context' }>) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface VoiceManagerDeps {
  send: (msg: ClientMessage) => void;
  myName: string;
  // Lobby-selected NPC ids. When exactly one, the manager treats that
  // NPC as ConvAI-eligible regardless of its NpcDef.useDecoupledStack
  // flag — see startSession early-bail. Server makes the matching
  // decision via isSingleNpcRoom() so both ends agree without an
  // extra wire-protocol field.
  npcIds: string[];
}

let deps: VoiceManagerDeps | null = null;
let active: ConvAISession | null = null;
let starting = false;
let singleNpcMode = false;
const pendingContext = new Map<string, PendingContext>();
let muteUnsub: (() => void) | null = null;
let lastSelfPos: Vec3 | null = null;
let lastTickAt = 0;
let volumeTimer: ReturnType<typeof setInterval> | null = null;

const POLL_INTERVAL_MS = 250;
const VOLUME_POLL_MS = 100;

export const installVoiceManager = (d: VoiceManagerDeps): void => {
  deps = d;
  singleNpcMode = d.npcIds.length === 1;
  if (!muteUnsub) {
    muteUnsub = onMuteChange((m) => {
      active?.setMuted(m);
    });
  }
  if (volumeTimer === null) {
    volumeTimer = setInterval(() => {
      // Mic level always polled — independent of session state — so the
      // diagnostic HUD shows mic activity even when the SDK is silent.
      const micLevel = getMicLevel();
      if (!active) {
        useGame.getState().setVoiceVolumes(micLevel, 0);
        return;
      }
      useGame.getState().setVoiceVolumes(micLevel, active.getOutputVolume());
    }, VOLUME_POLL_MS);
  }
  // Kick off the analyser pipeline; if mic permission isn't granted yet, it
  // retries on the next install call.
  void installMicLevelProbe();
};

export const teardownVoiceManager = (): void => {
  deps = null;
  void endActive('teardown');
  if (volumeTimer !== null) {
    clearInterval(volumeTimer);
    volumeTimer = null;
  }
  if (muteUnsub) {
    muteUnsub();
    muteUnsub = null;
  }
  for (const p of pendingContext.values()) {
    clearTimeout(p.timer);
    p.reject(new Error('voice manager torn down'));
  }
  pendingContext.clear();
};

export const handleNpcContext = (msg: Extract<ServerMessage, { type: 'npc_context' }>): void => {
  const pending = pendingContext.get(msg.sessionId);
  if (!pending) return;
  clearTimeout(pending.timer);
  pendingContext.delete(msg.sessionId);
  pending.resolve(msg);
};

export const handleNpcAlert = (msg: Extract<ServerMessage, { type: 'npc_alert' }>): void => {
  if (!active || active.sessionId !== msg.sessionId || active.npc.id !== msg.npcId) return;
  console.log(`[voice] npc_alert -> ${msg.npcId}: ${msg.text}`);
  active.sendContextualUpdate(msg.text);
};

export const handleConsentRequired = (): void => {
  // The local consent gate runs before the lobby, so this only fires if the
  // user joined a room whose server hasn't yet recorded their consent in
  // memory (e.g. server restart). Re-send the current local consent.
  const stored = (() => {
    try {
      return localStorage.getItem('slipstream-npc:consent');
    } catch {
      return null;
    }
  })();
  if (!stored || !deps) return;
  try {
    const parsed = JSON.parse(stored) as { version: string };
    deps.send({ type: 'consent', agreed: true, version: parsed.version });
  } catch {
    // ignore
  }
};

let lastReportedClosestId: string | null = null;
let lastReportedDist = -1;

export const tickVoiceProximity = (selfPos: Vec3): void => {
  if (!deps) return;
  lastSelfPos = selfPos;
  const now = performance.now();
  if (now - lastTickAt < POLL_INTERVAL_MS) return;
  lastTickAt = now;

  const closest = findClosestNpc(selfPos);
  // Diagnostic: log when closest NPC or distance bucket changes — proximity
  // problems are otherwise invisible.
  if (closest) {
    const bucket = Math.floor(closest.dist);
    if (closest.npcId !== lastReportedClosestId || bucket !== Math.floor(lastReportedDist)) {
      console.log(
        `[voice] closest npc=${closest.npcId} dist=${closest.dist.toFixed(2)}m radius=${NPC_VOICE.radius}m active=${active?.npc.id ?? 'none'}`,
      );
      lastReportedClosestId = closest.npcId;
      lastReportedDist = closest.dist;
    }
  }
  // If a session is active, hold it open until the ACTIVE NPC exits the
  // radius+hysteresis bubble. Don't kill it just because a different NPC
  // got closer — that thrashes the SDK handshake and prevents any session
  // from stabilizing in a multi-NPC room.
  if (active) {
    const activeDist = distanceToNpc(selfPos, active.npc.id);
    if (activeDist === null) {
      console.log(`[voice] active npc ${active.npc.id} no longer in snapshot, ending session`);
      void endActive('npc_disappeared');
    } else if (activeDist > NPC_VOICE.radius + NPC_VOICE.hysteresis) {
      console.log(
        `[voice] active npc ${active.npc.id} drifted to ${activeDist.toFixed(2)}m (>${NPC_VOICE.radius + NPC_VOICE.hysteresis}m), ending session`,
      );
      void endActive('proximity');
    }
    return;
  }
  if (starting) return;
  if (!closest || closest.dist > NPC_VOICE.radius) return;
  console.log(`[voice] entering bubble for ${closest.npcId} (${closest.dist.toFixed(2)}m), starting session`);
  void startSession(closest.npcId);
};

const distanceToNpc = (self: Vec3, npcId: string): number | null => {
  const snaps = useGame.getState().snapshots;
  const last = snaps[snaps.length - 1];
  if (!last) return null;
  for (const p of last.players.values()) {
    if (p.isBot && p.npcId === npcId && p.alive) {
      const dx = p.position[0] - self[0];
      const dy = p.position[1] - self[1];
      const dz = p.position[2] - self[2];
      return Math.sqrt(dx * dx + dy * dy + dz * dz);
    }
  }
  return null;
};

const findClosestNpc = (
  self: Vec3,
): { npcId: string; dist: number } | null => {
  const snaps = useGame.getState().snapshots;
  const last = snaps[snaps.length - 1];
  if (!last) return null;
  let best: { npcId: string; dist: number } | null = null;
  for (const p of last.players.values()) {
    if (!p.isBot || !p.npcId || !p.alive) continue;
    const dx = p.position[0] - self[0];
    const dy = p.position[1] - self[1];
    const dz = p.position[2] - self[2];
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (!best || d < best.dist) best = { npcId: p.npcId, dist: d };
  }
  return best;
};

const startSession = async (npcId: string): Promise<void> => {
  if (!deps || starting || active) return;
  const npc = npcById(npcId);
  if (!npc) return;
  // Phase 3: decoupled-stack NPCs handle their voice through the
  // server-orchestrated turn-state machine. Proximity still matters for
  // arbitration (NPC must be in the room for the player to address her),
  // but no per-player ConvAI session is opened.
  //
  // SINGLE-NPC OVERRIDE: when the lobby spawned exactly one NPC, route
  // that NPC through ConvAI regardless of the static flag — the server's
  // handleVoiceSessionStart has the matching override so it'll actually
  // mint context for us. ConvAI handles its own STT+LLM+TTS in one
  // provider with no orchestration layer between them.
  if (npc.useDecoupledStack && !singleNpcMode) return;
  starting = true;
  const sessionId = `s_${Math.random().toString(36).slice(2, 10)}`;
  try {
    await getMicStream();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn('[voice] mic permission denied:', err);
    useGame.getState().setVoiceLastError(`mic: ${msg}`);
    starting = false;
    return;
  }
  let ctxMsg: Extract<ServerMessage, { type: 'npc_context' }>;
  try {
    ctxMsg = await requestContext(npcId, sessionId);
    console.log(
      `[voice] got npc_context for ${npcId}: agentId=${ctxMsg.agentId ? 'set' : 'absent'} signedUrl=${ctxMsg.signedUrl ? 'set' : 'absent'}`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn('[voice] failed to get npc_context:', err);
    useGame.getState().setVoiceLastError(`context: ${msg}`);
    starting = false;
    return;
  }
  // Voice and persona both live on the per-NPC agent now. No per-session
  // overrides for either — the agent ID alone selects the right config.
  const session = new ConvAISession(npc, deps.myName, sessionId, {
    onTranscript: (line) => {
      deps?.send({ type: 'transcript', npcId, sessionId, line });
      useGame.getState().pushTranscript({ npcId, sessionId, line });
    },
    onStatusChange: (status) => {
      console.log(`[voice] session ${npcId} status -> ${status}`);
      useGame.getState().setVoiceSessionStatus(status);
      if (status === 'connected') {
        useGame.getState().setVoiceLastError(null);
      } else if (status === 'error') {
        useGame.getState().setVoiceLastError('SDK reported error — see console');
        // Telemetry for B1: if the SDK errored while we still consider this
        // session active, the proximity loop didn't ask for the end — tell
        // the server why it's going away.
        if (active === session) {
          try {
            deps?.send({ type: 'voice_session_end', sessionId: session.sessionId, reason: 'sdk_error' });
          } catch {
            // socket may already be closed
          }
        }
      } else if (status === 'ended') {
        // The SDK ended this session. If `active === session` here, the
        // proximity loop did NOT ask for the end (endActive nulls `active`
        // before awaiting end()) — so this was an SDK-driven drop, the B1
        // signature. Tell the server so the feedback pipeline sees it.
        if (active === session) {
          try {
            deps?.send({ type: 'voice_session_end', sessionId: session.sessionId, reason: 'sdk_ended' });
          } catch {
            // socket may already be closed
          }
          active = null;
          useGame.getState().setActiveVoiceSession(null);
        }
      }
    },
    onModeChange: (mode) => {
      console.log(`[voice] session ${npcId} mode -> ${mode}`);
      useGame.getState().setVoiceMode(mode);
    },
  });
  active = session;
  useGame.getState().setActiveVoiceSession({ npcId, sessionId, npcName: npc.name });
  await session.start({
    ...(ctxMsg.agentId ? { agentId: ctxMsg.agentId } : {}),
    ...(ctxMsg.signedUrl ? { signedUrl: ctxMsg.signedUrl } : {}),
    memoryBlob: ctxMsg.memoryBlob,
    ...(ctxMsg.elapsedSinceLastMs !== undefined
      ? { elapsedSinceLastMs: ctxMsg.elapsedSinceLastMs }
      : {}),
  });
  session.setMuted(isMuted());
  starting = false;
  // Suppress unused-var warning when proximity tick re-uses lastSelfPos in future iterations.
  void lastSelfPos;
};

const requestContext = (
  npcId: string,
  sessionId: string,
): Promise<Extract<ServerMessage, { type: 'npc_context' }>> => {
  if (!deps) return Promise.reject(new Error('no deps'));
  deps.send({ type: 'voice_session_start', npcId, sessionId });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingContext.delete(sessionId);
      reject(new Error('npc_context timeout'));
    }, 5000);
    pendingContext.set(sessionId, { resolve, reject, timer });
  });
};

const endActive = async (reason: string = 'manual'): Promise<void> => {
  if (!active) return;
  const s = active;
  active = null;
  useGame.getState().setActiveVoiceSession(null);
  try {
    deps?.send({ type: 'voice_session_end', sessionId: s.sessionId, reason });
  } catch {
    // socket may already be closed
  }
  await s.end();
};
