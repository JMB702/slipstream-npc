#!/usr/bin/env node
// Show the most recent voice session(s) across all rooms (fps_shooter, arena).
// Queries the party server's /admin/sessions endpoint per room, merges,
// sorts by recency, prints markdown.
//
// Usage:
//   pnpm session:last                           # most recent session, any room, any player
//   pnpm session:last 3                         # last 3 sessions
//   pnpm session:last --player=Jeff
//   pnpm session:last --since=2h
//   pnpm session:last --json                    # raw JSON instead of markdown
//   pnpm session:last --no-content              # skip transcript text, show summary only

import { readFile } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const ENV_FILE = join(REPO_ROOT, 'apps/party/.env');
const HOST = process.env.PARTY_HOST ?? 'http://localhost:1999';
const ROOMS = ['fps_shooter', 'arena'];

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

const wantJson = !!flag('json');
const noContent = !!flag('no-content');
const player = flag('player');
const sinceArg = flag('since');
const countArg = args.find((a) => /^\d+$/.test(a));
const count = countArg ? parseInt(countArg, 10) : 1;

const parseSince = (v) => {
  if (!v) return 0;
  const m = String(v).match(/^(\d+)([smhd])$/);
  if (!m) return 0;
  const n = +m[1];
  const mult = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2]];
  return Date.now() - n * mult;
};
const since = parseSince(sinceArg);

const envTxt = await readFile(ENV_FILE, 'utf8');
const secret = (envTxt.match(/^ELEVENLABS_AGENT_TOOL_SECRET=(.+)$/m) ?? [])[1]?.trim();
if (!secret) {
  console.error('ELEVENLABS_AGENT_TOOL_SECRET not found in apps/party/.env');
  process.exit(1);
}

const fetchRoom = async (room) => {
  const url = new URL(`${HOST}/parties/main/${room}/admin/sessions`);
  url.searchParams.set('secret', secret);
  url.searchParams.set('count', String(count));
  if (player) url.searchParams.set('player', String(player));
  if (since) url.searchParams.set('since', String(since));
  try {
    const res = await fetch(url, { method: 'GET' });
    if (!res.ok) {
      console.error(`[${room}] HTTP ${res.status}: ${await res.text()}`);
      return { room, sessions: [], scene: [] };
    }
    const body = await res.json();
    return { room, sessions: body.sessions ?? [], scene: body.scene ?? [] };
  } catch (err) {
    console.error(`[${room}] fetch failed: ${err.message}`);
    return { room, sessions: [], scene: [] };
  }
};

const fetched = await Promise.all(ROOMS.map(fetchRoom));
const all = fetched.flatMap((r) => r.sessions);
all.sort((a, b) => b.startedAt - a.startedAt);
const top = all.slice(0, count);

// Phase 2 scene transcripts: merged across rooms, sorted by speech time.
// Tagged with room so a player roaming between maps stays attributable.
const scene = fetched
  .flatMap((r) => r.scene.map((l) => ({ ...l, room: r.room })))
  .sort((a, b) => a.at - b.at);

if (wantJson) {
  console.log(JSON.stringify(top, null, 2));
  process.exit(0);
}

const fmtDur = (ms) => {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3600_000) return `${(ms / 60_000).toFixed(1)}m`;
  return `${(ms / 3600_000).toFixed(1)}h`;
};

