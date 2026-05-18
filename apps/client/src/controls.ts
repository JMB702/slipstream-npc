// Rebindable controls registry. Single source of truth for which physical
// key / gamepad button drives which in-game action. input.ts and the pose
// keybind handler in LocalPlayer.tsx consult this module on every input
// event so the bindings the menu writes here are live without a page reload.
//
// Mouse buttons, gamepad triggers, and stick axes are NOT rebindable —
// they're physically tied to their role (fire/aim/look/move). The menu shows
// them as "Fixed" rows so the player can still see the full control scheme.
//
// Persistence: localStorage key `slipstream_bindings_v1`. Versioning is in
// the key — bump the suffix if the action set changes incompatibly.

export type ActionId =
  // Movement
  | 'move_forward'
  | 'move_backward'
  | 'strafe_left'
  | 'strafe_right'
  | 'jump'
  | 'sprint'
  // Combat
  | 'reload'
  // World interaction
  | 'interact'
  | 'smoke'
  | 'toggle_combat'
  | 'toggle_fullscreen'
  | 'mute'
  // Poses (numeric debug keys)
  | 'pose_casual'
  | 'pose_combat'
  | 'pose_lean'
  | 'pose_sit'
  | 'pose_lay'
  | 'pose_dance_hiphop'
  | 'pose_dance_salsa'
  | 'pose_dance_silly'
  | 'pose_fight_idle';

export interface ActionMeta {
  id: ActionId;
  label: string;
  description: string;
  // Optional grouping for the menu's section headers.
  group: 'Movement' | 'Combat' | 'World' | 'Poses & Emotes';
}

export const ACTIONS: readonly ActionMeta[] = [
  { id: 'move_forward', label: 'Move Forward', description: 'Walk / run forward', group: 'Movement' },
  { id: 'move_backward', label: 'Move Backward', description: 'Walk / run backward', group: 'Movement' },
  { id: 'strafe_left', label: 'Strafe Left', description: 'Walk / run left', group: 'Movement' },
  { id: 'strafe_right', label: 'Strafe Right', description: 'Walk / run right', group: 'Movement' },
  { id: 'jump', label: 'Jump', description: 'Jump or vault a window', group: 'Movement' },
  { id: 'sprint', label: 'Sprint', description: 'Hold for keyboard; click L3 to toggle on gamepad', group: 'Movement' },
  { id: 'reload', label: 'Reload', description: 'Reload the rifle', group: 'Combat' },
  { id: 'interact', label: 'Interact (hold)', description: 'Hold to use the thing in front of you', group: 'World' },
  { id: 'smoke', label: 'Smoke Emote', description: 'Casual mode only. Rob only.', group: 'World' },
  { id: 'toggle_combat', label: 'Toggle Combat / Casual', description: 'Draw or holster the rifle', group: 'World' },
  { id: 'toggle_fullscreen', label: 'Toggle Fullscreen', description: 'Enter or exit browser fullscreen', group: 'World' },
  { id: 'mute', label: 'Mute Mic', description: 'Hard mute (overrides VAD)', group: 'World' },
  { id: 'pose_casual', label: 'Pose: Casual Idle', description: 'Force casual idle pose', group: 'Poses & Emotes' },
  { id: 'pose_combat', label: 'Pose: Combat', description: 'Draw rifle (same as Toggle)', group: 'Poses & Emotes' },
  { id: 'pose_lean', label: 'Pose: Lean Wall', description: 'Lean against the nearest wall', group: 'Poses & Emotes' },
  { id: 'pose_sit', label: 'Pose: Sit', description: 'Sit down', group: 'Poses & Emotes' },
  { id: 'pose_lay', label: 'Pose: Lay Down', description: 'Lay down', group: 'Poses & Emotes' },
  { id: 'pose_dance_hiphop', label: 'Dance: Hip Hop', description: 'Dance variant 0', group: 'Poses & Emotes' },
  { id: 'pose_dance_salsa', label: 'Dance: Salsa', description: 'Dance variant 1', group: 'Poses & Emotes' },
  { id: 'pose_dance_silly', label: 'Dance: Silly', description: 'Dance variant 2', group: 'Poses & Emotes' },
  { id: 'pose_fight_idle', label: 'Pose: Fight Idle', description: "Rob only. Brief defensive stance — auto-clears after a few seconds.", group: 'Poses & Emotes' },
];

