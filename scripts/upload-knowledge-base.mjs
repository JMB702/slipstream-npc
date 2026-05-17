#!/usr/bin/env node
// Sync the World Bible (backstory + per-map docs) into the ElevenLabs
// knowledge base for every NPC agent. Run this whenever you edit one of
// the docs/*.html files. The script:
//
//   1. Reads docs/backstory.html, docs/map-fps-shooter.html,
//      docs/map-arena.html.
//   2. Strips the UI chrome (toolbar, doc-nav, the warn callout that
//      tells YOU to run this script) and converts the remainder to
//      plain text with light markdown for headings and lists.
//   3. Deletes any prior knowledge base documents with our canonical
//      names. (We replace, not version — agents pick up the new content
//      on the next session.)
//   4. Creates fresh documents via POST /v1/convai/knowledge-base/text.
//   5. PATCHes every NPC agent so its conversation_config.agent.prompt
//      .knowledge_base array references the three new doc IDs, leaving
//      any unrelated knowledge_base entries on the agent alone.
//
// Pass --dry-run to print what would happen without making any changes.
//
// API key is read from apps/party/.env (ELEVENLABS_API_KEY). Agent IDs
// are scraped out of packages/shared/src/npc-roster.ts so renaming or
// re-seeding agents auto-updates the script.

import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const DRY_RUN = process.argv.includes('--dry-run');

const DOCS = [
  { file: 'backstory.html', name: 'Slipstream Backstory' },
  { file: 'map-fps-shooter.html', name: 'Slipstream Map: FPS Shooter Arena' },
  { file: 'map-arena.html', name: 'Slipstream Map: Original Arena' },
];

// Legacy KB document names that this script should also clean up (delete
// from the knowledge base and remove from each agent's knowledge_base
// list). Add to this list if we rename canonical docs.
const LEGACY_NAMES = ['Slipstream World Bible'];

const API = 'https://api.elevenlabs.io';

function log(...args) {
  console.log(DRY_RUN ? '[dry-run]' : '          ', ...args);
}

// ---------- HTML → text ----------

// Walk forward from `from` counting <div> opens and closes to find the
// position right after the matching </div>. Assumes well-formed input.
function endOfDiv(html, from) {
  let depth = 1;
  let i = from;
  while (i < html.length && depth > 0) {
    const open = html.indexOf('<div', i);
    const close = html.indexOf('</div>', i);
    if (close === -1) return html.length;
    if (open !== -1 && open < close) {
      depth++;
      i = open + 4;
    } else {
      depth--;
      i = close + 6;
    }
  }
  return i;
}

// Remove every <div ... matching `re` ...>...</div> from the string,
// respecting nested divs.
function stripDivs(html, re) {
  let result = html;
  while (true) {
    const m = result.match(re);
    if (!m) break;
    const start = m.index;
    const after = endOfDiv(result, start + m[0].length);
    result = result.slice(0, start) + result.slice(after);
  }
  return result;
}

function htmlToText(html) {
  // Drop everything outside <body>...</body>
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*)<\/body>/i);
  let text = bodyMatch ? bodyMatch[1] : html;

  // Drop <script> and <style> blocks
  text = text.replace(/<script[\s\S]*?<\/script>/gi, '');
  text = text.replace(/<style[\s\S]*?<\/style>/gi, '');

  // Drop UI chrome divs (toolbar, doc-nav, warn callout)
  text = stripDivs(text, /<div\s+id="toolbar"[^>]*>/i);
  text = stripDivs(text, /<div\s+class="doc-nav"[^>]*>/i);
  text = stripDivs(text, /<div\s+class="callout warn"[^>]*>/i);

  // Headings → markdown
  text = text.replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, '\n\n# $1\n\n');
  text = text.replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, '\n\n## $1\n\n');
  text = text.replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, '\n\n### $1\n\n');

  // List items
  text = text.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, '- $1\n');
  text = text.replace(/<\/?(ul|ol)[^>]*>/gi, '\n');

  // Paragraphs
  text = text.replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, '$1\n\n');

  // Strip remaining tags
  text = text.replace(/<\/?(strong|b|em|i|code|span|div|hr|br|a)[^>]*>/gi, ' ');
  text = text.replace(/<[^>]+>/g, '');

  // Decode entities
  text = text
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&mdash;/g, '—')
    .replace(/&ndash;/g, '–');

  // Collapse whitespace
  text = text
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return text;
}

