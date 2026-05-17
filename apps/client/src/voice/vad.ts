import { MicVAD } from '@ricky0123/vad-web';
import { getMicStream } from './mic.js';

// Voice-activity detection wrapper. Wraps @ricky0123/vad-web (Silero ONNX
// model + AudioWorklet) into a small singleton with a transition callback.
// The lib does the hard parts (mic capture, resampling, model inference,
// worklet hosting); we add:
//  - a single shared instance (one mic, one VAD)
//  - "speaking" → debounced "silent" transitions with a grace window so
//    short pauses inside a sentence don't toggle the speaker off
//  - manual mute integration: while muted, VAD output is forced to silent
//    and the SDK's pause() is called so the model isn't running
//
// Assets (silero_vad.onnx + worklet + ort-web wasm) are served from a
// pinned jsdelivr CDN. They're static, ~2MB total, cached after first load.
// No user audio ever leaves the browser — VAD is purely local. The
// ConsentGate copy notes this so users aren't surprised by the network
// request to jsdelivr.

const VAD_VERSION = '0.0.30';
const ORT_VERSION = '1.14.0';
const ASSET_BASE = `https://cdn.jsdelivr.net/npm/@ricky0123/vad-web@${VAD_VERSION}/dist/`;
const ORT_WASM_BASE = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/`;

const SILENCE_GRACE_MS = 800;

type Listener = (speaking: boolean) => void;

const listeners = new Set<Listener>();
let vad: MicVAD | null = null;
let starting: Promise<void> | null = null;
let speaking = false;
let muted = false;
let silenceTimer: number | null = null;

const emit = (next: boolean): void => {
  if (next === speaking) return;
  speaking = next;
  for (const l of listeners) l(speaking);
};

const handleSpeechStart = (): void => {
  if (silenceTimer !== null) {
    clearTimeout(silenceTimer);
    silenceTimer = null;
  }
  if (muted) return;
  emit(true);
};

const handleSpeechEnd = (): void => {
  if (silenceTimer !== null) clearTimeout(silenceTimer);
  silenceTimer = window.setTimeout(() => {
    silenceTimer = null;
    emit(false);
  }, SILENCE_GRACE_MS);
};

export const startVad = async (): Promise<void> => {
  if (vad) return;
  if (starting) return starting;
  starting = (async () => {
    // Eagerly resolve so a permission failure here aborts vad init cleanly.
    // The library's getStream factory is called again on resume() — we
    // delegate to the same singleton so we don't acquire two mic streams.
    await getMicStream();
    vad = await MicVAD.new({
      getStream: () => getMicStream(),
      pauseStream: async () => {
        // Don't release the mic on VAD pause — other consumers (e.g. the
        // WebRTC mesh) still hold the same MediaStream singleton.
      },
      resumeStream: async () => getMicStream(),
      baseAssetPath: ASSET_BASE,
      onnxWASMBasePath: ORT_WASM_BASE,
      onSpeechStart: handleSpeechStart,
      onSpeechEnd: handleSpeechEnd,
      onVADMisfire: () => {
        // Sub-threshold blip — treat as silent immediately.
        if (silenceTimer !== null) clearTimeout(silenceTimer);
        silenceTimer = null;
        emit(false);
      },
      // Defaults are tuned for podcast-style speech; tweak for game voice
      // chat: shorter min-speech so quick "go!" / "behind you!" register.
      // Library v0.0.30 expresses these in ms, not frames.
      minSpeechMs: 100,
      redemptionMs: 250,
      positiveSpeechThreshold: 0.5,
      negativeSpeechThreshold: 0.35,
    });
    vad.start();
  })()
    .catch((err) => {
      console.warn('[vad] init failed:', err);
      vad = null;
    })
    .finally(() => {
      starting = null;
    });
  return starting;
};

export const stopVad = (): void => {
  if (silenceTimer !== null) {
    clearTimeout(silenceTimer);
    silenceTimer = null;
  }
  if (vad) {
    try {
      vad.destroy();
    } catch {
      // Library throws if the worklet was never connected. Safe to ignore.
    }
    vad = null;
  }
  emit(false);
};

export const setVadMuted = (next: boolean): void => {
  if (next === muted) return;
  muted = next;
  if (muted) {
    emit(false);
    vad?.pause();
  } else {
    vad?.start();
  }
};

export const isVadSpeaking = (): boolean => speaking;

export const onVadChange = (l: Listener): (() => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
