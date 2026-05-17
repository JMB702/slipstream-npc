import type { Vec3 } from './state.js';

// World-space position of the coffee maker on the fps_shooter map.
//
// Derivation: the mesh was placed in Blender (Maps/Blender/FPS Shooter Map
// 01.blend) at local position [-16.67, 13.36, 2.28] in Blender's Z-up frame.
// glTF export rotates -90° about X to convert to Y-up, mapping Blender
// (X, Y, Z) → glTF (X, Z, -Y), giving scene-local [-16.67, 2.28, -13.36].
// The map's MapDef adds FPS_SHOOTER_BOUNDS.offset* = [15, 0, 15] to convert
// scene-local to world coords (sim.ts collision data is already in world
// coords; MapGltf applies the offset to align visuals). So:
//   world = [-16.67+15, 2.28+0, -13.36+15] = [-1.67, 2.28, 1.64]
// This is both the server's X/Z proximity reference and the position passed
// to <primitive> for the standalone CoffeeMaker GLB.
export const COFFEE_WORLD_POSITION: Vec3 = [-1.67, 2.28, 1.64];

// Navigation target for bots walking to the maker. Keep X/Z aligned to the
// visible maker, but use the fps_shooter walkarea/player-center height so
// line-of-sight checks do not route against the elevated mesh origin.
export const COFFEE_NAV_POSITION: Vec3 = [-1.67, 1.9, 1.64];

export const horizontalDistanceToCoffee = (position: Vec3): number => {
  const dx = position[0] - COFFEE_WORLD_POSITION[0];
  const dz = position[2] - COFFEE_WORLD_POSITION[2];
  return Math.hypot(dx, dz);
};
