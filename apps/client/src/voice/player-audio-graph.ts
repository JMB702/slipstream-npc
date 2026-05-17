import type { Vec3 } from '@slipstream-npc/shared';

// Spatial audio graph for player voice. One PannerNode per remote peer,
// positioned at the peer's snapshot location. The listener tracks the local
// camera; updated each frame from the R3F scene.
//
// We use AudioBufferSource via MediaStreamAudioSourceNode → GainNode →
// PannerNode → destination. Connecting the MediaStream directly to a
// PannerNode is well-supported in Chrome/Edge/Firefox; Safari has had bugs
// historically — we'd swap to a per-peer <audio> element + captureStream
// trick if Safari support becomes a requirement. Today everything we ship
// targets Chromium so the direct path is fine.

interface Slot {
  source: MediaStreamAudioSourceNode;
  gain: GainNode;
  panner: PannerNode;
  // Required muted-tag <audio> attachment. Chrome will not pull samples from
  // a MediaStream through Web Audio unless the stream is ALSO attached to a
  // media element somewhere. We add a hidden, muted <audio> element to
  // satisfy that constraint; gain is set via the Web Audio chain.
  sink: HTMLAudioElement;
}

const slots = new Map<string, Slot>();
let ctx: AudioContext | null = null;

const getCtx = (): AudioContext => {
  if (!ctx) {
    ctx = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
  }
  // Autoplay policy: contexts not created during a user gesture start in
  // `suspended` and must be resumed after a gesture. resume() returns a
  // promise; on Chromium it resolves once a gesture has occurred. Cheap to
  // call repeatedly — no-ops when already running. Mirrors sfx.ts.
  if (ctx.state === 'suspended') void ctx.resume();
  return ctx;
};

export const attachPeerStream = (peerId: string, stream: MediaStream | null): void => {
  // Remove path: detach + cleanup.
  if (!stream) {
    const slot = slots.get(peerId);
    if (slot) {
      try {
        slot.source.disconnect();
        slot.gain.disconnect();
        slot.panner.disconnect();
      } catch {
        // already gone
      }
      slot.sink.srcObject = null;
      slot.sink.remove();
      slots.delete(peerId);
    }
    return;
  }
  // Replace path (peer reconnected): drop the old slot first.
  if (slots.has(peerId)) attachPeerStream(peerId, null);

  const audioCtx = getCtx();
  const source = audioCtx.createMediaStreamSource(stream);
  const gain = audioCtx.createGain();
  gain.gain.value = 1;
  const panner = audioCtx.createPanner();
  panner.panningModel = 'HRTF';
  panner.distanceModel = 'inverse';
  panner.refDistance = 2;
  panner.maxDistance = 40;
  panner.rolloffFactor = 1.2;
  source.connect(gain).connect(panner).connect(audioCtx.destination);

  // Chrome-only quirk: also pipe the MediaStream into a hidden muted
  // <audio> element so the stream actually pulls samples through Web Audio.
  // Without this the source node receives silence even though the track is
  // active. See https://issues.chromium.org/issues/40089060.
  const sink = document.createElement('audio');
  sink.srcObject = stream;
  sink.muted = true;
  sink.autoplay = true;
  sink.style.display = 'none';
  document.body.appendChild(sink);
  // Autoplay may be blocked until first user gesture — the pointer-lock
  // click on the canvas usually clears it. Retry every 500ms until it
  // sticks; otherwise the muted-<audio>-sink trick never pumps samples
  // into Web Audio and the PannerNode outputs silence. Cleared once play
  // succeeds or the slot is detached.
  let playRetry: number | null = window.setInterval(() => {
    if (!sink.paused) {
      if (playRetry !== null) clearInterval(playRetry);
      playRetry = null;
      return;
    }
    void sink.play().catch(() => {
      // Keep retrying silently — the gesture may not have happened yet.
    });
  }, 500);
  void sink.play().catch(() => {
    // First attempt may reject; the retry loop above handles it.
  });

  slots.set(peerId, { source, gain, panner, sink });
  console.log(
    `[audio-graph] attached peer ${peerId}; ctx.state=${audioCtx.state}, tracks=${stream.getAudioTracks().length}`,
  );
};

// Set a peer's world position (their last known snapshot pos). Called each
// frame from the R3F scene with the latest snapshot data.
export const setPeerPosition = (peerId: string, pos: Vec3): void => {
  const slot = slots.get(peerId);
  if (!slot) return;
  const t = getCtx().currentTime;
  if (slot.panner.positionX) {
    slot.panner.positionX.setValueAtTime(pos[0], t);
    slot.panner.positionY.setValueAtTime(pos[1], t);
    slot.panner.positionZ.setValueAtTime(pos[2], t);
  } else {
    // Safari fallback (older API).
    slot.panner.setPosition(pos[0], pos[1], pos[2]);
  }
};

// Move the listener to the camera. Called each frame with camera position +
// forward vector. Up is fixed (+Y).
export const setListenerPose = (pos: Vec3, forward: Vec3): void => {
  const listener = getCtx().listener;
  const t = getCtx().currentTime;
  if (listener.positionX) {
    listener.positionX.setValueAtTime(pos[0], t);
    listener.positionY.setValueAtTime(pos[1], t);
    listener.positionZ.setValueAtTime(pos[2], t);
    listener.forwardX.setValueAtTime(forward[0], t);
    listener.forwardY.setValueAtTime(forward[1], t);
    listener.forwardZ.setValueAtTime(forward[2], t);
    listener.upX.setValueAtTime(0, t);
    listener.upY.setValueAtTime(1, t);
    listener.upZ.setValueAtTime(0, t);
  } else {
    listener.setPosition(pos[0], pos[1], pos[2]);
    listener.setOrientation(forward[0], forward[1], forward[2], 0, 1, 0);
  }
};

// Force-suspend the audio graph (used on mute-everyone toggles or page hide
// to save CPU). Idempotent.
export const suspendAudioGraph = (): void => {
  if (ctx && ctx.state === 'running') void ctx.suspend();
};

export const resumeAudioGraph = (): void => {
  if (ctx && ctx.state === 'suspended') void ctx.resume();
};
