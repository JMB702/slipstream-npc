import { SOCIAL, type NpcDef } from '@slipstream-npc/shared';
import type { NpcStateEntry } from '../storage.js';

// Build the system prompt + user message for one decoupled-NPC turn.
// Phase 3+ counterpart to server.ts:buildMemoryBlob — the ConvAI path uses
// a single text blob fed via sendContextualUpdate; the decoupled path
// drives Anthropic directly so the prompt is properly structured into
// system + user roles.
//
// We deliberately do not pull persona deltas / friendships / transcripts in
// this module — the caller (turn-state.ts) collects them and passes in.
// Keeps the module pure (no GameStorage or PartyKit DO references), which
// makes it unit-testable later.

export interface SceneSpeechLine {
  at: number;
  speakerName: string;
  text: string;
}

export interface RecentNpcTurn {
  at: number;
  text: string;
}

export interface ScenePromptInputs {
  npc: NpcDef;
  // Shared world facts every NPC should know — who's in the complex,
  // what players do, what NPCs can and can't do, etc. Generated from
  // docs/backstory.html by `pnpm bake:bible`.
  worldBibleShared: string;
  // The room the NPC is in right now — wall layout, landmarks, what's
  // actually visible. Generated from docs/map-*.html by `pnpm bake:bible`.
  arenaDescription: string;
  // Live game state, summarized into a one-paragraph string. Caller decides
  // what to include (health, follow target, hostility, etc.) so this module
  // doesn't need ServerPlayer types.
  selfStateLine: string;
  // Persona deltas — durable changes to self-knowledge that override the
  // baked personality where they conflict. Most recent first.
  personaDeltas: NpcStateEntry[];
  // Scene transcript (multi-speaker) since the last NPC turn. Each line is
  // attributed; the LLM gets it as a single user message that mirrors how
  // the room sounds to the NPC.
  scene: SceneSpeechLine[];
  // The last few things THIS NPC said in the room, so the LLM doesn't
  // repeat itself. Phase 3 keeps it shallow — Phase 4 will widen this when
  // chain-reactions land.
  recentSelfTurns: RecentNpcTurn[];
  // Other NPCs currently alive in the room — used so the LLM can address
  // them by name and avoid speaking as / about NPCs who left.
  otherNpcNames: string[];
  // Friendship score with each speaker that has spoken in `scene`. Keyed
  // by speakerName. Threshold is SOCIAL.friendThreshold.
  friendshipByPlayer: Record<string, number>;
}

const personaDeltaSection = (deltas: NpcStateEntry[]): string[] => {
  if (deltas.length === 0) return [];
  const out: string[] = [];
  out.push("## What's changed about you (authoritative — overrides your persona)");
  out.push(
    'The following facts about you have changed since your persona was written. ' +
      'When you talk about yourself, these are TRUE NOW; the persona text is the prior baseline. ' +
      'You still remember the prior state and the events that caused each change, but the current truth is below.',
  );
  out.push('');
  for (const e of deltas) {
    out.push(`- ${e.summary}`);
    if (e.evidence) out.push(`  Evidence: ${e.evidence}`);
  }
  out.push('');
  return out;
};

const friendshipSection = (
  friendshipByPlayer: Record<string, number>,
): string[] => {
  const names = Object.keys(friendshipByPlayer);
  if (names.length === 0) return [];
  const out = ['## Friendships in this scene'];
  for (const n of names) {
    const score = friendshipByPlayer[n] ?? 0;
    const friend = score >= SOCIAL.friendThreshold;
    out.push(
      `- ${n}: ${score} (threshold ${SOCIAL.friendThreshold})${friend ? ' — your friend.' : ''}`,
    );
  }
  out.push('');
  return out;
};

const recentSelfTurnsSection = (turns: RecentNpcTurn[]): string[] => {
  if (turns.length === 0) return [];
  const out = ['## What you said recently — HARD BAN on repeating these'];
  out.push(
    'These are your last few turns. DO NOT repeat them verbatim, near-verbatim, or in lightly-reworded form. ' +
      'If your draft response matches the opening words, the closing words, or the overall sentiment of any line below, ' +
      'throw it out and write a different one. A repeated line is a bug. Vary your phrasing, your hook, and your angle. ' +
      'If you genuinely have nothing new to add, say "Mm." or "Hm." or stay silent — a single beat is better than recycling.',
  );
  out.push('');
  for (const t of turns) out.push(`- "${t.text.replace(/"/g, '\\"')}"`);
  out.push('');
  return out;
};

