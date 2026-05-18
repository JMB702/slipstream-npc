import { useEffect, useMemo, useState } from 'react';
import {
  ACTIONS,
  FIXED_BINDINGS,
  actionsBoundToButton,
  actionsBoundToKey,
  getGamepadBinding,
  getKeyboardBinding,
  labelForButton,
  labelForKey,
  resetAllBindings,
  setGamepadBinding,
  setKeyboardBinding,
  subscribeBindings,
  type ActionId,
} from '../controls.js';

type Tab = 'keyboard' | 'gamepad';

interface Props {
  open: boolean;
  onClose(): void;
}

// Polls a single connected gamepad once per animation frame and reports the
// FIRST button index that's currently pressed via the supplied callback.
// Returns a cleanup function. Used while rebinding a gamepad action — the
// menu sits in capture mode until any button press resolves it.
const captureGamepadButton = (onCapture: (idx: number) => void): (() => void) => {
  let raf = 0;
  const tick = () => {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    for (const pad of pads) {
      if (!pad) continue;
      for (let i = 0; i < pad.buttons.length; i++) {
        const b = pad.buttons[i];
        if (b && b.pressed) {
          onCapture(i);
          return;
        }
      }
    }
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
  return () => cancelAnimationFrame(raf);
};

export const ControlsMenu = ({ open, onClose }: Props) => {
  const [tab, setTab] = useState<Tab>('keyboard');
  const [, setVersion] = useState(0);
  // When non-null, the menu is "listening" for the next physical input to
  // rebind that action. Null when idle.
  const [capturing, setCapturing] = useState<ActionId | null>(null);

  // Re-render on any binding change so labels and conflict-warnings stay
  // current after rebinds / resets.
  useEffect(() => subscribeBindings(() => setVersion((v) => v + 1)), []);

  // Esc closes the menu (or cancels a rebind capture). When the menu is in
  // capture mode, swallow ALL keydowns so the capture handler is the only
  // path that fires.
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (!capturing) {
        if (e.code === 'Escape') {
          e.preventDefault();
          onClose();
        }
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      if (e.code === 'Escape') {
        setCapturing(null);
        return;
      }
      // Modifier-only presses don't make sensible bindings — skip them so
      // the next non-modifier key wins the capture.
      if (
        e.code === 'ShiftLeft' && e.shiftKey && e.key === 'Shift' ||
        e.code === 'ShiftRight' && e.shiftKey && e.key === 'Shift'
      ) {
        // allow shift as binding (used for sprint) — fall through.
      }
      setKeyboardBinding(capturing, e.code);
      setCapturing(null);
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [open, capturing, onClose]);

  // Gamepad capture loop. Only runs when capturing AND on the gamepad tab —
  // a button press during keyboard capture should be ignored.
  useEffect(() => {
    if (!open || !capturing || tab !== 'gamepad') return;
    const stop = captureGamepadButton((idx) => {
      setGamepadBinding(capturing, idx);
      setCapturing(null);
    });
    return stop;
  }, [open, capturing, tab]);

  const grouped = useMemo(() => {
    const groups: Record<string, typeof ACTIONS[number][]> = {};
    for (const a of ACTIONS) {
      groups[a.group] ??= [];
      groups[a.group]!.push(a);
    }
    return groups;
  }, []);

  if (!open) return null;

  return (
    <div style={overlay} onClick={onClose}>
      <div style={panel} onClick={(e) => e.stopPropagation()}>
        <div style={header}>
          <h2 style={titleText}>Controls</h2>
          <button style={closeBtn} onClick={onClose} aria-label="Close controls menu">
            ✕
          </button>
        </div>

        <div style={tabRow}>
          <TabButton active={tab === 'keyboard'} onClick={() => setTab('keyboard')}>
            Keyboard &amp; Mouse
          </TabButton>
          <TabButton active={tab === 'gamepad'} onClick={() => setTab('gamepad')}>
            Xbox Controller
          </TabButton>
        </div>

        <div style={body}>
          {capturing && (
            <div style={captureBanner}>
              Press a {tab === 'keyboard' ? 'key' : 'button'} for <strong>{
                ACTIONS.find((a) => a.id === capturing)?.label
              }</strong>… (Esc to cancel)
            </div>
          )}

          {Object.entries(grouped).map(([groupName, actions]) => (
            <div key={groupName} style={groupBlock}>
              <div style={groupHeader}>{groupName}</div>
              {actions.map((action) => (
                <BindingRow
                  key={action.id}
                  actionId={action.id}
                  label={action.label}
                  description={action.description}
                  tab={tab}
                  capturing={capturing === action.id}
                  onStartCapture={() => setCapturing(action.id)}
                />
              ))}
            </div>
          ))}

          <div style={groupBlock}>
            <div style={groupHeader}>Fixed (hardware-mapped)</div>
            {FIXED_BINDINGS.filter((f) =>
              tab === 'keyboard' ? f.device === 'mouse' : f.device === 'gamepad',
            ).map((f) => (
              <div key={f.label + f.binding} style={fixedRow}>
                <div style={{ flex: 1 }}>
                  <div style={rowLabel}>{f.label}</div>
                  <div style={rowDesc}>{f.description}</div>
                </div>
                <div style={fixedBindingChip}>{f.binding}</div>
              </div>
            ))}
          </div>
        </div>

        <div style={footer}>
          <button style={resetBtn} onClick={resetAllBindings}>
            Reset all to defaults
          </button>
          <div style={footerHint}>Press Esc to close · Click a binding to rebind</div>
        </div>
      </div>
    </div>
  );
};

const BindingRow = ({
  actionId,
  label,
  description,
  tab,
  capturing,
  onStartCapture,
}: {
  actionId: ActionId;
  label: string;
  description: string;
  tab: Tab;
  capturing: boolean;
  onStartCapture(): void;
}) => {
  if (tab === 'keyboard') {
    const code = getKeyboardBinding(actionId);
    const conflicts = code ? actionsBoundToKey(code).filter((id) => id !== actionId) : [];
    return (
      <div style={row}>
        <div style={{ flex: 1 }}>
          <div style={rowLabel}>{label}</div>
          <div style={rowDesc}>{description}</div>
          {conflicts.length > 0 && (
            <div style={conflictText}>
              Also bound: {conflicts.map((id) => ACTIONS.find((a) => a.id === id)?.label).join(', ')}
            </div>
          )}
        </div>
        <button
          style={capturing ? bindingChipCapturing : bindingChip}
          onClick={onStartCapture}
        >
          {capturing ? 'Press a key…' : labelForKey(code)}
        </button>
        {code !== null && (
          <button
            style={clearBtn}
            onClick={() => setKeyboardBinding(actionId, null)}
            title="Unbind"
          >
            ✕
          </button>
        )}
      </div>
    );
  }
  const idx = getGamepadBinding(actionId);
  const conflicts = idx !== null ? actionsBoundToButton(idx).filter((id) => id !== actionId) : [];
  return (
    <div style={row}>
      <div style={{ flex: 1 }}>
        <div style={rowLabel}>{label}</div>
        <div style={rowDesc}>{description}</div>
        {conflicts.length > 0 && (
          <div style={conflictText}>
            Also bound: {conflicts.map((id) => ACTIONS.find((a) => a.id === id)?.label).join(', ')}
          </div>
        )}
      </div>
      <button
        style={capturing ? bindingChipCapturing : bindingChip}
        onClick={onStartCapture}
      >
        {capturing ? 'Press a button…' : labelForButton(idx)}
      </button>
      {idx !== null && (
        <button
          style={clearBtn}
          onClick={() => setGamepadBinding(actionId, null)}
          title="Unbind"
        >
          ✕
        </button>
      )}
    </div>
  );
};

const TabButton = ({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick(): void;
  children: React.ReactNode;
}) => (
  <button style={active ? tabBtnActive : tabBtn} onClick={onClick}>
    {children}
  </button>
);

const overlay: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(0, 0, 0, 0.6)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: 1000,
  fontFamily: 'system-ui, sans-serif',
};

