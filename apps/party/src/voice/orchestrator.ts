import {
  WORLD_BIBLE_SHARED,
  knowledgeForMap,
  voiceForCharacter,
  type MapId,
  type NpcDef,
  type ServerMessage,
  type Vec3,
} from '@slipstream-npc/shared';
import { arbitrate, type ArbCandidate } from './arbitration.js';
import { streamLlmEvents } from './llm.js';
import { NPC_TOOLS } from './tools.js';
import { streamTts } from './tts-stream.js';
import {
  buildSceneSystem,
  buildSceneUserText,
  type RecentNpcTurn,
  type SceneSpeechLine,
} from './scene-prompt.js';
import { TurnState } from './turn-state.js';
import { cleanMetaNarration } from './meta-filter.js';
import { getAgentVoiceId } from './agent-config.js';
import type { NpcStateEntry } from '../storage.js';

// Per-room orchestrator. Wires the TurnState machine to the actual LLM
// (Anthropic) and TTS (ElevenLabs WS) streams, broadcasts NPC audio
// chunks to every client, and handles barge-in cancellation.
//
// The server constructs one of these in onStart per Party.Server and
// forwards relevant lifecycle events:
//   - voice_state ClientMessages → onSpeakingChange
//   - scene transcript lines      → onSceneTranscript
//   - onClose for a connection    → onCloseConnection
//   - room teardown               → dispose
//
// The orchestrator stays narrow on purpose — it knows nothing about
// ServerPlayer, GameStorage, or NpcAlert. It calls back into the server
// through the ContextProvider interface for everything it needs.

const SELF_TURN_HISTORY_LEN = 5;
const SCENE_WINDOW_MS = 90_000;
// Was 200 — too tight once the `think` tool was introduced. Observed
// failure: model spent ~80 tokens on think.scratch reasoning, then ran out
// of budget before opening the `say` content block, producing empty turns.
// 600 leaves comfortable headroom for ~100 tokens of think + ~150 tokens
// of dialogue. Bump again if Rob's pyramid story keeps getting truncated.
const MAX_TOKENS_PER_TURN = 600;
// Pinned model id. The 3.5 Haiku snapshots were retired; current Haiku
// is the 4.5 line. Use the dated snapshot for stability — bump when a
// newer Haiku ships. List available models with `curl /v1/models`.
const LLM_MODEL = 'claude-haiku-4-5-20251001';
const TTS_MODEL = 'eleven_flash_v2_5';
// Transcript-driven arbitration delay. After every finalized Deepgram
// transcript, we wait this long for any follow-up finals before running
// arbitration. Bigger than Deepgram's endpointing (~300ms) so a player
// who says "Hi Mira... can you... hear me?" gets one arbitration on the
// full utterance, not three. Independent of VAD — the @ricky0123/vad-web
// model can fail silently on some networks/setups and this path keeps
// arbitration working without it.
const TRANSCRIPT_ARB_HOLD_MS = 700;
// Extended hold when the last transcript looks incomplete (no terminal
// punctuation). Deepgram with smart_format emits ".!?" at sentence ends;
// an unterminated line almost always means a follow-up final is coming
// within ~1-2s. This prevents a half-utterance like "That thread should
// have been picked..." from arbitrating before "...up by Guts." arrives.
const TRANSCRIPT_ARB_HOLD_INCOMPLETE_MS = 1800;

const ARENA_DESCRIPTION_FALLBACK =
  'Slipstream is a 3D arena where players can shoot each other. You are an NPC who patrols the map. ' +
  'You do not have to fight, but you can defend yourself if attacked. Other players may walk in and out of earshot at any time.';

