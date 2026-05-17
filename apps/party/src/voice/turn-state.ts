// Room-scoped turn-taking state machine for the decoupled NPC stack.
//
//   IDLE ─────► HUMAN_SPEAKING ─────► ARBITRATING ─────► NPC_SPEAKING ─────► IDLE
//     ▲              │                     │                  │
//     │              │ (player started)    │ (no candidate)   │ (barge-in)
//     │              ▼                     ▼                  ▼
//     └─────  HUMAN_SPEAKING ─────────  IDLE           HUMAN_SPEAKING (cancel)
//
// Inputs:
//   - voice_state events from each connected human (speaking/silent transitions)
//   - scene transcript lines (finalized utterances from Deepgram)
//   - room roster (which decoupled NPCs are present)
//
// Outputs:
//   - calls back into the server for `start-npc-turn(npcId)` and
//     `cancel-npc-turn(npcId)` actions. The server owns the LLM/TTS streams
//     and the audio broadcast; this module is pure orchestration.
//
// Constants — tuned to the plan's latency target:

export const SILENCE_HOLD_MS = 800;
export const MAX_NPC_CHAIN = 2;

export type TurnPhase =
  | { kind: 'idle' }
  | { kind: 'human_speaking'; speakers: Set<string>; lastSpeakStartedAt: number }
  | { kind: 'arbitrating'; since: number }
  | { kind: 'npc_speaking'; npcId: string; utteranceId: string; startedAt: number; chainCount: number };

export interface TurnStateCallbacks {
  // Fired when the machine has decided that arbitration should run. The
  // server collects scene transcript + candidate roster + lastNpcSpeakerId
  // and calls back into `submitArbitration` with the chosen npcId (or null).
  onArbitrate(): void;
  // Fired when the machine wants the server to start an NPC turn. The
  // server kicks off the LLM + TTS pipeline; chunks come back through the
  // broadcast layer. Returns the utteranceId so the machine can correlate
  // future cancel calls.
  onStartNpcTurn(npcId: string): string;
  // Fired when a player barges in mid-NPC speech. Server cancels the
  // in-flight LLM stream + TTS WS and broadcasts npc_audio_stop.
  onCancelNpcTurn(npcId: string, utteranceId: string): void;
}

// Loop detection: how many NPC turns in a row without a human turn before
// we force a HUMAN_SPEAKING wait. The plan caps NPC chains at 2; this is
// the same number, applied across all NPC turns (chain or otherwise) so
// pathological "two NPCs ping-pong about nothing" scenarios self-correct.
const NPC_TURNS_BEFORE_FORCE_HUMAN = 3;

export class TurnState {
  phase: TurnPhase = { kind: 'idle' };
  // Last NPC who spoke a full turn — used by arbitration's last-speaker
  // bonus. Cleared when conversation truly idles for > 60s.
  lastNpcSpeakerId: string | null = null;
  // Loop guard: count of consecutive NPC turns without a human utterance
  // in between. Reset to 0 every time a human speaks.
  private npcTurnsSinceHuman = 0;
  private cb: TurnStateCallbacks;
  // Tracks per-connection live speaking state. Speakers transition the
  // machine forward; silence transitions back.
  private speakingByConn = new Map<string, boolean>();
  // Silence-hold timer handle. The plain Node setTimeout type works in
  // both Workers and Node test environments.
  private silenceTimer: ReturnType<typeof setTimeout> | null = null;
  private lastSilenceClearAt = 0;

  constructor(cb: TurnStateCallbacks) {
    this.cb = cb;
  }

  // Tear down any pending timers. Called by the server on room shutdown.
  dispose(): void {
    if (this.silenceTimer !== null) {
      clearTimeout(this.silenceTimer);
      this.silenceTimer = null;
    }
  }

