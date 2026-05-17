import type { GameEvent, GameSnapshot, PlayerId, Pose, PoseTransition } from './state.js';
import type { Vec3 } from './state.js';

export interface InputFrame {
  seq: number;
  dtMs: number;
  forward: number;
  right: number;
  jump: boolean;
  sprint: boolean;
  fire: boolean;
  reload: boolean;
  // Rising-edge "use the thing in front of me" press. Server checks proximity
  // to interactable props (currently just the coffee maker on fps_shooter).
  interact: boolean;
  yaw: number;
  pitch: number;
  // Camera-resolved aim. Sent on every frame, but it's the per-fire-input
  // aim that matters: the server fires from `aimOrigin` toward `aim`, NOT
  // from the player's eye along yaw/pitch. Avoids the third-person camera-
  // vs-eye parallax bug where the camera (which sits behind+above the
  // player) sees over a ledge but the eye is occluded by it; reticle says
  // "clear shot" but the server saw a wall.
  //
  // Both null → server falls back to eye-from-yaw/pitch (older clients,
  // bots, or any frame the client couldn't compute a camera ray for).
  aimOrigin: Vec3 | null;
  aim: Vec3 | null;
}

export interface TranscriptLine {
  role: 'user' | 'agent';
  text: string;
  at: number;
  // True when this line is an `agent_response_correction` event from
  // ElevenLabs — a server-side rewrite of the last agent_response. The
  // client store uses this flag to REPLACE the last agent turn rather
  // than appending, so the transcript doesn't show "Mira repeated herself"
  // when the SDK streams a partial first and a fuller correction second.
  correction?: boolean;
}

// WebRTC signaling payload. The server is a dumb relay between two peers;
// neither side inspects the SDP/ICE contents. Either `sdp` or `ice` is set
// on a given message but not both. `to`/`from` are PartyKit connection ids.
export type WebRtcSignal =
  | { sdp: { type: 'offer' | 'answer'; sdp: string } }
  | { ice: { candidate: string; sdpMid: string | null; sdpMLineIndex: number | null } | null };

export type ClientMessage =
  | { type: 'hello'; name: string }
  | { type: 'input'; frames: InputFrame[] }
  | { type: 'chat'; text: string }
  | { type: 'ping'; t: number }
  | { type: 'consent'; agreed: boolean; version: string }
  | { type: 'voice_session_start'; npcId: string; sessionId: string }
  // reason is diagnostic-only: 'proximity' (player walked away), 'sdk_ended'
  // (SDK closed the session without us asking — the B1 case we're hunting),
  // 'sdk_error' (SDK reported an error), 'manual' (explicit hangup). Omitted
  // = 'manual'. The server forwards this verbatim into the feedback pipeline.
  | { type: 'voice_session_end'; sessionId: string; reason?: string }
  | { type: 'transcript'; npcId: string; sessionId: string; line: TranscriptLine }
  // Set the local player's expressive pose. Sent by the local client (debug
  // keys, future UI) for the controlled player. Voice agents drive NPC poses
  // server-side via the /tools/set_pose webhook, not via this channel.
  // `transition` plays a one-shot first; the server flips it to null after the
  // matching POSE.*Ms duration and sets `pose` to the destination at that point.
  | {
      type: 'set_pose';
      pose: Pose;
      transition?: PoseTransition;
      danceVariant?: number;
    }
  // Local VAD + manual-mute state. Sent on transitions only (debounced), not
  // every frame — server caches the last value into PlayerState so snapshots
  // carry it to every other client. `speaking` is the live VAD bit;
  // `mutedByVad` is the same bit inverted with grace applied for clarity in
  // logs; `mutedManual` is the M-key hard mute.
  | {
      type: 'voice_state';
      speaking: boolean;
      mutedByVad: boolean;
      mutedManual: boolean;
    }
  // WebRTC signaling relay. `to` is the destination peer's connection id
  // (from a snapshot's PlayerState.id when isBot=false). Server checks the
  // destination is a real human peer and forwards as a webrtc_signal
  // ServerMessage with `from` set to the sender's connection id.
  | {
      type: 'webrtc_signal';
      to: PlayerId;
      signal: WebRtcSignal;
    };

export type ServerMessage =
  | { type: 'welcome'; you: PlayerId; serverTime: number }
  | { type: 'snapshot'; snapshot: GameSnapshot }
  | { type: 'events'; events: GameEvent[] }
  | { type: 'pong'; t: number; serverTime: number }
  | { type: 'consent_required'; version: string }
  | {
      type: 'npc_context';
      npcId: string;
      sessionId: string;
      // For public agents the client uses agentId directly. For private agents
      // the server mints a short-lived signedUrl via the ElevenLabs REST API
      // and returns that instead; the API key stays on the server.
      agentId?: string;
      signedUrl?: string;
      memoryBlob: string;
      friendship: number;
      // ms since the most recent voice session between this NPC and this
      // player ended. Undefined = never spoken before. Drives the client's
      // greeting-recency bucket (B2 sense-of-time).
      elapsedSinceLastMs?: number;
    }
  // Mid-conversation system message piped into the agent via
  // sendContextualUpdate. Used to feed in-game events to the active session
  // (damage taken, player ran away, kill score, etc.) so the agent can react
  // in voice. Text format: "[System: ...]".
  | { type: 'npc_alert'; npcId: string; sessionId: string; text: string }
  // WebRTC signaling forwarded from another peer. `from` is the sender's
  // connection id; client matches it against its peer-connection map and
  // applies the SDP/ICE to that RTCPeerConnection.
  | {
      type: 'webrtc_signal';
      from: PlayerId;
      signal: WebRtcSignal;
    };

export const encode = <T>(msg: T): string => JSON.stringify(msg);
export const decode = <T>(raw: string): T => JSON.parse(raw) as T;
