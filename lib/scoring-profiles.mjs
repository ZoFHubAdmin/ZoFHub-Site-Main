// lib/scoring-profiles.mjs — what a score MEANS, per game.
// ---------------------------------------------------------------------------
// THE PROBLEM. The leaderboard had one column, `score bigint`, and one form
// field labelled "Score". Every game shared it. So a golf game measured in
// metres, a racer measured in lap time and a basketball game measured in wins
// all submitted a bare integer into the same ranking, and a player had to guess
// what number was wanted. Worse, "higher is better" was hardcoded — which is
// exactly wrong for a time trial, where the best run is the smallest number.
//
// THE SHAPE OF THE FIX. A game has a SCORING PROFILE: which metric it measures,
// in what unit, with what precision and bounds, and which direction is better.
// The form renders from the profile, the server validates against the profile,
// and the leaderboard ranks by the profile's direction. The browser never
// decides any of this — it is told.
//
// ── THE HONESTY PROBLEM, AND WHY `source` EXISTS ───────────────────────────
// The catalog stores title, category and tags. It does NOT store how any
// particular game counts a score. So for most games, the true metric is simply
// not knowable from here, and a system that guessed would put a confident
// "Distance achieved (meters)" label on a game that actually counts points.
// That is worse than the generic field it replaced: it is a specific false
// claim rather than a vague true one.
//
// So every profile carries a `source`:
//
//   'default'   → the generic points metric. Label: "Score". This is the only
//                 thing shown to a player unless somebody has confirmed better.
//                 It is NOT a guess — "score" is the neutral, honest reading of
//                 a number a player reports, and it is never wrong about units
//                 because it claims none.
//   'suggested' → a metric DERIVED from genre/tags/title, with the evidence
//                 recorded in `basis`. It is shown to an ADMINISTRATOR for
//                 confirmation and is deliberately NOT used to render a player's
//                 form. A suggestion is a question, not an answer.
//   'confirmed' → a human looked at the game and said yes. Only now does the
//                 player see "Distance achieved (meters)".
//
// formFieldFor() enforces that rule, so a suggestion cannot leak into a player's
// form by accident — see the test "a suggestion never reaches a player".
//
// PURE. No database, no clock, no Express. Every function takes plain data and
// returns plain data, so the rules are testable directly rather than through a
// live table.
// ---------------------------------------------------------------------------

/**
 * The closed vocabulary of metrics a game may be scored on.
 *
 * A closed set on purpose: free-text units are how a leaderboard ends up with
 * "meters", "metres", "m" and "Meters" as four incomparable rankings. Adding a
 * metric is a deliberate edit here, and every field has a default so a stored
 * profile may override only what it needs to.
 *
 * `higherIsBetter: false` is the field that makes time trials work.
 */
export const METRICS = Object.freeze({
  points: {
    label: 'Score', unit: null, unitLabel: '', higherIsBetter: true,
    valueType: 'integer', precision: 0, min: 0, max: 1_000_000_000,
    describe: 'A points total reported by the player.',
  },
  distance: {
    label: 'Distance achieved', unit: 'm', unitLabel: 'meters', higherIsBetter: true,
    valueType: 'decimal', precision: 1, min: 0, max: 1_000_000,
    describe: 'How far the player got, in metres.',
  },
  time_fastest: {
    label: 'Best time', unit: 's', unitLabel: 'seconds', higherIsBetter: false,
    valueType: 'decimal', precision: 2, min: 0, max: 86_400,
    describe: 'A completion time. The SMALLEST value wins.',
  },
  survival_time: {
    label: 'Time survived', unit: 's', unitLabel: 'seconds', higherIsBetter: true,
    valueType: 'decimal', precision: 1, min: 0, max: 86_400,
    describe: 'How long the player stayed alive. The LARGEST value wins.',
  },
  wins: {
    label: 'Wins achieved', unit: null, unitLabel: 'wins', higherIsBetter: true,
    valueType: 'integer', precision: 0, min: 0, max: 100_000,
    describe: 'Number of rounds or matches won.',
  },
  goals: {
    label: 'Goals scored', unit: null, unitLabel: 'goals', higherIsBetter: true,
    valueType: 'integer', precision: 0, min: 0, max: 100_000,
    describe: 'Goals, baskets or points scored in a sports game.',
  },
  levels: {
    label: 'Levels completed', unit: null, unitLabel: 'levels', higherIsBetter: true,
    valueType: 'integer', precision: 0, min: 0, max: 10_000,
    describe: 'How far through the game the player reached.',
  },
  objectives: {
    label: 'Objectives completed', unit: null, unitLabel: 'objectives', higherIsBetter: true,
    valueType: 'integer', precision: 0, min: 0, max: 10_000,
    describe: 'Puzzles solved, items collected or tasks finished.',
  },
  laps: {
    label: 'Laps completed', unit: null, unitLabel: 'laps', higherIsBetter: true,
    valueType: 'integer', precision: 0, min: 0, max: 10_000,
    describe: 'Laps finished in a racing game.',
  },
  accuracy: {
    label: 'Accuracy', unit: '%', unitLabel: 'percent', higherIsBetter: true,
    valueType: 'decimal', precision: 1, min: 0, max: 100,
    describe: 'A percentage, so it is capped at 100.',
  },
});

