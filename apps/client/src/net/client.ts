import PartySocket from 'partysocket';
import {
  decode,
  encode,
  type BotDifficulty,
  type ClientMessage,
  type MapId,
  type ServerMessage,
} from '@slipstream-npc/shared';
import { useGame } from '../store.js';
import { handleConsentRequired, handleNpcAlert, handleNpcContext } from '../voice/manager.js';
import { onServerSignal } from '../voice/webrtc-mesh.js';
import { startVoiceRuntime, stopVoiceRuntime } from '../voice/voice-runtime.js';

const urlHost =
  typeof window !== 'undefined'
    ? new URLSearchParams(window.location.search).get('host')
    : null;
const HOST = urlHost || import.meta.env.VITE_PARTYKIT_HOST || 'localhost:1999';

export interface NetClient {
  socket: PartySocket;
  send(msg: ClientMessage): void;
  close(): void;
}

export const connect = (
  mapId: MapId,
  name: string,
  killTarget?: number,
  accessCode?: string,
  botCount?: number,
  botDifficulty?: BotDifficulty,
  npcIds?: string[],
): NetClient => {
  const store = useGame.getState();
  store.setConn('connecting');
  store.setCloseReason(null);

  const query: Record<string, string> = { name, mapId };
  if (killTarget != null && Number.isFinite(killTarget)) {
    query.killTarget = String(Math.floor(killTarget));
  }
  if (botCount != null && Number.isFinite(botCount)) {
    query.botCount = String(Math.floor(botCount));
  }
  if (botDifficulty) {
    query.botDifficulty = botDifficulty;
  }
  if (npcIds && npcIds.length > 0) {
    query.npcIds = npcIds.join(',');
  }
  if (accessCode) {
    query.accessCode = accessCode;
  }

  const socket = new PartySocket({
    host: HOST,
    room: mapId,
    party: 'main',
    query,
  });

  socket.addEventListener('open', () => {
    useGame.getState().setConn('connected');
    // Forward stored consent so the server can record it for this session.
    // The consent gate runs before the lobby, so this is always populated by
    // the time we get here; the server uses it to gate voice_session_start.
    try {
      const raw = localStorage.getItem('slipstream-npc:consent');
      if (raw) {
        const parsed = JSON.parse(raw) as { version: string };
        socket.send(
          encode<ClientMessage>({ type: 'consent', agreed: true, version: parsed.version }),
        );
      }
    } catch {
      // ignore
    }
  });

  socket.addEventListener('close', (event) => {
    // Server uses 4003 for a bad access code. PartySocket auto-reconnects on
    // most close codes; we only surface a reason when it's a hard rejection
    // the player can actually fix in the lobby.
    const code = (event as CloseEvent).code;
    const reason = (event as CloseEvent).reason;
    if (code === 4003) {
      useGame.getState().setCloseReason(reason || 'invalid access code');
    } else if (code === 4002) {
      useGame.getState().setCloseReason(reason || 'wrong map');
    } else if (code === 4001) {
      useGame.getState().setCloseReason(reason || 'room full');
    }
    useGame.getState().setConn('disconnected');
    stopVoiceRuntime();
  });

  socket.addEventListener('message', (event) => {
    let msg: ServerMessage;
    try {
      msg = decode<ServerMessage>(event.data as string);
    } catch {
      return;
    }
    const s = useGame.getState();
    switch (msg.type) {
      case 'welcome':
        s.setMyId(msg.you);
        void startVoiceRuntime(msg.you, (out) => socket.send(encode(out)));
        return;
      case 'snapshot':
        s.ingestSnapshot(msg.snapshot);
        return;
      case 'events':
        s.ingestEvents(msg.events);
        return;
      case 'pong':
        return;
      case 'npc_context':
        handleNpcContext(msg);
        return;
      case 'npc_alert':
        handleNpcAlert(msg);
        return;
      case 'consent_required':
        handleConsentRequired();
        return;
      case 'webrtc_signal':
        onServerSignal(msg);
        return;
    }
  });

  return {
    socket,
    send(msg) {
      socket.send(encode(msg));
    },
    close() {
      socket.close();
    },
  };
};
