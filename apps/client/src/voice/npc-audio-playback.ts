import type { Vec3 } from '@slipstream-npc/shared';

// Phase 3 NPC audio playback. The server streams raw PCM chunks per NPC
// utterance over the existing PartyKit WebSocket (16-bit signed LE mono
// at NPC_AUDIO_SAMPLE_RATE Hz, base64-encoded); this module unpacks them
// into AudioBuffers and schedules them on a per-NPC AudioBufferSourceNode
// chain so the chunks play gapless. PCM not MP3 — see tts-stream.ts for
// why; the short version is MP3 chunks aren't frame-aligned and dropped
// decodes audibly skipped syllables on longer utterances.
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

// Keep in sync with the output_format query param in tts-stream.ts. PCM
// 24kHz is what ElevenLabs sends, and it's also what the AudioBuffer is
// constructed with — the browser resamples to the AudioContext's output
// rate (usually 48kHz) at playback time.
const NPC_AUDIO_SAMPLE_RATE = 24000;

// Synchronous PCM unpack — base64 → bytes → Int16Array → Float32Array →
// AudioBuffer. No async work, so the per-slot scheduling that follows
// never races: chunks are scheduled in receive order, not decode-completion
// order, which used to shuffle audio when decodes finished out of order.
const decodeBase64Pcm16 = (b64: string): AudioBuffer | null => {
  try {
    const binary = atob(b64);
    const byteLen = binary.length;
    // 16-bit samples → 2 bytes each. An odd byte length means the chunk
    // was truncated mid-sample, which shouldn't happen but guard anyway.
    const sampleCount = byteLen >> 1;
    if (sampleCount === 0) return null;
    const int16 = new Int16Array(sampleCount);
    for (let i = 0, b = 0; i < sampleCount; i++, b += 2) {
      const lo = binary.charCodeAt(b);
      const hi = binary.charCodeAt(b + 1);
      // Little-endian, signed.
      let s = (hi << 8) | lo;
      if (s & 0x8000) s |= ~0xffff;
      int16[i] = s;
    }
    const audioCtx = getCtx();
    const buffer = audioCtx.createBuffer(1, sampleCount, NPC_AUDIO_SAMPLE_RATE);
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < sampleCount; i++) channel[i] = int16[i]! / 32768;
    return buffer;
  } catch (err) {
    console.warn('[npc-audio] PCM unpack failed:', err);
    return null;
  }
};

// Enqueue a chunk for playback. Synchronous — PCM unpack is in-line, no
// awaits, so scheduling happens in receive order. The MP3 era of this
// function awaited decodeAudioData, which caused chunks to be scheduled
// in decode-completion order; on out-of-order completion the audio
// played in the wrong order. PCM removes the await and the race with it.
export const enqueueNpcChunk = (opts: {
  npcId: string;
  utteranceId: string;
  chunkIdx: number;
  mime: string;
  b64: string;
  isFinal: boolean;
}): void => {
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

  const buffer = decodeBase64Pcm16(opts.b64);
  if (!buffer) return;

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
