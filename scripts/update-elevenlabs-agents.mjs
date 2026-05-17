#!/usr/bin/env node
// In-place batch update for the ElevenLabs agents that back the NPC roster.
//
// Reads ELEVENLABS_API_KEY from apps/party/.env. Matches agents by name prefix
// (default: "Slipstream NPC — "), then for each matched agent supports:
//
//   --rename                 Rename "<old-prefix> — Mira" → "<new-prefix> — Mira".
//   --secret <hex>           Rotate the `secret` query-param in every webhook tool.
//   --host <https://...>     Repoint every webhook tool URL host part. Anything
//                            before the first `/parties/...` is replaced; the
//                            path is preserved.
//   --old-prefix <str>       Default "Slipstream NPC".
//   --new-prefix <str>       Default "Slipstream Rift".
//   --dry-run                Show the diff without PATCHing.
//   --print-roster           After updating, print the agent IDs as a paste-ready
//                            snippet keyed by NPC id (for local-only edits in
//                            packages/shared/src/npc-roster.ts).
//
// Usage example (live):
//   node scripts/update-elevenlabs-agents.mjs \
//     --rename \
//     --secret $(openssl rand -hex 24) \
//     --host https://slipstream-rift.<your-username>.partykit.dev
//
// Dry-run first to inspect the planned diff:
//   node scripts/update-elevenlabs-agents.mjs --rename --secret abc --host https://... --dry-run
//
// Note: the ElevenLabs PATCH endpoint expects the agent body in the same shape
// returned by GET. We fetch the full agent, mutate selected fields, and PATCH
// the whole thing back. If you change tools through the dashboard while this
// script is running, you'll race; pick a window when nobody's editing.

import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const API = 'https://api.elevenlabs.io';

function parseArgs(argv) {
  const out = {
    rename: false,
    dryRun: false,
    printRoster: false,
    secret: null,
    host: null,
    oldPrefix: 'Slipstream NPC',
    newPrefix: 'Slipstream Rift',
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--rename') out.rename = true;
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--print-roster') out.printRoster = true;
    else if (a === '--secret') out.secret = argv[++i];
    else if (a === '--host') out.host = argv[++i];
    else if (a === '--old-prefix') out.oldPrefix = argv[++i];
    else if (a === '--new-prefix') out.newPrefix = argv[++i];
    else if (a === '--help' || a === '-h') {
      console.log(
        'Usage: node scripts/update-elevenlabs-agents.mjs [--rename] [--secret HEX] [--host URL] [--dry-run] [--print-roster]',
      );
      process.exit(0);
    } else {
      console.error(`Unknown arg: ${a}`);
      process.exit(1);
    }
  }
  return out;
}

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