  // Connection-level VAD transition. PartyKit's onMessage forwards every
  // voice_state event here. `speaking` is the live VAD bit after the
  // client's 800ms grace window.
  setSpeaking(connId: string, speaking: boolean): void {
    const prev = this.speakingByConn.get(connId) ?? false;
    if (prev === speaking) return;
    this.speakingByConn.set(connId, speaking);

    const anySpeaking = this.anySpeaking();

    // Barge-in: a player started speaking during an NPC turn. Cancel the
    // in-flight TTS immediately.
    if (this.phase.kind === 'npc_speaking' && speaking) {
      this.cb.onCancelNpcTurn(this.phase.npcId, this.phase.utteranceId);
      this.phase = { kind: 'human_speaking', speakers: new Set([connId]), lastSpeakStartedAt: Date.now() };
      return;
    }

    // Idle/arbitrating → human_speaking when someone starts speaking.
    if (anySpeaking && (this.phase.kind === 'idle' || this.phase.kind === 'arbitrating')) {
      this.cancelSilenceTimer();
      // Human speech resets the loop guard. Every chain of NPC turns
      // requires a human utterance to refill the budget.
      this.npcTurnsSinceHuman = 0;
      this.phase = {
        kind: 'human_speaking',
        speakers: new Set([connId]),
        lastSpeakStartedAt: Date.now(),
      };
      return;
    }

    // Human_speaking: track the set of active speakers so we know when
    // "all silent" condition is met.
    if (this.phase.kind === 'human_speaking') {
      if (speaking) {
        this.phase.speakers.add(connId);
        this.cancelSilenceTimer();
        return;
      }
      this.phase.speakers.delete(connId);
      if (!anySpeaking) {
        this.startSilenceTimer();
      }
    }
  }

  // Connection dropped or player went away. Remove from tracking so a
  // crashed client doesn't pin the machine in HUMAN_SPEAKING forever.
  forgetConnection(connId: string): void {
    if (!this.speakingByConn.has(connId)) return;
    this.speakingByConn.delete(connId);
    if (this.phase.kind === 'human_speaking') {
      this.phase.speakers.delete(connId);
      if (!this.anySpeaking()) this.startSilenceTimer();
    }
  }

  // Called by the server when an NPC turn completes (the final TTS chunk
  // was broadcast). If the LLM output mentioned another NPC by name and
  // we're under MAX_NPC_CHAIN, re-enter ARBITRATING. Otherwise return to
  // IDLE. The loop guard also caps total consecutive NPC turns to keep
  // two NPCs from ping-ponging forever about nothing.
  completeNpcTurn(utteranceId: string, chainEligible: boolean): void {
    if (this.phase.kind !== 'npc_speaking' || this.phase.utteranceId !== utteranceId) {
      return;
    }
    this.lastNpcSpeakerId = this.phase.npcId;
    this.npcTurnsSinceHuman += 1;
    const chainCount = this.phase.chainCount;
    const overChainBudget = chainCount >= MAX_NPC_CHAIN;
    const overLoopBudget = this.npcTurnsSinceHuman >= NPC_TURNS_BEFORE_FORCE_HUMAN;
    if (chainEligible && !overChainBudget && !overLoopBudget) {
      this.phase = { kind: 'arbitrating', since: Date.now() };
      this.cb.onArbitrate();
      return;
    }
    this.phase = { kind: 'idle' };
  }

  // Called by the server after arbitration. If `npcId` is null, no NPC
  // scored above threshold — return to IDLE. Otherwise transition to
  // NPC_SPEAKING and let the server start the turn.
  submitArbitration(npcId: string | null): void {
    if (this.phase.kind !== 'arbitrating') return;
    if (!npcId) {
      this.phase = { kind: 'idle' };
      return;
    }
    const utteranceId = this.cb.onStartNpcTurn(npcId);
    const chainCount =
      this.lastNpcSpeakerId && this.lastNpcSpeakerId !== npcId
        ? 1 // first chain step
        : 0;
    this.phase = {
      kind: 'npc_speaking',
      npcId,
      utteranceId,
      startedAt: Date.now(),
      chainCount,
    };
  }

  private anySpeaking(): boolean {
    for (const v of this.speakingByConn.values()) if (v) return true;
    return false;
  }

  private startSilenceTimer(): void {
    this.cancelSilenceTimer();
    this.silenceTimer = setTimeout(() => {
      this.silenceTimer = null;
      this.lastSilenceClearAt = Date.now();
      // Double-check we're still in HUMAN_SPEAKING and nobody resumed.
      if (this.phase.kind !== 'human_speaking') return;
      if (this.anySpeaking()) return;
      this.phase = { kind: 'arbitrating', since: Date.now() };
      this.cb.onArbitrate();
    }, SILENCE_HOLD_MS);
  }

  private cancelSilenceTimer(): void {
    if (this.silenceTimer !== null) {
      clearTimeout(this.silenceTimer);
      this.silenceTimer = null;
    }
  }
}
