import { Billboard, Text, useGLTF } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import { useMemo, useRef, useState } from 'react';
import { Group, Mesh, RingGeometry } from 'three';
import { COFFEE, COFFEE_WORLD_POSITION } from '@slipstream-npc/shared';
import { getInteractHoldProgress, getPredictedState } from './local-state.js';

const COFFEE_MAKER_URL = '/models/CoffeeMaker.glb';
useGLTF.preload(COFFEE_MAKER_URL);

// Coffee-maker mesh anchored at COFFEE_WORLD_POSITION. Exported from the
// Blender source with its world transform zeroed so we position it cleanly
// from the shared constant — the same constant the server's tryDrinkCoffee
// proximity check uses, so the visible mesh and the interaction radius can't
// drift apart.
const CoffeeMakerMesh = () => {
  const { scene } = useGLTF(COFFEE_MAKER_URL);
  return <primitive object={scene} position={COFFEE_WORLD_POSITION} />;
};

const RING_INNER = 0.16;
const RING_OUTER = 0.22;
const RING_SEGMENTS = 48;

// Floating "[E / Y] Drink" prompt + hold-progress ring anchored above the
// coffee maker. Visible only while the local player is inside
// COFFEE.interactRadius. The ring fills clockwise as the player holds the
// interact button; once full, input.ts fires the discrete interact press.
const InteractHint = () => {
  const groupRef = useRef<Group>(null);
  const ringMeshRef = useRef<Mesh>(null);
  const [inRange, setInRange] = useState(false);
  const labelPosition = useMemo(
    () =>
      [
        COFFEE_WORLD_POSITION[0],
        COFFEE_WORLD_POSITION[1] + 0.9,
        COFFEE_WORLD_POSITION[2],
      ] as [number, number, number],
    [],
  );
  const ringGeom = useMemo(
    () => new RingGeometry(RING_INNER, RING_OUTER, RING_SEGMENTS, 1, 0, 0.0001),
    [],
  );

  useFrame(() => {
    const me = getPredictedState();
    const dx = me.position[0] - COFFEE_WORLD_POSITION[0];
    const dy = me.position[1] - COFFEE_WORLD_POSITION[1];
    const dz = me.position[2] - COFFEE_WORLD_POSITION[2];
    const dist = Math.hypot(dx, dy, dz);
    setInRange(dist <= COFFEE.interactRadius);

    // Rebuild the ring's theta-length each frame to match hold progress.
    // RingGeometry isn't parametric per-frame, so we swap a fresh geometry
    // on the mesh ref — RingGeometry is cheap (a few dozen triangles).
    const ring = ringMeshRef.current;
    if (!ring) return;
    const p = getInteractHoldProgress();
    if (p <= 0) {
      ring.visible = false;
      return;
    }
    ring.visible = true;
    const sweep = Math.max(0.0001, p * Math.PI * 2);
    const prev = ring.geometry;
    // Start the sweep at 12-o'clock (Math.PI/2) and fill clockwise. Three's
    // RingGeometry winds CCW, so negate the start to make the fill read as
    // clockwise from above.
    ring.geometry = new RingGeometry(RING_INNER, RING_OUTER, RING_SEGMENTS, 1, Math.PI / 2 - sweep, sweep);
    prev.dispose();
  });

  if (!inRange) return null;
  return (
    <group ref={groupRef} position={labelPosition}>
      <Billboard>
        <Text
          fontSize={0.18}
          color="#fff8cc"
          outlineWidth={0.012}
          outlineColor="#1a1500"
          anchorX="center"
          anchorY="middle"
        >
          [E / Y] Hold to drink — free coffee
        </Text>
        <mesh ref={ringMeshRef} geometry={ringGeom} position={[0, -0.25, 0]}>
          <meshBasicMaterial color="#ffd166" toneMapped={false} />
        </mesh>
      </Billboard>
    </group>
  );
};

// Composite: render the coffee-maker mesh + the floating prompt. Map.tsx only
// has to import one component for the fps_shooter branch.
export const CoffeePrompt = () => (
  <>
    <CoffeeMakerMesh />
    <InteractHint />
  </>
);
