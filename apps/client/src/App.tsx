import { useEffect, useState } from 'react';
import { setActiveMap, type BotDifficulty, type MapId } from '@slipstream-npc/shared';
import { connect, type NetClient } from './net/client.js';
import { getKeyboardBinding } from './controls.js';
import { Scene } from './game/Scene.js';
import { Lobby } from './ui/Lobby.js';
import { HUD } from './ui/HUD.js';
import { Minimap } from './ui/Minimap.js';
import { Scoreboard } from './ui/Scoreboard.js';
import { ConsentGate, getStoredConsent } from './ui/ConsentGate.js';
import { ControlsMenu } from './ui/ControlsMenu.js';
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
  const [controlsOpen, setControlsOpen] = useState(false);
  const lastCloseReason = useGame((s) => s.lastCloseReason);

  useEffect(() => {
    installMuteControls();
  }, []);

  // Esc toggles the controls menu while in-game. The menu's own Esc
  // handler closes it when it's already open (and cancels rebind capture);
  // this handler only OPENS it. Ignored if the lobby is up or any text
  // input has focus.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== 'Escape') return;
      if (controlsOpen) return; // menu's own handler closes it
      if (!client) return; // lobby visible — leave Esc to the browser
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      e.preventDefault();
      // Release pointer lock so the menu's mouse clicks work.
      if (document.pointerLockElement) document.exitPointerLock();
      setControlsOpen(true);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [client, controlsOpen]);

  // Fullscreen toggle. Default keybind is F; rebindable via the controls
  // menu. The Fullscreen API requires "user activation" (a real keypress
  // in the same call stack) — calling requestFullscreen async-later or
  // from a non-event tick rejects with "API can only be initiated by a
  // user gesture." That constraint is why this lives in the keydown
  // handler instead of a separate function.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const code = getKeyboardBinding('toggle_fullscreen');
      if (!code || e.code !== code) return;
      if (controlsOpen) return; // don't fight with rebind capture
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      e.preventDefault();
      if (document.fullscreenElement) {
        document.exitFullscreen().catch(() => {});
      } else {
        document.documentElement.requestFullscreen().catch((err) => {
          // Most common failure: not a "user gesture" — shouldn't happen
          // since we're inside a keydown handler, but log so it's not
          // silently swallowed.
          console.warn('[fullscreen] requestFullscreen failed:', err);
        });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [controlsOpen]);

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
      <button
        onClick={() => {
          if (document.pointerLockElement) document.exitPointerLock();
          setControlsOpen(true);
        }}
        style={controlsBtn}
        title="Controls (Esc)"
      >
        ⚙ Controls
      </button>
      <ControlsMenu open={controlsOpen} onClose={() => setControlsOpen(false)} />
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

const controlsBtn: React.CSSProperties = {
  position: 'fixed',
  top: 12,
  left: 78,
  padding: '6px 10px',
  background: 'rgba(0,0,0,0.5)',
  color: '#e8e8f0',
  border: '1px solid #2a2f4a',
  borderRadius: 4,
  fontSize: 12,
  cursor: 'pointer',
  fontFamily: 'system-ui, sans-serif',
};
