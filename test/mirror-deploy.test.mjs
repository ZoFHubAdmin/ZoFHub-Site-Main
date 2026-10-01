// test/mirror-deploy.test.mjs — the site must work on a domain it has never
// heard of, with no code change.
// ---------------------------------------------------------------------------
// THE SCENARIO THIS EXISTS FOR. The primary domain gets added to a school web
// filter. The response is to stand the same code up on a fresh throwaway
// domain, today, without editing anything. That only works if NOTHING the
// server emits names a specific host.
//
// A hardcoded hostname does not announce itself. The mirror comes up, the pages
// render, and then canonical tags point at the blocked domain, the sitemap
// advertises it to crawlers, and a link sends a visitor straight back to the
// filter that blocked them. So this file serves real requests under two
// different Host headers and asserts the output actually follows the host.
//
// It deliberately does NOT ban absolute URLs in general — the panic cloak has
// to name classroom.google.com, and the AI client has to name its provider.
// What it bans is the site naming ITSELF.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PORT = 8531;
const BASE = `http://127.0.0.1:${PORT}`;

// Two hosts that share nothing. If a response mentions one while being asked
// under the other, something is hardcoded.
const MIRROR_A = 'zofhub-primary.example';
const MIRROR_B = 'totally-different-mirror.test';

let srv;

before(async () => {
  const env = { ...process.env };
  try {
    for (const line of readFileSync(join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
      const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
      if (m && !env[m[1]]) env[m[1]] = m[2];
    }
  } catch { /* .env is optional */ }

  srv = spawn(process.execPath, ['server.js'], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...env, PORT: String(PORT), NO_OPEN: '1', CRON_DISABLED: '1', NODE_ENV: 'test' },
  });
  srv.stdout.resume();
  srv.stderr.resume();

  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(1500) })).ok) return;
    } catch { /* still booting */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('server did not start');
});

after(() => { try { srv?.kill('SIGKILL'); } catch { /* already gone */ } });

// node:http, NOT fetch. `Host` is a forbidden header in the fetch spec, and
// undici silently replaces it with the connected address — so a fetch-based
// version of this file passes or fails on the loopback name and never tests a
// mirror at all. Only a raw request can pose as another domain.
function getAs(host, path) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: PORT, path, headers: { Host: host } },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { body += c; });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
      },
    );
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error(`timeout on ${path}`)));
    req.end();
  });
}

