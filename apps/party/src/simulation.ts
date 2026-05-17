import {
  COFFEE,
  MAP,
  NET,
  PLAYER,
  POSE,
  TICK_MS,
  VAULT,
  WEAPON,
  WINDOWS,
  applyMovement,
  horizontalDistanceToCoffee,
  rayCapsuleVertical,
  raycastObstacles,
  type GameEvent,
  type InputFrame,
  type Pose,
  type PoseTransition,
  type Vec3,
  type WindowDef,
} from '@slipstream-npc/shared';
import type { ServerPlayer } from './state.js';
import { randomSpawn } from './state.js';
import { markAttack } from './social.js';

const POSE_TRANSITION_MS: Record<NonNullable<PoseTransition>, number> = {
  sit_down: POSE.sitDownMs,
  lay_down: POSE.layDownMs,
  stand_up: POSE.standUpMs,
};

// Server-side helper to drive a player's pose. Used by the local-player
// set_pose ClientMessage path and the /tools/set_pose webhook for voice
// agents. Sets the transition (if any) and destination pose atomically;
// the simulation tick flips transition → null after the timing elapses.
export const setPose = (
  player: ServerPlayer,
  pose: Pose,
  transition: PoseTransition,
  danceVariant: number,
  now: number,
): void => {
  player.pose = pose;
  player.poseTransition = transition;
  player.danceVariant = Math.max(0, Math.floor(danceVariant)) % POSE.danceVariants;
  player.poseStartedAt = now;
  if (transition !== null) {
    player.velocity = [0, 0, 0];
  }
};

// Combat overrides social. Called from the hit path so a posed NPC drops
// the pose the moment someone shoots them.
export const clearPose = (player: ServerPlayer): void => {
  player.pose = null;
  player.poseTransition = null;
  player.danceVariant = 0;
  player.poseStartedAt = undefined;
};

// Advance pose-transition timers. Called once per tick from runTick.
export const advancePoseTransition = (player: ServerPlayer, now: number): void => {
  if (player.poseTransition === null) return;
  const startedAt = player.poseStartedAt ?? now;
  const elapsed = now - startedAt;
  const required = POSE_TRANSITION_MS[player.poseTransition];
  if (elapsed < required) return;
  // Transition complete. For sit_down / lay_down the destination pose is
  // already in `player.pose`. For stand_up we always return to default null.
  if (player.poseTransition === 'stand_up') {
    player.pose = null;
  }
  player.poseTransition = null;
  player.poseStartedAt = now;
};

// Voice-agent-facing API: pick the right transition for a target pose so the
// agent only has to say "sit" rather than "play sit_down for 1.5s then sit".
// `target` mirrors the agent webhook contract — null means "back to default."
export const applyAgentPose = (
  player: ServerPlayer,
  target: Pose,
  danceVariant: number,
  now: number,
): void => {
  // Standing up from a held pose plays the stand_up transition first.
  if (target === null) {
    if (player.pose === 'sit' || player.pose === 'lay') {
      setPose(player, null, 'stand_up', 0, now);
    } else {
      clearPose(player);
    }
    return;
  }
  if (target === 'sit') {
    setPose(player, 'sit', 'sit_down', 0, now);
    return;
  }
  if (target === 'lay') {
    setPose(player, 'lay', 'lay_down', 0, now);
    return;
  }
  // casual_idle, lean_wall, dance — no transition (the destination loop just starts).
  setPose(player, target, null, danceVariant, now);
};

