// Anthropic Messages API streaming wrapper. Yields a discriminated union
// of {text, tool_use} events so the orchestrator can route tool_use calls
// to the existing game-side handlers (follow_player, patrol, lean_wall,
// drink_coffee, etc.) while text continues to stream into the TTS pipeline.
//
// Why Haiku: latency. The fast path is "player stopped talking → first
// audio chunk in <=1.8s" and Haiku's TTFB is ~600ms vs Sonnet's 1.5s+.

const API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

export interface LlmToolSchema {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, { type: string; description?: string; enum?: string[] }>;
    required?: string[];
  };
}

export interface LlmCallOptions {
  apiKey: string;
  model: string;
  system: string;
  userText: string;
  maxTokens: number;
  // Optional Anthropic tool definitions. When present, the model can emit
  // tool_use blocks in its response; the caller routes them via the
  // dispatcher. The model's text response continues to stream in parallel.
  tools?: LlmToolSchema[];
  // Optional abort signal so the turn-state machine can cancel mid-stream
  // when the player barges in.
  signal?: AbortSignal;
}

export type LlmEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool_use'; name: string; id: string; input: unknown };

interface SsePayload {
  type: string;
  index?: number;
  content_block?: {
    type?: string;
    id?: string;
    name?: string;
    input?: unknown;
  };
  delta?: { type?: string; text?: string; partial_json?: string };
}

const parseSseLine = (line: string): SsePayload | null => {
  if (!line.startsWith('data:')) return null;
  const raw = line.slice(5).trim();
  if (!raw || raw === '[DONE]') return null;
  try {
    return JSON.parse(raw) as SsePayload;
  } catch {
    return null;
  }
};

interface BlockState {
  type: 'text' | 'tool_use' | 'other';
  name?: string;
  id?: string;
  jsonBuf: string;
}

// AsyncIterable of LLM events. On Anthropic error the generator throws;
// callers should wrap in try.
export async function* streamLlmEvents(
  opts: LlmCallOptions,
): AsyncGenerator<LlmEvent, void, void> {
  const body: Record<string, unknown> = {
    model: opts.model,
    max_tokens: opts.maxTokens,
    system: opts.system,
    messages: [{ role: 'user', content: opts.userText }],
    stream: true,
  };
  if (opts.tools && opts.tools.length > 0) body.tools = opts.tools;

  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'x-api-key': opts.apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: opts.signal,
  });

  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => '');
    throw new Error(`anthropic ${res.status}: ${text.slice(0, 400)}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  const blocks = new Map<number, BlockState>();

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      const evt = parseSseLine(line);
      if (!evt) continue;

      if (evt.type === 'content_block_start' && evt.index !== undefined) {
        const cb = evt.content_block;
        if (cb?.type === 'tool_use' && cb.name) {
          blocks.set(evt.index, { type: 'tool_use', name: cb.name, id: cb.id, jsonBuf: '' });
        } else if (cb?.type === 'text') {
          blocks.set(evt.index, { type: 'text', jsonBuf: '' });
        } else {
          blocks.set(evt.index, { type: 'other', jsonBuf: '' });
        }
        continue;
      }

      if (evt.type === 'content_block_delta' && evt.index !== undefined) {
        const state = blocks.get(evt.index);
        if (!state) continue;
        if (evt.delta?.type === 'text_delta' && evt.delta.text) {
          yield { type: 'text', delta: evt.delta.text };
        } else if (evt.delta?.type === 'input_json_delta' && evt.delta.partial_json !== undefined) {
          state.jsonBuf += evt.delta.partial_json;
        }
        continue;
      }

      if (evt.type === 'content_block_stop' && evt.index !== undefined) {
        const state = blocks.get(evt.index);
        if (!state) continue;
        if (state.type === 'tool_use' && state.name) {
          let parsed: unknown = {};
          try {
            parsed = state.jsonBuf ? JSON.parse(state.jsonBuf) : {};
          } catch (err) {
            console.warn(`[llm] tool_use ${state.name} bad json: ${state.jsonBuf}`, err);
            parsed = {};
          }
          yield { type: 'tool_use', name: state.name, id: state.id ?? '', input: parsed };
        }
        blocks.delete(evt.index);
        continue;
      }

      if (evt.type === 'message_stop') {
        return;
      }
    }
  }
}