describe('the served site follows the host it was asked under', () => {
  for (const path of ['/robots.txt', '/sitemap.xml']) {
    test(`${path} advertises the requesting host, not a baked-in one`, async () => {
      const a = (await getAs(MIRROR_A, path)).body;
      const b = (await getAs(MIRROR_B, path)).body;

      assert.ok(a.includes(MIRROR_A), `${path} under ${MIRROR_A} never mentions it`);
      assert.ok(b.includes(MIRROR_B), `${path} under ${MIRROR_B} never mentions it`);
      // The decisive one: serving the mirror must not leak the other domain.
      assert.ok(!b.includes(MIRROR_A),
        `${path} served to ${MIRROR_B} still names ${MIRROR_A} — a hardcoded host`);
    });
  }

  test('a game page sends GameDistribution the mirror it is actually on', async () => {
    // The revenue-share referrer is the one place the site deliberately tells a
    // third party its own address. On a mirror it must say the MIRROR, or the
    // in-game ad revenue is attributed to a domain that no longer serves anyone.
    const games = await (await fetch(`${BASE}/api/games?limit=1`)).json().catch(() => null);
    const slug = games?.games?.[0]?.slug || games?.[0]?.slug;
    if (!slug) return;   // empty catalog in this environment — nothing to assert

    const html = (await getAs(MIRROR_B, `/play/${slug}`)).body;
    assert.ok(!html.includes(MIRROR_A),
      `/play/${slug} served to ${MIRROR_B} leaked ${MIRROR_A}`);

    const ref = /gd_sdk_referrer_url=([^"&'\\ ]+)/.exec(html);
    if (ref) {
      assert.ok(decodeURIComponent(ref[1]).includes(MIRROR_B),
        `gd_sdk_referrer_url points somewhere other than the serving host: ${ref[1]}`);
    }
  });

  test('no HTML page hardcodes a hostname for itself', async () => {
    for (const path of ['/', '/browser', '/donate', '/leaderboard', '/community']) {
      const html = (await getAs(MIRROR_B, path)).body;
      for (const bad of [MIRROR_A, 'zofhub.com', 'zofhub.onrender.com']) {
        assert.ok(!html.includes(bad), `${path} contains a hardcoded "${bad}"`);
      }
    }
  });
});

describe('static assets carry no self-reference', () => {
  // Walks what is actually SERVED, so a new page cannot quietly reintroduce
  // this. Vendored engine bundles are excluded: they are third-party sources
  // under AGPL and are not ours to rewrite.
  const SKIP_DIRS = new Set(['gust', 'uv', 'scram', 'epoxy', 'baremux', 'vendor', 'assets']);

  // Naming the site's own deployments. External hosts are fine and expected.
  const SELF_RE = /https?:\/\/(?:[a-z0-9-]+\.)*zofhub\.(?:com|net|org|io|onrender\.com)/i;

  function* walk(dir) {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        if (SKIP_DIRS.has(entry)) continue;
        yield* walk(full);
      } else if (['.html', '.js', '.css', '.json'].includes(extname(entry))) {
        yield full;
      }
    }
  }

  test('nothing under public/ names a ZoFHub deployment', () => {
    const offenders = [];
    for (const file of walk(join(ROOT, 'public'))) {
      const text = readFileSync(file, 'utf8');
      const hit = SELF_RE.exec(text);
      // zofhub.local is a SENTINEL BASE for parsing relative URLs with the URL
      // constructor, not a host anything is fetched from. It never leaves the
      // client and is correct as written.
      if (hit && !/zofhub\.local/i.test(hit[0])) {
        offenders.push(`${file.slice(ROOT.length + 1)}: ${hit[0]}`);
      }
    }
    assert.deepEqual(offenders, [],
      'these would break, or leak the blocked domain, on a mirror:\n' + offenders.join('\n'));
  });

  test('no page pins a canonical or og:url to an absolute host', () => {
    const offenders = [];
    for (const file of walk(join(ROOT, 'public'))) {
      if (extname(file) !== '.html') continue;
      const text = readFileSync(file, 'utf8');
      for (const m of text.matchAll(/<(?:link|meta)[^>]*(?:rel="canonical"|property="og:url")[^>]*>/gi)) {
        // A canonical pointing at the blocked domain tells search engines the
        // mirror is a duplicate of a page nobody can reach.
        if (/(?:href|content)="https?:\/\//i.test(m[0])) {
          offenders.push(`${file.slice(ROOT.length + 1)}: ${m[0].trim()}`);
        }
      }
    }
    assert.deepEqual(offenders, [], 'absolute canonical/og:url survives a mirror move badly');
  });
});

describe('deployment config makes no host assumption', () => {
  test('SITE_URL is never required for the site to serve', () => {
    // SITE_URL exists for CORS and for naming the site in legal text. If any
    // ASSET path or API route resolved through it, an unset or stale value on a
    // fresh mirror would break the page rather than degrade a sentence.
    const server = readFileSync(join(ROOT, 'server.js'), 'utf8');
    const misuse = [...server.matchAll(/^.*SITE_URL.*$/gm)]
      .map(m => m[0])
      .filter(l => /src=|href=|fetch\(|\.static\(|sendFile/.test(l) && !l.trim().startsWith('//'));
    assert.deepEqual(misuse, [], 'SITE_URL is being used to build an asset or request path');
  });

  test('render.yaml pins no hostname into the service', () => {
    if (!existsSync(join(ROOT, 'render.yaml'))) return;
    const yaml = readFileSync(join(ROOT, 'render.yaml'), 'utf8');
    for (const line of yaml.split(/\r?\n/)) {
      if (line.trim().startsWith('#')) continue;           // comments may cite examples
      assert.ok(!/value:\s*https?:\/\/[a-z0-9-]+\.(?:com|net|org|io)/i.test(line),
        `render.yaml hardcodes a host: ${line.trim()}`);
    }
  });
});
