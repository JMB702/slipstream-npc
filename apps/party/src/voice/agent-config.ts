// ElevenLabs Agent config fetcher.
//
// The decoupled stack normally reads voice ids from the per-character
// VOICE_BY_CHARACTER map at build time. That requires editing code every
// time you want to swap a voice. This module fetches the voice id from the
// agent's live config on ElevenLabs instead, so changing the voice in the
// ElevenLabs UI propagates to the game on the next NPC turn (after the
// cache TTL elapses, or after `invalidateAgentVoiceCache(agentId)` is called).
//
// Resolution order (consumed by orchestrator.ts):
//   1. Live ElevenLabs Agent voice (this module)
//   2. NpcDef.voiceId hard override
//   3. VOICE_BY_CHARACTER fallback
//
// The cache prevents hammering the API: one fetch per agent per TTL window.
// Set TTL_MS short for fast UI iteration, long for production efficiency.

interface CacheEntry {
  voiceId: string;
  until: number;
}

const cache = new Map<string, CacheEntry>();

// Cache TTL. 30s feels live in playtests; raise to a few minutes for prod.
const TTL_MS = 30_000;

// In-flight de-dup: if 5 NPC turns spin up at once, we don't want 5 GETs.
const inFlight = new Map<string, Promise<string | null>>();

const isUsableAgentId = (agentId: string | undefined | null): boolean =>
  typeof agentId === 'string' &&
  agentId.length > 0 &&
  !agentId.toLowerCase().includes('placeholder');

const fetchAgentVoiceId = async (
  agentId: string,
  apiKey: string,
): Promise<string | null> => {
  try {
    const res = await fetch(
      `https://api.elevenlabs.io/v1/convai/agents/${encodeURIComponent(agentId)}`,
      { headers: { 'xi-api-key': apiKey } },
    );
    if (!res.ok) {
      console.warn(
        `[agent-config] GET agent ${agentId} → ${res.status} ${res.statusText}`,
      );
      return null;
    }
    const data = (await res.json()) as {
      conversation_config?: { tts?: { voice_id?: string } };
    };
    const voiceId = data?.conversation_config?.tts?.voice_id;
    if (typeof voiceId === 'string' && voiceId.length > 0) return voiceId;
    return null;
  } catch (err) {
    console.warn(`[agent-config] fetch failed for ${agentId}:`, err);
    return null;
  }
};

// Returns the voice id currently set on the ElevenLabs agent, or null if the
// agent id is a placeholder, the API key is missing, or the fetch fails.
// Null lets the caller fall through to its existing fallbacks instead of
// blocking the turn on a transient API hiccup.
export const getAgentVoiceId = async (
  agentId: string | undefined | null,
  apiKey: string | undefined | null,
): Promise<string | null> => {
  if (!isUsableAgentId(agentId)) return null;
  if (!apiKey) return null;
  const id = agentId as string;
  const key = apiKey as string;

  const hit = cache.get(id);
  if (hit && hit.until > Date.now()) return hit.voiceId;

  const existing = inFlight.get(id);
  if (existing) return existing;

  const promise = fetchAgentVoiceId(id, key).then((voiceId) => {
    inFlight.delete(id);
    if (voiceId) cache.set(id, { voiceId, until: Date.now() + TTL_MS });
    return voiceId;
  });
  inFlight.set(id, promise);
  return promise;
};

// Admin hook: drop one agent's cache, or all of them. Wired into the
// /admin/voice-cache route so a save-in-UI → invalidate → next turn cycle
// can propagate a voice change faster than the TTL window.
export const invalidateAgentVoiceCache = (agentId?: string): void => {
  if (agentId) cache.delete(agentId);
  else cache.clear();
};
