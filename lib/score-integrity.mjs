// lib/score-integrity.mjs
// ---------------------------------------------------------------------------
// Decide whether a submitted score should go straight to the public board or be
// held for review. Pure: no database, no network, no clock. Everything it needs
// is passed in, so every rule below is testable directly and CI can exercise it
// without secrets.
//
// DESIGN RULE: this function QUARANTINES, it does not reject.
//
// A rejected score is gone and the player is told they cheated. A quarantined
// score is invisible until an administrator looks at it, and approving it
// restores it intact. Those failure modes are not symmetric — a false positive
// on quarantine costs a moderator ten seconds, a false positive on rejection
// costs a real player their run and their trust. Hard rejection is reserved for
// the per-game plausibility ceiling in server.js, which is a statement about
// what the GAME can produce, not a guess about the player.
//
// WHAT WAS ALREADY HERE
// The original detector was one rule: score > 6x the established board best,
// active only once the best was >= 50. It is preserved verbatim below as
// `outlier`, because it is a good rule. The additions close holes around it.
// ---------------------------------------------------------------------------

/** A new score must beat the board best by this much to look suspicious. */
export const OUTLIER_FACTOR = 6;
/** ...but only once the board HAS a best worth comparing against. */
export const OUTLIER_BASELINE = 50;

/**
 * On a board with no established best, `outlier` cannot fire at all — there is
 * nothing to be 6x of. That left the first score on every game unchecked up to
 * the hard ceiling, and it is the first score that sets the baseline every later
 * comparison uses. One submission of 4,999,999 on a fresh board became "normal",
 * and from then on only a score above 30 million looked odd.
 *
 * So: with no baseline, judge against the game's own declared ceiling instead.
 * Half is deliberately generous — this is the opening claim on an empty board,
 * not evidence of anything, and it only asks a human to glance at it.
 */
export const FIRST_SCORE_CEILING_FRACTION = 0.5;

/**
 * Points per second that no human input can sustain. Deliberately far above real
 * play — idle and clicker games legitimately produce thousands per second — so
 * this only catches the shape it is aimed at: burn a session, wait the minimum
 * play time, submit near the ceiling. Overridable per game via
 * data/score-limits.json (`maxPerSecond`), for a game that genuinely goes higher.
 */
export const MAX_POINTS_PER_SECOND = 50_000;

/** Identical score, same game, same source, seen this many times recently => replay. */
export const DUPLICATE_THRESHOLD = 3;

/**
 * @param {object} input
 * @param {number} input.score        the submitted score
 * @param {number} input.best         current public best for this game (0 if none)
 * @param {number} input.ceiling      per-game plausibility ceiling
 * @param {number} [input.playedMs]   measured session play time, from consumeSession()
 * @param {number} [input.duplicates] how many identical recent scores from this source
 * @param {number} [input.maxPerSecond] per-game override for the rate rule
 * @returns {{flagged: boolean, reason: string|null, evidence: object}}
 */
export function assessScore({ score, best = 0, ceiling, playedMs, duplicates = 0, maxPerSecond } = {}) {
  const s = Number(score);
  const b = Number(best) || 0;
  const cap = Number(ceiling) > 0 ? Number(ceiling) : Infinity;
  const played = Number.isFinite(Number(playedMs)) && Number(playedMs) > 0 ? Number(playedMs) : null;
  const rateCap = Number(maxPerSecond) > 0 ? Number(maxPerSecond) : MAX_POINTS_PER_SECOND;

  // Everything the reviewer needs, recorded whether or not a rule fires — the
  // numbers are just as useful for tuning a threshold that did NOT fire.
  const evidence = {
    score: s,
    boardBest: b,
    ceiling: Number.isFinite(cap) ? cap : null,
    ratioToBest: b > 0 ? Number((s / b).toFixed(2)) : null,
    fractionOfCeiling: Number.isFinite(cap) && cap > 0 ? Number((s / cap).toFixed(4)) : null,
    playedMs: played,
    pointsPerSecond: played ? Number((s / (played / 1000)).toFixed(1)) : null,
    duplicatesSeen: duplicates,
    rules: { outlier: false, noBaseline: false, rate: false, duplicate: false },
  };

  if (!Number.isFinite(s) || s <= 0) {
    return { flagged: false, reason: null, evidence };
  }

  // 1. The original rule, unchanged.
  if (b >= OUTLIER_BASELINE && s > b * OUTLIER_FACTOR) evidence.rules.outlier = true;

  // 2. The empty-board hole.
  if (b < OUTLIER_BASELINE && Number.isFinite(cap) && s > cap * FIRST_SCORE_CEILING_FRACTION) {
    evidence.rules.noBaseline = true;
  }

  // 3. Implied rate. Only meaningful when play time was actually measured.
  if (played && evidence.pointsPerSecond > rateCap) evidence.rules.rate = true;

  // 4. The same score, from the same source, over and over.
  if (duplicates >= DUPLICATE_THRESHOLD) evidence.rules.duplicate = true;

  // Report every rule that fired, not just the first. Two rules agreeing is a
  // much stronger signal than either alone, and a reviewer should see that.
  const fired = Object.entries(evidence.rules).filter(([, v]) => v).map(([k]) => k);
  return {
    flagged: fired.length > 0,
    reason: fired.length ? fired.join('+') : null,
    evidence,
  };
}
