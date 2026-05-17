#!/usr/bin/env node
// Build the bot nav graph from a hand-authored Blender Walk area mesh.
//
// Reads walkarea.json (already in game-space coordinates — see
// "Walk area" object in the FPS Shooter Map .blend; baking is done from
// Blender Python so axis conversion lives there, not here). Subdivides
// triangles whose longest edge exceeds TARGET_SPACING, drops one waypoint
// per triangle at its centroid, and builds edges from triangle adjacency.
// Triangle adjacency is the load-bearing simplification: two triangles that
// share an edge in the source mesh are guaranteed walkable-connected because
// the artist drew the mesh that way.
//
// Usage: node scripts/extract-map-nav.mjs

import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..');

const SOURCE_JSON = join(REPO_ROOT, 'Maps/fps_shooter_game_arena_map_v3/walkarea.json');
const OUTPUT_TS = join(REPO_ROOT, 'packages/shared/src/maps/fps_shooter.nav.ts');

// Target spacing between waypoints. Any triangle whose longest edge is
// longer than this gets split until every sub-triangle fits. 2.5m on a
// ~700 m² surface gives ~400-500 waypoints — sparse enough that
// nearestReachableNode's LOS scan stays cheap, dense enough that A*
// produces smooth paths.
const TARGET_SPACING = 2.5;
// Capsule half-height. Walkarea verts sit at the floor surface; we lift
// waypoints to capsule center so server-side LOS / distance checks see them
// at the same height a bot's `position` reports.
const PLAYER_HALF_H = 0.9;

const src = JSON.parse(await readFile(SOURCE_JSON, 'utf8'));
console.log(
  `Loaded ${src.vertex_count} verts / ${src.triangle_count} tris  ` +
    `bounds=x[${src.game_bounds.x}] y[${src.game_bounds.y}] z[${src.game_bounds.z}]`,
);

const baseVerts = src.vertices.map((v) => [v[0], v[1], v[2]]);
const baseTris = src.triangles.map((t) => [t[0], t[1], t[2]]);

// Subdivide: each working triangle is a tuple of three vertex indices. To
// split the longest edge we add a new vertex at its midpoint, then emit two
// child triangles in its place. Children inherit parent's neighbor pointers
// through shared edges — we track adjacency by edge endpoints (sorted vert
// indices) so the post-subdivision adjacency computation stays correct.
const verts = baseVerts.slice();
const midpointCache = new Map(); // 'minIdx_maxIdx' -> midpoint vert idx
const midpoint = (a, b) => {
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  const key = `${lo}_${hi}`;
  const cached = midpointCache.get(key);
  if (cached !== undefined) return cached;
  const va = verts[a];
  const vb = verts[b];
  const m = [(va[0] + vb[0]) / 2, (va[1] + vb[1]) / 2, (va[2] + vb[2]) / 2];
  const idx = verts.length;
  verts.push(m);
  midpointCache.set(key, idx);
  return idx;
};

const edgeLen2 = (a, b) => {
  const va = verts[a];
  const vb = verts[b];
  const dx = va[0] - vb[0];
  const dy = va[1] - vb[1];
  const dz = va[2] - vb[2];
  return dx * dx + dy * dy + dz * dz;
};

const TARGET_LEN2 = TARGET_SPACING * TARGET_SPACING;

const subdivided = [];
const queue = baseTris.slice();
while (queue.length > 0) {
  const [a, b, c] = queue.pop();
  const lab = edgeLen2(a, b);
  const lbc = edgeLen2(b, c);
  const lca = edgeLen2(c, a);
  const longest = Math.max(lab, lbc, lca);
  if (longest <= TARGET_LEN2) {
    subdivided.push([a, b, c]);
    continue;
  }
  // Split the longest edge. Two children share the new midpoint with each
  // other and with the (eventual) triangle on the far side of the split edge.
  if (lab >= lbc && lab >= lca) {
    const m = midpoint(a, b);
    queue.push([a, m, c]);
    queue.push([m, b, c]);
  } else if (lbc >= lab && lbc >= lca) {
    const m = midpoint(b, c);
    queue.push([a, b, m]);
    queue.push([a, m, c]);
  } else {
    const m = midpoint(c, a);
    queue.push([a, b, m]);
    queue.push([m, b, c]);
  }
}

