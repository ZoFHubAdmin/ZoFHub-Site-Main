// Leaderboard review — the human half of the anti-cheat system.
//
// lib/score-integrity.mjs decides whether to quarantine a score. This file is
// what happens next: turning the machine's decision back into something a person
// can act on, and parsing the requests a reviewer's search box produces.
//
// Both jobs are pure functions on purpose. The detector earned its 19 tests by
// being extractable; the same argument applies here, and one of these functions
// builds a PostgREST filter string out of user input, which is not something
// that should only be exercised by clicking around a live dashboard.

// ── Query parsing ──────────────────────────────────────────────────────────

export const STATUSES = ['ok', 'flagged', 'rejected'];
export const SORTS = {
  recent:  { column: 'created_at', ascending: false },
  oldest:  { column: 'created_at', ascending: true },
  highest: { column: 'score',      ascending: false },
  lowest:  { column: 'score',      ascending: true },
};
export const MAX_LIMIT = 100;
export const DEFAULT_LIMIT = 40;

// A search term goes into a PostgREST `or=(...)` filter, where commas, dots and
// parentheses are STRUCTURE, not text. Passing them through would at best break
// the query and at worst let a reviewer's search box rewrite the filter tree, so
// the term is reduced to a conservative charset rather than escaped. Player
// names and slugs live inside it; anything else was never going to match a row.
export function sanitizeTerm(value) {
  if (typeof value !== 'string') return '';
  return value.toLowerCase().replace(/[^a-z0-9 _-]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
}

export function parseScoreQuery(query = {}) {
  const q = sanitizeTerm(query.q);
  const status = STATUSES.includes(query.status) ? query.status
    : query.status === 'all' ? 'all'
    : 'flagged';                       // the review queue is the default view
  const sortKey = Object.hasOwn(SORTS, query.sort) ? query.sort : 'recent';
  const { column, ascending } = SORTS[sortKey];

  // parseInt would accept '40abc' and, worse, '1e20' via Number. Both of those
  // reached Postgres as a range bound once already; see parseRowId's history.
  const asInt = (v, fallback) => {
    const n = typeof v === 'number' ? v : (/^\d+$/.test(String(v ?? '')) ? Number(v) : NaN);
    return Number.isSafeInteger(n) ? n : fallback;
  };
  const limit = Math.min(MAX_LIMIT, Math.max(1, asInt(query.limit, DEFAULT_LIMIT)));
  const offset = Math.min(100_000, Math.max(0, asInt(query.offset, 0)));

  return { q, status, sort: sortKey, column, ascending, limit, offset };
}

// The `or` filter for a search term, or null when there is nothing to search.
export function searchFilter(term) {
  const t = sanitizeTerm(term);
  if (!t) return null;
  return `player_name.ilike.%${t}%,slug.ilike.%${t}%`;
}

// ── Explaining a quarantine ────────────────────────────────────────────────

// What each rule actually means, in the reviewer's language rather than the
// detector's. The keys match lib/score-integrity.mjs's `rules` object.
export const RULE_LABELS = {
  outlier:    'Far beyond the established best',
  noBaseline: 'Large first score on an empty board',
  rate:       'Scoring faster than the game allows',
  duplicate:  'Same score submitted repeatedly',
};

const num = (n) => {
  if (n === null || n === undefined || !Number.isFinite(Number(n))) return null;
  const v = Number(n);
  // Deterministic grouping — toLocaleString depends on the server's ICU locale,
  // which would make these tests pass or fail based on the host.
  const [whole, frac] = String(Math.abs(v)).split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (v < 0 ? '-' : '') + grouped + (frac ? '.' + frac : '');
};

const secs = (ms) => {
  if (!Number.isFinite(Number(ms)) || Number(ms) <= 0) return null;
  const s = Number(ms) / 1000;
  return s < 60 ? `${s.toFixed(1)}s` : `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
};

/**
 * Turn a stored flag_evidence blob into a headline and a list of facts.
 *
 * Rows quarantined before db/community-scores-evidence.sql was applied have no
 * evidence at all — only the reason string. Those are reported as `legacy` so
 * the UI can say "recorded before evidence capture" instead of rendering an
 * empty table that looks like a bug.
 */
export function explainEvidence(evidence, flagReason = null) {
  const ev = evidence && typeof evidence === 'object' && !Array.isArray(evidence) ? evidence : null;
  const rules = ev?.rules && typeof ev.rules === 'object' ? ev.rules : {};
  const fired = Object.keys(RULE_LABELS).filter((k) => rules[k] === true);

  if (!ev) {
    return {
      legacy: true,
      fired: [],
      headline: flagReason ? `Flagged: ${flagReason}` : 'Flagged — no reason recorded',
      note: 'Quarantined before evidence capture was added, so only the reason string exists.',
      facts: [],
    };
  }

  const facts = [];
  const add = (label, value, suspicious = false) => {
    if (value !== null && value !== undefined) facts.push({ label, value, suspicious });
  };

  add('Score submitted', num(ev.score));
  add('Board best at the time',
    ev.boardBest ? num(ev.boardBest) : '0 — nothing to compare against',
    rules.noBaseline === true);
  add('Times the board best',
    ev.ratioToBest === null || ev.ratioToBest === undefined ? null : `${num(ev.ratioToBest)}×`,
    rules.outlier === true);
  add('Measured play time', secs(ev.playedMs), rules.rate === true);
  add('Implied scoring rate', ev.pointsPerSecond === null || ev.pointsPerSecond === undefined
    ? null : `${num(ev.pointsPerSecond)} pts/sec`, rules.rate === true);
  add('Share of the game ceiling', ev.fractionOfCeiling === null || ev.fractionOfCeiling === undefined
    ? null : `${num(Math.round(Number(ev.fractionOfCeiling) * 1000) / 10)}%`,
    rules.noBaseline === true);
  add('Repeat submissions seen', ev.duplicatesSeen ? num(ev.duplicatesSeen) : null,
    rules.duplicate === true);

  return {
    legacy: false,
    fired,
    headline: fired.length
      ? fired.map((k) => RULE_LABELS[k]).join(' + ')
      : (flagReason ? `Flagged: ${flagReason}` : 'Flagged — no rule recorded'),
    // Two independent rules agreeing is a far stronger signal than either alone,
    // and it is the thing a reviewer should notice first.
    note: fired.length > 1 ? `${fired.length} independent checks agree.` : null,
    facts,
  };
}

/**
 * Roll a player's submissions into the numbers that answer "is this person
 * cheating, or did one score look odd?" — the question a single flagged row
 * cannot answer on its own.
 */
export function summarizePlayer(rows = []) {
  const list = Array.isArray(rows) ? rows : [];
  const counted = (s) => list.filter((r) => r?.status === s).length;
  const games = new Set(list.map((r) => r?.slug).filter(Boolean));
  const scores = list.map((r) => Number(r?.score)).filter(Number.isFinite);
  const flagged = counted('flagged');
  const rejected = counted('rejected');
  return {
    submissions: list.length,
    games: games.size,
    ok: counted('ok'),
    flagged,
    rejected,
    bestScore: scores.length ? Math.max(...scores) : 0,
    // A player with one flag out of forty is noise. One out of one is a pattern.
    // Surfacing the rate stops a reviewer from having to eyeball the table.
    flagRate: list.length ? Math.round(((flagged + rejected) / list.length) * 100) : 0,
  };
}
