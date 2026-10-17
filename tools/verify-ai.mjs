// tools/verify-ai.mjs — live browser verification of the AI architecture.
// ---------------------------------------------------------------------------
//   npm run verify-ai
//
// The sibling of `npm run verify-proxy`, and it exists for the same reason: the
// claims this feature makes are claims about what a REAL BROWSER does, and no
// amount of reading the source can settle them. It boots the real server, opens
// /ai in a real Chromium, types a real prompt, and records EVERY network request
// the page makes. Then it checks what cannot be proved statically:
//
//   1. the browser requests https://text.pollinations.ai/<encoded prompt>,
//      as ONE GET, and can actually READ the response (the cross-origin part)
//   2. the prompt never appears in a request to our own origin, and no
//      /api/ai/ request reaches the server at all
//   3. no key round-trip, no model discovery, no local inference download,
//      no image generation
//   4. the returned text is rendered into the existing message list
//   5. a prompt containing HTML is escaped, and a resend inside the send
//      cooldown is suppressed
//
// It makes a real request to the free tier, so it can fail for an honest
// external reason (a 429, or the tier being withdrawn). Read the printed
// request log before concluding the site is broken.
//
// NOTE: it exits non-zero on any failure, so it works as a gate.
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

const PORT = process.env.PORT || '8781';
const BASE = `http://127.0.0.1:${PORT}`;
// NOT `PROMPT`: Windows defines a PROMPT variable ($P$G) in every shell, so
// process.env.PROMPT silently replaced the test prompt with a command-prompt
// format string — and the model, reasonably, asked what $P$G meant.
const PROMPT = process.env.AI_VERIFY_PROMPT || 'In one short sentence, what is a prime number?';

