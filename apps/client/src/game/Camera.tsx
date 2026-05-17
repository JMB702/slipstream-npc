import { useFrame, useThree } from '@react-three/fiber';
import { useRef } from 'react';
import { PerspectiveCamera } from 'three';
import { PLAYER, raycastObstacles, type Vec3 } from '@slipstream-npc/shared';
import { useGame } from '../store.js';
import { getActiveInput, getPredictedState, setCameraDist } from './local-state.js';
import { setListenerPose } from '../voice/player-audio-graph.js';

// Hipfire (default) framing.
const HIP_BACK_DIST = 3.4;
const HIP_SHOULDER_OFFSET = 0.65;
const HIP_FOV = 70;

// Aim-down-sights framing. Pulled in over the right shoulder and zoomed FOV;
// camera RAY-cast still applies (you can ADS in tight rooms without clipping).
const ADS_BACK_DIST = 1.6;
const ADS_SHOULDER_OFFSET = 0.45;
const ADS_FOV = 48;

// How fast the framing transitions on aim engage/disengage. Single per-frame
// lerp factor — at 60fps, 0.18 settles in ~0.2s, which feels snappy without
// being jarring.
const ADS_LERP = 0.18;

const HEIGHT_OFFSET = 0.55;
const AIM_DIST = 25;

// Spring-arm camera collision tunables.
const CAMERA_RADIUS = 0.3; // sphere-cast radius — pulls in at corners before clipping
const WALL_PADDING = 0.05; // visible offset from wall surface
const MIN_CAM_DIST = PLAYER.radius + CAMERA_RADIUS + 0.1; // hard floor; never inside the player capsule

// Asymmetric damping + hysteresis. Retract fast (to never visibly clip), return
// slow (to never twitch when rotating near a wall edge). Hysteresis prevents
// single-frame ping-pong at narrow doorways where ideal/collided distances flicker.
const RETRACT_LERP = 0.6; // ~150ms time constant at 60fps
const RETURN_LERP = 0.1; // ~1000ms time constant
const HYSTERESIS = 0.15; // m