export interface OrchestratorContext {
  broadcast(msg: ServerMessage): void;
  getDecoupledCandidates(): ArbCandidate[];
  getOtherNpcNames(excludeId: string): string[];
  buildSelfStateLine(npcId: string): string;
  getFriendshipScore(npcId: string, playerName: string): Promise<number>;
  getPersonaDeltas(npcId: string): Promise<NpcStateEntry[]>;
  getSpeakerPosition(speakerName: string): Vec3 | undefined;
  // Anthropic + ElevenLabs API keys. The orchestrator hard-fails the turn
  // (silently — emits no audio) if either is missing.
  getApiKeys(): { anthropic?: string; elevenlabs?: string };
  // The active map id for this room — used to inject the canonical
  // arena description (landmarks, walls, what's where) into every
  // system prompt so NPCs don't invent objects the player can clearly
  // see don't exist.
  getMapId(): MapId;
  // Emit a structured feedback event so /admin/sessions and the pnpm
  // session:last CLI surface decoupled NPC turns alongside legacy ones.
  emit(event: { kind: string; [k: string]: unknown }): void;
  // Phase 4: route a tool_use call from Claude into the existing game
  // handlers (follow_player, patrol, lean_wall, drink_coffee, etc.).
  // Implementation lives on the server because the handlers mutate
  // ServerPlayer state. Fire-and-forget — the LLM doesn't await a
  // tool_result; we just trust the handler ran. The dispatcher emits its
  // own tool_call FeedbackEvent so session:last surfaces the action.
  dispatchTool(npcId: string, playerName: string | null, toolName: string, args: unknown): void;
}

interface ActiveTurn {
  npcId: string;
  utteranceId: string;
  abort: AbortController;
  // Text accumulator — used to compute chainEligible (does this turn
  // mention another NPC by name) and to feed the recent-self-turns
  // history once the turn completes.
  textBuf: string;
  // Wall-clock at which the orchestrator should finalize the turn
  // (release the turn-state machine to IDLE / chain). 0 = not yet
  // scheduled; the audio loop sets this when it sends the final chunk.
  // Polled by tick() — see the same-pattern note on transcriptArbDeadline.
  finalizeAt: number;
  chainEligible: boolean;
}

export class VoiceOrchestrator {
  private turn: TurnState;
  private ctx: OrchestratorContext;
  // Scene speech since the last NPC turn (or since IDLE → HUMAN_SPEAKING).
  // Reset on every arbitration so each NPC turn only sees fresh speech.
  private sceneSinceLastNpcTurn: SceneSpeechLine[] = [];
  // Per-NPC ring of recent self turns. Front-loaded into the prompt so
  // the LLM doesn't repeat itself.
  private recentSelfTurns = new Map<string, RecentNpcTurn[]>();
  private active: ActiveTurn | null = null;
  private nextUtteranceCounter = 0;
  // Wall-clock deadline at which the transcript-driven arbitration should
  // fire. Set on every new scene transcript (resetting the hold so a
  // chain of partials/finals coalesces into one turn). 0 = nothing
  // pending. The server's runTick loop polls this every TICK_MS and
  // triggers arbitration when Date.now() >= the deadline — we used to
  // use setTimeout, but Cloudflare Durable Objects don't reliably fire
  // deferred timers between request handlers, so we drive this off the
  // existing setInterval-based tick that always survives.
  private transcriptArbDeadline = 0;

  constructor(ctx: OrchestratorContext) {
    this.ctx = ctx;
    this.turn = new TurnState({
      onArbitrate: () => this.runArbitration(),
      onStartNpcTurn: (npcId) => this.startNpcTurn(npcId),
      onCancelNpcTurn: (npcId, utteranceId) => this.cancelNpcTurn(npcId, utteranceId),
    });
  }

  onSpeakingChange(connId: string, speaking: boolean): void {
    this.turn.setSpeaking(connId, speaking);
  }

