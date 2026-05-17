import type { ClientMessage, ServerMessage, WebRtcSignal } from '@slipstream-npc/shared';
import { getMicStream } from './mic.js';

// WebRTC peer mesh for player voice. PartyKit relays signaling (SDP + ICE)
// between peers; the audio itself flows peer-to-peer with no SFU.
//
// Each peer maintains one RTCPeerConnection per other human in the room. We
// use the MDN "perfect negotiation" pattern to avoid offer/answer races:
// the peer with the lexicographically smaller id is "impolite" (initiates
// renegotiation, ignores incoming offers that collide). The other is
// "polite" (rolls back its local description and accepts the incoming
// offer). This handles both peers trying to negotiate at the same instant.
//
// O(N²) bandwidth — fine for ≤4 players. The swap-to-SFU cliff is
// documented in CLAUDE.md and the workbook (F12 backlog).

const STUN_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
];

export type PeerTrackListener = (peerId: string, stream: MediaStream | null) => void;

interface Peer {
  pc: RTCPeerConnection;
  // "polite" peer rolls back on glare. Determined by id comparison.
  polite: boolean;
  // Perfect-negotiation flags from the MDN reference.
  makingOffer: boolean;
  ignoreOffer: boolean;
  // Each peer's incoming remote stream. Created lazily when an ontrack
  // event fires; passed to the audio-graph layer for spatial playback.
  remoteStream: MediaStream | null;
}

const peers = new Map<string, Peer>();
const trackListeners = new Set<PeerTrackListener>();
let localId: string | null = null;
let send: ((msg: ClientMessage) => void) | null = null;
let localStream: MediaStream | null = null;
let started = false;

export const onPeerTrack = (l: PeerTrackListener): (() => void) => {
  trackListeners.add(l);
  return () => trackListeners.delete(l);
};

// Diagnostic snapshot for the in-game VoiceDebug widget. Returns a compact
// view of every peer's RTC + ICE state plus whether a remote audio track
// has actually arrived. Cheap — just reads RTCPeerConnection getters.
export interface MeshPeerInfo {
  peerId: string;
  polite: boolean;
  connectionState: RTCPeerConnectionState;
  iceConnectionState: RTCIceConnectionState;
  hasRemoteStream: boolean;
}
export const getMeshState = (): { started: boolean; peers: MeshPeerInfo[] } => ({
  started,
  peers: Array.from(peers.entries()).map(([peerId, p]) => ({
    peerId,
    polite: p.polite,
    connectionState: p.pc.connectionState,
    iceConnectionState: p.pc.iceConnectionState,
    hasRemoteStream: p.remoteStream !== null,
  })),
});

const emitTrack = (peerId: string, stream: MediaStream | null): void => {
  for (const l of trackListeners) l(peerId, stream);
};

const createPeer = (peerId: string): Peer => {
  // Tie-break: whichever side has the lexicographically larger id is the
  // polite peer. Symmetric across both sides because both run the same code.
  const polite = (localId ?? '') < peerId;
  const pc = new RTCPeerConnection({ iceServers: STUN_SERVERS });
  const peer: Peer = { pc, polite, makingOffer: false, ignoreOffer: false, remoteStream: null };

  // Attach the local mic so the SDP describes a sendrecv audio transceiver.
  if (localStream) {
    for (const t of localStream.getAudioTracks()) pc.addTrack(t, localStream);
  }

  pc.onnegotiationneeded = async () => {
    try {
      peer.makingOffer = true;
      await pc.setLocalDescription();
      if (pc.localDescription && send) {
        send({
          type: 'webrtc_signal',
          to: peerId,
          signal: {
            sdp: {
              type: pc.localDescription.type as 'offer' | 'answer',
              sdp: pc.localDescription.sdp,
            },
          },
        });
      }
    } catch (err) {
      console.warn(`[mesh] negotiation to ${peerId} failed:`, err);
    } finally {
      peer.makingOffer = false;
    }
  };

  pc.onicecandidate = ({ candidate }) => {
    if (!send) return;
    send({
      type: 'webrtc_signal',
      to: peerId,
      signal: {
        ice: candidate
          ? {
              candidate: candidate.candidate,
              sdpMid: candidate.sdpMid,
              sdpMLineIndex: candidate.sdpMLineIndex,
            }
          : null,
      },
    });
  };

  pc.ontrack = (ev) => {
    const stream = ev.streams[0] ?? new MediaStream([ev.track]);
    peer.remoteStream = stream;
    console.log(`[mesh] ontrack from ${peerId}, kind=${ev.track.kind}`);
    emitTrack(peerId, stream);
  };

  pc.onconnectionstatechange = () => {
    console.log(`[mesh] peer ${peerId} connectionState=${pc.connectionState}`);
    // Hard-failed peer: drop and let the next snapshot diff re-add it. Browser
    // doesn't recover from "failed" without manual restartIce; cheaper to
    // tear down and remake.
    if (pc.connectionState === 'failed') {
      removePeer(peerId);
    }
  };

  pc.oniceconnectionstatechange = () => {
    console.log(`[mesh] peer ${peerId} iceConnectionState=${pc.iceConnectionState}`);
  };

  peers.set(peerId, peer);
  console.log(`[mesh] created peer ${peerId} (polite=${polite})`);
  return peer;
};

