import { useEffect, useState } from 'react';
import { setActiveMap, type BotDifficulty, type MapId } from '@slipstream-npc/shared';
import { connect, type NetClient } from './net/client.js';
import { Scene } from './game/Scene.js';
import { Lobby } from './ui/Lobby.js';
import { HUD } from './ui/HUD.js';
import { Minimap } from './ui/Minimap.js';
import { Scoreboard } from './ui/Scoreboard.js';
import { ConsentGate, getStoredConsent } from './ui/ConsentGate.js';
import { MuteIndicator } from './ui/MuteIndicator.js';
import { SpeakerHUD } from './ui/SpeakerHUD.js';
import { VoiceDebug } from './ui/VoiceDebug.js';
import { installVoiceManager, teardownVoiceManager } from './voice/manager.js';
import { installMuteControls } from './voice/mute.js';
import { useGame } from './store.js';

export const App = () => {
  const [client, setClient] = useState<NetClient | null>(null);
  const [name, setName] = useState('');
  const [consented, setConsented] = useState(() => getStoredConsent() !== null);
  const lastCloseReason = useGame((s) => s.lastCloseReason);

  useEffect(() => {
    installMuteControls();
  }, []);

  const onJoin = ({
    name,
    mapId,
    killTarget,
    accessCode,
    botCount,
    botDifficulty,
    npcIds,
  }: {
    name: string;
    mapId: MapId;
    killTarget: number;
    accessCode: string;
    botCount: number;
    botDifficulty: BotDifficulty;
    npcIds: string[];
  }) => {
    setActiveMap(mapId);
    useGame.getState().setActiveMapId(mapId);
    const c = connect(mapId, name, killTarget, accessCode, botCount, botDifficulty, npcIds);
    installVoiceManager({ send: c.send, myName: name });
    setClient(c);
    setName(name);
  };

  const onLeave = () => {
    teardownVoiceManager();
    client?.close();
    setClient(null);
    useGame.getState().reset();
  };

  useEffect(() => {
    if (client && lastCloseReason) {
      teardownVoiceManager();
      client.close();
      setClient(null);
    }
  }, [client, lastCloseReason]);

  if (!consented) return <ConsentGate onAgree={() => setConsented(true)} />;
  if (!client) return <Lobby onJoin={onJoin} />;

  return (
    <>
      <Scene send={client.send} myName={name} />
      <HUD />
      <Minimap />
      <Scoreboard />
      <MuteIndicator />
      <SpeakerHUD />
      <VoiceDebug />
      <button onClick={onLeave} style={leaveBtn}>
        Leave
      </button>
    </>
  );
};

const leaveBtn: React.CSSProperties = {
  position: 'fixed',
  top: 12,
  left: 12,
  padding: '6px 10px',
  background: 'rgba(0,0,0,0.5)',
  color: '#e8e8f0',
  border: '1px solid #2a2f4a',
  borderRadius: 4,
  fontSize: 12,
  cursor: 'pointer',
};
