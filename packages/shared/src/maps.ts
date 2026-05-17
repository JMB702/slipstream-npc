import { HOUSE_WALLS, MAP, SCATTERED_OBSTACLES, type Obstacle } from './constants.js';
import { FPS_SHOOTER_BOUNDS, FPS_SHOOTER_OBSTACLES } from './maps/fps_shooter.collision.js';
import { FPS_SHOOTER_TRIS, type CollisionTri } from './maps/fps_shooter.mesh.js';
import { FPS_SHOOTER_EDGES, FPS_SHOOTER_WAYPOINTS } from './maps/fps_shooter.nav.js';
import type { Vec3 } from './state.js';

export type MapId = 'fps_shooter' | 'arena';

export interface MapDef {
  readonly id: MapId;
  readonly displayName: string;
  // Side length of the perimeter clamp box (the runtime treats this as a
  // square arena centered on the origin).
  readonly size: number;
  // Half-width of the safe random-spawn box; smaller than `size / 2` so
  // players don't spawn inside a perimeter wall.
  readonly spawnArea: number;
  readonly spawnHeight: number;
  readonly obstacles: readonly Obstacle[];
  // Precise triangle mesh used for shot raycasts when present. Movement
  // collision still uses `obstacles` (AABBs) — capsule-vs-mesh resolution is
  // a follow-up. Maps without a baked mesh leave this empty and shots fall
  // back to the AABB raycast path.
  readonly collisionTris: readonly CollisionTri[];
  // Hand-authored fixed spawn positions. When non-empty, the server picks
  // uniformly at random from this list instead of rejection-sampling a
  // random XZ in `spawnArea`. Each point should be authored to land the
  // player on a real floor with no AABB overlap.
  readonly spawnPoints: readonly Vec3[];
  // Hand-authored or grid-generated nav graph used by bot pathfinding.
  readonly waypoints: readonly Vec3[];
  readonly edges: readonly (readonly [number, number])[];
  // Translation applied to a GLTF-rendered scene so its origin matches the
  // collision data. null for procedural maps with no GLTF.
  readonly gltfOffset: readonly [number, number, number] | null;
}

const ARENA_WAYPOINTS: readonly Vec3[] = [
  [-3, MAP.spawnHeight, 3],
  [3, MAP.spawnHeight, 3],
  [-3, MAP.spawnHeight, -3],
  [3, MAP.spawnHeight, -3],
  [-3, MAP.spawnHeight, -7.5],
  [-3, MAP.spawnHeight, 0],
  [3, MAP.spawnHeight, 0],
  [0, MAP.spawnHeight, 3],
  [0, MAP.spawnHeight, -3],
  [-10, MAP.spawnHeight, 9],
  [10, MAP.spawnHeight, 9],
  [10, MAP.spawnHeight, -9],
  [-10, MAP.spawnHeight, -9],
  [-15, MAP.spawnHeight, -4],
  [13, MAP.spawnHeight, -5],
  [2, MAP.spawnHeight, 16],
];

const ARENA_EDGES: readonly (readonly [number, number])[] = [
  [0, 5], [2, 5],
  [1, 6], [3, 6],
  [0, 7], [1, 7],
  [2, 8], [3, 8],
  [2, 4],
  [4, 12], [4, 11],
  [9, 10], [10, 11], [11, 12], [12, 9],
  [12, 13], [9, 15], [10, 15], [11, 14],
  [4, 13], [4, 14],
];

