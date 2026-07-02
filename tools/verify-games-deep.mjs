// tools/verify-games-deep.mjs
//
// Real game URL verification with HTTP HEAD/GET requests, runs each game
// multiple times to confirm stability, and identifies truly broken games.
//
//   node tools/verify-games-deep.mjs            # report only
//   node tools/verify-games-deep.mjs --fix      # auto-remove broken + rewrite html-snippet URLs
//   node tools/verify-games-deep.mjs --rewrite  # rewrite html-snippet embed URLs only
//   node tools/verify-games-deep.mjs --runs N   # how many probe attempts per URL (default 3)
//
// Output:
//   broken-games-final.json   ← per-source, per-game details
//   tools/verify-games-deep.report.txt   ← human summary
//
// Detection rules (in order):
//   1. URL is missing / not a string / does not start with http(s)://
//   2. URL contains an HTML snippet (<div>, <script>, <iframe>) — not a real URL
//      (these can sometimes be auto-rewritten to the publisher's direct game URL)
//   3. Real HTTP check: GET the URL with a browser UA, parse the body, look for
//      a <title> or game-frame signature. Mark as broken if:
//        - Network error / DNS fail / connect refused
//        - HTTP 4xx (5xx retries once)
//        - Body too small (<300 bytes) and no <html> / <body> / <title>
//        - Body contains "404", "not found", "parked domain", "domain for sale",
//          "this domain", "coming soon" with no real game content
//
// For api/games.json (the live catalog the server actually serves), each URL is
// probed RUNS times — broken only if ALL probes fail.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const FIX      = process.argv.includes('--fix');
const REWRITE  = process.argv.includes('--rewrite') || FIX;  // --fix implies rewrite
const runsArg  = process.argv.find(a => a.startsWith('--runs='));
const RUNS     = parseInt(runsArg ? runsArg.split('=')[1] : (process.argv.includes('--runs') ? process.argv[process.argv.indexOf('--runs') + 1] : 3), 10);

// Game sources to verify
const GAME_SOURCES = [
  { file: 'api/games.json',                 name: 'API Games (LIVE CATALOG)', critical: true,  autoFix: true  },
  { file: 'ai_gaming_hub_final.json',       name: 'AI Gaming Hub',            critical: false, autoFix: true  },
  { file: 'data/top_games.json',            name: 'Top Games',                critical: false, autoFix: true  }
];

// ---------------- HTTP probe ----------------

