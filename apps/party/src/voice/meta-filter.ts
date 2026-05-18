// LLM meta-narration filter. The prompt forbids stage directions / tone
// tags / meta-narration but Claude occasionally leaks them anyway. Without
// this filter the leaks reach TTS verbatim and the NPC literally says
// "Dry, matter-of-fact response." in their voice.
//
// Observed leak patterns in production:
//   "Looking at the exchange, Jeff's asking if I have something better to
//    do than shoot. Dry, matter-of-fact response."
//   "Considering the situation. Brief, dry reply."
//   "Hm. (gruff tone)"
//
// Strategy:
//   1. Strip trailing tone-tag sentences ("Dry, matter-of-fact response.")
//   2. Strip trailing parenthetical/bracket meta ("(stern tone)")
//   3. Strip leading "Note:" / "Response:" prefixes
//   4. Drop standalone meta-only sentences
//   5. Drop opener sentences that are clearly meta-paraphrase of the
//      player's question ("Looking at the exchange, X is asking…")
//
// Tradeoffs: false-positive risk on rare phrasings. Patterns are tuned
// conservative — better to leave a fishy line in than to silence dialogue
// that just happens to start with "Looking at". If the user reports a
// false-positive, narrow the offending pattern.

const TONE_WORDS = [
  'dry', 'matter-of-fact', 'sarcastic', 'calm', 'terse', 'stern',
  'gruff', 'warm', 'gentle', 'short', 'brief', 'amused', 'annoyed',
  'flat', 'wry', 'deadpan', 'quiet', 'soft', 'sharp', 'cold',
  'patient', 'tired', 'bored', 'tense',
].join('|');

// Trailing "Dry, matter-of-fact response." style — terminal sentence
// that's a bare tone adjective + "response/reply/tone/delivery/voice".
// Lookbehind on [.!?] so the regex consumes the trailing meta sentence
// WITHOUT eating the preceding sentence's terminator. Falls back to a
// non-lookbehind form for the leading-whitespace case where there's no
// preceding sentence (whole response is meta).
const TRAILING_TONE_SENTENCE = new RegExp(
  `(?<=[.!?])\\s+(?:${TONE_WORDS})(?:[,\\s]+(?:and\\s+|but\\s+|,?\\s*)?(?:${TONE_WORDS}))*[\\s,]+(?:response|reply|tone|delivery|voice|answer)\\.?\\s*$`,
  'i',
);

// Trailing parenthetical or bracketed meta — "(stern tone)", "[short]"
const TRAILING_PAREN_META = /\s*[(\[][^)\]]{1,40}[)\]]\.?\s*$/;

// Leading labels — "Response:", "Reply:", "Answer:", "Note:"
const LEADING_LABEL = /^\s*(?:response|reply|answer|note|output|dialogue|line)\s*[:\-—]\s*/i;

// Standalone meta sentence — the whole thing is a tone tag (no actual
// dialogue payload).
const STANDALONE_META_SENTENCE = new RegExp(
  `^\\s*(?:${TONE_WORDS})(?:[,\\s]+(?:${TONE_WORDS}))*[\\s,]+(?:response|reply|tone|delivery|voice|answer)\\.?\\s*$`,
  'i',
);

// Opener that paraphrases what the player just said — high-confidence
// meta when combined with third-person-about-the-player ("Jeff is asking",
// "Mira wants to know"). Matches: "Looking at the exchange,",
// "Considering the situation,", "Reading the room,", "Given that,",
// "Reflecting on this,".
const META_OPENER = /^\s*(looking at|considering|reading|given|reflecting on|analyzing|examining|observing|thinking about)\b[^.!?]{0,80}[,.!?]\s*/i;

