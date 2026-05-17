import { useAnimations, useGLTF } from '@react-three/drei';
import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AnimationClip,
  BoxGeometry,
  CylinderGeometry,
  Euler,
  Group,
  LoopOnce,
  LoopRepeat,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
  Quaternion,
  SphereGeometry,
  Vector3,
  type AnimationAction,
} from 'three';
import * as SkeletonUtils from 'three/examples/jsm/utils/SkeletonUtils.js';
import { COFFEE_WORLD_POSITION, PLAYER, POSE, type CharacterId, type PlayerId, type Pose, type PoseTransition, type Vec3 } from '@slipstream-npc/shared';
import { useGame } from '../store.js';
import { getCameraDist, startDrinkLock } from './local-state.js';
import { playCoffeeSip, playGunshot, playHitMarker, playReload } from './sfx.js';

// =============================================================================
// Mixamo rifle-aim character swap workflow
// =============================================================================
// Soldier.glb only ships Idle / Walk / Run / TPose with arms swinging freely
// — that's why a held weapon never looks right against it. The proper fix is
// to use a character animated with a held rifle:
//
//   1. https://www.mixamo.com (free Adobe login)
//   2. Pick a rigged character. Download as FBX Binary, with Skin, T-pose.
//      Most Mixamo characters DO NOT include a gun mesh — they expect you to
//      attach one to the right-hand bone. If you want a built-in gun, search
//      Sketchfab/CGTrader for a "Mixamo-rigged soldier with rifle" (or pose
//      one in Blender by attaching a gun mesh to mixamorigRightHand).
//   3. Pick rifle animations one at a time, download as FBX Binary, without
//      Skin, 30fps:
//        - "Rifle Idle"           -> "Idle"
//        - "Rifle Walk Forward"   -> "Walk"
//        - "Rifle Run"            -> "Run"
//        - "Firing Rifle"         -> "Fire"
//   4. In Blender: import character FBX, then each animation FBX. In the
//      Action Editor, rename actions to Idle / Walk / Run / Fire. Export as
//      glTF 2.0 with Animations enabled.
//   5. Replace apps/client/public/models/Soldier.glb with the new GLB.
//   6. If your clips use different names (Mixamo often suffixes them with
//      "mixamo.com" or the source-FBX name), update CLIP_NAMES below.
//
// What this file already supports:
//   - Idle / Walk / Run blending (locomotion state machine, looping clips)
//   - Jump fakery (freezes Run mid-stride; replace with a real Jump clip
//     if your pack has one and update CLIP_NAMES.Jump)
//   - Fire as a one-shot full-body override on shot events (gated on the
//     CLIP_NAMES.Fire entry — leave it null to disable while you don't have
//     a Fire clip yet)
// =============================================================================

// Cache-bust version. Bump ONLY when the GLBs are rebaked (pnpm bake:characters)
// — drei keys its in-memory parse cache by URL, so a stale tab keeps the old
// clip data even after the file on disk changes. Don't tie this to Date.now()
// (gotcha #9 — forces re-downloads on every reload for every player).
const GLB_VERSION = '3';
const url = (path: string) => `${path}?v=${GLB_VERSION}`;
const MODEL_URLS: Record<CharacterId, string> = {
  soldier: url('/models/Soldier.glb'),
  ch15: url('/models/Ch15.glb'),
  ch35: url('/models/Ch35.glb'),
  eve: url('/models/Eve.glb'),
  maria: url('/models/Maria.glb'),
  medea: url('/models/Medea.glb'),
  // Guts's new body (5/16). Baked from 3D Assets/Characters/Guts - Dreyar By M.Aure.fbx
  // via the same `pnpm bake:characters Dreyar` pipeline.
  dreyar: url('/models/Dreyar.glb'),
};
for (const u of Object.values(MODEL_URLS)) useGLTF.preload(u);

const MODEL_SCALES: Record<CharacterId, number> = {
  soldier: 1,
  ch15: 1,
  ch35: 1,
  eve: 1,
  maria: 1,
  medea: 1,
  // Dreyar's baked asset is ~17.25m tall while the shared player capsule is
  // 1.8m. Scale only the visual model so Guts matches the other characters
  // without changing movement, hit detection, or the attached rifle size.
  dreyar: 0.10436,
};

interface Props {
  velocity: Vec3;
  yaw: number;
  reloading: boolean;
  vaulting: boolean;
  alive: boolean;
  playerId: PlayerId | null;
  characterId?: CharacterId;
  // Server-driven expressive pose. null = combat-ready (existing locomotion runs).
  // poseTransition !== null means a one-shot is currently playing; once the
  // server clears it, the looping clip for `pose` takes over.
  pose?: Pose;
  poseTransition?: PoseTransition;
  danceVariant?: number;
}

const WALK_RUN_THRESHOLD = (PLAYER.walkSpeed + PLAYER.sprintSpeed) / 2;
const IDLE_SPEED = 0.15;
const AIRBORNE_VY = 0.5;

// Run clip is ~0.7s; mid-stride lands around 0.35s with one leg planted —
// reads as a leap silhouette when frozen. Used by Jump fallback.
const JUMP_POSE_TIME = 0.35;

