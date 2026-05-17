import { Conversation } from '@elevenlabs/client';
import type { TextConversation, VoiceConversation } from '@elevenlabs/client';
import type { NpcDef, TranscriptLine } from '@slipstream-npc/shared';

export interface ConvAICallbacks {
  onTranscript?: (line: TranscriptLine) => void;
  onStatusChange?: (status: 'idle' | 'connecting' | 'connected' | 'ended' | 'error') => void;
  onModeChange?: (mode: 'speaking' | 'listening') => void;
  onClientToolCall?: (name: string, params: unknown) => Promise<string> | string;
}

export class ConvAISession {
  readonly sessionId: string;
  readonly npc: NpcDef;
  readonly playerName: string;
  private conversation: VoiceConversation | TextConversation | null = null;
  private startedAt = 0;
  private ended = false;
  private cb: ConvAICallbacks;

  constructor(npc: NpcDef, playerName: string, sessionId: string, cb: ConvAICallbacks) {
    this.npc = npc;
    this.playerName = playerName;
    this.sessionId = sessionId;
    this.cb = cb;
  }

  async start(opts: {
    agentId?: string;
    signedUrl?: string;
    memoryBlob: string;
    // ms since the player last spoke with this NPC. Drives the
    // greeting-recency bucket (B2 sense-of-time):
    //  <  90s  → suppress the opening line entirely; continue mid-thought.
    //  90s-10m → use resumeLines if persona has them, else suppress.
    //  10m-1d  → fresh greeting (normal pool).
    //  > 1d    → fresh greeting (normal pool); memoryBlob tells the LLM the gap.
    // Undefined = never spoken before → fresh greeting.
    elapsedSinceLastMs?: number;
  }): Promise<void> {
    if (this.conversation || this.ended) return;
    this.cb.onStatusChange?.('connecting');
    if (!opts.agentId && !opts.signedUrl) {
      console.error(
        `[voice] ${this.npc.name} has no agentId. Set it in packages/shared/src/npc-roster.ts ` +
          `after creating the ElevenLabs agent for this NPC. See docs/elevenlabs-setup.md ` +
          `for the full setup walkthrough.`,
      );
      this.cb.onStatusChange?.('error');
      return;
    }
    const authConfig = opts.signedUrl
      ? ({ signedUrl: opts.signedUrl } as const)
      : ({ agentId: opts.agentId! } as const);
    try {
      const elapsed = opts.elapsedSinceLastMs;
      const greetingsPool = this.npc.greetings;
      const resumePool = this.npc.resumeLines ?? [];
      const pickRand = (pool: readonly string[]) =>
        pool[Math.floor(Math.random() * pool.length)] ?? '';
      let firstMessage: string;
      if (elapsed === undefined || elapsed >= 10 * 60_000) {
        // Never spoken before, or long enough that a fresh greeting fits.
        firstMessage = pickRand(greetingsPool);
      } else if (elapsed >= 90_000) {
        // Short pause — prefer a resume line; fall back to silence so the
        // agent picks up where it left off using the memoryBlob context.
        firstMessage = resumePool.length > 0 ? pickRand(resumePool) : '';
      } else {
        // Essentially continuous — no opening line at all.
        firstMessage = '';
      }
      console.log(
        `[voice] ${this.npc.name} firstMessage choice: elapsed=${elapsed === undefined ? 'never' : Math.round(elapsed / 1000) + 's'} → ${firstMessage === '' ? '(suppressed)' : `"${firstMessage.slice(0, 40)}…"`}`,
      );
      // Persona and voice live on the agent itself (one ElevenLabs agent per
      // NPC). Only first_message stays as an override so each session opens
      // appropriately for the recency bucket. Dynamic per-session context
      // (friendship, recent transcripts, live game state, elapsed time) is
      // sent via sendContextualUpdate after connect so it layers on top of
      // the baked persona instead of replacing it.
      this.conversation = await Conversation.startSession({
        ...authConfig,
        overrides: {
          agent: {
            firstMessage,
          },
        },
        dynamicVariables: {
          npc_id: this.npc.id,
          player_name: this.playerName,
          session_id: this.sessionId,
        },
        onConnect: () => {
          this.startedAt = Date.now();
          this.cb.onStatusChange?.('connected');
        },
        onDisconnect: () => {
          this.cb.onStatusChange?.('ended');
        },
        onModeChange: ({ mode }) => {
          this.cb.onModeChange?.(mode);
        },
        onError: (msg) => {
          console.warn(`[voice] session error for ${this.npc.name}: ${msg}`);
          this.cb.onStatusChange?.('error');
        },
        onMessage: ({ message, role }) => {
          if (!message) return;
          this.cb.onTranscript?.({
            role: role === 'user' ? 'user' : 'agent',
            text: message,
            at: Date.now(),
          });
        },
        // Streaming responses can fire onMessage with a short partial first,
        // then the server emits an `agent_response_correction` with the fuller
        // text. Without subscribing, the partial lingers in the transcript as
        // a separate agent turn — players see "you repeated yourself" because
        // the corrected text reads as a near-duplicate. Tag the correction
        // distinctly so the store can replace the last agent line instead of
        // appending. Audio playback of the correction is SDK-internal; this
        // only cleans up the visible transcript.
        onAgentResponseCorrection: (event) => {
          const corrected =
            (event as { corrected_agent_response?: string } | undefined)
              ?.corrected_agent_response ?? '';
          if (!corrected) return;
          this.cb.onTranscript?.({
            role: 'agent',
            text: corrected,
            at: Date.now(),
            correction: true,
          });
        },
        clientTools: {
          // Reserved for v2 client-tool calls. Today the make_friend tool
          // is a server webhook (Phase 6) so the agent doesn't need a
          // browser-side handler.
        },
      });
      // Now that the session is connected, push the dynamic memory blob in as
      // a system message. The SDK queues it for the agent's next turn, so it
      // arrives before the agent's first real response (after the player's
      // first utterance — the greeting was already sent as first_message).
      if (opts.memoryBlob.trim()) {
        try {
          this.conversation.sendContextualUpdate(opts.memoryBlob);
        } catch (err) {
          console.warn(`[voice] initial sendContextualUpdate failed:`, err);
        }
      }
    } catch (err) {
      console.warn(`[voice] startSession failed for ${this.npc.name}:`, err);
      this.cb.onStatusChange?.('error');
    }
  }