export const FollowCamera = () => {
  const { camera } = useThree();
  const appliedDist = useRef(HIP_BACK_DIST);
  // Smoothed framing values driven by ADS hold. Refs (not state) so the
  // useFrame loop can read+write without triggering React reconciliation.
  const backDistRef = useRef(HIP_BACK_DIST);
  const shoulderRef = useRef(HIP_SHOULDER_OFFSET);
  const fovRef = useRef(HIP_FOV);

  useFrame(() => {
    const myId = useGame.getState().myId;
    if (!myId) return;

    const pred = getPredictedState();
    const inp = getActiveInput();
    const yaw = inp?.yaw ?? pred.yaw;
    const pitch = inp?.pitch ?? pred.pitch;
    const aiming = inp?.aiming ?? false;

    // Lerp framing toward the active mode (hip vs ADS) every frame. Keeps the
    // transition smooth and per-frame consistent regardless of how long the
    // aim button is held.
    const targetBack = aiming ? ADS_BACK_DIST : HIP_BACK_DIST;
    const targetShoulder = aiming ? ADS_SHOULDER_OFFSET : HIP_SHOULDER_OFFSET;
    const targetFov = aiming ? ADS_FOV : HIP_FOV;
    backDistRef.current += (targetBack - backDistRef.current) * ADS_LERP;
    shoulderRef.current += (targetShoulder - shoulderRef.current) * ADS_LERP;
    fovRef.current += (targetFov - fovRef.current) * ADS_LERP;
    if (camera instanceof PerspectiveCamera) {
      const next = fovRef.current;
      if (Math.abs(camera.fov - next) > 0.01) {
        camera.fov = next;
        camera.updateProjectionMatrix();
      }
    }

    // While vaulting, the player's torso passes through the wall and the
    // spring-arm raycast would yank the camera in (you can't see your own
    // leap). Skip collision and hold at full BACK_DIST until vault ends.
    const lastSnap = useGame.getState().snapshots[useGame.getState().snapshots.length - 1];
    const me = lastSnap?.players.get(myId);
    const vaulting = me?.vaulting ?? false;

    const cp = Math.cos(pitch);
    const sp = Math.sin(pitch);
    const sy = Math.sin(yaw);
    const cy = Math.cos(yaw);

    const fx = -sy * cp;
    const fy = sp;
    const fz = -cy * cp;
    const rx = cy;
    const rz = -sy;

    const eyeX = pred.position[0];
    const eyeY = pred.position[1] + PLAYER.height * 0.3;
    const eyeZ = pred.position[2];

    // Idealized desired camera position: behind by current back distance,
    // shoulder offset to the right, height offset up. Both back and shoulder
    // are lerped by the ADS handler above — at rest they sit at hip values.
    const back = backDistRef.current;
    const shoulder = shoulderRef.current;
    const desiredX = eyeX - fx * back + rx * shoulder;
    const desiredY = eyeY - fy * back + HEIGHT_OFFSET;
    const desiredZ = eyeZ - fz * back + rz * shoulder;

    // Cast from the eye toward the desired position. Use the full ray length so
    // hits past the desired endpoint don't matter; inflate AABBs by CAMERA_RADIUS
    // so corners pull us in before the sphere can clip.
    const dx = desiredX - eyeX;
    const dy = desiredY - eyeY;
    const dz = desiredZ - eyeZ;
    const rayLen = Math.hypot(dx, dy, dz);
    let safeDist = rayLen;
    if (!vaulting && rayLen > 1e-6) {
      const ndx = dx / rayLen;
      const ndy = dy / rayLen;
      const ndz = dz / rayLen;
      const eye: Vec3 = [eyeX, eyeY, eyeZ];
      const dir: Vec3 = [ndx, ndy, ndz];
      const hit = raycastObstacles(eye, dir, rayLen, CAMERA_RADIUS);
      if (hit !== null) {
        safeDist = Math.max(0, hit - WALL_PADDING);
      }
    }
    if (safeDist < MIN_CAM_DIST) safeDist = MIN_CAM_DIST;

    if (vaulting) {
      // Snap straight to full distance so the leap is visible; resume normal
      // damping when the vault clears.
      appliedDist.current = safeDist;
    } else {
      // Asymmetric damping with hysteresis.
      const cur = appliedDist.current;
      if (safeDist < cur) {
        appliedDist.current = cur + (safeDist - cur) * RETRACT_LERP;
      } else if (safeDist > cur + HYSTERESIS) {
        appliedDist.current = cur + (safeDist - cur) * RETURN_LERP;
      }
    }

    // Place camera along the normalized ray at the damped distance.
    const t = rayLen > 1e-6 ? appliedDist.current / rayLen : 0;
    let camX = eyeX + dx * t;
    let camY = eyeY + dy * t;
    let camZ = eyeZ + dz * t;

    // Floor safety: never let the camera go through the ground plane.
    if (camY < CAMERA_RADIUS) camY = CAMERA_RADIUS;

    camera.position.set(camX, camY, camZ);

    // Aim point unchanged: a point far along the look ray from the eye.
    // Pulling the camera in does NOT change where bullets go (server uses yaw/pitch).
    camera.lookAt(eyeX + fx * AIM_DIST, eyeY + fy * AIM_DIST, eyeZ + fz * AIM_DIST);

    // Publish the applied camera distance so the local Character can hide its
    // body when the camera is close enough that the head occludes the aim cone.
    setCameraDist(appliedDist.current);

    // Drive the spatial audio listener from the same pose. Forward is the
    // camera's look vector (fx, fy, fz); position is the applied camera
    // position. HRTF panning for remote player voice keys off these values.
    setListenerPose([camX, camY, camZ], [fx, fy, fz]);
  });

  return null;
};
