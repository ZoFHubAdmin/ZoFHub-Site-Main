// ============================================================================
// rate-limit.mjs — scoped token buckets, and the client key they are keyed on.
//
// WHAT WAS WRONG BEFORE THIS FILE. server.js kept ONE Map of buckets keyed by
// IP alone, and every write endpoint drew from it with its own capacity and
// refill rate. So the limits were not independent at all:
//
//   · a presence beat (burst 30, a token every 200ms) topped the SHARED bucket
//     back up every two seconds, so from any IP that had the site open the
//     feedback, subscribe, score and donation limits were really "5 per second";
//   · and in the other direction, a burst of those rare writes spent tokens the
//     presence beats needed, so the live counter flickered for everyone behind
//     the same address.
//
// Each limiter here owns its own Map, so a scope can only ever spend its own
// budget.
//
// THE ARITHMETIC IS CONTINUOUS. The old refill added floor(elapsed / refillMs)
// tokens and then reset `last` to now, throwing away the fractional remainder
// on every call — a client calling every 1.5 intervals was refilled at two-
// thirds of the documented rate. Here tokens are a real number and `last`
// always advances to now, so the sustained rate is exactly 1000 / refillMs per
// second and the burst is exactly `capacity`.
//
// UNITS, stated once because getting them wrong is silent:
//   capacity — the BURST: requests allowed back-to-back from a cold bucket.
//   refillMs — MILLISECONDS PER SINGLE TOKEN, not a window length.
//              (capacity 10, refillMs 5000) = a burst of 10, then 0.2/sec.
//
// THE KEY. A rate limit keyed on a raw address has two failure modes:
//   · IPv4-mapped IPv6 (::ffff:203.0.113.9) and plain 203.0.113.9 are the same
//     client and must share a bucket;
//   · one IPv6 subscriber is routinely handed a whole /64 — 2^64 addresses — so
//     a per-/128 limit is one the client can rotate past at will. IPv6 is
//     therefore keyed on its /64 prefix.
// A shared NAT still collapses many people into one key. That is not solvable
// by keying on the address harder; it is why presence has a per-session tier
// on top of the per-address one (see lib/presence-store.mjs).
// ============================================================================

/**
 * Expand an IPv6 literal to eight 16-bit groups. Returns null when it is not
 * parseable, so the caller falls back to the literal string rather than
 * inventing a prefix for something it did not understand.
 */