// Default keyboard bindings. `code` matches KeyboardEvent.code values (e.g.
// 'KeyW', 'ShiftLeft', 'Space', 'Digit1'). Two actions may share a key — the
// menu warns on save but allows it (some players intentionally double-bind).
export const DEFAULT_KEYBOARD: Record<ActionId, string | null> = {
  move_forward: 'KeyW',
  move_backward: 'KeyS',
  strafe_left: 'KeyA',
  strafe_right: 'KeyD',
  jump: 'Space',
  sprint: 'ShiftLeft',
  reload: 'KeyR',
  interact: 'KeyE',
  smoke: 'KeyB',
  toggle_combat: 'KeyY',
  toggle_fullscreen: 'KeyF',
  mute: 'KeyM',
  pose_casual: 'Digit1',
  pose_combat: 'Digit2',
  pose_lean: 'Digit3',
  pose_sit: 'Digit4',
  pose_lay: 'Digit5',
  pose_dance_hiphop: 'Digit6',
  pose_dance_salsa: 'Digit7',
  pose_dance_silly: 'Digit8',
  pose_fight_idle: 'Digit9',
};

// Default gamepad bindings. Numeric values are standard-mapping button
// indices (0=A, 1=B, 2=X, 3=Y, 4=LB, 5=RB, 6=LT, 7=RT, 8=Back, 9=Start,
// 10=L3, 11=R3, 12=Dpad-up, 13=Dpad-down, 14=Dpad-left, 15=Dpad-right).
// null = no default binding on this device for this action.
export const DEFAULT_GAMEPAD: Record<ActionId, number | null> = {
  move_forward: null, // left stick axis — not a button
  move_backward: null,
  strafe_left: null,
  strafe_right: null,
  jump: 0, // A
  sprint: 10, // L3 click toggle
  reload: 2, // X
  interact: 3, // Y / Triangle (hold)
  smoke: 13, // D-pad Down
  toggle_combat: 1, // B
  toggle_fullscreen: null, // browsers gate Fullscreen API on a user-input event; gamepad button presses don't count as "user activation" in Chrome, so leave keyboard-only by default
  mute: null, // no gamepad binding by default
  pose_casual: null,
  pose_combat: null,
  pose_lean: null,
  pose_sit: null,
  pose_lay: null,
  pose_dance_hiphop: null,
  pose_dance_salsa: null,
  pose_dance_silly: null,
  pose_fight_idle: null,
};

// Pretty button names for the menu / HUD. Includes physical-mapping rows
// (mouse, triggers) so the menu can show the full control surface even
// though those entries aren't rebindable.
export const GAMEPAD_BUTTON_LABELS: Record<number, string> = {
  0: 'A',
  1: 'B',
  2: 'X',
  3: 'Y',
  4: 'LB',
  5: 'RB',
  6: 'LT',
  7: 'RT',
  8: 'Back / View',
  9: 'Menu / Start',
  10: 'L3 (click)',
  11: 'R3 (click)',
  12: 'D-pad Up',
  13: 'D-pad Down',
  14: 'D-pad Left',
  15: 'D-pad Right',
};

// Human-friendly keyboard names. Falls back to the raw KeyboardEvent.code
// (e.g. 'F13') when no override is set — readable enough.
const KEYBOARD_LABEL_OVERRIDES: Record<string, string> = {
  Space: 'Space',
  ShiftLeft: 'Left Shift',
  ShiftRight: 'Right Shift',
  ControlLeft: 'Left Ctrl',
  ControlRight: 'Right Ctrl',
  AltLeft: 'Left Alt',
  AltRight: 'Right Alt',
  MetaLeft: '⌘ Left',
  MetaRight: '⌘ Right',
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  Tab: 'Tab',
  Enter: 'Enter',
  Escape: 'Escape',
  Backspace: 'Backspace',
  Backquote: '`',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
  CapsLock: 'Caps Lock',
};

export const labelForKey = (code: string | null): string => {
  if (!code) return 'Unbound';
  if (KEYBOARD_LABEL_OVERRIDES[code]) return KEYBOARD_LABEL_OVERRIDES[code]!;
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) return `Num ${code.slice(6)}`;
  return code;
};

export const labelForButton = (idx: number | null): string => {
  if (idx === null || idx === undefined) return 'Unbound';
  return GAMEPAD_BUTTON_LABELS[idx] ?? `Button ${idx}`;
};

