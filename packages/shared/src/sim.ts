import { COFFEE, PLAYER, type Obstacle } from './constants.js';
import { getActiveMap } from './maps.js';
import type { InputFrame } from './messages.js';
import type { Vec3 } from './state.js';

export interface MovableState {
  position: Vec3;
  velocity: Vec3;
  yaw: number;
  pitch: number;
  grounded: boolean;
  // Coffee-buff expiry (Date.now ms). When present and in the future, sprint
  // speed gets COFFEE.sprintMultiplier applied. Optional so plain MovableState
  // callers (tests, future props) don't have to set it.
  coffeeBuffUntil?: number;
}

export const applyMovement = (state: MovableState, input: InputFrame): MovableState => {
  const { obstacles: OBSTACLES, size: mapSize } = getActiveMap();
  const HALF_MAP = mapSize / 2;
  const yaw = input.yaw;
  const pitch = clamp(input.pitch, -Math.PI / 2 + 0.01, Math.PI / 2 - 0.01);
  const dt = Math.min(input.dtMs, 100) / 1000;

  const coffeeActive =
    state.coffeeBuffUntil !== undefined && Date.now() < state.coffeeBuffUntil;
  const sprintBoost = input.sprint && coffeeActive ? COFFEE.sprintMultiplier : 1;
  const speed = (input.sprint ? PLAYER.sprintSpeed : PLAYER.walkSpeed) * sprintBoost;
  const fwd = clamp(input.forward, -1, 1);
  const strafe = clamp(input.right, -1, 1);

  const sin = Math.sin(yaw);
  const cos = Math.cos(yaw);

  let vx = (-sin * fwd + cos * strafe) * speed;
  let vz = (-cos * fwd - sin * strafe) * speed;

  let vy = state.velocity[1];
  let grounded = state.grounded;
  if (grounded && input.jump) {
    vy = PLAYER.jumpSpeed;
    grounded = false;
  }
  vy -= PLAYER.gravity * dt;

  const r = PLAYER.radius;
  const halfH = PLAYER.height / 2;
  const floor = halfH;

  // Per-axis swept collision against AABB obstacles. Treat the player as an
  // upright cylinder (radius r, half-height halfH) — slight overlap at AABB
  // corners but cheap and good enough for an MVP. Resolving X/Y/Z separately
  // gives natural sliding along walls.

  let px = state.position[0];
  let py = state.position[1];
  let pz = state.position[2];

  // Per-axis sweep against AABBs. Returns { coord, blocked } so the caller
  // can decide whether to retry at a stepped-up Y for stair traversal.
  const sweepX = (sx: number, sy: number, sz: number, target: number) => {
    let resolved = target;
    let blocked = false;
    for (const o of OBSTACLES) {
      if (!overlapsYZ(sy, sz, o, r, halfH)) continue;
      const minX = o.pos[0] - o.halfSize[0] - r;
      const maxX = o.pos[0] + o.halfSize[0] + r;
      if (resolved > minX && resolved < maxX) {
        if (sx <= minX) resolved = minX;
        else if (sx >= maxX) resolved = maxX;
        else resolved = sx;
        blocked = true;
      }
    }
    return { coord: resolved, blocked };
  };

  const sweepZ = (sx: number, sy: number, sz: number, target: number) => {
    let resolved = target;
    let blocked = false;
    for (const o of OBSTACLES) {
      if (!overlapsXY(sx, sy, o, r, halfH)) continue;
      const minZ = o.pos[2] - o.halfSize[2] - r;
      const maxZ = o.pos[2] + o.halfSize[2] + r;
      if (resolved > minZ && resolved < maxZ) {
        if (sz <= minZ) resolved = minZ;
        else if (sz >= maxZ) resolved = maxZ;
        else resolved = sz;
        blocked = true;
      }
    }
    return { coord: resolved, blocked };
  };

  // Stair-step: when grounded, run X/Z sweeps twice — once at current py,
  // once at py + stepHeight. If the lifted pass made more progress, accept
  // it and snap py up. Stair treads within stepHeight clear the lifted
  // player; taller walls block both passes identically. Mid-air movement
  // skips the retry so jumping/falling doesn't get a free auto-step.
  const targetX = px + vx * dt;
  const xLow = sweepX(px, py, pz, targetX);
  let resolvedX = xLow.coord;
  let stepUpY = py;
  if (xLow.blocked) {
    if (grounded) {
      const liftedPy = py + PLAYER.stepHeight;
      const xHigh = sweepX(px, liftedPy, pz, targetX);
      if (Math.abs(xHigh.coord - px) > Math.abs(xLow.coord - px) + 1e-4) {
        resolvedX = xHigh.coord;
        stepUpY = liftedPy;
        if (xHigh.blocked) vx = 0;
      } else {
        vx = 0;
      }
    } else {
      vx = 0;
    }
  }
  px = resolvedX;

  const targetZ = pz + vz * dt;
  const zLow = sweepZ(px, stepUpY, pz, targetZ);
  let resolvedZ = zLow.coord;
  if (zLow.blocked) {
    if (grounded) {
      const liftedPy = stepUpY === py ? py + PLAYER.stepHeight : stepUpY;
      const zHigh = sweepZ(px, liftedPy, pz, targetZ);
      if (Math.abs(zHigh.coord - pz) > Math.abs(zLow.coord - pz) + 1e-4) {
        resolvedZ = zHigh.coord;
        stepUpY = liftedPy;
        if (zHigh.blocked) vz = 0;
      } else {
        vz = 0;
      }
    } else {
      vz = 0;
    }
  }
  pz = resolvedZ;
  if (stepUpY > py) py = stepUpY;

  // Y axis: gravity / jump, then floor and obstacle-top/bottom resolution
  const targetY = py + vy * dt;
  let resolvedY = targetY;
  if (resolvedY <= floor) {
    resolvedY = floor;
    vy = 0;
    grounded = true;
  } else {
    grounded = false;
  }
  for (const o of OBSTACLES) {
    if (!overlapsXZ(px, pz, o, r)) continue;
    const top = o.pos[1] + o.halfSize[1] + halfH;
    const bottom = o.pos[1] - o.halfSize[1] - halfH;
    if (resolvedY < top && resolvedY > bottom) {
      if (py >= top) {
        resolvedY = top;
        if (vy < 0) vy = 0;
        grounded = true;
      } else if (py <= bottom) {
        resolvedY = bottom;
        if (vy > 0) vy = 0;
      }
    }
  }
  py = resolvedY;

  // Map perimeter as a final safety clamp (cheap, prevents escaping if a
  // collision pass somehow misses).
  px = clamp(px, -HALF_MAP + r, HALF_MAP - r);
  pz = clamp(pz, -HALF_MAP + r, HALF_MAP - r);

  return {
    position: [px, py, pz],
    velocity: [vx, vy, vz],
    yaw,
    pitch,
    grounded,
  };
};

