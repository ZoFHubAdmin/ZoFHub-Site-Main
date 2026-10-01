#!/usr/bin/env node
// tools/verify-proxy.mjs — does each proxy engine actually render the site you
// asked for?
// ---------------------------------------------------------------------------
//   npm run verify-proxy
//   npm run verify-proxy -- --engine uv --target https://example.com/
//
// WHY THIS EXISTS. Until now nothing in this repository could answer "does
// Ultraviolet work?" without a human opening a browser. That gap cost real
// accuracy: the UV engine was recorded as broken — "service worker returns
// HTTP 500" — on the strength of a 207-byte response body. The body was
// example.com's actual body, which is 207 bytes. UV was fine. A check that
// loads the page and reads what rendered would not have made that mistake.
//
// ── WHY NOT UPSTREAM'S VALIDATOR ──────────────────────────────────────────
// InvisiProxy (AGPL-3.0, QuiteAFancyEmerald/InvisiProxy v7.0.2.1) ships
// proxyServiceValidator.js, which is the reason this file exists at all — the
// idea of a CI-runnable proxy check is theirs. Its method was NOT adopted, and
// the reason is worth writing down. It generates a proxy URL in a browser and
// then fetches that URL with axios:
//
//     const response = await axios.get(url, { headers });
//     return response.status === 200;
//
// A service worker only intercepts requests from clients it controls. An axios
// request from Node is not a client at all, so it never reaches the proxy — it
// hits the origin server and reports whatever that returns. Measured here: a
// fetch of a /uv/service/… URL from outside the worker's scope returns Express's
// own 404 JSON. A 200 from that request would mean the SERVER answered, which
// is the opposite of what the test is trying to prove.
//
// That is the trap this repository already names in RULE 3 — never treat HTTP
// 200 as verification. So the check below drives the real UI in a real browser
// and asserts on the DOCUMENT THAT RENDERED.
//
// NO UPSTREAM CODE IS COPIED. See docs/proxy/INVISIPROXY.md for the provenance record.

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(join(ROOT, 'noop.cjs'));

const args = process.argv.slice(2);
const flag = (n, d = null) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : d;
};

// Targets are chosen to be small, stable, and tolerant of being proxied. A
// marker is a string that can ONLY come from the real page, so a cached frame,
// an error page or the engine's own homepage cannot satisfy it.
const TARGETS = [
  { url: 'https://example.com/', marker: 'Example Domain' },
  { url: 'https://www.wikipedia.org/', marker: 'Wikipedia' },
];
// GUST is checked differently from the other two and it is worth saying why.
// Scramjet and Ultraviolet are SERVICE-WORKER engines: the page's own address
// bar drives them and the proxied document lands in #gustFrame, whose src
// encodes the target. GUST is an 'app' engine — it owns a whole browser UI, so
// /gust/ loads into #gustFrame and GUST renders the page into an iframe of its
// OWN (#frame), from a blob: URL. So it needs its own address bar (#url, one
// level down) and there is no encoded src to check; the rendered text is the
// evidence. Leaving it out meant a third of the built-in engines had no check
// at all.
const ENGINES = ['scramjet', 'uv', 'gust'];
const APP_ENGINES = new Set(['gust']);

const only = flag('engine');
const customTarget = flag('target');
const HEADFUL = args.includes('--headed');
const BASE = flag('base');
const PORT = Number(flag('port', '8741'));

let chromium;
try { ({ chromium } = require('playwright')); }
catch {
  console.error('playwright is not installed. It is a devDependency:\n  npm install\n'
    + 'Production deploys omit it on purpose (render.yaml uses --omit=dev).');
  process.exit(2);
}

// ── server ─────────────────────────────────────────────────────────────────
let srv = null;
let base = BASE;
if (!base) {
  const env = { ...process.env, PORT: String(PORT), NO_OPEN: '1', CRON_DISABLED: '1', ANURA_PORT: '0' };
  srv = spawn(process.execPath, ['server.js'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env });
  srv.stdout.on('data', () => {});
  srv.stderr.on('data', () => {});
  base = `http://127.0.0.1:${PORT}`;
  process.stdout.write('starting server');
  let up = false;
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1500) })).ok) { up = true; break; }
    } catch { /* not yet */ }
    process.stdout.write('.');
    await new Promise((r) => setTimeout(r, 500));
  }
  console.log(up ? ' ready\n' : ' FAILED\n');
  if (!up) { srv.kill('SIGKILL'); process.exit(2); }
}

const targets = customTarget ? [{ url: customTarget, marker: null }] : TARGETS;
const engines = only ? [only] : ENGINES;
const rows = [];

const browser = await chromium.launch({ headless: !HEADFUL });
const page = await browser.newPage();
await page.goto(`${base}/browser`, { waitUntil: 'domcontentloaded', timeout: 60000 });

// Both service workers must be ACTIVATED before any engine can be judged;
// otherwise the first engine tested is penalised for the app still warming up.
await page.waitForFunction(async () => {
  const regs = await navigator.serviceWorker.getRegistrations();
  return regs.filter((r) => r.active?.state === 'activated').length >= 2;
}, { timeout: 45000 }).catch(() => console.warn('warning: service workers did not both activate in 45s'));