function probe(url, timeout = 7000) {
  return new Promise((resolve) => {
    let parsed;
    try { parsed = new URL(url); } catch { return resolve({ ok: false, reason: 'invalid-url' }); }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return resolve({ ok: false, reason: 'bad-protocol' });
    }
    const lib = parsed.protocol === 'https:' ? httpsRequest : httpRequest;
    const start = Date.now();
    const req = lib({
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: 'GET',
      timeout,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9'
      }
    }, (res) => {
      const status = res.statusCode || 0;
      // Drain at most 48KB — enough to see if it's a real game page (scripts/canvas) vs parked
      let body = '';
      let bytes = 0;
      res.on('data', (chunk) => {
        if (bytes < 49152) {
          body += chunk.toString('utf8', 0, Math.min(chunk.length, 49152 - bytes));
          bytes += chunk.length;
        }
      });
      res.on('end', () => {
        const ms = Date.now() - start;
        if (status >= 400) return resolve({ ok: false, status, reason: `http-${status}`, body: body.slice(0, 200), ms });

        // ====== Body-shape signals ======
        const lower = body.toLowerCase();
        const len = body.length;

        // Trivially empty / not HTML
        if (len < 100) return resolve({ ok: false, status, reason: 'empty-body', body: body.slice(0, 200), ms });

        // Must look like an HTML page — if it doesn't, it's not a renderable game.
        if (!/<html|<!doctype|<head/i.test(body)) {
          return resolve({ ok: false, status, reason: 'not-html', body: body.slice(0, 200), ms });
        }

        // Strong "this is a game" signals
        const hasCanvas   = /<canvas\b/i.test(body);
        const hasGameJS   = /<script[^>]*src=[^>]*(game|play|embed|main|app|index|html5|phaser|unity)/i.test(body);
        const hasIframe   = /<iframe\b/i.test(body);
        const hasGameAPI  = /(phaser|unity|createjs|kaboom|gamezop|gameMonetize|GameDistribution|Y8\.|htmlgames|famobi|playhop|gameflare)/i.test(body);
        const gameSignals = hasCanvas || hasGameJS || hasIframe || hasGameAPI;

        // ====== Parked-domain / 404 page signals ======
        // Only consider the body "parked" if it does NOT also have a strong game signal.
        const parkedRegex = /(404|page[\s-]*not[\s-]*found|domain[\s-]for[\s-]sale|coming[\s-]soon|parked[\s-]domain|suspended[\s-]page|this[\s-]+domain|buy[\s-]this[\s-]domain|is[\s-]+for[\s-]+sale|account[\s-]suspended|site[\s-]not[\s-]*found)/i;
        const looksLikeParked = parkedRegex.test(lower) && len < 4000; // parked pages are usually small

        if (looksLikeParked && !gameSignals) {
          return resolve({ ok: false, status, reason: 'soft-404-signals', body: body.slice(0, 200), ms });
        }

        // A page that has NO game signals AND is suspiciously small is a real "not a game" failure
        if (!gameSignals && len < 600) {
          return resolve({ ok: false, status, reason: 'no-game-signals', body: body.slice(0, 200), ms });
        }

        resolve({ ok: true, status, bodyLen: body.length, ms, gameSignals: { hasCanvas, hasGameJS, hasIframe, hasGameAPI } });
      });
    });
    req.on('error', (e) => {
      // HPE_HEADER_OVERFLOW happens when the server sends a set-cookie or other
      // header longer than Node's parser limit (8KB on a single line). The game
      // still works in a real browser — only Node's HTTP parser chokes. Mark
      // as "unverifiable" (NOT broken) so we don't drop working games.
      if (e.code === 'HPE_HEADER_OVERFLOW') {
        return resolve({ ok: true, reason: 'unverifiable-header-overflow', ms: Date.now() - start });
      }
      resolve({ ok: false, reason: 'net-error:' + e.code, ms: Date.now() - start });
    });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, reason: 'timeout', ms: Date.now() - start }); });
    req.end();
  });
}

// ---------------- HTML-snippet URL rewrite ----------------
// Some catalog sources (notably everygame.json — htmlgames.com) store a
// `<div><script src="...embed.js?game=Foo..."></script></div>` HTML string
// in the "embed" field instead of a real URL. The script can rewrite these
// to the publisher's direct game URL: `https://cdn.htmlgames.com/Foo/index.html`.
const HTMLGAMES_EMBED_RE = /cdn\.htmlgames\.com\/embed\.js\?game=([A-Za-z0-9_-]+)/i;
function rewriteHtmlSnippetUrl(raw) {
  if (typeof raw !== 'string') return null;
  if (!raw.includes('<') && !raw.includes('script')) return null;
  const m = raw.match(HTMLGAMES_EMBED_RE);
  if (m) return `https://cdn.htmlgames.com/${m[1]}/index.html`;
  return null;
}

// ---------------- File load/normalize ----------------

function normalizeGame(g) {
  if (!g || typeof g !== 'object') return null;
  const title = g.title || g.name || '';
  if (!title) return null;
  const game_url = g.embed_url || g.embedUrl || g.embed || g.link || g.game_url || g.url || '';
  if (!game_url || typeof game_url !== 'string') return null;
  const slug = g.slug || String(title).toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
  return {
    slug,
    title,
    game_url,
    thumbnail_url: g.thumbnail || g.thumbnail_url || g.image || g.imageUrl || '',
    category: (g.category || g.type || g.genre || 'arcade').toString().toLowerCase()
  };
}

function loadJsonGames(filePath) {
  try {
    const raw = readFileSync(filePath, 'utf8');
    const data = JSON.parse(raw);
    let arr;
    if (Array.isArray(data)) arr = data;
    else if (data.games && Array.isArray(data.games)) arr = data.games;
    else if (data.gamesFlat && Array.isArray(data.gamesFlat)) arr = data.gamesFlat;
    else arr = [];
    return { arr, raw, isArray: Array.isArray(data) || !!data.games };
  } catch (e) {
    return { arr: [], raw: null, isArray: true, error: e.message };
  }
}

