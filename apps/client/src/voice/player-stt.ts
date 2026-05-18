import type { ClientMessage, ServerMessage } from '@slipstream-npc/shared';
import { getMicStream } from './mic.js';

// Streaming speech-to-text via Deepgram. The server mints a short-lived
// access token (~30s TTL) on demand; this client opens a WebSocket directly
// to api.deepgram.com using the token, streams raw 16-bit PCM at the
// AudioContext's native sample rate, and forwards finalized transcripts to
// PartyKit as scene-transcript ClientMessages.
//
// Mic audio path: the same singleton MediaStream that backs the WebRTC mesh
// and VAD is used here — no second mic acquisition. ScriptProcessorNode is
// deprecated but the only universally-supported way to get raw Float32
// samples without an AudioWorklet module dance (which adds Vite asset
// handling). The replacement is trivial when the latency matters.
//
// Format: linear16 at the AudioContext's native rate (usually 48000 Hz).
// Higher than necessary but Deepgram accepts it; no client-side resampling
// reduces complexity and the bandwidth (~96 KB/s) is fine for upstream.
//
// Lifecycle: start() is called by voice-runtime after consent + connect.
// Internally:
//   1. send `stt_token_request` and wait for the reply
//   2. open `wss://api.deepgram.com/v1/listen?...` with the token
//   3. wire mic → AudioContext → ScriptProcessor → ws
//   4. on `is_final` Deepgram messages, emit `transcript` ClientMessages
// On token expiry (~30s) we transparently refresh and reopen the socket.

const DG_URL = 'wss://api.deepgram.com/v1/listen';

interface TokenReply {
  token?: string;
  expiresInS?: number;
  reason?: string;
}

interface DeepgramResult {
  type?: string;
  channel?: {
    alternatives?: { transcript?: string }[];
  };
  is_final?: boolean;
  speech_final?: boolean;
}

let started = false;
let mySpeakerName: string | null = null;
let netSend: ((msg: ClientMessage) => void) | null = null;
let pendingTokenResolve: ((reply: TokenReply) => void) | null = null;
let socket: WebSocket | null = null;
// Audio graph is a singleton across STT restarts. Browser autoplay policy
// keeps a freshly-created AudioContext SUSPENDED unless construction happens
// inside a user gesture. PartyKit hot-reloads and Deepgram token expiry both
// trigger STT restarts that are NOT in a gesture window — creating a new
// AudioContext on each restart silently produces no audio (ScriptProcessor
// onaudioprocess only fires while running). Reusing the original context
// (created during the initial lobby "Enter Game" click) sidesteps the
// suspension problem. Only the WS-bound processor + source nodes are
// rebuilt per session.
let audioCtx: AudioContext | null = null;
let processor: ScriptProcessorNode | null = null;
let source: MediaStreamAudioSourceNode | null = null;
let sinkGain: GainNode | null = null;
let reconnectTimer: number | null = null;
let stopped = false;

// Public hook from the dispatch table. Resolves the in-flight token
// request. Called by net/client.ts when it sees a stt_token ServerMessage.
export const onSttTokenReply = (msg: Extract<ServerMessage, { type: 'stt_token' }>): void => {
  const r = pendingTokenResolve;
  pendingTokenResolve = null;
  r?.({ token: msg.token, expiresInS: msg.expiresInS, reason: msg.reason });
};

const requestToken = (): Promise<TokenReply> =>
  new Promise((resolve) => {
    if (!netSend) {
      resolve({ reason: 'no-net-send' });
      return;
    }
    pendingTokenResolve = resolve;
    netSend({ type: 'stt_token_request' });
    // Safety timeout — if the server doesn't reply we don't want to hang
    // forever waiting on a promise.
    window.setTimeout(() => {
      if (pendingTokenResolve === resolve) {
        pendingTokenResolve = null;
        resolve({ reason: 'timeout' });
      }
    }, 5000);
  });

