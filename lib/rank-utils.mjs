// lib/rank-utils.mjs — the ranking rules BOTH the feed and the Vibe Finder obey.
// ---------------------------------------------------------------------------
// These three things were about to exist twice, once in lib/recommender.mjs and
// once in lib/vibe-engine.mjs:
//
//   1. what counts as a duplicate title
//   2. how hard to cap a single category
//   3. how to trade relevance against variety
//
// Two copies of a rule is two rules, and the moment one is tuned the other is
// wrong. The catalog genuinely has ~2,348 games sharing a title with another
// game, so rule 1 in particular is load-bearing on every surface: get it wrong
// in one place and that surface shows "Turn 90" three times and reads as broken.

/**
 * Collapse a title to a comparison key.
 *
 * "Moto X3M 2" and "moto  x3m  2!" are the same game surfacing under two slugs
 * (different publishers re-import the same build). Punctuation and spacing are
 * the only difference in the overwhelming majority of those pairs, so
 * normalising both away catches them without needing fuzzy matching.
 *
 * Numbers are KEPT: "Moto X3M 2" and "Moto X3M 3" are genuinely different games
 * and both deserve a slot.
 */
export function titleKey(title) {
  return String(title || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * Greedy Maximal Marginal Relevance with a category quota and title dedupe.
 *
 * @param {object}   o
 * @param {Array}    o.candidates  [{ slug, score, ...}] sorted desc by score
 * @param {Function} o.getGame     slug -> game object | undefined
 * @param {Function} o.simOf       (aSlug, aGame, bGame) -> 0..1 similarity
 * @param {number}   o.limit
 * @param {number}   [o.lambda]    relevance vs variety. 1 = pure relevance.
 * @param {number}   [o.maxCategoryShare]
 * @param {Set}      [o.exclude]   slugs that must never appear
 * @param {Function} [o.label]     slug -> because-label
 * @param {Function} [o.onDeferred] called with candidates the quota rejected
 * @returns {Array} chosen games, each with `because`
 *
 * WHY GREEDY AND NOT OPTIMAL: choosing the best diverse set of k from n is
 * NP-hard. Greedy MMR is the standard approximation and is what every
 * production system uses, because the difference is invisible to a person
 * looking at 18 tiles and the cost difference is enormous.
 */
export function mmrSelect({
  candidates, getGame, simOf, limit,
  lambda = 0.72, maxCategoryShare = 0.4,
  exclude = new Set(), label = () => null, onDeferred = null,
}) {
  const out = [];
  const takenSlugs = new Set();
  const takenTitles = new Set();
  const usedCat = new Map();
  const maxPerCat = Math.max(2, Math.ceil(limit * maxCategoryShare));
  const pool = candidates.slice();

  const tryPush = (slug, why, enforceQuota) => {
    if (takenSlugs.has(slug) || exclude.has(slug)) return false;
    const g = getGame(slug);
    if (!g) return false;
    const tk = titleKey(g.title);
    if (tk && takenTitles.has(tk)) return false;
    const cat = g.category || 'other';
    if (enforceQuota && (usedCat.get(cat) || 0) >= maxPerCat) return false;
    usedCat.set(cat, (usedCat.get(cat) || 0) + 1);
    takenSlugs.add(slug);
    if (tk) takenTitles.add(tk);
    out.push({ ...g, because: why });
    return true;
  };

  const deferred = [];
  while (out.length < limit && pool.length) {
    let bestIdx = -1, bestVal = -Infinity;
    for (let i = 0; i < pool.length; i++) {
      const c = pool[i];
      if (takenSlugs.has(c.slug)) continue;
      const g = getGame(c.slug);
      if (!g) continue;
      let maxSim = 0;
      for (const chosen of out) {
        const s = simOf(c.slug, g, chosen);
        if (s > maxSim) maxSim = s;
      }
      const val = lambda * c.score - (1 - lambda) * maxSim;
      if (val > bestVal) { bestVal = val; bestIdx = i; }
    }
    if (bestIdx === -1) break;
    const chosen = pool[bestIdx];
    if (!tryPush(chosen.slug, label(chosen.slug, chosen), true)) {
      // Rejected by the quota — DEFER, never discard. A player whose taste is
      // entirely one genre would otherwise lose every candidate past the cap
      // and get a half-empty row padded with unrelated filler.
      deferred.push(chosen);
    }
    pool.splice(bestIdx, 1);
  }

  // Top-up with the quota lifted. A slightly single-genre row beats a short one.
  for (const d of deferred) {
    if (out.length >= limit) break;
    tryPush(d.slug, label(d.slug, d), false);
  }
  if (onDeferred) onDeferred(deferred);
  return out;
}

/**
 * Popularity on a curve that saturates.
 *
 * log10 so the 5,000-play game does not outrank the 400-play game by 12x, and
 * capped at 1 so no amount of popularity can override relevance outright.
 * Shared so the feed and the Vibe Finder agree on what "popular" means.
 */
export function popNorm(plays) {
  const p = Number(plays) || 0;
  return Math.min(1, Math.log10(1 + p) / 3);
}

export default { titleKey, mmrSelect, popNorm };
