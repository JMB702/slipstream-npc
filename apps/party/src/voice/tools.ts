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

// THINK channel — scratch pad for reasoning that NEVER reaches TTS.
//
// This is the architectural fix for the meta-narration leak class:
//   - Old: model puts reasoning ("Rob would let it land", "no say call
//     needed") inside `say({ line })` because there's no other channel,
//     and the line goes straight to TTS.
//   - New: model has a dedicated `think` tool. The orchestrator routes
//     think calls to logs and forwards NOTHING to TTS. The model can
//     reason as much as it wants here without ever risking the speaker
//     channel.
//
// Strict construction-level guarantee: there is no code path that takes
// `think.scratch` and sends it to ElevenLabs. The text is observed,
// logged, then dropped on the floor.
export const THINK_TOOL: LlmToolSchema = {
  name: 'think',
  description:
    'Scratch pad for reasoning. Use this BEFORE deciding whether to call `say`. The content is NEVER spoken or shown to the player — it stays on the server. ' +
    'If you find yourself wanting to describe your own decision-making ("I should…", "no need to respond", "silence is the right move"), put it HERE, never inside `say`. ' +
    'If your character is confused or undecided, reason about it here, then either call `say` with the actual in-character dialogue or call nothing at all (silence).',
  input_schema: {
    type: 'object',
    properties: {
      scratch: {
        type: 'string',
        description:
          'Free-form private reasoning. The player cannot see or hear this. Be terse — short notes are enough.',
      },
    },
    required: ['scratch'],
  },
};

// Channel for spoken dialogue. The orchestrator extracts `line` from every
// `say` tool_use call and concatenates them into the TTS stream. Anything
// the model emits as raw text (outside this tool) is discarded — that's the
// structural fix for meta-narration leaks. The model cannot accidentally
// read system messages aloud or describe its own reasoning because the only
// path to the speaker is this tool.
export const SAY_TOOL: LlmToolSchema = {
  name: 'say',
  description:
    "Channel for SPOKEN DIALOGUE ONLY. The `line` argument is fed verbatim to text-to-speech and broadcast to the player as your character's voice. " +
    "REQUIRED on every turn — if you were picked to respond, you ARE speaking. Multiple `say` calls in one turn are concatenated in order. " +
    "`line` must contain QUOTED CHARACTER SPEECH — the literal words you'd say into a microphone. " +
    "It must NOT contain reasoning, narration, descriptions, third-person references to yourself, or any text about whether to speak. Put reasoning in `think` first if needed. " +
    "If you have nothing big to add, still call `say` with a short in-character beat like \"Mm.\", \"Yeah.\", \"Hm.\", or \"Heard you.\" Silence is not an output.",
  input_schema: {
    type: 'object',
    properties: {
      line: {
        type: 'string',
        description:
          "The exact in-character words to speak aloud — as if dictating into a microphone. Plain dialogue only: no stage directions, no asterisks, no markdown, no speaker tags, no narration, no third-person ('Rob would…'), no decision-talk ('I'll stay silent', 'no need to respond'), no system-message echoes. 1-2 sentences usually. If you'd write any of that, put it in `think` instead.",
      },
    },
    required: ['line'],
  },
};

export const NPC_TOOLS: LlmToolSchema[] = [
  THINK_TOOL,
  SAY_TOOL,
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