export const applyInput = (player: ServerPlayer, input: InputFrame, now: number): void => {
  if (!player.alive) {
    player.lastSeenSeq = input.seq;
    return;
  }
  // Firing engages combat from any non-combat state — clears casual_idle,
  // breaks committed social poses, and abandons in-progress transitions so
  // the rifle-aim state machine takes over instantly. Done before computing
  // freeze flags so a same-frame fire from a posed state doesn't stall input.
  if (input.fire && player.pose !== null) {
    clearPose(player);
  }
  // Casual mode is the default walking state — the player moves normally,
  // just with relaxed animations instead of rifle aim. Only the *committed*
  // social poses (sit, lay, lean, dance) and their transitions freeze input.
  const isCommittedPose =
    player.pose !== null && player.pose !== 'casual_idle';
  const isInTransition = player.poseTransition !== null;
  // Committed pose / mid-transition: freeze position, only update look.
  if (isCommittedPose || isInTransition) {
    player.yaw = input.yaw;
    player.pitch = input.pitch;
    player.velocity = [0, 0, 0];
    player.lastSeenSeq = input.seq;
    player.lastIntegratedAt = now;
    return;
  }
  // Vaulting: server-driven tween owns position; just keep yaw/pitch fresh
  // so the camera follows the player's view, and ack the input.
  if (player.vaultEndAt !== null) {
    player.yaw = input.yaw;
    player.pitch = input.pitch;
    player.lastSeenSeq = input.seq;
    return;
  }
  // Drink lock: while the coffee animation is playing, the body is frozen
  // in place so the pickup→drink clip doesn't slide. Yaw/pitch still update
  // so the camera (free-orbiting around the locked character) can be
  // mouse-driven. Velocity zeroed every tick so any pre-drink momentum
  // dies immediately. Lock duration matches the client's animation window
  // (COFFEE.drinkLockMs).
  if (player.drinkingUntil !== undefined && Date.now() < player.drinkingUntil) {
    player.yaw = input.yaw;
    player.pitch = input.pitch;
    player.velocity = [0, 0, 0];
    player.lastSeenSeq = input.seq;
    player.lastIntegratedAt = now;
    return;
  }
  // Edge-trigger: if jump was pressed AND we're standing near a window we
  // can vault through, start the vault instead of running normal movement.
  if (input.jump && player.grounded) {
    const plan = planVault(player);
    if (plan !== null) {
      player.vaultFrom = plan.from;
      player.vaultTo = plan.to;
      player.vaultEndAt = now + VAULT.durationMs;
      player.vaulting = true;
      player.position = plan.from;
      player.velocity = [0, 0, 0];
      player.grounded = false;
      player.yaw = input.yaw;
      player.pitch = input.pitch;
      player.lastSeenSeq = input.seq;
      player.lastIntegratedAt = now;
      return;
    }
  }
  const next = applyMovement(player, input);
  player.position = next.position;
  player.velocity = next.velocity;
  player.yaw = next.yaw;
  player.pitch = next.pitch;
  player.grounded = next.grounded;
  player.lastSeenSeq = input.seq;
  player.lastIntegratedAt = now;

  if (input.reload && !player.reloading && player.ammo < WEAPON.magazineSize) {
    player.reloading = true;
    player.reloadDoneAt = now + WEAPON.reloadMs;
  }
};

// Server-authoritative coffee-drink check. Returns a DrinkEvent when
// proximity passes. Pure decision — caller broadcasts the event and handles
// NPC-alert side effects (synchronous applyInput stays async-free).
export interface DrinkResult {
  event: GameEvent;
}

export const tryDrinkCoffee = (
  player: ServerPlayer,
  now: number,
): DrinkResult | null => {
  if (!player.alive) return null;
  if (player.reloading || player.vaultEndAt !== null) return null;
  if (COFFEE.cooldownMs > 0 && player.lastCoffeeDrinkAt !== undefined) {
    const sinceMs = Date.now() - player.lastCoffeeDrinkAt;
    if (sinceMs < COFFEE.cooldownMs) return null;
  }
  if (horizontalDistanceToCoffee(player.position) > COFFEE.interactRadius) return null;

  player.health = Math.min(PLAYER.maxHealth, player.health + COFFEE.healAmount);
  player.coffeeBuffUntil = Date.now() + COFFEE.buffDurationMs;
  player.lastCoffeeDrinkAt = Date.now();
  // Movement lock for the full animation window (align + pickup + drink).
  // applyInput zeroes velocity and skips applyMovement until this elapses,
  // so the player can't slide around mid-sip.
  player.drinkingUntil = Date.now() + COFFEE.drinkLockMs;
  // Drinking is a non-combat moment — drop combat aim back into casual stance
  // for the duration of the animation so the pickup→drink clip reads cleanly
  // AND the held rifle disappears (Character.tsx gates gun visibility on
  // `pose === null`, so combat-mode drinkers would otherwise sip with the
  // rifle still in hand). Done unconditionally: every drink ends up in
  // casual_idle, regardless of whether the player was in combat, sitting,
  // leaning, or dancing.
  if (player.pose !== 'casual_idle' || player.poseTransition !== null) {
    clearPose(player);
    player.pose = 'casual_idle';
  }

  return {
    event: { type: 'drink', playerId: player.id, at: now },
  };
};