console.log(
  `After subdivision: ${verts.length} verts / ${subdivided.length} tris  ` +
    `(target spacing ${TARGET_SPACING} m)`,
);

// One waypoint per triangle, at centroid + capsule-half-height lift.
const waypoints = subdivided.map(([a, b, c]) => {
  const va = verts[a];
  const vb = verts[b];
  const vc = verts[c];
  return [
    (va[0] + vb[0] + vc[0]) / 3,
    (va[1] + vb[1] + vc[1]) / 3 + PLAYER_HALF_H,
    (va[2] + vb[2] + vc[2]) / 3,
  ];
});

// Adjacency via shared edges. For each undirected edge (vMin, vMax), record
// the triangle indices that contain it; pairs in that list become graph
// edges. A well-formed surface mesh has at most 2 tris per edge; mesh seams
// or T-junctions can show up as 1 or 3+, and we just take all pairings.
const edgeToTris = new Map();
const addEdge = (a, b, ti) => {
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  const key = `${lo}_${hi}`;
  let arr = edgeToTris.get(key);
  if (!arr) {
    arr = [];
    edgeToTris.set(key, arr);
  }
  arr.push(ti);
};
for (let ti = 0; ti < subdivided.length; ti++) {
  const [a, b, c] = subdivided[ti];
  addEdge(a, b, ti);
  addEdge(b, c, ti);
  addEdge(c, a, ti);
}

const edgeSet = new Set();
const edges = [];
for (const tris of edgeToTris.values()) {
  if (tris.length < 2) continue;
  for (let i = 0; i < tris.length; i++) {
    for (let j = i + 1; j < tris.length; j++) {
      const a = tris[i];
      const b = tris[j];
      const lo = Math.min(a, b);
      const hi = Math.max(a, b);
      const key = `${lo}_${hi}`;
      if (edgeSet.has(key)) continue;
      edgeSet.add(key);
      edges.push([lo, hi]);
    }
  }
}

console.log(`Graph: ${waypoints.length} waypoints, ${edges.length} edges`);

// Connectivity check: BFS from node 0 and verify every waypoint is
// reachable. A* assumes a connected graph for our use case; isolated
// pockets mean the artist left a seam unwelded.
const adj = Array.from({ length: waypoints.length }, () => []);
for (const [a, b] of edges) {
  adj[a].push(b);
  adj[b].push(a);
}
const visited = new Array(waypoints.length).fill(false);
const stack = [0];
visited[0] = true;
let visitedCount = 1;
while (stack.length > 0) {
  const cur = stack.pop();
  for (const nb of adj[cur]) {
    if (!visited[nb]) {
      visited[nb] = true;
      visitedCount += 1;
      stack.push(nb);
    }
  }
}
if (visitedCount !== waypoints.length) {
  console.warn(
    `WARNING: graph has ${waypoints.length - visitedCount} unreachable nodes ` +
      `(BFS from node 0 reached ${visitedCount}/${waypoints.length}). ` +
      `Check the source mesh for unwelded seams.`,
  );
} else {
  console.log(`Connectivity: all ${waypoints.length} nodes reachable from node 0.`);
}

const fmt = (n) => Number(n.toFixed(4));
const wpLines = waypoints.map((w) => `  [${fmt(w[0])}, ${fmt(w[1])}, ${fmt(w[2])}],`);
const edgeLines = edges.map(([a, b]) => `  [${a}, ${b}],`);

const output = `// AUTO-GENERATED by scripts/extract-map-nav.mjs — do not edit.
// Source: Maps/fps_shooter_game_arena_map_v3/walkarea.json (baked from
// Blender 'Walk area' mesh). Waypoint count tracks source-mesh density;
// edges come from triangle adjacency in the authored surface.
import type { Vec3 } from '../state.js';

export const FPS_SHOOTER_WAYPOINTS: readonly Vec3[] = [
${wpLines.join('\n')}
];

export const FPS_SHOOTER_EDGES: readonly (readonly [number, number])[] = [
${edgeLines.join('\n')}
];
`;

await writeFile(OUTPUT_TS, output);
console.log(`Wrote ${OUTPUT_TS}`);
