// ============================================================================
// scores.mjs — leaderboard rules, with no database and no Express in sight.
//
// WHY THIS FILE EXISTS SEPARATELY. Every rule here is a decision about whether
// to trust a number a stranger typed. Those decisions are the feature; the SQL
// around them is plumbing. Keeping them pure means they can be tested directly
// instead of through a live table.
//
// WHAT THE SCHEMA ALREADY DECIDED. db/community.sql and
// db/community-scores-integrity.sql describe a leaderboard of PLAYER-REPORTED
// scores, and say in as many words that the server enforces "single-use
// proof-of-play sessions + per-game score ceilings", holding outliers at
// status='flagged' for review. The games are third-party cross-origin iframes,
// so there is no way to read a real score out of one — self-reporting is not a
// shortcut here, it is the only thing possible, and that is exactly why the
// quarantine exists. This file implements those rules rather than inventing new
// ones.
//
// THE THREAT MODEL, PLAINLY. None of this makes a self-reported score true. It
// makes a fake score cost something: you must have opened the game, waited a
// plausible length of time, used a token that works once, and landed inside a
// believable range. Anything outside that is held back from the public board
// rather than shown and quietly believed.
// ============================================================================

import { randomBytes } from 'node:crypto';

export const SCORE_MAX = Number(process.env.SCORE_MAX) || 1_000_000_000;
export const NAME_MAX = 40;                       // matches varchar(40) in the schema
export const MIN_PLAY_MS = Number(process.env.SCORE_MIN_PLAY_MS) || 8_000;
export const SESSION_TTL_MS = Number(process.env.SCORE_SESSION_TTL_MS) || 6 * 60 * 60 * 1000;
export const OUTLIER_FACTOR = Number(process.env.SCORE_OUTLIER_FACTOR) || 10;

export const STATUS = { OK: 'ok', FLAGGED: 'flagged' };
export const REASON = {
  CEILING: 'above_absolute_ceiling',
  OUTLIER: 'far_above_existing_board',
  FAST: 'submitted_too_fast',
};

/**
 * Normalise a player name.
 *
 * Anything that is not a string becomes the default rather than throwing —
 * `{"player_name":{"$ne":null}}` and `["x"]` must travel the ordinary path, not
 * a cheaper one. Control characters are stripped because this string is
 * rendered in a list next to other people's names.
 */
export function cleanName(value) {
  if (typeof value !== 'string') return 'Player';
  // Written as a codepoint filter rather than a regex full of escapes: control
  // characters, the zero-width and bidi ranges and the line separators are
  // exactly the characters that let one player's name disturb the rendering of
  // every row around it, and this way the intent stays readable.
  const stripped = Array.from(value).filter((ch) => {
    const c = ch.codePointAt(0);
    if (c < 0x20 || c === 0x7f) return false;         // control characters
    if (c >= 0x200b && c <= 0x200f) return false;     // zero-width + bidi marks
    if (c >= 0x202a && c <= 0x202e) return false;     // bidi overrides
    if (c === 0x2028 || c === 0x2029) return false;   // line/paragraph separators
    return true;
  }).join('');
  const s = stripped.replace(/\s+/g, ' ').trim().slice(0, NAME_MAX);
  return s || 'Player';
}

/**
 * Coerce a submitted score to a safe integer, or null when it is not one.
 *
 * Rejects the shapes Number() is too generous about — '1e9', '0x10', '12abc',
 * Infinity, negatives and fractions. Surrounding whitespace IS accepted and
 * trimmed: this value is typed by a person into a text input, and a trailing
 * space is a typo rather than an attempt at an alternate spelling.
 */
export function cleanScore(value) {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 0 && value <= SCORE_MAX ? value : null;
  }
  if (typeof value !== 'string') return null;
  if (!/^\d{1,15}$/.test(value.trim())) return null;
  const n = Number(value.trim());
  return Number.isSafeInteger(n) && n >= 0 && n <= SCORE_MAX ? n : null;
}

/**
 * Validate a whole submission. Returns { ok, value } or { ok:false, error }.
 * `slugExists` is injected so this stays free of the catalog.
 */
export function validateSubmission(body, slugExists) {
  const slug = typeof body?.slug === 'string' ? body.slug.trim().toLowerCase() : '';
  if (!/^[a-z0-9][a-z0-9-]{0,119}$/.test(slug)) return { ok: false, error: 'bad slug' };
  if (typeof slugExists === 'function' && !slugExists(slug)) return { ok: false, error: 'unknown game' };

  const score = cleanScore(body?.score);
  if (score === null) return { ok: false, error: 'score must be a whole number in range' };

  return { ok: true, value: { slug, score, playerName: cleanName(body?.player_name ?? body?.playerName) } };
}

/**
 * Decide whether a valid submission may appear on the public board.
 *
 * `board` is the existing VISIBLE scores for this game (numbers, any order).
 * A first score on an empty board cannot be an outlier relative to anything, so
 * only the absolute ceiling applies — otherwise the very first honest player
 * would be quarantined for having no predecessors.
 */
export function classifyScore(score, board = [], { playedMs } = {}) {
  if (Number.isFinite(playedMs) && playedMs < MIN_PLAY_MS) {
    return { status: STATUS.FLAGGED, reason: REASON.FAST };
  }
  if (score > SCORE_MAX) return { status: STATUS.FLAGGED, reason: REASON.CEILING };

  const known = board.filter((n) => Number.isFinite(n) && n > 0);
  if (known.length >= 3) {
    const best = Math.max(...known);
    if (best > 0 && score > best * OUTLIER_FACTOR) {
      return { status: STATUS.FLAGGED, reason: REASON.OUTLIER };
    }
  }
  return { status: STATUS.OK, reason: null };
}