interface VaultPlan {
  from: Vec3;
  to: Vec3;
}

const planVault = (player: ServerPlayer): VaultPlan | null => {
  const fwdX = -Math.sin(player.yaw);
  const fwdZ = -Math.cos(player.yaw);
  let best: { window: WindowDef; throughDist: number; signedThrough: number } | null = null;

  for (const w of WINDOWS) {
    const along = w.axis === 'x' ? player.position[0] : player.position[2];
    const through = w.axis === 'x' ? player.position[2] : player.position[0];
    const fwdThrough = w.axis === 'x' ? fwdZ : fwdX;
    const offsetThrough = through - w.wallCoord;

    if (Math.abs(offsetThrough) > VAULT.triggerRange) continue;
    if (Math.abs(along - w.openingCenter) > w.openingHalfWidth + VAULT.lateralSlack) continue;
    // Must face TOWARD the wall: forward's through-axis sign opposite to player's offset
    if (Math.sign(fwdThrough) === Math.sign(offsetThrough)) continue;
    if (Math.sign(offsetThrough) === 0) continue; // standing exactly on the wall — no clear direction
    if (Math.abs(fwdThrough) < VAULT.facingMin) continue;

    if (best === null || Math.abs(offsetThrough) < best.throughDist) {
      best = { window: w, throughDist: Math.abs(offsetThrough), signedThrough: offsetThrough };
    }
  }
  if (best === null) return null;

  const { window: w, signedThrough } = best;
  // Don't lateral-snap on trigger — that visibly slides the player sideways
  // at vault start. Tween from the player's actual current position to the
  // opening-centered exit on the opposite side, so any lateral correction
  // happens smoothly across the vault duration.
  const exitSign = -Math.sign(signedThrough);
  const toAlong = w.openingCenter;
  const toThrough = w.wallCoord + exitSign * VAULT.exitOffset;
  const y = MAP.spawnHeight;
  const from: Vec3 = [player.position[0], y, player.position[2]];
  const to: Vec3 =
    w.axis === 'x' ? [toAlong, y, toThrough] : [toThrough, y, toAlong];
  return { from, to };
};

// Drive the position tween while a vault is in progress. Called every tick
// from the room's tick loop. When the vault ends, snaps to destination and
// clears the state so normal movement resumes.
export const tickVault = (player: ServerPlayer, now: number): void => {
  if (player.vaultEndAt === null || player.vaultFrom === null || player.vaultTo === null) return;
  if (now >= player.vaultEndAt) {
    player.position = player.vaultTo;
    player.velocity = [0, 0, 0];
    player.grounded = true;
    player.vaultFrom = null;
    player.vaultTo = null;
    player.vaultEndAt = null;
    player.vaulting = false;
    player.lastIntegratedAt = now;
    return;
  }
  const total = VAULT.durationMs;
  const remaining = player.vaultEndAt - now;
  const t = Math.max(0, Math.min(1, 1 - remaining / total));
  const f = player.vaultFrom;
  const to = player.vaultTo;
  // Sin arc so the player rises and lands without a discontinuity.
  const arc = Math.sin(t * Math.PI) * VAULT.arcHeight;
  player.position = [
    f[0] + (to[0] - f[0]) * t,
    f[1] + (to[1] - f[1]) * t + arc,
    f[2] + (to[2] - f[2]) * t,
  ];
  player.lastIntegratedAt = now;
};

