import {
  BOT,
  COFFEE_NAV_POSITION,
  PLAYER,
  TICK_MS,
  WEAPON,
  type BotProfile,
  type InputFrame,
  type Vec3,
} from '@slipstream-npc/shared';
import type { ServerPlayer } from '../state.js';
import { applyInput, setPose } from '../simulation.js';
import { planPath, randomPatrolGoal } from './path.js';
import { getNavGraph } from './waypoints.js';
import {
  directionFromYawPitch,
  eyePosition,
  findVisibleTarget,
  hasLineOfSight,
  slewAngle,
  yawPitchToward,
} from './aim.js';

// Memory of recently chosen patrol goals (node indices). Capped to keep the
// bias from starving the bot on small maps with few nodes.
const VISITED_MEMORY = 8;
// Patrol-goal selection mix.
//   - "unvisited": ~60% — random pick from nodes the bot hasn't been to lately.
//     Drives general coverage.
//   - "upper":     ~25% — random pick from any node above the ground tier
//     so multi-level maps see bots actively climbing.
//   - "expedition": ~15% — pick the FARTHEST node from current position so
//     the bot occasionally commits to a long traversal across the map.
const UPPER_TIER_Y_MIN = 2.5;
const MIN_GOAL_DISTANCE = 6;

const pickExplorationGoal = (bot: ServerPlayer): Vec3 | null => {
  const graph = getNavGraph();
  if (graph.nodes.length === 0) return null;
  const visited = bot.botVisitedRecent ?? [];
  const visitedSet = new Set(visited);
  const here = bot.position;
  const minDistSq = MIN_GOAL_DISTANCE * MIN_GOAL_DISTANCE;
  const farEnough = (n: Vec3) => {
    const dx = n[0] - here[0];
    const dz = n[2] - here[2];
    return dx * dx + dz * dz >= minDistSq;
  };

  const roll = Math.random();
  let chosenIdx = -1;

  // ~15% — long expedition: farthest reachable node.
  if (roll < 0.15) {
    let bestDist = -1;
    for (let i = 0; i < graph.nodes.length; i++) {
      const n = graph.nodes[i]!;
      const dx = n[0] - here[0];
      const dz = n[2] - here[2];
      const d = dx * dx + dz * dz;
      if (d > bestDist) {
        bestDist = d;
        chosenIdx = i;
      }
    }
  } else if (roll < 0.40) {
    // ~25% — upper-tier bias.
    const candidates: number[] = [];
    for (let i = 0; i < graph.nodes.length; i++) {
      const n = graph.nodes[i]!;
      if (n[1] < UPPER_TIER_Y_MIN) continue;
      if (visitedSet.has(i)) continue;
      if (!farEnough(n)) continue;
      candidates.push(i);
    }
    // Fall back to any upper-tier node if all are visited/too close.
    if (candidates.length === 0) {
      for (let i = 0; i < graph.nodes.length; i++) {
        if (graph.nodes[i]![1] >= UPPER_TIER_Y_MIN) candidates.push(i);
      }
    }
    if (candidates.length > 0) {
      chosenIdx = candidates[Math.floor(Math.random() * candidates.length)]!;
    }
  }

  // ~60% — unvisited general pick. Also the fallback for any branch above
  // that produced no candidate.
  if (chosenIdx < 0) {
    const candidates: number[] = [];
    for (let i = 0; i < graph.nodes.length; i++) {
      if (visitedSet.has(i)) continue;
      if (!farEnough(graph.nodes[i]!)) continue;
      candidates.push(i);
    }
    if (candidates.length === 0) {
      // All near or all visited — fall through to any non-self node.
      for (let i = 0; i < graph.nodes.length; i++) candidates.push(i);
    }
    chosenIdx = candidates[Math.floor(Math.random() * candidates.length)]!;
  }

  // Remember the pick so subsequent rolls avoid it (LRU ring).
  const next = (bot.botVisitedRecent = bot.botVisitedRecent ?? []);
  next.push(chosenIdx);
  while (next.length > VISITED_MEMORY) next.shift();
  return graph.nodes[chosenIdx] ?? null;
};

