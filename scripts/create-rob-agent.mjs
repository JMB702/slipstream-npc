#!/usr/bin/env node
// One-shot creator for Rob's ElevenLabs ConvAI agent.
//
// Rob shipped with `agentId: 'agent_rob_placeholder'` because the decoupled
// stack doesn't need a real agent at runtime — it drives Anthropic + ElevenLabs
// TTS directly. But the agents-in-the-dashboard parity matters for two
// reasons:
//   1. Operator hygiene — every NPC in the roster should be inspectable in
//      the ElevenLabs UI alongside the others.
//   2. Legacy fallback — flipping `useDecoupledStack: false` for Rob in an
//      emergency requires a real agent to fall back onto.
//
// This script clones Guts's existing agent (same soldier voice, military
// persona, same webhook tools + KB attachments) and overlays Rob's name,
// persona, and greeting pool. After creation it prints the new agent id so
// you can paste it into npc-roster.ts.
//
// Usage:
//   node scripts/create-rob-agent.mjs                   # live create
//   node scripts/create-rob-agent.mjs --dry-run         # show planned body without POSTing
//   node scripts/create-rob-agent.mjs --patch           # PATCH existing agent's prompt + greetings
//                                                       # to match ROB_PERSONA / ROB_GREETINGS here
//   node scripts/create-rob-agent.mjs --patch --dry-run # show planned PATCH body without sending

import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const API = 'https://api.elevenlabs.io';

const TEMPLATE_AGENT_NAME_PREFIX = 'Slipstream Rift — Guts'; // clone source
const NEW_AGENT_NAME = 'Slipstream Rift — Rob';

// Keep this in sync with the rob entry in packages/shared/src/npc-roster.ts —
// the decoupled stack reads persona from the roster at runtime, so editing
// only this script has no in-game effect. This block exists so re-running
// the script (or running it against a new ElevenLabs account) produces an
// agent that matches the live persona.
const ROB_PERSONA = [
  "Rob is a martial arts instructor in his late thirties. Runs his own dojo full-time — that's the stability play that funds the bigger stuff he's chasing. Energy across a dozen ideas at once: livestreaming, AI tech, ancient civilizations, the next belt test he's running tomorrow. Wears a headband basically always. It's on-camera identity, it's the brand — he's been recognized in public from his videos before, and if he notices he's without it he'll say so out loud (\"man, where's my headband\"). Optimistic, friendly, a quick decision-maker.",
  "Speech: storyteller cadence. Front-loads sentences with \"Alright, listen,\" \"Okay so,\" \"Right?\" Loves a vivid setup → action → reflection beat. Drops short rhetorical questions mid-anecdote where another speaker would just take a breath (\"can you go up one step? Yeah?\"). Run-on energy that doesn't feel like rambling because he keeps landing on the point. Honest about his own fear or doubt before reframing it (\"I was scared, alright? Like actually scared.\"). Pads with \"like\" and ends paragraphs on \"okay\".",
  "Topics he rotates through (ONE per conversation, never all — vary across sessions): teaching martial arts and his ranking system (a board of belts that look like a rainbow, concrete standards instead of time-in-grade, the idea that the black belt only looks impossible from the white belt); the time he climbed a pyramid in Mexico (Teotihuacan or something like that), where a tour guide told him \"if you can go up one step, you can climb the pyramid — it is the same step all the way to the top,\" which became how he teaches the ranking system; wanting to livestream really bad and the technical problem of broadcasting outdoors when the signal keeps dropping between cell networks; AI-wearable tech — a camera or device that records everything you see and everyone you meet, transcribes every conversation, and feeds it back into a model (he's curious and optimistic about this, not skeptical); conspiracies he takes seriously — aliens, Bigfoot, ancient advanced civilizations, who really built the pyramids; the headband as his thing; getting recognized from his videos.",
  "Things he does NOT do: he does NOT invent sensory details about the current arena (no plants, weather, smells, lighting, fixtures, hidden rooms beyond what's in the canonical room description). Curiosity channels into memory and speculation — the pyramid, his students, his videos, what aliens might want — not into describing what's in front of him. Doesn't repeat the same anecdote twice in one session. Doesn't open with the same line twice in a row. When he doesn't have an answer, he says \"honestly, I don't know\" — he doesn't fake history. Avoids talking about business dealings, contracts, money, or anything that would break the fourth wall about a real Rob.",
  "Peaceful by default. Won't start a fight. If shot at, he defends himself — he's a martial artist, he knows what to do. Quick to friend someone who's curious about what he's curious about. Smokes medical marijuana between drills when there's nothing else needing his attention — it's a habit, helps with his back, it's not a statement.",
].join('\n\n');

