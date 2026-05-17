import { useFrame } from '@react-three/fiber';
import { useRef } from 'react';
import { Group } from 'three';
import { NET, type PlayerId } from '@slipstream-npc/shared';
import { useGame } from '../store.js';
import { PlayerModel } from './PlayerModel.js';

interface Props {
  id: PlayerId;
}

// Subscribe to the latest snapshot's view of this player so React re-renders
// when alive/reloading/vaulting/etc. change. Without this, the previous
// implementation buffered everything in a ref inside useFrame — the ref
// mutation never triggered a re-render, so PlayerModel saw stale flags
// (most visibly: bots never played the Death animation because alive=true
// was frozen at first mount).
export const RemotePlayer = ({ id }: Props) => {
  const ref = useRef<Group>(null);
  const player = useGame((s) => {
    const last = s.snapshots[s.snapshots.length - 1];
    return last?.players.get(id);
  });
  const isFriend = useGame((s) => {
    const last = s.snapshots[s.snapshots.length - 1];
    const me = s.myId !== null ? last?.players.get(s.myId) : undefined;
    const them = last?.players.get(id);
    if (!me || !them) return false;
    return them.friendsWith.includes(me.name) || me.friendsWith.includes(them.name);
  });
  const voiceIcon = useGame((s) => {
    const sess = s.activeVoiceSession;
    if (!sess) return null;
    const last = s.snapshots[s.snapshots.length - 1];
    const them = last?.players.get(id);
    if (!them || them.npcId !== sess.npcId) return null;
    if (s.voiceOutputVolume <= 0.05) return null;
    return 'speaker' as const;
  });

  useFrame(() => {
    const snaps = useGame.getState().snapshots;
    if (snaps.length === 0 || !ref.current) return;

    const newest = snaps[snaps.length - 1];
    if (!newest) return;
    const renderTime = newest.serverTime - NET.interpolationDelayMs;

    let from = snaps[0]!;
    let to = newest;
    for (let i = 0; i < snaps.length - 1; i++) {
      const s0 = snaps[i];
      const s1 = snaps[i + 1];
      if (!s0 || !s1) continue;
      if (s0.serverTime <= renderTime && s1.serverTime >= renderTime) {
        from = s0;
        to = s1;
        break;
      }
    }

    const a = from.players.get(id);
    const b = to.players.get(id);
    const target = b ?? a;
    if (!target) return;

    const span = Math.max(1, to.serverTime - from.serverTime);
    const t = clamp((renderTime - from.serverTime) / span, 0, 1);

    const ax = a?.position[0] ?? target.position[0];
    const ay = a?.position[1] ?? target.position[1];
    const az = a?.position[2] ?? target.position[2];
    const bx = target.position[0];
    const by = target.position[1];
    const bz = target.position[2];

    ref.current.position.set(lerp(ax, bx, t), lerp(ay, by, t), lerp(az, bz, t));
    ref.current.rotation.y = lerpAngle(a?.yaw ?? target.yaw, target.yaw, t);
  });

  if (!player) return <group ref={ref} />;

  return (
    <group ref={ref}>
      <PlayerModel
        name={player.name}
        alive={player.alive}
        health={player.health}
        velocity={player.velocity}
        yaw={player.yaw}
        reloading={player.reloading}
        vaulting={player.vaulting}
        playerId={id}
        isBot={player.isBot}
        isFriend={isFriend}
        voiceIcon={voiceIcon}
        characterId={player.characterId}
        pose={player.pose}
        poseTransition={player.poseTransition}
        danceVariant={player.danceVariant}
      />
    </group>
  );
};

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

const lerpAngle = (a: number, b: number, t: number) => {
  let diff = b - a;
  while (diff > Math.PI) diff -= Math.PI * 2;
  while (diff < -Math.PI) diff += Math.PI * 2;
  return a + diff * t;
};

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
