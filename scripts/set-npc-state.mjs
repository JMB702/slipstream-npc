#!/usr/bin/env node
// Persona-delta CLI — add / list / clear durable changes to an NPC's
// self-knowledge. These layer on top of the baked persona via memoryBlob's
// "## What's changed about you" section. Use sparingly: this is for
// in-fiction changes the persona can't anticipate, not routine tuning.
//
// Usage:
//   node scripts/set-npc-state.mjs <npcId> "<summary>" [--evidence="..."] [--source=script:Jeff]
//   node scripts/set-npc-state.mjs --list <npcId>
//   node scripts/set-npc-state.mjs --clear <npcId>
//
// Examples:
//   node scripts/set-npc-state.mjs mira "Your shoulder pain is gone — Jeff helped you on 5/16." \
//     --evidence="See your conversation with Jeff on 5/16 9:35-9:56 AM."
//   node scripts/set-npc-state.mjs --list mira
//
// Reads ELEVENLABS_AGENT_TOOL_SECRET from apps/party/.env. Targets the
// local dev server by default; override with PARTY_HOST env var.

import { readFile } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const ENV_FILE = join(REPO_ROOT, 'apps/party/.env');
const HOST = process.env.PARTY_HOST ?? 'http://localhost:1999';
const ROOM = process.env.PARTY_ROOM ?? 'fps_shooter';

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.findIndex((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (i < 0) return undefined;
  const a = args[i];
  args.splice(i, 1);
  if (a.includes('=')) return a.slice(a.indexOf('=') + 1);
  const next = args[i];
  if (next && !next.startsWith('--')) {
    args.splice(i, 1);
    return next;
  }
  return true;
};

const isList = flag('list');
const isClear = flag('clear');
const evidence = flag('evidence');
const source = flag('source') ?? 'script:cli';

const envTxt = await readFile(ENV_FILE, 'utf8');
const secret = (envTxt.match(/^ELEVENLABS_AGENT_TOOL_SECRET=(.+)$/m) ?? [])[1]?.trim();
if (!secret) {
  console.error('ELEVENLABS_AGENT_TOOL_SECRET not found in apps/party/.env');
  process.exit(1);
}

const base = `${HOST}/parties/main/${ROOM}/admin/npc-state`;

const fail = (msg) => {
  console.error(msg);
  process.exit(1);
};

if (isList) {
  const npcId = typeof isList === 'string' ? isList : args[0];
  if (!npcId) fail('Usage: --list <npcId>');
  const res = await fetch(`${base}?npcId=${encodeURIComponent(npcId)}&secret=${encodeURIComponent(secret)}`, {
    method: 'GET',
  });
  const body = await res.text();
  console.log(`HTTP ${res.status}`);
  try {
    const parsed = JSON.parse(body);
    if (parsed.entries) {
      console.log(`${parsed.entries.length} entries for ${npcId}:`);
      for (const [i, e] of parsed.entries.entries()) {
        console.log(`  [${i}] ${new Date(e.at).toLocaleString()} — ${e.summary}`);
        if (e.evidence) console.log(`       evidence: ${e.evidence}`);
        console.log(`       source: ${e.source}`);
      }
    } else console.log(parsed);
  } catch {
    console.log(body);
  }
  process.exit(0);
}

if (isClear) {
  const npcId = typeof isClear === 'string' ? isClear : args[0];
  if (!npcId) fail('Usage: --clear <npcId>');
  const res = await fetch(`${base}?npcId=${encodeURIComponent(npcId)}&secret=${encodeURIComponent(secret)}`, {
    method: 'DELETE',
  });
  console.log(`HTTP ${res.status} — ${await res.text()}`);
  process.exit(res.ok ? 0 : 1);
}

const [npcId, summary] = args;
if (!npcId || !summary) {
  fail(
    'Usage:\n  set-npc-state.mjs <npcId> "<summary>" [--evidence="..."] [--source=X]\n  set-npc-state.mjs --list <npcId>\n  set-npc-state.mjs --clear <npcId>',
  );
}

const res = await fetch(`${base}?secret=${encodeURIComponent(secret)}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    npcId,
    summary,
    ...(evidence ? { evidence } : {}),
    source,
  }),
});
console.log(`HTTP ${res.status} — ${await res.text()}`);
process.exit(res.ok ? 0 : 1);