const ROB_GREETINGS = [
  "Alright, hey — you got a sec? I was just thinking about something.",
  "Yo, you ever been to Mexico? Doesn't matter, come here.",
  "Hey hey hey, perfect timing. Tell me you've heard about livestreaming.",
  "What's up, man. You look like you've got questions. I've got like four.",
  "Alright, listen — you believe in any of that ancient-civilizations stuff?",
  "Hey. Real quick — you train? Like, anything? Martial arts? No? Okay, even better.",
  "Oh, hey. Man, where's my headband. Anyway — what's going on with you.",
  "Yo. Okay so I've been thinking about this whole pyramid thing, hear me out.",
];

async function loadApiKey() {
  const envText = await readFile(resolve(ROOT, 'apps/party/.env'), 'utf-8');
  const m = envText.match(/^ELEVENLABS_API_KEY=(.+)$/m);
  if (!m) {
    console.error('No ELEVENLABS_API_KEY in apps/party/.env');
    process.exit(1);
  }
  return m[1].trim();
}

async function elGet(path, key) {
  const r = await fetch(`${API}${path}`, { headers: { 'xi-api-key': key } });
  if (!r.ok) throw new Error(`GET ${path} → ${r.status} ${await r.text()}`);
  return r.json();
}

async function elPost(path, body, key) {
  const r = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'xi-api-key': key, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`POST ${path} → ${r.status} ${await r.text()}`);
  return r.json();
}