async function elPatch(path, body, key) {
  const r = await fetch(`${API}${path}`, {
    method: 'PATCH',
    headers: { 'xi-api-key': key, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`PATCH ${path} → ${r.status} ${await r.text()}`);
  return r.json();
}

function mutateAgent(agent, { rename, secret, host, oldPrefix, newPrefix }) {
  const changes = [];
  const patch = {};

  if (rename && agent.name?.startsWith(oldPrefix)) {
    const newName = newPrefix + agent.name.slice(oldPrefix.length);
    patch.name = newName;
    changes.push(`name: "${agent.name}" → "${newName}"`);
  }

  const tools = agent?.conversation_config?.agent?.prompt?.tools;
  if (Array.isArray(tools) && (secret || host)) {
    const nextTools = tools.map((t) => {
      if (t?.type !== 'webhook' || !t?.api_schema) return t;
      const next = JSON.parse(JSON.stringify(t));
      if (host) {
        const url = next.api_schema.url;
        if (typeof url === 'string') {
          const idx = url.indexOf('/parties/');
          if (idx >= 0) {
            const newUrl = host.replace(/\/$/, '') + url.slice(idx);
            if (newUrl !== url) {
              changes.push(`tool[${t.name}].url-host: → ${host}`);
              next.api_schema.url = newUrl;
            }
          }
        }
      }
      if (secret) {
        // Some agents embed ?secret=… directly in the URL string (older
        // setup path); newer ones use query_params_schema. Rewrite both so
        // it doesn't matter which form a given agent uses.
        if (typeof next.api_schema.url === 'string' && /[?&]secret=/.test(next.api_schema.url)) {
          const before = next.api_schema.url;
          next.api_schema.url = before.replace(
            /([?&])secret=[^&]*/g,
            `$1secret=${encodeURIComponent(secret)}`,
          );
          if (next.api_schema.url !== before) {
            changes.push(`tool[${t.name}].url-secret: rotated`);
          }
        }
        if (Array.isArray(next.api_schema.query_params_schema)) {
          next.api_schema.query_params_schema = next.api_schema.query_params_schema.map((q) => {
            if (q?.id === 'secret' && q?.value_type === 'constant') {
              if (q.constant_value !== secret) {
                changes.push(`tool[${t.name}].schema-secret: rotated`);
                return { ...q, constant_value: secret };
              }
            }
            return q;
          });
        }
      }
      return next;
    });
    // GET returns both `tools` (full defs) and `tool_ids` (refs) on the
    // prompt; PATCH rejects sending both (400 "both_tools_and_tool_ids_provided").
    // Strip tool_ids so only the modified tools array goes back.
    const promptCopy = { ...(agent.conversation_config?.agent?.prompt ?? {}) };
    delete promptCopy.tool_ids;
    patch.conversation_config = {
      ...(agent.conversation_config ?? {}),
      agent: {
        ...(agent.conversation_config?.agent ?? {}),
        prompt: {
          ...promptCopy,
          tools: nextTools,
        },
      },
    };
  }

  return { patch, changes };
}

function nameToNpcId(displayName, newPrefix) {
  // "Slipstream Rift — Mira" → "mira"
  // "Slipstream NPC — Vicky" → "fennel" (Vicky is a display name; npc id is 'fennel')
  const map = {
    mira: 'mira',
    guts: 'guts',
    vicky: 'fennel',
    rook: 'rook',
    vex: 'vex',
    jacqueline: 'jacqueline',
  };
  const tail = displayName.split(' — ')[1] ?? displayName;
  const slug = tail.trim().toLowerCase();
  return map[slug] ?? slug;
}

async function main() {
  const args = parseArgs(process.argv);
  const key = await loadApiKey();

  console.log(
    `Plan: rename=${args.rename} secret=${args.secret ? 'rotate' : 'no'} host=${args.host ?? 'no change'} dry-run=${args.dryRun}`,
  );

  const list = await elGet('/v1/convai/agents?page_size=100', key);
  const matched = (list.agents ?? []).filter((a) =>
    a.name?.startsWith(args.oldPrefix) || a.name?.startsWith(args.newPrefix),
  );
  console.log(`Matched ${matched.length} agents.\n`);

  const rosterOut = [];

  for (const meta of matched) {
    const full = await elGet(`/v1/convai/agents/${meta.agent_id}`, key);
    const { patch, changes } = mutateAgent(full, args);
    console.log(`# ${full.name}  (${meta.agent_id})`);
    if (changes.length === 0) {
      console.log('  (no changes)');
    } else {
      for (const c of changes) console.log('  ' + c);
    }
    if (!args.dryRun && changes.length > 0) {
      await elPatch(`/v1/convai/agents/${meta.agent_id}`, patch, key);
      console.log('  → PATCHed.');
    }
    const finalName = patch.name ?? full.name;
    rosterOut.push({ id: nameToNpcId(finalName, args.newPrefix), agentId: meta.agent_id });
    console.log();
  }

  if (args.printRoster) {
    console.log('--- Roster snippet (DO NOT commit; paste into local-only npc-roster.ts) ---');
    for (const r of rosterOut) {
      console.log(`  ${r.id}: '${r.agentId}',`);
    }
  }
}

main().catch((e) => {
  console.error(e.stack || String(e));
  process.exit(1);
});