// Fill physics gaps for players who aren't sending inputs (idle, AFK, just spawned).
// Without this, gravity never runs for them and they freeze at the spawn height.
//
// CRITICAL: this only runs when the player is genuinely idle (no input within
// the last ~1.5 ticks). For an active player, applyInput handles physics on
// every frame; running integrateIdle on top of it would overwrite the
// just-computed velocity with (0, 0, 0) — the network would see velocity
// alternating between intended and zero, and animation state machines on the
// client would oscillate between Walk and Idle.
const IDLE_THRESHOLD_MS = TICK_MS * 1.5;

export const integrateIdle = (player: ServerPlayer, now: number): void => {
  if (!player.alive) {
    player.lastIntegratedAt = now;
    return;
  }
  // Vault tween owns position; don't apply gravity over the top of it.
  if (player.vaultEndAt !== null) return;
  const dtMs = now - player.lastIntegratedAt;
  if (dtMs < IDLE_THRESHOLD_MS) return;
  const idleFrame: InputFrame = {
    seq: 0,
    dtMs,
    forward: 0,
    right: 0,
    jump: false,
    sprint: false,
    fire: false,
    reload: false,
    interact: false,
    yaw: player.yaw,
    pitch: player.pitch,
    aimOrigin: null,
    aim: null,
  };
  const next = applyMovement(player, idleFrame);
  player.position = next.position;
  player.velocity = next.velocity;
  player.grounded = next.grounded;
  player.lastIntegratedAt = now;
};

export const finishReload = (player: ServerPlayer, now: number): void => {
  if (player.reloading && player.reloadDoneAt !== null && now >= player.reloadDoneAt) {
    player.ammo = WEAPON.magazineSize;
    player.reloading = false;
    player.reloadDoneAt = null;
  }
};

export const maybeRespawn = (player: ServerPlayer, now: number): void => {
  if (!player.alive && player.respawnAt !== null && now >= player.respawnAt) {
    player.position = randomSpawn();
    player.velocity = [0, 0, 0];
    player.health = PLAYER.maxHealth;
    player.alive = true;
    player.respawnAt = null;
    player.ammo = WEAPON.magazineSize;
    player.reloading = false;
    player.reloadDoneAt = null;
    player.grounded = true;
    player.lastIntegratedAt = now;
    player.lastDamagedAt = 0;
    player.vaultFrom = null;
    player.vaultTo = null;
    player.vaultEndAt = null;
    player.vaulting = false;
    // Drop rewind history at respawn so a freshly respawned player can't be
    // hit by a delayed shot at their pre-death location.
    player.positionHistory = [];
    // Pose doesn't survive respawn as-is — a corpse playing Sit then standing
    // up alive at the spawn point would look bizarre. Clear all pose state
    // and put the player back into the default casual stance. Voice agents
    // can re-pose their NPCs after respawn if it makes narrative sense.
    clearPose(player);
    player.pose = 'casual_idle';
  }
};

// Lag-compensation rewind buffer.
//
// We sample (serverTime, position) once per server tick into a fixed-size
// circular buffer. tryFire looks up each victim's position at the shooter's
// view-time — `now - NET.interpolationDelayMs` — instead of using the latest
// authoritative position. Without this, a target moving at walk speed (6m/s)
// is offset ~0.6m from where the shooter sees them on screen and any half-
// decent shot misses for reasons the shooter can't perceive.
//
// Buffer holds ~POSITION_HISTORY_MS of samples. Older entries are evicted.
const POSITION_HISTORY_MS = 500;

export const pushPositionHistory = (player: ServerPlayer, now: number): void => {
  if (!player.alive) return;
  player.positionHistory.push({ t: now, pos: player.position });
  // Evict samples older than POSITION_HISTORY_MS so the buffer can't grow
  // unbounded for a long-lived match.
  const cutoff = now - POSITION_HISTORY_MS;
  while (player.positionHistory.length > 0 && player.positionHistory[0]!.t < cutoff) {
    player.positionHistory.shift();
  }
};

