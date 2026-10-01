// lib/link-checker.mjs
//
// Shared link-check logic used by:
//   - tools/link-checker.mjs        (standalone CLI, batch of 50)
//   - lib/cron-jobs.mjs             (hourly in-process, batch of 200)
//
// Strategy:
//   * Grab oldest-checked working games from Supabase.
//   * HEAD-request each with a 3-second AbortSignal timeout.
//   * 2xx/3xx → success: update last_checked = now().
//   * 4xx/5xx/timeout/network error → mark is_working = false, last_checked = now().
//   * One try/catch per game so a single weird URL can't kill the loop.
//   * Returns a counter object so the caller can log it.
//
// Concurrency: we run requests in a small pool (PARALLEL) instead of
// sequentially — 50 HEAD requests serialized would take 50 × ~600ms = 30s,
// while parallel-8 finishes in ~4s. The pool size is tuned so a free-tier
// Supabase instance doesn't get hammered with 50 concurrent updates.

// The link checker exists to WRITE is_working/last_checked back to `games`.
// Without an admin key every one of those UPDATEs is refused by RLS, so it
// would probe thousands of URLs and persist nothing.
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getSupabaseAdmin } from './supabase.mjs';
import { delPattern as cacheDelPattern } from './cache.mjs';
import { framingVerdict } from './framing.mjs';
// Probes hit URLs stored in the database. A poisoned row must not be able to
// point this job at internal infrastructure, so every probe goes through the
// same address-validated fetcher the request routes use.
import { safeFetch } from './safe-fetch.mjs';

const LC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OVERRIDES_FILE = join(LC_ROOT, 'data', 'catalog-overrides.json');
const FRAME_LOG_KEY = 'frameBlocked';
const FRAME_LOG_MAX = 500;

/**
 * Record framing exclusions in data/catalog-overrides.json.
 *
 * Written under its own machine-owned key. The serve-time loader
 * (lib/catalog-overrides.mjs) reads only `patch`, `add`, `remove` and
 * `featured`, so this key changes nothing about what is served — the
 * is_working=false write to Supabase is what actually hides the game. This is
 * the audit trail: which row, which header, and what it said, so a wrongly
 * excluded game can be argued with instead of guessed at.
 *
 * The file is hand-curated and 600KB+, so: only rewritten when something
 * actually changed, capped, and written atomically via a temp file + rename so
 * an interrupted run cannot truncate somebody's curation.
 */