/**
 * Rank rows for display: score desc, then earliest submission first so a tie is
 * broken by who got there first rather than by whatever order the database felt
 * like returning. Equal scores share a rank ("1,2,2,4"), which is what a reader
 * expects a leaderboard to mean.
 */
export function rank(rows) {
  const sorted = [...rows].sort((a, b) => {
    const d = (Number(b.score) || 0) - (Number(a.score) || 0);
    if (d) return d;
    return new Date(a.created_at || 0) - new Date(b.created_at || 0);
  });
  let lastScore = null, lastRank = 0;
  return sorted.map((r, i) => {
    const s = Number(r.score) || 0;
    if (s !== lastScore) { lastRank = i + 1; lastScore = s; }
    return { ...r, rank: lastRank };
  });
}

/**
 * Strip a database row down to what a public leaderboard actually needs.
 * The row carries an id and a created_at; neither belongs in a public response,
 * and the id is a sequential integer that leaks how many scores exist.
 */
export function publicRow(r) {
  return {
    rank: r.rank,
    player_name: r.player_name,
    score: Number(r.score) || 0,
    slug: r.slug,
    at: r.created_at ? new Date(r.created_at).toISOString().slice(0, 10) : null,
  };
}

// ── Proof-of-play sessions ──────────────────────────────────────────────────
// A single-use token, handed out when a game is actually opened and required
// back when a score is submitted. In memory on purpose: it must work with no
// database, and a token that outlives a restart is not worth the storage.
const sessions = new Map();          // token -> { slug, issued, used, owner }
const SESSION_MAX = 20000;

// PER-ADDRESS QUOTA. The store is global and bounded, and the old overflow rule
// dropped the OLDEST tokens — anybody's. One address issuing tokens as fast as
// its rate limit allowed could therefore push every other visitor's token out,
// and their next score would fail as "unknown or expired" with nothing to
// explain why. Each owner (a keyed hash of the client address) now has its own
// FIFO slice: past the quota, an owner's OWN oldest token is dropped. A flood
// can only evict itself.
//
// Sized for a school NAT, where one address is a whole building: 300 pupils
// each opening a handful of games inside the 6-hour token lifetime is ~1,500.
export const SESSION_MAX_PER_OWNER = Number(process.env.SCORE_SESSION_MAX_PER_OWNER) || 2000;
const byOwner = new Map();           // owner -> [token, ...] in issue order

function forget(token) {
  const s = sessions.get(token);
  if (!s) return;
  sessions.delete(token);
  const list = byOwner.get(s.owner);
  if (!list) return;
  const i = list.indexOf(token);
  if (i !== -1) list.splice(i, 1);
  if (!list.length) byOwner.delete(s.owner);
}

// A full sweep walks every token, so it runs at most once a minute rather than
// on every issue — the old code did the whole walk per request.
let lastSweep = 0;
function sweepSessions(now) {
  if (now - lastSweep < 60_000 && sessions.size < SESSION_MAX) return;
  lastSweep = now;
  for (const [t, s] of sessions) {
    if (now - s.issued > SESSION_TTL_MS) forget(t);
  }
  // Still over the global bound after expiry: shed from the LARGEST owner, so
  // the address holding the most tokens pays for the overflow, not a bystander.
  while (sessions.size >= SESSION_MAX) {
    let biggest = null, n = 0;
    for (const [o, list] of byOwner) if (list.length > n) { biggest = o; n = list.length; }
    if (!biggest) break;
    forget(byOwner.get(biggest)[0]);
  }
}

/**
 * Issue a single-use play token for `slug`.
 * `owner` identifies the requesting address (the server passes a keyed hash);
 * it is used only for the per-address quota and is never returned or stored
 * anywhere but this in-memory map.
 */
export function issueSession(slug, now = Date.now(), owner = 'unknown') {
  sweepSessions(now);
  const list = byOwner.get(owner) || [];
  while (list.length >= SESSION_MAX_PER_OWNER) forget(list[0]);
  const token = randomBytes(18).toString('base64url');
  sessions.set(token, { slug, issued: now, used: false, owner });
  list.push(token);
  byOwner.set(owner, list);
  return token;
}

/**
 * Consume a token. Returns { ok, playedMs } or { ok:false, error }.
 * Single use: a second call with the same token fails, so one opened game
 * cannot be turned into a stream of submissions.
 */
export function consumeSession(token, slug, now = Date.now()) {
  if (typeof token !== 'string' || !token) return { ok: false, error: 'missing play token' };
  const s = sessions.get(token);
  if (!s) return { ok: false, error: 'play token is unknown or expired' };
  if (s.used) { forget(token); return { ok: false, error: 'play token already used' }; }
  if (s.slug !== slug) return { ok: false, error: 'play token is for a different game' };
  if (now - s.issued > SESSION_TTL_MS) { forget(token); return { ok: false, error: 'play token expired' }; }
  s.used = true;
  forget(token);
  return { ok: true, playedMs: now - s.issued };
}

/** Test seam. */
export function _resetSessions() { sessions.clear(); byOwner.clear(); lastSweep = 0; }
export const _sessionCount = () => sessions.size;
