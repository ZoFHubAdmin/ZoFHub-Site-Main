// ZoFHub · presence.js
//
// Live "people playing now" + total visitors.  Talks to:
//   POST /api/presence/beat   { sessionId, slug }  -- every 10s
//   POST /api/presence/leave  (sendBeacon on pagehide)
//   GET  /api/presence/stream (EventSource — snapshots every ~2.5s)
//
// Public API:
//   import { presence } from './presence.js';
//   presence.setSlug('drift-king');     // current game (or null on home/category)
//   presence.subscribe(snap => { ... }); // snap = { total, games:{slug:n}, t }
//   presence.unsubscribe(fn);
//
// On import, presence auto-starts (single instance per tab).  Safe to import
// from multiple modules — only one EventSource and one heartbeat are created.

const SESSION_KEY = 'zofhub:sid';
const BEAT_MS = 4_000;

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
    this.es = null;
    this.beatTimer = null;
    this.reconnectAttempt = 0;
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
    this._beat();
    this.beatTimer = setInterval(() => this._beat(), BEAT_MS);
    this._connectSSE();
    // Leave promptly on page hide.
    window.addEventListener('pagehide', () => this._leave(), { capture: true });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') this._beat();
    });
  }

  _connectSSE() {
    try { this.es?.close(); } catch {}
    const es = new EventSource('/api/presence/stream');
    this.es = es;
    es.onopen = () => { this.reconnectAttempt = 0; };
    es.onmessage = (ev) => {
      try {
        const snap = JSON.parse(ev.data);
        this.snapshot = snap;
        for (const fn of this.subs) { try { fn(snap); } catch (e) { console.warn('[presence] sub error:', e); } }
      } catch {}
    };
    es.onerror = () => {
      // Browser auto-reconnects, but if the connection truly broke we add a backoff.
      this.reconnectAttempt++;
      if (this.reconnectAttempt > 5) {
        try { es.close(); } catch {}
        setTimeout(() => this._connectSSE(), Math.min(30_000, 1000 * 2 ** this.reconnectAttempt));
      }
    };
  }

  async _beat() {
    try {
      const r = await fetch('/api/presence/beat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: this.sid, slug: this.slug }),
        keepalive: true
      });
      if (r.ok) {
        // Use the immediate response in case the SSE hasn't tick'd yet.
        const snap = await r.json();
        if (snap && typeof snap.total === 'number') {
          this.snapshot = snap;
          for (const fn of this.subs) { try { fn(snap); } catch {} }
        }
      }
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
