// lib/vibe-intent.mjs — turn a typed mood into a STRUCTURED request.
// ---------------------------------------------------------------------------
// The Vibe Finder used to do this: find mood words in the text, collect a bag of
// genre keywords, score games by keyword overlap. That answers "something chill"
// and nothing else. Every one of these — all of which people actually type —
// came back wrong or empty:
//
//   "I only have 10 minutes"          no duration concept existed at all
//   "challenging but not frustrating" both words are the SAME axis; overlap
//                                     scoring cannot express "a band of it"
//   "not scary"                       fired the horror bucket. It returned
//                                     horror games for a request to avoid them.
//   "something like what I just played" no access to history whatsoever
//
// So this parses text into a target VECTOR over the axes in
// data/game-attributes.json, plus negations, plus an optional reference game.
// Scoring then becomes distance-to-target, which answers all four.
//
// ── WHY DISTANCE-TO-TARGET AND NOT MAXIMISE ────────────────────────────────
// "Challenging" is not a request to maximise difficulty — the hardest game in
// the catalog is not the best answer, it is the worst one. It is a request for a
// BAND. Maximising is also what makes "challenging but not frustrating"
// unanswerable: the two clauses pull the same axis in opposite directions, and a
// maximiser can only take the larger. Averaging the two targets lands at ~0.6,
// which is exactly what the sentence means.
//
// ── NO AI IN THIS PATH ──────────────────────────────────────────────────────
// This is pure, synchronous, and dependency-free, so /api/vibe answers from
// local computation in single-digit milliseconds. server.js keeps the optional
// Pollinations refinement for text this parser scores as LOW CONFIDENCE, which
// is now rare rather than routine. A network round-trip must never be the only
// way to answer "something chill".

// Every axis this module can target. Mirrors tools/build-game-attributes.py —
// if you add an axis there, add it here or nothing will ever request it.
export const AXES = ['calm', 'pace', 'brainy', 'challenge', 'social', 'cozy'];

