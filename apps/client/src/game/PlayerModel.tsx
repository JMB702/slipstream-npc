import { Billboard, Text } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import { Suspense, useState } from 'react';
import { PLAYER, type CharacterId, type PlayerId, type Pose, type PoseTransition, type Vec3 } from '@slipstream-npc/shared';
import { Character } from './Character.js';
import { getLastAimedAt } from './aim-state.js';
import { useGame } from '../store.js';

// How long an enemy's nameplate stays visible after the local reticle leaves
// them. Matches the spec: tag on aim, fade out after a 3s grace.
const NAME_REVEAL_HOLD_MS = 3000;

interface Props {
  name: string;
  alive: boolean;
  health: number;
  velocity: Vec3;
  yaw: number;
  reloading: boolean;
  vaulting: boolean;
  playerId: PlayerId | null;
  isBot?: boolean;
  isFriend?: boolean;
  voiceIcon?: 'mic' | 'speaker' | null;
  characterId?: CharacterId;
  pose?: Pose;
  poseTransition?: PoseTransition;
  danceVariant?: number;
}

// Persistent "AI" badge that floats above every bot/NPC. Required by
// ElevenLabs' Disclosure Requirements: end users must be informed they're
// interacting with AI, not a human. The ConsentGate covers the upfront
// notice; this badge is the persistent-banner layer so the AI status stays
// visible during gameplay (and in screenshots / streams).
const AiBadge = () => (
  <group position={[0, 0.5, 0]}>
    <mesh>
      <planeGeometry args={[0.36, 0.16]} />
      <meshBasicMaterial color="#000000" transparent opacity={0.65} />
    </mesh>
    <Text
      position={[0, 0, 0.002]}
      fontSize={0.1}
      color="#7aa8ff"
      outlineWidth={0.008}
      outlineColor="black"
    >
      AI
    </Text>
  </group>
);

export const PlayerModel = ({
  name,
  alive,
  health,
  velocity,
  yaw,
  reloading,
  vaulting,
  playerId,
  isBot,
  isFriend,
  voiceIcon,
  characterId,
  pose,
  poseTransition,
  danceVariant,
}: Props) => {
  const myId = useGame((s) => s.myId);
  const isSelf = playerId !== null && playerId === myId;
  const showsName = alive && playerId !== null && !isSelf;
  return (
    <group>
      <Suspense fallback={<CapsuleFallback />}>
        <Character
          velocity={velocity}
          yaw={yaw}
          reloading={reloading}
          vaulting={vaulting}
          alive={alive}
          playerId={playerId}
          characterId={characterId}
          pose={pose}
          poseTransition={poseTransition}
          danceVariant={danceVariant}
        />
      </Suspense>
      {alive && (
        <Billboard position={[0, PLAYER.height / 2 + 0.35, 0]}>
          {isBot && <AiBadge />}
          {showsName && <EnemyNameLabel name={name} isFriend={!!isFriend} playerId={playerId} />}
          {voiceIcon && <VoiceGlyph kind={voiceIcon} />}
          {health < PLAYER.maxHealth && <NameplateHealthBar health={health} />}
        </Billboard>
      )}
    </group>
  );
};

const VoiceGlyph = ({ kind }: { kind: 'mic' | 'speaker' }) => {
  const color = kind === 'speaker' ? '#5fff8f' : '#3a7afe';
  const glyph = kind === 'speaker' ? '🔊' : '🎤';
  return (
    <group position={[0, 0.28, 0]}>
      <mesh>
        <circleGeometry args={[0.13, 24]} />
        <meshBasicMaterial color="#000000" transparent opacity={0.6} />
      </mesh>
      <Text
        position={[0, 0, 0.002]}
        fontSize={0.16}
        color={color}
        outlineWidth={0.01}
        outlineColor="black"
      >
        {glyph}
      </Text>
    </group>
  );
};

const EnemyNameLabel = ({
  name,
  isFriend,
  playerId,
}: {
  name: string;
  isFriend: boolean;
  playerId: PlayerId;
}) => {
  const [visible, setVisible] = useState(false);
  useFrame(() => {
    const last = getLastAimedAt(playerId);
    const should = last > 0 && performance.now() - last < NAME_REVEAL_HOLD_MS;
    if (should !== visible) setVisible(should);
  });
  if (!visible) return null;
  const color = isFriend ? '#5fff8f' : 'white';
  return (
    <Text fontSize={0.14} color={color} outlineWidth={0.012} outlineColor="black">
      {isFriend ? `● ${name}` : name}
    </Text>
  );
};

const NAMEPLATE_BAR_W = 0.9;
const NAMEPLATE_BAR_H = 0.04;

const NameplateHealthBar = ({ health }: { health: number }) => {
  const frac = Math.max(0, Math.min(1, health / PLAYER.maxHealth));
  const fillW = Math.max(0.0001, NAMEPLATE_BAR_W * frac);
  const fillX = -NAMEPLATE_BAR_W / 2 + fillW / 2;
  const color = frac > 0.6 ? '#5fff8f' : frac > 0.3 ? '#ffd060' : '#ff5050';
  return (
    <group position={[0, -0.16, 0]}>
      <mesh>
        <planeGeometry args={[NAMEPLATE_BAR_W + 0.03, NAMEPLATE_BAR_H + 0.03]} />
        <meshBasicMaterial color="#000000" transparent opacity={0.7} />
      </mesh>
      <mesh position={[0, 0, 0.001]}>
        <planeGeometry args={[NAMEPLATE_BAR_W, NAMEPLATE_BAR_H]} />
        <meshBasicMaterial color="#3a0a0a" />
      </mesh>
      <mesh position={[fillX, 0, 0.002]}>
        <planeGeometry args={[fillW, NAMEPLATE_BAR_H]} />
        <meshBasicMaterial color={color} />
      </mesh>
    </group>
  );
};

// Shown while the GLB is fetching/parsing on first mount.
const CapsuleFallback = () => (
  <mesh castShadow>
    <capsuleGeometry args={[PLAYER.radius, PLAYER.height - PLAYER.radius * 2, 8, 16]} />
    <meshStandardMaterial color="#666" />
  </mesh>
);

export const colorForId = (id: string): string => {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  const hue = h % 360;
  return `hsl(${hue}, 70%, 55%)`;
};