export const METRIC_IDS = Object.freeze(Object.keys(METRICS));
export const DEFAULT_METRIC = 'points';
export const PROFILE_SOURCES = Object.freeze(['default', 'suggested', 'confirmed']);

/** The neutral profile every game starts with. Never a false claim. */
export function defaultProfile(slug = '') {
  return normalizeProfile({ slug, metricId: DEFAULT_METRIC, source: 'default' });
}

/**
 * Coerce any stored or submitted value into a complete, valid profile.
 *
 * Total by construction: an unrecognised metric, a nonsensical precision or a
 * reversed min/max all fall back to something coherent rather than throwing. A
 * profile is read on every score submission and every leaderboard render, so a
 * single bad row must not be able to 500 the feature.
 */
export function normalizeProfile(raw) {
  const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const metricId = METRIC_IDS.includes(o.metricId) ? o.metricId : DEFAULT_METRIC;
  const base = METRICS[metricId];

  const source = PROFILE_SOURCES.includes(o.source) ? o.source : 'default';
  // A non-default metric with no evidence behind it is not trustworthy, so it
  // degrades to a suggestion rather than silently presenting as confirmed.
  const effectiveSource = metricId === DEFAULT_METRIC && source === 'suggested' ? 'default' : source;

  const valueType = o.valueType === 'integer' || o.valueType === 'decimal' ? o.valueType : base.valueType;
  // An integer metric cannot carry decimals, whatever a stored row claims.
  const precision = valueType === 'integer'
    ? 0
    : clampInt(o.precision, 0, 3, base.precision);

  let min = numOr(o.min, base.min);
  let max = numOr(o.max, base.max);
  if (min > max) { const t = min; min = max; max = t; }   // a reversed range is a typo, not a rule

  return {
    slug: String(o.slug || '').toLowerCase().trim(),
    metricId,
    metricName: base.label,
    displayLabel: plainLabel(o.displayLabel) || base.label,
    unit: o.unit === null ? null : (plainLabel(o.unit) || base.unit),
    unitLabel: base.unitLabel,
    higherIsBetter: typeof o.higherIsBetter === 'boolean' ? o.higherIsBetter : base.higherIsBetter,
    valueType,
    precision,
    min,
    max,
    mode: plainLabel(o.mode) || null,
    source: effectiveSource,
    basis: plainLabel(o.basis) || null,
    enabled: o.enabled === false ? false : true,
    configurationVersion: Number.isInteger(o.configurationVersion) && o.configurationVersion > 0
      ? o.configurationVersion : 1,
  };
}

const numOr = (v, d) => (Number.isFinite(Number(v)) && v !== null && v !== '' && typeof v !== 'boolean' ? Number(v) : d);
const clampInt = (v, lo, hi, d) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return d;
  return Math.min(hi, Math.max(lo, Math.round(n)));
};
/** Labels are rendered next to other players' names — keep them inert text. */
function plainLabel(v) {
  if (typeof v !== 'string') return '';
  const t = v.replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim();
  return t.slice(0, 40);
}

// ── Submitted values ───────────────────────────────────────────────────────

/**
 * Validate one submitted value against a profile.
 *
 * Deliberately stricter than Number(): '1e9', '0x10', '12abc', Infinity, NaN,
 * '' and null are all refused rather than coerced, because every one of them is
 * a way to smuggle a value past a bounds check. Surrounding whitespace IS
 * trimmed — a trailing space is a typo in a text input, not an attack.
 *
 * @returns {{ok: true, value: number} | {ok: false, error: string}}
 */
