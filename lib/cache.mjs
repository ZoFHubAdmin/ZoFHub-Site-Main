// lib/cache.mjs
//
// Unified cache façade.  Same API regardless of backend:
//
//   await cache.get(key)                      → value | null
//   await cache.set(key, value, ttlSeconds)   → 'OK'  | null on failure
//   await cache.delPattern(globPattern)       → number of keys deleted
//   await cache.flush()                       → ok? (USE WITH CARE)
//   cache.backend                             → 'redis' | 'memory'
//
// Why two backends:
//   - Production: REDIS_URL points at Upstash / Redis Cloud / Render
//     Redis / self-hosted; we use `ioredis` over a TLS TCP connection.
//   - Dev / first-deploy / Redis-outage: zero env → bounded in-process
//     LRU.  Survives single-process traffic spikes; doesn't survive
//     restarts (which is fine for cache).
//
// All methods are async and never throw.  On any backend error they
// silently return null/0 and let the caller fall through to the
// database — matches the API spec ("never crash, never 500").

import Redis from 'ioredis';

// ---------------------------------------------------------------------
// In-memory LRU: O(1) get/set with insertion-order Map, capped at
// MEMORY_MAX entries to bound RSS even under cache-miss storms.
// ---------------------------------------------------------------------
const MEMORY_MAX = 5000;

class MemoryCache {
  constructor() {
    this.store = new Map(); // key -> { value, expiresAt }
  }
  _purgeExpired(now) {
    if (this.store.size < MEMORY_MAX / 2) return;
    for (const [k, v] of this.store) {
      if (v.expiresAt && v.expiresAt < now) this.store.delete(k);
    }
  }
  async get(key) {
    const now = Date.now();
    const hit = this.store.get(key);
    if (!hit) return null;
    if (hit.expiresAt && hit.expiresAt < now) { this.store.delete(key); return null; }
    // Bump to most-recently-used position
    this.store.delete(key);
    this.store.set(key, hit);
    return hit.value;
  }
  async set(key, value, ttlSeconds) {
    const now = Date.now();
    this._purgeExpired(now);
    if (this.store.size >= MEMORY_MAX) {
      // Evict oldest (the Map preserves insertion order)
      const oldest = this.store.keys().next().value;
      if (oldest !== undefined) this.store.delete(oldest);
    }
    this.store.set(key, {
      value,
      expiresAt: ttlSeconds ? now + ttlSeconds * 1000 : 0
    });
    return 'OK';
  }
  async delPattern(pattern) {
    // Glob → RegExp.  Only `*` is supported (matches anything except line break).
    const rx = new RegExp('^' + pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
    let count = 0;
    for (const k of this.store.keys()) {
      if (rx.test(k)) { this.store.delete(k); count++; }
    }
    return count;
  }
  async flush() { this.store.clear(); return true; }
}

// ---------------------------------------------------------------------
// ioredis backend
// ---------------------------------------------------------------------
class RedisCache {
  constructor(url) {
    this.client = new Redis(url, {
      // Don't queue commands during outage — fail fast and let the caller
      // fall through to the DB.  Keeps cache-miss storms from snowballing.
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      // Short connect + command timeouts so a dead Redis can't slow API.
      connectTimeout: 3000,
      commandTimeout: 1500,
      lazyConnect: false,
      // ioredis 5 surfaces 'error' even when retrying; swallow to keep logs sane.
      retryStrategy: (times) => Math.min(2000 * times, 10_000)
    });
    this.client.on('error', (e) => {
      // Don't spam the log: only first error per minute.
      const now = Date.now();
      if (!this._lastErr || now - this._lastErr > 60_000) {
        console.warn('[cache] redis error:', e.message);
        this._lastErr = now;
      }
    });
    this.client.on('ready', () => console.log('[cache] redis connected.'));
  }
  async get(key) {
    try {
      const raw = await this.client.get(key);
      if (raw == null) return null;
      try { return JSON.parse(raw); } catch { return raw; }
    } catch { return null; }
  }
  async set(key, value, ttlSeconds) {
    try {
      const raw = typeof value === 'string' ? value : JSON.stringify(value);
      if (ttlSeconds && ttlSeconds > 0) await this.client.set(key, raw, 'EX', ttlSeconds);
      else                              await this.client.set(key, raw);
      return 'OK';
    } catch { return null; }
  }
  // Pattern-based delete using non-blocking SCAN — never use KEYS in prod,
  // it blocks the whole Redis instance.
  async delPattern(pattern) {
    let count = 0;
    try {
      const stream = this.client.scanStream({ match: pattern, count: 200 });
      for await (const keys of stream) {
        if (!keys.length) continue;
        // UNLINK is non-blocking lazy delete; falls back to DEL on older Redis.
        try { await this.client.unlink(...keys); }
        catch { await this.client.del(...keys); }
        count += keys.length;
      }
    } catch (e) {
      console.warn('[cache] delPattern failed:', e.message);
    }
    return count;
  }
  async flush() {
    try { await this.client.flushdb(); return true; } catch { return false; }
  }
}

// ---------------------------------------------------------------------
// Factory + singleton
// ---------------------------------------------------------------------
let _cache = null;

function buildCache() {
  const url = process.env.REDIS_URL || process.env.UPSTASH_REDIS_URL;
  if (!url) {
    console.log('[cache] REDIS_URL not set — using in-memory cache.');
    const c = new MemoryCache();
    c.backend = 'memory';
    return c;
  }
  try {
    const c = new RedisCache(url);
    c.backend = 'redis';
    return c;
  } catch (e) {
    console.warn('[cache] redis init failed, falling back to memory:', e.message);
    const c = new MemoryCache();
    c.backend = 'memory';
    return c;
  }
}

export function getCache() {
  if (!_cache) _cache = buildCache();
  return _cache;
}

// Convenience re-exports so callers can `import { get, set } from './cache.mjs'`.
export const get        = (k)         => getCache().get(k);
export const set        = (k, v, ttl) => getCache().set(k, v, ttl);
export const delPattern = (p)         => getCache().delPattern(p);
export const flush      = ()          => getCache().flush();