const removePeer = (peerId: string): void => {
  const peer = peers.get(peerId);
  if (!peer) return;
  try {
    peer.pc.close();
  } catch {
    // already closed
  }
  peers.delete(peerId);
  emitTrack(peerId, null);
};

export const handleSignalFromPeer = async (
  peerId: string,
  signal: WebRtcSignal,
): Promise<void> => {
  let peer = peers.get(peerId);
  if (!peer) peer = createPeer(peerId);
  const { pc } = peer;

  try {
    if ('sdp' in signal) {
      const offerCollision =
        signal.sdp.type === 'offer' &&
        (peer.makingOffer || pc.signalingState !== 'stable');
      peer.ignoreOffer = !peer.polite && offerCollision;
      if (peer.ignoreOffer) return;
      await pc.setRemoteDescription(signal.sdp);
      if (signal.sdp.type === 'offer') {
        await pc.setLocalDescription();
        if (pc.localDescription && send) {
          send({
            type: 'webrtc_signal',
            to: peerId,
            signal: {
              sdp: {
                type: pc.localDescription.type as 'offer' | 'answer',
                sdp: pc.localDescription.sdp,
              },
            },
          });
        }
      }
    } else if ('ice' in signal) {
      if (signal.ice === null) {
        // End-of-candidates marker — Chrome emits one with empty candidate
        // string; addIceCandidate(null) is well-defined.
        try {
          await pc.addIceCandidate(undefined);
        } catch {
          // ignore
        }
        return;
      }
      try {
        await pc.addIceCandidate(signal.ice);
      } catch (err) {
        if (!peer.ignoreOffer) console.warn(`[mesh] addIceCandidate from ${peerId}:`, err);
      }
    }
  } catch (err) {
    console.warn(`[mesh] handleSignalFromPeer ${peerId} threw:`, err);
  }
};

// Sync the peer mesh to the current room roster. Called after every snapshot
// from voice-runtime. `presentPeerIds` is the set of human players in the
// room excluding the local player. Peers in the set without a connection
// get one; peers that vanished get torn down.
export const syncPeers = async (presentPeerIds: readonly string[]): Promise<void> => {
  if (!started) return;
  const present = new Set(presentPeerIds);
  // Remove peers that left.
  for (const id of Array.from(peers.keys())) {
    if (!present.has(id)) removePeer(id);
  }
  // Add peers that joined. The impolite side will trigger negotiationneeded
  // as soon as we addTrack via createPeer; the polite side waits for the
  // offer to arrive. Either way both sides converge.
  for (const id of present) {
    if (peers.has(id)) continue;
    createPeer(id);
  }
};

export const startMesh = async (
  myId: string,
  netSend: (msg: ClientMessage) => void,
): Promise<void> => {
  if (started) return;
  localId = myId;
  send = netSend;
  localStream = await getMicStream();
  started = true;
};

export const stopMesh = (): void => {
  for (const id of Array.from(peers.keys())) removePeer(id);
  started = false;
  send = null;
  localId = null;
  localStream = null;
};

// Hook for the net client's dispatch. Called when a webrtc_signal ServerMessage
// arrives. Synchronous wrapper around the async handler since the dispatcher
// is a switch statement and doesn't await.
export const onServerSignal = (msg: Extract<ServerMessage, { type: 'webrtc_signal' }>): void => {
  void handleSignalFromPeer(msg.from, msg.signal);
};