const panel: React.CSSProperties = {
  width: 'min(720px, 92vw)',
  maxHeight: '85vh',
  display: 'flex',
  flexDirection: 'column',
  background: '#10131c',
  color: '#e8e8f0',
  border: '1px solid #2a2f4a',
  borderRadius: 8,
  boxShadow: '0 12px 40px rgba(0,0,0,0.5)',
};

const header: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  padding: '14px 18px',
  borderBottom: '1px solid #2a2f4a',
};

const titleText: React.CSSProperties = { margin: 0, fontSize: 18, fontWeight: 600 };

const closeBtn: React.CSSProperties = {
  background: 'transparent',
  color: '#e8e8f0',
  border: 'none',
  fontSize: 18,
  cursor: 'pointer',
  padding: '4px 8px',
};

const tabRow: React.CSSProperties = {
  display: 'flex',
  gap: 0,
  borderBottom: '1px solid #2a2f4a',
  padding: '0 18px',
};

const tabBtn: React.CSSProperties = {
  background: 'transparent',
  color: '#9aa0b8',
  border: 'none',
  borderBottom: '2px solid transparent',
  padding: '10px 14px',
  fontSize: 13,
  cursor: 'pointer',
};

const tabBtnActive: React.CSSProperties = {
  ...tabBtn,
  color: '#e8e8f0',
  borderBottomColor: '#3a7afe',
};