// ---------------- Concurrent probe runner ----------------

async function probeAllSequential(games, runs, onProgress) {
  const results = [];
  let i = 0;
  for (const g of games) {
    i++;
    onProgress && onProgress(i, games.length, g);
    const url = g.game_url;
    // Cheap pre-check: is the URL even an http(s) URL?
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
      results.push({ ...g, ok: false, reason: 'invalid-url', attempts: 0 });
      continue;
    }
    // HTML-snippet detection
    if (url.includes('<') || url.includes('script') || url.includes('div>')) {
      const rewritten = rewriteHtmlSnippetUrl(url);
      results.push({ ...g, ok: false, reason: 'html-snippet-url', rewritten, attempts: 0 });
      continue;
    }
    // Run multiple probes — only mark broken if ALL fail
    const attempts = [];
    for (let r = 0; r < runs; r++) {
      const res = await probe(url);
      attempts.push(res);
      if (res.ok) break;
    }
    const ok = attempts.some(a => a.ok);
    results.push({ ...g, ok, attempts, firstFail: attempts.find(a => !a.ok) });
  }
  return results;
}

// ---------------- Per-file audit & fix ----------------

async function auditFile(source) {
  const filePath = join(ROOT, source.file);
  if (!existsSync(filePath)) {
    console.log(`  SKIP ${source.name} — ${source.file} not found`);
    return { source: source.name, file: source.file, skipped: true };
  }
  const { arr, raw, isArray, error } = loadJsonGames(filePath);
  if (error) {
    console.log(`  SKIP ${source.name} — JSON parse failed: ${error}`);
    return { source: source.name, file: source.file, skipped: true };
  }
  const norm = arr.map(normalizeGame).filter(Boolean);
  const dedup = new Map();
  for (const g of norm) {
    if (!dedup.has(g.slug)) dedup.set(g.slug, g);
  }
  const games = [...dedup.values()];
  console.log(`  Auditing ${source.name} (${games.length} unique slugs) with ${RUNS} probe(s) each...`);

  const results = await probeAllSequential(games, RUNS, (i, total, g) => {
    if (i % 50 === 0 || i === total) process.stdout.write(`\r    ${i}/${total}  (last: ${g.slug})   `);
  });
  process.stdout.write('\n');

  const broken = results.filter(r => !r.ok);
  const rewrites = results.filter(r => r.reason === 'html-snippet-url' && r.rewritten);
  console.log(`    total=${results.length}  broken=${broken.length}  rewriteable=${rewrites.length}`);

  // Auto-fix
  let rewroteCount = 0, removedCount = 0;
  if ((REWRITE || FIX) && source.autoFix && raw) {
    // Build slug → replacement map (HTML-snippet rewrites first, drop broken next)
    const replacement = new Map();
    for (const r of results) {
      if (r.reason === 'html-snippet-url' && r.rewritten) {
        replacement.set(r.slug, r.rewritten);
      }
    }
    // Apply rewrites to the raw data
    let updatedRaw = raw;
    if (replacement.size > 0) {
      const jsonStr = JSON.stringify(updatedRaw);
      // Walk the JSON, find objects with matching slug+embed_url, swap
      const updated = JSON.parse(jsonStr, (key, value) => {
        if (value && typeof value === 'object' && !Array.isArray(value) && value.slug && replacement.has(value.slug)) {
          const newUrl = replacement.get(value.slug);
          if (value.embed_url) { value.embed_url = newUrl; rewroteCount++; }
          if (value.embed)    { value.embed    = newUrl; }
          if (value.embedUrl) { value.embedUrl = newUrl; }
          if (value.url)      { value.url      = newUrl; }
          if (value.game_url) { value.game_url = newUrl; }
        }
        return value;
      });
      updatedRaw = updated;
    }
    // Drop broken entries from raw data
    if (FIX && source.critical) {
      const brokenSlugs = new Set(broken.map(b => b.slug));
      let pruned;
      if (Array.isArray(updatedRaw)) {
        pruned = updatedRaw.filter(g => !(g && g.slug && brokenSlugs.has(g.slug)));
      } else if (updatedRaw.games && Array.isArray(updatedRaw.games)) {
        pruned = { ...updatedRaw, games: updatedRaw.games.filter(g => !(g && g.slug && brokenSlugs.has(g.slug))) };
      } else {
        pruned = updatedRaw;
      }
      removedCount = brokenSlugs.size;
      updatedRaw = pruned;
    }
    if (rewroteCount > 0 || removedCount > 0) {
      const finalJson = JSON.stringify(updatedRaw, null, 2);
      writeFileSync(filePath, finalJson);
      console.log(`    → wrote ${source.file} (rewrote ${rewroteCount} URLs, removed ${removedCount} broken)`);
    }
  }

  return {
    source: source.name,
    file: source.file,
    total: results.length,
    broken: broken.map(b => ({
      slug: b.slug,
      title: b.title,
      url: b.game_url,
      reason: b.reason || (b.firstFail && b.firstFail.reason) || 'unknown',
      status: b.firstFail && b.firstFail.status,
      attempts: (b.attempts || []).map(a => ({ ok: a.ok, reason: a.reason, status: a.status, ms: a.ms }))
    })),
    rewrites: rewrites.map(r => ({ slug: r.slug, title: r.title, from: r.game_url, to: r.rewritten })),
    rewroteCount,
    removedCount
  };
}