// ── The lexicon ────────────────────────────────────────────────────────────
// phrase -> [axis, target, weight][]
//
// `target` is where on the axis the phrase is asking for, NOT a direction. So
// "relaxing" is calm:0.92 rather than "calm +1", which is what lets opposing
// clauses average into a coherent request instead of cancelling to nothing.
//
// Multi-word phrases are matched before single words, so "not too hard" is
// handled as a unit rather than as "not" + "too" + "hard".
const LEXICON = [
  // ── calm / chaos ────────────────────────────────────────────────────────
  [['relaxing', 'relax', 'chill', 'chilled', 'calm', 'calming', 'peaceful', 'soothing',
    'unwind', 'wind down', 'destress', 'de stress', 'decompress', 'zen', 'mellow',
    'cozy', 'comfy', 'quiet', 'gentle', 'laid back', 'low key', 'no stress'],
   [['calm', 0.92, 2.0], ['challenge', 0.25, 0.8], ['pace', 0.3, 0.7]]],

  [['chaotic', 'chaos', 'crazy', 'insane', 'wild', 'mayhem', 'madness', 'frantic',
    'hectic', 'bonkers', 'unhinged', 'nuts', 'wacky'],
   [['calm', 0.06, 2.0], ['pace', 0.9, 1.4]]],

  [['intense', 'adrenaline', 'hardcore', 'brutal', 'extreme', 'hyped', 'pumped'],
   [['calm', 0.12, 1.6], ['pace', 0.85, 1.2], ['challenge', 0.8, 1.0]]],

  // ── pace ────────────────────────────────────────────────────────────────
  [['fast', 'fast paced', 'quick reflexes', 'twitchy', 'speedy', 'rapid', 'high speed',
    'action packed', 'energetic', 'hyper', 'active'],
   [['pace', 0.92, 1.8]]],

  [['slow', 'slow paced', 'slow burn', 'take my time', 'no rush', 'unhurried',
    'turn based', 'thoughtful'],
   [['pace', 0.12, 1.8]]],

  // ── brainy ──────────────────────────────────────────────────────────────
  [['thinking', 'think', 'brainy', 'brain', 'clever', 'smart', 'puzzle', 'puzzling',
    'logic', 'logical', 'strategy', 'strategic', 'mental', 'stimulating',
    'wake my brain', 'brain teaser', 'problem solving', 'figure out', 'work my brain'],
   [['brainy', 0.9, 1.9]]],

  [['mindless', 'no thinking', 'brainless', 'switch off', 'turn my brain off',
    'zone out', 'braindead', 'autopilot'],
   [['brainy', 0.08, 1.9], ['challenge', 0.2, 1.0]]],

  // ── challenge ───────────────────────────────────────────────────────────
  // "challenging" targets 0.82, not 1.0 — a request for difficulty is not a
  // request for the single most punishing game in a 17k catalog.
  [['challenging', 'challenge', 'hard', 'difficult', 'tough', 'test me', 'push me',
    'skill', 'skilful', 'skillful', 'demanding', 'tricky'],
   [['challenge', 0.82, 1.8]]],

  [['frustrating', 'rage', 'ragequit', 'rage quit', 'punishing', 'unfair', 'impossible',
    'infuriating', 'sweaty', 'tryhard'],
   [['challenge', 0.96, 1.5]]],

  [['easy', 'simple', 'casual', 'casually', 'chilled out', 'light', 'lightweight',
    'no pressure', 'forgiving', 'relaxed', 'low effort', 'effortless', 'beginner'],
   [['challenge', 0.14, 1.8], ['calm', 0.72, 0.8]]],

  // ── social ──────────────────────────────────────────────────────────────
  [['competitive', 'compete', 'versus', 'vs', 'pvp', 'multiplayer', 'against others',
    'against people', 'beat someone', 'leaderboard', 'ranked', 'tournament',
    'against friends', 'two player', '2 player'],
   [['social', 0.92, 1.9], ['challenge', 0.7, 0.8]]],

  [['alone', 'solo', 'single player', 'by myself', 'on my own', 'solitary'],
   [['social', 0.1, 1.6]]],

  // ── cozy ────────────────────────────────────────────────────────────────
  [['cute', 'adorable', 'wholesome', 'sweet', 'lovely', 'charming', 'pets', 'animals',
    'kawaii', 'heartwarming', 'comforting'],
   [['cozy', 0.92, 1.8], ['calm', 0.75, 0.7]]],

  [['scary', 'horror', 'creepy', 'spooky', 'frightening', 'terrifying', 'haunted',
    'nightmare', 'zombie', 'zombies'],
   [['cozy', 0.06, 1.7], ['calm', 0.2, 1.0]]],

  [['violent', 'gory', 'brutal fighting', 'bloody', 'shooting', 'guns'],
   [['cozy', 0.12, 1.4]]],

  // ── emotional states → what actually helps ──────────────────────────────
  // These are not axis words; they are how people really open the sentence.
  [['sad', 'lonely', 'down', 'crying', 'heartbroken', 'upset', 'miserable', 'blue',
    'depressed', 'homesick'],
   [['cozy', 0.85, 1.5], ['calm', 0.8, 1.3], ['challenge', 0.2, 1.0]]],

  [['angry', 'furious', 'mad', 'pissed', 'annoyed', 'irritated', 'frustrated with'],
   [['calm', 0.15, 1.4], ['pace', 0.85, 1.2], ['cozy', 0.25, 0.9]]],

  [['anxious', 'stressed', 'overwhelmed', 'nervous', 'panicking', 'worried', 'tense',
    'burnt out', 'burned out', 'exhausted', 'tired', 'sleepy', 'drained'],
   [['calm', 0.93, 1.9], ['challenge', 0.15, 1.3], ['pace', 0.25, 1.0]]],

  [['bored', 'boredom', 'nothing to do', 'kill time', 'pass the time', 'time to kill'],
   [['pace', 0.72, 1.0], ['challenge', 0.5, 0.5]]],

  [['happy', 'excited', 'good mood', 'great mood', 'cheerful', 'joyful'],
   [['pace', 0.75, 1.0], ['cozy', 0.7, 0.8]]],
];

// Words that reverse the clause that follows them.
const NEGATORS = new Set([
  'not', 'no', 'nothing', 'never', 'without', 'avoid', 'except', 'dont', "don't",
  'doesnt', "doesn't", 'anything but', 'hate', 'sick of', 'tired of', 'less',
]);

// Words that soften a target toward the middle rather than reversing it.
// "not TOO hard" is a different request from "not hard".
const DAMPENERS = new Set(['too', 'overly', 'super', 'really', 'very', 'extremely', 'so']);

// Phrases meaning "use the game I last played as the seed".
const REFERENCE_PHRASES = [
  'like the game i just played', 'like what i just played', 'like the last game',
  'like that last one', 'similar to what i played', 'similar to the last',
  'like my last game', 'more like that', 'more of that', 'like the one i just played',
  'something like that', 'like what i was playing', 'more like what i played',
];

