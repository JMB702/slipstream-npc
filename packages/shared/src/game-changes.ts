// Game changes — the canonical "things that happened to the world" registry.
// Each entry becomes a persona-delta in the targeted NPCs' `state:<npcId>`
// once per room (dedup'd via `seeded:<id>` storage key). Every NPC in scope
// reads it at session start via memoryBlob's "## What's changed about you"
// section and integrates it in-character.
//
// THE WORKFLOW (the whole point of this file):
//   1. Ship a code change.
//   2. Add a GameChange entry below describing what NPCs should know.
//      Write the `summary` from the NPC's POV — second person, present tense.
//   3. Reload the server. onStart calls seedGameChanges() which writes the
//      delta to every targeted NPC and sets seeded:<id> so it never re-fires.
//   4. Next conversation: NPCs naturally reference the change.
//
// WHAT BELONGS HERE:
//   - New mechanics ("there's a coffee maker now")
//   - New characters ("Halsey is back in the arena")
//   - World-state changes that should be common NPC knowledge
//   - Permanent character changes that come with code/persona edits
//
// WHAT DOES NOT BELONG HERE:
//   - Per-player history ("Jeff is your friend now") — that's friendship state.
//   - Event-triggered knowledge ("a player just discovered coffee") — that's
//     an in-fiction cascade, handled imperatively (see coffee:discovered).
//   - One-off character changes you set manually via `pnpm npc:state`. If you
//     want them to persist across map/room boots and apply to fresh rooms,
//     ADD THEM HERE instead so they're reproducible.
//
// DEDUP CONTRACT: `id` is the dedup key. Once an id is seeded into a room,
// changing its `summary` will NOT re-seed — bump the id (e.g. add a -v2
// suffix) if you want every existing room to re-apply.

export interface GameChange {
  /** Stable unique id. Used as the dedup key. NEVER reuse or rename. */
  readonly id: string;
  /** Wall-clock ms at which this change happened in the game's timeline.
   *  NPCs may reference how long ago it was. Use Date.parse() on a stable
   *  string so it's deterministic across deploys. */
  readonly at: number;
  /** 'all' = every NPC in the roster. Otherwise, list of npcIds. */
  readonly scope: 'all' | readonly string[];
  /** The persona-delta summary text. Written from the NPC's POV (second
   *  person, present tense). Same shape as a manual `npc:state` entry. */
  readonly summary: string;
  /** Optional evidence/justification the LLM can cite if pressed. */
  readonly evidence?: string;
}

export const GAME_CHANGES: readonly GameChange[] = [
  {
    id: '2026-05-16-coffee-maker',
    at: Date.parse('2026-05-16T00:00:00Z'),
    scope: 'all',
    summary:
      "There's a coffee maker in the arena. Anyone can walk up to it and drink — it restores some health and gives a short buff. It's just part of the place now. Mention it naturally if asked about anything new, or about coffee in general; otherwise don't bring it up unprompted.",
    evidence:
      'See COFFEE constants and COFFEE_WORLD_POSITION in packages/shared. Drink path: tryDrinkCoffee in apps/party/src/simulation.ts.',
  },
  {
    id: '2026-05-16-coffee-no-cooldown',
    at: Date.parse('2026-05-16T12:00:00Z'),
    scope: 'all',
    summary:
      'The coffee maker no longer has a cooldown. You can drink from it again whenever you physically reach it. Do not refuse coffee because of timing or cooldown; decide only from your persona and the conversation.',
    evidence:
      'COFFEE.cooldownMs is now 0 in packages/shared/src/constants.ts.',
  },
  {
    id: '2026-05-17-multi-speaker',
    at: Date.parse('2026-05-17T00:00:00Z'),
    scope: 'all',
    summary:
      "How conversations work has changed. You can hear and respond in group conversations across the room, not just within arm's reach of one player. When humans are talking, you wait. When they stop, whichever NPC the moment calls for is the one who speaks; usually that's the person who was named, or whose topic came up, or whoever was last in the thread. Other NPCs can hear you and react. You won't always be the one who answers — that's normal. If you do answer, keep it short (a sentence or two), in voice, in character.",
    evidence:
      'See the multi-speaker voice redesign — orchestrator + arbitration in apps/party/src/voice/.',
  },
  {
    id: '2026-05-18-rob-joined',
    at: Date.parse('2026-05-18T00:00:00Z'),
    // Scoped to everyone EXCEPT Rob — he doesn't need to be told he exists.
    scope: ['mira', 'guts', 'fennel', 'rook', 'vex', 'jacqueline'],
    summary:
      "A new soldier named Rob has joined the arena. He's another NPC, recently arrived. You haven't spent much time with him yet, but you know he's around — quiet, smokes when he's idle. He may show up in conversation; reference him naturally if it fits, otherwise don't bring him up unprompted.",
    evidence:
      'See NPCS roster entry for rob in packages/shared/src/npc-roster.ts.',
  },
  {
    // Supersedes 2026-05-18-rob-joined. The original entry described Rob as a
    // quiet smoker — placeholder persona, written before his real personality
    // was filled in. This delta corrects the picture for every other NPC.
    // Bumped id (not edited in place) because the dedup contract says edits
    // to a seeded id don't re-fire — and the original already shipped.
    id: '2026-05-18-rob-joined-v2',
    at: Date.parse('2026-05-18T12:00:00Z'),
    scope: ['mira', 'guts', 'fennel', 'rook', 'vex', 'jacqueline'],
    summary:
      "What you actually know about Rob, now that you've watched him a bit: he's a martial arts instructor who runs his own dojo, wears a headband basically always, and won't shut up about livestreaming, AI tech, ancient civilizations, and whether the pyramids were built by who they say. He smokes medical marijuana between patrols — it's his thing, helps his back. Energetic, friendly, talks a lot but lands his points. The earlier read on him as 'quiet' was wrong; you weren't paying attention. Reference him naturally if it fits the moment; otherwise don't bring him up unprompted.",
    evidence:
      'See NPCS roster entry for rob in packages/shared/src/npc-roster.ts.',
  },
];