// --- Mutable state + persistence ---------------------------------------

const STORAGE_KEY = 'slipstream_bindings_v1';

interface StoredBindings {
  keyboard: Partial<Record<ActionId, string | null>>;
  gamepad: Partial<Record<ActionId, number | null>>;
}

const loadStored = (): StoredBindings => {
  if (typeof window === 'undefined') return { keyboard: {}, gamepad: {} };
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { keyboard: {}, gamepad: {} };
    const parsed = JSON.parse(raw) as StoredBindings;
    return {
      keyboard: parsed.keyboard ?? {},
      gamepad: parsed.gamepad ?? {},
    };
  } catch {
    return { keyboard: {}, gamepad: {} };
  }
};

const stored = loadStored();

const keyboardBindings: Record<ActionId, string | null> = {
  ...DEFAULT_KEYBOARD,
  ...stored.keyboard,
};

const gamepadBindings: Record<ActionId, number | null> = {
  ...DEFAULT_GAMEPAD,
  ...stored.gamepad,
};

const subscribers = new Set<() => void>();
const notify = () => subscribers.forEach((s) => s());

const persist = () => {
  if (typeof window === 'undefined') return;
  const payload: StoredBindings = {
    keyboard: {} as Partial<Record<ActionId, string | null>>,
    gamepad: {} as Partial<Record<ActionId, number | null>>,
  };
  for (const action of ACTIONS) {
    if (keyboardBindings[action.id] !== DEFAULT_KEYBOARD[action.id]) {
      payload.keyboard[action.id] = keyboardBindings[action.id];
    }
    if (gamepadBindings[action.id] !== DEFAULT_GAMEPAD[action.id]) {
      payload.gamepad[action.id] = gamepadBindings[action.id];
    }
  }
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // localStorage full or unavailable; in-memory binding still works for
    // the session.
  }
};

export const getKeyboardBinding = (id: ActionId): string | null =>
  keyboardBindings[id];

export const getGamepadBinding = (id: ActionId): number | null =>
  gamepadBindings[id];

export const setKeyboardBinding = (id: ActionId, code: string | null): void => {
  keyboardBindings[id] = code;
  persist();
  notify();
};

export const setGamepadBinding = (id: ActionId, idx: number | null): void => {
  gamepadBindings[id] = idx;
  persist();
  notify();
};

export const resetAllBindings = (): void => {
  for (const action of ACTIONS) {
    keyboardBindings[action.id] = DEFAULT_KEYBOARD[action.id];
    gamepadBindings[action.id] = DEFAULT_GAMEPAD[action.id];
  }
  persist();
  notify();
};

export const subscribeBindings = (cb: () => void): (() => void) => {
  subscribers.add(cb);
  return () => subscribers.delete(cb);
};

// Reverse-lookup helper used by input.ts for the rare cases where we want
// to know "what action does this physical key/button drive?" — currently
// only used by the menu's conflict warning.
export const actionsBoundToKey = (code: string): ActionId[] =>
  ACTIONS.filter((a) => keyboardBindings[a.id] === code).map((a) => a.id);

export const actionsBoundToButton = (idx: number): ActionId[] =>
  ACTIONS.filter((a) => gamepadBindings[a.id] === idx).map((a) => a.id);

// Fixed (non-rebindable) physical mappings — for menu display only. input.ts
// hardcodes these because they're tied to the hardware role.
export interface FixedBinding {
  label: string;
  device: 'mouse' | 'gamepad' | 'keyboard';
  binding: string;
  description: string;
}

export const FIXED_BINDINGS: readonly FixedBinding[] = [
  { label: 'Look', device: 'mouse', binding: 'Mouse Move', description: 'Move the camera (mouse-look)' },
  { label: 'Fire', device: 'mouse', binding: 'Left Click', description: 'Fire the rifle' },
  { label: 'Aim (ADS)', device: 'mouse', binding: 'Right Click (hold)', description: 'Aim down sights' },
  { label: 'Move', device: 'gamepad', binding: 'Left Stick', description: 'Walk / run direction' },
  { label: 'Look', device: 'gamepad', binding: 'Right Stick', description: 'Camera rotation' },
  { label: 'Aim (ADS)', device: 'gamepad', binding: 'LT (Left Trigger)', description: 'Aim down sights' },
  { label: 'Fire', device: 'gamepad', binding: 'RT (Right Trigger)', description: 'Fire the rifle' },
];
