import type { LlmToolSchema } from './llm.js';

// Tool schemas exposed to Claude on every decoupled-stack NPC turn. These
// match the existing HTTP webhook routes one-for-one — same names, same
// effects — so a player can say "follow me" and either:
//   (a) Claude emits a tool_use that the dispatcher routes to the existing
//       handler, OR
//   (b) Claude hallucinates a refusal and the regex fallback in
//       applyTranscriptIntent picks up the slack on the user transcript.
// The two paths converge on the same internal helpers (applyPatrolToBot,
// applyLeanTargetToBot, startBotCoffeeRun, etc.) so behavior is identical
// regardless of which entry point fired.

export const NPC_TOOLS: LlmToolSchema[] = [
  {
    name: 'follow_player',
    description:
      "Call this when the player asks you to follow them AND you agree to. The game will path you toward them automatically. Don't announce that you're calling a tool — just do it and react in voice.",
    input_schema: {
      type: 'object',
      properties: {
        player_name: { type: 'string', description: 'Display name of the player to follow.' },
      },
      required: ['player_name'],
    },
  },
  {
    name: 'stop_following',
    description: 'Call this when you want to stop following the player you were following.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'patrol',
    description:
      "Call this when the player asks you to patrol, walk around, or wander. The bot will pace the map at normal speed.",
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'sprint_patrol',
    description:
      'Call this when the player asks you to patrol fast, run patrol, or sprint around. Same as patrol but at sprint speed.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'lean_wall',
    description:
      'Call this when the player asks you to lean on the wall or take cover. The bot will walk to the nearest wall and lean against it.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'flee_from',
    description:
      'Call this when your persona would genuinely retreat from the player (insulted, threatened, etc.). The bot paths away from them.',
    input_schema: {
      type: 'object',
      properties: {
        player_name: { type: 'string', description: 'Display name of the player to flee from.' },
      },
      required: ['player_name'],
    },
  },
  {
    name: 'start_attacking',
    description:
      "Call this when the conversation has convinced you to start shooting the named target. Treats them as hostile for the next ~30 seconds; do not call this casually.",
    input_schema: {
      type: 'object',
      properties: {
        target_name: { type: 'string', description: 'Display name of the player or NPC to attack.' },
      },
      required: ['target_name'],
    },
  },
  {
    name: 'stop_attacking',
    description:
      'Call this when you want to stand down and stop being hostile to the named target.',
    input_schema: {
      type: 'object',
      properties: {
        target_name: { type: 'string', description: 'Display name of the player or NPC.' },
      },
      required: ['target_name'],
    },
  },
  {
    name: 'make_friend',
    description:
      'Call this only after a real moment of trust or shared experience. Not on greetings. Boosts the friendship score with the player so the game treats you as friends.',
    input_schema: {
      type: 'object',
      properties: {
        player_name: { type: 'string', description: 'Display name of the player to befriend.' },
      },
      required: ['player_name'],
    },
  },
  {
    name: 'drink_coffee',
    description:
      'Call this when your persona naturally would walk over to the free coffee maker for a cup. The game will path you to it. Do not claim you drank until a system message confirms it landed.',
    input_schema: { type: 'object', properties: {} },
  },
];