// Fire animation duration (ms). After this elapses with no further shots,
// the character returns to locomotion. If you have a 0.4s Fire clip, set
// this slightly less so the next shot can re-trigger smoothly.
const FIRE_HOLD_MS = 350;

// Drink sequence timings. First an ALIGN_MS window where the character
// turns to face the maker (no animation switch, just a yaw lerp under the
// existing CasualIdle pose). Then PickUpCoffee plays for its full native
// duration, then DrinkCoffee. Track the actual Mixamo clip lengths
// (PickUp = 3.467s, Drinking = 8.900s) plus a small buffer so the final
// pose holds briefly before the state machine releases control.
const ALIGN_MS = 400;
const PICKUP_HOLD_MS = 3500;
const DRINK_HOLD_MS = 9000;

// When the camera-to-eye distance drops below this, hide the local skeletal
// mesh so the character's head/torso doesn't occlude the aim cone. Picked
// just above ADS framing (1.6m) so ADS reliably triggers the hide; spring-arm
// collision pull-ins below this threshold also trigger it. Gun stays visible.
const LOCAL_HIDE_DIST = 1.9;

// Muzzle flash visibility duration per shot (ms). Flash is meant to "pop" —
// shorter than FIRE_HOLD_MS, which spans the firing animation.
const MUZZLE_FLASH_MS = 55;

type Dir = 'F' | 'FR' | 'R' | 'BR' | 'B' | 'BL' | 'L' | 'FL';
type DanceKey = 'DanceHipHop' | 'DanceSalsa' | 'DanceSilly';
type ClipKey =
  | 'Idle'
  | 'Jump'
  | 'Vault'
  | 'Death'
  | 'Fire'
  | 'FireWalk'
  | 'Reload'
  | 'ReloadWalk'
  | 'ReloadRun'
  | 'CasualIdle'
  | 'CasualWalkF'
  | 'CasualRunF'
  | 'LeanWall'
  | 'SitDown'
  | 'SitIdle'
  | 'LayDown'
  | 'LayIdle'
  | 'StandUp'
  | 'PickUpCoffee'
  | 'DrinkCoffee'
  | DanceKey
  | `Walk${Dir}`
  | `Run${Dir}`;

// Danced clip variants, ordered to match POSE.danceVariants (server clamps
// the wire value to [0, POSE.danceVariants - 1] before broadcasting).
const DANCE_VARIANTS: readonly DanceKey[] = ['DanceHipHop', 'DanceSalsa', 'DanceSilly'];

// Map ClipKey -> the actual clip name in the GLB. `null` means "no clip
// available, skip transitions to this state".
const CLIP_NAMES: Record<ClipKey, string | null> = {
  Idle: 'Idle',
  Jump: 'RunF', // re-uses sprint-forward frozen mid-stride; replace with a real Jump clip later
  Vault: 'Vault',
  Death: 'Death',
  Fire: 'Fire',
  FireWalk: 'FireWalk',
  Reload: 'Reload',
  ReloadWalk: 'ReloadWalk',
  ReloadRun: 'ReloadRun',
  // Social poses. null until the corresponding clip is baked into the GLB
  // (see scripts/canonical-clip-map.json). The state machine gracefully
  // falls back to Idle / WalkF when a posed clip resolves to null.
  CasualIdle: 'CasualIdle',
  CasualWalkF: 'CasualWalkF',
  CasualRunF: 'CasualRunF',
  LeanWall: 'LeanWall',
  SitDown: 'SitDown',
  SitIdle: 'SitIdle',
  LayDown: 'LayDown',
  LayIdle: 'LayIdle',
  StandUp: 'StandUp',
  // Free-coffee interaction sequence. Bake via `pnpm bake-character-glb` —
  // the canonical clip names produced by the bake pipeline are 'PickUp' and
  // 'Drinking' (see scripts/canonical-clip-map.json). Until the character
  // GLBs are rebaked these resolve to no AnimationAction and the state
  // machine falls back to Idle/WalkF — the server still applies the buff and
  // emits the DrinkEvent, but the player won't see a custom animation yet.
  PickUpCoffee: 'PickUp',
  DrinkCoffee: 'Drinking',
  DanceHipHop: 'DanceHipHop',
  DanceSalsa: 'DanceSalsa',
  DanceSilly: 'DanceSilly',
  WalkF: 'WalkF',
  WalkFR: 'WalkFR',
  WalkR: 'WalkR',
  WalkBR: 'WalkBR',
  WalkB: 'WalkB',
  WalkBL: 'WalkBL',
  WalkL: 'WalkL',
  WalkFL: 'WalkFL',
  RunF: 'RunF',
  RunFR: 'RunFR',
  RunR: 'RunR',
  RunBR: 'RunBR',
  RunB: 'RunB',
  RunBL: 'RunBL',
  RunL: 'RunL',
  RunFL: 'RunFL',
};

// Override Vault: the Mixamo clip is 4.2s including a long approach-run
// before the actual leap. Skip the run-up by starting the action at this
// offset (in seconds of clip time), and play the rest at VAULT_TIMESCALE so
// the visible leap+landing fits VAULT.durationMs in real time.
//   real_duration = (4.2 - VAULT_START_TIME) / VAULT_TIMESCALE
const VAULT_START_TIME = 1.0;
const VAULT_TIMESCALE = 2.1;

