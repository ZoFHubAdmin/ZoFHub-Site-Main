// lib/active-roster.mjs — the "serve exactly N games" roster.
// ---------------------------------------------------------------------------
// WHAT THIS IS. The catalog master pool is large (thousands of candidate games).
// This module decides WHICH of them are ACTIVE — the subset the public site
// actually lists and serves. The active set is FIXED at ACTIVE_GAMES_CAP
// (default 100) and does not grow on its own.
//
// ── HISTORY, BECAUSE THE SEMANTICS REVERSED ────────────────────────────────
// This file used to implement "start at 100 and grow +30 every 36 hours", and
// `reconcileRoster`'s target was deliberately a FLOOR so the grow job could push
// the roster past it. That had a consequence nobody asked for: the roster file on
// this machine had reached 129 slugs, so the site was serving 129 games while
// every surface still described it as a 100-game catalog. The cap could not
// correct it, because a floor cannot.
//
// The product decision is now the opposite: the catalog is a CURATED SET OF A
// FIXED SIZE and nothing adds to it automatically. So:
//
//   · the target is a HARD CEILING — reconcileRoster truncates a roster that is
//     over it, which is what makes the 129 → 100 correction happen by itself on
//     the next catalog build rather than needing a migration;
//   · growRoster() is GONE, not merely unscheduled. A pure helper left lying
//     around is an invitation to re-wire it, and "no automatic additions" is
//     easier to keep true when the machinery to add does not exist.
//
// WHICH 100 SURVIVE A TRUNCATION. The roster's own order, kept from the front.
// Growth appended, so the first 100 entries are exactly the originally-seeded
// 100 — trimming removes what the grow job added and restores the intended set,
// rather than picking a fresh arbitrary 100 and breaking every bookmark.
//
// WHY A ROSTER FILE and not just "first N of the pool": the active set must be
// STABLE. Recomputed as "first 100" on every catalog refresh, pool reordering
// (imports, spreadCatalog) would silently swap games in and out, breaking
// bookmarks, the sitemap and the whole point of a curated set. So the chosen
// slugs are PERSISTED (data/active-roster.json) and only change when a game is
// delisted or an operator deliberately changes the set.
//
// PURE CORE. The functions here take plain data and return plain data — no file
// I/O, no clock, no catalog object — so they are unit-testable. server.js owns
// reading/writing the file and calling these at catalog-build time.
//
// DISABLED BY DEFAULT-OFF SEMANTICS. A cap of 0 (or negative) means "no cap" —
// selectActive returns the whole pool unchanged, and nothing is persisted. That
// is the escape hatch: set ACTIVE_GAMES_CAP=0 to serve the entire catalog again
// (the integration suite does exactly this, because it asserts full-catalog
// pagination behaviour).
// ---------------------------------------------------------------------------

/** Coerce any stored/parsed value into a well-formed roster object. */
export function normalizeRoster(raw) {
  const o = raw && typeof raw === 'object' ? raw : {};
  const slugs = Array.isArray(o.slugs)
    ? [...new Set(o.slugs.map((s) => String(s || '').toLowerCase().trim()).filter(Boolean))]
    : [];
  return {
    cap: Number.isFinite(o.cap) ? o.cap : null,
    slugs,
    updatedAt: typeof o.updatedAt === 'string' ? o.updatedAt : null,
  };
}

/** The ordered list of slugs present in the pool, deduped, lowercased. */
export function poolSlugs(pool) {
  const out = [];
  const seen = new Set();
  for (const g of Array.isArray(pool) ? pool : []) {
    const s = String(g?.slug || '').toLowerCase().trim();
    if (s && !seen.has(s)) { seen.add(s); out.push(s); }
  }
  return out;
}

/**
 * Reconcile a roster against the current pool and a target size.
 *
 * Rules, in order:
 *   1. Drop roster slugs that no longer exist in the pool (a delisted game must
 *      not linger as a dead active entry).
 *   2. Keep surviving roster slugs in their existing order, TRUNCATED to the
 *      target. The target is a hard ceiling: a roster carrying more than the
 *      target (e.g. the 129 left behind by the retired grow job) is trimmed back
 *      from the front, which restores the originally-seeded set.
 *   3. If the roster is SHORTER than the target, fill from the pool in pool
 *      order (skipping ones already chosen) until it reaches the target or the
 *      pool is exhausted — so an archived game's slot gets refilled.
 *
 * @returns { slugs } the reconciled ordered slug list (<= min(target, pool size)).
 */
export function reconcileRoster(poolList, rosterSlugs, target) {
  const pool = Array.isArray(poolList) ? poolList : [];
  const poolSet = new Set(pool);
  const want = Math.min(Math.max(0, target | 0), pool.length);
  const kept = [];
  const chosen = new Set();
  for (const s of Array.isArray(rosterSlugs) ? rosterSlugs : []) {
    if (kept.length >= want) break;                     // hard ceiling
    if (poolSet.has(s) && !chosen.has(s)) { kept.push(s); chosen.add(s); }
  }
  for (const s of pool) {
    if (kept.length >= want) break;
    if (!chosen.has(s)) { kept.push(s); chosen.add(s); }
  }
  return { slugs: kept };
}

/**
 * Select the active games out of the pool given a roster and a cap.
 *
 * cap <= 0 → NO CAP: return the whole pool unchanged, and signal that nothing
 * should be persisted (capped:false). Otherwise return the pool filtered to the
 * roster membership, IN POOL ORDER (so the existing spread/category ordering is
 * preserved — a capped catalog is just a smaller version of the same ordering),
 * plus the reconciled roster to persist.
 *
 * @returns { games, roster:{slugs}, capped:boolean }
 */
export function selectActive(pool, roster, cap) {
  const list = Array.isArray(pool) ? pool : [];
  if (!(cap > 0)) return { games: list, roster: { slugs: [] }, capped: false };
  const slugs = poolSlugs(list);
  const reconciled = reconcileRoster(slugs, normalizeRoster(roster).slugs, cap);
  const active = new Set(reconciled.slugs);
  const games = list.filter((g) => active.has(String(g?.slug || '').toLowerCase().trim()));
  return { games, roster: reconciled, capped: true };
}

export default { normalizeRoster, poolSlugs, reconcileRoster, selectActive };