function recordFramingExclusions(entries) {
  if (!entries.length || !existsSync(OVERRIDES_FILE)) return 0;
  let doc;
  try {
    doc = JSON.parse(readFileSync(OVERRIDES_FILE, 'utf8'));
  } catch (e) {
    console.warn('[link-check] overrides file unreadable, not logging exclusions:', e.message);
    return 0;
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return 0;

  const existing = Array.isArray(doc[FRAME_LOG_KEY]) ? doc[FRAME_LOG_KEY] : [];
  const bySlug = new Map(existing.map((e) => [e.slug, e]));
  let added = 0;
  for (const e of entries) {
    if (!bySlug.has(e.slug)) added++;
    bySlug.set(e.slug, e);
  }
  if (!added && entries.every((e) => existing.some((x) => x.slug === e.slug && x.reason === e.reason))) {
    return 0;                       // nothing new to say; leave the file alone
  }

  doc[FRAME_LOG_KEY] = [...bySlug.values()]
    .sort((a, b) => String(b.at).localeCompare(String(a.at)))
    .slice(0, FRAME_LOG_MAX);
  doc._comment_frameBlocked =
    'Written by lib/link-checker.mjs. Games whose own server refuses to be framed '
    + '(X-Frame-Options, or CSP frame-ancestors that excludes us). Ignored by the '
    + 'serve-time loader — the authoritative hide is is_working=false in Supabase.';

  const tmp = OVERRIDES_FILE + '.tmp';
  try {
    writeFileSync(tmp, JSON.stringify(doc, null, 2) + '\n', 'utf8');
    renameSync(tmp, OVERRIDES_FILE);
  } catch (e) {
    console.warn('[link-check] could not write exclusions:', e.message);
    return 0;
  }
  return entries.length;
}

// Spec: 3s ceiling per HEAD.  At concurrency 16, a worst-case 200-batch
// run finishes in ~38s wall time even if every URL times out.
const REQUEST_TIMEOUT_MS = 3000;
// Parallel pool size.  Tradeoff: higher = faster batch, but more open
// sockets and more risk of triggering rate-limits at upstream CDNs.
// 16 is a sweet spot for free-tier Supabase + free-tier hosts.
const PARALLEL = 16;

// HEAD some publisher CDNs reject HEAD outright (returns 405). For those
// we retry with GET-but-aborted-after-headers so we don't download the body.
//
// Exported so other crons (daily-promote in cron-jobs.mjs) can pre-validate
// URLs before insert without duplicating the probe logic.
// Browser-like headers. Many publisher CDNs 403 a bare HEAD/GET from a
// datacenter IP but serve a real iframe navigation fine, so we mirror the
// headers a browser sends when loading the game inside an <iframe>.
function browserHeaders(url) {
  let origin = '';
  try { origin = new URL(url).origin + '/'; } catch {}
  return {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer': origin,
    'Sec-Fetch-Dest': 'iframe', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Site': 'cross-site',
  };
}

export async function probe(url, { selfOrigin = '' } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);

  // A status code alone is not health. A page that answers 200 and sends
  // `X-Frame-Options: DENY` renders as a black rectangle inside our player, and
  // the old check called that healthy — the single largest source of "the game
  // just doesn't load" in this catalog. The framing verdict is now part of the
  // result, and it only ever fires on a POSITIVE blocking header: a response
  // with no framing headers stays alive, so a CDN that omits them on HEAD can
  // never cost us a working game.
  const judge = (r, status) => {
    const statusOk = status >= 200 && status < 400;
    const framing = framingVerdict(r.headers, { selfOrigin });
    return { ok: statusOk && !framing.blocked, status, framing };
  };

  try {
    const r = await safeFetch(url, { method: 'HEAD', timeoutMs: REQUEST_TIMEOUT_MS, headers: browserHeaders(url) });
    // Many publisher CDNs reject HEAD (and a bare GET) with 401/403/405/429/501
    // even though a real iframe GET serves the game fine. Retry with browser-
    // like headers so we don't false-flag a working game as dead.
    if ([401, 403, 405, 429, 501].includes(r.status)) {
      const ctrl2 = new AbortController();
      const t2 = setTimeout(() => ctrl2.abort(), REQUEST_TIMEOUT_MS);
      try {
        const r2 = await safeFetch(url, { method: 'GET', timeoutMs: REQUEST_TIMEOUT_MS, headers: browserHeaders(url) });
        try { await r2.body?.cancel(); } catch { /* headers are all we needed */ }
        return judge(r2, r2.status);
      } finally { clearTimeout(t2); }
    }
    return judge(r, r.status);
  } catch (e) {
    return { ok: false, status: 0, error: e.name === 'AbortError' ? 'timeout' : e.message, framing: null };
  } finally {
    clearTimeout(t);
  }
}

// Small concurrency pool — keeps Supabase + the network happy.
async function pool(items, n, worker) {
  const queue = items.slice();
  const runners = new Array(n).fill(0).map(async () => {
    while (queue.length) {
      const it = queue.shift();
      if (it !== undefined) await worker(it);
    }
  });
  await Promise.all(runners);
}