// Auto-generate a roaming grid for a map: drop nodes inside the playable
// box, skip ones that intersect the supplied obstacle list, then connect
// each node to its 8 grid neighbors when both endpoints have line-of-sight.
const buildGrid = (
  obstacles: readonly Obstacle[],
  half: number,
  step: number,
  y: number,
): { waypoints: Vec3[]; edges: [number, number][] } => {
  const cells: Array<{ x: number; z: number }> = [];
  const cols = Math.floor((half * 2) / step) + 1;
  for (let r = 0; r < cols; r++) {
    for (let c = 0; c < cols; c++) {
      const x = -half + c * step;
      const z = -half + r * step;
      cells.push({ x, z });
    }
  }

  const insideObstacle = (x: number, z: number): boolean => {
    for (const o of obstacles) {
      if (
        x > o.pos[0] - o.halfSize[0] - 0.4 &&
        x < o.pos[0] + o.halfSize[0] + 0.4 &&
        y > o.pos[1] - o.halfSize[1] - 0.9 &&
        y < o.pos[1] + o.halfSize[1] + 0.9 &&
        z > o.pos[2] - o.halfSize[2] - 0.4 &&
        z < o.pos[2] + o.halfSize[2] + 0.4
      ) {
        return true;
      }
    }
    return false;
  };

  const segmentBlocked = (a: Vec3, b: Vec3): boolean => {
    const samples = 8;
    for (let s = 1; s < samples; s++) {
      const t = s / samples;
      const x = a[0] + (b[0] - a[0]) * t;
      const yy = a[1] + (b[1] - a[1]) * t;
      const z = a[2] + (b[2] - a[2]) * t;
      if (insideObstacle(x, z)) return true;
      // Check the eye height too (rough LOS for tall walls).
      if (insideObstacle(x, z) || pointBlockedAtY(x, yy, z, obstacles)) return true;
    }
    return false;
  };

  const indexOfCell: number[] = [];
  const waypoints: Vec3[] = [];
  for (const cell of cells) {
    if (insideObstacle(cell.x, cell.z)) {
      indexOfCell.push(-1);
      continue;
    }
    indexOfCell.push(waypoints.length);
    waypoints.push([cell.x, y, cell.z]);
  }

  const edges: [number, number][] = [];
  const cellAt = (r: number, c: number): number => {
    if (r < 0 || c < 0 || r >= cols || c >= cols) return -1;
    return indexOfCell[r * cols + c] ?? -1;
  };
  for (let r = 0; r < cols; r++) {
    for (let c = 0; c < cols; c++) {
      const a = cellAt(r, c);
      if (a < 0) continue;
      const neighbors = [
        cellAt(r, c + 1),
        cellAt(r + 1, c),
        cellAt(r + 1, c + 1),
        cellAt(r + 1, c - 1),
      ];
      for (const b of neighbors) {
        if (b < 0) continue;
        if (segmentBlocked(waypoints[a]!, waypoints[b]!)) continue;
        edges.push([a, b]);
      }
    }
  }
  return { waypoints, edges };
};

const pointBlockedAtY = (
  x: number,
  y: number,
  z: number,
  obstacles: readonly Obstacle[],
): boolean => {
  for (const o of obstacles) {
    if (
      x > o.pos[0] - o.halfSize[0] &&
      x < o.pos[0] + o.halfSize[0] &&
      y > o.pos[1] - o.halfSize[1] &&
      y < o.pos[1] + o.halfSize[1] &&
      z > o.pos[2] - o.halfSize[2] &&
      z < o.pos[2] + o.halfSize[2]
    ) {
      return true;
    }
  }
  return false;
};

// fps_shooter is multi-level — walkable surfaces exist at y≈1, 4, 6+. We
// probe each grid cell at every elevation and place a waypoint per "floor
// top" we find. Cross-tier edges only land when a stepHeight/ramp
// walkability check confirms a bot can actually walk between them — sheer
// cliffs and rooftop teleports get filtered out, stairs/ramps approved.
// This is what gets bots upstairs: patrol goals can land on any tier and
// A* walks them there via the discovered ramp edges.
const PLAYER_HALF_H = 0.9;
const PLAYER_STEP_HEIGHT = 0.45;

const findSurfaceYsAt = (
  x: number,
  z: number,
  obstacles: readonly Obstacle[],
  yMax: number,
): number[] => {
  // Walk Y upward in fine steps; whenever we transition from "inside an
  // obstacle" to "open air", the lower point is a walkable surface top.
  // Step size must be smaller than the thinnest walkable AABB on the map —
  // stair treads in fps_shooter are 0.25m thick, so a 0.25m sample skips
  // right past them.
  const surfaces: number[] = [];
  const step = 0.1;
  let prev = pointBlockedAtY(x, 0, z, obstacles);
  for (let y = step; y <= yMax; y += step) {
    const here = pointBlockedAtY(x, y, z, obstacles);
    if (prev && !here) surfaces.push(y - step);
    prev = here;
  }
  return surfaces;
};

const floorYAtDrop = (
  x: number,
  z: number,
  obstacles: readonly Obstacle[],
  fromY: number,
  maxDrop: number,
): number | null => {
  // Drop downward from fromY; the first obstacle we enter gives the floor.
  if (pointBlockedAtY(x, fromY, z, obstacles)) return fromY;
  const step = 0.1;
  for (let dy = step; dy <= maxDrop; dy += step) {
    const y = fromY - dy;
    if (pointBlockedAtY(x, y, z, obstacles)) return y + step;
  }
  return null;
};