// Fourth-wall phrases that never appear in legitimate in-character dialogue.
// If ANY of these phrases appears anywhere in the response, the LLM has
// broken character to address the operator ("I need context to respond
// authentically"). Drop the ENTIRE response — there's no way to salvage it.
//
// Observed pattern in production (Rob, Haiku 4.5):
//   "I need context to respond authentically. What was I just asked, or
//    what did Jeff just say in response to? ... Can you give me the line
//    or question that prompted Jeff's response?"
//
// These checks are designed to fire on ANY one phrase — every entry below
// is something a real person would never say in casual conversation.
const FOURTH_WALL_PHRASES: readonly RegExp[] = [
  // Fourth-wall: asking the operator for context
  /\brespond (in[- ]character|authentically)\b/i,
  /\bI\s+should\s+respond\b/i,
  /\bI\s+(need|don't have)\s+(context|more context|the (full|complete) exchange)\b/i,
  /\bcan you (give|tell|provide|share)\s+me\b.*\b(line|question|context|exchange|conversation|prompt)\b/i,
  /\bwhat (was|did)\s+I\s+(just\s+)?(asked|ask|say|saying)\b/i,
  /\bif\s+\w+\s+(was|is)\s+(addressing|referring|talking)\s+to\s+me\b/i,
  /\bwhat\s+was\s+the\s+conversation\s+about\b/i,
  /\bto\s+reply\s+authentically\b/i,
  // Chain-of-thought leak: the model is narrating its own
  // decision-process about whether/how to use the say tool. Real people
  // don't say "no say call needed" — that's coder talk leaking through.
  /\bno\s+`?say`?\s+call\b/i,
  /\b`?say`?\s+call\s+(needed|required|necessary)\b/i,
  /\bsilence\s+is\s+(the\s+)?(right|correct|better)\s+(move|choice|call|response|option)\b/i,
  /\bI('ll| will|'d| would)\s+(stay|be|remain)\s+silent\b/i,
  /\bI\s+have\s+nothing\s+to\s+say\s+here\b/i,
  /\bI\s+(read|interpret)\s+(that|this)\s+as\b/i,
  /\bI\s+need\s+to\s+read\s+(this|that)\s+carefully\b/i,
  /\bthere('s| is)\s+nothing\s+that\s+calls\s+for\b/i,
  /\bno\s+need\s+to\s+respond\s+to\s+(a|that|this|the)\b/i,
  /\bbroke\s+character\b/i,
  // Third-person self-reference: the model talks about its own character
  // as if they're a third party. "Rob would just watch", "Mira wouldn't
  // say that" etc. Names are checked dynamically by the caller — these
  // patterns catch the structural tells that work regardless of which
  // NPC is speaking ("he'd just", "she'd let it", "they'd watch").
  /\b(he|she|they)('d|'ll| would| will)\s+(just\s+)?(watch|wait|let it (land|sit|go)|stay\s+(quiet|silent)|be (quiet|silent))\b/i,
  /\b(he|she)\s+would(n't)?\s+(narrate|respond|reply|jump in|say)\b/i,
];

const isFourthWallLeak = (text: string): boolean => {
  for (const re of FOURTH_WALL_PHRASES) {
    if (re.test(text)) return true;
  }
  return false;
};

const splitSentences = (text: string): string[] => {
  // Crude sentence split — keeps trailing punctuation with the preceding
  // sentence. Handles ., !, ?, and ellipses. Newlines also split.
  const out: string[] = [];
  let buf = '';
  for (let i = 0; i < text.length; i++) {
    buf += text[i];
    const c = text[i];
    const next = text[i + 1];
    if ((c === '.' || c === '!' || c === '?') && (next === ' ' || next === '\n' || next === undefined)) {
      // The outer condition already rules out ellipsis: in "...", `next` is
      // '.', which doesn't satisfy space/newline/undefined, so we don't
      // mid-split. We hit this branch only on a true sentence terminator
      // followed by whitespace or string end.
      out.push(buf.trim());
      buf = '';
    } else if (c === '\n') {
      if (buf.trim()) out.push(buf.trim());
      buf = '';
    }
  }
  if (buf.trim()) out.push(buf.trim());
  return out.filter((s) => s.length > 0);
};

// Anthropic's Haiku 4.5 sometimes emits `<thinking>...</thinking>` blocks
// as plain text outside any tool_use call — a leak of its native chain-of-
// thought formatting. When the orchestrator's "no say call → fall back to
// raw text" path catches that text and runs it through this filter, the
// thinking block needs to be stripped or it ships verbatim to TTS.
// Observed in production: Guts emitted "<thinking> Let me check the
// current situation: - Jeff just said ... I'm Guts, a retired drill
// sergeant ..." and it played as audio.
//
// Strip the entire <thinking>...</thinking> region (greedy across newlines).
// Also strip unclosed/orphan opening tags — the model sometimes hits the
// max_tokens budget mid-thinking-block, so the closing tag never arrives.
const THINKING_BLOCK = /<thinking>[\s\S]*?<\/thinking>/gi;
const THINKING_OPEN_UNCLOSED = /<thinking>[\s\S]*$/i;

export const cleanMetaNarration = (raw: string): string => {
  let text = raw.trim();
  if (!text) return '';

  // Strip native <thinking> blocks before any other check — they often
  // contain phrases that would trip the fourth-wall guard and hard-drop
  // the whole response, when the actual in-character dialogue may live
  // AFTER the thinking block.
  text = text.replace(THINKING_BLOCK, '').replace(THINKING_OPEN_UNCLOSED, '').trim();
  if (!text) return '';

  // Hard-drop: the LLM broke character to address the operator. There's
  // no salvageable in-character text mixed in — these responses are
  // entirely AI self-talk and should never reach TTS.
  if (isFourthWallLeak(text)) {
    return '';
  }

  // Strip leading labels — "Response: ..."
  text = text.replace(LEADING_LABEL, '');

  // Strip trailing parenthetical/bracket meta — "(stern tone)"
  text = text.replace(TRAILING_PAREN_META, '');

  // Strip trailing tone-tag sentence — "Dry, matter-of-fact response."
  // Apply repeatedly so chained tags ("Brief. Dry reply.") all strip.
  let prev = '';
  while (prev !== text) {
    prev = text;
    text = text.replace(TRAILING_TONE_SENTENCE, '').trim();
  }

  // Sentence-level filtering — drop standalone meta sentences and
  // meta-paraphrase openers.
  const sentences = splitSentences(text);
  const kept: string[] = [];
  for (const s of sentences) {
    if (STANDALONE_META_SENTENCE.test(s)) continue;
    // Drop opener-paraphrase sentences that also reference a speaker
    // in the third person ("Jeff's asking", "Mira wants to know"). The
    // third-person check avoids false positives where an NPC naturally
    // says "Looking at it that way, sure" as actual dialogue.
    if (META_OPENER.test(s)) {
      const hasThirdPersonReference =
        /\b\w+'s\s+(asking|saying|wondering|trying|looking|talking)\b/i.test(s) ||
        /\b\w+\s+(is|was)\s+(asking|saying|wondering|trying)\b/i.test(s);
      if (hasThirdPersonReference) continue;
    }
    kept.push(s);
  }

  return kept.join(' ').trim();
};