// Per-clip playback speed multiplier. Mixamo's stock locomotion clips animate
// at their own pace, slower than our walkSpeed/sprintSpeed in world space, so
// doubling the playback rate roughly matches the cycle to actual ground speed.
const CLIP_TIMESCALE: Record<ClipKey, number> = {
  Idle: 1,
  Jump: 0, // unused (Jump path freezes the action)
  Vault: VAULT_TIMESCALE,
  Death: 1,
  Fire: 1,
  FireWalk: 1,
  Reload: 1,
  ReloadWalk: 1,
  ReloadRun: 1,
  CasualIdle: 1, CasualWalkF: 2, CasualRunF: 1, LeanWall: 1,
  SitDown: 1, SitIdle: 1, LayDown: 1, LayIdle: 1, StandUp: 1,
  PickUpCoffee: 1, DrinkCoffee: 1,
  DanceHipHop: 1, DanceSalsa: 1, DanceSilly: 1,
  WalkF: 2, WalkFR: 2, WalkR: 2, WalkBR: 2, WalkB: 2, WalkBL: 2, WalkL: 2, WalkFL: 2,
  RunF: 1, RunFR: 1, RunR: 1, RunBR: 1, RunB: 1, RunBL: 1, RunL: 1, RunFL: 1,
};

// Snap (localForward, localRight) to one of 8 cardinal/diagonal directions.
// theta is measured from the forward axis, positive toward the right.
const DIRS_BY_OCTANT: readonly Dir[] = ['F', 'FR', 'R', 'BR', 'B', 'BL', 'L', 'FL'];
const directionFromVelocity = (lf: number, lr: number): Dir => {
  const theta = Math.atan2(lr, lf);
  const idx = ((Math.round(theta / (Math.PI / 4)) % 8) + 8) % 8;
  return DIRS_BY_OCTANT[idx]!;
};

