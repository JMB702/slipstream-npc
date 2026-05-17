import type { Vec3 } from '@slipstream-npc/shared';

// Phase 3 NPC audio playback. The server streams MP3 chunks per NPC
// utterance over the existing PartyKit WebSocket; this module decodes
// them with Web Audio's `decodeAudioData` and schedules them on a per-NPC
// AudioBufferSourceNode chain so the chunks play gapless.
//
// Spatial: the source chain routes through a PannerNode positioned at
// the NPC's snapshot location. The listener pose comes from the same
// player-audio-graph singleton that drives peer voice, so NPC audio is
// spatialized against the same camera basis without an extra setup
// dance.
//
// Cancellation: `stopNpcUtterance(npcId, utteranceId)` clears the queue
// and stops any in-flight sources. The server broadcasts npc_audio_stop
// when the player barges in; we honor it within ~30ms (one AudioContext
// scheduling tick).

interface Slot {
  panner: PannerNode;
  // Wall-clock time of the next scheduled chunk start. Chunks chain end-
  // to-end against this so playback is gapless even when decode + queue
  // latency varies.
  nextStartAt: number;
  // Currently active utterance — chunks from a different utteranceId are
  // ignored. The server only sends one utterance per NPC at a time, but
  // a barge-in + immediate restart can race the stop broadcast.
  utteranceId: string | null;
  // Live source nodes so we can hard-stop on barge-in. Sources self-
  // unregister when their `onended` fires.
  active: Set<AudioBufferSourceNode>;
  // True once an `isFinal` chunk has been received and the trailing
  // source has finished playing. The slot is kept around for re-use
  // (avoid PannerNode churn) but conceptually idle.
  drainedFinal: boolean;
}

const slots = new Map<string, Slot>();
let ctx: AudioContext | null = null;

