const GUNSHOT_URL = '/audio/gunshot.mp3';
const DRY_FIRE_URL = '/audio/dry-fire.mp3';
const HIT_MARKER_URL = '/audio/hit-marker.mp3';
const RELOAD_URL = '/audio/reload.mp3';
const COFFEE_SIP_URL = '/audio/coffee-sip.mp3';
const FOOTSTEP_URL = '/audio/footstep.mp3';

const GUNSHOT_MAX_DIST = 60;
const GUNSHOT_MIN_VOL = 0.05;
const GUNSHOT_BASE_VOL = 0.35;
const DRY_FIRE_VOL = 0.6;
const HIT_MARKER_VOL = 0.8;
const RELOAD_MAX_DIST = 25;
const RELOAD_MIN_VOL = 0;
const RELOAD_BASE_VOL = 0.5;
const COFFEE_SIP_MAX_DIST = 18;
const COFFEE_SIP_BASE_VOL = 0.6;
const FOOTSTEP_MAX_DIST = 25;
// Muted pending tuning — see CLAUDE.md "Audio" section. Restore to 0.35 to
// re-enable; the cadence ticker in Character.tsx still runs and bails on the
// `gain <= 0` guard below, so flipping the volume alone brings footsteps back.
const FOOTSTEP_BASE_VOL = 0;

// Re-trigger the one-shot at these intervals so a faster gait = shorter
// interval (pitch invariant), not playbackRate (which would chipmunk the
// audio). Both exported so the Character cadence ticker can read them.
export const FOOTSTEP_INTERVAL_WALK_MS = 500;
export const FOOTSTEP_INTERVAL_RUN_MS = 333;
// Speed floor: ignores residual numerical drift while idle so the ticker
// doesn't accidentally fire when the player isn't actually moving.
export const FOOTSTEP_MIN_SPEED = 0.5;

const ONSET_THRESHOLD = 0.1;

let ctx: AudioContext | null = null;
const buffers = new Map<string, Promise<AudioBuffer>>();
const onsets = new Map<string, number>();

function getCtx(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  if (!ctx) {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    ctx = new Ctor();
  }
  if (ctx.state === 'suspended') void ctx.resume();
  return ctx;
}

function load(url: string): Promise<AudioBuffer> {
  const cached = buffers.get(url);
  if (cached) return cached;
  const c = getCtx();
  if (!c) {
    const rejected = Promise.reject(new Error('AudioContext unavailable'));
    rejected.catch(() => {});
    return rejected;
  }
  const p = fetch(url)
    .then((r) => r.arrayBuffer())
    .then((buf) => c.decodeAudioData(buf));
  buffers.set(url, p);
  return p;
}

function findOnset(buffer: AudioBuffer): number {
  const ch = buffer.getChannelData(0);
  let peak = 0;
  for (let i = 0; i < ch.length; i++) {
    const v = Math.abs(ch[i]!);
    if (v > peak) peak = v;
  }
  if (peak === 0) return 0;
  const threshold = peak * ONSET_THRESHOLD;
  for (let i = 0; i < ch.length; i++) {
    if (Math.abs(ch[i]!) >= threshold) return i / buffer.sampleRate;
  }
  return 0;
}

function playBuffer(url: string, gain: number, offset = 0): void {
  const c = getCtx();
  if (!c) return;
  load(url)
    .then((buffer) => {
      const src = c.createBufferSource();
      src.buffer = buffer;
      const g = c.createGain();
      g.gain.value = gain;
      src.connect(g).connect(c.destination);
      src.start(0, offset);
    })
    .catch(() => {});
}

export function playGunshot(distance: number): void {
  const t = Math.max(0, Math.min(1, 1 - distance / GUNSHOT_MAX_DIST));
  const gain = Math.max(GUNSHOT_MIN_VOL, t) * GUNSHOT_BASE_VOL;
  playBuffer(GUNSHOT_URL, gain);
}

export function playDryFire(): void {
  playBuffer(DRY_FIRE_URL, DRY_FIRE_VOL);
}

export function playReload(distance: number): void {
  const t = Math.max(0, Math.min(1, 1 - distance / RELOAD_MAX_DIST));
  const gain = Math.max(RELOAD_MIN_VOL, t) * RELOAD_BASE_VOL;
  if (gain <= 0) return;
  playBuffer(RELOAD_URL, gain);
}

// Coffee-sip cue — plays per drink event. No-op silently if the mp3 isn't in
// /audio/ yet so the rest of the interaction (heal, buff, NPC alert) still
// works while audio is being sourced.
export function playCoffeeSip(distance: number): void {
  const t = Math.max(0, Math.min(1, 1 - distance / COFFEE_SIP_MAX_DIST));
  const gain = t * COFFEE_SIP_BASE_VOL;
  if (gain <= 0) return;
  playBuffer(COFFEE_SIP_URL, gain);
}

export function playFootstep(distance: number): void {
  const t = Math.max(0, Math.min(1, 1 - distance / FOOTSTEP_MAX_DIST));
  const gain = t * FOOTSTEP_BASE_VOL;
  if (gain <= 0) return;
  playBuffer(FOOTSTEP_URL, gain);
}

export function playHitMarker(): void {
  const c = getCtx();
  if (!c) return;
  load(HIT_MARKER_URL)
    .then((buffer) => {
      let offset = onsets.get(HIT_MARKER_URL);
      if (offset === undefined) {
        offset = findOnset(buffer);
        onsets.set(HIT_MARKER_URL, offset);
      }
      playBuffer(HIT_MARKER_URL, HIT_MARKER_VOL, offset);
    })
    .catch(() => {});
}