// Float32 [-1, 1] → Int16 little-endian buffer for Deepgram's linear16.
// In-place pass over the input array to avoid extra allocation.
const floatTo16BitPCM = (input: Float32Array): ArrayBuffer => {
  const buf = new ArrayBuffer(input.length * 2);
  const view = new DataView(buf);
  for (let i = 0; i < input.length; i++) {
    let s = input[i]!;
    if (s > 1) s = 1;
    else if (s < -1) s = -1;
    view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return buf;
};

// Tear down the per-session audio graph nodes (processor + source + sink)
// but NOT the AudioContext itself — see the audioCtx singleton comment for
// why. The context lives for the page lifetime once it's been resumed.
const teardownAudio = (): void => {
  if (processor) {
    try {
      processor.disconnect();
    } catch {
      // already
    }
    processor.onaudioprocess = null;
    processor = null;
  }
  if (sinkGain) {
    try {
      sinkGain.disconnect();
    } catch {
      // already
    }
    sinkGain = null;
  }
  if (source) {
    try {
      source.disconnect();
    } catch {
      // already
    }
    source = null;
  }
  // audioCtx intentionally preserved across STT restarts.
};

// Lazily create or return the singleton AudioContext. resume() is fired
// without await — Web Audio's resume() promise can stay pending forever
// when called outside the autoplay-policy gesture window, and awaiting it
// hangs the entire STT init. Chrome auto-resumes the context on the next
// user gesture anyway; we just need a context that EXISTS so the WS can
// open. Suspended contexts produce zero-amplitude buffers (no audio sent)
// until they resume, which is the right fallback.
const getOrCreateAudioCtx = (): AudioContext => {
  if (!audioCtx || audioCtx.state === 'closed') {
    audioCtx = new AudioContext();
  }
  if (audioCtx.state === 'suspended') {
    void audioCtx.resume().catch((err) => {
      console.warn('[stt] AudioContext.resume() failed:', err);
    });
  }
  return audioCtx;
};

const closeSocket = (reason: string): void => {
  if (!socket) return;
  try {
    socket.send(JSON.stringify({ type: 'CloseStream' }));
  } catch {
    // already gone
  }
  try {
    socket.close(1000, reason);
  } catch {
    // already
  }
  socket = null;
};

const openSocket = async (): Promise<void> => {
  if (stopped) return;
  console.log('[stt] openSocket: requesting token');
  const reply = await requestToken();
  if (stopped) return;
  if (!reply.token) {
    console.warn(`[stt] token mint failed: ${reply.reason ?? 'unknown'}`);
    // Token mint failure isn't a permanent stop; the server may have been
    // mid-reconnect or rate-limited us. Retry after a backoff.
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = null;
      void openSocket();
    }, 5000);
    return;
  }
  console.log(`[stt] got token (len=${reply.token.length} ttl=${reply.expiresInS ?? 0}s)`);

  // Native AudioContext sample rate. Browsers commonly default to 48000 Hz
  // (sometimes 44100). Either is fine for Deepgram if we report it. The
  // context is a singleton — see audioCtx declaration — so this only
  // constructs on the very first STT start; subsequent restarts reuse it
  // and just call resume() to handle suspension after tab visibility loss.
  const ctx = getOrCreateAudioCtx();
  const sampleRate = ctx.sampleRate;

  const params = new URLSearchParams({
    model: 'nova-2',
    encoding: 'linear16',
    sample_rate: String(sampleRate),
    channels: '1',
    interim_results: 'true',
    smart_format: 'true',
    // Endpointing: how much silence (ms) before Deepgram considers the
    // utterance "done" and emits is_final=true. 300ms keeps natural pauses
    // from chopping a sentence in half; higher would feel laggy for game
    // chat.
    endpointing: '300',
    // utterance_end_ms is the cleanup signal Deepgram sends after silence
    // surpasses this threshold — used in Phase 3 to detect "all humans
    // stopped, time to pick an NPC."
    utterance_end_ms: '1000',
  });
  console.log(`[stt] opening Deepgram WS (sampleRate=${sampleRate}, ctx.state=${ctx.state})`);
  const ws = new WebSocket(`${DG_URL}?${params.toString()}`, ['token', reply.token]);
  ws.binaryType = 'arraybuffer';
  socket = ws;

  ws.onopen = async () => {
    console.log('[stt] Deepgram WS open');
    if (stopped) {
      closeSocket('stopped-while-opening');
      return;
    }
    try {
      const stream = await getMicStream();
      const tracks = stream.getAudioTracks();
      const trackInfo = tracks.map((t) => `enabled=${t.enabled} muted=${t.muted} state=${t.readyState}`).join(', ');
      console.log(`[stt] mic stream acquired: ${tracks.length} track(s) [${trackInfo}]`);
      // Re-check the singleton context; if a teardown happened between the
      // top of openSocket and onopen firing, we want the current one.
      const liveCtx = getOrCreateAudioCtx();
      console.log(`[stt] AudioContext state at wire-up: ${liveCtx.state}`);
      source = liveCtx.createMediaStreamSource(stream);
      // ScriptProcessor's bufferSize controls chunk granularity; 2048 at
      // 48kHz ≈ 43ms per chunk, which is well under Deepgram's 100ms
      // recommended max. Deprecated but universally supported; AudioWorklet
      // is the replacement when latency or worker isolation matters.
      processor = liveCtx.createScriptProcessor(2048, 1, 1);
      // Sink gain at 0 so the processor's silent output doesn't leak out
      // the speakers — connecting to destination is still required for the
      // process callback to fire.
      sinkGain = liveCtx.createGain();
      sinkGain.gain.value = 0;
      source.connect(processor);
      processor.connect(sinkGain);
      sinkGain.connect(liveCtx.destination);

      let processFires = 0;
      let nonSilentFires = 0;
      let bytesSent = 0;
      processor.onaudioprocess = (ev) => {
        if (!socket || socket.readyState !== WebSocket.OPEN) return;
        const channelData = ev.inputBuffer.getChannelData(0);
        processFires++;
        // Quick non-silence check — peak amplitude over the buffer.
        let peak = 0;
        for (let i = 0; i < channelData.length; i++) {
          const a = Math.abs(channelData[i]!);
          if (a > peak) peak = a;
        }
        if (peak > 0.01) nonSilentFires++;
        const pcm = floatTo16BitPCM(channelData);
        socket.send(pcm);
        bytesSent += pcm.byteLength;
        // Log every ~2s (≈47 fires at 2048/48kHz). Reveals whether the
        // processor is firing at all and whether mic audio is non-silent.
        if (processFires % 47 === 0) {
          console.log(
            `[stt] audio: ${processFires} fires, ${nonSilentFires} non-silent, ${(bytesSent / 1024).toFixed(1)}KB sent`,
          );
        }
      };
      console.log('[stt] audio graph wired; awaiting onaudioprocess fires');
    } catch (err) {
      console.warn('[stt] mic wire-up failed:', err);
      closeSocket('wire-up-failed');
    }
  };

  let dgMessageCount = 0;
  ws.onmessage = (ev) => {
    dgMessageCount++;
    let data: DeepgramResult;
    try {
      data = JSON.parse(typeof ev.data === 'string' ? ev.data : '') as DeepgramResult;
    } catch {
      console.warn(`[stt] non-JSON Deepgram message #${dgMessageCount}`);
      return;
    }
    if (dgMessageCount <= 3 || dgMessageCount % 20 === 0) {
      console.log(`[stt] Deepgram msg #${dgMessageCount} type=${data.type} is_final=${data.is_final}`);
    }
    if (data.type === 'Results' || (data.channel && data.is_final !== undefined)) {
      const text = data.channel?.alternatives?.[0]?.transcript ?? '';
      if (!text.trim()) return;
      const isFinal = data.is_final === true;
      if (!isFinal) {
        console.log(`[stt] interim: "${text}"`);
        return; // Phase 2: only finals reach the server.
      }
      console.log(`[stt] FINAL transcript → server: "${text}"`);
      const now = Date.now();
      netSend?.({
        type: 'transcript',
        line: { role: 'user', text, at: now },
        final: true,
        speakerName: mySpeakerName ?? undefined,
      });
    }
  };

  ws.onclose = (ev) => {
    socket = null;
    teardownAudio();
    if (stopped) return;
    // Auto-reconnect on token expiry / network blips. Backoff is short
    // since we want fast recovery during a playtest.
    console.warn(`[stt] socket closed code=${ev.code} reason=${ev.reason}; reconnecting in 2s`);
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = null;
      void openSocket();
    }, 2000);
  };

  ws.onerror = (err) => {
    console.warn('[stt] socket error', err);
    // onclose follows automatically; let that path handle reconnect.
  };
};

export const startPlayerStt = async (
  speakerName: string,
  send: (msg: ClientMessage) => void,
): Promise<void> => {
  if (started) return;
  started = true;
  stopped = false;
  mySpeakerName = speakerName;
  netSend = send;
  await openSocket();
};

export const stopPlayerStt = (): void => {
  if (!started) return;
  started = false;
  stopped = true;
  mySpeakerName = null;
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  closeSocket('runtime-stop');
  teardownAudio();
  if (pendingTokenResolve) {
    pendingTokenResolve({ reason: 'stopped' });
    pendingTokenResolve = null;
  }
  netSend = null;
};
