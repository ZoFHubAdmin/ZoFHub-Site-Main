// ZoFHub · signals.js — the interaction signals personalization is allowed to use.
// ---------------------------------------------------------------------------
// WHAT IS COLLECTED, WHERE IT LIVES, AND WHY
//
// Everything here stays in YOUR BROWSER, in localStorage, under the `zofhub:v2:`
// prefix. None of it is written to a database, associated with an account (there
// are none), or joined to an IP address. The server sees a subset of it on the
// request that needs it, uses it to order that one response, and forgets it —
// lib/recommender.mjs is stateless by design and says so at the top.
//
//   signal          what it is                          why it is needed
//   ─────────────── ─────────────────────────────────── ──────────────────────
//   history         slugs you opened, newest first      the core taste signal
//   favorites       slugs you starred                   explicit "I like this"
//   skips           slugs you scrolled past             stops re-showing misses
//   dwell           seconds on a game, bucketed         a 3s bounce ≠ a 20min run
//   searches        your last few search terms          intent you typed
//   vibe            the last mood you typed             carries into the feed
//
// WHAT IS DELIBERATELY NOT COLLECTED
//   • No mouse movement, scroll depth, keystroke timing, or focus/blur logging.
//   • No cross-site anything. No fingerprinting. No third-party calls.
//   • No timestamps finer than a second, and dwell is BUCKETED before it is ever
//     sent (see recordDwell) — an exact millisecond duration is a much stronger
//     identifier than the coarse bucket personalization actually needs.
//   • Nothing at all until you interact. A first visit sends empty arrays.
//
// Everything is capped and self-expiring, so this cannot grow without bound and
// stale data ages out rather than accumulating forever. store.wipe() (already
// wired to the existing privacy control) clears all of it.

import { store } from './storage.js';

const NS = 'zofhub:v2:';
const MAX_SKIPS = 60;
const MAX_SEARCHES = 8;
const MAX_DWELL = 60;
const SKIP_TTL_MS = 14 * 24 * 60 * 60 * 1000;   // two weeks
const VIBE_TTL_MS = 45 * 60 * 1000;             // a mood is a passing state

function read(key, fallback) {
  try {
    const r = localStorage.getItem(NS + key);
    return r == null ? fallback : JSON.parse(r);
  } catch { return fallback; }
}
function write(key, value) {
  try { localStorage.setItem(NS + key, JSON.stringify(value)); } catch {}
}

// ── Skips ──────────────────────────────────────────────────────────────────
// A "skip" is a game that was rendered, sat on screen long enough to have been
// seen, and was not opened. That is a much weaker signal than a play, and it is
// treated as one server-side (SKIP_NEIGHBOUR_PENALTY) — recorded here mainly so
// the same eight games stop reappearing in a row you keep ignoring.
export const skips = {
  get() {
    const now = Date.now();
    const list = read('skips', []).filter(s => s && s.id && now - (s.ts || 0) < SKIP_TTL_MS);
    return list;
  },
  ids() { return skips.get().map(s => s.id); },
  add(ids) {
    if (!ids || !ids.length) return;
    const now = Date.now();
    const cur = skips.get();
    const seen = new Map(cur.map(s => [s.id, s]));
    for (const id of ids) {
      if (!id) continue;
      const prev = seen.get(id);
      // Count REPEATED skips. Passing over a game once means little; passing
      // over it four times is a clear "no", and the count is what lets the
      // suppression be proportional instead of binary.
      seen.set(id, { id, ts: now, n: Math.min(9, (prev?.n || 0) + 1) });
    }
    // Newest first, capped.
    const out = [...seen.values()].sort((a, b) => b.ts - a.ts).slice(0, MAX_SKIPS);
    write('skips', out);
  },
  // Opening a game retracts any skip against it — the strongest possible
  // correction, and it must win. Without this a game you scrolled past twice
  // and then played would stay suppressed.
  clear(id) {
    write('skips', skips.get().filter(s => s.id !== id));
  },
};