  setMuted(muted: boolean): void {
    if (!this.conversation) return;
    if ('setMicMuted' in this.conversation) this.conversation.setMicMuted(muted);
  }

  // Inject a system-level message into the live conversation. Used by the
  // game to feed in-game events (damage, player movement, kill score) to the
  // agent so it can react in voice mid-conversation. The SDK queues these
  // until the agent's next turn.
  sendContextualUpdate(text: string): void {
    if (!this.conversation) return;
    try {
      this.conversation.sendContextualUpdate(text);
    } catch (err) {
      console.warn(`[voice] sendContextualUpdate failed:`, err);
    }
  }

  // Realtime volume probes from the SDK — used to gate the on-head speaker
  // icons on actual audio activity, not just session-open. Returns 0 when
  // there's no live conversation yet.
  getInputVolume(): number {
    if (!this.conversation) return 0;
    try {
      return this.conversation.getInputVolume() || 0;
    } catch {
      return 0;
    }
  }

  getOutputVolume(): number {
    if (!this.conversation) return 0;
    try {
      return this.conversation.getOutputVolume() || 0;
    } catch {
      return 0;
    }
  }

  async end(): Promise<void> {
    if (this.ended) return;
    this.ended = true;
    try {
      await this.conversation?.endSession();
    } catch {
      // The SDK throws if the connection was never established; safe to ignore.
    }
    this.conversation = null;
    this.cb.onStatusChange?.('ended');
  }

  get durationMs(): number {
    return this.startedAt ? Date.now() - this.startedAt : 0;
  }
}