const server = spawn(process.execPath, ['server.js'], {
  env: { ...process.env, PORT, NODE_ENV: 'development', NO_OPEN: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
let ready = false;
server.stdout.on('data', (b) => { serverLog += b; if (String(b).includes('running')) ready = true; });
server.stderr.on('data', (b) => { serverLog += b; });

const waitFor = async (fn, ms, label) => {
  const t0 = Date.now();
  for (;;) {
    if (await fn()) return true;
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 250));
  }
};

const fail = [];
const pass = [];
const check = (ok, label, detail = '') => {
  (ok ? pass : fail).push(label + (detail ? ` — ${detail}` : ''));
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
};

try {
  await waitFor(async () => ready, 90000, 'the server to boot');

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  const requests = [];
  page.on('request', (r) => requests.push({ url: r.url(), method: r.method(), type: r.resourceType() }));
  const responses = [];
  page.on('response', (r) => responses.push({ url: r.url(), status: r.status() }));
  const consoleErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 300)); });
  page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + String(e).slice(0, 300)));

  await page.goto(`${BASE}/ai`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForSelector('#aiInput', { timeout: 30000 });

  // ── The footer must be the shared one, on this page too ──────────────────
  await page.waitForFunction(() => !!document.querySelector('.site-footer')?.dataset.enhanced,
    { timeout: 15000 }).catch(() => {});
  const footer = await page.evaluate(() => {
    const f = document.querySelector('.site-footer');
    if (!f) return null;
    return {
      mini: f.classList.contains('site-footer-mini'),
      columns: f.querySelectorAll('.footer-col').length,
      brand: !!f.querySelector('.footer-brand'),
      links: f.querySelectorAll('a').length,
      hasMiniInner: !!f.querySelector('.footer-mini-inner'),
    };
  });
  check(!!footer && !footer.mini && footer.columns >= 3 && footer.brand && !footer.hasMiniInner,
    '/ai renders the full shared footer', JSON.stringify(footer));

  // ── Send a real prompt ───────────────────────────────────────────────────
  const before = requests.length;
  await page.fill('#aiInput', PROMPT);
  await page.press('#aiInput', 'Enter');

  // Wait until the assistant bubble holds real text (not the typing dots).
  let answered = false;
  try {
    await page.waitForFunction(() => {
      const rows = document.querySelectorAll('#aiMessages .msg.assistant');
      const last = rows[rows.length - 1];
      if (!last) return false;
      if (last.querySelector('.typing-dots')) return false;
      const t = (last.querySelector('.msg-body')?.textContent || '').trim();
      return t.length > 0;
    }, { timeout: 75000 });
    answered = true;
  } catch { /* recorded below */ }

  const sent = requests.slice(before);
  const encoded = encodeURIComponent(PROMPT);

  // 1. Did the browser call Pollinations directly?
  const direct = sent.filter((r) => r.url.startsWith('https://text.pollinations.ai/'));
  check(direct.length >= 1, 'the browser requested text.pollinations.ai directly',
    direct.length ? `${direct.length} request(s), method ${direct[0].method}` : 'no such request');

  if (direct.length) {
    const u = direct[0].url;
    // The path is the COMPOSED prompt: the site's grounding system prompt, the
    // recent turns, then a trailing "Assistant:" cue. The URL API takes one
    // string, so that is the only way to carry a system prompt or any history
    // at all. What must hold is that the user's text is in there verbatim, that
    // it is the last thing the model is asked about, and that the whole path is
    // a single encodeURIComponent (no double-encoding, no second segment).
    const path = u.slice('https://text.pollinations.ai/'.length);
    let decoded = null;
    try { decoded = decodeURIComponent(path); } catch { /* reported below */ }
    check(decoded !== null && encodeURIComponent(decoded) === path,
      'the path is exactly one encodeURIComponent of the prompt (not double-encoded)');
    check(decoded !== null && decoded.includes(PROMPT),
      "the user's typed text appears in the path verbatim",
      decoded === null ? 'path would not decode' : '');
    check(decoded !== null && decoded.trimEnd().endsWith('Assistant:'),
      'the user turn is the last thing asked, with the model cued to answer');
    check(decoded !== null && decoded.includes('ZoFHub AI'),
      'the grounding system prompt is included (this is what stops fabrication)');
    check(!path.includes('/'), 'the prompt is a single path segment');
    check(!u.includes('?'), 'no query string was added');
    check(direct[0].method === 'GET', 'it is a GET');
    check(direct.length === 1, 'exactly one upstream request per message', `${direct.length}`);
    const resp = responses.find((r) => r.url === u);
    check(!!resp, 'the response was readable by the page',
      resp ? `HTTP ${resp.status}` : 'no response event — the browser could not read it');
  }

  // 2. Did the prompt touch our own server?
  const ourOrigin = sent.filter((r) => r.url.startsWith(BASE));
  const leaked = ourOrigin.filter((r) =>
    r.url.includes(encoded) || r.url.toLowerCase().includes('prime number') || /\/api\/ai\//.test(r.url));
  check(leaked.length === 0, 'the prompt never went to our own server',
    leaked.length ? leaked.map((r) => r.method + ' ' + r.url).join(', ') : `${ourOrigin.length} same-origin request(s), none AI`);

  // 3. No key endpoint, no model discovery, no local model download.
  check(!sent.some((r) => /\/api\/ai\/key/.test(r.url)), 'no /api/ai/key round-trip');
  check(!sent.some((r) => /text\.pollinations\.ai\/models/.test(r.url)), 'no model-discovery round-trip');
  check(!sent.some((r) => /transformers|onnx|huggingface|\.wasm$/i.test(r.url)),
    'no local inference engine was downloaded');
  check(!sent.some((r) => /image\.pollinations\.ai/.test(r.url)), 'no image-generation request');

  // 4. Was the answer rendered?
  const rendered = await page.evaluate(() => {
    const rows = document.querySelectorAll('#aiMessages .msg.assistant');
    const last = rows[rows.length - 1];
    return {
      text: (last?.querySelector('.msg-body')?.textContent || '').trim().slice(0, 300),
      notice: !!document.querySelector('.ai-notice'),
      rateLimit: !!document.querySelector('.ai-ratelimit'),
      status: (document.querySelector('#aiEngineStatus')?.textContent || '').trim(),
    };
  });
  check(answered && rendered.text.length > 0 && !rendered.notice && !rendered.rateLimit,
    'the returned text rendered in the existing message list',
    JSON.stringify(rendered));

  // ── Rapid submissions are throttled ──────────────────────────────────────
  // Send is locked for 2.5s after each prompt, so an immediate second message
  // must NOT produce a second upstream request.
  const countUserTurns = () => page.evaluate(() =>
    document.querySelectorAll('#aiMessages .msg.user').length);
  // Two submits BACK TO BACK. (An earlier version of this check waited for the
  // first answer before resending, by which point the 2.5s window had long
  // expired — so it was asserting a guarantee that had already lapsed.)
  const turnsBefore = await countUserTurns();
  const reqBefore = requests.length;
  await page.fill('#aiInput', 'first of two rapid sends');
  await page.press('#aiInput', 'Enter');
  await page.fill('#aiInput', 'second of two rapid sends');
  await page.press('#aiInput', 'Enter');
  await page.waitForTimeout(1200);
  const burst = requests.slice(reqBefore).filter((r) => r.url.startsWith('https://text.pollinations.ai/'));
  const newTurns = (await countUserTurns()) - turnsBefore;
  // At most one of the two is accepted. It can legitimately be ZERO: the send
  // cooldown is 2.5s from the PREVIOUS submit, and the answer above can arrive
  // well inside that, so the lock may still be held when this burst starts.
  // What must never happen is two upstream requests from two fast keystrokes.
  check(burst.length <= 1 && newTurns <= 1,
    'two rapid submissions never produce two upstream requests',
    `${burst.length} request(s), ${newTurns} new user turn(s) accepted`);

  // ── A prompt containing HTML is escaped, not interpreted ─────────────────
  await page.waitForTimeout(2600);                       // let the cooldown clear
  await page.fill('#aiInput', '<img src=x onerror=alert(1)>');
  await page.press('#aiInput', 'Enter');
  await page.waitForFunction((n) =>
    document.querySelectorAll('#aiMessages .msg.user').length > n, turnsBefore, { timeout: 15000 });
  const xss = await page.evaluate(() => {
    const u = [...document.querySelectorAll('#aiMessages .msg.user .msg-body')].pop();
    return { html: (u?.innerHTML || '').slice(0, 200), imgs: document.querySelectorAll('#aiMessages img').length };
  });
  check(xss.imgs === 0 && xss.html.includes('&lt;img'),
    'a prompt containing HTML is escaped, not injected', JSON.stringify(xss));

  // ── The SECOND entry point: the floating assistant on every other page ──
  // The orb is a different file (public/js/ai-helper.js) on a different page,
  // so "the AI works" on /ai proves nothing about it. This is the check that
  // catches one entry point being left on an old implementation.
  {
    const orbPage = await browser.newPage();
    const orbRequests = [];
    const orbResponses = [];
    orbPage.on('request', (r) => orbRequests.push({ url: r.url(), method: r.method() }));
    orbPage.on('response', (r) => orbResponses.push({ url: r.url(), status: r.status() }));
    const orbErrors = [];
    orbPage.on('pageerror', (e) => orbErrors.push(String(e).slice(0, 200)));

    // Space this out from the /ai request above. The free tier is roughly one
    // request per 15s per IP, and sending both back to back made the endpoint
    // answer the second one 404 — the same request returned 200 when spaced.
    // Without this pause the tool fails on a limit it caused itself.
    await new Promise((r) => setTimeout(r, 16000));
    await orbPage.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    // layout.js ships a placeholder orb and lazy-loads ai-helper.js on first click.
    await orbPage.waitForSelector('#aiOrb', { timeout: 30000 });
    await orbPage.click('#aiOrb');
    await orbPage.waitForSelector('#aiOrbInput', { timeout: 30000 });

    const orbBefore = orbRequests.length;
    const ORB_PROMPT = 'Name one classic arcade game, in two words.';
    await orbPage.fill('#aiOrbInput', ORB_PROMPT);
    await orbPage.press('#aiOrbInput', 'Enter');

    let orbAnswered = false;
    try {
      await orbPage.waitForFunction(() => {
        const msgs = document.querySelectorAll('#aiOrbBody .ai-orb-msg.ai');
        const last = msgs[msgs.length - 1];
        if (!last || last.querySelector('.ai-orb-dots')) return false;
        return (last.textContent || '').trim().length > 0;
      }, { timeout: 75000 });
      orbAnswered = true;
    } catch { /* reported below */ }

    const orbSent = orbRequests.slice(orbBefore);
    const orbDirect = orbSent.filter((r) => r.url.startsWith('https://text.pollinations.ai/'));
    check(orbDirect.length === 1 && orbDirect[0].method === 'GET',
      'the floating assistant also sends ONE direct GET',
      `${orbDirect.length} request(s)`);
    check(!orbSent.some((r) => /\/api\/ai\//.test(r.url)),
      'the floating assistant uses no server route');
    if (orbDirect.length) {
      let dec = null;
      try { dec = decodeURIComponent(orbDirect[0].url.slice('https://text.pollinations.ai/'.length)); } catch {}
      check(dec !== null && dec.includes(ORB_PROMPT), 'its prompt is in the path verbatim');
    }
    const orbText = await orbPage.evaluate(() => {
      const msgs = document.querySelectorAll('#aiOrbBody .ai-orb-msg.ai');
      return (msgs[msgs.length - 1]?.textContent || '').trim().slice(0, 160);
    });
    const orbStatus = orbDirect.length
      ? (orbResponses.find((r) => r.url === orbDirect[0].url)?.status ?? 'no response')
      : 'no request';
    check(orbAnswered && orbText.length > 0, 'its answer rendered in the panel',
      `upstream HTTP ${orbStatus} :: ${JSON.stringify(orbText)}`);
    // A 429 is the documented free-tier limit and is not a defect. A 404 is the
    // UNDOCUMENTED way this endpoint sometimes expresses the same throttle
    // (measured: back-to-back requests gave 200 then 404, and the identical
    // second request gave 200 when spaced out) — tolerated here for the same
    // reason, and called out so a persistent 404 is not mistaken for normal.
    check([200, 429, 404].includes(orbStatus),
      'its upstream answered 200 (or 429/404, the free-tier throttle)', String(orbStatus));
    if (orbStatus !== 200) {
      console.log(`  note: the assistant's upstream answered ${orbStatus}; on this tier that is `
        + 'usually throttling. Re-run spaced out before treating it as a defect.');
    }
    check(orbErrors.length === 0, 'the floating assistant raised no page errors', orbErrors.join('; '));
    await orbPage.close();
  }

  // ── /browser also carries the shared footer ──────────────────────────────
  {
    const bp = await browser.newPage();
    await bp.goto(`${BASE}/browser`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await bp.waitForFunction(() => !!document.querySelector('.site-footer')?.dataset.enhanced,
      { timeout: 20000 }).catch(() => {});
    const f = await bp.evaluate(() => {
      const el = document.querySelector('.site-footer');
      return el && {
        mini: el.classList.contains('site-footer-mini'),
        columns: el.querySelectorAll('.footer-col').length,
        brand: !!el.querySelector('.footer-brand'),
      };
    });
    check(!!f && !f.mini && f.columns >= 3 && f.brand,
      '/browser renders the full shared footer too', JSON.stringify(f));
    await bp.close();
  }

  console.log('\n--- console errors ---');
  console.log(consoleErrors.length ? consoleErrors.join('\n') : '(none)');

  console.log('\n--- every request the page made after submitting ---');
  for (const r of sent) console.log(`  ${r.method} ${r.url.slice(0, 150)}`);

  console.log('\n--- server log: any AI route touched? ---');
  const aiHits = serverLog.split('\n').filter((l) => /\/api\/ai\//.test(l));
  console.log(aiHits.length ? aiHits.join('\n') : '(no /api/ai/ request reached the server)');

  await browser.close();
} catch (e) {
  console.log('HARNESS ERROR: ' + (e?.message || e));
  fail.push('harness: ' + (e?.message || e));
} finally {
  server.kill();
}

console.log(`\n==== ${pass.length} passed, ${fail.length} failed ====`);
if (fail.length) { console.log('failed:'); for (const f of fail) console.log('  - ' + f); }
process.exit(fail.length ? 1 : 0);