  onSceneTranscript(line: SceneSpeechLine): void {
    this.sceneSinceLastNpcTurn.push(line);
    // Drop ancient lines so a long-idle conversation doesn't accumulate
    // forever. Anything older than SCENE_WINDOW_MS is irrelevant for
    // arbitration / the prompt.
    const cutoff = Date.now() - SCENE_WINDOW_MS;
    while (
      this.sceneSinceLastNpcTurn.length > 0 &&
      this.sceneSinceLastNpcTurn[0]!.at < cutoff
    ) {
      this.sceneSinceLastNpcTurn.shift();
    }

    // Transcript-as-barge-in: a new finalized utterance arriving while an
    // NPC is mid-speech is the most reliable signal we have that the
    // player just spoke over them. VAD would normally fire this, but
    // browser VAD has been flaky in practice. Cancel the active turn so
    // the human's new utterance becomes the next thing arbitration
    // weights — and so the player isn't talked over.
    if (this.active && this.turn.phase.kind === 'npc_speaking') {
      this.ctx.emit({
        kind: 'npc_turn_cancelled',
        npcId: this.active.npcId,
        utteranceId: this.active.utteranceId,
        reason: 'transcript-bargein',
      });
      this.cancelActive('transcript-bargein');
      // Force the state machine back to HUMAN_SPEAKING so the silence
      // path picks it up cleanly. Mirror the turn-state's internal API.
      this.turn.phase = { kind: 'human_speaking', speakers: new Set(), lastSpeakStartedAt: Date.now() };
    }

    // Transcript-driven arbitration: schedule an arbitration pass after a
    // short hold so multiple consecutive finals coalesce. Each new line
    // pushes the deadline out — the actual fire happens in `tick()`
    // which the server's runTick loop calls every TICK_MS. When the
    // latest line looks unterminated ("we should ask" — no period), wait
    // longer for the rest of the sentence to arrive so the name in the
    // second half doesn't miss the arbitration window.
    const looksIncomplete = !/[.!?]\s*$/.test(line.text);
    const hold = looksIncomplete ? TRANSCRIPT_ARB_HOLD_INCOMPLETE_MS : TRANSCRIPT_ARB_HOLD_MS;
    this.transcriptArbDeadline = Date.now() + hold;
  }

  // Called every TICK_MS from the server's runTick loop. The whole point
  // of routing through the tick loop (vs. setTimeout) is that
  // setInterval-based timers survive Cloudflare DO request boundaries
  // while standalone setTimeouts often do not. This is the prod-safe
  // way to schedule deferred work in a Durable Object.
  tick(): void {
    const now = Date.now();
    // Finalize a turn whose TTS finished but whose audio is still
    // playing on the clients. Releases the turn-state to IDLE/chain.
    if (this.active && this.active.finalizeAt > 0 && now >= this.active.finalizeAt) {
      const { npcId, utteranceId, chainEligible } = this.active;
      this.finishTurn(npcId, utteranceId, chainEligible);
    }
    // Run arbitration once the transcript-coalesce hold expires.
    if (this.transcriptArbDeadline > 0 && now >= this.transcriptArbDeadline) {
      this.transcriptArbDeadline = 0;
      this.tryTranscriptDrivenArbitration();
    }
  }

  // Trigger an arbitration pass purely on the basis of a finalized scene
  // transcript, independent of the VAD-based turn-state. Used as a
  // fallback when VAD never reports speaking transitions (silent-model
  // failure, mic permissions revoked mid-session, etc.) — Deepgram's
  // own endpointing IS the authoritative "human just stopped" signal.
  // Skips when an NPC is already speaking so we don't barge-in on our
  // own audio with a duplicate turn.
  private tryTranscriptDrivenArbitration(): void {
    if (this.turn.phase.kind === 'npc_speaking') return;
    if (this.turn.phase.kind === 'arbitrating') return;
    // Force the state machine into ARBITRATING regardless of how we got
    // here. runArbitration will read sceneSinceLastNpcTurn and either
    // pick an NPC or fall back to IDLE.
    this.turn.phase = { kind: 'arbitrating', since: Date.now() };
    this.runArbitration();
  }

  onCloseConnection(connId: string): void {
    this.turn.forgetConnection(connId);
  }

  dispose(): void {
    this.cancelActive('dispose');
    this.transcriptArbDeadline = 0;
    this.turn.dispose();
  }