// Drive a bot one tick: pick state, plan path if needed, generate an input
// frame, and feed it through the existing applyInput pipeline so bots and
// humans share one simulation path. Returns true if the bot pressed fire
// (caller adds to pendingFire set).
export const tickBot = (
  bot: ServerPlayer,
  others: readonly ServerPlayer[],
  now: number,
  profile: BotProfile,
): boolean => {
  if (!bot.alive) {
    bot.botState = 'dead';
    bot.botPath = [];
    bot.botPathIdx = 0;
    bot.botTargetId = null;
    return false;
  }
  if (bot.botState === 'dead' || bot.botState === undefined) {
    bot.botState = 'patrol';
    bot.botPath = undefined;
    bot.botPathIdx = 0;
  }
  // Lean-arrival check: if /tools/lean_wall set a target and we've now
  // pathed to it, snap our facing to the precomputed back-to-wall yaw and
  // apply the pose. The next tick the inCommittedPose early-return below
  // freezes us in the lean. Runs BEFORE the committed-pose check so we
  // can transition into the pose this same tick.
  if (bot.botLeanTarget) {
    const dx = bot.position[0] - bot.botLeanTarget.position[0];
    const dz = bot.position[2] - bot.botLeanTarget.position[2];
    if (Math.hypot(dx, dz) < BOT.waypointArriveDist) {
      bot.yaw = bot.botLeanTarget.yaw;
      setPose(bot, 'lean_wall', null, 0, now);
      bot.botLeanTarget = null;
      bot.botPath = undefined;
      bot.botGoal = null;
      return false;
    }
  }

  // Committed-pose bot — sitting, lying, leaning, dancing. Skip patrol pathing
  // so the NPC stays where the agent placed it. Casual_idle is the default
  // for everyone now and is NOT a freeze — a casual NPC still patrols and
  // walks around, just with relaxed animations. Combat hostility still clears
  // pose via clearPose() inside the damage path, so a posed bot CAN be
  // re-engaged without special-casing it here.
  const inCommittedPose =
    bot.pose !== null && bot.pose !== 'casual_idle';
  if (inCommittedPose || bot.poseTransition !== null) {
    bot.botPath = undefined;
    bot.botGoal = null;
    return false;
  }

  const targetCheckDue =
    bot.botLastTargetCheckAt === undefined ||
    now - bot.botLastTargetCheckAt >= BOT.targetReacquireMs;

  let target: ServerPlayer | null = null;
  if (targetCheckDue) {
    target = findVisibleTarget(bot, others, profile.fireRangeMax, now);
    bot.botLastTargetCheckAt = now;
    bot.botTargetId = target?.id ?? bot.botTargetId ?? null;
  } else if (bot.botTargetId) {
    target = others.find((p) => p.id === bot.botTargetId && p.alive) ?? null;
  }

  // Validate LOS for the cached target (cheap LOS check refreshed on its own
  // schedule so we're not raycasting every tick mid-engage).
  let hasLOS = false;
  if (target) {
    const losCheckDue =
      bot.botLastLosCheckAt === undefined ||
      now - bot.botLastLosCheckAt >= BOT.losCheckMs;
    if (losCheckDue) {
      hasLOS = hasLineOfSight(eyePosition(bot), eyePosition(target));
      bot.botLastLosCheckAt = now;
      if (hasLOS) bot.botLastSawTargetAt = now;
    } else {
      // Best-effort: assume LOS holds between checks unless we already lost it.
      hasLOS = bot.botLastSawTargetAt !== undefined && now - bot.botLastSawTargetAt < BOT.losCheckMs * 3;
    }
  }

  // State transition.
  if (target && hasLOS) {
    if (bot.botState !== 'engage') {
      bot.botState = 'engage';
      bot.botEngagedAt = now;
      bot.botPath = undefined;
    }
  } else if (target && !hasLOS && bot.botLastSawTargetAt !== undefined) {
    if (bot.botState !== 'hunt') {
      bot.botState = 'hunt';
      bot.botGoal = target.position;
      bot.botPath = undefined;
    } else {
      bot.botGoal = target.position;
    }
  } else {
    if (bot.botState !== 'patrol') {
      bot.botState = 'patrol';
      bot.botPath = undefined;
      bot.botGoal = null;
    }
  }

  // Resolve agent-driven follow / flee targets. Engage (hostility) always
  // wins over these — combat takes precedence over a chat-induced follow.
  const followTarget =
    bot.botFollowing && bot.botState !== 'engage'
      ? others.find((p) => p.id === bot.botFollowing && p.alive) ?? null
      : null;
  const fleeingActive = bot.botFleeingFrom && bot.botFleeingFrom.until > now;
  if (bot.botFleeingFrom && !fleeingActive) bot.botFleeingFrom = null;
  const fleeFrom =
    fleeingActive && bot.botState !== 'engage'
      ? others.find((p) => p.id === bot.botFleeingFrom!.id && p.alive) ?? null
      : null;
  // Coffee run: lowest-priority agent-driven goal — overridden by engage,
  // follow, and flee, but supersedes patrol. botGoingForCoffeeUntil is a
  // wall-clock deadline (Date.now ms); arrival detection + tryDrinkCoffee
  // invocation + state-clear happens in server.ts:runTick where the
  // broadcast + alert machinery lives. The controller's only job here is
  // to make the coffee maker's navigation position the path-planning goal.
  const coffeeBound =
    bot.botGoingForCoffeeUntil !== undefined &&
    Date.now() < bot.botGoingForCoffeeUntil &&
    bot.botState !== 'engage' &&
    !followTarget &&
    !fleeFrom;

  // Plan / replan path for non-engage states.
  if (bot.botState !== 'engage') {
    const replanDue =
      bot.botLastReplanAt === undefined ||
      now - bot.botLastReplanAt >= BOT.pathReplanMs ||
      !bot.botPath ||
      bot.botPath.length === 0;
    if (replanDue) {
      let goal: Vec3 | null = null;
      if (followTarget) {
        // Hysteresis follow: discrete HOLD ↔ FOLLOWING states with separate
        // entry/exit thresholds. Eliminates the "walks backward when player
        // approaches" bug by NEVER computing a goal-on-the-player→bot-ray:
        // the goal is always either ft.position (walk to player) or
        // bot.position (stand still).
        //
        //   HOLD → FOLLOWING:  dist > followResumeDist  (~4m)
        //   FOLLOWING → HOLD:  dist ≤ followStandoffDist  (~2.5m)
        //   gap between:        whichever sub-state we were in, stay there
        //
        // On HOLD → FOLLOWING we also set followHoldUntil so the movement
        // section suppresses forward motion for a brief window — the bot
        // turns to face the player FIRST, then walks.
        const ft = followTarget;
        const dx = bot.position[0] - ft.position[0];
        const dz = bot.position[2] - ft.position[2];
        const dist = Math.hypot(dx, dz);
        if (bot.botFollowMoving) {
          if (dist <= BOT.followStandoffDist) {
            bot.botFollowMoving = false;
            bot.botFollowHoldUntil = undefined;
            goal = bot.position;
          } else {
            goal = ft.position;
          }
        } else {
          if (dist > BOT.followResumeDist) {
            bot.botFollowMoving = true;
            bot.botFollowHoldUntil = now + BOT.followResumeDelayMs;
            goal = ft.position;
          } else {
            goal = bot.position;
          }
        }
      } else if (fleeFrom) {
        // Flee: pick a node opposite the fleeing-from player.
        const ff = fleeFrom;
        const dx = bot.position[0] - ff.position[0];
        const dz = bot.position[2] - ff.position[2];
        const len = Math.hypot(dx, dz) || 1;
        const norm: Vec3 = [
          bot.position[0] + (dx / len) * 15,
          bot.position[1],
          bot.position[2] + (dz / len) * 15,
        ];
        goal = norm;
      } else if (bot.botLeanTarget) {
        // Walk to the precomputed lean spot. On arrival the top-of-tick
        // check applies pose='lean_wall' and clears this field.
        goal = bot.botLeanTarget.position;
      } else if (coffeeBound) {
        goal = COFFEE_NAV_POSITION;
      } else if (bot.botState === 'hunt' && bot.botGoal) {
        goal = bot.botGoal;
      } else if (bot.botGoal) {
        goal = bot.botGoal;
      } else {
        // Exploration: weighted pick (unvisited / upper-tier / long expedition)
        // so bots don't just oscillate near spawn. Falls back to the basic
        // random-patrol if the graph is empty.
        goal = pickExplorationGoal(bot) ?? randomPatrolGoal(bot.position);
      }
      bot.botGoal = goal;
      const path = planPath(bot.position, goal);
      if (path === null) {
        // No route to this goal — drop it and let the next tick pick a new
        // one. Steering toward an unreachable point just wedges the bot.
        bot.botGoal = null;
        bot.botPath = undefined;
        bot.botPathIdx = 0;
      } else {
        bot.botPath = path;
        bot.botPathIdx = 0;
      }
      bot.botLastReplanAt = now;
    }
    advancePathIfArrived(bot);
  }

  // Voice-conversation freeze: if a player has an active ConvAI session
  // with this NPC and the NPC is not in engage AND not actively following
  // or fleeing or coffee-bound (those tools are themselves conversation
  // outputs), the NPC freezes and faces the player. Movement tools
  // override the freeze because the conversation just asked the NPC to MOVE.
  const conversingWith =
    bot.botConversationWith &&
    bot.botState !== 'engage' &&
    !followTarget &&
    !fleeFrom &&
    !coffeeBound
      ? others.find((p) => p.id === bot.botConversationWith && p.alive) ?? null
      : null;

  // Compute desired facing direction.
  let desiredYaw = bot.yaw;
  let desiredPitch = bot.pitch;
  if (bot.botState === 'engage' && target) {
    const aim = yawPitchToward(eyePosition(bot), eyePosition(target));
    desiredYaw = aim.yaw + jitter(profile.aimJitterRad);
    desiredPitch = aim.pitch + jitter(profile.aimJitterRad);
  } else if (conversingWith) {
    const aim = yawPitchToward(eyePosition(bot), eyePosition(conversingWith));
    desiredYaw = aim.yaw;
    desiredPitch = aim.pitch;
  } else {
    const next = currentWaypoint(bot);
    if (next) {
      const aim = yawPitchToward(bot.position, next);
      desiredYaw = aim.yaw;
      desiredPitch = 0;
    }
  }
  // Slew limits keep bots from snapping instantly onto a target.
  const dtSec = TICK_MS / 1000;
  const yaw = slewAngle(bot.yaw, desiredYaw, profile.aimYawRateRad * dtSec);
  const pitch = slewAngle(bot.pitch, desiredPitch, profile.aimPitchRateRad * dtSec);

  // Movement: pick a steering goal, decompose into forward/right relative to
  // the bot's CURRENT yaw (slewed value), so it can strafe-while-facing-target.
  let forward = 0;
  let right = 0;
  let sprint = false;
  let jump = false;

  const now2 = now;
  if (bot.botState === 'engage' && target) {
    const distToTarget = horizDist(bot.position, target.position);
    if (distToTarget < profile.fireRangeMin) {
      // Too close — back-pedal.
      const back = subtract(bot.position, target.position);
      const fr = decomposeMovement(back, yaw);
      forward = clamp(fr.forward, -1, 1);
      right = clamp(fr.right, -1, 1);
    } else {
      // Lazy strafe: flip direction every ~700ms so we're not a stationary
      // duck. Fed entirely as `right` input; forward stays 0 unless we want
      // to close.
      if (bot.botStrafeFlipAt === undefined || now2 >= bot.botStrafeFlipAt) {
        bot.botStrafeSign = bot.botStrafeSign === 1 ? -1 : 1;
        if (bot.botStrafeSign === undefined || bot.botStrafeSign === 0) bot.botStrafeSign = 1;
        bot.botStrafeFlipAt = now2 + 600 + Math.random() * 400;
      }
      right = bot.botStrafeSign ?? 1;
      // Light forward press if target is far inside max range.
      if (distToTarget > profile.fireRangeMax * 0.7) forward = 0.5;
    }
  } else {
    const next = currentWaypoint(bot);
    if (next) {
      const distToWaypoint = horizDist(bot.position, next);
      // Force-sprint overrides the distance gate so /tools/sprint_patrol
      // makes the bot sprint between every waypoint, not just far ones.
      // Doesn't apply to lean — sprinting into a wall mid-lean reads as
      // chaotic. Doesn't apply to follow — already governed by its own
      // state machine.
      sprint =
        bot.botForceSprint === true && !bot.botLeanTarget && !followTarget
          ? true
          : distToWaypoint > BOT.sprintWhenFurtherThan;
      const dir = subtract(next, bot.position);
      const fr = decomposeMovement(dir, yaw);
      forward = clamp(fr.forward, -1, 1);
      right = clamp(fr.right, -1, 1);
    }
  }

  // Conversation override wins over patrol movement (but not over engage —
  // hostility-driven combat already took precedence above).
  if (conversingWith) {
    forward = 0;
    right = 0;
    sprint = false;
    jump = false;
  }

  // Follow turn-first delay: when transitioning HOLD → FOLLOWING the replan
  // block sets botFollowHoldUntil. Until it expires, suppress forward motion
  // so the bot rotates toward the player (yaw slew still runs because the
  // goal/path are already in place), then starts walking. Doesn't apply
  // during engage — combat overrides this window.
  if (
    bot.botState !== 'engage' &&
    bot.botFollowHoldUntil !== undefined &&
    now < bot.botFollowHoldUntil
  ) {
    forward = 0;
    right = 0;
    sprint = false;
  }

  // Stuck detection: if we're meant to be moving and we're crawling, jump and
  // force a replan. The doorways are tight; an occasional nudge unwedges the
  // bot from a wall corner.
  const wantsToMove = forward !== 0 || right !== 0;
  const speed2D = Math.hypot(bot.velocity[0], bot.velocity[2]);
  if (wantsToMove && speed2D < BOT.stuckSpeed) {
    if (bot.botStuckSince === undefined) bot.botStuckSince = now;
    if (now - (bot.botStuckSince ?? now) >= BOT.stuckMs) {
      jump = true;
      bot.botPath = undefined;
      bot.botStuckSince = undefined;
    }
  } else {
    bot.botStuckSince = undefined;
  }

  // Reload when ammo is low and we're not actively shooting.
  const wantsReload =
    !bot.reloading &&
    bot.ammo <= BOT.reloadAmmoThreshold &&
    bot.botState !== 'engage';

  // Fire when in engage, target visible, reaction delay elapsed, ammo > 0, not reloading.
  let fire = false;
  if (
    bot.botState === 'engage' &&
    target &&
    hasLOS &&
    !bot.reloading &&
    bot.ammo > 0 &&
    bot.botEngagedAt !== undefined &&
    now - bot.botEngagedAt >= profile.engageReachMs
  ) {
    // Aim must actually be on target — don't fire before slew lands.
    const aimDir = directionFromYawPitch(yaw, pitch);
    const toTarget = subtract(eyePosition(target), eyePosition(bot));
    const len = Math.hypot(toTarget[0], toTarget[1], toTarget[2]);
    if (len > 1e-4) {
      const dot =
        (aimDir[0] * toTarget[0] +
          aimDir[1] * toTarget[1] +
          aimDir[2] * toTarget[2]) /
        len;
      if (dot > profile.fireAimDotMin) {
        // Easy bots randomly skip on-target ticks so the player has breathing
        // room even after a clean lock-on.
        if (profile.fireDropoutChance <= 0 || Math.random() >= profile.fireDropoutChance) {
          fire = true;
        }
      }
    }
  }

  // Build the input frame and route it through the same pipeline humans use.
  const seq = (bot.botInputSeq ?? 0) + 1;
  bot.botInputSeq = seq;
  const frame: InputFrame = {
    seq,
    dtMs: TICK_MS,
    forward,
    right,
    jump,
    // Server already demotes sprint+fire to walk+fire — trusting the existing
    // rule rather than re-implementing it here.
    sprint: sprint && !fire,
    fire,
    reload: wantsReload,
    interact: false,
    yaw,
    pitch,
    // Bots don't have a camera; server falls back to eye + yaw/pitch when
    // these are null. (No third-person parallax problem to solve.)
    aimOrigin: null,
    aim: null,
  };
  applyInput(bot, frame, now);
  return fire;
};

