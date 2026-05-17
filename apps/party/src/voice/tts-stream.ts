// ElevenLabs streaming TTS over WebSocket. Takes an async iterable of
// text deltas (from llm.ts) and yields binary audio chunks (MP3 frames)
// as soon as ElevenLabs returns them. The Cloudflare Workers runtime that
// powers PartyKit DOs supports WebSockets natively.
//
// API: wss://api.elevenlabs.io/v1/text-to-speech/<voice_id>/stream-input
// Auth: xi-api-key as a Sec-WebSocket-Protocol entry. Workers WebSocket
// constructor accepts a `protocols` array.
//
// Protocol sketch (the docs lag the live API; this matches what works in
// Nov 2024):
//   client → server: { "text": "<persona space>" }            (BOS, empty)
//   client → server: { "text": "delta text " }                (incremental)
//   client → server: { "text": "more text " }
//   client → server: { "text": "", "flush": true }            (force gen)
//   client → server: { "text": "" }                           (EOS)
//   server → client: { "audio": "<b64 mp3 chunk>", "alignment": ... }
//   server → client: { "audio": null, "isFinal": true }       (done)
//
// The `flush: true` after small chunks of text trades a bit of latency for
// "fewer / more natural" generation boundaries. For game voice chat we want
// audio to start as fast as possible, so we flush at the FIRST punctuation
// and at every clause/sentence boundary thereafter.

export interface TtsCallOptions {
  apiKey: string;
  voiceId: string;
  modelId: string;
  // Async iterable of text deltas — typically from streamLlmTextDeltas.
  textDeltas: AsyncIterable<string>;
  // Aborts the upstream TTS request when the user barges in. Closes the
  // socket, draining no further chunks.
  signal?: AbortSignal;
}

export interface TtsAudioChunk {
  // Base64-encoded MP3 chunk, ready to forward to the client.
  audioB64: string;
  // Monotonic per-utterance index. Client uses this to drop out-of-order
  // chunks if the WS reorders (it shouldn't, but cheap insurance).
  chunkIdx: number;
}

interface TtsInbound {
  audio?: string | null;
  isFinal?: boolean;
}

// Decide whether to send `flush: true` after appending `delta`. We flush
// at sentence/clause boundaries to keep generation latency low without
// chopping mid-word. Conservative — over-flushing causes flat prosody.
const shouldFlushAfter = (delta: string): boolean =>
  /[\.!?\,\;\:\-\—]\s*$/.test(delta);

// Buffer feed from the LLM and the inbound audio stream are interleaved
// via a single shared Promise.race-style queue. We can't await the LLM
// generator in parallel with the WS message loop without a queue, so the
// implementation pushes onto an in-memory list and resolves a waiter.
export async function* streamTts(
  opts: TtsCallOptions,
): AsyncGenerator<TtsAudioChunk, void, void> {
  const url =
    `wss://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(opts.voiceId)}` +
    `/stream-input?model_id=${encodeURIComponent(opts.modelId)}&output_format=mp3_44100_128`;

  // ElevenLabs streaming WS doesn't authenticate via subprotocol — the
  // xi_api_key MUST be in the first JSON message body. Browsers can't set
  // custom WS headers, so the init-message pattern is the canonical path
  // (per their docs) and works identically from Cloudflare Workers.
  const ws = new WebSocket(url);

  // Outbound: send BOS once open; then drain LLM deltas + send `flush`
  // markers; then send EOS when LLM is done.
  const queue: TtsAudioChunk[] = [];
  let queueResolve: (() => void) | null = null;
  let queueClosed = false;
  let queueError: unknown = null;
  let chunkIdx = 0;

  const pushChunk = (c: TtsAudioChunk): void => {
    queue.push(c);
    queueResolve?.();
    queueResolve = null;
  };
  const closeQueue = (): void => {
    queueClosed = true;
    queueResolve?.();
    queueResolve = null;
  };
  const failQueue = (err: unknown): void => {
    queueError = err;
    queueClosed = true;
    queueResolve?.();
    queueResolve = null;
  };

  const onAbort = (): void => {
    try {
      ws.close(1000, 'aborted');
    } catch {
      // already closed
    }
    closeQueue();
  };
  opts.signal?.addEventListener('abort', onAbort);

  ws.addEventListener('message', (ev) => {
    try {
      const raw = typeof ev.data === 'string' ? ev.data : '';
      if (!raw) return;
      const msg = JSON.parse(raw) as TtsInbound;
      if (msg.audio) {
        pushChunk({ audioB64: msg.audio, chunkIdx: chunkIdx++ });
      }
      if (msg.isFinal) {
        try {
          ws.close(1000, 'final');
        } catch {
          // already closed
        }
        closeQueue();
      }
    } catch (err) {
      console.warn('[tts] message parse failed:', err);
    }
  });

  ws.addEventListener('close', () => {
    closeQueue();
  });

  ws.addEventListener('error', (err) => {
    failQueue(err);
  });

  // Wait for socket to open before piping text. ElevenLabs WS rejects
  // payloads before the handshake completes.
  await new Promise<void>((resolve, reject) => {
    const onOpen = (): void => {
      ws.removeEventListener('error', onErr);
      resolve();
    };
    const onErr = (err: Event): void => {
      ws.removeEventListener('open', onOpen);
      reject(err);
    };
    ws.addEventListener('open', onOpen, { once: true });
    ws.addEventListener('error', onErr, { once: true });
  });

  // BOS — empty initial message primes the synthesizer + carries the
  // xi_api_key field that authenticates this connection. ElevenLabs
  // rejects subsequent messages until this is sent. voice_settings
  // ride along here too.
  ws.send(
    JSON.stringify({
      text: ' ',
      voice_settings: { stability: 0.4, similarity_boost: 0.6, speed: 1.0 },
      xi_api_key: opts.apiKey,
    }),
  );

  // Producer task: drain LLM deltas → send to WS. Runs in parallel with
  // the consumer (this generator). On completion, send the EOS marker.
  const producer = (async () => {
    try {
      for await (const delta of opts.textDeltas) {
        if (queueClosed) return;
        ws.send(
          JSON.stringify({
            text: delta,
            ...(shouldFlushAfter(delta) ? { flush: true } : {}),
          }),
        );
      }
      // EOS: empty text tells ElevenLabs there is no more input. The
      // server then drains remaining audio + sends isFinal=true and
      // closes the socket on its end.
      ws.send(JSON.stringify({ text: '' }));
    } catch (err) {
      failQueue(err);
      try {
        ws.close(1011, 'producer-error');
      } catch {
        // already closed
      }
    }
  })();

  try {
    while (true) {
      if (queue.length > 0) {
        yield queue.shift()!;
        continue;
      }
      if (queueClosed) {
        if (queueError) throw queueError;
        return;
      }
      await new Promise<void>((resolve) => {
        queueResolve = resolve;
      });
    }
  } finally {
    opts.signal?.removeEventListener('abort', onAbort);
    // Await the producer task so it doesn't leak past generator
    // termination. We don't care about its result, only that it finishes.
    await producer.catch(() => {});
  }
}