const renderSession = (s) => {
  const out = [];
  out.push(`## Session — ${s.room} — ${s.player}`);
  out.push(
    `${new Date(s.startedAt).toLocaleString()} → ${new Date(s.endedAt).toLocaleString()} (${fmtDur(s.durationMs)}, ${s.lineCount} lines: ${s.userLineCount}u/${s.agentLineCount}a)`,
  );
  out.push(`NPCs: **${s.npcs.join(', ')}**`);
  out.push('');

  // Event summary
  if (s.events.length > 0) {
    out.push(`### Events during session (${s.events.length})`);
    const byKind = {};
    for (const e of s.events) (byKind[e.kind] ??= []).push(e);
    for (const [kind, list] of Object.entries(byKind)) {
      if (kind === 'tool_call') {
        for (const e of list)
          out.push(
            `- \`tool_call\` **${e.tool}** by ${e.npcId} for ${e.playerName} ${e.ok ? '✓' : '✗'}${e.args ? ` ${JSON.stringify(e.args)}` : ''}`,
          );
      } else if (kind === 'voice_session') {
        for (const e of list)
          out.push(
            `- \`voice_session ${e.phase}\` ${e.npcId} (${e.playerName})${e.durationMs ? ` durationMs=${e.durationMs}` : ''}${e.reason ? ` reason=${e.reason}` : ''}`,
          );
      } else if (kind === 'hostility_change') {
        for (const e of list)
          out.push(`- \`hostility_change\` ${e.npcId} → ${e.towardsName} (${e.op}, src=${e.source})`);
      } else if (kind === 'shot_fired') {
        for (const e of list)
          out.push(
            `- \`shot_fired\` ${e.shooterIsBot ? e.shooterNpcId : e.shooterId} → ${e.targetName ?? '(miss)'} ${e.hit ? 'HIT' : 'miss'}${e.killed ? ' KILL' : ''}`,
          );
      } else if (kind === 'feedback_signal') {
        for (const e of list) out.push(`- \`feedback_signal\` **${e.trigger}**: _"${e.text}"_`);
      } else {
        out.push(`- \`${kind}\` ${JSON.stringify(list[0])}`);
      }
    }
    out.push('');
  }

  // NPC persona-delta state active during session
  if (Object.keys(s.npcState).length > 0) {
    out.push(`### NPC persona deltas active`);
    for (const [npcId, entries] of Object.entries(s.npcState)) {
      out.push(`- **${npcId}**:`);
      for (const e of entries) {
        out.push(`  - _${new Date(e.at).toLocaleString()}_ — ${e.summary.slice(0, 200)}${e.summary.length > 200 ? '…' : ''}`);
      }
    }
    out.push('');
  }

  // Transcript
  if (!noContent) {
    out.push(`### Transcript`);
    let curNpc = null;
    for (const l of s.transcript) {
      if (l.npcId !== curNpc) {
        out.push('');
        out.push(`**${l.npcId.toUpperCase()}**`);
        curNpc = l.npcId;
      }
      const t = new Date(l.at).toLocaleTimeString();
      const who = l.role === 'user' ? s.player.toUpperCase() : l.npcId;
      out.push(`- \`${t}\` **${who}**: ${l.text}`);
    }
    out.push('');
  }
  return out.join('\n');
};

const renderScene = (lines) => {
  if (lines.length === 0) return null;
  const out = [];
  out.push(`## Scene transcript (multi-speaker) — ${lines.length} lines`);
  out.push('');
  for (const l of lines) {
    const t = new Date(l.at).toLocaleTimeString();
    const tag = l.kind === 'npc' ? '🤖' : '🎙';
    const room = l.room ? ` _(${l.room})_` : '';
    out.push(`- \`${t}\` ${tag} **${l.speakerName.toUpperCase()}**${room}: ${l.text}`);
  }
  return out.join('\n');
};

if (top.length === 0 && scene.length === 0) {
  console.log('_No sessions or scene transcripts found._');
  if (player) console.log(`(Filtered to player=${player}; try without the filter.)`);
  process.exit(0);
}

if (top.length > 0) {
  console.log(`# Last ${top.length} session${top.length === 1 ? '' : 's'}`);
  console.log(`Queried rooms: ${ROOMS.join(', ')}. Returned ${top.length} of ${all.length} candidates.`);
  console.log('');
  for (const s of top) console.log(renderSession(s));
}

const sceneRendered = renderScene(scene);
if (sceneRendered) {
  console.log('');
  console.log(sceneRendered);
}