const currentWaypoint = (bot: ServerPlayer): Vec3 | null => {
  if (!bot.botPath || bot.botPath.length === 0) return null;
  const idx = Math.min(bot.botPathIdx ?? 0, bot.botPath.length - 1);
  return bot.botPath[idx]!;
};

const advancePathIfArrived = (bot: ServerPlayer): void => {
  if (!bot.botPath || bot.botPath.length === 0) return;
  let idx = bot.botPathIdx ?? 0;
  while (idx < bot.botPath.length) {
    const wp = bot.botPath[idx]!;
    if (horizDist(bot.position, wp) > BOT.waypointArriveDist) break;
    idx += 1;
  }
  bot.botPathIdx = idx;
  if (idx >= bot.botPath.length) {
    // Reached the end — clear so we plan a new patrol next tick.
    bot.botPath = undefined;
    bot.botPathIdx = 0;
    bot.botGoal = null;
  }
};

const decomposeMovement = (
  worldDir: Vec3,
  yaw: number,
): { forward: number; right: number } => {
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  // Inverse of sim.ts movement: vx = -sin*fwd + cos*right, vz = -cos*fwd - sin*right.
  // Solving for fwd/right given a target world vector (dx, dz):
  const dx = worldDir[0];
  const dz = worldDir[2];
  const len = Math.hypot(dx, dz);
  if (len < 1e-4) return { forward: 0, right: 0 };
  const nx = dx / len;
  const nz = dz / len;
  const forward = -sy * nx - cy * nz;
  const right = cy * nx - sy * nz;
  return { forward, right };
};

