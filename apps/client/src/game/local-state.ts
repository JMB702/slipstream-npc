import { PLAYER, type MovableState } from '@slipstream-npc/shared';
import type { InputState } from './input.js';
import type { createInput } from './input.js';

let activeInput: ReturnType<typeof createInput> | null = null;

export const setActiveInput = (input: ReturnType<typeof createInput> | null): void => {
  activeInput = input;
};

export const getActiveInput = (): InputState | null => activeInput?.state ?? null;

export const consumeFire = (): boolean => activeInput?.consumeFire() ?? false;

export const consumeInteractHold = (): boolean => activeInput?.consumeInteractHold() ?? false;

export const getInteractHoldProgress = (): number => activeInput?.getInteractHoldProgress() ?? 0;

const predicted: MovableState = {
  position: [0, PLAYER.height / 2, 0],
  velocity: [0, 0, 0],
  yaw: 0,
  pitch: 0,
  grounded: true,
};

export const getPredictedState = (): MovableState => predicted;

export const setPredictedState = (s: MovableState): void => {
  predicted.position = s.position;
  predicted.velocity = s.velocity;
  predicted.yaw = s.yaw;
  predicted.pitch = s.pitch;
  predicted.grounded = s.grounded;
};

// Current applied camera-to-eye distance (after spring-arm collision + ADS
// damping). The local Character reads this to hide its own body when the
// camera is close enough that the head/torso would occlude the aim cone.
// FollowCamera writes once per frame.
let cameraDist = Infinity;
export const getCameraDist = (): number => cameraDist;
export const setCameraDist = (d: number): void => {
  cameraDist = d;
};

// Drink window — freezes the local player's rendered yaw so the camera
// (which still tracks mouse yaw) orbits FREELY around a stationary
// character. The first `alignMs` of the lock smoothly rotates the rendered
// yaw from startYaw → targetYaw (so the character turns to face the maker
// before the pickup animation plays); the remainder holds at targetYaw.
// Set by Character.tsx's drink-event subscriber; read by LocalPlayer.tsx
// for the character yaw override. Plain `performance.now()` comparisons —
// no callback / no React state.
let drinkLockStart = 0;
let drinkLockDuration = 0;
let drinkLockAlignMs = 0;
let drinkLockStartYaw = 0;
let drinkLockTargetYaw = 0;
export const startDrinkLock = (
  durationMs: number,
  startYaw: number,
  targetYaw: number,
  alignMs: number,
): void => {
  drinkLockStart = performance.now();
  drinkLockDuration = durationMs;
  drinkLockAlignMs = alignMs;
  drinkLockStartYaw = startYaw;
  drinkLockTargetYaw = targetYaw;
};

// Shortest-angle interpolation. Adds/subtracts 2π so the lerp turns the
// short way around the circle (e.g. -3.0 → 3.0 turns ~0.28 rad backward,
// not ~6 rad forward).
const lerpAngle = (a: number, b: number, t: number): number => {
  let delta = b - a;
  while (delta > Math.PI) delta -= Math.PI * 2;
  while (delta < -Math.PI) delta += Math.PI * 2;
  return a + delta * t;
};
const easeInOutQuad = (t: number): number =>
  t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;

// Returns the yaw to render the local character at while a drink is in
// flight, or null when no drink lock is active. LocalPlayer.tsx uses null
// to fall back to the live mouse-driven yaw.
export const getDrinkLockedYaw = (): number | null => {
  if (drinkLockDuration <= 0) return null;
  const elapsed = performance.now() - drinkLockStart;
  if (elapsed >= drinkLockDuration) return null;
  if (drinkLockAlignMs <= 0 || elapsed >= drinkLockAlignMs) {
    return drinkLockTargetYaw;
  }
  const t = elapsed / drinkLockAlignMs;
  return lerpAngle(drinkLockStartYaw, drinkLockTargetYaw, easeInOutQuad(t));
};