// Returns the player's position at `t` server-time, linearly interpolated
// between the two history samples that bracket it. Falls back to current
// position if `t` is newer than the freshest sample (or the buffer is empty);
// clamps to the oldest sample if `t` is older than anything we have.
const positionAt = (player: ServerPlayer, t: number): Vec3 => {
  const h = player.positionHistory;
  if (h.length === 0) return player.position;
  if (t >= h[h.length - 1]!.t) return player.position;
  if (t <= h[0]!.t) return h[0]!.pos;
  // Linear scan from the back is cheap — buffer is small (~15 entries at 30Hz
  // and 500ms) and lookups are rare (one per shot).
  for (let i = h.length - 1; i > 0; i--) {
    const a = h[i - 1]!;
    const b = h[i]!;
    if (t >= a.t && t <= b.t) {
      const span = b.t - a.t;
      const frac = span > 0 ? (t - a.t) / span : 0;
      return [
        a.pos[0] + (b.pos[0] - a.pos[0]) * frac,
        a.pos[1] + (b.pos[1] - a.pos[1]) * frac,
        a.pos[2] + (b.pos[2] - a.pos[2]) * frac,
      ];
    }
  }
  return player.position;
};

// Out-of-combat health regen (CoD/Halo style). Runs every tick; only heals
// after `regenDelayMs` of no damage. Heals at `regenPerSec` and clamps at max.
export const regenHealth = (player: ServerPlayer, now: number): void => {
  if (!player.alive) return;
  if (player.health >= PLAYER.maxHealth) return;
  if (now - player.lastDamagedAt < PLAYER.regenDelayMs) return;
  player.health = Math.min(
    PLAYER.maxHealth,
    player.health + PLAYER.regenPerSec * (TICK_MS / 1000),
  );
};

