// ============================================================================
// presence-store.mjs — the live "N playing now" sessions, and their limits.
//
// THE TRAFFIC MODEL, WRITTEN DOWN. A visitor's tab beats every 2s (0.5/s) and
// once more whenever it regains focus. Three independent limits sit on that,
// each answering a different question:
//
//   1. PER SESSION (server.js, limiter 'presenceSession')
//      "Is this one tab misbehaving?" Keyed on the random per-tab session id,
//      so it is precise without being a fingerprint. Sized at 1/s sustained,
//      twice the real cadence, with a burst for focus-beats.
//
//   2. PER ADDRESS (server.js, limiter 'presenceIp')
//      "Is this address flooding?" Coarse on purpose. A school or library NAT
//      puts hundreds of real devices behind ONE address, and this site's
//      audience is exactly that — so the budget is sized for a large NAT
//      (default 200 beats/s ≈ 400 tabs), not for one person.
//
//   3. SESSIONS PER ADDRESS (here, maxSessionsPerKey)
//      "How many players can one address make up?" Limit 2 alone would let a
//      single address hold ~1,600 fabricated sessions alive (200/s × 8s TTL).
//      This caps the number of DISTINCT sessions one address can have counted
//      at once (default 500). A NAT larger than that is under-counted beyond
//      the cap — the beats are still answered, the extra tabs just do not add
//      to the number — which is the honest trade: a slightly low count for a
//      very large school, versus letting any one address inflate every badge.
//
// And one global bound: maxSessions. When the store is full a NEW session is
// refused rather than evicting the oldest one, because oldest-first eviction
// hands a flood the power to delete real visitors' sessions.
//
// CPU. The old handler rebuilt the snapshot (a walk over every session) on
// every single beat, so the cost of a beat grew with the number of visitors:
// 20,000 sessions × thousands of beats/s. The snapshot is now memoised — a
// full walk happens at most every `minRecomputeMs` while things are changing,
// and at least every `maxAgeMs` — and the serialised JSON is memoised with it.
//
// PRIVACY. A session remembers its slug, when it last beat, and the key of the
// address it came from. The address key is whatever the caller passes — the
// server passes a keyed HMAC, never a raw address — and it lives only in
// memory, only for the session's TTL, and never appears in any output.
// ============================================================================

const SESSION_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
// Same shape the leaderboard accepts, so one slug is valid everywhere or nowhere.
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,119}$/;

export function createPresenceStore({
  ttlMs = 8_000,
  maxSessions = 20_000,
  maxSessionsPerKey = 500,
  minRecomputeMs = 250,
  maxAgeMs = 1_000,
  isKnownSlug = null,
  now = Date.now,
} = {}) {
  const sessions = new Map();     // sid -> { slug, lastSeen, owner }
  const perOwner = new Map();     // owner -> live session count
  let memo = { at: -Infinity, snap: null, json: '' };
  let dirty = true;

  const cleanSlug = (slug) => {
    if (typeof slug !== 'string' || !SLUG_RE.test(slug)) return null;
    if (typeof isKnownSlug === 'function' && !isKnownSlug(slug)) return null;
    return slug;
  };

  function release(owner) {
    const n = (perOwner.get(owner) || 0) - 1;
    if (n > 0) perOwner.set(owner, n); else perOwner.delete(owner);
  }

  function drop(sid) {
    const s = sessions.get(sid);
    if (!s) return false;
    sessions.delete(sid);
    release(s.owner);
    dirty = true;
    return true;
  }

  function sweep() {
    const t = now();
    for (const [sid, s] of sessions) {
      if (t - s.lastSeen > ttlMs) drop(sid);
    }
  }

  /**
   * Record a heartbeat. Returns { accepted, changed, reason? }.
   * `accepted:false` is not an error for the caller to surface: the visitor
   * still gets a snapshot, their tab just is not (newly) counted.
   */
  function beat(sid, slug, owner = 'unknown') {
    if (typeof sid !== 'string' || !SESSION_ID_RE.test(sid)) {
      return { accepted: false, changed: false, reason: 'bad-session-id' };
    }
    const t = now();
    const s = sessions.get(sid);
    const safeSlug = cleanSlug(slug);
    if (s && t - s.lastSeen <= ttlMs) {
      const changed = s.slug !== safeSlug;
      s.lastSeen = t;
      s.slug = safeSlug;
      if (changed) dirty = true;
      return { accepted: true, changed };
    }
    if (s) drop(sid);                              // expired: re-admit as new

    if ((perOwner.get(owner) || 0) >= maxSessionsPerKey) {
      return { accepted: false, changed: false, reason: 'per-address-cap' };
    }
    if (sessions.size >= maxSessions) {
      sweep();
      if (sessions.size >= maxSessions) {
        return { accepted: false, changed: false, reason: 'store-full' };
      }
    }
    sessions.set(sid, { slug: safeSlug, lastSeen: t, owner });
    perOwner.set(owner, (perOwner.get(owner) || 0) + 1);
    dirty = true;
    return { accepted: true, changed: true };
  }

  function leave(sid) {
    return typeof sid === 'string' && drop(sid);
  }

  function compute() {
    const t = now();
    // A null-prototype object: slugs are client-supplied keys, and a plain
    // object would read 'constructor' or 'toString' back as a function.
    const games = Object.create(null);
    let total = 0;
    for (const [, s] of sessions) {
      if (t - s.lastSeen > ttlMs) continue;
      total++;
      if (s.slug) games[s.slug] = (games[s.slug] || 0) + 1;
    }
    const snap = { total, games, t };
    memo = { at: t, snap, json: JSON.stringify(snap) };
    dirty = false;
    return memo;
  }

  function current() {
    const t = now();
    const age = t - memo.at;
    if (!memo.snap || age >= maxAgeMs || (dirty && age >= minRecomputeMs)) return compute();
    return memo;
  }

  return {
    beat,
    leave,
    sweep,
    /** The public snapshot object: { total, games, t }. */
    snapshot: () => current().snap,
    /** The same snapshot, already serialised — what the HTTP handler sends. */
    snapshotJson: () => current().json,
    size: () => sessions.size,
    sessionsFor: (owner) => perOwner.get(owner) || 0,
    limits: { ttlMs, maxSessions, maxSessionsPerKey, minRecomputeMs, maxAgeMs },
  };
}