export const Character = ({
  velocity,
  yaw,
  reloading,
  vaulting,
  alive,
  playerId,
  characterId = 'soldier',
  pose = null,
  poseTransition = null,
  danceVariant = 0,
}: Props) => {
  const gltf = useGLTF(MODEL_URLS[characterId] ?? MODEL_URLS.soldier);
  const modelScale = MODEL_SCALES[characterId] ?? 1;
  const cloned = useMemo(() => SkeletonUtils.clone(gltf.scene), [gltf.scene]);
  // Mixamo animations carry root motion in the Hips bone's position track —
  // the character translates forward during Walk/Run, jumps in Y during a
  // Jump clip, etc. Our server controls position authoritatively, so leaving
  // these in causes the model to drift forward and snap back on every
  // snapshot. Strip them here, keeping all rotation tracks intact.
  const animations = useMemo(() => stripRootMotion(gltf.animations), [gltf.animations]);
  const { actions } = useAnimations(animations, cloned);
  const currentAnim = useRef<ClipKey>('Idle');
  // Tracks the most recent drinkSession value the state machine has reacted
  // to. When the live drinkSession outpaces this ref, the state machine
  // bypasses its `currentAnim === wanted` short-circuit so the second drink
  // (and beyond) always fires a fresh transition.
  const lastDrinkSessionRef = useRef(0);

  // Fire state: true while we want to be playing the Fire clip. Cleared by
  // a timer FIRE_HOLD_MS after the most recent shot event for this player.
  const [firing, setFiring] = useState(false);
  const fireTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Drink sequence: 'pickup' → 'drink' → null over PICKUP_HOLD_MS +
  // DRINK_HOLD_MS. Driven by the server-event subscriber below — same
  // timestamp-gating pattern (gotcha #14) the shot/hit-marker uses so the
  // 200-event ring buffer can't deafen us. `drinkSession` increments per
  // drink event so the state machine effect always re-runs on a fresh
  // drink even if React would short-circuit a same-value setState.
  const [drinkPhase, setDrinkPhase] = useState<null | 'pickup' | 'drink'>(null);
  const [drinkSession, setDrinkSession] = useState(0);
  const drinkAlignTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const drinkPickupTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const drinkEndTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Timestamp-based detection. Length-based comparison silently breaks once
  // the store's 200-event cap fills: array length stays pinned and the
  // subscriber stops firing, killing muzzle flash + Fire animation triggers
  // after a couple dozen seconds of play. Server-assigned `at` is monotonic.
  const lastAtRef = useRef<number>(-1);
  const muzzleFlashUntilRef = useRef(0);
  const camera = useThree((s) => s.camera);

  useEffect(() => {
    if (!playerId) return;
    const initial = useGame.getState().events;
    lastAtRef.current = initial.length ? Math.max(...initial.map((e) => e.at)) : -1;
    return useGame.subscribe((state) => {
      let firedThisBatch = false;
      let lastShotOrigin: Vec3 | null = null;
      let hitThisBatch = false;
      let drankThisBatch = false;
      let drinkPosition: Vec3 | null = null;
      let maxAt = lastAtRef.current;
      const myId = state.myId;
      for (const ev of state.events) {
        if (ev.at <= lastAtRef.current) continue;
        if (ev.at > maxAt) maxAt = ev.at;
        if (ev.type === 'shot' && ev.shooterId === playerId) {
          firedThisBatch = true;
          lastShotOrigin = ev.origin;
          if (playerId === myId && ev.hit) hitThisBatch = true;
        }
        if (ev.type === 'drink' && ev.playerId === playerId) {
          drankThisBatch = true;
          const snap = state.snapshots[state.snapshots.length - 1];
          drinkPosition = snap?.players.get(playerId)?.position ?? null;
        }
      }
      lastAtRef.current = maxAt;
      if (firedThisBatch) {
        if (lastShotOrigin) {
          const dx = camera.position.x - lastShotOrigin[0];
          const dy = camera.position.y - lastShotOrigin[1];
          const dz = camera.position.z - lastShotOrigin[2];
          playGunshot(Math.sqrt(dx * dx + dy * dy + dz * dz));
        }
        if (hitThisBatch) playHitMarker();
        setFiring(true);
        muzzleFlashUntilRef.current = performance.now() + MUZZLE_FLASH_MS;
        if (fireTimeoutRef.current) clearTimeout(fireTimeoutRef.current);
        fireTimeoutRef.current = setTimeout(() => setFiring(false), FIRE_HOLD_MS);
      }
      if (drankThisBatch) {
        if (drinkPosition) {
          const dx = camera.position.x - drinkPosition[0];
          const dy = camera.position.y - drinkPosition[1];
          const dz = camera.position.z - drinkPosition[2];
          playCoffeeSip(Math.sqrt(dx * dx + dy * dy + dz * dz));
        }
        // Three.js auto-disables actions after a fadeOut completes (gotcha #3).
        // After the first drink's animations have faded out into CasualIdle,
        // the PickUp / Drinking actions are sitting disabled — a subsequent
        // fadeIn().play() would blend the bind pose through. Pre-emptively
        // reset+enable both clips and zero their weight so the state machine
        // transition that's about to fire lands on a clean foundation.
        const pickupAction = CLIP_NAMES.PickUpCoffee
          ? actions[CLIP_NAMES.PickUpCoffee]
          : null;
        const drinkAction = CLIP_NAMES.DrinkCoffee
          ? actions[CLIP_NAMES.DrinkCoffee]
          : null;
        if (pickupAction) {
          pickupAction.stop();
          pickupAction.reset();
          pickupAction.enabled = true;
        }
        if (drinkAction) {
          drinkAction.stop();
          drinkAction.reset();
          drinkAction.enabled = true;
        }
        // Stay in the resting pose (CasualIdle) during the alignment
        // window — drinkPhase doesn't enter 'pickup' until the character
        // has finished turning to face the maker. setDrinkSession still
        // increments so the state machine effect re-runs and the locked
        // yaw is visibly updated each frame via getDrinkLockedYaw().
        setDrinkSession((s) => s + 1);
        if (drinkAlignTimerRef.current) clearTimeout(drinkAlignTimerRef.current);
        if (drinkPickupTimerRef.current) clearTimeout(drinkPickupTimerRef.current);
        if (drinkEndTimerRef.current) clearTimeout(drinkEndTimerRef.current);
        drinkAlignTimerRef.current = setTimeout(() => setDrinkPhase('pickup'), ALIGN_MS);
        drinkPickupTimerRef.current = setTimeout(
          () => setDrinkPhase('drink'),
          ALIGN_MS + PICKUP_HOLD_MS,
        );
        drinkEndTimerRef.current = setTimeout(
          () => setDrinkPhase(null),
          ALIGN_MS + PICKUP_HOLD_MS + DRINK_HOLD_MS,
        );
        // Local-player only: lock the rendered yaw for the duration. The
        // first ALIGN_MS lerps from the player's current yaw to the
        // "facing the maker" target so the character visibly turns into
        // position before the pickup animation plays. After that, yaw
        // holds at the target while the camera (still mouse-driven) can
        // free-orbit around the stationary character.
        const myIdNow = state.myId;
        if (playerId === myIdNow) {
          const snap = state.snapshots[state.snapshots.length - 1];
          const me = snap?.players.get(playerId);
          const startYaw = me?.yaw ?? 0;
          // Yaw convention (see sim.ts applyMovement): the player's forward
          // direction at yaw=0 is (0, 0, -1); rotating yaw rotates around +Y.
          // To face the maker from the player's position, compute the
          // ground-plane vector and solve for the yaw that aligns forward
          // with it: atan2(player.x - maker.x, player.z - maker.z).
          const px = me?.position[0] ?? 0;
          const pz = me?.position[2] ?? 0;
          const targetYaw = Math.atan2(
            px - COFFEE_WORLD_POSITION[0],
            pz - COFFEE_WORLD_POSITION[2],
          );
          startDrinkLock(
            ALIGN_MS + PICKUP_HOLD_MS + DRINK_HOLD_MS,
            startYaw,
            targetYaw,
            ALIGN_MS,
          );
        }
      }
    });
  }, [playerId, camera]);

  const prevReloadingRef = useRef(false);
  useEffect(() => {
    if (reloading && !prevReloadingRef.current && playerId) {
      const snap = useGame.getState().snapshots[useGame.getState().snapshots.length - 1];
      const me = snap?.players.get(playerId);
      if (me) {
        const dx = camera.position.x - me.position[0];
        const dy = camera.position.y - me.position[1];
        const dz = camera.position.z - me.position[2];
        playReload(Math.sqrt(dx * dx + dy * dy + dz * dz));
      }
    }
    prevReloadingRef.current = reloading;
  }, [reloading, playerId, camera]);

  // Start the default (Idle) animation once actions are available.
  useEffect(() => {
    const idle = actions[CLIP_NAMES.Idle ?? ''];
    if (idle) idle.reset().fadeIn(0.15).play();
  }, [actions]);

  // Attach a rifle to the right-hand bone. With rifle-aim animations, the
  // hands are posed in a grip stance, so the rifle ends up looking held
  // (both hands near each other on the weapon).
  // Mixamo skeletons exported from Blender end up with a ~0.001 cumulative
  // world scale on every bone — bone-as-parent makes any child invisible
  // unless you compensate. Workaround: parent the gun to the wrapper group
  // (NOT the bone) and copy the bone's world transform onto the gun each
  // frame. This way the gun follows the hand without inheriting the
  // skeleton's scale weirdness.
  const gunMeshRef = useRef<Group | null>(null);
  const wrapperRef = useRef<Group | null>(null);
  const handBoneRef = useRef<Object3D | null>(null);
  const gunLocalMatrix = useMemo(() => {
    const m = new Matrix4();
    m.compose(
      new Vector3(GUN_POS_X, GUN_POS_Y, GUN_POS_Z),
      new Quaternion().setFromEuler(new Euler(GUN_ROT_X, GUN_ROT_Y, GUN_ROT_Z, 'XYZ')),
      new Vector3(GUN_SCALE, GUN_SCALE, GUN_SCALE),
    );
    return m;
  }, []);
  const tmpMat = useMemo(() => new Matrix4(), []);
  const tmpInv = useMemo(() => new Matrix4(), []);

  useEffect(() => {
    handBoneRef.current = findRightHandBone(cloned);
    if (!handBoneRef.current) {
      console.warn('Character: no right-hand bone found, gun not attached');
    }
    return () => {
      handBoneRef.current = null;
    };
  }, [cloned]);

  useFrame(() => {
    const wrapper = wrapperRef.current;
    const gun = gunMeshRef.current;
    const bone = handBoneRef.current;
    if (!wrapper || !gun || !bone) return;
    // Gun is only visible in combat stance. Casual, lean, sit, lay, dance
    // and any pose transition (including stand_up back to null) hide it so
    // the relaxed clips don't show a rifle dangling from a hand that isn't
    // gripping it. Firing while casual auto-clears pose server-side, so the
    // gun reappears in time for the muzzle flash.
    const gunVisible = pose === null && poseTransition === null;
    gun.visible = gunVisible;
    if (!gunVisible) return;
    // Get the bone's world position, convert to wrapper-local. We skip
    // rotation tracking on purpose — Mixamo's bone world matrix bakes a
    // ~0.001 cumulative scale that contaminates rotation extraction.
    // Using a fixed orientation works because the wrapper already faces
    // the player's forward direction; rotation.y = π flips the gun's
    // local -Z (barrel) to point forward.
    bone.getWorldPosition(gun.position);
    wrapper.worldToLocal(gun.position);
    gun.rotation.set(0, Math.PI, 0);
    gun.scale.setScalar(GUN_SCALE);

    const flash = gun.getObjectByName('muzzleFlash');
    if (flash) flash.visible = performance.now() < muzzleFlashUntilRef.current;

    // Local-player only: when the spring-arm pulls the camera in tight (ADS,
    // wall collision, sprint into geometry), the character's head/torso ends
    // up between the camera and the look ray, occluding the aim cone. Hide
    // the skeletal mesh below a threshold close to ADS framing distance.
    // Gun stays visible since it's a sibling of `cloned` inside the wrapper.
    const myIdNow = useGame.getState().myId;
    if (playerId && playerId === myIdNow) {
      cloned.visible = getCameraDist() >= LOCAL_HIDE_DIST;
    } else if (!cloned.visible) {
      cloned.visible = true;
    }
  });

  // State machine. Acts only on actual transitions.
  useEffect(() => {
    // Decompose world velocity into facing-relative components. Server
    // convention (sim.ts): vx = -sin(yaw)*fwd + cos(yaw)*right, vz =
    // -cos(yaw)*fwd - sin(yaw)*right. Inverting gives the formulas below.
    const cy = Math.cos(yaw);
    const sy = Math.sin(yaw);
    const localForward = -velocity[0] * sy - velocity[2] * cy;
    const localRight = velocity[0] * cy - velocity[2] * sy;
    const speed = Math.hypot(localForward, localRight);
    const airborne = Math.abs(velocity[1]) > AIRBORNE_VY;
    const fireClip = CLIP_NAMES.Fire ? actions[CLIP_NAMES.Fire] : undefined;
    const fireWalkClip = CLIP_NAMES.FireWalk ? actions[CLIP_NAMES.FireWalk] : undefined;
    const reloadClip = CLIP_NAMES.Reload ? actions[CLIP_NAMES.Reload] : undefined;
    const reloadWalkClip = CLIP_NAMES.ReloadWalk ? actions[CLIP_NAMES.ReloadWalk] : undefined;
    const reloadRunClip = CLIP_NAMES.ReloadRun ? actions[CLIP_NAMES.ReloadRun] : undefined;
    const vaultClip = CLIP_NAMES.Vault ? actions[CLIP_NAMES.Vault] : undefined;
    const deathClip = CLIP_NAMES.Death ? actions[CLIP_NAMES.Death] : undefined;
    const pickupCoffeeClip = CLIP_NAMES.PickUpCoffee ? actions[CLIP_NAMES.PickUpCoffee] : undefined;
    const drinkCoffeeClip = CLIP_NAMES.DrinkCoffee ? actions[CLIP_NAMES.DrinkCoffee] : undefined;

    // Pose lookup — only consulted if the server says we're posed. Falls back
    // to null if the clip isn't in the GLB yet (clips ship gradually).
    const poseTransitionKey: ClipKey | null =
      poseTransition === 'sit_down' ? 'SitDown'
      : poseTransition === 'lay_down' ? 'LayDown'
      : poseTransition === 'stand_up' ? 'StandUp'
      : null;
    // Casual mode is the only pose with multiple locomotion clips: Idle when
    // still, CasualWalkF at walk speed, CasualRunF when sprinting. Sprint
    // boundary matches the combat state machine (WALK_RUN_THRESHOLD = midway
    // between walkSpeed and sprintSpeed). When airborne, we return null so
    // the predicate falls through to the Jump path below — otherwise the
    // character would freeze CasualIdle in midair. Only forward locomotion
    // variants ship today (slight foot-slide sideways/back is acceptable;
    // an 8-way casual pack is a follow-up).
    const poseHoldKey: ClipKey | null =
      pose === 'casual_idle'
        ? (airborne
          ? null
          : speed >= WALK_RUN_THRESHOLD ? 'CasualRunF'
          : speed >= IDLE_SPEED ? 'CasualWalkF'
          : 'CasualIdle')
      : pose === 'lean_wall' ? 'LeanWall'
      : pose === 'sit' ? 'SitIdle'
      : pose === 'lay' ? 'LayIdle'
      : pose === 'dance' ? (DANCE_VARIANTS[Math.max(0, Math.min(POSE.danceVariants - 1, danceVariant))] ?? null)
      : null;
    const poseTransitionClip = poseTransitionKey ? actions[CLIP_NAMES[poseTransitionKey] ?? ''] : undefined;
    const poseHoldClip = poseHoldKey ? actions[CLIP_NAMES[poseHoldKey] ?? ''] : undefined;

    // Priority: Death > PoseTransition > PoseHold > Vault > Reload > Fire > Jump (airborne) > locomotion.
    // Death wins over everything — once the player is killed, every other
    // animation is overridden until they respawn.
    // Pose comes next: if the server says we're posed, we play the pose clip
    // and ignore locomotion (the server already zeroed velocity).
    let desired: ClipKey;
    if (!alive && deathClip) {
      desired = 'Death';
    } else if (!alive) {
      // No Death clip in the GLB — fade everything out (legacy behavior).
      for (const a of Object.values(actions)) a?.fadeOut(0.2);
      return;
    } else if (drinkPhase === 'pickup' && pickupCoffeeClip && !airborne) {
      // Drink outranks pose / locomotion. The local player spawns in
      // pose='casual_idle' (peaceful default), and that pose's hold clip
      // would otherwise silently win the priority race below — the drink
      // anim never showed. Keep drink above pose so the 3-second pickup→
      // drink cinematic plays regardless of resting pose. Combat (fire,
      // reload, death) still wins because those branches sit above this.
      desired = 'PickUpCoffee';
    } else if (drinkPhase === 'drink' && drinkCoffeeClip && !airborne) {
      desired = 'DrinkCoffee';
    } else if (poseTransitionKey && poseTransitionClip) {
      desired = poseTransitionKey;
    } else if (poseHoldKey && poseHoldClip) {
      desired = poseHoldKey;
    } else if (vaulting && vaultClip) {
      desired = 'Vault';
    } else if (reloading && !airborne && speed >= WALK_RUN_THRESHOLD && reloadRunClip) {
      desired = 'ReloadRun';
    } else if (reloading && !airborne && speed >= IDLE_SPEED && reloadWalkClip) {
      desired = 'ReloadWalk';
    } else if (reloading && reloadClip && !airborne) {
      desired = 'Reload';
    } else if (firing && !airborne && speed >= IDLE_SPEED && fireWalkClip) {
      desired = 'FireWalk';
    } else if (firing && fireClip && !airborne) {
      desired = 'Fire';
    } else if (airborne) {
      desired = 'Jump';
    } else if (speed < IDLE_SPEED) {
      desired = 'Idle';
    } else {
      const dir = directionFromVelocity(localForward, localRight);
      desired = (speed < WALK_RUN_THRESHOLD ? `Walk${dir}` : `Run${dir}`) as ClipKey;
    }

    // Fall back gracefully if a clip isn't bound (e.g. loading order, or a
    // diagonal clip missing from a future trimmed GLB).
    const wanted: ClipKey =
      pickAction(actions, desired)
        ? desired
        : speed < WALK_RUN_THRESHOLD
          ? pickAction(actions, 'WalkF') ? 'WalkF' : 'Idle'
          : pickAction(actions, 'RunF') ? 'RunF' : 'Idle';

    // Fresh drink event detection. If a new drink session started since our
    // last evaluation, force a transition even if `wanted` matches the
    // currently playing clip — the action may have been disabled by an
    // earlier fadeOut (Three gotcha #3) and needs a full reset cycle.
    const drinkSessionAdvanced = drinkSession !== lastDrinkSessionRef.current;
    lastDrinkSessionRef.current = drinkSession;
    if (currentAnim.current === wanted && !drinkSessionAdvanced) return;

    const prev = pickAction(actions, currentAnim.current);
    const next = pickAction(actions, wanted);
    const sameClip = prev === next;

    if (sameClip && next && !drinkSessionAdvanced) {
      applyClipMode(next, wanted, false);
      next.play();
      currentAnim.current = wanted;
      return;
    }

    if (prev) prev.fadeOut(0.15);
    if (next) {
      applyClipMode(next, wanted, true);
      next.fadeIn(0.15).play();
    }
    currentAnim.current = wanted;
  }, [velocity, yaw, reloading, vaulting, alive, firing, drinkPhase, drinkSession, actions, pose, poseTransition, danceVariant]);

  // Note: deliberately NOT returning null when !alive — we want the corpse
  // to remain visible playing the Death clip until the server respawns the
  // player (PLAYER.respawnMs).

  // Mixamo character: origin at feet, native forward is +z. Our world has
  // forward = -z at yaw=0, so we apply a 180° y rotation to align them.
  // The position offset pushes feet to ground (player position is capsule center).
  // Gun is rendered as a sibling of the cloned model inside the same wrapper
  // group; useFrame updates its matrix to follow the right-hand bone in
  // wrapper-local space, sidestepping the bone's small world-scale that
  // makes bone-attached children invisible.
  return (
    <group ref={wrapperRef} position={[0, -PLAYER.height / 2, 0]} rotation={[0, Math.PI, 0]}>
      <group scale={modelScale}>
        <primitive object={cloned} />
      </group>
      <CharacterGun gunMeshRef={gunMeshRef} />
    </group>
  );
};