const overlapsYZ = (py: number, pz: number, o: Obstacle, r: number, halfH: number): boolean =>
  py > o.pos[1] - o.halfSize[1] - halfH &&
  py < o.pos[1] + o.halfSize[1] + halfH &&
  pz > o.pos[2] - o.halfSize[2] - r &&
  pz < o.pos[2] + o.halfSize[2] + r;

const overlapsXY = (px: number, py: number, o: Obstacle, r: number, halfH: number): boolean =>
  px > o.pos[0] - o.halfSize[0] - r &&
  px < o.pos[0] + o.halfSize[0] + r &&
  py > o.pos[1] - o.halfSize[1] - halfH &&
  py < o.pos[1] + o.halfSize[1] + halfH;

const overlapsXZ = (px: number, pz: number, o: Obstacle, r: number): boolean =>
  px > o.pos[0] - o.halfSize[0] - r &&
  px < o.pos[0] + o.halfSize[0] + r &&
  pz > o.pos[2] - o.halfSize[2] - r &&
  pz < o.pos[2] + o.halfSize[2] + r;

const clamp = (v: number, lo: number, hi: number): number =>
  v < lo ? lo : v > hi ? hi : v;

// Slabs method. Returns the t of the entry hit along `dir` from `origin`, or
// null if the ray misses or hits beyond `maxDist`. Pass `inflate` to grow the
// box on every axis — useful for treating the caster as a sphere of radius
// `inflate` (the inflated-AABB test is conservative at corners, which is
// exactly what we want for camera collision).
export const rayAABB = (
  origin: Vec3,
  dir: Vec3,
  o: Obstacle,
  maxDist: number,
  inflate = 0,
): number | null => {
  let tmin = 0;
  let tmax = maxDist;
  for (let axis = 0; axis < 3; axis++) {
    const min = o.pos[axis]! - o.halfSize[axis]! - inflate;
    const max = o.pos[axis]! + o.halfSize[axis]! + inflate;
    const d = dir[axis]!;
    const oo = origin[axis]!;
    if (Math.abs(d) < 1e-8) {
      if (oo < min || oo > max) return null;
      continue;
    }
    const invD = 1 / d;
    let t1 = (min - oo) * invD;
    let t2 = (max - oo) * invD;
    if (t1 > t2) {
      const tmp = t1;
      t1 = t2;
      t2 = tmp;
    }
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return null;
  }
  return tmin;
};

export const raycastObstacles = (
  origin: Vec3,
  dir: Vec3,
  maxDist: number,
  inflate = 0,
): number | null => {
  const map = getActiveMap();
  // Triangle mesh path: precise, matches the visible geometry exactly. The
  // voxelized-AABB raycast it replaces would block shots above visible wall
  // tops when the voxelizer's greedy merge extended an AABB past the mesh.
  // `inflate` is ignored on the mesh path — it only ever matters for camera
  // spring-arm collision, which still uses AABB obstacles.
  if (map.collisionTris.length > 0) {
    let best: number | null = null;
    for (const tri of map.collisionTris) {
      const t = rayTriangle(origin, dir, tri.a, tri.b, tri.c, maxDist);
      if (t !== null && (best === null || t < best)) best = t;
    }
    return best;
  }
  let best: number | null = null;
  for (const o of map.obstacles) {
    const t = rayAABB(origin, dir, o, maxDist, inflate);
    if (t !== null && (best === null || t < best)) best = t;
  }
  return best;
};