// ---------------- Main ----------------

async function main() {
  console.log('=== Deep Game Verification ===');
  console.log(`Mode: ${FIX ? 'FIX (rewrite + remove)' : REWRITE ? 'REWRITE only' : 'REPORT only'}`);
  console.log(`Probes per URL: ${RUNS}\n`);

  const reports = [];
  for (const source of GAME_SOURCES) {
    console.log(`\n[${source.name}]`);
    const r = await auditFile(source);
    reports.push(r);
  }

  // Summary
  let totalGames = 0, totalBroken = 0, totalRewritten = 0, totalRemoved = 0;
  for (const r of reports) {
    if (r.skipped) continue;
    totalGames    += r.total;
    totalBroken   += r.broken.length;
    totalRewritten += r.rewroteCount || 0;
    totalRemoved  += r.removedCount || 0;
  }
  console.log('\n=== Summary ===');
  console.log(`Sources audited: ${reports.filter(r => !r.skipped).length}`);
  console.log(`Total games:     ${totalGames}`);
  console.log(`Broken games:    ${totalBroken}`);
  console.log(`URLs rewritten:  ${totalRewritten}`);
  console.log(`Games removed:   ${totalRemoved}`);

  // Write per-game JSON
  const outJson = join(ROOT, 'broken-games-final.json');
  writeFileSync(outJson, JSON.stringify(reports, null, 2));
  console.log(`\nDetails saved to: broken-games-final.json`);

  // Write human-readable report
  const lines = [];
  lines.push('=== Deep Game Verification Report ===');
  lines.push(`Mode: ${FIX ? 'FIX' : REWRITE ? 'REWRITE' : 'REPORT'}  Probes/URL: ${RUNS}`);
  lines.push(`Total games: ${totalGames}  Broken: ${totalBroken}  Rewrites: ${totalRewritten}  Removed: ${totalRemoved}`);
  for (const r of reports) {
    if (r.skipped) { lines.push(`\n[${r.source}]  SKIPPED`); continue; }
    lines.push(`\n[${r.source}]  ${r.file}  total=${r.total}  broken=${r.broken.length}  rewrote=${r.rewroteCount || 0}  removed=${r.removedCount || 0}`);
    if (r.broken.length) {
      for (const b of r.broken) {
        lines.push(`  BROKEN  ${b.slug}  (${b.title})  reason=${b.reason}  status=${b.status || '-'}`);
        lines.push(`         ${b.url}`);
      }
    }
    if (r.rewrites && r.rewrites.length) {
      for (const w of r.rewrites) {
        lines.push(`  REWRITE ${w.slug}  ${w.from}  →  ${w.to}`);
      }
    }
  }
  const outTxt = join(ROOT, 'tools', 'verify-games-deep.report.txt');
  writeFileSync(outTxt, lines.join('\n'));
  console.log(`Text report:    ${outTxt}`);
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
