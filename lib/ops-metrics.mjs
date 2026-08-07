// Operational metrics for the admin console: a bounded error log and the
// catalog rollups the analytics panel needs.
//
// THE ERROR LOG IS A REDACTION PROBLEM FIRST
// An error message is the single most common place a credential leaks. A failed
// Supabase call puts the request URL in `message`, a failed fetch echoes the
// Authorization header, and a stack frame can carry a token that was a function
// argument. This buffer is read by an authenticated admin, but it is also JSON
// on the wire and in a browser's memory, so everything is scrubbed on the way
// IN — redacting on the way out would leave the secret sitting in server memory
// for anyone with a heap dump or a second bug.
//
// Bounded on purpose. An unbounded error list is a memory leak that only fires
// on the day something is already going wrong.

export const MAX_ERRORS = 200;

// Anything shaped like a credential. Deliberately greedy: a false positive
// costs a few obscured characters in a log line, a false negative writes a live
// key into a dashboard.
const REDACTIONS = [
  [/\b(eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+)/g, '[jwt]'],
  [/\bsb_(secret|publishable)_[A-Za-z0-9_-]{8,}/gi, '[supabase-key]'],
  [/\b(sk|pk|rk)-[A-Za-z0-9_-]{16,}/g, '[api-key]'],
  [/\bgh[pousr]_[A-Za-z0-9]{16,}/g, '[github-token]'],
  // ORDER MATTERS. The HTTP auth schemes must be redacted before the generic
  // key=value rule below, which stops at whitespace: on "Authorization: Bearer
  // <token>" it matched the word "Bearer" as the value and left the token
  // sitting in the log. Specific shapes first, catch-all last.
  [/\b(Bearer|Basic|Token|Digest)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [redacted]'],
  // Credentials in a URL, and query parameters that carry them.
  [/(https?:\/\/)[^/\s:@]+:[^/\s@]+@/gi, '$1[credentials]@'],
  [/([?&](?:key|token|secret|password|apikey|access_token)=)[^&\s]+/gi, '$1[redacted]'],
  // Any remaining key=value / "key": "value" pair whose NAME says it is a secret.
  [/(["']?(?:password|passwd|secret|token|api[_-]?key|auth|authorization|credential)["']?\s*[:=]\s*["']?)([^\s"',;&]{4,})/gi, '$1[redacted]'],
];

/** Scrub anything credential-shaped out of a string. Never throws. */
export function redact(value) {
  let s = typeof value === 'string' ? value : String(value ?? '');
  for (const [re, to] of REDACTIONS) s = s.replace(re, to);
  return s;
}

// Errors that differ only by a row id or timestamp are the same error. Grouping
// on a normalised signature stops one failing request repeated 5,000 times from
// evicting every other error in the buffer.
export function signature(message) {
  return redact(message)
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<uuid>')
    .replace(/\b\d{4}-\d{2}-\d{2}T[\d:.]+Z?\b/g, '<time>')
    .replace(/\d+/g, '<n>')
    .slice(0, 200);
}

export function createErrorLog({ max = MAX_ERRORS, now = () => Date.now() } = {}) {
  const entries = new Map();          // signature -> entry
  let dropped = 0;

  return {
    record(err, context = {}) {
      const raw = err instanceof Error ? (err.message || String(err)) : String(err ?? 'unknown error');
      const message = redact(raw).slice(0, 400);
      const sig = signature(raw);
      const at = now();
      const existing = entries.get(sig);
      if (existing) {
        existing.count++;
        existing.lastAt = at;
        existing.message = message;         // keep the most recent wording
        // Re-insert so Map iteration order stays least-recent-first, which is
        // what makes eviction below evict the right thing.
        entries.delete(sig);
        entries.set(sig, existing);
        return existing;
      }
      const entry = {
        signature: sig, message, count: 1, firstAt: at, lastAt: at,
        where: redact(context.where || '').slice(0, 120) || null,
        status: Number.isFinite(Number(context.status)) ? Number(context.status) : null,
      };
      entries.set(sig, entry);
      while (entries.size > max) {
        const oldest = entries.keys().next().value;
        entries.delete(oldest);
        dropped++;
      }
      return entry;
    },
    list({ limit = 50 } = {}) {
      return [...entries.values()]
        .sort((a, b) => b.lastAt - a.lastAt)
        .slice(0, Math.max(1, Math.min(limit, max)))
        .map((e) => ({ ...e }));
    },
    stats() {
      let total = 0;
      for (const e of entries.values()) total += e.count;
      return { distinct: entries.size, total, dropped, capacity: max };
    },
    clear() { entries.clear(); dropped = 0; },
  };
}

/** Hostname of a URL, or null. Never throws on a relative or malformed value. */
function hostOf(url) {
  try { return new URL(String(url)).hostname; } catch { return null; }
}

/**
 * Roll a catalog + play counts into the analytics panel's numbers.
 *
 * `plays` is the live in-memory Map the server already maintains, so this adds
 * no queries — the alternative was a table scan every time the tab was opened.
 */
export function summarizeCatalog(games, plays = new Map(), { top = 15 } = {}) {
  const list = Array.isArray(games) ? games.filter((g) => g && typeof g === 'object') : [];
  const byCategory = new Map();
  const byProvider = new Map();
  let totalPlays = 0, played = 0;

  const ranked = [];
  for (const g of list) {
    const cat = String(g.category || 'uncategorised').toLowerCase();
    byCategory.set(cat, (byCategory.get(cat) || 0) + 1);
    // Fall back to the embed host when `provider` is absent. This function used
    // to read g.provider alone and report every game as "unknown" in production,
    // because nothing on a catalog object ever set that field — while these
    // tests passed, since their fixtures set it by hand. server.js now populates
    // it at the catalog choke point; deriving here too keeps this function
    // correct for any caller that passes raw rows.
    const prov = String(g.provider || hostOf(g.embed_url || g.game_url || g.url) || 'unknown').toLowerCase();
    byProvider.set(prov, (byProvider.get(prov) || 0) + 1);
    const n = Number(g.plays ?? plays.get(g.slug) ?? 0) || 0;
    totalPlays += n;
    if (n > 0) { played++; ranked.push({ slug: g.slug, title: g.title, plays: n, category: cat }); }
  }
  ranked.sort((a, b) => b.plays - a.plays || String(a.slug).localeCompare(String(b.slug)));

  const rank = (m) => [...m.entries()].sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count }));
  return {
    games: list.length,
    totalPlays,
    playedGames: played,
    // The share of the catalog anyone has ever opened. On a 12,000-game
    // catalogue this is the number that says whether discovery is working.
    coverage: list.length ? Math.round((played / list.length) * 1000) / 10 : 0,
    topGames: ranked.slice(0, top),
    categories: rank(byCategory),
    providers: rank(byProvider).slice(0, 10),
  };
}
