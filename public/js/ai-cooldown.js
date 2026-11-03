// ZoFHub · ai-cooldown.js — how long the AI makes a visitor wait between requests.
// ---------------------------------------------------------------------------
// Two independent windows, because the two limits they respect are independent:
//
//   text   10 s   starts when a text answer has FINISHED (or failed, or was
//                 cancelled) — "after every message, a 10 second cooldown".
//   image  45 s   starts when an image request is SENT — the free image service
//                 allows one picture per 45 s per IP, counted from the request.
//
// A text message does not wait on an image and an image does not wait on a text
// message: they go to different endpoints with different limits.
//
// The wait lives in localStorage, not in a variable, for two reasons. Reloading
// the page must not hand back a free request (the provider counts per IP, not
// per tab), and the /ai page and the floating assistant are both text clients
// that share that one IP — so they share one clock.
//
// Nothing here touches the network. It is a local courtesy to the visitor's own
// per-IP allowance on a free tier, not a security control: a visitor can clear
// storage and skip it, and the only thing they gain is the provider's own 429/402.
// ---------------------------------------------------------------------------

export const TEXT_COOLDOWN_MS = 10_000;
export const IMAGE_COOLDOWN_MS = 45_000;

// No stored wait may ever exceed this. A system clock set far into the future, or a
// hand-edited value, must cost a visitor at most two minutes, never a lockout.
export const MAX_COOLDOWN_MS = 120_000;

export const COOLDOWN_STORAGE_KEY = 'zofhub:ai:cooldown:v1';
export const COOLDOWN_KINDS = Object.freeze(['text', 'image']);

function defaultStorage() {
  // Merely reading `localStorage` can throw (sandboxed frame, blocked site data).
  try { return globalThis.localStorage ?? null; } catch { return null; }
}

/**
 * @param {object} [deps]
 * @param {Storage|null} [deps.storage]   anything with getItem/setItem
 * @param {() => number} [deps.now]       the clock, in epoch milliseconds
 * @param {string} [deps.key]             the storage key
 */
export function createCooldowns({ storage = defaultStorage(), now = () => Date.now(), key = COOLDOWN_STORAGE_KEY } = {}) {
  // Mirror of what this tab has written. It is the whole truth when storage is
  // unavailable, and it is merged (max) with storage when it is not, so a write
  // that failed can never silently lose a wait.
  const memory = { text: 0, image: 0 };

  function load() {
    const out = { text: memory.text, image: memory.image };
    let stored = null;
    try {
      const raw = storage && storage.getItem(key);
      if (raw) stored = JSON.parse(raw);
    } catch { stored = null; }
    if (stored && typeof stored === 'object') {
      for (const k of COOLDOWN_KINDS) {
        const v = Number(stored[k]);
        if (Number.isFinite(v) && v > out[k]) out[k] = v;
      }
    }
    return out;
  }

  function save(next) {
    for (const k of COOLDOWN_KINDS) memory[k] = next[k];
    try { storage && storage.setItem(key, JSON.stringify({ text: next.text, image: next.image })); } catch { /* memory still holds it */ }
  }

  function check(kind) {
    if (!COOLDOWN_KINDS.includes(kind)) throw new RangeError(`unknown cooldown kind: ${kind}`);
  }

  /** Milliseconds left on `kind`'s wait; 0 when it may be used now. */
  function remainingMs(kind) {
    check(kind);
    const left = load()[kind] - now();
    if (!(left > 0)) return 0;
    return Math.min(left, MAX_COOLDOWN_MS);
  }

  /** Whole seconds left, rounded UP so the countdown never shows 0 while still blocked. */
  function remainingSec(kind) {
    return Math.ceil(remainingMs(kind) / 1000);
  }

  /**
   * Begin (or extend) a wait of `ms`. It only ever lengthens: a 10 s window
   * cannot cut short a 45 s one, and a provider's "retry after 41s" is honoured
   * on top of the fixed window rather than replaced by it.
   */
  function start(kind, ms) {
    check(kind);
    const wait = Math.min(Math.max(Number(ms) || 0, 0), MAX_COOLDOWN_MS);
    const cur = load();
    const until = now() + wait;
    if (until > cur[kind]) cur[kind] = until;
    save(cur);
    return remainingSec(kind);
  }

  /** End `kind`'s wait immediately. */
  function clear(kind) {
    check(kind);
    const cur = load();
    cur[kind] = 0;
    save(cur);
  }

  return { remainingMs, remainingSec, start, clear };
}

/** "7s", or "1m 5s" once it passes a minute. */
export function formatWait(seconds) {
  const s = Math.max(0, Math.ceil(Number(seconds) || 0));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return r ? `${m}m ${r}s` : `${m}m`;
}

// The one shared instance for the page. Both AI surfaces import it with the SAME
// specifier (including the ?v= query) so they get one module instance, one clock.
export const cooldowns = createCooldowns();