const CharacterGun = ({ gunMeshRef }: { gunMeshRef: React.MutableRefObject<Group | null> }) => {
  const gun = useMemo(() => createRifleMesh(), []);
  useEffect(() => {
    gunMeshRef.current = gun;
    return () => {
      if (gunMeshRef.current === gun) gunMeshRef.current = null;
      gun.traverse((obj) => {
        if (obj instanceof Mesh) {
          obj.geometry.dispose();
          if (obj.material instanceof MeshStandardMaterial) obj.material.dispose();
        }
      });
    };
  }, [gun, gunMeshRef]);
  return <primitive object={gun} />;
};

const pickAction = (
  actions: Record<string, AnimationAction | null>,
  key: ClipKey,
): AnimationAction | undefined => {
  const name = CLIP_NAMES[key];
  if (!name) return undefined;
  return actions[name] ?? undefined;
};

// Configures an action for the given state. `freshClip` is true when the
// action's clip is changing (e.g., Idle → Jump) and we want to start the
// leap pose at a known frame; false when the same clip is being re-used
// (Run ↔ Jump) and we want to leave the cycle's playhead alone.
const applyClipMode = (
  action: AnimationAction,
  mode: ClipKey,
  freshClip: boolean,
): void => {
  // CRITICAL: three.js automatically sets enabled=false when a fadeOut
  // completes. fadeIn doesn't re-enable, so the mixer would force the
  // action's effective weight to 0 (the bind / T-pose blends through).
  action.enabled = true;

  if (mode === 'Jump') {
    if (freshClip) action.time = JUMP_POSE_TIME;
    action.paused = true;
    action.timeScale = 0;
    return;
  }

  action.paused = false;
  action.timeScale = CLIP_TIMESCALE[mode] ?? 1;
  if (freshClip && (mode === 'Fire' || mode === 'Reload' || mode === 'ReloadWalk' || mode === 'ReloadRun' || mode === 'Death' || mode === 'PickUpCoffee' || mode === 'DrinkCoffee')) {
    // Restart these clips from the beginning so each shot/reload/death/drink replays cleanly.
    action.time = 0;
  }
  if (freshClip && (mode === 'SitDown' || mode === 'LayDown' || mode === 'StandUp')) {
    // Pose transitions are one-shot — restart from frame 0 each time so a
    // mid-pose change doesn't pick up from a stale playhead.
    action.time = 0;
  }
  if (freshClip && mode === 'Vault') {
    // Skip the approach-run portion at the start of the Mixamo clip.
    action.time = VAULT_START_TIME;
  }
  // One-shots hold their final frame until the server flips state. Vault /
  // Death are existing; pose transitions (SitDown/LayDown/StandUp) follow the
  // same contract — the server-side advancePoseTransition timer is what flips
  // the visual into the looped destination pose.
  if (
    mode === 'Vault' ||
    mode === 'Death' ||
    mode === 'SitDown' ||
    mode === 'LayDown' ||
    mode === 'StandUp'
  ) {
    action.loop = LoopOnce;
    action.clampWhenFinished = true;
  } else {
    action.loop = LoopRepeat;
    action.clampWhenFinished = false;
  }
};

