#!/usr/bin/env node
// Set a default `first_message` on every Slipstream Rift ElevenLabs agent.
//
// Production conversations log overrides_applied = { agent: null, ... } —
// meaning the per-session firstMessage override the client sends isn't
// taking effect (SDK key-casing mismatch or override path silently dropped).
// Without a default first_message and without an applied override, the agent
// has nothing to say at session start, the user waits for the NPC to speak,
// nobody speaks, the 30s timeout fires, message_count=0. Setting a default
// first_message makes the agent ALWAYS open the conversation, regardless of
// the override.
//
// The default is each NPC's greetings[0] from packages/shared/src/npc-roster.ts.
// The per-session override can still swap it out for variety on subsequent
// sessions — but if the override path is broken, this default fires.
//
// Usage:
//   node scripts/set-agent-first-messages.mjs --dry-run
//   node scripts/set-agent-first-messages.mjs

import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const API = 'https://api.elevenlabs.io';

// npcId → greetings[0]. Pulled from packages/shared/src/npc-roster.ts at
// authoring time; if the roster grows, re-derive these by hand or extend
// the script to parse the TS source.
const DEFAULT_FIRST_MESSAGES = {
  mira: "Oh — hey. Didn't hear you. You good?",
  guts: 'Mm. You walk loud, kid. What is it.',
  fennel: "Hi! Sorry — I was just looking at something. Hey.",
  rook: '...Yeah?',
  vex: 'Oh, you. Hi. What.',
  jacqueline: 'Oh, hey honey! Come sit a minute. Or stand, whatever\'s easier.',
};

const DRY = process.argv.includes('--dry-run');

const env = await readFile(resolve(ROOT, 'apps/party/.env'), 'utf-8');
const key = env.match(/^ELEVENLABS_API_KEY=(.+)$/m)?.[1].trim();
if (!key) {
  console.error('No ELEVENLABS_API_KEY in apps/party/.env');
  process.exit(1);
}

const list = await fetch(`${API}/v1/convai/agents?page_size=100`, {
  headers: { 'xi-api-key': key },
}).then((r) => r.json());

const matched = (list.agents ?? []).filter((a) => a.name?.startsWith('Slipstream Rift'));
console.log(`matched ${matched.length} agents`);

for (const meta of matched) {
  // "Slipstream Rift — Mira" → "mira"
  const tail = meta.name.split(' — ')[1] ?? '';
  const npcId = { Vicky: 'fennel' }[tail] ?? tail.toLowerCase();
  const fm = DEFAULT_FIRST_MESSAGES[npcId];
  if (!fm) {
    console.log(`# ${meta.name} (${meta.agent_id}): SKIP — no default for npc id "${npcId}"`);
    continue;
  }
  const patch = {
    conversation_config: {
      agent: {
        first_message: fm,
      },
    },
  };
  console.log(`# ${meta.name} (${meta.agent_id})`);
  console.log(`  first_message → ${JSON.stringify(fm)}`);
  if (DRY) continue;
  const r = await fetch(`${API}/v1/convai/agents/${meta.agent_id}`, {
    method: 'PATCH',
    headers: { 'xi-api-key': key, 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!r.ok) {
    console.error('  PATCH failed:', r.status, await r.text());
    continue;
  }
  console.log('  → PATCHed.');
}