const canWalkBetween = (
  a: Vec3,
  b: Vec3,
  obstacles: readonly Obstacle[],
): boolean => {
  // Sample many intermediate horizontal points; at each, drop a ray to find
  // the floor. Each consecutive floor must be within ~stepHeight of the
  // previous (auto-climb) or downhill. This approves stairs/ramps that an
  // LOS test would reject as solid geometry. Tolerates a few sample misses
  // because narrow stair treads can fall between samples.
  const samples = 20;
  // Per-step tolerance slightly larger than PLAYER.stepHeight to forgive
  // sampling alignment off real stair tread tops.
  const stepTol = 0.6;
  const aFloor = a[1] - PLAYER_HALF_H;
  const probeFromY = Math.max(a[1], b[1]) + 2.0;
  const probeDrop = probeFromY + 1.0;
  let prevFloor = aFloor;
  let missed = 0;
  for (let i = 1; i <= samples; i++) {
    const t = i / samples;
    const x = a[0] + (b[0] - a[0]) * t;
    const z = a[2] + (b[2] - a[2]) * t;
    const fy = floorYAtDrop(x, z, obstacles, probeFromY, probeDrop);
    if (fy === null) {
      missed += 1;
      if (missed > 2) return false;
      continue;
    }
    const delta = fy - prevFloor;
    if (delta > stepTol) return false;
    if (delta < -4) return false;
    prevFloor = fy;
  }
  const endFloor = b[1] - PLAYER_HALF_H;
  if (Math.abs(prevFloor - endFloor) > stepTol + 0.1) return false;
  return true;
};

const EMPTY_CELL_NODES: readonly number[] = [];

// Multi-level grid construction.
//   1. At each (x,z) grid cell, probe every Y elevation; place a waypoint on
//      every walkable floor surface discovered.
//   2. Connect same-tier waypoints (|Δy| < 0.5) via 8-neighbor LOS at the
//      shared elevation.
//   3. Connect cross-tier waypoints (|Δy| > 0.5) via a stair walkability
//      test that drops rays at intermediate samples — only succeeds when
//      consecutive floor heights are within stepHeight (real stairs/ramps).
//      Cross-tier search extends to 2-cell radius so long stair runs are
//      caught.
const buildMultiLevelGrid = (
  obstacles: readonly Obstacle[],
  half: number,
  step: number,
  yCeiling: number,
): { waypoints: Vec3[]; edges: [number, number][] } => {
  const cols = Math.floor((half * 2) / step) + 1;
  const cellNodes: number[][] = [];
  const waypoints: Vec3[] = [];
  for (let r = 0; r < cols; r++) {
    for (let c = 0; c < cols; c++) {
      const x = -half + c * step;
      const z = -half + r * step;
      const surfaces = findSurfaceYsAt(x, z, obstacles, yCeiling);
      const indices: number[] = [];
      let lastKept = -Infinity;
      for (const sy of surfaces) {
        // Collapse near-duplicate surfaces from sampling noise (one physical
        // floor reported twice within ~1m).
        if (sy - lastKept < 1.0) continue;
        // Skip surfaces where the waypoint sits inside another obstacle
        // (e.g., the cell is under a low ceiling — bot would clip).
        const wpY = sy + PLAYER_HALF_H;
        if (pointBlockedAtY(x, wpY, z, obstacles)) continue;
        indices.push(waypoints.length);
        waypoints.push([x, wpY, z]);
        lastKept = sy;
      }
      cellNodes.push(indices);
    }
  }

  const edges: [number, number][] = [];
  const seen = new Set<string>();
  const cellAt = (r: number, c: number): readonly number[] => {
    if (r < 0 || c < 0 || r >= cols || c >= cols) return EMPTY_CELL_NODES;
    return cellNodes[r * cols + c] ?? EMPTY_CELL_NODES;
  };
  const tryEdge = (a: number, b: number) => {
    if (a === b) return;
    const key = a < b ? `${a}-${b}` : `${b}-${a}`;
    if (seen.has(key)) return;
    const wa = waypoints[a]!;
    const wb = waypoints[b]!;
    const sameTier = Math.abs(wa[1] - wb[1]) < 0.5;
    const ok = sameTier
      ? !sampleSegmentBlockedAtY(wa, wb, wa[1], obstacles)
      : canWalkBetween(wa, wb, obstacles);
    if (!ok) return;
    seen.add(key);
    edges.push([a, b]);
  };

  for (let r = 0; r < cols; r++) {
    for (let c = 0; c < cols; c++) {
      const here = cellAt(r, c);
      if (here.length === 0) continue;
      // 8-neighbor (1-cell radius) — primary connectivity.
      const adjacent = [
        cellAt(r, c + 1),
        cellAt(r + 1, c),
        cellAt(r + 1, c + 1),
        cellAt(r + 1, c - 1),
      ];
      for (const a of here) {
        for (const nb of adjacent) {
          for (const b of nb) tryEdge(a, b);
        }
      }
    }
  }

  // Cross-tier stair sweep: for every waypoint that sits ABOVE the ground
  // tier, try to walkable-connect it to every other waypoint within 10m
  // horizontal. Real stairs/ramps can span this far, and the floor-tracking
  // check rejects sheer drops and ungated rooftops on its own.
  const CROSS_TIER_RADIUS = 10;
  for (let a = 0; a < waypoints.length; a++) {
    const wa = waypoints[a]!;
    // Anchor on UPPER waypoints — sweeping every ground node against every
    // other ground node would be O(N²) for no gain (those are already
    // adjacent-grid connected).
    if (wa[1] < 2.0) continue;
    for (let b = 0; b < waypoints.length; b++) {
      if (a === b) continue;
      const wb = waypoints[b]!;
      const dx = wa[0] - wb[0];
      const dz = wa[2] - wb[2];
      if (dx * dx + dz * dz > CROSS_TIER_RADIUS * CROSS_TIER_RADIUS) continue;
      if (Math.abs(wa[1] - wb[1]) < 0.5) continue;
      tryEdge(a, b);
    }
  }
  return { waypoints, edges };
};

