import { useSyncExternalStore } from 'react';
import { setMicEnabled } from './mic.js';

type Listener = (muted: boolean) => void;

let muted = false;
const listeners = new Set<Listener>();

export const isMuted = (): boolean => muted;

export const setMuted = (next: boolean): void => {
  if (next === muted) return;
  muted = next;
  setMicEnabled(!muted);
  for (const l of listeners) l(muted);
};

export const toggleMute = (): void => setMuted(!muted);

export const onMuteChange = (l: Listener): (() => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

// React hook backed by useSyncExternalStore so any component re-renders
// when mute flips. The MuteIndicator widget uses its own local state; this
// hook is for components like the speaker icon over the local player.
const subscribe = (cb: () => void): (() => void) => {
  const wrapped: Listener = () => cb();
  listeners.add(wrapped);
  return () => {
    listeners.delete(wrapped);
  };
};
const getSnapshot = (): boolean => muted;
export const useMuted = (): boolean => useSyncExternalStore(subscribe, getSnapshot);


let gamepadPollHandle: number | null = null;
const prevButtons = new Map<number, boolean>();

// Xbox button indices we listen for. Y (button 3) was previously also
// mapped to mute, but B is the combat/casual toggle and Y was free territory
// once we standardized — keep Menu/Start only as the gamepad mute path so
// nothing on the right-cluster face buttons silently changes the mic state.
//   9  = Menu (Start)
const GAMEPAD_TOGGLE_BUTTONS = [9];

const pollGamepads = (): void => {
  const pads = navigator.getGamepads ? navigator.getGamepads() : [];
  for (const pad of pads) {
    if (!pad) continue;
    for (const idx of GAMEPAD_TOGGLE_BUTTONS) {
      const button = pad.buttons[idx];
      if (!button) continue;
      const prev = prevButtons.get(idx) ?? false;
      if (button.pressed && !prev) toggleMute();
      prevButtons.set(idx, button.pressed);
    }
  }
  gamepadPollHandle = requestAnimationFrame(pollGamepads);
};

const onKeyDown = (e: KeyboardEvent): void => {
  if (e.key === 'm' || e.key === 'M') {
    // Mute key shouldn't fire when the user is typing into a text input.
    const tag = (e.target as HTMLElement | null)?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    toggleMute();
  }
};

let installed = false;

export const installMuteControls = (): void => {
  if (installed) return;
  installed = true;
  window.addEventListener('keydown', onKeyDown);
  if (gamepadPollHandle === null) gamepadPollHandle = requestAnimationFrame(pollGamepads);
};