export function validateScoreValue(profileLike, raw) {
  const p = normalizeProfile(profileLike);
  if (!p.enabled) return { ok: false, error: 'this game is not accepting scores' };

  let s;
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) return { ok: false, error: `enter a number` };
    s = String(raw);
  } else if (typeof raw === 'string') {
    s = raw.trim();
  } else {
    return { ok: false, error: 'enter a number' };
  }
  if (!s) return { ok: false, error: 'enter a number' };

  const pattern = p.valueType === 'integer' ? /^\d{1,15}$/ : /^\d{1,15}(\.\d{1,3})?$/;
  if (!pattern.test(s)) {
    return {
      ok: false,
      error: p.valueType === 'integer'
        ? `enter ${p.displayLabel.toLowerCase()} as a whole number`
        : `enter ${p.displayLabel.toLowerCase()} as a number (up to ${p.precision} decimal place${p.precision === 1 ? '' : 's'})`,
    };
  }

  const n = Number(s);
  if (!Number.isFinite(n)) return { ok: false, error: 'enter a number' };

  const decimals = (s.split('.')[1] || '').length;
  if (decimals > p.precision) {
    return { ok: false, error: p.precision === 0
      ? `${p.displayLabel.toLowerCase()} must be a whole number`
      : `${p.displayLabel.toLowerCase()} allows at most ${p.precision} decimal place${p.precision === 1 ? '' : 's'}` };
  }
  if (n < p.min) return { ok: false, error: `${p.displayLabel.toLowerCase()} cannot be below ${p.min}` };
  if (n > p.max) return { ok: false, error: `${p.displayLabel.toLowerCase()} cannot be above ${p.max}${p.unit ? ' ' + p.unit : ''}` };

  // Round to the profile's precision so two equal runs cannot differ by float
  // noise and rank differently.
  const value = p.precision === 0 ? Math.round(n) : Number(n.toFixed(p.precision));
  return { ok: true, value };
}

// ── Ranking ────────────────────────────────────────────────────────────────

/**
 * Rank rows for display, honouring the profile's direction.
 *
 * A tie is broken by who submitted FIRST, and equal values share a rank
 * ("1,2,2,4"), which is what a reader expects a leaderboard to mean. The
 * direction comes from the profile, so a time trial ranks ascending without any
 * caller needing to know that.
 */
export function rankRows(profileLike, rows) {
  const p = normalizeProfile(profileLike);
  const list = Array.isArray(rows) ? rows : [];
  const valueOf = (r) => {
    const v = Number(r?.value ?? r?.score);
    return Number.isFinite(v) ? v : (p.higherIsBetter ? -Infinity : Infinity);
  };
  const sorted = [...list].sort((a, b) => {
    const d = p.higherIsBetter ? valueOf(b) - valueOf(a) : valueOf(a) - valueOf(b);
    if (d) return d;
    return new Date(a?.created_at || 0) - new Date(b?.created_at || 0);
  });
  let lastValue = null;
  let lastRank = 0;
  return sorted.map((r, i) => {
    const v = valueOf(r);
    if (v !== lastValue) { lastRank = i + 1; lastValue = v; }
    return { ...r, rank: lastRank };
  });
}

/**
 * May two games share one ranking?
 *
 * Only when they measure the same thing in the same direction. This is what
 * stops a "genre leaderboard" from ranking metres, seconds and wins together as
 * though they were interchangeable numbers.
 */
export function isComparable(a, b) {
  const x = normalizeProfile(a);
  const y = normalizeProfile(b);
  return x.metricId === y.metricId && x.unit === y.unit && x.higherIsBetter === y.higherIsBetter;
}

/** A sentence telling the player how this board is ranked. */
export function rankingExplanation(profileLike) {
  const p = normalizeProfile(profileLike);
  const unit = p.unit ? ` (${p.unitLabel || p.unit})` : '';
  return p.higherIsBetter
    ? `Ranked by ${p.displayLabel.toLowerCase()}${unit} — highest first.`
    : `Ranked by ${p.displayLabel.toLowerCase()}${unit} — lowest first, because a smaller value is a better result.`;
}

// ── The player's form ──────────────────────────────────────────────────────

/**
 * Everything the submission form needs, derived from the profile.
 *
 * THE RULE THIS FUNCTION ENFORCES: a 'suggested' profile is rendered as the
 * GENERIC field, never as its suggested metric. A suggestion is evidence for an
 * administrator to act on; showing it to a player would be asserting a unit
 * nobody has checked. Only 'confirmed' changes what a player sees.
 */
export function formFieldFor(profileLike) {
  const p = normalizeProfile(profileLike);
  const shown = p.source === 'confirmed' ? p : defaultProfile(p.slug);

  const unitSuffix = shown.unit ? ` (${shown.unitLabel || shown.unit})` : '';
  return {
    metricId: shown.metricId,
    label: `${shown.displayLabel}${unitSuffix}`,
    unit: shown.unit,
    valueType: shown.valueType,
    precision: shown.precision,
    min: shown.min,
    max: shown.max,
    mode: shown.mode,
    // An integer field gets a numeric keypad; a decimal one must not, or a phone
    // keyboard will not offer a decimal point.
    inputMode: shown.valueType === 'integer' ? 'numeric' : 'decimal',
    step: shown.valueType === 'integer' ? '1' : String(1 / 10 ** shown.precision),
    placeholder: placeholderFor(shown),
    help: rankingExplanation(shown),
    // True when the player is seeing the neutral field because nothing better
    // has been confirmed. The UI uses it to stay honest about self-reporting.
    generic: shown.metricId === DEFAULT_METRIC,
  };
}

