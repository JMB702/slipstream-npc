export interface InputState {
  forward: number;
  right: number;
  jump: boolean;
  sprint: boolean;
  fire: boolean;
  reload: boolean;
  // "Use the thing in front of me" — hold to engage. Tracks the wall-clock
  // start of the current hold (E key or gamepad Y); null when not pressed.
  // The full interact press is fired by consumeInteractHold() once the hold
  // duration exceeds INTERACT_HOLD_MS, gated by an internal flag so a single
  // hold can't fire repeatedly.
  interactHeldSince: number | null;
  // Hold-to-aim flag (RMB on PC, LT/L2 on gamepad). Camera reads this to
  // pull in for ADS — purely a presentation flag, not gameplay-affecting.
  aiming: boolean;
  yaw: number;
  pitch: number;
  pointerLocked: boolean;
}

// How long the player must hold E / gamepad Y before the interact fires.
// The CoffeePrompt progress arc fills over the same duration so the hold
// feels intentional — a brief commitment, not a tap.
export const INTERACT_HOLD_MS = 1500;

export const createInput = (canvas: HTMLCanvasElement): {
  state: InputState;
  consumeFire(): boolean;
  consumeInteractHold(): boolean;
  getInteractHoldProgress(): number;
  destroy(): void;
} => {
  const state: InputState = {
    forward: 0,
    right: 0,
    jump: false,
    sprint: false,
    fire: false,
    reload: false,
    interactHeldSince: null,
    aiming: false,
    yaw: 0,
    pitch: 0,
    pointerLocked: false,
  };

  // Once a hold completes and fires interact, this flag suppresses re-firing
  // for the remainder of that hold. Cleared on release so the next press is
  // a fresh hold. Kept outside `state` because callers shouldn't read it
  // directly — consumeInteractHold() is the only sanctioned consumer.
  let interactFiredThisHold = false;

  // Movement and buttons are merged from two sources (keyboard, gamepad).
  // Each source writes to its own slot; mergeAxes/mergeButtons recompute the
  // public state. This keeps either source from clobbering the other.
  let kbForward = 0;
  let kbRight = 0;
  let kbJump = false;
  let kbSprint = false;
  let kbReload = false;
  let mouseAim = false;

  let gpForward = 0;
  let gpRight = 0;
  let gpJump = false;
  let gpSprint = false;
  let gpReload = false;
  let gpAim = false;

  const mergeAxes = () => {
    state.forward = clampUnit(kbForward + gpForward);
    state.right = clampUnit(kbRight + gpRight);
  };
  const mergeButtons = () => {
    state.jump = kbJump || gpJump;
    state.sprint = kbSprint || gpSprint;
    state.reload = kbReload || gpReload;
    state.aiming = mouseAim || gpAim;
  };

  const keys = new Set<string>();

  const updateKbAxes = () => {
    kbForward = (keys.has('KeyW') ? 1 : 0) - (keys.has('KeyS') ? 1 : 0);
    kbRight = (keys.has('KeyD') ? 1 : 0) - (keys.has('KeyA') ? 1 : 0);
    kbJump = keys.has('Space');
    kbSprint = keys.has('ShiftLeft') || keys.has('ShiftRight');
    kbReload = keys.has('KeyR');
    mergeAxes();
    mergeButtons();
  };

  const onKeyDown = (e: KeyboardEvent) => {
    // Start a fresh interact hold on KeyE press. Skip if E is already held
    // (OS key-repeat would otherwise reset the timer).
    if (e.code === 'KeyE' && !keys.has('KeyE')) {
      state.interactHeldSince = performance.now();
      interactFiredThisHold = false;
    }
    keys.add(e.code);
    updateKbAxes();
  };
  const onKeyUp = (e: KeyboardEvent) => {
    if (e.code === 'KeyE') {
      state.interactHeldSince = null;
      interactFiredThisHold = false;
    }
    keys.delete(e.code);
    updateKbAxes();
  };

  let dropNextMouseMove = false;

  const onMouseMove = (e: MouseEvent) => {
    if (!state.pointerLocked) return;
    if (document.pointerLockElement !== canvas) return;
    if (dropNextMouseMove) {
      dropNextMouseMove = false;
      return;
    }
    // Browsers occasionally deliver large movement deltas — typically the first
    // event after pointer-lock engages, after a tab regains focus, or when the
    // OS coalesces buffered mouse motion. Clamp so a single spurious event
    // can't whip the camera around.
    const dx = clampMovement(e.movementX);
    const dy = clampMovement(e.movementY);
    // While aiming, drop look sensitivity so the higher-zoom view still tracks
    // smoothly. Standard FPS convention — keeps muscle memory consistent.
    const sens = state.aiming ? ADS_SENSITIVITY : 1;
    state.yaw -= dx * 0.0025 * sens;
    state.pitch -= dy * 0.0025 * sens;
    clampPitch();
  };

  const onMouseDown = (e: MouseEvent) => {
    if (e.button === 2) {
      // RMB → aim. Only engages while pointer is locked so a misclick before
      // entering the canvas doesn't snap into ADS.
      if (state.pointerLocked) {
        mouseAim = true;
        mergeButtons();
      }
      return;
    }
    if (e.button !== 0) return;
    if (!state.pointerLocked) {
      canvas.requestPointerLock();
      return;
    }
    state.fire = true;
  };

  const onMouseUp = (e: MouseEvent) => {
    if (e.button === 2) {
      mouseAim = false;
      mergeButtons();
      return;
    }
    // intentionally do not clear state.fire — consumeFire is the only consumer
  };

  const onPointerLockChange = () => {
    state.pointerLocked = document.pointerLockElement === canvas;
    if (state.pointerLocked) dropNextMouseMove = true;
    // Releasing pointer lock should drop ADS; otherwise the camera stays
    // zoomed-in after the player Alt-Tabs or hits Escape mid-aim.
    if (!state.pointerLocked && mouseAim) {
      mouseAim = false;
      mergeButtons();
    }
  };

  const onContextMenu = (e: MouseEvent) => e.preventDefault();

  const clampPitch = () => {
    const lim = Math.PI / 2 - 0.01;
    if (state.pitch > lim) state.pitch = lim;
    if (state.pitch < -lim) state.pitch = -lim;
  };

  // Gamepad polling. Runs every animation frame; samples the first connected
  // gamepad and applies its inputs into the merged state. RT is edge-triggered
  // for semi-auto fire, mirroring mouse-click semantics in onMouseDown. L3 is
  // edge-triggered as a sprint toggle (click-on / click-off).
  let prevTriggerPressed = false;
  let prevSprintPressed = false;
  let prevInteractPressed = false;
  let sprintToggled = false;
  let lastPollMs = performance.now();
  let rafHandle = 0;

  const pollGamepad = () => {
    const now = performance.now();
    const dt = Math.min(0.1, (now - lastPollMs) / 1000);
    lastPollMs = now;

    const pad = pickGamepad();
    if (!pad) {
      if (gpForward !== 0 || gpRight !== 0 || gpJump || gpSprint || gpReload || gpAim) {
        gpForward = 0;
        gpRight = 0;
        gpJump = false;
        gpSprint = false;
        gpReload = false;
        gpAim = false;
        mergeAxes();
        mergeButtons();
      }
      prevTriggerPressed = false;
      prevSprintPressed = false;
      prevInteractPressed = false;
      sprintToggled = false;
      rafHandle = requestAnimationFrame(pollGamepad);
      return;
    }

    const lx = pad.axes[0] ?? 0;
    const ly = pad.axes[1] ?? 0;
    const rx = pad.axes[2] ?? 0;
    const ry = pad.axes[3] ?? 0;

    const left = applyRadialDeadzone(lx, ly, GP_DEADZONE);
    gpRight = left.x;
    // Standard mapping: stick up is -Y. Forward should be +1 when stick is up.
    gpForward = -left.y;

    const right = applyRadialDeadzone(rx, ry, GP_DEADZONE);
    if (right.x !== 0 || right.y !== 0) {
      const yawIn = signedExpo(right.x, GP_LOOK_EXPO);
      const pitchIn = signedExpo(right.y, GP_LOOK_EXPO);
      // Same ADS slowdown applied to mouse — keeps muscle memory consistent
      // across input methods so a player who's aiming on either feels at home.
      const sens = state.aiming ? ADS_SENSITIVITY : 1;
      state.yaw -= yawIn * GP_LOOK_YAW_RATE * dt * sens;
      state.pitch -= pitchIn * GP_LOOK_PITCH_RATE * dt * sens;
      clampPitch();
    }

    gpJump = isPressed(pad, 0);
    gpReload = isPressed(pad, 2);

    const sprintPressed = isPressed(pad, 10);
    if (sprintPressed && !prevSprintPressed) sprintToggled = !sprintToggled;
    prevSprintPressed = sprintPressed;
    gpSprint = sprintToggled;
    // LT (left trigger, standard mapping idx 6) is hold-to-aim. Most pad
    // drivers report LT as analog .value, not .pressed, so check both.
    gpAim =
      isPressed(pad, 6) || (pad.buttons[6]?.value ?? 0) >= GP_TRIGGER_THRESHOLD;

    const triggerPressed =
      isPressed(pad, 7) || (pad.buttons[7]?.value ?? 0) >= GP_TRIGGER_THRESHOLD;
    if (triggerPressed && !prevTriggerPressed) {
      state.fire = true;
    }
    prevTriggerPressed = triggerPressed;

    // Button 3 = Y on Xbox, Triangle on PlayStation. Hold to engage —
    // mirrors the keyboard KeyE flow so consumeInteractHold() can fire the
    // interact once the hold duration crosses INTERACT_HOLD_MS regardless
    // of input device. Rising edge starts the hold timer; release clears.
    const interactPressed = isPressed(pad, 3);
    if (interactPressed && !prevInteractPressed) {
      state.interactHeldSince = performance.now();
      interactFiredThisHold = false;
    } else if (!interactPressed && prevInteractPressed) {
      state.interactHeldSince = null;
      interactFiredThisHold = false;
    }
    prevInteractPressed = interactPressed;

    mergeAxes();
    mergeButtons();

    rafHandle = requestAnimationFrame(pollGamepad);
  };

  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('mousemove', onMouseMove);
  canvas.addEventListener('mousedown', onMouseDown);
  window.addEventListener('mouseup', onMouseUp);
  document.addEventListener('pointerlockchange', onPointerLockChange);
  canvas.addEventListener('contextmenu', onContextMenu);
  rafHandle = requestAnimationFrame(pollGamepad);

  return {
    state,
    consumeFire(): boolean {
      const v = state.fire;
      // edge-trigger: keep semi-auto by clearing here
      state.fire = false;
      return v;
    },
    // Returns true ONCE per hold when the held duration has crossed
    // INTERACT_HOLD_MS. Subsequent calls during the same hold return false.
    // Releasing the button (handled in onKeyUp / the gamepad poll) clears
    // the fired flag so a fresh press starts a new hold.
    consumeInteractHold(): boolean {
      if (state.interactHeldSince === null) return false;
      if (interactFiredThisHold) return false;
      const heldMs = performance.now() - state.interactHeldSince;
      if (heldMs < INTERACT_HOLD_MS) return false;
      interactFiredThisHold = true;
      return true;
    },
    // 0..1 fill ratio for the hold progress UI. 0 when not pressed; clamps
    // to 1 once the hold completes (so the arc visually finishes filling
    // before consumeInteractHold() fires the actual press).
    getInteractHoldProgress(): number {
      if (state.interactHeldSince === null) return 0;
      const heldMs = performance.now() - state.interactHeldSince;
      const r = heldMs / INTERACT_HOLD_MS;
      return r < 0 ? 0 : r > 1 ? 1 : r;
    },
    destroy(): void {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('mousemove', onMouseMove);
      canvas.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('mouseup', onMouseUp);
      document.removeEventListener('pointerlockchange', onPointerLockChange);
      canvas.removeEventListener('contextmenu', onContextMenu);
      if (rafHandle) cancelAnimationFrame(rafHandle);
    },
  };
};