  private runArbitration(): void {
    const sceneLineCount = this.sceneSinceLastNpcTurn.length;
    const candidates = this.ctx.getDecoupledCandidates();
    if (sceneLineCount === 0 || candidates.length === 0) {
      // Diagnostic: silence triggered arbitration but there's nothing to
      // score against. Either Deepgram hasn't delivered the final
      // transcript yet (rare race — endpointing fires ~300ms, silence
      // hold is 800ms), or DEEPGRAM_API_KEY is missing, or no decoupled
      // candidates are in the room. Emitting so pnpm session:last shows
      // why nothing happened.
      this.ctx.emit({
        kind: 'arbitration_empty',
        sceneLineCount,
        candidateCount: candidates.length,
      });
      this.turn.submitArbitration(null);
      return;
    }
    const speech = this.sceneSinceLastNpcTurn.map((l) => ({
      speakerName: l.speakerName,
      speakerPos: this.ctx.getSpeakerPosition(l.speakerName),
      text: l.text,
    }));
    const decision = arbitrate({
      candidates,
      speech,
      lastNpcSpeakerId: this.turn.lastNpcSpeakerId,
    });
    if (!decision) {
      // Speech existed but no candidate scored above the threshold. Most
      // common cause: scene text was generic small-talk with no name or
      // topic match. Surface so Jeff can tune topicKeywords.
      this.ctx.emit({
        kind: 'arbitration_no_winner',
        sceneLineCount,
        candidateCount: candidates.length,
        sceneSample: speech.slice(-3).map((s) => `${s.speakerName}:${s.text}`).join(' | '),
      });
      this.turn.submitArbitration(null);
      return;
    }
    this.ctx.emit({
      kind: 'arbitration_pick',
      npcId: decision.npcId,
      score: decision.score,
      reasons: decision.reasons,
    });
    this.turn.submitArbitration(decision.npcId);
  }

  private startNpcTurn(npcId: string): string {
    const utteranceId = `u-${Date.now()}-${this.nextUtteranceCounter++}`;
    const abort = new AbortController();
    this.active = { npcId, utteranceId, abort, textBuf: '', finalizeAt: 0, chainEligible: false };
    // Snapshot the scene speech now and clear the buffer so the next
    // turn starts fresh. We intentionally don't include this NPC's own
    // upcoming response in the next arbitration window — it shows up
    // through the lastNpcSpeakerId bonus instead.
    const speech = this.sceneSinceLastNpcTurn.slice();
    this.sceneSinceLastNpcTurn = [];
    void this.runNpcTurn(npcId, utteranceId, speech, abort.signal);
    return utteranceId;
  }

  private cancelNpcTurn(npcId: string, utteranceId: string): void {
    if (!this.active || this.active.npcId !== npcId || this.active.utteranceId !== utteranceId) {
      return;
    }
    this.cancelActive('barge-in');
  }

  private cancelActive(reason: string): void {
    if (!this.active) return;
    const { npcId, utteranceId, abort } = this.active;
    try {
      abort.abort(reason);
    } catch {
      // already aborted
    }
    this.ctx.broadcast({ type: 'npc_audio_stop', npcId, utteranceId });
    this.ctx.emit({ kind: 'npc_turn_cancelled', npcId, utteranceId, reason });
    this.active = null;
  }

