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
import { getSupabaseAdmin } from './supabase.mjs';
import { delPattern as cacheDelPattern } from './cache.mjs';

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

export async function probe(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  try {
    const r = await fetch(url, { method: 'HEAD', signal: ctrl.signal, redirect: 'follow', headers: browserHeaders(url) });
    // Many publisher CDNs reject HEAD (and a bare GET) with 401/403/405/429/501
    // even though a real iframe GET serves the game fine. Retry with browser-
    // like headers so we don't false-flag a working game as dead.
    if ([401, 403, 405, 429, 501].includes(r.status)) {
      const ctrl2 = new AbortController();
      const t2 = setTimeout(() => ctrl2.abort(), REQUEST_TIMEOUT_MS);
      try {
        const r2 = await fetch(url, { method: 'GET', signal: ctrl2.signal, redirect: 'follow', headers: browserHeaders(url) });
        return { ok: r2.status >= 200 && r2.status < 400, status: r2.status };
      } finally { clearTimeout(t2); }
    }
    return { ok: r.status >= 200 && r.status < 400, status: r.status };
  } catch (e) {
    return { ok: false, status: 0, error: e.name === 'AbortError' ? 'timeout' : e.message };
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
  const counters = { batchSize, checked: 0, alive: 0, dead: 0, errors: 0, supabaseDown: false, cacheInvalidated: 0 };

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

  console.log(`[link-check] done. checked=${counters.checked} alive=${counters.alive} dead=${counters.dead} errors=${counters.errors} cacheInvalidated=${counters.cacheInvalidated}`);
  return counters;
}