// Filler stripped before harvesting leftover words as keywords.
const STOP = new Set([
  'i', 'a', 'an', 'the', 'want', 'wants', 'wanted', 'something', 'anything', 'some',
  'give', 'me', 'find', 'show', 'get', 'need', 'looking', 'for', 'to', 'play',
  'game', 'games', 'please', 'just', 'really', 'kind', 'type', 'sort', 'of', 'mood',
  'vibe', 'feel', 'feeling', 'im', "i'm", 'am', 'is', 'are', 'be', 'can', 'could',
  'would', 'right', 'now', 'today', 'like', 'and', 'but', 'or', 'with', 'that',
  'this', 'it', 'my', 'have', 'has', 'only', 'got', 'thats', 'in', 'on', 'at',
  'up', 'out', 'about', 'more', 'less', 'very', 'too', 'so', 'you', 'your',
  // Time words. extractDuration() has already taken the meaning out of these;
  // leaving them in made "I only have 10 minutes" search game titles for the
  // word "minutes", which matches nothing and dilutes the real signal.
  'minute', 'minutes', 'min', 'mins', 'hour', 'hours', 'hr', 'hrs', 'half',
  'second', 'seconds', 'time', 'long', 'short', 'quick', 'while', 'session',
  // Consumed by the "like what I just played" phrase match.
  'played', 'playing', 'last', 'one', 'ones', 'again', 'else', 'other',
]);

// ── Duration ───────────────────────────────────────────────────────────────
// "I only have 10 minutes" / "half an hour" / "a couple of minutes" / "quick".
const WORD_NUMBERS = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
  eight: 8, nine: 9, ten: 10, fifteen: 15, twenty: 20, thirty: 30, forty: 40,
  fortyfive: 45, sixty: 60, couple: 2, few: 3, several: 4,
};

/**
 * Pull an explicit session length out of the text, in minutes.
 * Returns null when the text says nothing about time.
 */
export function extractDuration(text) {
  const t = ' ' + text + ' ';

  // "half an hour", "an hour and a half"
  if (/\bhour and a half\b/.test(t)) return 90;
  if (/\bhalf an? hour\b/.test(t)) return 30;

  // "10 minutes", "10 min", "10m", "2 hours"
  let m = t.match(/\b(\d{1,3})\s*(minutes?|mins?|m)\b/);
  if (m) return clampMinutes(parseInt(m[1], 10));
  m = t.match(/\b(\d{1,2})\s*(hours?|hrs?|h)\b/);
  if (m) return clampMinutes(parseInt(m[1], 10) * 60);

  // "ten minutes", "a couple of minutes", "a few mins"
  m = t.match(/\b([a-z]+)\s+(?:of\s+)?(minutes?|mins?)\b/);
  if (m && WORD_NUMBERS[m[1]] !== undefined) return clampMinutes(WORD_NUMBERS[m[1]]);
  m = t.match(/\b([a-z]+)\s+(?:of\s+)?(hours?)\b/);
  if (m && WORD_NUMBERS[m[1]] !== undefined) return clampMinutes(WORD_NUMBERS[m[1]] * 60);

  // Bare qualitative time words. Only fire when the sentence is ABOUT time —
  // "quick" in "quick reflexes" is about pace, not session length.
  if (/\b(quick|short|fast) (game|one|session|break)\b/.test(t)) return 5;
  if (/\b(kill|pass|waste) (a few minutes|some time|time)\b/.test(t)) return 5;
  if (/\bon (a|my) break\b/.test(t)) return 8;
  if (/\blong session\b|\bsettle in\b|\ball (day|night)\b|\bhours to (kill|spare)\b/.test(t)) return 40;
  return null;
}

function clampMinutes(n) {
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.max(2, Math.min(45, n));
}

/** Normalise: lowercase, strip punctuation, collapse whitespace. */
function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9'\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Does a negator apply to the phrase starting at `idx`?
 *
 * Scoped to the FOUR words before the phrase, and stopped by a clause boundary
 * ("but", "and", ","). Without the boundary, "not scary but challenging" would
 * negate "challenging" too — the negator has to stop where the clause does.
 *
 * Returns { negated, dampened }.
 */
function negationContext(words, idx) {
  let negated = false, dampened = false;
  for (let i = idx - 1; i >= 0 && i >= idx - 4; i--) {
    const w = words[i];
    if (w === 'but' || w === 'and' || w === 'though' || w === 'however') break;
    if (DAMPENERS.has(w)) { dampened = true; continue; }
    if (NEGATORS.has(w)) { negated = true; break; }
  }
  return { negated, dampened };
}

