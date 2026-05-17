import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import { Group, Vector3 } from 'three';
import {
  PLAYER,
  TICK_MS,
  applyMovement,
  type ClientMessage,
  type InputFrame,
  type MovableState,
  type Vec3,
} from '@slipstream-npc/shared';
import { useGame } from '../store.js';
import { createInput } from './input.js';
import { setActiveInput, setPredictedState, consumeFire, consumeInteractHold, getDrinkLockedYaw } from './local-state.js';
import { castCameraRay, findAimTarget, stampAimedAt } from './aim-state.js';
import { hapticFire } from './haptics.js';
import { playDryFire } from './sfx.js';
import { PlayerModel } from './PlayerModel.js';
import { tickVoiceProximity } from '../voice/manager.js';
import { useMuted } from '../voice/mute.js';

interface Props {
  send(msg: ClientMessage): void;
  myName: string;
}

export const LocalPlayer = ({ send, myName }: Props) => {
  const ref = useRef<Group>(null);
  const { gl, camera } = useThree();
  const seqRef = useRef(1);
  const accumulator = useRef(0);
  const lastSent = useRef(performance.now());
  const inputBuffer = useRef<InputFrame[]>([]);
  const liveInputRef = useRef<ReturnType<typeof createInput> | null>(null);
  // Reused scratch vector for camera.getWorldDirection() — avoids per-frame
  // allocation in the input-frame builder.
  const camFwdScratch = useMemo(() => new Vector3(), []);

  useEffect(() => {
    const input = createInput(gl.domElement);
    liveInputRef.current = input;
    setActiveInput(input);
    return () => {
      input.destroy();
      if (liveInputRef.current === input) liveInputRef.current = null;
      setActiveInput(null);
    };
  }, [gl]);

  // Pose controls.
  //   Y  — toggle between combat (rifle aim) and casual (relaxed). Players
  //        spawn in casual; taking damage auto-engages combat via server-side
  //        clearPose. Firing the trigger in casual does NOTHING — the player
  //        must explicitly Y to draw the gun first, so the trigger can't
  //        accidentally yank a chatting NPC into combat. Y lets them holster
  //        again afterwards without having to wait or get hit.
  //   1-7 — explicit pose tests for the social animations (lean / sit / lay
  //        / dance variants). Send target pose only; the server applies the
  //        right transition (e.g. sit→stand_up→casual when leaving sit).
  //
  // Ignored while a text input is focused so name entry can't accidentally
  // seat the player.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat) return;
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
      switch (e.code) {
        case 'KeyY': {
          // Read combat-vs-not directly. Nullish coalescing on .pose collapses
          // `null` (combat) into the same bucket as missing-snapshot, which
          // would lock the player in combat forever (the toggle always
          // re-sends pose: null). Compare the snapshot field explicitly.
          const me = useGame.getState().snapshots.at(-1)?.players.get(useGame.getState().myId ?? '');
          const inCombat = me?.pose === null;
          send({ type: 'set_pose', pose: inCombat ? 'casual_idle' : null });
          break;
        }
        case 'Digit1':
          send({ type: 'set_pose', pose: 'casual_idle' });
          break;
        case 'Digit2':
          send({ type: 'set_pose', pose: null });
          break;
        case 'Digit3':
          send({ type: 'set_pose', pose: 'lean_wall' });
          break;
        case 'Digit4':
          send({ type: 'set_pose', pose: 'sit' });
          break;
        case 'Digit5':
          send({ type: 'set_pose', pose: 'lay' });
          break;
        case 'Digit6':
          send({ type: 'set_pose', pose: 'dance', danceVariant: 0 });
          break;
        case 'Digit7':
          send({ type: 'set_pose', pose: 'dance', danceVariant: 1 });
          break;
        case 'Digit8':
          send({ type: 'set_pose', pose: 'dance', danceVariant: 2 });
          break;
        default:
          return;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [send]);

  // Xbox controller: B (button 1) toggles combat/casual. Easy thumb reach
  // without breaking aim (vs RB which forces a hand reposition), and clear of
  // the taken bindings (A=jump, X=reload, Y=mute, LT/RT=aim/fire, LSB=sprint).
  useEffect(() => {
    let raf = 0;
    let prevPressed = false;
    const poll = () => {
      const pads = navigator.getGamepads ? navigator.getGamepads() : [];
      let pressed = false;
      for (const pad of pads) {
        if (!pad) continue;
        if (pad.buttons[1]?.pressed) {
          pressed = true;
          break;
        }
      }
      if (pressed && !prevPressed) {
        // See the KeyY handler for the bug this avoids — `null ?? 'casual_idle'`
        // collapses combat-mode and missing-snapshot into one bucket, locking
        // the toggle.
        const me = useGame.getState().snapshots.at(-1)?.players.get(useGame.getState().myId ?? '');
        const inCombat = me?.pose === null;
        send({ type: 'set_pose', pose: inCombat ? 'casual_idle' : null });
      }
      prevPressed = pressed;
      raf = requestAnimationFrame(poll);
    };
    raf = requestAnimationFrame(poll);
    return () => cancelAnimationFrame(raf);
  }, [send]);

  useFrame((_, delta) => {
    const dtMs = delta * 1000;
    accumulator.current += dtMs;

    const live = liveInputRef.current?.state;

    if (accumulator.current >= TICK_MS && live) {
      const sendDt = performance.now() - lastSent.current;
      lastSent.current = performance.now();
      accumulator.current = 0;

      const rawFired = consumeFire();
      const interacted = consumeInteractHold();
      // Casual mode: trigger is a no-op. Suppress the fire bit before it
      // reaches the InputFrame so no haptic, no dry-fire SFX, no shot intent
      // crosses the wire. Player must press Y to draw the gun first. Mirrors
      // the server-side gate in apps/party/src/server.ts case 'input'.
      const myIdForGate = useGame.getState().myId;
      const lastSnapForGate = useGame.getState().snapshots[useGame.getState().snapshots.length - 1];
      const meForGate = myIdForGate ? lastSnapForGate?.players.get(myIdForGate) : undefined;
      const inCasual = meForGate?.pose === 'casual_idle';
      const fired = rawFired && !inCasual;
      if (fired) {
        // Server is authoritative on ammo and life; don't buzz on dry-fire
        // pulls or trigger-mashing while dead.
        if (meForGate && meForGate.alive && meForGate.ammo > 0) {
          hapticFire();
        } else if (meForGate && meForGate.alive && meForGate.ammo <= 0) {
          playDryFire();
        }
      }
      // Camera-resolved aim. Cast from the camera (which sees over ledges,
      // around shoulders, etc.) and find the first wall or player capsule.
      // Server uses this as authoritative origin/direction so third-person
      // parallax doesn't make eye-blocked shots fail when the reticle clearly
      // shows a hit. Live snapshot positions for visual matching; server does
      // its own lag-comp test from the same origin/direction.
      let aimOrigin: Vec3 | null = null;
      let aim: Vec3 | null = null;
      const myIdNow = useGame.getState().myId;
      const lastSnapNow =
        useGame.getState().snapshots[useGame.getState().snapshots.length - 1];
      if (myIdNow && lastSnapNow) {
        camera.getWorldDirection(camFwdScratch);
        aimOrigin = [camera.position.x, camera.position.y, camera.position.z];
        const hit = castCameraRay(
          aimOrigin,
          [camFwdScratch.x, camFwdScratch.y, camFwdScratch.z],
          myIdNow,
          lastSnapNow.players.values(),
        );
        aim = hit.point;
      }
      const frame: InputFrame = {
        seq: seqRef.current++,
        dtMs: sendDt,
        forward: live.forward,
        right: live.right,
        jump: live.jump,
        // Can't sprint while firing. Server enforces this too; doing it here
        // keeps client prediction matching the server's authoritative state.
        sprint: live.sprint && !fired,
        fire: fired,
        reload: live.reload,
        interact: interacted,
        yaw: live.yaw,
        pitch: live.pitch,
        aimOrigin,
        aim,
      };
      inputBuffer.current.push(frame);
      if (inputBuffer.current.length > 120) inputBuffer.current.shift();
      send({ type: 'input', frames: [frame] });
    }

    const myId = useGame.getState().myId;
    const lastSnap = useGame.getState().snapshots[useGame.getState().snapshots.length - 1];
    if (!ref.current || !myId || !lastSnap) return;
    const me = lastSnap.players.get(myId);
    if (!me) return;

    if (!me.alive) {
      setPredictedState({
        position: me.position,
        velocity: [0, 0, 0],
        yaw: me.yaw,
        pitch: me.pitch,
        grounded: true,
      });
      ref.current.position.set(me.position[0], me.position[1], me.position[2]);
      ref.current.rotation.y = me.yaw;
      return;
    }

    // While vaulting, the server tweens position; client prediction would
    // fight the tween (movement input is ignored server-side anyway). Lerp
    // the wrapper toward the latest snapshot position rather than snapping —
    // snapshots arrive at 20 Hz so a hard set produces visible step jitter
    // at the 60 Hz render rate.
    if (me.vaulting) {
      const cx = ref.current.position.x;
      const cy = ref.current.position.y;
      const cz = ref.current.position.z;
      const lerpAmt = 0.35;
      const nx = cx + (me.position[0] - cx) * lerpAmt;
      const ny = cy + (me.position[1] - cy) * lerpAmt;
      const nz = cz + (me.position[2] - cz) * lerpAmt;
      ref.current.position.set(nx, ny, nz);
      ref.current.rotation.y = me.yaw;
      setPredictedState({
        position: [nx, ny, nz],
        velocity: [0, 0, 0],
        yaw: me.yaw,
        pitch: me.pitch,
        grounded: false,
      });
      // Keep the buffer drained so when the vault ends we don't replay stale jumps.
      const ackedSeq = me.lastSeenSeq;
      while (inputBuffer.current.length > 0 && inputBuffer.current[0]!.seq <= ackedSeq) {
        inputBuffer.current.shift();
      }
      return;
    }

    const ackedSeq = me.lastSeenSeq;
    while (inputBuffer.current.length > 0 && inputBuffer.current[0]!.seq <= ackedSeq) {
      inputBuffer.current.shift();
    }

    let state: MovableState = {
      position: me.position,
      velocity: me.velocity,
      yaw: me.yaw,
      pitch: me.pitch,
      grounded: me.position[1] <= PLAYER.height / 2 + 0.001,
      coffeeBuffUntil: me.coffeeBuffUntil,
    };
    // Server freezes the body during a drink (see applyInput's drinkingUntil
    // branch). Mirror it on the client so prediction doesn't fight the
    // server-authoritative position and the player can't visibly slide
    // around mid-sip. Yaw still updates so the camera can free-orbit.
    const drinkingNow =
      me.drinkingUntil !== undefined && Date.now() < me.drinkingUntil;
    if (!drinkingNow) {
      for (const frame of inputBuffer.current) {
        state = applyMovement(state, frame);
      }

      // Extrapolate the partial frame between the last sent input and now
      // so motion is continuous between 30Hz input ticks.
      const partialDtMs = performance.now() - lastSent.current;
      if (partialDtMs > 0 && live) {
        state = applyMovement(state, {
          seq: 0,
          dtMs: partialDtMs,
          forward: live.forward,
          right: live.right,
          jump: false,
          sprint: live.sprint,
          fire: false,
          reload: false,
          interact: false,
          yaw: live.yaw,
          pitch: live.pitch,
          // Local-only prediction frame; never serialized over the wire.
          aimOrigin: null,
          aim: null,
        });
      }
    } else {
      // Drink lock: snap to the server's authoritative position and zero
      // velocity. Yaw still tracks the mouse so camera orbit feels live.
      state = {
        position: me.position,
        velocity: [0, 0, 0],
        yaw: live?.yaw ?? me.yaw,
        pitch: live?.pitch ?? me.pitch,
        grounded: true,
        coffeeBuffUntil: me.coffeeBuffUntil,
      };
    }

    setPredictedState(state);

    ref.current.position.set(state.position[0], state.position[1], state.position[2]);
    // During a coffee drink, the rendered character yaw is locked to wherever
    // the player was facing at drink start. The camera (mouse-driven) still
    // updates each frame, so the player can free-orbit around the stationary
    // character. Live state.yaw is still sent on the wire — the character's
    // gameplay direction is unaffected — only the local render is frozen.
    const lockedYaw = getDrinkLockedYaw();
    ref.current.rotation.y = lockedYaw !== null ? lockedYaw : state.yaw;

    tickVoiceProximity(state.position);

    // Aim-target detection for enemy nameplate reveal. Mirrors server fire
    // raycast — same eye height, same hit radius, same wall occlusion. Stamps
    // the aim-state module so every PlayerModel can read its own last-aimed-at
    // time without a global re-render.
    const aimedId = findAimTarget(state.position, state.yaw, state.pitch, myId, lastSnap.players.values());
    if (aimedId) stampAimedAt(aimedId, performance.now());
  });

  const myId = useGame((s) => s.myId);
  const lastSnap = useGame((s) => s.snapshots[s.snapshots.length - 1]);
  const me = myId ? lastSnap?.players.get(myId) : undefined;
  const inputVolume = useGame((s) => s.voiceInputVolume);
  const muted = useMuted();
  // Analyzer-based RMS reading (voice/level.ts). Idle hovers ~0.005, normal
  // speech is well past 0.04. No session check — mic level is meaningful
  // independent of SDK state.
  const localVoiceIcon: 'mic' | null = !muted && inputVolume > 0.04 ? 'mic' : null;

  return (
    <group ref={ref}>
      <PlayerModel
        name={me?.name ?? myName}
        alive={me?.alive ?? true}
        health={me?.health ?? 100}
        velocity={me?.velocity ?? [0, 0, 0]}
        yaw={me?.yaw ?? 0}
        reloading={me?.reloading ?? false}
        vaulting={me?.vaulting ?? false}
        playerId={myId ?? null}
        characterId={me?.characterId}
        voiceIcon={localVoiceIcon}
        pose={me?.pose ?? null}
        poseTransition={me?.poseTransition ?? null}
        danceVariant={me?.danceVariant ?? 0}
      />
    </group>
  );
};