const MAX_MOUSE_DELTA = 200;
const clampMovement = (v: number): number => {
  if (!Number.isFinite(v)) return 0;
  if (v > MAX_MOUSE_DELTA) return MAX_MOUSE_DELTA;
  if (v < -MAX_MOUSE_DELTA) return -MAX_MOUSE_DELTA;
  return v;
};

const clampUnit = (v: number): number => {
  if (!Number.isFinite(v)) return 0;
  if (v > 1) return 1;
  if (v < -1) return -1;
  return v;
};

const ADS_SENSITIVITY = 0.5;
const GP_DEADZONE = 0.15;
const GP_LOOK_YAW_RATE = 3.0;
const GP_LOOK_PITCH_RATE = 2.2;
const GP_LOOK_EXPO = 2;
const GP_TRIGGER_THRESHOLD = 0.5;

const pickGamepad = (): Gamepad | null => {
  const pads = navigator.getGamepads ? navigator.getGamepads() : [];
  for (const p of pads) {
    if (p && p.connected) return p;
  }
  return null;
};

const isPressed = (pad: Gamepad, idx: number): boolean => {
  const b = pad.buttons[idx];
  return !!b && b.pressed;
};

// Radial deadzone: zero out within the inner circle, then rescale the
// remaining magnitude to [0, 1] preserving direction. Avoids the square-gate
// feel of per-axis deadzones.
const applyRadialDeadzone = (
  x: number,
  y: number,
  dz: number,
): { x: number; y: number } => {
  const mag = Math.hypot(x, y);
  if (mag <= dz) return { x: 0, y: 0 };
  const scaled = (mag - dz) / (1 - dz);
  const clamped = scaled > 1 ? 1 : scaled;
  return { x: (x / mag) * clamped, y: (y / mag) * clamped };
};

const signedExpo = (v: number, expo: number): number => {
  const sign = v < 0 ? -1 : 1;
  return sign * Math.pow(Math.abs(v), expo);
};