const body: React.CSSProperties = {
  padding: '14px 18px',
  overflowY: 'auto',
  flex: 1,
};

const groupBlock: React.CSSProperties = { marginBottom: 18 };

const groupHeader: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  textTransform: 'uppercase',
  letterSpacing: 0.5,
  color: '#9aa0b8',
  marginBottom: 8,
};

const row: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  padding: '8px 10px',
  borderRadius: 4,
  background: 'rgba(255,255,255,0.02)',
  marginBottom: 4,
};

const fixedRow: React.CSSProperties = {
  ...row,
  opacity: 0.7,
};

const rowLabel: React.CSSProperties = { fontSize: 13, fontWeight: 500 };
const rowDesc: React.CSSProperties = { fontSize: 11, color: '#9aa0b8', marginTop: 2 };

const conflictText: React.CSSProperties = {
  fontSize: 11,
  color: '#ffd060',
  marginTop: 4,
};

const bindingChip: React.CSSProperties = {
  background: '#1c2236',
  color: '#e8e8f0',
  border: '1px solid #2a2f4a',
  borderRadius: 4,
  padding: '6px 12px',
  fontSize: 12,
  fontFamily: 'monospace',
  minWidth: 90,
  textAlign: 'center',
  cursor: 'pointer',
};

const bindingChipCapturing: React.CSSProperties = {
  ...bindingChip,
  background: '#3a7afe',
  border: '1px solid #5a99ff',
};

const fixedBindingChip: React.CSSProperties = {
  ...bindingChip,
  cursor: 'default',
  background: 'transparent',
  color: '#9aa0b8',
};

const clearBtn: React.CSSProperties = {
  background: 'transparent',
  color: '#9aa0b8',
  border: '1px solid #2a2f4a',
  borderRadius: 4,
  padding: '6px 8px',
  fontSize: 11,
  cursor: 'pointer',
};

const captureBanner: React.CSSProperties = {
  background: '#3a7afe',
  color: '#fff',
  padding: '10px 14px',
  borderRadius: 4,
  marginBottom: 12,
  fontSize: 13,
};

const footer: React.CSSProperties = {
  borderTop: '1px solid #2a2f4a',
  padding: '12px 18px',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 10,
};

const resetBtn: React.CSSProperties = {
  background: '#2a1c1c',
  color: '#ff9696',
  border: '1px solid #6a2a2a',
  borderRadius: 4,
  padding: '6px 12px',
  fontSize: 12,
  cursor: 'pointer',
};

const footerHint: React.CSSProperties = {
  fontSize: 11,
  color: '#9aa0b8',
};