// Möller-Trumbore ray-triangle intersection. Returns the distance `t` along
// `dir` (assumed unit length) from `origin` to the front-face hit, or null
// if the ray misses, hits beyond `maxDist`, or hits the back face. Treating
// back-face hits as misses matches the AABB raycast it replaces — a shot
// fired from inside a wall shouldn't register against that wall's interior.
export const rayTriangle = (
  origin: Vec3,
  dir: Vec3,
  a: Vec3,
  b: Vec3,
  c: Vec3,
  maxDist: number,
): number | null => {
  const abx = b[0] - a[0];
  const aby = b[1] - a[1];
  const abz = b[2] - a[2];
  const acx = c[0] - a[0];
  const acy = c[1] - a[1];
  const acz = c[2] - a[2];
  const px = dir[1] * acz - dir[2] * acy;
  const py = dir[2] * acx - dir[0] * acz;
  const pz = dir[0] * acy - dir[1] * acx;
  const det = abx * px + aby * py + abz * pz;
  if (det < 1e-8) return null;
  const invDet = 1 / det;
  const tvx = origin[0] - a[0];
  const tvy = origin[1] - a[1];
  const tvz = origin[2] - a[2];
  const u = (tvx * px + tvy * py + tvz * pz) * invDet;
  if (u < 0 || u > 1) return null;
  const qx = tvy * abz - tvz * aby;
  const qy = tvz * abx - tvx * abz;
  const qz = tvx * aby - tvy * abx;
  const v = (dir[0] * qx + dir[1] * qy + dir[2] * qz) * invDet;
  if (v < 0 || u + v > 1) return null;
  const t = (acx * qx + acy * qy + acz * qz) * invDet;
  if (t < 0 || t > maxDist) return null;
  return t;
};

// Ray-vs-vertical-capsule. Capsule axis is along +y; the segment between
// (cx, yLow, cz) and (cx, yHigh, cz) is "fat" by `radius` in every direction
// (cylinder body + hemispherical caps at the endpoints). Returns the nearest
// non-negative t along `dir` within `maxDist`, or null. Assumes `dir` is unit.
//
// Used for player hit detection: replacing the older single-sphere-at-center
// test, which couldn't reach the head (height/2 = 0.9m above center, sphere
// radius 0.72m → top of sphere at ~1.62m, well below a 1.8m model's head).
// Vertical capsule matches the visible body shape, so down-aimed shots from
// elevation register the way the player expects.
export const rayCapsuleVertical = (
  origin: Vec3,
  dir: Vec3,
  cx: number,
  cz: number,
  yLow: number,
  yHigh: number,
  radius: number,
  maxDist: number,
): number | null => {
  let best: number | null = null;

  // 1) Cylinder body. Solve in the x/z plane; ignore y for the quadratic, then
  //    verify the hit-point's y lies within the segment range.
  const ox = origin[0] - cx;
  const oz = origin[2] - cz;
  const dx = dir[0];
  const dz = dir[2];
  const a = dx * dx + dz * dz;
  if (a > 1e-9) {
    const halfB = ox * dx + oz * dz;
    const c = ox * ox + oz * oz - radius * radius;
    const disc = halfB * halfB - a * c;
    if (disc >= 0) {
      const sq = Math.sqrt(disc);
      const t = (-halfB - sq) / a;
      if (t >= 0 && t <= maxDist) {
        const yHit = origin[1] + t * dir[1];
        if (yHit >= yLow && yHit <= yHigh) {
          best = t;
        }
      }
    }
  }

  // 2) Hemispherical caps. A miss from the cylinder may still hit one of these
  //    when the ray angles steeply (up-aim or down-aim from a height delta).
  const tLow = raySphere(origin, dir, cx, yLow, cz, radius, maxDist);
  if (tLow !== null && (best === null || tLow < best)) best = tLow;
  const tHigh = raySphere(origin, dir, cx, yHigh, cz, radius, maxDist);
  if (tHigh !== null && (best === null || tHigh < best)) best = tHigh;

  return best;
};

const raySphere = (
  origin: Vec3,
  dir: Vec3,
  cx: number,
  cy: number,
  cz: number,
  radius: number,
  maxDist: number,
): number | null => {
  const ox = origin[0] - cx;
  const oy = origin[1] - cy;
  const oz = origin[2] - cz;
  const b = ox * dir[0] + oy * dir[1] + oz * dir[2];
  const c = ox * ox + oy * oy + oz * oz - radius * radius;
  const disc = b * b - c;
  if (disc < 0) return null;
  const sq = Math.sqrt(disc);
  const t = -b - sq;
  if (t < 0 || t > maxDist) return null;
  return t;
};