// =============================================================================
// Rifle attached to the right-hand bone.
// Mixamo bone convention: hand bone's local +Y points along the fingers.
// Gun mesh convention: barrel along local -Z, top of receiver along +Y.
// To get barrel-along-finger-direction we rotate the gun -90° around X
// (so gun's local -Z aligns with bone's local +Y, and gun's +Y rolls to +Z).
// Position offset is small — the gun's origin is at the pistol grip, so
// putting it slightly "forward" along the bone (+Y in bone-local) places
// the grip in the palm.
// =============================================================================
const GUN_POS_X = 0;
const GUN_POS_Y = 0.04;
const GUN_POS_Z = 0;
const GUN_ROT_X = -Math.PI / 2;
const GUN_ROT_Y = 0;
const GUN_ROT_Z = 0;
const GUN_SCALE = 1;

// Drop position tracks on the Hips (root) bone from every clip, replacing
// each clip with a copy whose tracks are filtered. Keeps rotation tracks so
// limbs still animate; removes only the translation that competes with the
// server's authoritative position.
//
// Exception: clips whose visual REQUIRES the Hips Y descent — Death drops the
// body to the floor via Hips.y. Stripping it leaves the corpse hovering at
// standing height. We keep all Hips translation for these (X/Z drift is
// negligible for a death-in-place clip).
const KEEP_ROOT_MOTION = new Set(['Death']);
const stripRootMotion = (clips: readonly AnimationClip[]): AnimationClip[] =>
  clips.map((clip) => {
    if (KEEP_ROOT_MOTION.has(clip.name)) return clip;
    const tracks = clip.tracks.filter(
      (t) => !/Hips\.position$/i.test(t.name) && !/Hips\.scale$/i.test(t.name),
    );
    return new AnimationClip(clip.name, clip.duration, tracks, clip.blendMode);
  });

