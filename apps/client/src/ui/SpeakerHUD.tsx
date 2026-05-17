import { useEffect, useMemo, useRef, useState } from 'react';
import { useFrame } from '@react-three/fiber';
import { Vector3 } from 'three';
import { useGame } from '../store.js';
import type { PlayerState, Vec3 } from '@slipstream-npc/shared';
import { getSpeakingNpcIds } from '../voice/npc-audio-playback.js';

// Top-right speaker panel. With the proximity-gated voice system removed in
// the multi-speaker redesign, you can hear another player from anywhere on
// the map — without a visual cue, the audio is disorienting. This panel
// shows a row per actively-speaking remote human, with either an offscreen
// direction arrow (when they're outside the camera frustum) or distance
// caption (always shown).
//
// Phase 1: players only. Phase 4 adds NPC rows when the decoupled NPC stack
// ships.
//
// Data sources:
//   - `voiceSpeaking` on PlayerState (server mirrors from voice_state
//     ClientMessage).
//   - Snapshot position for the directional math.
//   - The camera basis is read out of R3F via a thin <CameraProbe>
//     component since the HUD lives outside the <Canvas>.

interface SpeakerRow {
  id: string;
  name: string;
  pos: Vec3;
  speaking: boolean;
  // wall-clock ms when speaking last flipped to false; used to fade out
  // the row 1.5s after silence.
  lastSpokeAt: number;
  // 'player' or 'npc' — drives the [NPC] persona-color chip in Phase 4.
  kind: 'player' | 'npc';
}

const FADE_OUT_MS = 1500;

interface CameraBasis {
  pos: Vec3;
  forward: Vec3;
  // Inverse projection: maps world → camera-space (x right, y up, z forward).
  right: Vec3;
  up: Vec3;
}

// Lives inside <Canvas>; writes the latest camera basis to a shared ref each
// frame so the HUD (outside Canvas) can read it without re-rendering on
// every animation tick.
const cameraBasisRef: { current: CameraBasis | null } = { current: null };

// Scratch vectors reused each frame to avoid per-frame allocation churn.
const _fwd = new Vector3();
const _right = new Vector3();
const _up = new Vector3(0, 1, 0);

export const SpeakerHUDCameraProbe = () => {
  useFrame(({ camera }) => {
    camera.getWorldDirection(_fwd);
    // Right = forward × up. Three's cross() mutates lhs, so copy then cross.
    _right.copy(_fwd).cross(_up).normalize();
    cameraBasisRef.current = {
      pos: [camera.position.x, camera.position.y, camera.position.z],
      forward: [_fwd.x, _fwd.y, _fwd.z],
      right: [_right.x, _right.y, _right.z],
      up: [0, 1, 0],
    };
  });
  return null;
};

// Project a world point into the camera's screen-space direction. Returns
// `{ onscreen, angleRad, dist }`:
//  - onscreen: true if the projected point is in front of the camera
//    (forward dot delta > 0) AND within ~60deg of the forward axis (a
//    conservative frustum approximation; we don't have the real FOV here).
//  - angleRad: signed angle around the screen center, used to rotate the
//    offscreen direction arrow. 0 = up; positive = clockwise.
//  - dist: meters from camera to point.
const projectToHud = (
  basis: CameraBasis,
  worldPos: Vec3,
): { onscreen: boolean; angleRad: number; dist: number } => {
  const dx = worldPos[0] - basis.pos[0];
  const dy = worldPos[1] - basis.pos[1];
  const dz = worldPos[2] - basis.pos[2];
  const dist = Math.hypot(dx, dy, dz) || 0.0001;
  // Camera-space components.
  const fwd =
    dx * basis.forward[0] + dy * basis.forward[1] + dz * basis.forward[2];
  const right =
    dx * basis.right[0] + dy * basis.right[1] + dz * basis.right[2];
  const up = dx * basis.up[0] + dy * basis.up[1] + dz * basis.up[2];
  // Onscreen: in front, within a 60deg half-angle.
  const fwdRatio = fwd / dist;
  const onscreen = fwd > 0 && fwdRatio > 0.5;
  // Screen-space angle for the off-screen arrow. Convert (right, up) into a
  // 2D vector and atan2. atan2(right, up) gives 0 for up, positive clockwise.
  const angleRad = Math.atan2(right, up);
  return { onscreen, angleRad, dist };
};