// Per-NPC voice-session alerts. Each kind is emitted to the active voice
// session of the bot it concerns, formatted into a system message on the
// server, and forwarded to the SDK via sendContextualUpdate so the agent
// knows what its body just did or had done to it.
interface BaseAlert {
  targetConnId: string;
  npcId: string;
  sessionId: string;
}
export type NpcAlert =
  | (BaseAlert & {
      kind: 'damaged';
      shooterName: string;
      damage: number;
      hpAfter: number;
      killed: boolean;
    })
  | (BaseAlert & {
      kind: 'shot_fired';
      victimName: string | null;
      hit: boolean;
      killed: boolean;
    })
  | (BaseAlert & {
      kind: 'friend_attacked';
      friendName: string;
      attackerName: string;
    })
  // A kill happened somewhere on the map that this NPC was not directly
  // involved in (not the shooter, not the victim, victim wasn't a friend
  // — those cases already fire damaged / shot_fired / friend_attacked).
  // Used to let the agent register kills it would plausibly hear.
  | (BaseAlert & {
      kind: 'kill_witnessed';
      killerName: string;
      victimName: string;
    })
  // This NPC's 30-second hostility window toward a specific person just
  // expired. Useful so the agent stops being "angry" mid-conversation
  // when the timer runs out.
  | (BaseAlert & {
      kind: 'hostility_ended';
      targetName: string;
    })
  // Another NPC (not this one) just reached the friendship threshold
  // with a player. NPCs all know each other — they'd notice.
  | (BaseAlert & {
      kind: 'npc_befriended_player';
      npcName: string;
      playerName: string;
    })
  // The player this NPC is currently talking to just started reloading
  // their rifle. ~1.5s window of vulnerability.
  | (BaseAlert & {
      kind: 'player_reloaded';
      playerName: string;
    })
  // A human player joined the room while this NPC was in a voice session.
  | (BaseAlert & {
      kind: 'player_joined';
      playerName: string;
    })
  // A human player left the room while this NPC was in a voice session.
  // Excludes the player who was the NPC's conversation partner — that
  // case ends the session entirely and is handled by onClose.
  | (BaseAlert & {
      kind: 'player_left';
      playerName: string;
    })
  // Self-state confirmations: the NPC's own body just changed state due to
  // a tool call OR the server-side regex fallback OR another in-game event.
  // Critical for closing the agent's perception loop — without these, the
  // LLM has no idea the regex/tool changed its state and may insist
  // "my feet are stuck" when its body is actually walking.
  | (BaseAlert & {
      kind: 'self_follow_started';
      playerName: string;
      source: 'tool' | 'regex';
    })
  | (BaseAlert & {
      kind: 'self_follow_stopped';
      playerName: string;
      source: 'tool' | 'regex' | 'auto';
    })
  | (BaseAlert & {
      kind: 'self_flee_started';
      playerName: string;
    })
  | (BaseAlert & {
      kind: 'self_attack_started';
      targetName: string;
      source: 'tool' | 'damaged';
    })
  | (BaseAlert & {
      kind: 'self_attack_stopped';
      targetName: string;
      source: 'tool' | 'expire';
    })
  | (BaseAlert & {
      kind: 'self_befriended_player';
      playerName: string;
    })
  | (BaseAlert & {
      kind: 'self_patrol_started';
      sprint: boolean;
    })
  | (BaseAlert & {
      kind: 'self_lean_started';
      /** Approximate distance the bot will walk to reach the wall. */
      distM: number;
    })
  | (BaseAlert & {
      kind: 'self_lean_no_wall';
    })
  // A player (or another NPC) just used the free coffee maker. Dispatched
  // both to NPCs currently in a session with the drinker AND to NPCs within
  // COFFEE.observationRadius of the maker who happen to be in a session
  // with anyone. The discovery itself is seeded as a persona delta at room
  // boot via GAME_CHANGES — this alert is the live "I see you using it"
  // reaction. Guts (npcId === 'guts') gets a tailored line via dispatch
  // that calls back to his existing coffee-price gripes.
  | (BaseAlert & {
      kind: 'coffee_consumed';
      drinkerName: string;
    })
  // Self-state confirmation that THIS NPC has disengaged from conversation
  // movement and is currently walking to the maker. Fired when the
  // drink_coffee tool lands, or when transcript fallback catches the NPC's
  // own commitment to go.
  | (BaseAlert & {
      kind: 'self_coffee_started';
      source: 'tool' | 'transcript';
    })
  // Self-state confirmation that THIS NPC just finished drinking from the
  // maker — fired after a drink_coffee tool call lands. Closes the agent's
  // perception loop so the LLM doesn't immediately ask for another drink.
  | (BaseAlert & {
      kind: 'self_drank_coffee';
    })
  // Self-state confirmation that THIS NPC tried to walk to the coffee
  // maker but couldn't reach it before the timeout / a higher-priority
  // state (combat, flee) interrupted them. Lets the agent know in voice
  // that the drink didn't happen.
  | (BaseAlert & {
      kind: 'self_coffee_unreachable';
    });

// Back-compat alias (older callsites use this name).
export type NpcDamageAlert = NpcAlert;