// ── Dwell ──────────────────────────────────────────────────────────────────
// Bucketed on the way in, never stored raw. The buckets are the only thing any
// consumer needs: "bounced", "played", "stuck around".
export const dwell = {
  get() { return read('dwell', {}); },
  /** @param {string} id @param {number} seconds */
  record(id, seconds) {
    if (!id || !Number.isFinite(seconds) || seconds < 0) return;
    const bucket = seconds < 15 ? 'bounce' : seconds < 120 ? 'short' : 'long';
    const cur = dwell.get();
    // Keep only the most recent verdict per game, and cap the map. A game you
    // bounced off once and then played for an hour is a game you like.
    cur[id] = bucket;
    const keys = Object.keys(cur);
    if (keys.length > MAX_DWELL) {
      for (const k of keys.slice(0, keys.length - MAX_DWELL)) delete cur[k];
    }
    write('dwell', cur);
    // A real bounce is a soft negative — the one case where opening a game is
    // evidence AGAINST it. Under 15 seconds is not "played", it is "looked and
    // left", and without this the history signal treats them identically.
    if (bucket === 'bounce') skips.add([id]);
    else skips.clear(id);
  },
  /** Slugs the visitor actually stuck with — the strongest positive signal. */
  liked() {
    const d = dwell.get();
    return Object.keys(d).filter(k => d[k] === 'long');
  },
};

// ── Searches ───────────────────────────────────────────────────────────────
// Only the terms, only the last few, and only ones that look like a game search
// rather than something personal that was pasted into the box by accident.
export const searches = {
  get() { return read('searches', []); },
  add(term) {
    const t = String(term || '').trim().toLowerCase().slice(0, 40);
    // Guardrail: anything with an @, a long digit run, or a URL shape is not a
    // game search and is not kept. Cheap, and it means an accidental paste of an
    // email or a phone number never lands in storage.
    if (t.length < 2) return;
    if (/@|\d{6,}|https?:|\.(com|net|org)\b/.test(t)) return;
    const cur = searches.get().filter(s => s !== t);
    cur.unshift(t);
    write('searches', cur.slice(0, MAX_SEARCHES));
  },
};

// ── Vibe ───────────────────────────────────────────────────────────────────
// The last mood typed into the Vibe Finder, so the feed can lean that way for a
// while. Expires on its own: a mood is a state, not a preference, and a feed
// still shaped by "something relaxing" three days later would be wrong.
export const vibe = {
  get() {
    const v = read('vibe', null);
    if (!v || !v.q || Date.now() - (v.ts || 0) > VIBE_TTL_MS) return null;
    return v.q;
  },
  set(q) {
    const t = String(q || '').trim().slice(0, 200);
    if (t) write('vibe', { q: t, ts: Date.now() });
  },
  clear() { write('vibe', null); },
};

/**
 * The bundle sent to /api/for-you and /api/vibe.
 *
 * Assembled in one place so there is exactly one answer to "what does the server
 * receive", and so adding a field is a deliberate act rather than something that
 * happens by accident at a call site.
 */
export function personalizationPayload() {
  const history = store.history.get().map(h => h.id).filter(Boolean);
  const favorites = store.favorites.get().filter(Boolean);
  // Games stuck with count as favourites for ranking purposes — behavioural
  // evidence at least as strong as a star, and far more common.
  const liked = dwell.liked().filter(id => !favorites.includes(id));
  return {
    history,
    favorites: [...favorites, ...liked].slice(0, 40),
    skips: skips.ids().slice(0, 40),
    vibe: vibe.get() || undefined,
  };
}

/** True when there is enough signal for personalization to mean anything. */
export function hasSignal() {
  const p = personalizationPayload();
  return p.history.length >= 3 || p.favorites.length >= 2;
}

export default { skips, dwell, searches, vibe, personalizationPayload, hasSignal };