const getCtx = (): AudioContext => {
  if (!ctx) {
    ctx = new (window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
  }
  if (ctx.state === 'suspended') void ctx.resume();
  return ctx;
};

const createSlot = (npcId: string): Slot => {
  const audioCtx = getCtx();
  const panner = audioCtx.createPanner();
  panner.panningModel = 'HRTF';
  panner.distanceModel = 'inverse';
  // NPC voices carry a touch further than peer voice (NPCs are intentionally
  // findable across the room; the SpeakerHUD arrow + audio is the wayfinding
  // affordance). Reference 3m, max 50m, gentle rolloff.
  panner.refDistance = 3;
  panner.maxDistance = 50;
  panner.rolloffFactor = 1.0;
  panner.connect(audioCtx.destination);
  const slot: Slot = {
    panner,
    nextStartAt: audioCtx.currentTime,
    utteranceId: null,
    active: new Set(),
    drainedFinal: false,
  };
  slots.set(npcId, slot);
  return slot;
};

const decodeBase64Mp3 = async (b64: string): Promise<AudioBuffer | null> => {
  const audioCtx = getCtx();
  try {
    // Manual atob → Uint8Array → ArrayBuffer. atob is broadly available and
    // doesn't require Buffer polyfills that Vite would otherwise complain
    // about for ESM client builds.
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return await audioCtx.decodeAudioData(bytes.buffer);
  } catch (err) {
    console.warn('[npc-audio] decode failed:', err);
    return null;
  }
};

// Enqueue a chunk for playback. Out-of-order chunks (chunkIdx older than
// the most recent enqueued for the same utterance) are dropped; this only
// matters if PartyKit reorders, which it shouldn't, but the gate is cheap.
export const enqueueNpcChunk = async (opts: {
  npcId: string;
  utteranceId: string;
  chunkIdx: number;
  mime: string;
  b64: string;
  isFinal: boolean;
}): Promise<void> => {
  const slot = slots.get(opts.npcId) ?? createSlot(opts.npcId);

  // Utterance handoff: a new utteranceId implies the previous one ended
  // cleanly OR was stopped (the server is responsible for sending
  // npc_audio_stop before reusing the slot). Clear stale state so the
  // chain restarts at "now."
  if (slot.utteranceId !== opts.utteranceId) {
    slot.utteranceId = opts.utteranceId;
    slot.drainedFinal = false;
    slot.nextStartAt = getCtx().currentTime;
  }

  if (opts.isFinal && !opts.b64) {
    // Final marker only — no audio payload. Just records that this
    // utterance is complete. The trailing source's onended handles slot
    // cleanup once it finishes playing.
    slot.drainedFinal = true;
    return;
  }

  const buffer = await decodeBase64Mp3(opts.b64);
  if (!buffer) return;
  // Guard against late chunks from a cancelled utterance: if the server
  // broadcast npc_audio_stop and reset utteranceId, drop this chunk.
  if (slot.utteranceId !== opts.utteranceId) return;

  const audioCtx = getCtx();
  const source = audioCtx.createBufferSource();
  source.buffer = buffer;
  source.connect(slot.panner);
  const startAt = Math.max(audioCtx.currentTime, slot.nextStartAt);
  source.start(startAt);
  slot.nextStartAt = startAt + buffer.duration;
  slot.active.add(source);
  source.onended = () => {
    slot.active.delete(source);
  };

  if (opts.isFinal) {
    slot.drainedFinal = true;
  }
};

// Hard-cancel: stop every queued source for an NPC and reset the chain.
// Called on npc_audio_stop ServerMessages (barge-in) and on disconnect.
export const stopNpcUtterance = (npcId: string, utteranceId?: string): void => {
  const slot = slots.get(npcId);
  if (!slot) return;
  if (utteranceId && slot.utteranceId !== utteranceId) return;
  for (const source of slot.active) {
    try {
      source.stop();
      source.disconnect();
    } catch {
      // already stopped
    }
  }
  slot.active.clear();
  slot.utteranceId = null;
  slot.nextStartAt = getCtx().currentTime;
  slot.drainedFinal = true;
};

// Position update from the snapshot. Called each frame (or each snapshot
// ingest) with the NPC's current world position.
export const setNpcAudioPosition = (npcId: string, pos: Vec3): void => {
  const slot = slots.get(npcId);
  if (!slot) return;
  const t = getCtx().currentTime;
  if (slot.panner.positionX) {
    slot.panner.positionX.setValueAtTime(pos[0], t);
    slot.panner.positionY.setValueAtTime(pos[1], t);
    slot.panner.positionZ.setValueAtTime(pos[2], t);
  } else {
    slot.panner.setPosition(pos[0], pos[1], pos[2]);
  }
};

// Drop everything — used on room teardown. Closes the audio context if
// nothing else is holding it (peer audio graph has its own context).
export const teardownNpcAudio = (): void => {
  for (const [, slot] of slots) {
    for (const source of slot.active) {
      try {
        source.stop();
        source.disconnect();
      } catch {
        // already
      }
    }
    try {
      slot.panner.disconnect();
    } catch {
      // already
    }
  }
  slots.clear();
};

// Diagnostic for the in-game VoiceDebug panel — mirrors the shape used
// by mesh + player-audio-graph getters.
export interface NpcAudioSlotInfo {
  npcId: string;
  utteranceId: string | null;
  activeSources: number;
  drainedFinal: boolean;
}
export const getNpcAudioState = (): NpcAudioSlotInfo[] =>
  Array.from(slots.entries()).map(([npcId, s]) => ({
    npcId,
    utteranceId: s.utteranceId,
    activeSources: s.active.size,
    drainedFinal: s.drainedFinal,
  }));

// Currently-speaking NPC ids — slot has an active utterance with at least
// one source playing. Used by the SpeakerHUD to render NPC rows.
export const getSpeakingNpcIds = (): string[] => {
  const out: string[] = [];
  for (const [npcId, slot] of slots) {
    if (slot.utteranceId && slot.active.size > 0) out.push(npcId);
  }
  return out;
};
