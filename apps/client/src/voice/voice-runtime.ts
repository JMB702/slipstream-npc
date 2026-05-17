import type { ClientMessage } from '@slipstream-npc/shared';
import { useGame } from '../store.js';
import { isMuted, onMuteChange } from './mute.js';
import { onVadChange, setVadMuted, startVad, stopVad } from './vad.js';
import { onPeerTrack, startMesh, stopMesh, syncPeers } from './webrtc-mesh.js';
import { attachPeerStream, setPeerPosition } from './player-audio-graph.js';

// Top-level orchestrator for Phase 1 player voice. Owns three concerns:
//
//  1. VAD lifecycle. Starts the Silero-based VAD once we have mic permission;
//     emits `speaking`/`silent` transitions; sends `voice_state` ClientMessages
//     on transitions so the server can mirror them into PlayerState.
//
//  2. Mesh roster sync. Subscribes to game snapshots; computes the set of
//     remote human peers; tells webrtc-mesh to add/remove RTCPeerConnections
//     accordingly.
//
//  3. Audio routing. Pipes peer MediaStreams from the mesh into the spatial
//     audio graph, and updates each peer's PannerNode position every frame
//     from snapshot data. Listener pose is set by the Camera component
//     (Scene-side) via setListenerPose.
//
// This module is intentionally singleton — there's exactly one local mic,
// one VAD, one mesh, one audio graph per browser tab. start/stop are called
// once each by the net client on welcome/close.

let started = false;
let unsubVad: (() => void) | null = null;
let unsubMute: (() => void) | null = null;
let unsubSnapshot: (() => void) | null = null;
let unsubPeerTrack: (() => void) | null = null;
let lastSent: { speaking: boolean; mutedByVad: boolean; mutedManual: boolean } | null = null;

const sendVoiceState = (
  netSend: (msg: ClientMessage) => void,
  speaking: boolean,
): void => {
  const mutedManual = isMuted();
  const mutedByVad = !speaking && !mutedManual;
  // Debounce: only emit on transitions. The server caches into PlayerState
  // and rebroadcasts in snapshots, so resending the same state every tick
  // is pure waste.
  if (
    lastSent &&
    lastSent.speaking === speaking &&
    lastSent.mutedByVad === mutedByVad &&
    lastSent.mutedManual === mutedManual
  ) {
    return;
  }
  lastSent = { speaking, mutedByVad, mutedManual };
  netSend({ type: 'voice_state', speaking, mutedByVad, mutedManual });
};

const computePresentPeerIds = (): string[] => {
  const state = useGame.getState();
  const myId = state.myId;
  const snap = state.snapshots[state.snapshots.length - 1];
  if (!snap || !myId) return [];
  const out: string[] = [];
  for (const p of snap.players.values()) {
    if (p.isBot) continue;
    if (p.id === myId) continue;
    out.push(p.id);
  }
  return out;
};

const updatePeerPositions = (): void => {
  const state = useGame.getState();
  const myId = state.myId;
  const snap = state.snapshots[state.snapshots.length - 1];
  if (!snap || !myId) return;
  for (const p of snap.players.values()) {
    if (p.isBot || p.id === myId) continue;
    setPeerPosition(p.id, p.position);
  }
};

export const startVoiceRuntime = async (
  myId: string,
  netSend: (msg: ClientMessage) => void,
): Promise<void> => {
  if (started) return;
  started = true;

  try {
    await startMesh(myId, netSend);
  } catch (err) {
    console.warn('[voice] mesh start failed:', err);
  }

  // Start VAD asynchronously — mic permission flow may take a moment, and
  // mesh peer connections already work without VAD output. If permission
  // is denied or the model fails to load, mesh stays alive but VAD output
  // is permanently silent (matches "user has no mic" UX).
  void startVad();

  unsubVad = onVadChange((speaking) => {
    sendVoiceState(netSend, speaking);
  });

  unsubMute = onMuteChange((muted) => {
    setVadMuted(muted);
    sendVoiceState(netSend, false);
  });

  // Snapshot subscription drives both the mesh roster and the panner
  // positions. Subscribe to the slice that changes on every snapshot.
  unsubSnapshot = useGame.subscribe((state, prev) => {
    if (state.snapshots === prev.snapshots) return;
    void syncPeers(computePresentPeerIds());
    updatePeerPositions();
  });

  unsubPeerTrack = onPeerTrack((peerId, stream) => {
    attachPeerStream(peerId, stream);
  });

  // Initial sync — covers the case where myId arrives AFTER the first
  // snapshot (welcome can come after snapshot in some race orderings).
  void syncPeers(computePresentPeerIds());
};

export const stopVoiceRuntime = (): void => {
  if (!started) return;
  started = false;
  unsubVad?.();
  unsubMute?.();
  unsubSnapshot?.();
  unsubPeerTrack?.();
  unsubVad = unsubMute = unsubSnapshot = unsubPeerTrack = null;
  lastSent = null;
  stopVad();
  stopMesh();
};