// Sample-along-segment obstacle check at a fixed Y, mirroring the legacy
// buildGrid edge filter — used for same-tier upper edges where LOS at the
// shared elevation is what we want.
const sampleSegmentBlockedAtY = (
  a: Vec3,
  b: Vec3,
  y: number,
  obstacles: readonly Obstacle[],
): boolean => {
  const samples = 8;
  for (let s = 1; s < samples; s++) {
    const t = s / samples;
    const x = a[0] + (b[0] - a[0]) * t;
    const z = a[2] + (b[2] - a[2]) * t;
    if (pointBlockedAtY(x, y, z, obstacles)) return true;
  }
  return false;
};

// Authored in Blender (Spawn Visualization collection), audited against
// FPS_SHOOTER_OBSTACLES — every point is clear of all inflated AABBs at
// y=4 and lands on the floor at y=1.
const FPS_SHOOTER_SPAWN_POINTS: readonly Vec3[] = [
  [3.346, 4, -9.5],
  [8.862, 4, -8.762],
  [-1.419, 4, -9.5],
  [9.5, 4, 7.595],
  [-9.5, 4, -7.047],
  [5.063, 4, -4.031],
  [7.06, 4, -9.5],
  [-3.834, 4, -8.268],
  [9.5, 4, -3.922],
  [8.494, 4, 8.748],
  [0.397, 4, 9.5],
  [-4.967, 4, 4.097],
  [-8.931, 4, 8.792],
  [8.681, 4, 1.856],
  [4.472, 4, -9.5],
  [-9.247, 4, -8.884],
  [-9.576, 4, -5.329],
];

export const MAPS: Record<MapId, MapDef> = {
  fps_shooter: {
    id: 'fps_shooter',
    displayName: 'FPS Shooter Arena',
    size: Math.max(FPS_SHOOTER_BOUNDS.sizeX, FPS_SHOOTER_BOUNDS.sizeZ),
    spawnArea: Math.max(FPS_SHOOTER_BOUNDS.sizeX, FPS_SHOOTER_BOUNDS.sizeZ) / 2 - 3,
    // Spawn above the GLTF floor (top y≈0.5 at 1× scale) — gravity drops
    // the player onto whichever surface is below them. The static
    // floor=halfH clamp in sim.ts is just a safety net; the floor slab in
    // FPS_SHOOTER_OBSTACLES is what actually stops the fall.
    spawnHeight: 4,
    obstacles: FPS_SHOOTER_OBSTACLES,
    collisionTris: FPS_SHOOTER_TRIS,
    spawnPoints: FPS_SHOOTER_SPAWN_POINTS,
    waypoints: FPS_SHOOTER_WAYPOINTS,
    edges: FPS_SHOOTER_EDGES,
    gltfOffset: [
      FPS_SHOOTER_BOUNDS.offsetX,
      FPS_SHOOTER_BOUNDS.offsetY,
      FPS_SHOOTER_BOUNDS.offsetZ,
    ],
  },
  arena: {
    id: 'arena',
    displayName: 'Original Arena',
    size: MAP.size,
    spawnArea: MAP.size / 2 - 4,
    spawnHeight: MAP.spawnHeight,
    obstacles: [...HOUSE_WALLS, ...SCATTERED_OBSTACLES],
    collisionTris: [],
    spawnPoints: [],
    waypoints: ARENA_WAYPOINTS,
    edges: ARENA_EDGES,
    gltfOffset: null,
  },
};

export const DEFAULT_MAP_ID: MapId = 'fps_shooter';

export const isMapId = (v: string | null | undefined): v is MapId =>
  v === 'fps_shooter' || v === 'arena';

let active: MapDef = MAPS[DEFAULT_MAP_ID];

export const setActiveMap = (id: MapId): void => {
  active = MAPS[id];
};

export const getActiveMap = (): MapDef => active;