export const tryFire = (
  shooter: ServerPlayer,
  others: ServerPlayer[],
  now: number,
  aim: { aimOrigin: Vec3; aim: Vec3 } | null,
  onNpcAlert?: (alert: NpcAlert) => void,
): GameEvent[] => {
  if (!shooter.alive || shooter.reloading || shooter.vaultEndAt !== null || shooter.ammo <= 0) return [];

  shooter.ammo -= 1;

  // Eye sits a bit above body center (so muzzle flashes don't come out of the
  // chest). Always used as the visual tracer ORIGIN — even when authoritative
  // hit detection casts from the camera, the visible bullet travels from gun
  // to impact so the player sees it leave the rifle.
  const eyeOrigin: Vec3 = [
    shooter.position[0],
    shooter.position[1] + PLAYER.height * 0.3,
    shooter.position[2],
  ];

  // Authoritative cast origin and direction. With a client-supplied aim point,
  // fire from the CAMERA toward the resolved aim — this is the third-person
  // camera-vs-eye parallax fix. The camera sits behind+above the player, so
  // a low ledge that occludes the eye-forward ray doesn't occlude the camera
  // ray; reticle clear == server-side clear.
  let castOrigin: Vec3;
  let dir: Vec3;
  if (aim) {
    castOrigin = aim.aimOrigin;
    const dx = aim.aim[0] - aim.aimOrigin[0];
    const dy = aim.aim[1] - aim.aimOrigin[1];
    const dz = aim.aim[2] - aim.aimOrigin[2];
    const len = Math.hypot(dx, dy, dz) || 1;
    dir = [dx / len, dy / len, dz / len];
  } else {
    // No camera info (bot, dropped frame, older client). Old behavior: fire
    // from eye along yaw/pitch. Still gets lag-comp rewind below.
    castOrigin = eyeOrigin;
    dir = directionFromYawPitch(shooter.yaw, shooter.pitch);
  }

  // Lag-compensation rewind: aim at the world-time the shooter saw on their
  // screen, which is the latest snapshot they received minus the
  // interpolation delay buffer. We don't track per-client RTT precisely yet,
  // so use just NET.interpolationDelayMs — that alone covers the dominant
  // visual-lag source for most networks. Future polish can add RTT/2.
  const rewindAt = now - NET.interpolationDelayMs;
  const playerHit = raycastPlayers(castOrigin, dir, WEAPON.range, others, shooter.id, rewindAt);
  const wallT = raycastObstacles(castOrigin, dir, WEAPON.range);

  // Shot is blocked if a wall is closer than the nearest player.
  const blocked = wallT !== null && (playerHit === null || wallT < playerHit.t);
  const effectiveHit = blocked ? null : playerHit;
  const castStopT =
    blocked && wallT !== null
      ? wallT
      : effectiveHit !== null
        ? effectiveHit.t
        : WEAPON.range;

  // Visible tracer: anchor at the eye/gun and aim at the world-space impact
  // point. When camera-anchored cast resolves a hit at e.g. (5, 1.4, -10),
  // we want the tracer to appear to leave the rifle and end at the same
  // impact point — not at where the eye-forward ray would have landed.
  const impactX = castOrigin[0] + dir[0] * castStopT;
  const impactY = castOrigin[1] + dir[1] * castStopT;
  const impactZ = castOrigin[2] + dir[2] * castStopT;
  const eyeDx = impactX - eyeOrigin[0];
  const eyeDy = impactY - eyeOrigin[1];
  const eyeDz = impactZ - eyeOrigin[2];
  const eyeLen = Math.hypot(eyeDx, eyeDy, eyeDz) || 1;
  const eyeStopT = Math.min(eyeLen, WEAPON.range);
  const eyeDir: Vec3 = [eyeDx / eyeLen, eyeDy / eyeLen, eyeDz / eyeLen];

  const events: GameEvent[] = [
    {
      type: 'shot',
      shooterId: shooter.id,
      origin: eyeOrigin,
      // Direction is unit; we encode the effective tracer length by scaling so
      // the client renders a beam to the impact point, not 80m past the wall.
      direction: [
        eyeDir[0] * (eyeStopT / WEAPON.range),
        eyeDir[1] * (eyeStopT / WEAPON.range),
        eyeDir[2] * (eyeStopT / WEAPON.range),
      ],
      hit: effectiveHit?.hitId ?? null,
      at: now,
    },
  ];

  let killedVictim = false;
  let victimName: string | null = null;
  if (effectiveHit) {
    const victim = others.find((p) => p.id === effectiveHit.hitId);
    if (victim && victim.alive) {
      victim.health -= WEAPON.damage;
      victim.lastDamagedAt = now;
      victimName = victim.name;
      // Combat overrides social — break any pose the victim was in so the
      // damage-reactive state machine (engage, flee, return fire) can take over.
      clearPose(victim);
      markAttack(shooter.name, victim, [shooter, ...others], now, (friend) => {
        if (
          onNpcAlert &&
          friend.isBot &&
          friend.npcId &&
          friend.botConversationWith &&
          friend.botActiveSessionId
        ) {
          onNpcAlert({
            kind: 'friend_attacked',
            targetConnId: friend.botConversationWith,
            npcId: friend.npcId,
            sessionId: friend.botActiveSessionId,
            friendName: victim.name,
            attackerName: shooter.name,
          });
        }
      });
      if (
        onNpcAlert &&
        victim.isBot &&
        victim.npcId &&
        victim.botConversationWith &&
        victim.botActiveSessionId
      ) {
        onNpcAlert({
          kind: 'damaged',
          targetConnId: victim.botConversationWith,
          npcId: victim.npcId,
          sessionId: victim.botActiveSessionId,
          shooterName: shooter.name,
          damage: WEAPON.damage,
          hpAfter: Math.max(0, victim.health),
          killed: victim.health <= 0,
        });
      }
      if (victim.health <= 0) {
        victim.health = 0;
        victim.alive = false;
        victim.respawnAt = now + PLAYER.respawnMs;
        victim.deaths += 1;
        shooter.kills += 1;
        killedVictim = true;
        events.push({
          type: 'kill',
          killerId: shooter.id,
          victimId: victim.id,
          at: now,
        });
      }
    }
  }

  // Shooter-side awareness: when a bot fires (hit or miss), tell its voice
  // session so the agent can answer "why are you shooting?" honestly. For
  // misses we still emit — the agent should know it pulled the trigger even
  // if the round didn't connect.
  if (
    onNpcAlert &&
    shooter.isBot &&
    shooter.npcId &&
    shooter.botConversationWith &&
    shooter.botActiveSessionId
  ) {
    if (victimName === null && shooter.botTargetId) {
      const intended = others.find((p) => p.id === shooter.botTargetId);
      if (intended) victimName = intended.name;
    }
    onNpcAlert({
      kind: 'shot_fired',
      targetConnId: shooter.botConversationWith,
      npcId: shooter.npcId,
      sessionId: shooter.botActiveSessionId,
      victimName,
      hit: effectiveHit !== null,
      killed: killedVictim,
    });
  }

  return events;
};