/**
 * Parse a free-text vibe into a structured intent.
 *
 * @param {string} text
 * @returns {{
 *   targets: Record<string, {value:number, weight:number}>,
 *   sessionMin: number|null,
 *   keywords: string[],
 *   negatedKeywords: string[],
 *   wantsReference: boolean,
 *   confidence: number,
 *   matched: number,
 *   raw: string
 * }}
 */
export function parseVibe(text) {
  const raw = String(text || '').slice(0, 300);
  const norm = normalize(raw);
  const words = norm.split(' ').filter(Boolean);
  const padded = ' ' + norm + ' ';

  const acc = {};                 // axis -> { sum, weight }
  const bounds = {};              // axis -> { min?, max? }
  const negatedKeywords = [];
  let matched = 0;

  const addTarget = (axis, value, weight) => {
    if (!AXES.includes(axis) || weight <= 0) return;
    if (!acc[axis]) acc[axis] = { sum: 0, weight: 0 };
    acc[axis].sum += value * weight;
    acc[axis].weight += weight;
  };

  // A negation is a BOUND, not an inverted target.
  //
  // This is the fix for "challenging but not frustrating". Reversing
  // "frustrating" (challenge 0.96) into a target of 0.04 and averaging it
  // against "challenging" (0.82) produced 0.52 — a request for AVERAGE
  // difficulty, which is neither thing the sentence asked for. The sentence
  // means "high, but stop short of the top", and a ceiling says that exactly.
  //
  // The 0.15 inset is what makes the bound bite rather than merely touch: "not
  // frustrating" should exclude the 0.96 games, not permit them at the limit.
  const addBound = (axis, target) => {
    if (!AXES.includes(axis)) return;
    if (!bounds[axis]) bounds[axis] = {};
    if (target > 0.5) {
      const cap = Math.max(0.1, target - 0.15);
      bounds[axis].max = Math.min(bounds[axis].max ?? 1, cap);
    } else {
      const floor = Math.min(0.9, target + 0.15);
      bounds[axis].min = Math.max(bounds[axis].min ?? 0, floor);
    }
  };

  // Longest phrases first so "not too hard" beats "hard", and "two player"
  // is not read as the number two.
  const entries = [];
  for (const [phrases, effects] of LEXICON) {
    for (const p of phrases) entries.push({ phrase: p, effects });
  }
  entries.sort((a, b) => b.phrase.length - a.phrase.length);

  const consumed = new Set();     // word indices already explained by a phrase
  const pendingReversals = [];    // [axis, value, weight] — applied only if the
                                  // axis has no positive target (see below)
  const matchedWords = [];        // single-word phrases, kept as literal terms too

  for (const { phrase, effects } of entries) {
    const needle = ' ' + phrase + ' ';
    let at = padded.indexOf(needle);
    if (at === -1) continue;

    // Word index of the match, for negation scoping.
    const wordIdx = padded.slice(0, at + 1).split(' ').filter(Boolean).length;
    const phraseLen = phrase.split(' ').length;
    // Skip if every word here was already claimed by a longer phrase.
    let allConsumed = true;
    for (let k = 0; k < phraseLen; k++) if (!consumed.has(wordIdx + k)) allConsumed = false;
    if (allConsumed) continue;
    for (let k = 0; k < phraseLen; k++) consumed.add(wordIdx + k);

    matched += 1;
    const { negated, dampened } = negationContext(words, wordIdx);
    // A concrete single word is BOTH a mood signal and a literal search term.
    // "zombie" should raise the dark/high-energy axes AND still prefer games
    // with "zombie" in the title — the axes alone would happily return any
    // horror-ish game and miss the obvious literal matches.
    if (!negated && phraseLen === 1) matchedWords.push(phrase);

    for (const [axis, target, weight] of effects) {
      if (negated && dampened) {
        // "not TOO hard" — pull toward the middle, do not reverse. Landing on
        // 0.5 exactly would be a claim of no preference; 0.42 keeps a slight
        // lean away from the thing they pushed back on.
        addTarget(axis, target > 0.5 ? 0.42 : 0.58, weight * 0.9);
      } else if (negated) {
        // Always record the bound — that is the part that is unambiguously
        // true: they told us where NOT to go.
        addBound(axis, target);
        // Only ALSO reverse it into a target when nothing else has spoken for
        // this axis. "not scary" on its own has to produce a positive request
        // (otherwise there is nothing to rank by), but "challenging but not
        // frustrating" must not, because "challenging" already said where to
        // aim and the bound alone is the whole of the second clause's meaning.
        //
        // Deferred to after the loop, since a later clause may still claim the
        // axis — "not scary, something cute" reads left to right, but the
        // decision depends on the whole sentence.
        //
        // MODERATED, not mirrored. A straight `1 - target` turned "not scary"
        // (cozy 0.06) into a demand for cozy 0.94, and the top results were
        // eight baby-and-puppy games. But "not scary" is a request to AVOID one
        // end, not to sprint to the other — the bound above already excludes the
        // horror games, which is the part they actually asked for. 0.65 keeps a
        // clear lean away from the rejected end without pretending they asked
        // for its opposite.
        const mirrored = 0.5 + (0.5 - target) * 0.65;
        pendingReversals.push([axis, mirrored, weight * 0.75]);
        negatedKeywords.push(phrase);
      } else if (dampened) {
        // "really relaxing" — same direction, a little stronger.
        addTarget(axis, target, weight * 1.15);
      } else {
        addTarget(axis, target, weight);
      }
    }
  }

  // A negated clause becomes a positive target ONLY on an axis nothing else
  // claimed. See the note where pendingReversals is filled.
  for (const [axis, value, weight] of pendingReversals) {
    if (!acc[axis]) addTarget(axis, value, weight);
  }

  // ── Duration ─────────────────────────────────────────────────────────────
  const sessionMin = extractDuration(padded);

  // ── "like what I just played" ────────────────────────────────────────────
  const wantsReference = REFERENCE_PHRASES.some(p => padded.includes(' ' + p + ' '))
    || /\bmore like (this|that|it)\b/.test(padded);

  // ── Leftover words become keywords ───────────────────────────────────────
  // Someone typing "zombie" or "minecraft" wants that thing literally, and no
  // axis captures it. Words already explained by a phrase are excluded so
  // "relaxing" does not also become a title search term.
  const keywords = [...matchedWords];
  words.forEach((w, i) => {
    if (consumed.has(i) || STOP.has(w) || w.length < 3 || /^\d+$/.test(w)) return;
    if (NEGATORS.has(w) || DAMPENERS.has(w)) return;
    const { negated } = negationContext(words, i);
    if (negated) negatedKeywords.push(w);
    else keywords.push(w);
  });

  // ── Targets, then bounds applied on top ──────────────────────────────────
  const targets = {};
  for (const [axis, { sum, weight }] of Object.entries(acc)) {
    let value = Math.max(0, Math.min(1, sum / weight));
    const b = bounds[axis];
    if (b) {
      if (b.max !== undefined) value = Math.min(value, b.max);
      if (b.min !== undefined) value = Math.max(value, b.min);
    }
    targets[axis] = {
      value,
      // Cap so one axis mentioned five ways cannot dominate the distance sum.
      weight: Math.min(3, weight),
    };
  }

  // Confidence: did we understand the request, or are we guessing? Drives
  // whether server.js bothers asking the AI to help.
  const signalWords = matched * 2 + (sessionMin ? 2 : 0) + (wantsReference ? 2 : 0)
    + Math.min(3, keywords.length);
  const confidence = Math.max(0, Math.min(1, signalWords / 8));

  return {
    targets, bounds, sessionMin,
    keywords: [...new Set(keywords)].slice(0, 12),
    negatedKeywords: [...new Set(negatedKeywords)].slice(0, 12),
    wantsReference, confidence, matched, raw,
  };
}

/**
 * A short human sentence describing what we understood, for the UI.
 * Written from the player's side: "relaxing, about 10 minutes", not
 * "calm=0.92 session=10".
 */
export function describeIntent(intent) {
  const bits = [];
  const say = (axis, lowWord, highWord) => {
    const t = intent.targets[axis];
    if (!t || t.weight < 0.6) return;
    if (t.value >= 0.68) bits.push(highWord);
    else if (t.value <= 0.32) bits.push(lowWord);
  };
  say('calm', 'high-energy', 'relaxing');
  say('pace', 'slow-paced', 'fast-paced');
  say('brainy', 'no thinking needed', 'brain-teasing');
  say('challenge', 'easygoing', 'challenging');
  say('social', 'solo', 'competitive');
  say('cozy', 'dark', 'cute');
  if (intent.sessionMin) bits.push(`about ${intent.sessionMin} min`);
  if (intent.wantsReference) bits.push('like your last game');
  return bits.slice(0, 4).join(' · ');
}

export default { parseVibe, describeIntent, extractDuration, AXES };
