import { create } from 'zustand';
import {
  DEFAULT_MAP_ID,
  MATCH,
  type GameEvent,
  type GameSnapshot,
  type MapId,
  type PlayerId,
  type PlayerState,
  type TranscriptLine,
} from '@slipstream-npc/shared';

export interface ActiveVoiceSession {
  npcId: string;
  npcName: string;
  sessionId: string;
}

export type VoiceStatus = 'idle' | 'connecting' | 'connected' | 'ended' | 'error';
export type VoiceMode = 'speaking' | 'listening' | null;

export type ConnState = 'idle' | 'connecting' | 'connected' | 'disconnected';

interface SnapshotEntry {
  receivedAt: number;
  serverTime: number;
  players: Map<PlayerId, PlayerState>;
}

interface State {
  conn: ConnState;
  myId: PlayerId | null;
  serverTimeOffset: number;
  snapshots: SnapshotEntry[];
  events: GameEvent[];
  killFeed: GameEvent[];
  chat: GameEvent[];
  killTarget: number;
  winnerId: PlayerId | null;
  activeMapId: MapId;
  lastCloseReason: string | null;
  activeVoiceSession: ActiveVoiceSession | null;
  voiceStatus: VoiceStatus;
  voiceMode: VoiceMode;
  voiceInputVolume: number;
  voiceOutputVolume: number;
  voiceLastError: string | null;
  voiceTranscripts: { npcId: string; sessionId: string; line: TranscriptLine }[];
  setConn(s: ConnState): void;
  setCloseReason(r: string | null): void;
  setMyId(id: PlayerId): void;
  setActiveMapId(id: MapId): void;
  ingestSnapshot(s: GameSnapshot): void;
  ingestEvents(e: GameEvent[]): void;
  setActiveVoiceSession(s: ActiveVoiceSession | null): void;
  setVoiceSessionStatus(s: VoiceStatus): void;
  setVoiceMode(m: VoiceMode): void;
  setVoiceVolumes(input: number, output: number): void;
  setVoiceLastError(err: string | null): void;
  pushTranscript(t: { npcId: string; sessionId: string; line: TranscriptLine }): void;
  reset(): void;
}

const SNAPSHOT_BUFFER = 30;
const FEED_LIMIT = 8;

// Dev-only debug hook: expose the store on window so test scripts and
// in-browser eval can read live snapshot/player state without needing the
// same module instance Vite served to the app. Stripped in production
// builds via `import.meta.env.DEV`.
if (import.meta.env.DEV && typeof window !== 'undefined') {
  Promise.resolve().then(() => {
    (window as unknown as { useGame: unknown }).useGame = useGame;
  });
}

export const useGame = create<State>((set, get) => ({
  conn: 'idle',
  myId: null,
  serverTimeOffset: 0,
  snapshots: [],
  events: [],
  killFeed: [],
  chat: [],
  killTarget: MATCH.defaultKillTarget,
  winnerId: null,
  activeMapId: DEFAULT_MAP_ID,
  lastCloseReason: null,
  activeVoiceSession: null,
  voiceStatus: 'idle',
  voiceMode: null,
  voiceInputVolume: 0,
  voiceOutputVolume: 0,
  voiceLastError: null,
  voiceTranscripts: [],

  setConn(s) {
    set({ conn: s });
  },

  setCloseReason(r) {
    set({ lastCloseReason: r });
  },

  setMyId(id) {
    set({ myId: id });
  },

  setActiveMapId(id) {
    set({ activeMapId: id });
  },

  ingestSnapshot(s) {
    const map = new Map<PlayerId, PlayerState>();
    for (const p of s.players) map.set(p.id, p);
    const entry: SnapshotEntry = {
      receivedAt: performance.now(),
      serverTime: s.serverTime,
      players: map,
    };
    const snapshots = [...get().snapshots, entry];
    while (snapshots.length > SNAPSHOT_BUFFER) snapshots.shift();
    set({ snapshots, killTarget: s.killTarget, winnerId: s.winnerId });
  },

  ingestEvents(events) {
    const prev = get();
    const kills = events.filter((e) => e.type === 'kill');
    const chats = events.filter((e) => e.type === 'chat');
    set({
      events: [...prev.events, ...events].slice(-200),
      killFeed: [...prev.killFeed, ...kills].slice(-FEED_LIMIT),
      chat: [...prev.chat, ...chats].slice(-FEED_LIMIT),
    });
  },

  setActiveVoiceSession(s) {
    set({
      activeVoiceSession: s,
      voiceStatus: s ? 'connecting' : 'idle',
      voiceMode: s ? get().voiceMode : null,
    });
  },

  setVoiceSessionStatus(s) {
    set({ voiceStatus: s });
  },

  setVoiceMode(m) {
    set({ voiceMode: m });
  },

  setVoiceVolumes(input, output) {
    set({ voiceInputVolume: input, voiceOutputVolume: output });
  },

  setVoiceLastError(err) {
    set({ voiceLastError: err });
  },

  pushTranscript(t) {
    set((state) => {
      const next = state.voiceTranscripts.slice();
      // agent_response_correction events rewrite the last agent turn rather
      // than adding a new one. The audio for the original was already played
      // (SDK-internal); the correction is mostly a transcript-level cleanup.
      if (t.line.correction && t.line.role === 'agent') {
        for (let i = next.length - 1; i >= 0; i--) {
          const cand = next[i]!;
          if (cand.line.role !== 'agent') continue;
          if (cand.sessionId !== t.sessionId || cand.npcId !== t.npcId) break;
          next[i] = t;
          return { voiceTranscripts: next.slice(-200) };
        }
      }
      next.push(t);
      return { voiceTranscripts: next.slice(-200) };
    });
  },

  reset() {
    set({
      conn: 'idle',
      myId: null,
      serverTimeOffset: 0,
      snapshots: [],
      events: [],
      killFeed: [],
      chat: [],
      killTarget: MATCH.defaultKillTarget,
      winnerId: null,
      lastCloseReason: null,
      activeVoiceSession: null,
      voiceStatus: 'idle',
      voiceMode: null,
      voiceInputVolume: 0,
      voiceOutputVolume: 0,
      voiceLastError: null,
      voiceTranscripts: [],
    });
  },
}));

export const latestPlayers = (): Map<PlayerId, PlayerState> => {
  const snaps = useGame.getState().snapshots;
  const last = snaps[snaps.length - 1];
  return last ? last.players : new Map();
};