// ---------- Config loading ----------

async function loadApiKey() {
  const envText = await readFile(resolve(ROOT, 'apps/party/.env'), 'utf-8');
  const match = envText.match(/^ELEVENLABS_API_KEY=(.+)$/m);
  if (!match) {
    throw new Error('ELEVENLABS_API_KEY not found in apps/party/.env');
  }
  return match[1].trim().replace(/^["']|["']$/g, '');
}

async function loadAgents() {
  const rosterText = await readFile(
    resolve(ROOT, 'packages/shared/src/npc-roster.ts'),
    'utf-8',
  );
  // Match each NpcDef entry's id / name / agentId triple in declaration order.
  const re = /id:\s*'([^']+)',\s*name:\s*'([^']+)',\s*agentId:\s*'([^']+)'/g;
  const out = [];
  for (const m of rosterText.matchAll(re)) {
    if (m[3].startsWith('TODO_')) continue;
    out.push({ id: m[1], name: m[2], agentId: m[3] });
  }
  return out;
}

// ---------- ElevenLabs API helpers ----------

async function apiFetch(apiKey, path, init = {}) {
  const resp = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      'xi-api-key': apiKey,
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...(init.headers ?? {}),
    },
  });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`${init.method ?? 'GET'} ${path} → ${resp.status}: ${body}`);
  }
  const ct = resp.headers.get('content-type') ?? '';
  return ct.includes('application/json') ? resp.json() : resp.text();
}

async function listKnowledgeBase(apiKey) {
  // Endpoint paginates; pull pages until empty.
  const all = [];
  let cursor = null;
  for (let page = 0; page < 50; page++) {
    const qs = new URLSearchParams({ page_size: '100' });
    if (cursor) qs.set('cursor', cursor);
    const data = await apiFetch(apiKey, `/v1/convai/knowledge-base?${qs}`);
    const docs = data.documents ?? data.knowledge_base ?? [];
    all.push(...docs);
    cursor = data.next_cursor ?? data.cursor ?? null;
    if (!cursor || docs.length === 0) break;
  }
  return all;
}

async function deleteKnowledgeBaseDoc(apiKey, id) {
  return apiFetch(apiKey, `/v1/convai/knowledge-base/${id}`, { method: 'DELETE' });
}

async function createKnowledgeBaseTextDoc(apiKey, name, text) {
  return apiFetch(apiKey, '/v1/convai/knowledge-base/text', {
    method: 'POST',
    body: JSON.stringify({ name, text }),
  });
}

async function getAgent(apiKey, agentId) {
  return apiFetch(apiKey, `/v1/convai/agents/${agentId}`);
}

