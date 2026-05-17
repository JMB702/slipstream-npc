import type { NpcDef, Vec3 } from '@slipstream-npc/shared';

// Pick which NPC (if any) should respond to a stretch of multi-speaker
// speech. Pure scoring function — no PartyKit / storage references.
//
// Scoring breakdown (matches the plan's design — Phase 3 ships the full
// formula even though only Vicky is currently flagged useDecoupledStack;
// Phase 4 just flips more flags and adds candidates with no code change):
//
//   nameMatch:          100 (any speaker said the NPC's display name)
//   topicKeyword hit:    20 per matched keyword (capped at 60)
//   lastSpeaker bonus:    8 (the same NPC took the previous NPC turn)
//   proximityFactor:     15 * clamp(1 - minDist/25m, 0, 1)
//
// Tie-break: nameMatch > total score > proximity > stable order.
// Below `ARB_MIN_SCORE`, no NPC responds — silence is a valid outcome.

export interface ArbCandidate {
  npc: NpcDef;
  position: Vec3;
  alive: boolean;
}

export interface ArbInput {
  // All NPC candidates in the room. Filter to useDecoupledStack on the
  // caller side; this module doesn't care how the list was built.
  candidates: ArbCandidate[];
  // The scene utterances since the last NPC turn, with speaker info so
  // proximity can pick the closest speaker for each candidate.
  speech: Array<{ speakerName: string; speakerPos?: Vec3; text: string }>;
  // npcId of the previous NPC turn's speaker, used for the last-speaker
  // bonus. Null if this is the first turn of the conversation.
  lastNpcSpeakerId: string | null;
}

export interface ArbDecision {
  npcId: string;
  score: number;
  reasons: string[];
}

// Threshold below which no NPC responds — silence is a valid outcome.
// Set low enough that proximity alone (an NPC within ~12m of a speaker)
// is sufficient for generic chitchat to get a response, but high enough
// that an NPC across the map doesn't speak unless they were named or
// their topic came up.
const ARB_MIN_SCORE = 6;
const PROXIMITY_MAX_M = 25;
// Bumped from 15 so a close NPC (0m) scores 20 on proximity alone, well
// above ARB_MIN_SCORE, and an NPC ~18m away still clears it.
const PROXIMITY_WEIGHT = 20;
const TOPIC_PER_HIT = 20;
const TOPIC_CAP = 60;
const NAME_MATCH_WEIGHT = 100;
const LAST_SPEAKER_WEIGHT = 8;

const minDistance = (npc: ArbCandidate, speakerPositions: Vec3[]): number => {
  if (speakerPositions.length === 0) return Number.POSITIVE_INFINITY;
  let best = Number.POSITIVE_INFINITY;
  for (const p of speakerPositions) {
    const dx = npc.position[0] - p[0];
    const dy = npc.position[1] - p[1];
    const dz = npc.position[2] - p[2];
    const d = Math.hypot(dx, dy, dz);
    if (d < best) best = d;
  }
  return best;
};

const nameMentioned = (npc: NpcDef, text: string): boolean => {
  // Match the display name as a whole word, case-insensitive. Also matches
  // every entry in `nameAliases` — streaming STT regularly mistakes
  // "Mira" for "Mara" / "Myra" / "Mura" and the roster lists those
  // explicitly so a strong-trigger path survives transcription error.
  const tokens = [npc.name, ...(npc.nameAliases ?? [])];
  for (const t of tokens) {
    if (!t) continue;
    const pattern = new RegExp(`\\b${escapeRegex(t)}\\b`, 'i');
    if (pattern.test(text)) return true;
  }
  return false;
};

const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const topicHits = (npc: NpcDef, text: string): number => {
  const keys = npc.topicKeywords ?? [];
  if (keys.length === 0) return 0;
  const lower = text.toLowerCase();
  let hits = 0;
  for (const k of keys) {
    if (!k) continue;
    const re = new RegExp(`\\b${escapeRegex(k.toLowerCase())}\\b`);
    if (re.test(lower)) hits += 1;
  }
  return hits;
};

export const arbitrate = (input: ArbInput): ArbDecision | null => {
  if (input.candidates.length === 0 || input.speech.length === 0) return null;

  // Concat the scene speech once — name/topic checks run against the same
  // text. Skip dead NPCs entirely.
  const sceneText = input.speech.map((s) => s.text).join(' ');
  const speakerPositions = input.speech
    .map((s) => s.speakerPos)
    .filter((p): p is Vec3 => p !== undefined);

  let best: ArbDecision | null = null;
  for (const c of input.candidates) {
    if (!c.alive) continue;
    const reasons: string[] = [];
    let score = 0;

    if (nameMentioned(c.npc, sceneText)) {
      score += NAME_MATCH_WEIGHT;
      reasons.push(`name:${c.npc.name}`);
    }

    const topic = topicHits(c.npc, sceneText);
    if (topic > 0) {
      const topicScore = Math.min(TOPIC_CAP, topic * TOPIC_PER_HIT);
      score += topicScore;
      reasons.push(`topic:${topic}`);
    }

    if (input.lastNpcSpeakerId && input.lastNpcSpeakerId === c.npc.id) {
      score += LAST_SPEAKER_WEIGHT;
      reasons.push('last-speaker');
    }

    const dist = minDistance(c, speakerPositions);
    if (Number.isFinite(dist)) {
      const factor = Math.max(0, 1 - dist / PROXIMITY_MAX_M);
      const proxScore = Math.round(PROXIMITY_WEIGHT * factor);
      if (proxScore > 0) {
        score += proxScore;
        reasons.push(`prox:${Math.round(dist)}m`);
      }
    }

    if (score < ARB_MIN_SCORE) continue;
    if (!best || score > best.score) {
      best = { npcId: c.npc.id, score, reasons };
    }
  }
  return best;
};

export const ARB_CONSTANTS = {
  minScore: ARB_MIN_SCORE,
  proximityMaxM: PROXIMITY_MAX_M,
  proximityWeight: PROXIMITY_WEIGHT,
  topicPerHit: TOPIC_PER_HIT,
  topicCap: TOPIC_CAP,
  nameMatchWeight: NAME_MATCH_WEIGHT,
  lastSpeakerWeight: LAST_SPEAKER_WEIGHT,
};
