// lib/vibe-engine.mjs — rank the catalog against a parsed vibe.
// ---------------------------------------------------------------------------
// Input:  a VibeIntent (lib/vibe-intent.mjs) + the live catalog.
// Output: ranked games, each carrying WHY it was chosen.
//
// ── THE CONFIDENCE TRAP, AND WHY IT DOMINATES THIS FILE ────────────────────
// data/game-attributes.json gives every game six axes AND a confidence. Between
// 39% and 76% of the catalog has NO evidence on any given axis, and those games
// are recorded at 0.5 — the honest "we do not know".
//
// Scoring by raw distance-to-target would then hand every mid-range request to
// the games we know nothing about: a request for challenge 0.5 scores a perfect
// 0 distance against 148 games with a real mid rating AND against every game
// that simply had no evidence. The unknowns are far more numerous, so they win.
// The feature would look like it worked — real games, plausible order — while
// systematically surfacing the least-understood corner of the catalog.
//
// So every axis contribution is scaled by the game's confidence, and a
// low-confidence game is scored against a NEUTRAL baseline instead of being
// treated as a perfect match. `unknownPenalty` is what makes "we don't know"
// rank below "we know it fits" and above "we know it doesn't".

import { titleKey, mmrSelect, popNorm } from './rank-utils.mjs';

// ── The /api/vibe response contract ────────────────────────────────────────
// Every path through the route returns THIS shape, with every field present.
//
// It did not before. There are three exits — the empty-query guard, the
// no-attributes fallback, and the main ranker — and they returned three
// different objects: the first omitted `understood`, `personalized` and
// `candidates`, the second omitted `candidates`, only the third was complete.
// Nothing was wrong on the server; the cost landed entirely on the client,
// which had to treat every field as possibly-absent and could not tell "the
// ranker considered 0 candidates" from "this exit does not report candidates".
//
// `count` is DERIVED from games.length rather than passed in. It was previously
// set alongside the array by each caller, which is a correctness claim nobody
// was checking — two of the three exits computed it from a different variable
// than the one they returned.
export const VIBE_SOURCES = Object.freeze([
  'empty',            // no query text
  'local-keywords',   // curated mood map only
  'ai',               // curated map + the keyword-refinement model
  'attributes',       // the attribute ranker (the normal path)
  'attributes+ai',    // attribute ranker, keywords widened by the model
  'fallback',         // nothing matched; a usable shelf was substituted
]);
const SOURCE_SET = new Set(VIBE_SOURCES);

/**
 * Normalise any partial result into the full contract.
 *
 * Total and defensive: an unexpected `source`, a non-array `games`, a missing
 * field or a hostile cached object all produce a valid response rather than a
 * shape the client has to guard against.
 */
export function vibeResponse(partial = {}) {
  const p = (partial && typeof partial === 'object') ? partial : {};
  const games = Array.isArray(p.games) ? p.games : [];
  const keywords = Array.isArray(p.keywords)
    ? p.keywords.filter(k => typeof k === 'string' && k).slice(0, 10)
    : [];
  return {
    games,
    count: games.length,
    keywords,
    understood: typeof p.understood === 'string' ? p.understood : '',
    // An unknown source is reported as 'fallback' rather than echoed: the field
    // exists so the client can branch on it, and a value outside the enum is
    // exactly the thing that would break that branch.
    source: SOURCE_SET.has(p.source) ? p.source : 'fallback',
    personalized: p.personalized === true,
    candidates: Number.isFinite(p.candidates) && p.candidates >= 0
      ? Math.floor(p.candidates) : 0,
    cached: p.cached === true,
  };
}

import { AXES } from './vibe-intent.mjs';

// How much a game we know nothing about is docked, relative to a confident
// match. Not 1.0 (that would hide ~40% of the catalog from every query, and a
// 10-minute request would return nothing on a fresh index) and not 0 (that is
// the trap above). 0.35 keeps unknowns eligible but never preferred.
const UNKNOWN_PENALTY = 0.35;

// Weight of the popularity prior. Small on purpose: with 0 plays across the
// whole catalog today this term is inert, and when plays do accrue it must
// break ties, not decide them.
const POP_WEIGHT = 0.18;

// A literal keyword hit ("zombie") is strong evidence — stronger than any single
// axis — because the player named the thing.
const KEYWORD_WEIGHT = 0.55;
const CATEGORY_WEIGHT = 0.40;