export async function runLinkCheck({ batchSize = 50 } = {}) {
  const counters = { batchSize, checked: 0, alive: 0, dead: 0, framed: 0, errors: 0, supabaseDown: false, cacheInvalidated: 0 };
  const framingExclusions = [];

  const supa = getSupabaseAdmin();
  if (!supa) {
    counters.supabaseDown = true;
    console.warn('[link-check] Supabase not configured — skipping.');
    return counters;
  }

  let games;
  try {
    const { data, error } = await supa
      .from('games')
      .select('id, slug, title, game_url')
      .eq('is_working', true)
      .order('last_checked', { ascending: true })
      .limit(batchSize);
    if (error) throw error;
    games = data || [];
  } catch (e) {
    counters.supabaseDown = true;
    console.error('[link-check] failed to fetch batch:', e.message);
    return counters;
  }

  console.log(`[link-check] checking ${games.length} games (batch=${batchSize}, parallel=${PARALLEL}, timeout=${REQUEST_TIMEOUT_MS}ms)`);

  // Track whether any game was newly marked dead in this run.  If yes,
  // we surgically invalidate the paginated games cache so the dead row
  // can't leak back to users from a stale cached page response.
  let anyMarkedDead = false;

  await pool(games, PARALLEL, async (g) => {
    counters.checked++;
    try {
      const result = await probe(g.game_url);
      const nowIso = new Date().toISOString();
      if (result.ok) {
        counters.alive++;
        // Spec: success → update last_checked only. Per-row try/catch so a
        // single bad slug can't poison the batch.
        try {
          const { error } = await supa
            .from('games')
            .update({ last_checked: nowIso })
            .eq('id', g.id);
          if (error) throw error;
        } catch (e) {
          counters.errors++;
          console.warn(`[link-check] update-alive ${g.slug} failed:`, e.message);
        }
      } else if (result.framing?.blocked) {
        // The server answered, but it refuses to be framed. This is a DEFINITIVE
        // failure for our purposes even on a 200: the browser will not render it
        // inside the player, so every visitor gets a black rectangle. It is the
        // one "healthy" status code that is not health.
        counters.framed++;
        try {
          const { error } = await supa
            .from('games')
            .update({ is_working: false, last_checked: nowIso })
            .eq('id', g.id);
          if (error) throw error;
          anyMarkedDead = true;
          framingExclusions.push({
            slug: g.slug,
            url: g.game_url,
            reason: result.framing.reason,
            header: result.framing.header,
            value: String(result.framing.value || '').slice(0, 200),
            status: result.status,
            at: nowIso,
          });
          console.log(`[link-check]   FRAMED: ${g.slug} (${result.status}, ${result.framing.reason})`);
        } catch (e) {
          counters.errors++;
          console.warn(`[link-check] update-framed ${g.slug} failed:`, e.message);
        }
      } else if (result.status === 404 || result.status === 410) {
        // DEFINITIVE failure: the game is genuinely GONE (404 Not Found / 410
        // Gone). Only these are safe to mark dead. A 401/403/429 is almost
        // always an anti-bot/IP block (the game still loads in a browser/iframe
        // and via the proxy), and a 5xx is usually transient — so those fall
        // through to "inconclusive" below and stay alive.
        counters.dead++;
        try {
          const { error } = await supa
            .from('games')
            .update({ is_working: false, last_checked: nowIso })
            .eq('id', g.id);
          if (error) throw error;
          anyMarkedDead = true;
          console.log(`[link-check]   DEAD: ${g.slug} (${result.status})`);
        } catch (e) {
          counters.errors++;
          console.warn(`[link-check] update-dead ${g.slug} failed:`, e.message);
        }
      } else {
        // INCONCLUSIVE: timeout / DNS / network error (status 0), a host block
        // (401/403/429/451), or a transient server error (5xx). None prove the
        // game is gone — marking it dead here would let a flaky connection or an
        // anti-bot block silently erode the catalog (and once is_working=false,
        // it's never re-checked). Leave it alive and just bump last_checked so
        // it rotates to the back of the queue.
        counters.errors++;
        try {
          await supa.from('games').update({ last_checked: nowIso }).eq('id', g.id);
        } catch {}
      }
    } catch (e) {
      // Outer per-game try/catch — spec section 5. Update last_checked so
      // the row isn't stuck at the top of the ASC queue forever.
      counters.errors++;
      console.warn(`[link-check] ${g.slug} hard error:`, e.message);
      try {
        await supa.from('games').update({ last_checked: new Date().toISOString() }).eq('id', g.id);
      } catch {}
    }
  });

  // CRITICAL: cache invalidation. If any game was marked dead this
  // run, the paginated /api/games:page:* responses we cached an hour
  // ago may still include them. Surgical SCAN+UNLINK of the pattern
  // pins the staleness to a single round-trip and avoids FLUSHDB
  // (which would nuke unrelated keys other features rely on).
  if (anyMarkedDead) {
    try {
      counters.cacheInvalidated = await cacheDelPattern('games:page:*');
      console.log(`[link-check] cache invalidated: ${counters.cacheInvalidated} keys (games:page:*)`);
    } catch (e) {
      console.warn('[link-check] cache invalidation failed:', e.message);
    }
  }

  if (framingExclusions.length) {
    counters.framingLogged = recordFramingExclusions(framingExclusions);
  }

  console.log(`[link-check] done. checked=${counters.checked} alive=${counters.alive} dead=${counters.dead} framed=${counters.framed} errors=${counters.errors} cacheInvalidated=${counters.cacheInvalidated}`);
  return counters;
}