function ipv6Groups(ip) {
  let s = String(ip).toLowerCase();
  const zone = s.indexOf('%');
  if (zone !== -1) s = s.slice(0, zone);
  // A trailing dotted quad (::ffff:1.2.3.4, 64:ff9b::1.2.3.4) is two groups.
  const dotted = s.match(/^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (dotted) {
    const oct = dotted[2].split('.').map(Number);
    if (oct.some((n) => n > 255)) return null;
    s = dotted[1] + ((oct[0] << 8) | oct[1]).toString(16) + ':' + ((oct[2] << 8) | oct[3]).toString(16);
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return null;
  const groups = [...head, ...Array(fill).fill('0'), ...tail];
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  return groups.map((g) => parseInt(g, 16));
}

/**
 * The key a client is rate-limited under.
 *   203.0.113.9            → 203.0.113.9
 *   ::ffff:203.0.113.9     → 203.0.113.9
 *   2001:db8:1:2:aa:bb:cc:dd → 2001:db8:1:2::/64
 *   '' / undefined         → 'unknown'
 */
export function clientKey(ip) {
  const s = String(ip ?? '').trim();
  if (!s) return 'unknown';
  if (!s.includes(':')) return s;                       // IPv4 (or an opaque token)
  const g = ipv6Groups(s);
  if (!g) return s;
  // IPv4-mapped: ::ffff:a.b.c.d is the IPv4 client itself.
  if (g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0xffff) {
    return `${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`;
  }
  return `${g.slice(0, 4).map((n) => n.toString(16)).join(':')}::/64`;
}

/**
 * One independent token-bucket limiter.
 *
 * @param {object} o
 * @param {number} o.capacity   burst size (tokens)
 * @param {number} o.refillMs   milliseconds per token
 * @param {number} [o.maxKeys]  memory bound; past it the oldest half is dropped
 * @param {() => number} [o.now] clock, injectable for tests
 */
export function createLimiter({ capacity, refillMs, maxKeys = 50_000, now = Date.now } = {}) {
  if (!(capacity > 0) || !(refillMs > 0)) {
    throw new TypeError('createLimiter needs a positive capacity and refillMs');
  }
  const buckets = new Map();            // key -> { tokens, last }

  function refill(b, t) {
    if (t > b.last) {
      b.tokens = Math.min(capacity, b.tokens + (t - b.last) / refillMs);
      b.last = t;
    }
  }

  function bucket(key, t) {
    let b = buckets.get(key);
    if (!b) {
      if (buckets.size >= maxKeys) {
        // Map iteration is insertion order: the first keys are the oldest.
        // Dropping a bucket only ever hands that key a FULL bucket, which
        // favours the evicted client — it cannot be used to starve anyone.
        let drop = Math.ceil(maxKeys / 2);
        for (const k of buckets.keys()) { buckets.delete(k); if (--drop <= 0) break; }
      }
      b = { tokens: capacity, last: t };
      buckets.set(key, b);
    }
    return b;
  }

  return {
    capacity,
    refillMs,
    /** Spend `cost` tokens for `key`. True when allowed. */
    allow(key, cost = 1) {
      const t = now();
      const b = bucket(String(key), t);
      refill(b, t);
      if (b.tokens < cost) return false;
      b.tokens -= cost;
      return true;
    },
    /** Milliseconds until `key` could spend one token (0 when it can now). */
    retryAfterMs(key) {
      const b = buckets.get(String(key));
      if (!b) return 0;
      const t = now();
      refill(b, t);
      return b.tokens >= 1 ? 0 : Math.ceil((1 - b.tokens) * refillMs);
    },
    /** Sustained requests per second this limiter permits for one key. */
    get perSecond() { return 1000 / refillMs; },
    size: () => buckets.size,
    reset: () => buckets.clear(),
  };
}

/**
 * A named set of independent limiters, so call sites read as
 * `limits.allow('feedback', req.ip)` and no two scopes can share a bucket.
 *
 * The key passed in is run through clientKey(); pass `{ rawKey: true }` for a
 * key that is not an address (a session id, the literal 'global').
 */
export function createLimiterSet(defs, { now = Date.now, maxKeys } = {}) {
  const limiters = new Map();
  for (const [name, d] of Object.entries(defs)) {
    limiters.set(name, createLimiter({ ...d, now, ...(maxKeys ? { maxKeys } : {}) }));
  }
  const get = (scope) => {
    const l = limiters.get(scope);
    if (!l) throw new Error(`unknown rate-limit scope "${scope}"`);
    return l;
  };
  return {
    allow(scope, key, { rawKey = false, cost = 1 } = {}) {
      return get(scope).allow(rawKey ? String(key ?? 'unknown') : clientKey(key), cost);
    },
    retryAfterSec(scope, key, { rawKey = false } = {}) {
      const ms = get(scope).retryAfterMs(rawKey ? String(key ?? 'unknown') : clientKey(key));
      return Math.max(1, Math.ceil(ms / 1000));
    },
    limiter: get,
    scopes: () => [...limiters.keys()],
    /** For the admin console / tests: each scope's configured model. */
    describe() {
      const out = {};
      for (const [name, l] of limiters) {
        out[name] = { burst: l.capacity, msPerToken: l.refillMs, perSecond: +l.perSecond.toFixed(3), keys: l.size() };
      }
      return out;
    },
    reset() { for (const l of limiters.values()) l.reset(); },
  };
}

/** Read a positive number from the environment, or the default. */
export function envNumber(name, fallback, env = process.env) {
  const n = Number(env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