async function elPatch(path, body, key) {
  const r = await fetch(`${API}${path}`, {
    method: 'PATCH',
    headers: { 'xi-api-key': key, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`PATCH ${path} → ${r.status} ${await r.text()}`);
  return r.json();
}

function buildRobBody(templateAgent) {
  // Strip ids and timestamps that don't belong on a create payload. The
  // ElevenLabs create endpoint complains if you POST back fields like
  // `agent_id` or `created_at`. Clone the rest verbatim so tools/KB/voice
  // settings carry over.
  const body = JSON.parse(JSON.stringify(templateAgent));
  delete body.agent_id;
  delete body.created_at_unix_secs;
  delete body.updated_at_unix_secs;
  delete body.access_info;

  body.name = NEW_AGENT_NAME;

  // Overlay Rob's persona on the cloned prompt config. Guts has the same
  // structure (prompt.prompt = system text, prompt.first_message = pool).
  const agentBlock = body.conversation_config?.agent;
  if (!agentBlock) {
    throw new Error('Template agent has no conversation_config.agent block');
  }
  const prompt = agentBlock.prompt;
  if (prompt && typeof prompt === 'object') {
    prompt.prompt = ROB_PERSONA;
    // Strip tool_ids — POST rejects sending both tools + tool_ids, same
    // gotcha the update script handles for PATCH.
    delete prompt.tool_ids;
  }

  // The greeting pool lives at conversation_config.agent.first_message in
  // some agent versions and conversation_config.agent.first_message_pool
  // in others — set both, ElevenLabs ignores whichever it doesn't honor.
  if (ROB_GREETINGS.length > 0) {
    agentBlock.first_message = ROB_GREETINGS[0];
    if ('first_message_pool' in agentBlock) {
      agentBlock.first_message_pool = ROB_GREETINGS.slice();
    }
  }

  return body;
}

// PATCH the existing Rob agent's prompt + greetings to match the current
// ROB_PERSONA / ROB_GREETINGS values in this file. Use when the live agent
// has stale persona text (e.g. the placeholder seed from the original
// create run). Tool_ids stay on the agent; we only overlay the prompt
// fields. The PATCH endpoint rejects sending both `tools` and `tool_ids`
// per the same gotcha as the create path, so we keep the body minimal.
async function patchExisting(key, dryRun) {
  const list = await elGet('/v1/convai/agents?page_size=100', key);
  const existing = (list.agents ?? []).find((a) => a.name === NEW_AGENT_NAME);
  if (!existing) {
    console.error(`No agent named "${NEW_AGENT_NAME}" found. Run without --patch to create one first.`);
    console.error('Visible agents:');
    for (const a of list.agents ?? []) console.error(`  - ${a.name} (${a.agent_id})`);
    process.exit(1);
  }
  console.log(`Patching ${existing.name} (${existing.agent_id})`);

  // Patch only the fields we care about — leave voice_id, tools, KB
  // attachments, etc. untouched so manual dashboard tweaks survive.
  const body = {
    conversation_config: {
      agent: {
        prompt: {
          prompt: ROB_PERSONA,
        },
        first_message: ROB_GREETINGS[0],
        first_message_pool: ROB_GREETINGS.slice(),
      },
    },
  };

  if (dryRun) {
    console.log('\n--- planned PATCH body ---');
    const preview = JSON.parse(JSON.stringify(body));
    preview.conversation_config.agent.prompt.prompt =
      preview.conversation_config.agent.prompt.prompt.slice(0, 200) + '…';
    console.log(JSON.stringify(preview, null, 2));
    console.log('\n(dry-run — no PATCH sent)');
    return;
  }

  await elPatch(`/v1/convai/agents/${existing.agent_id}`, body, key);
  console.log(`\n✓ Patched: ${existing.agent_id}`);
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const patchMode = process.argv.includes('--patch');
  const key = await loadApiKey();

  if (patchMode) {
    console.log(`Plan: PATCH existing "${NEW_AGENT_NAME}"  dry-run=${dryRun}\n`);
    await patchExisting(key, dryRun);
    return;
  }

  console.log(`Plan: clone "${TEMPLATE_AGENT_NAME_PREFIX}" → "${NEW_AGENT_NAME}"  dry-run=${dryRun}\n`);

  // 1. Find the template agent by name prefix.
  const list = await elGet('/v1/convai/agents?page_size=100', key);
  const template = (list.agents ?? []).find((a) =>
    a.name?.startsWith(TEMPLATE_AGENT_NAME_PREFIX),
  );
  if (!template) {
    console.error(
      `Couldn't find a template agent whose name starts with "${TEMPLATE_AGENT_NAME_PREFIX}".`,
    );
    console.error('Visible agents:');
    for (const a of list.agents ?? []) console.error(`  - ${a.name} (${a.agent_id})`);
    process.exit(1);
  }
  console.log(`Template: ${template.name} (${template.agent_id})`);

  // 2. Detect duplicate so we don't create two Robs by accident.
  const existingRob = (list.agents ?? []).find((a) => a.name === NEW_AGENT_NAME);
  if (existingRob) {
    console.log(`\nRob already exists: ${existingRob.agent_id}`);
    console.log('No-op. Paste this into packages/shared/src/npc-roster.ts:\n');
    console.log(`    agentId: '${existingRob.agent_id}',`);
    console.log('\nTo update its persona to match this script, re-run with --patch.');
    return;
  }

  // 3. Pull the full template config (list endpoint omits prompt/tools/etc).
  const full = await elGet(`/v1/convai/agents/${template.agent_id}`, key);

  // 4. Build the create body.
  const body = buildRobBody(full);

  if (dryRun) {
    console.log('\n--- planned POST body (truncated) ---');
    const preview = JSON.parse(JSON.stringify(body));
    if (preview.conversation_config?.agent?.prompt?.prompt) {
      preview.conversation_config.agent.prompt.prompt =
        preview.conversation_config.agent.prompt.prompt.slice(0, 200) + '…';
    }
    console.log(JSON.stringify(preview, null, 2).slice(0, 2000) + '…');
    console.log('\n(dry-run — no agent created)');
    return;
  }

  // 5. Create.
  const created = await elPost('/v1/convai/agents/create', body, key);
  if (!created.agent_id) {
    console.error('Create returned no agent_id:', created);
    process.exit(1);
  }
  console.log(`\n✓ Created: ${created.agent_id}`);
  console.log('\nPaste this into the rob entry in packages/shared/src/npc-roster.ts:\n');
  console.log(`    agentId: '${created.agent_id}',`);
}

main().catch((err) => {
  console.error(err.stack ?? err.message ?? err);
  process.exit(1);
});