async function patchAgent(apiKey, agentId, body) {
  return apiFetch(apiKey, `/v1/convai/agents/${agentId}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
}

// ---------- Main ----------

async function main() {
  log(`Working directory: ${ROOT}`);
  log(DRY_RUN ? 'DRY RUN — no changes will be made.' : 'LIVE RUN — making changes.');

  const apiKey = await loadApiKey();
  log(`Loaded API key: ${apiKey.slice(0, 6)}…${apiKey.slice(-4)}`);

  const agents = await loadAgents();
  if (agents.length === 0) {
    throw new Error('No agents with real agentIds found in npc-roster.ts');
  }
  log(`Found ${agents.length} NPC agents:`);
  for (const a of agents) log(`  - ${a.name.padEnd(12)} ${a.agentId}`);

  // Build text documents from HTML files
  const textDocs = [];
  for (const { file, name } of DOCS) {
    const html = await readFile(resolve(ROOT, 'docs', file), 'utf-8');
    const text = htmlToText(html);
    log(`Prepared "${name}" from docs/${file} (${text.length} chars)`);
    textDocs.push({ file, name, text });
  }

  if (DRY_RUN) {
    log('--- Preview of first doc ---');
    console.log(textDocs[0].text.slice(0, 600) + (textDocs[0].text.length > 600 ? '\n…' : ''));
    log('--- end preview ---');
  }

  // List existing KB docs that share our canonical names OR a legacy
  // name we're retiring. These get deleted at the end, after every
  // agent has been detached from them (KB delete returns 409 while any
  // agent still references the doc).
  const targetNames = new Set(DOCS.map((d) => d.name));
  const cleanupNames = new Set([...targetNames, ...LEGACY_NAMES]);
  const existing = await listKnowledgeBase(apiKey);
  const toDelete = existing.filter((d) => cleanupNames.has(d.name));
  if (toDelete.length > 0) {
    log(`Will delete ${toDelete.length} stale knowledge base document(s) after detaching from agents:`);
    for (const doc of toDelete) log(`  - "${doc.name}" (${doc.id})`);
  } else {
    log('No stale knowledge base documents to clean up.');
  }

  // Create fresh KB docs
  const created = [];
  for (const { name, text } of textDocs) {
    if (DRY_RUN) {
      log(`Would create "${name}"`);
      created.push({ id: `DRY_RUN_${name.replace(/\W+/g, '_')}`, name });
      continue;
    }
    log(`Creating "${name}"…`);
    const result = await createKnowledgeBaseTextDoc(apiKey, name, text);
    const id = result.id ?? result.document?.id;
    if (!id) {
      throw new Error(`Create returned no id: ${JSON.stringify(result)}`);
    }
    log(`  → id ${id}`);
    created.push({ id, name });
  }

  // Patch each agent to reference the 3 new docs
  for (const agent of agents) {
    log(`Updating ${agent.name} (${agent.agentId})…`);
    if (DRY_RUN) {
      log(`  Would attach: ${created.map((c) => c.name).join(', ')}`);
      continue;
    }
    const config = await getAgent(apiKey, agent.agentId);
    const convCfg = config?.conversation_config ?? {};
    const agentCfg = convCfg.agent ?? {};
    const promptCfg = agentCfg.prompt ?? {};
    const currentKB = Array.isArray(promptCfg.knowledge_base)
      ? promptCfg.knowledge_base
      : [];
    const preserved = currentKB.filter((k) => !cleanupNames.has(k.name));
    const newKB = [
      ...preserved,
      ...created.map((c) => ({
        id: c.id,
        name: c.name,
        type: 'text',
        usage_mode: 'auto',
      })),
    ];

    // Send back the full conversation_config with only knowledge_base
    // replaced, so the PATCH can't accidentally drop voice settings,
    // system prompt, tools, etc. if the API treats nested objects as
    // replace-not-merge. Strip `tools` (legacy mirror of `tool_ids`)
    // because the API rejects payloads containing both.
    const { tools: _legacyTools, ...promptForPatch } = promptCfg;
    const patch = {
      conversation_config: {
        ...convCfg,
        agent: {
          ...agentCfg,
          prompt: {
            ...promptForPatch,
            knowledge_base: newKB,
          },
        },
      },
    };
    try {
      await patchAgent(apiKey, agent.agentId, patch);
      log(`  Knowledge base now has ${newKB.length} entries (${preserved.length} preserved + ${created.length} new).`);
    } catch (e) {
      console.warn(`  PATCH failed for ${agent.name}:`, e.message);
    }
  }

  // Now that every agent is detached, delete the stale KB documents.
  if (toDelete.length > 0) {
    log(`Deleting ${toDelete.length} stale knowledge base document(s):`);
    for (const doc of toDelete) {
      log(`  - "${doc.name}" (${doc.id})`);
      if (!DRY_RUN) {
        try {
          await deleteKnowledgeBaseDoc(apiKey, doc.id);
        } catch (e) {
          console.warn(`    Delete failed (will need manual cleanup):`, e.message);
        }
      }
    }
  }

  log('Done.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