export const buildSceneSystem = (inputs: ScenePromptInputs): string => {
  const lines: string[] = [];

  // 1. Persona — baked from npc-roster.ts. The LLM reads this as the
  // primary identity prompt; deltas (next section) override where they
  // conflict.
  lines.push('## Who you are');
  lines.push(inputs.npc.personality);
  lines.push('');

  // 2. Persona deltas — durable in-fiction changes.
  lines.push(...personaDeltaSection(inputs.personaDeltas));

  // 3. World context — shared backstory + the canonical map description,
  // plus an explicit confabulation guardrail. The shared bible is the
  // common facts every NPC knows (who the others are, what players do,
  // the rules of this place). The map description is the room they're
  // physically in right now. Both are auto-generated from the artist-
  // editable HTML docs so they never drift from the ElevenLabs KB.
  if (inputs.worldBibleShared.trim()) {
    lines.push('## The world you live in (shared backstory)');
    lines.push(inputs.worldBibleShared);
    lines.push('');
  }
  lines.push('## The room you are in right now (canonical — do not contradict)');
  lines.push(inputs.arenaDescription);
  lines.push('');
  lines.push('## What you can and cannot describe');
  lines.push(
    'STRICT RULE: the room is exactly what the section above says. The player can SEE the arena on their screen — every wall, every staircase, every object. If you describe something the player can see is not there, immersion breaks immediately and the player will call you out on it.',
  );
  lines.push('');
  lines.push('DO NOT invent any of the following:');
  lines.push('- Plants, flowers, moss, weeds, vines, grass, leaves — there are none in the arena unless the canonical description above lists them.');
  lines.push('- Insects, animals, birds, tracks, footprints.');
  lines.push('- Furniture, bars, doors, signs, posters, lights, fixtures, decorations — anything beyond the walls, stairs, and objects listed above.');
  lines.push('- Weather, wind, rain, sun, clouds, time of day. The lighting is whatever the canonical description says (usually flat and even).');
  lines.push('- Smells, dust motes, condensation, lichen, "the way the light hits that corner."');
  lines.push('- New rooms, wings, sections, areas, levels not in the canonical description.');
  lines.push('');
  lines.push('You CAN talk about:');
  lines.push('- Your own past, memories, opinions, training, family, hobbies, fears — your inner world is yours to draw from.');
  lines.push('- Other NPCs and their personas (you know each other).');
  lines.push('- The other players and what they\'ve said this scene.');
  lines.push('- Things actually listed in the canonical room description above — by their canonical names.');
  lines.push('- Abstract ideas, plans, theories, jokes.');
  lines.push('');
  lines.push('If a player describes something you can\'t verify (claiming there\'s a hidden room, etc.), respond in character without confirming it — express doubt, ask what they mean, or redirect.');
  lines.push('');

  // 4. Right now — health, follow target, hostility flags etc.
  if (inputs.selfStateLine.trim()) {
    lines.push('## Right now');
    lines.push(inputs.selfStateLine.trim());
    lines.push('');
  }

  // 5. Who else is here.
  if (inputs.otherNpcNames.length > 0) {
    lines.push(
      `Other NPCs in the room: ${inputs.otherNpcNames.join(', ')}.`,
    );
    lines.push('');
  }

  // 6. Friendships per speaker — drives how the NPC addresses each one.
  lines.push(...friendshipSection(inputs.friendshipByPlayer));

  // 7. Recent self turns — anti-repetition gate.
  lines.push(...recentSelfTurnsSection(inputs.recentSelfTurns));

  // 8. Response shape. Crucial — without this, Claude defaults to long
  // exposition and the TTS bill balloons. Equally crucial: the output is
  // fed to text-to-speech verbatim, so any non-spoken text (stage
  // directions, narration, asterisk-emotes, brackets) gets read aloud.
  lines.push('## How to respond');
  lines.push(
    'CRITICAL: your response is fed directly to text-to-speech. Every word you write will be spoken aloud in your voice. ' +
      'Output ONLY the spoken dialogue — nothing else.\n\n' +
      'DO NOT include:\n' +
      '- Stage directions: "I nod", "I turn toward Jeff", "I tilt my head", "looks over", "softens", etc.\n' +
      '- Narration: "with a smile", "her expression softens", "raw in his voice", etc.\n' +
      '- Asterisk emotes: *sighs*, *laughs*, *nods*\n' +
      '- Brackets: [pause], [softly], [system messages you received]\n' +
      '- Speaker tags: "Vicky:", "I say,"\n' +
      '- Quotes around your own speech\n\n' +
      'Just write the words you would say out loud, as if dictating into a microphone. ' +
      'Keep it short — usually 1-2 sentences. ' +
      'If you have nothing useful to say, output a short interjection ("Hm.", "Yeah?", "Mm.") and stop. ' +
      'You may address other speakers by name in the dialogue itself.',
  );

  return lines.join('\n');
};

// Format the scene transcript as a single user message. The Claude API
// works best when multi-speaker dialogue is presented this way (versus
// alternating user/assistant turns) — it preserves the multi-party
// structure without confusing the model about who said what when.
export const buildSceneUserText = (scene: SceneSpeechLine[]): string => {
  if (scene.length === 0) return '(The room is quiet. Say something brief or nothing at all.)';
  const lines = ['Recent speech in the room (your turn to respond):'];
  for (const l of scene) {
    lines.push(`${l.speakerName}: ${l.text}`);
  }
  return lines.join('\n');
};