  private async runNpcTurn(
    npcId: string,
    utteranceId: string,
    speech: SceneSpeechLine[],
    signal: AbortSignal,
  ): Promise<void> {
    const candidates = this.ctx.getDecoupledCandidates();
    const candidate = candidates.find((c) => c.npc.id === npcId);
    if (!candidate) {
      this.finishTurn(npcId, utteranceId, /* chainEligible */ false);
      return;
    }
    const keys = this.ctx.getApiKeys();
    if (!keys.anthropic || !keys.elevenlabs) {
      console.warn('[orchestrator] missing API key — skipping NPC turn');
      this.ctx.emit({
        kind: 'npc_turn_aborted',
        npcId,
        utteranceId,
        reason: !keys.anthropic ? 'no-anthropic-key' : 'no-elevenlabs-key',
      });
      this.finishTurn(npcId, utteranceId, false);
      return;
    }
    // Voice id resolution order:
    //   1. Live agent config from ElevenLabs (cached). Lets you change the
    //      voice in the ElevenLabs UI and have it propagate to the game
    //      without a code edit. Returns null when the agent id is a
    //      placeholder, the API key is missing, or the fetch fails — at
    //      which point we fall through.
    //   2. Explicit NpcDef.voiceId override (rarely set).
    //   3. Per-character VOICE_BY_CHARACTER fallback (always populated).
    const liveAgentVoice = await getAgentVoiceId(
      candidate.npc.agentId,
      keys.elevenlabs,
    );
    const voiceId =
      liveAgentVoice ??
      candidate.npc.voiceId ??
      voiceForCharacter(candidate.npc.characterId);
    if (!voiceId) {
      console.warn(`[orchestrator] npc ${npcId} has no resolvable voiceId; skipping`);
      this.finishTurn(npcId, utteranceId, false);
      return;
    }

    // Gather prompt inputs in parallel — these are independent storage
    // lookups so issuing concurrently shaves ~30-50ms off TTFB.
    const speakerNames = Array.from(new Set(speech.map((l) => l.speakerName)));
    const [personaDeltas, friendshipScores] = await Promise.all([
      this.ctx.getPersonaDeltas(npcId),
      Promise.all(
        speakerNames.map(async (n) => ({
          name: n,
          score: await this.ctx.getFriendshipScore(npcId, n),
        })),
      ),
    ]);
    const friendshipByPlayer: Record<string, number> = {};
    for (const f of friendshipScores) friendshipByPlayer[f.name] = f.score;

    // World bible: shared backstory (facts every NPC knows) + the per-
    // map description (what's actually in the room). Both come from the
    // artist-editable HTML docs (docs/backstory.html, docs/map-*.html)
    // via `pnpm bake:bible`. Falls back to the generic blurb on an
    // unknown map id so NPCs still have SOMETHING to refer to.
    const mapKnowledge =
      knowledgeForMap(this.ctx.getMapId()) ?? ARENA_DESCRIPTION_FALLBACK;
    const system = buildSceneSystem({
      npc: candidate.npc,
      worldBibleShared: WORLD_BIBLE_SHARED,
      arenaDescription: mapKnowledge,
      selfStateLine: this.ctx.buildSelfStateLine(npcId),
      personaDeltas,
      scene: speech,
      recentSelfTurns: this.recentSelfTurns.get(npcId) ?? [],
      otherNpcNames: this.ctx.getOtherNpcNames(npcId),
      friendshipByPlayer,
    });
    const userText = buildSceneUserText(speech);

    this.ctx.emit({
      kind: 'npc_turn_start',
      npcId,
      utteranceId,
      sceneLineCount: speech.length,
    });

    const startedAt = Date.now();
    // Pick the "primary speaker" — the player whose utterance most likely
    // prompted this NPC turn. Used as the playerName for tool dispatches
    // when Claude calls a tool with no player_name arg (most tools take one,
    // but the schema makes it optional in some cases).
    const primarySpeaker = speech.length > 0 ? speech[speech.length - 1]!.speakerName : null;
    try {
      const llmStream = streamLlmEvents({
        apiKey: keys.anthropic,
        model: LLM_MODEL,
        system,
        userText,
        maxTokens: MAX_TOKENS_PER_TURN,
        tools: NPC_TOOLS,
        signal,
      });
      // Split the LLM event stream into:
      //   - tool_use(say) events  → concatenated lines forwarded to TTS
      //   - other tool_use events → dispatch into the server's game handlers
      //   - raw text deltas       → discarded (the structural anti-meta gate)
      //
      // The model is instructed to emit ALL spoken dialogue through the
      // `say` tool. Free text outside the tool is silently dropped, which
      // eliminates the meta-narration leak class entirely: there's no
      // channel for the model to read system messages, markdown bullets,
      // or its own reasoning aloud. The legacy text-buffer path used to
      // pipe raw text through `cleanMetaNarration`; we keep that as a
      // backstop only if the model ignores the tool and emits text anyway,
      // which logs a warning.
      const teeStream = (async function* (this: VoiceOrchestrator) {
        const spokenParts: string[] = [];
        let strayText = '';
        for await (const evt of llmStream) {
          if (evt.type === 'text') {
            strayText += evt.delta;
          } else if (evt.type === 'tool_use') {
            if (evt.name === 'think') {
              // Architectural meta-narration fix: `think` is the model's
              // private scratch pad. We OBSERVE the reasoning (so we can
              // see what the model was thinking when debugging) but never
              // forward it anywhere. The TTS pipeline has no code path
              // that could route this to the speaker — it's a construction-
              // level guarantee, not a filter.
              const scratch = (evt.input as { scratch?: unknown })?.scratch;
              const text = typeof scratch === 'string' ? scratch.trim() : '';
              if (text.length > 0) {
                console.log(
                  `[think] ${npcId}: ${text.slice(0, 300)}${text.length > 300 ? '…' : ''}`,
                );
              }
              continue;
            }
            if (evt.name === 'say') {
              const raw = (evt.input as { line?: unknown })?.line;
              const rawLine = typeof raw === 'string' ? raw.trim() : '';
              if (rawLine.length === 0) continue;
              // Even with the say-tool structural gate + think-tool sanctioned
              // reasoning channel, paranoia: a regression in the model could
              // still see it put meta into `line:`. The cleaner is the
              // last-line defense.
              const cleanedLine = cleanMetaNarration(rawLine);
              if (cleanedLine.length === 0) {
                console.log(
                  `[say-tool] ${npcId} say() contained only meta; dropped. raw=${rawLine.slice(0, 200)}`,
                );
                continue;
              }
              if (cleanedLine !== rawLine) {
                console.log(
                  `[say-tool] ${npcId} say() cleaned ${rawLine.length}→${cleanedLine.length}`,
                );
              }
              spokenParts.push(cleanedLine);
            } else {
              this.ctx.dispatchTool(npcId, primarySpeaker, evt.name, evt.input);
            }
          }
        }
        const spoken = spokenParts.join(' ').trim();
        // Backstop: if the model emits raw text instead of using `say`,
        // log it and fall back to the cleaner so the player still hears
        // something. The new tool-based path SHOULD make this 0% of turns.
        let final = spoken;
        if (final.length === 0 && strayText.trim().length > 0) {
          const cleaned = cleanMetaNarration(strayText);
          if (cleaned.length > 0) {
            console.warn(
              `[say-tool] ${npcId} emitted raw text instead of calling \`say\`; falling back. raw=${strayText.slice(0, 200)}`,
            );
            final = cleaned;
          } else {
            console.log(
              `[say-tool] ${npcId} emitted only meta text, no \`say\` call; staying silent. raw=${strayText.slice(0, 200)}`,
            );
            return;
          }
        }
        if (this.active && this.active.utteranceId === utteranceId) {
          this.active.textBuf = final;
        }
        if (final.length > 0) yield final;
      }).call(this);

      const audioStream = streamTts({
        apiKey: keys.elevenlabs,
        voiceId,
        modelId: TTS_MODEL,
        textDeltas: teeStream as AsyncIterable<string>,
        signal,
      });

      let chunkIdx = 0;
      let firstChunkAt: number | null = null;
      for await (const audio of audioStream) {
        if (signal.aborted) break;
        if (firstChunkAt === null) {
          firstChunkAt = Date.now();
          this.ctx.emit({
            kind: 'npc_first_audio',
            npcId,
            utteranceId,
            firstChunkMs: firstChunkAt - startedAt,
          });
        }
        this.ctx.broadcast({
          type: 'npc_audio_chunk',
          npcId,
          utteranceId,
          chunkIdx: chunkIdx++,
          mime: 'audio/mpeg',
          b64: audio.audioB64,
          isFinal: false,
        });
      }
      if (signal.aborted) return; // cancelActive already broadcast the stop

      // Final marker so clients release the buffer.
      this.ctx.broadcast({
        type: 'npc_audio_chunk',
        npcId,
        utteranceId,
        chunkIdx: chunkIdx,
        mime: 'audio/mpeg',
        b64: '',
        isFinal: true,
      });

      this.recordSelfTurn(npcId);
      const chainEligible = this.checkChainEligible(npcId);
      const fullText = this.active?.textBuf ?? '';
      this.ctx.emit({
        kind: 'npc_turn_end',
        npcId,
        utteranceId,
        durationMs: Date.now() - startedAt,
        text: fullText.slice(0, 500),
      });
      // The audio loop is done sending chunks, but the client is still
      // playing the queue. If we transition out of npc_speaking now,
      // arbitration will fire on the next transcript and a second NPC will
      // start talking over the still-audible first. Hold the turn-state
      // for an estimated playback duration. setTimeout doesn't survive
      // DO request boundaries in prod, so stamp a deadline that tick()
      // polls every TICK_MS.
      const estimatedPlaybackMs =
        Math.max(800, fullText.length * 65) + 300;
      const elapsedMs = Date.now() - startedAt;
      const remainingMs = Math.max(0, estimatedPlaybackMs - elapsedMs);
      if (this.active && this.active.utteranceId === utteranceId) {
        this.active.chainEligible = chainEligible;
        this.active.finalizeAt = Date.now() + remainingMs;
      }
    } catch (err) {
      if (signal.aborted) return;
      console.warn(`[orchestrator] npc turn ${npcId} failed:`, err);
      this.ctx.broadcast({ type: 'npc_audio_stop', npcId, utteranceId });
      this.ctx.emit({
        kind: 'npc_turn_error',
        npcId,
        utteranceId,
        message: (err as Error).message ?? String(err),
      });
      this.finishTurn(npcId, utteranceId, false);
    }
  }

