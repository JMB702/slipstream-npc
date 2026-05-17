import { useState } from 'react';

const STORAGE_KEY = 'slipstream-npc:consent';
export const CONSENT_VERSION = 'v3';

interface StoredConsent {
  version: string;
  agreedAt: number;
}

export const getStoredConsent = (): StoredConsent | null => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredConsent;
    if (parsed.version !== CONSENT_VERSION) return null;
    return parsed;
  } catch {
    return null;
  }
};

interface Props {
  onAgree: () => void;
}

export const ConsentGate = ({ onAgree }: Props) => {
  const [checked, setChecked] = useState(false);

  const onAccept = () => {
    if (!checked) return;
    const stored: StoredConsent = { version: CONSENT_VERSION, agreedAt: Date.now() };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
    } catch {
      // ignore quota / private-mode errors; the in-memory consent still gates this session
    }
    onAgree();
  };

  return (
    <div style={overlay}>
      <div style={card}>
        <h1 style={h1}>You are about to talk to AI characters</h1>
        <p style={pStrong}>
          The NPCs in Slipstream Rift are not humans. They are AI agents powered by{' '}
          <a style={a} href="https://elevenlabs.io" target="_blank" rel="noreferrer">
            ElevenLabs
          </a>
          {' '}Conversational AI. You are interacting with software, not with another
          person, whenever you talk to a character in this game.
        </p>
        <p style={p}>
          Slipstream Rift is operated by <strong>JMB Image Studios LLC</strong> ("we",
          "us"). By clicking <strong>Agree</strong> below, and each time you use voice
          or text with an AI agent in this game, you consent to (a) us, (b) ElevenLabs,
          and (c) any third-party service providers we or ElevenLabs use (including
          large-language-model providers, transcription services, and any future
          vendors that may replace or supplement them) capturing, transmitting,
          transcribing, processing, storing, sharing, and otherwise using your
          microphone audio, the resulting transcripts, and any text or in-game
          communications, for any lawful purpose, including: providing and operating
          the service; developing, improving, and expanding the service and our other
          products; training, fine-tuning, and evaluating machine-learning and AI
          models; research and analytics; and complying with applicable law.
        </p>
        <p style={pHeader}>How this works today, and how it may change:</p>
        <ul style={ul}>
          <li>When voice chat is active in this game, your microphone audio is sent to ElevenLabs and to the AI models that drive the NPCs. ElevenLabs and those model providers process and may retain that audio and the resulting transcripts under their own policies, which you can review on their respective websites.</li>
          <li>Transcripts are stored on our game server so NPCs can remember conversations across sessions, and so we can operate, debug, and improve the game. We do not retain raw audio ourselves.</li>
          <li>You can mute your microphone at any time (M on keyboard, Start/Menu on Xbox controller). When muted, your audio is not transmitted. Voice activity detection also auto-mutes your microphone when you are not speaking, so background sound is not transmitted to other players.</li>
          <li>When other human players are in the same room, your microphone audio is sent directly to those players' browsers over an encrypted peer-to-peer (WebRTC) connection. Audio does not transit our game server, but the connection-establishment messages do. Voice activity detection runs entirely in your browser using a small machine-learning model that is loaded from a public software CDN (jsdelivr.net) on first use; your microphone audio never leaves your device for that step.</li>
          <li>The exact mechanics of when and how voice is captured will change over time as we add features. This consent covers those future changes as well as the current behavior. If you do not want to consent to evolving voice features, do not proceed past this screen and do not use voice in this game.</li>
        </ul>
        <p style={pStrong}>Anything you say or do in this game may become public to other players. Treat the entire game as a public space:</p>
        <ul style={ul}>
          <li>NPCs may speak out loud in ways that other players can hear, including reading back, paraphrasing, or reacting to things you have said to them.</li>
          <li>NPCs may share what you have told them with other NPCs or with other players, at any time, anywhere in the game world, by any means the game supports now or in the future. Friendships, secrets, plans, opinions, personal details, and anything else you disclose can travel between players through the NPCs and through the game's other systems.</li>
          <li>Other players may also hear your microphone or see your text directly through features we add over time.</li>
          <li>Do not say or share anything in this game that you would not be comfortable becoming public to other players or to us.</li>
        </ul>
        <p style={pSmall}>
          Recording-law consent. Some jurisdictions (including Florida, where this
          service is operated) require every party to a conversation to consent to its
          recording. By proceeding, you confirm that you, and anyone whose voice your
          microphone may capture while you use this game, consent to the capture,
          transmission, and use described above, and that you have the legal right to
          give that consent under the law of your location.
        </p>
        <p style={pSmall}>
          This service is not directed to children under 13. If you are under 13, do
          not proceed.
        </p>
        <label style={check}>
          <input
            type="checkbox"
            checked={checked}
            onChange={(e) => setChecked(e.target.checked)}
            style={checkbox}
          />
          I am 13 or older and I agree to the terms above.
        </label>
        <button onClick={onAccept} disabled={!checked} style={checked ? btnOn : btnOff}>
          Agree and continue
        </button>
      </div>
    </div>
  );
};

const overlay: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(8, 10, 18, 0.95)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 16,
  zIndex: 100,
};
const card: React.CSSProperties = {
  background: '#101424',
  color: '#e8e8f0',
  border: '1px solid #2a2f4a',
  borderRadius: 8,
  padding: 24,
  maxWidth: 560,
  maxHeight: '85vh',
  overflowY: 'auto',
  fontFamily: 'system-ui, -apple-system, sans-serif',
  lineHeight: 1.45,
};
const h1: React.CSSProperties = { fontSize: 22, margin: '0 0 12px' };
const p: React.CSSProperties = { fontSize: 14, margin: '0 0 12px', opacity: 0.9 };
const pStrong: React.CSSProperties = { fontSize: 14, margin: '0 0 14px', lineHeight: 1.5 };
const pHeader: React.CSSProperties = { fontSize: 13, margin: '0 0 6px', opacity: 0.8 };
const pSmall: React.CSSProperties = { fontSize: 12, margin: '0 0 12px', opacity: 0.7, lineHeight: 1.45 };
const a: React.CSSProperties = { color: '#7aa8ff', textDecoration: 'underline' };
const ul: React.CSSProperties = { fontSize: 13, margin: '0 0 12px', paddingLeft: 18, opacity: 0.9 };
const check: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  fontSize: 13,
  margin: '12px 0',
  cursor: 'pointer',
};
const checkbox: React.CSSProperties = { width: 16, height: 16, cursor: 'pointer' };
const btn: React.CSSProperties = {
  padding: '8px 14px',
  border: '1px solid #2a2f4a',
  borderRadius: 4,
  fontSize: 14,
  cursor: 'pointer',
};
const btnOff: React.CSSProperties = { ...btn, background: '#22263a', color: '#6b6f88', cursor: 'not-allowed' };
const btnOn: React.CSSProperties = { ...btn, background: '#3a7afe', color: 'white', borderColor: '#3a7afe' };