function placeholderFor(p) {
  if (p.metricId === DEFAULT_METRIC) return 'e.g. 12500';
  if (p.valueType === 'integer') return 'e.g. 7';
  return p.metricId === 'time_fastest' ? 'e.g. 42.80' : 'e.g. 128.5';
}

// ── Suggestions (for an administrator, never for a player) ─────────────────
//
// Evidence-ordered: a TAG is a stronger signal than a category, and an explicit
// word in the TITLE is stronger still, because categories in this catalog are
// broad buckets ("arcade", "skill") that say almost nothing about scoring.

const TITLE_RULES = [
  [/\b(golf|mini\s*golf|putt)\b/i, 'distance', 'the title names golf, which is scored by distance'],
  [/\b(time\s*trial|speedrun|lap\s*time)\b/i, 'time_fastest', 'the title names a timed format'],
  [/\b(survival|survive|endless|infinite)\b/i, 'survival_time', 'the title names an endless/survival format'],
  [/\b(basketball|basket|soccer|football|hockey|tennis|volleyball)\b/i, 'goals', 'the title names a goal-scoring sport'],
];

const TAG_RULES = [
  [/^(2\s*player|two\s*player|1v1)$/i, 'wins', 'a head-to-head tag — these games are measured in rounds won'],
  [/^(golf)$/i, 'distance', 'a golf tag'],
  [/^(racing|race|drift|car|motorcycle)$/i, 'laps', 'a racing tag'],
  [/^(platform|parkour|runner)$/i, 'distance', 'a running/platforming tag — progress is a distance'],
  [/^(shooting|shooter|sniper|archery)$/i, 'accuracy', 'a shooting tag'],
  [/^(puzzle|match\s*3|sudoku|mahjong)$/i, 'objectives', 'a puzzle tag — progress is puzzles solved'],
  [/^(idle|clicker)$/i, 'points', 'an idle/clicker tag — these are plain point totals'],
];

const CATEGORY_RULES = [
  ['racing', 'laps', 'the racing category'],
  ['sports', 'goals', 'the sports category'],
  ['puzzle', 'objectives', 'the puzzle category'],
  ['shooting', 'accuracy', 'the shooting category'],
  ['io', 'survival_time', 'the .io category — these are usually survival games'],
];

function tagsOf(game) {
  const t = game?.tags;
  const list = Array.isArray(t) ? t : String(t || '').split(',');
  return list.map((x) => String(x || '').trim()).filter(Boolean).slice(0, 12);
}

/**
 * Suggest a metric for a game, with the evidence that produced it.
 *
 * Returns the DEFAULT metric with a null basis when nothing matches — "I cannot
 * tell" is a real answer and is the one that keeps the player's form honest.
 *
 * @returns {{metricId: string, basis: string|null, confidence: 'title'|'tag'|'category'|'none'}}
 */
export function suggestMetric(game) {
  const title = String(game?.title || '');
  for (const [re, metricId, basis] of TITLE_RULES) {
    if (re.test(title)) return { metricId, basis, confidence: 'title' };
  }
  for (const tag of tagsOf(game)) {
    for (const [re, metricId, basis] of TAG_RULES) {
      if (re.test(tag)) return { metricId, basis: `${basis} ("${tag}")`, confidence: 'tag' };
    }
  }
  const cat = String(game?.category || '').toLowerCase().trim();
  for (const [name, metricId, basis] of CATEGORY_RULES) {
    if (cat === name) return { metricId, basis, confidence: 'category' };
  }
  return { metricId: DEFAULT_METRIC, basis: null, confidence: 'none' };
}

/**
 * The profile a game should START with: its suggestion, marked as a suggestion.
 *
 * Never 'confirmed'. The only thing that produces a confirmed profile is an
 * administrator saying so, which is the whole point of the distinction.
 */
export function suggestedProfile(game) {
  const s = suggestMetric(game);
  if (s.metricId === DEFAULT_METRIC) return defaultProfile(game?.slug);
  return normalizeProfile({
    slug: game?.slug,
    metricId: s.metricId,
    source: 'suggested',
    basis: s.basis,
  });
}

/**
 * Does this game still need a human decision?
 *
 * The admin diagnostic behind "games missing a verified score configuration".
 * A game on the neutral default with nothing to suggest is FINE and is not
 * listed — there is no decision waiting on anybody.
 */
export function needsReview(profileLike) {
  const p = normalizeProfile(profileLike);
  return p.source === 'suggested';
}

export default {
  METRICS, METRIC_IDS, DEFAULT_METRIC, PROFILE_SOURCES,
  defaultProfile, normalizeProfile, validateScoreValue, rankRows, isComparable,
  rankingExplanation, formFieldFor, suggestMetric, suggestedProfile, needsReview,
};
