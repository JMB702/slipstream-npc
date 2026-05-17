import { HOUSE_WALLS, MAPS, SCATTERED_OBSTACLES, type Obstacle } from '@slipstream-npc/shared';
import { useGame } from '../store.js';
import { CoffeePrompt } from './CoffeePrompt.js';
import { MapGltf } from './MapGltf.js';

const renderObstacle = (o: Obstacle, key: number, color: string) => (
  <mesh
    key={key}
    position={o.pos as unknown as [number, number, number]}
    castShadow
    receiveShadow
  >
    <boxGeometry args={[o.halfSize[0] * 2, o.halfSize[1] * 2, o.halfSize[2] * 2]} />
    <meshStandardMaterial color={color} />
  </mesh>
);

export const Arena = () => {
  const mapId = useGame((s) => s.activeMapId);
  const map = MAPS[mapId];
  const half = map.size / 2;

  return (
    <group>
      {mapId === 'arena' && (
        <mesh receiveShadow position={[0, 0, 0]} rotation={[-Math.PI / 2, 0, 0]}>
          <planeGeometry args={[map.size, map.size]} />
          <meshStandardMaterial color="#1a1f2e" />
        </mesh>
      )}

      {mapId === 'arena' && (
        <>
          {/* Map perimeter walls */}
          {([
            [half, 2, 0, 1, 4, map.size],
            [-half, 2, 0, 1, 4, map.size],
            [0, 2, half, map.size, 4, 1],
            [0, 2, -half, map.size, 4, 1],
          ] as const).map(([x, y, z, sx, sy, sz], i) => (
            <mesh key={i} position={[x, y, z]} castShadow receiveShadow>
              <boxGeometry args={[sx, sy, sz]} />
              <meshStandardMaterial color="#2a2f3e" />
            </mesh>
          ))}

          {HOUSE_WALLS.map((o, i) => renderObstacle(o, i, '#8a7a5c'))}
          {SCATTERED_OBSTACLES.map((o, i) => renderObstacle(o, i, '#3a4055'))}
        </>
      )}

      {mapId === 'fps_shooter' && <MapGltf id={mapId} />}
      {mapId === 'fps_shooter' && <CoffeePrompt />}

      {mapId === 'arena' && (
        <gridHelper args={[map.size, map.size, '#2a3050', '#1a2030']} position={[0, 0.01, 0]} />
      )}
    </group>
  );
};