const directionFromYawPitch = (yaw: number, pitch: number): Vec3 => {
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  const cp = Math.cos(pitch);
  const sp = Math.sin(pitch);
  return [-sy * cp, sp, -cy * cp];
};

interface RayHit {
  hitId: string;
  t: number;
}

const raycastPlayers = (
  origin: Vec3,
  dir: Vec3,
  maxDist: number,
  targets: ServerPlayer[],
  excludeId: string,
  rewindAt: number,
): RayHit | null => {
  let best: RayHit | null = null;
  // Hit volume = the visible body. Capsule axis is vertical, segment endpoints
  // sit `(height/2 - radius)` above and below capsule center, hemispheres of
  // `radius` cap each end. A small bonus over PLAYER.radius keeps registration
  // feeling snappy without being implausibly forgiving.
  const hitRadius = PLAYER.radius + 0.1;
  const halfSegment = PLAYER.height / 2 - PLAYER.radius;
  for (const p of targets) {
    if (p.id === excludeId || !p.alive) continue;
    // Rewind to where the shooter SAW this target on screen, not where they
    // are right now. Without this, a target moving even at walk speed shows
    // a ~0.6m offset between visual and authoritative position — every
    // remotely accurate shot misses.
    const rewound = positionAt(p, rewindAt);
    const yLow = rewound[1] - halfSegment;
    const yHigh = rewound[1] + halfSegment;
    const t = rayCapsuleVertical(
      origin,
      dir,
      rewound[0],
      rewound[2],
      yLow,
      yHigh,
      hitRadius,
      maxDist,
    );
    if (t !== null && (best === null || t < best.t)) {
      best = { hitId: p.id, t };
    }
  }
  return best;
};