export const SpeakerHUD = () => {
  const myId = useGame((s) => s.myId);
  const snapshots = useGame((s) => s.snapshots);
  // Track per-id last-spoke-at outside React state so the fade clock isn't
  // tied to renders.
  const lastSpokeAtRef = useRef<Map<string, number>>(new Map());
  // Render tick — bump 5x/sec to update the offscreen arrow direction. Audio
  // direction doesn't need 60fps precision; the rows feel snappy at 200ms.
  const [, setNow] = useState(0);
  useEffect(() => {
    const handle = window.setInterval(() => setNow(Date.now()), 200);
    return () => clearInterval(handle);
  }, []);

  const rows = useMemo<SpeakerRow[]>(() => {
    const snap = snapshots[snapshots.length - 1];
    if (!snap) return [];
    const out: SpeakerRow[] = [];
    const now = Date.now();
    // Phase 3+: NPC rows are driven by the audio playback module's "is a
    // chunk source currently playing for this npcId" set. Keyed by npcId
    // (e.g. 'fennel' for Vicky), looked up against snapshot positions.
    const speakingNpcSet = new Set(getSpeakingNpcIds());
    snap.players.forEach((p: PlayerState) => {
      if (p.id === myId) return;
      // Bots only surface when they have an active audio utterance — the
      // server is the source of truth for whether an NPC is speaking; bots
      // without a live chunk stream are silent.
      if (p.isBot) {
        const speaking = !!(p.npcId && speakingNpcSet.has(p.npcId));
        if (speaking) lastSpokeAtRef.current.set(p.id, now);
        const lastSpokeAt = lastSpokeAtRef.current.get(p.id) ?? 0;
        const visible = speaking || now - lastSpokeAt < FADE_OUT_MS;
        if (!visible) return;
        out.push({
          id: p.id,
          name: p.name,
          pos: p.position,
          speaking,
          lastSpokeAt,
          kind: 'npc',
        });
        return;
      }
      const speaking = p.voiceSpeaking === true;
      if (speaking) lastSpokeAtRef.current.set(p.id, now);
      const lastSpokeAt = lastSpokeAtRef.current.get(p.id) ?? 0;
      const visible = speaking || now - lastSpokeAt < FADE_OUT_MS;
      if (!visible) return;
      out.push({
        id: p.id,
        name: p.name,
        pos: p.position,
        speaking,
        lastSpokeAt,
        kind: 'player',
      });
    });
    return out;
  }, [snapshots, myId]);

  if (rows.length === 0) return null;
  const basis = cameraBasisRef.current;

  return (
    <div style={panelStyle}>
      {rows.map((r) => {
        const proj = basis ? projectToHud(basis, r.pos) : null;
        const fadeMs = r.speaking ? 0 : Date.now() - r.lastSpokeAt;
        const opacity = Math.max(0, 1 - fadeMs / FADE_OUT_MS);
        return (
          <div
            key={r.id}
            style={{
              ...rowStyle,
              opacity,
              background: r.speaking
                ? 'rgba(80, 200, 120, 0.16)'
                : 'rgba(40, 44, 52, 0.6)',
              borderLeft: r.speaking
                ? '3px solid rgb(80, 200, 120)'
                : '3px solid transparent',
            }}
          >
            <span style={micIconStyle}>🎙</span>
            <span style={nameStyle}>{r.name}</span>
            {r.kind === 'npc' && <span style={npcChipStyle}>NPC</span>}
            {proj && !proj.onscreen && (
              <span
                style={{
                  ...arrowStyle,
                  transform: `rotate(${proj.angleRad}rad)`,
                }}
                aria-label="offscreen direction"
              >
                ▲
              </span>
            )}
            {proj && (
              <span style={distStyle}>{Math.round(proj.dist)} m</span>
            )}
          </div>
        );
      })}
    </div>
  );
};

const panelStyle: React.CSSProperties = {
  position: 'fixed',
  top: 12,
  right: 12,
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  pointerEvents: 'none',
  fontFamily:
    '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", system-ui, sans-serif',
  fontSize: 13,
  color: '#e6e9ef',
  zIndex: 20,
};

const rowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '4px 10px',
  borderRadius: 6,
  minWidth: 160,
  transition: 'opacity 120ms linear, background 120ms linear',
};

const micIconStyle: React.CSSProperties = {
  fontSize: 14,
  lineHeight: 1,
};

const nameStyle: React.CSSProperties = {
  flex: 1,
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  fontWeight: 500,
};

const arrowStyle: React.CSSProperties = {
  display: 'inline-block',
  color: 'rgb(160, 220, 180)',
  fontSize: 12,
  width: 14,
  textAlign: 'center',
};

const distStyle: React.CSSProperties = {
  color: '#9aa3b2',
  fontSize: 11,
  fontVariantNumeric: 'tabular-nums',
};

const npcChipStyle: React.CSSProperties = {
  fontSize: 9,
  fontWeight: 700,
  letterSpacing: '0.06em',
  padding: '1px 5px',
  borderRadius: 4,
  background: 'rgba(168, 140, 255, 0.22)',
  color: 'rgb(196, 178, 255)',
};
