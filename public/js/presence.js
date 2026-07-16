// ZoFHub · presence.js
//
// Live "people playing now" + total visitors.  Talks to:
//   POST /api/presence/beat   { sessionId, slug }  -- every BEAT_MS; response is a
//                                                      fresh snapshot (this is the
//                                                      live update — no SSE needed)
//   POST /api/presence/leave  (sendBeacon on pagehide)
//
// Uses light POLLING, NOT a long-lived EventSource. A per-tab SSE holds one of the
// browser's ~6 HTTP/1.1 connections open forever, so 7+ tabs saturated the pool and
// starved the beats (the "count takes 8-11s to update / lags" bug). Short beats
// release the connection between polls, so any number of tabs stay fast.
//
// Public API:
//   import { presence } from './presence.js';
//   presence.setSlug('drift-king');     // current game (or null on home/category)
//   presence.subscribe(snap => { ... }); // snap = { total, games:{slug:n}, t }
//   presence.unsubscribe(fn);
//
// On import, presence auto-starts (single instance per tab).  Safe to import
// from multiple modules — only one heartbeat is created.

const SESSION_KEY = 'zofhub:sid';
// Beat cadence. Frequent enough to feel live (the tab you're looking at also beats
// on focus for an instant refresh), but kept well under the server's
// PRESENCE_TTL_MS so a live session never expires between beats.
const BEAT_MS = 2_000;

function makeSessionId() {
  // 16 hex chars from crypto if available, otherwise Math.random fallback.
  if (globalThis.crypto?.getRandomValues) {
    const a = new Uint8Array(8);
    crypto.getRandomValues(a);
    return [...a].map(b => b.toString(16).padStart(2, '0')).join('');
  }
  return Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10);
}

function getSessionId() {
  try {
    let sid = sessionStorage.getItem(SESSION_KEY);
    if (!sid) { sid = makeSessionId(); sessionStorage.setItem(SESSION_KEY, sid); }
    return sid;
  } catch {
    return makeSessionId();
  }
}

class Presence {
  constructor() {
    this.sid = getSessionId();
    this.slug = null;
    this.snapshot = { total: 0, games: {}, t: 0 };
    this.subs = new Set();
    this.beatTimer = null;
    this._wired = false;
  }

  setSlug(slug) {
    this.slug = slug || null;
    // Fire an immediate beat so the count updates promptly.
    this._beat();
  }

  subscribe(fn) {
    if (typeof fn !== 'function') return () => {};
    this.subs.add(fn);
    // Push the current snapshot immediately so new subscribers paint right away.
    try { fn(this.snapshot); } catch (e) { console.warn('[presence] sub error:', e); }
    return () => this.unsubscribe(fn);
  }
  unsubscribe(fn) { this.subs.delete(fn); }

  start() {
    if (this._wired) return;
    this._wired = true;
    // Light POLLING — a periodic beat POST that returns the current snapshot. We
    // deliberately do NOT hold a long-lived SSE/EventSource: a per-tab stream keeps
    // one of the browser's ~6 HTTP/1.1 connections-per-origin open forever, so 7+
    // tabs saturated the pool and STARVED these very beats (that was the "count
    // takes 8-11s to update" bug). Short beats release the connection between polls,
    // so ANY number of tabs stay fast, and the tab you're looking at updates
    // instantly from its OWN beat response (below).
    this._beat();
    this.beatTimer = setInterval(() => this._beat(), BEAT_MS);
    // Refresh instantly whenever the tab regains focus (switching to it, alt-tab…).
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') this._beat();
    });
    // Drop out of the count the moment the tab closes (beacon) so others see it fast.
    window.addEventListener('pagehide', () => this._leave(), { capture: true });
  }

  // Apply a snapshot (from a beat response) and notify subscribers. Ignores
  // anything malformed or older than what we already have, so an out-of-order
  // response (two beats in flight) can never make the count flicker backwards.
  _applySnapshot(snap) {
    if (!snap || typeof snap.total !== 'number') return;
    if (typeof snap.t === 'number' && typeof this.snapshot.t === 'number' && snap.t < this.snapshot.t) return;
    this.snapshot = snap;
    for (const fn of this.subs) { try { fn(snap); } catch (e) { console.warn('[presence] sub error:', e); } }
  }

  async _beat() {
    try {
      const r = await fetch('/api/presence/beat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: this.sid, slug: this.slug }),
        keepalive: true
      });
      if (r.ok) this._applySnapshot(await r.json());   // the response carries the live snapshot
    } catch {}
  }

  _leave() {
    const payload = JSON.stringify({ sessionId: this.sid });
    try {
      if (navigator.sendBeacon) {
        navigator.sendBeacon('/api/presence/leave', new Blob([payload], { type: 'application/json' }));
      } else {
        fetch('/api/presence/leave', { method: 'POST', body: payload, keepalive: true });
      }
    } catch {}
  }
}

export const presence = new Presence();
presence.start();

// Convenience: format big numbers as 1.2k, 12k, 1.2m
export function fmtCount(n) {
  if (n == null) return '';
  if (n < 1000) return String(n);
  if (n < 10_000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
  if (n < 1_000_000) return Math.round(n / 1000) + 'k';
  return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'm';
}

// Smoothly update a text node when a number changes — adds a brief flash
// class so the UI registers as "live."  No-op when the new value matches.
const lastValue = new WeakMap();
export function paintCount(el, value, fmt = fmtCount) {
  if (!el) return;
  const prev = lastValue.get(el);
  if (prev === value) return;
  lastValue.set(el, value);
  el.textContent = fmt(value);
  // Restart the flash animation by toggling the class on the next frame.
  el.classList.remove('count-flash');
  // Forcing reflow so the animation can restart cleanly.
  void el.offsetWidth;
  el.classList.add('count-flash');
}