  private finishTurn(npcId: string, utteranceId: string, chainEligible: boolean): void {
    this.active = null;
    this.turn.completeNpcTurn(utteranceId, chainEligible);
    void npcId; // not currently used in TurnState but reserved for future routing
  }

  private recordSelfTurn(npcId: string): void {
    const text = this.active?.textBuf.trim();
    if (!text) return;
    const list = this.recentSelfTurns.get(npcId) ?? [];
    list.push({ at: Date.now(), text });
    while (list.length > SELF_TURN_HISTORY_LEN) list.shift();
    this.recentSelfTurns.set(npcId, list);
  }

  // Chain trigger: did this NPC's response mention another decoupled NPC
  // by name (or any of their aliases)? If so, the turn-state machine
  // re-enters ARBITRATING with the last-speaker bonus pointing away from
  // this one, so a different NPC can pick it up.
  private checkChainEligible(currentNpcId: string): boolean {
    const text = this.active?.textBuf ?? '';
    if (!text) return false;
    const candidates = this.ctx.getDecoupledCandidates();
    for (const c of candidates) {
      if (c.npc.id === currentNpcId) continue;
      const tokens = [c.npc.name, ...(c.npc.nameAliases ?? [])];
      for (const t of tokens) {
        if (!t) continue;
        const re = new RegExp(`\\b${escapeRegex(t)}\\b`, 'i');
        if (re.test(text)) return true;
      }
    }
    return false;
  }
}

const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Helper for the server: build an ArbCandidate from a known NpcDef and the
// matching ServerPlayer. Kept here so the server doesn't import ArbCandidate
// shape directly — the orchestrator owns its inputs.
export const npcDefToCandidate = (
  npc: NpcDef,
  position: Vec3,
  alive: boolean,
): ArbCandidate => ({ npc, position, alive });