// A negated keyword is a near-veto, not a nudge. Someone who says "not scary"
// and gets a horror game has been actively failed, which is worse than getting a
// merely mediocre match.
const NEGATED_PENALTY = 1.5;

// Session-length tolerance. |log2(actual/target)| — so 5 vs 10 minutes and 20 vs
// 10 minutes are equally wrong, which matches how people experience it: half as
// long and twice as long are both "not what I asked for".
const SESSION_TOLERANCE = 1.15;

/**
 * How well one game fits an intent. Returns { score, reasons }.
 * Pure and synchronous — no I/O, no catalog access.
 */
export function scoreGame(game, attrs, intent, opts = {}) {
  const reasons = [];
  let score = 0;
  let axisWeightTotal = 0;
  let axisScoreTotal = 0;

  const conf = attrs ? (attrs.confidence ?? 0) : 0;

  // ── Axis fit ─────────────────────────────────────────────────────────────
  for (const axis of AXES) {
    const t = intent.targets[axis];
    if (!t) continue;
    axisWeightTotal += t.weight;
    if (!attrs || conf <= 0.02) {
      // No opinion about this game — score it as a partial match so it stays
      // eligible without displacing a game we can actually vouch for.
      axisScoreTotal += t.weight * (1 - UNKNOWN_PENALTY);
      continue;
    }
    const actual = attrs[axis];
    if (typeof actual !== 'number') {
      axisScoreTotal += t.weight * (1 - UNKNOWN_PENALTY);
      continue;
    }
    // Distance -> fit. |a-t| is at most 1, so fit is already 0..1.
    const fit = 1 - Math.abs(actual - t.value);
    // Blend toward the neutral baseline by confidence: a 0.2-confidence game
    // gets mostly the baseline, a 0.9-confidence game gets mostly its real fit.
    const blended = conf * fit + (1 - conf) * (1 - UNKNOWN_PENALTY);
    axisScoreTotal += t.weight * blended;

    if (conf >= 0.25 && fit >= 0.82 && t.weight >= 1.2) {
      reasons.push(axis);
    }
  }
  if (axisWeightTotal > 0) score += axisScoreTotal / axisWeightTotal;

  // ── Hard bounds ──────────────────────────────────────────────────────────
  // "not frustrating" produced a ceiling. A game past it is not merely a worse
  // match, it is the thing they asked to avoid — so it is pushed out of
  // contention rather than ranked slightly lower.
  if (intent.bounds && attrs && conf >= 0.25) {
    for (const [axis, b] of Object.entries(intent.bounds)) {
      const v = attrs[axis];
      if (typeof v !== 'number') continue;
      if (b.max !== undefined && v > b.max) score -= 0.8 * (v - b.max) * 4;
      if (b.min !== undefined && v < b.min) score -= 0.8 * (b.min - v) * 4;
    }
  }

  // ── Session length ───────────────────────────────────────────────────────
  if (intent.sessionMin && attrs && typeof attrs.session_min === 'number') {
    const ratio = attrs.session_min / intent.sessionMin;
    const off = Math.abs(Math.log2(Math.max(0.05, ratio)));
    const fit = Math.max(0, 1 - off / SESSION_TOLERANCE);
    // Weighted like a strong axis: when someone says "10 minutes" they mean it.
    score += 0.9 * fit;
    if (fit >= 0.7) reasons.push('session');
  }

  // ── Literal keywords ─────────────────────────────────────────────────────
  const title = String(game.title || '').toLowerCase();
  const cat = String(game.category || '').toLowerCase();
  const tags = Array.isArray(game.tags) ? game.tags : [];
  const tagSet = opts.tagSet || new Set(tags.map(t => String(t).toLowerCase()));

  let kwHits = 0;
  for (const k of intent.keywords) {
    if (k.length < 3) continue;
    let hit = 0;
    if (tagSet.has(k)) hit = Math.max(hit, 1.0);
    if (cat === k) hit = Math.max(hit, 1.0);
    else if (cat.includes(k)) hit = Math.max(hit, 0.6);
    if (title.includes(k)) hit = Math.max(hit, 0.85);
    if (hit > 0) { score += KEYWORD_WEIGHT * hit; kwHits += 1; }
  }
  if (kwHits) reasons.push('keyword');

  // ── Negated keywords ─────────────────────────────────────────────────────
  for (const k of intent.negatedKeywords) {
    if (k.length < 3) continue;
    if (tagSet.has(k) || title.includes(k) || cat.includes(k)) {
      score -= NEGATED_PENALTY;
    }
  }

  // ── Category affinity from the intent's implied categories ───────────────
  if (opts.wantCategories && opts.wantCategories.has(cat)) {
    score += CATEGORY_WEIGHT;
  }

  // ── Taste (optional personalization) ─────────────────────────────────────
  // Kept OUTSIDE the axis maths so the Vibe Finder works identically for a
  // first-time visitor. See blendTaste() for why it is capped this low.
  if (opts.tasteBoost) score += opts.tasteBoost;

  // ── Popularity prior ─────────────────────────────────────────────────────
  if (opts.plays) score += POP_WEIGHT * popNorm(opts.plays);

  return { score, reasons };
}

