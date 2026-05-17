import type { Vec3 } from '@slipstream-npc/shared';
import { getNavGraph, hasLineOfSight, nearestReachableNode } from './waypoints.js';

// A* over the small (16-node) waypoint graph. Returns a list of world-space
// positions from start → goal, or null if unreachable. Caller passes the
// bot's current position and the desired destination — we snap each end to
// the nearest reachable graph node and stitch the result.
export const planPath = (start: Vec3, goal: Vec3): Vec3[] | null => {
  // If we already have direct LOS to the goal, no graph search needed.
  if (hasLineOfSight(start, goal)) return [goal];

  const graph = getNavGraph();
  // Maps with no waypoints (or whose collision filters every grid cell) get
  // no graph-based pathing; just point straight at the goal and let the
  // movement code do its best.
  if (graph.nodes.length === 0) return [goal];
  const startIdx = nearestReachableNode(start);
  const goalIdx = nearestReachableNode(goal);
  if (startIdx < 0 || goalIdx < 0) return null;
  if (startIdx === goalIdx) {
    return [graph.nodes[startIdx]!, goal];
  }

  const nodeIdxPath = aStar(startIdx, goalIdx);
  if (nodeIdxPath === null) return null;

  const out: Vec3[] = [];
  for (const i of nodeIdxPath) out.push(graph.nodes[i]!);
  // Append the original goal so the bot finishes at the actual target spot,
  // not just the nearest waypoint.
  out.push(goal);
  return out;
};

const aStar = (startIdx: number, goalIdx: number): number[] | null => {
  const graph = getNavGraph();
  const n = graph.nodes.length;
  const goalPos = graph.nodes[goalIdx]!;
  const gScore = new Array<number>(n).fill(Infinity);
  const fScore = new Array<number>(n).fill(Infinity);
  const cameFrom = new Array<number>(n).fill(-1);
  const open = new Set<number>();

  gScore[startIdx] = 0;
  fScore[startIdx] = heuristic(graph.nodes[startIdx]!, goalPos);
  open.add(startIdx);

  while (open.size > 0) {
    let current = -1;
    let bestF = Infinity;
    for (const i of open) {
      if (fScore[i]! < bestF) {
        bestF = fScore[i]!;
        current = i;
      }
    }
    if (current === -1) return null;

    if (current === goalIdx) {
      const path: number[] = [];
      let cur = current;
      while (cur !== -1) {
        path.push(cur);
        cur = cameFrom[cur]!;
      }
      path.reverse();
      return path;
    }

    open.delete(current);
    const adj = graph.adj[current]!;
    for (const neighbor of adj) {
      const tentative = gScore[current]! + graph.cost[current]![neighbor]!;
      if (tentative < gScore[neighbor]!) {
        cameFrom[neighbor] = current;
        gScore[neighbor] = tentative;
        fScore[neighbor] = tentative + heuristic(graph.nodes[neighbor]!, goalPos);
        open.add(neighbor);
      }
    }
  }
  return null;
};

const heuristic = (a: Vec3, b: Vec3): number => {
  const dx = a[0] - b[0];
  const dz = a[2] - b[2];
  return Math.sqrt(dx * dx + dz * dz);
};

// Pick a random patrol destination from the waypoint set, excluding any node
// closer than `minDistance` to the bot's current position. Falls back to
// the bot's own position when the active map has no usable waypoints (the
// auto-generated grid can come back empty if the collision data covers
// every grid cell).
export const randomPatrolGoal = (from: Vec3, minDistance = 8): Vec3 => {
  const nodes = getNavGraph().nodes;
  if (nodes.length === 0) return from;
  const candidates: Vec3[] = [];
  for (const n of nodes) {
    const dx = n[0] - from[0];
    const dz = n[2] - from[2];
    if (dx * dx + dz * dz >= minDistance * minDistance) candidates.push(n);
  }
  const pool = candidates.length > 0 ? candidates : nodes;
  return pool[Math.floor(Math.random() * pool.length)]!;
};