const subtract = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];

const horizDist = (a: Vec3, b: Vec3): number => {
  const dx = a[0] - b[0];
  const dz = a[2] - b[2];
  return Math.sqrt(dx * dx + dz * dz);
};

const clamp = (v: number, lo: number, hi: number): number =>
  v < lo ? lo : v > hi ? hi : v;

// Crude approximation of a Gaussian by averaging two uniform draws — enough
// noise to make bots not feel like aimbots.
const jitter = (amount: number): number => {
  const u = (Math.random() + Math.random()) / 2 - 0.5;
  return u * 2 * amount;
};

// Exposed for spawn-time setup — keeps bot fire-rate matched to humans by
// forcing an initial gap on join.
export const ensureBotDefaults = (bot: ServerPlayer, now: number): void => {
  bot.botState = 'patrol';
  bot.botPath = undefined;
  bot.botPathIdx = 0;
  bot.botGoal = null;
  bot.botTargetId = null;
  bot.botLastReplanAt = undefined;
  bot.botLastTargetCheckAt = undefined;
  bot.botLastLosCheckAt = undefined;
  bot.botLastSawTargetAt = undefined;
  bot.botEngagedAt = undefined;
  bot.botInputSeq = 0;
  bot.botStuckSince = undefined;
  bot.botStrafeSign = 1;
  bot.botStrafeFlipAt = now;
  bot.botVisitedRecent = [];
  // Treat the join time as integration baseline so integrateIdle doesn't
  // immediately deluge gravity into them on tick 1.
  bot.lastIntegratedAt = now;
  // Sanity: full ammo so we don't get an instant-reload on spawn.
  bot.ammo = WEAPON.magazineSize;
  bot.health = PLAYER.maxHealth;
};