/**
 * Build intent targets FROM a game — "something like the one I just played".
 *
 * Without this, a reference request carries no axis targets at all, so almost
 * every game scores ~0 and only the handful boosted by taste clear the floor.
 * Measured before this existed: "something like the game I just played"
 * returned FOUR games instead of eighteen.
 *
 * Only axes the source game is confident about become targets — copying a 0.5
 * "we don't know" into a target would ask the catalog to match our ignorance.
 * Weight is scaled by confidence for the same reason.
 */
export function targetsFromGame(attrs) {
  if (!attrs || (attrs.confidence ?? 0) < 0.15) return null;
  const targets = {};
  for (const axis of AXES) {
    const v = attrs[axis];
    if (typeof v !== 'number') continue;
    // 0.5 is the module's explicit "no evidence" value. Treating it as a target
    // would make every unknown game a perfect match — the confidence trap this
    // file opens by describing.
    if (Math.abs(v - 0.5) < 0.02) continue;
    targets[axis] = { value: v, weight: 1.4 * Math.min(1, attrs.confidence * 2) };
  }
  return Object.keys(targets).length ? targets : null;
}

/**
 * Attribute-space distance, used as the diversity signal for MMR.
 *
 * The recommender uses its similarity INDEX for this. Here we have real vectors,
 * which is strictly better: two racing games with different pace and challenge
 * are genuinely different recommendations, and index similarity would call them
 * near-identical and suppress one.
 */
export function attrSimilarity(a, b) {
  if (!a || !b) return 0;
  let sum = 0, n = 0;
  for (const axis of AXES) {
    if (typeof a[axis] !== 'number' || typeof b[axis] !== 'number') continue;
    sum += Math.abs(a[axis] - b[axis]);
    n += 1;
  }
  if (!n) return 0;
  return Math.max(0, 1 - sum / n);
}

/**
 * Rank the catalog for a vibe.
 *
 * @param {object}   o
 * @param {object}   o.intent      from parseVibe()
 * @param {Function} o.pool        () -> all candidate games
 * @param {Function} o.attrsOf     slug -> attribute record | undefined
 * @param {Function} o.getGame     slug -> game | undefined
 * @param {number}   [o.limit]
 * @param {Function} [o.playsOf]
 * @param {Map}      [o.taste]     slug -> weight, the caller's taste profile
 * @param {Function} [o.neighboursOf] slug -> [[slug, sim]] for taste expansion
 * @param {Set}      [o.exclude]   slugs to never return (recently played/skipped)
 * @param {number}   [o.lambda]
 * @returns {{games: Array, scanned: number, matched: number}}
 */
export function rankByVibe({
  intent, pool, attrsOf, getGame, limit = 18, playsOf = null,
  taste = null, neighboursOf = null, exclude = new Set(), lambda = 0.74,
}) {
  const games = pool();
  // Categories the literal keywords imply, so "zombie" also lifts the adventure
  // category rather than only games with "zombie" in the title.
  const wantCategories = new Set();
  for (const k of intent.keywords) {
    const c = KEYWORD_CATEGORY[k];
    if (c) wantCategories.add(c);
  }

  // Taste expansion: turn the caller's played/favourited slugs into a boost map
  // over their neighbours, so personalization can lift a game the player has
  // never seen. Capped hard — see blendTaste().
  const tasteBoost = taste && taste.size ? blendTaste(taste, neighboursOf) : null;

  const scored = [];
  for (const g of games) {
    if (!g || !g.slug || exclude.has(g.slug)) continue;
    const attrs = attrsOf(g.slug);
    const { score, reasons } = scoreGame(g, attrs, intent, {
      plays: playsOf ? playsOf(g.slug) : 0,
      wantCategories,
      tasteBoost: tasteBoost ? (tasteBoost.get(g.slug) || 0) : 0,
    });
    if (score > 0.15) scored.push({ slug: g.slug, score, reasons, attrs });
  }

  scored.sort((a, b) => b.score - a.score);
  // Bound the MMR pass. Beyond a few hundred candidates the tail cannot reach
  // the output, and MMR is O(picked x candidates).
  const shortlist = scored.slice(0, Math.max(limit * 14, 220));
  const attrById = new Map(shortlist.map(s => [s.slug, s.attrs]));
  const reasonById = new Map(shortlist.map(s => [s.slug, s.reasons]));

  const chosen = mmrSelect({
    candidates: shortlist,
    getGame,
    simOf: (slug, a, b) => attrSimilarity(attrById.get(slug), attrById.get(b.slug)),
    limit,
    lambda,
    exclude,
    label: (slug) => ({ kind: 'vibe', reasons: reasonById.get(slug) || [] }),
  });

  return { games: chosen, scanned: games.length, matched: scored.length };
}