for (const engine of engines) {
  for (const target of targets) {
    const t0 = Date.now();
    let verdict = 'FAIL';
    let detail = '';
    try {
      await page.selectOption('#engineSelect', engine);
      await page.waitForTimeout(APP_ENGINES.has(engine) ? 5000 : 800);

      if (APP_ENGINES.has(engine)) {
        // Drive GUST's own address bar, one frame down, then read the document
        // it renders into its inner #frame. No marker means no pass — and
        // because the two targets have distinct markers, a stale frame left
        // over from the previous target cannot satisfy this either.
        if (!target.marker) { rows.push({ engine, target: target.url, verdict: 'skip', ms: 0, detail: '--target needs a marker for app engines' }); continue; }
        const shell = page.frameLocator('#gustFrame');
        await shell.locator('#url').fill(target.url);
        await shell.locator('#url').press('Enter');
        const inner = shell.frameLocator('#frame');
        const deadline = Date.now() + 45000;
        let seen = '';
        while (Date.now() < deadline) {
          try { seen = await inner.locator('body').innerText({ timeout: 1500 }); } catch { seen = ''; }
          if (seen.includes(target.marker)) break;
          await page.waitForTimeout(1000);
        }
        if (seen.includes(target.marker)) { verdict = 'pass'; detail = `"${seen.trim().split('\n')[0].slice(0, 40)}"`; }
        else detail = seen ? `rendered ${seen.length} chars, marker "${target.marker}" absent` : 'inner frame never rendered';
        const ms0 = Date.now() - t0;
        rows.push({ engine, target: target.url, verdict, ms: ms0, detail });
        console.log(`  ${verdict === 'pass' ? 'pass' : 'FAIL'}  ${engine.padEnd(9)} ${target.url.padEnd(30)} ${String(ms0).padStart(6)}ms  ${detail}`);
        continue;
      }

      await page.fill('#urlInput', target.url);
      await page.press('#urlInput', 'Enter');

      // Poll the FRAME's own document. Two conditions, both required:
      //   1. the frame's src encodes the target we asked for — this is what
      //      catches a stale frame still showing the previous navigation, the
      //      exact mistake that produced the false "UV is broken" report;
      //   2. the rendered text carries a marker only the real page has.
      const host = new URL(target.url).hostname;
      const deadline = Date.now() + 45000;
      let last = null;
      while (Date.now() < deadline) {
        last = await page.evaluate(() => {
          const f = document.querySelector('#gustFrame');
          let text = null;
          let title = null;
          try {
            title = f.contentDocument?.title ?? null;
            text = f.contentDocument?.body?.innerText?.slice(0, 4000) ?? null;
          } catch { title = '(cross-origin)'; }
          return { src: f.getAttribute('src') || '', title, text, len: text?.length ?? 0 };
        });
        // The encoded URL is engine-specific and deliberately obfuscated, so
        // match on the decoded form the app produced rather than on a substring.
        const srcOk = last.src && await page.evaluate(([src, h, eng]) => {
          try {
            if (eng === 'scramjet') return decodeURIComponent(src).includes(h);
            const enc = self.__uv$config;
            const raw = src.slice(enc.prefix.length);
            return enc.decodeUrl(decodeURIComponent(raw)).includes(h);
          } catch { return false; }
        }, [last.src, host, engine]);

        const markerOk = target.marker
          ? (last.text || '').includes(target.marker) || (last.title || '').includes(target.marker)
          : last.len > 200;
        if (srcOk && markerOk) { verdict = 'pass'; detail = `"${(last.title || '').slice(0, 40)}"`; break; }
        if (srcOk && last.len > 0) detail = `rendered ${last.len} chars, marker "${target.marker}" absent`;
        else if (!srcOk) detail = 'frame is not pointing at the requested host';
        await page.waitForTimeout(1000);
      }
    } catch (e) {
      detail = String(e.message || e).slice(0, 90);
    }
    const ms = Date.now() - t0;
    rows.push({ engine, target: target.url, verdict, ms, detail });
    console.log(`  ${verdict === 'pass' ? 'pass' : 'FAIL'}  ${engine.padEnd(9)} ${target.url.padEnd(30)} ${String(ms).padStart(6)}ms  ${detail}`);
  }
}

await browser.close();
if (srv) srv.kill('SIGKILL');

const failed = rows.filter((r) => r.verdict !== 'pass');
const slowest = rows.reduce((a, b) => (a && a.ms > b.ms ? a : b), null);
console.log(`\n${rows.length - failed.length}/${rows.length} rendered correctly`
  + (slowest ? `  ·  slowest ${slowest.engine} ${slowest.ms}ms` : ''));
if (failed.length) {
  console.log('\nfailed:');
  for (const f of failed) console.log(`  ${f.engine} → ${f.target}: ${f.detail}`);
}
process.exit(failed.length ? 1 : 0);
