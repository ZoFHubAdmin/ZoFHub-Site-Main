// lib/active-roster.mjs — the "show only N games now, grow over time" roster.
// ---------------------------------------------------------------------------
// WHAT THIS IS. The catalog master pool is large (thousands of games). This
// module decides WHICH of them are ACTIVE — the subset the public site actually
// lists and serves. It starts at a configured size (ACTIVE_GAMES_CAP, default
// 100) and GROWS by a fixed batch (the existing +30-every-36h grow job) by
// promoting games out of the pool into the roster.
//
// WHY A ROSTER FILE and not just "first N of the pool": the active set must be
// STABLE. If it were recomputed as "first 100" on every catalog refresh, the
// pool reordering (new imports, spreadCatalog) would silently swap games in and
// out, breaking bookmarks, sitemaps and the whole point of a curated set. So the
// chosen slugs are PERSISTED (data/active-roster.json) and only ever added to.
//
// PURE CORE. The functions here take plain data and return plain data — no file
// I/O, no clock, no catalog object — so they are unit-testable. server.js owns
// reading/writing the file and calling these at catalog-build time; the grow
// cron calls growRoster() on its schedule.
//
// DISABLED BY DEFAULT-OFF SEMANTICS. A cap of 0 (or negative) means "no cap" —
// selectActive returns the whole pool unchanged, and nothing is persisted. That
// is the escape hatch: set ACTIVE_GAMES_CAP=0 to serve the entire catalog again.
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
    lastGrowAt: typeof o.lastGrowAt === 'string' ? o.lastGrowAt : null,
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
 *   2. Keep every surviving roster slug, in its existing order (stability — the
 *      set only ever grows, never reshuffles).
 *   3. If the roster is SHORTER than the target, fill from the pool in pool
 *      order (skipping ones already chosen) until it reaches the target or the
 *      pool is exhausted. If it is already at or above the target (because the
 *      grow job has been promoting), keep all of them — the target is a FLOOR,
 *      not a ceiling.
 *
 * @returns { slugs } the reconciled ordered slug list (<= pool size).
 */
export function reconcileRoster(poolList, rosterSlugs, target) {
  const pool = Array.isArray(poolList) ? poolList : [];
  const poolSet = new Set(pool);
  const kept = [];
  const chosen = new Set();
  for (const s of Array.isArray(rosterSlugs) ? rosterSlugs : []) {
    if (poolSet.has(s) && !chosen.has(s)) { kept.push(s); chosen.add(s); }
  }
  const want = Math.min(Math.max(0, target | 0), pool.length);
  for (const s of pool) {
    if (kept.length >= want) break;
    if (!chosen.has(s)) { kept.push(s); chosen.add(s); }
  }
  return { slugs: kept };
}

/**
 * Promote up to `addN` new games from the pool into the roster (the grow job).
 * Idempotent per pool: once every pool slug is in the roster, this adds nothing.
 *
 * @returns { slugs, added } — the new roster list and how many were promoted.
 */
export function growRoster(poolList, rosterSlugs, addN) {
  const pool = Array.isArray(poolList) ? poolList : [];
  const next = [];
  const have = new Set();
  for (const s of Array.isArray(rosterSlugs) ? rosterSlugs : []) {
    if (!have.has(s)) { next.push(s); have.add(s); }
  }
  let added = 0;
  const n = Math.max(0, addN | 0);
  for (const s of pool) {
    if (added >= n) break;
    if (!have.has(s)) { next.push(s); have.add(s); added += 1; }
  }
  return { slugs: next, added };
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

export default { normalizeRoster, poolSlugs, reconcileRoster, growRoster, selectActive };