/**
 * Turn a taste profile into a per-slug boost.
 *
 * CAPPED AT 0.3 ON PURPOSE. The Vibe Finder answers an EXPLICIT request, and an
 * explicit request must beat an inferred preference every time. Someone who
 * normally plays racing games and types "something relaxing" is telling you
 * their history is not what they want right now — if taste could outweigh the
 * axes, they would get racing games and the feature would be useless precisely
 * when it matters most. Personalization here breaks ties among games that
 * already match the vibe; it never selects the vibe.
 */
function blendTaste(taste, neighboursOf) {
  const boost = new Map();
  const add = (slug, v) => boost.set(slug, Math.min(0.3, (boost.get(slug) || 0) + v));
  for (const [slug, w] of taste) {
    if (!neighboursOf) continue;
    for (const [nb, sim] of neighboursOf(slug)) {
      add(nb, 0.3 * w * sim);
    }
  }
  return boost;
}

// Keyword -> catalog category. Only confident, unambiguous mappings; an
// ambiguous entry here quietly redirects a whole query to the wrong 1,200 games.
// Mirrors the mapping server.js already used for the old bucket path, kept here
// so both paths agree on what "shooter" implies.
export const KEYWORD_CATEGORY = {
  race: 'racing', racing: 'racing', drift: 'racing', car: 'racing', cars: 'racing',
  parking: 'racing', truck: 'racing', moto: 'racing', traffic: 'racing', drive: 'racing',
  driving: 'racing', bike: 'racing',
  shoot: 'shooting', shooter: 'shooting', sniper: 'shooting', gun: 'shooting',
  guns: 'shooting', fps: 'shooting', strike: 'shooting', shooting: 'shooting',
  soccer: 'sports', football: 'sports', basketball: 'sports', golf: 'sports',
  bowling: 'sports', tennis: 'sports', sport: 'sports', sports: 'sports', dunk: 'sports',
  puzzle: 'puzzle', sudoku: 'puzzle', word: 'puzzle', jigsaw: 'puzzle', logic: 'puzzle',
  brain: 'puzzle', memory: 'puzzle', quiz: 'puzzle', chess: 'puzzle', crossword: 'puzzle',
  mahjong: 'mahjong-solitaire', solitaire: 'mahjong-solitaire',
  bubble: 'bubble-shooter',
  dress: 'girls', makeover: 'girls', salon: 'girls', fashion: 'girls',
  princess: 'girls', wedding: 'girls', beauty: 'girls', hair: 'girls', baby: 'girls',
  adventure: 'adventure', quest: 'adventure', dragon: 'adventure', ninja: 'adventure',
  dungeon: 'adventure', knight: 'adventure', survival: 'adventure', zombie: 'adventure',
  horror: 'adventure', scary: 'adventure', ghost: 'adventure', granny: 'adventure',
  fight: 'action', battle: 'action', boxing: 'action', punch: 'action',
  ragdoll: 'action', kombat: 'action', smash: 'action', stickman: 'action',
  run: 'hypercasual', jump: 'hypercasual', dash: 'hypercasual', flappy: 'hypercasual',
  stack: 'hypercasual', helix: 'hypercasual', parkour: 'hypercasual',
  idle: 'clicker', clicker: 'clicker', tycoon: 'clicker',
  tetris: 'retro', pixel: 'retro', snake: 'retro', pinball: 'retro', retro: 'retro',
  multiplayer: 'multiplayer', io: 'multiplayer',
};

export default { rankByVibe, scoreGame, attrSimilarity, KEYWORD_CATEGORY };