const findRightHandBone = (root: Object3D): Object3D | null => {
  let best: Object3D | null = null;
  root.traverse((obj) => {
    if (best) return;
    const name = obj.name;
    const lower = name.toLowerCase();
    if (
      name === 'mixamorigRightHand' ||
      name === 'RightHand' ||
      name === 'Hand_R' ||
      name === 'hand_r' ||
      (lower.includes('hand') &&
        (lower.includes('right') || lower.endsWith('_r') || lower.endsWith('.r')))
    ) {
      best = obj;
    }
  });
  return best;
};

// Two-handed rifle. Local origin sits at the pistol-grip — that's where the
// dominant hand goes, so attaching to the right-hand bone places the grip
// in the hand naturally.
const createRifleMesh = (): Group => {
  const gun = new Group();

  const metal = new MeshStandardMaterial({ color: '#1a1a1a', metalness: 0.7, roughness: 0.35 });
  const wood = new MeshStandardMaterial({ color: '#3a2818', metalness: 0.05, roughness: 0.85 });

  // Receiver — main body, sits forward of the grip
  const receiver = new Mesh(new BoxGeometry(0.06, 0.08, 0.3), metal);
  receiver.position.set(0, 0.07, -0.05);
  receiver.castShadow = true;
  gun.add(receiver);

  // Barrel — extends forward (-z) from the front of the receiver
  const barrel = new Mesh(new CylinderGeometry(0.014, 0.014, 0.4, 12), metal);
  barrel.rotation.x = Math.PI / 2;
  barrel.position.set(0, 0.09, -0.4);
  barrel.castShadow = true;
  gun.add(barrel);

  // Stock — extends backward (+z) from the receiver
  const stock = new Mesh(new BoxGeometry(0.05, 0.08, 0.22), wood);
  stock.position.set(0, 0.06, 0.21);
  stock.castShadow = true;
  gun.add(stock);

  // Pistol grip — directly at the gun's local origin (where the hand bone holds it)
  const grip = new Mesh(new BoxGeometry(0.04, 0.11, 0.05), wood);
  grip.position.set(0, 0, 0);
  grip.rotation.x = -0.18;
  grip.castShadow = true;
  gun.add(grip);

  // Forend — under the barrel, support-hand grip
  const forend = new Mesh(new BoxGeometry(0.05, 0.04, 0.18), wood);
  forend.position.set(0, 0.05, -0.22);
  forend.castShadow = true;
  gun.add(forend);

  // Iron sight
  const sight = new Mesh(new BoxGeometry(0.012, 0.025, 0.02), metal);
  sight.position.set(0, 0.13, -0.1);
  gun.add(sight);

  // Muzzle flash — at the barrel tip, hidden by default. Toggled visible for
  // ~one frame on shot events. Unlit material + fog disabled so it pops.
  const muzzleFlash = new Mesh(
    new SphereGeometry(0.06, 10, 10),
    new MeshBasicMaterial({ color: '#fff5a0', transparent: true, opacity: 0.95, fog: false }),
  );
  muzzleFlash.position.set(0, 0.09, -0.62);
  muzzleFlash.name = 'muzzleFlash';
  muzzleFlash.visible = false;
  gun.add(muzzleFlash);

  return gun;
};
