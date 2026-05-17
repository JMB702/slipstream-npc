// Independent RMS meter on the local mic stream. Runs in parallel to the
// ElevenLabs SDK so the on-head icon (and the diagnostic HUD) reflect "your
// mic is producing audible sound" — not "the SDK believes there's audio."
// This isolates two failure modes that otherwise look identical: a dead mic
// vs. an SDK that opened a mic but isn't analyzing it.

import { getMicStream } from './mic.js';

let ctx: AudioContext | null = null;
let analyser: AnalyserNode | null = null;
let source: MediaStreamAudioSourceNode | null = null;
let buf: Float32Array<ArrayBuffer> | null = null;
let installed = false;
let smoothed = 0;

const SMOOTHING = 0.6;

export const installMicLevelProbe = async (): Promise<void> => {
  if (installed) return;
  installed = true;
  try {
    const stream = await getMicStream();
    // Lazy AudioContext — browsers require a user gesture to start one.
    // installVoiceManager runs after the user clicks Drop in / Join, so the
    // gesture is satisfied. Older browsers may need the prefixed name.
    const Ctor = (window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext })
        .webkitAudioContext) as typeof AudioContext;
    ctx = new Ctor();
    if (ctx.state === 'suspended') await ctx.resume();
    source = ctx.createMediaStreamSource(stream);
    analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.2;
    buf = new Float32Array(new ArrayBuffer(analyser.fftSize * 4));
    source.connect(analyser);
  } catch (err) {
    console.warn('[voice] mic level probe failed:', err);
    installed = false;
  }
};

export const teardownMicLevelProbe = (): void => {
  try {
    source?.disconnect();
  } catch {
    // already disconnected
  }
  source = null;
  analyser = null;
  buf = null;
  if (ctx && ctx.state !== 'closed') void ctx.close();
  ctx = null;
  installed = false;
  smoothed = 0;
};

// Returns 0..1-ish RMS. Smoothed across calls to avoid flicker. Returns 0
// if the probe isn't installed (sane default — the SDK probe still drives
// the SDK-side reading).
export const getMicLevel = (): number => {
  if (!analyser || !buf) return 0;
  analyser.getFloatTimeDomainData(buf);
  let sumSq = 0;
  for (let i = 0; i < buf.length; i++) {
    const v = buf[i]!;
    sumSq += v * v;
  }
  const rms = Math.sqrt(sumSq / buf.length);
  // RMS for typical speaking sits around 0.05-0.15; we don't normalize past
  // 1, just smooth and pass through.
  smoothed = smoothed * SMOOTHING + rms * (1 - SMOOTHING);
  return smoothed;
};
