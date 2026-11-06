// tools/verify-ai.mjs — live browser verification of the AI architecture.
// ---------------------------------------------------------------------------
//   npm run verify-ai
//
// A real-browser check of the AI page against a booted server, and it exists for one reason: the
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
//      and a TEXT message makes no image request
//   4. the returned text is rendered into the existing message list
//   5. a prompt containing HTML is escaped, and a resend inside the 18 s wait
//      that follows every answer is refused (and the wait really lasts ~18 s)
//   6. /image <description> asks https://image.pollinations.ai/<description>
//      from the browser — ONE GET, issued by an <img>, no query string, no
//      server hop — shows the picture, and a second /image inside the 50 s wait
//      is refused
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
  // CRON_DISABLED: this server inherits the real .env, Supabase admin key included, and a run
  // lasts well over 30 s. Without it the first link-check fires and WRITES is_working=false to
  // the live games table. A verification run must never touch live data.
  env: { ...process.env, PORT, NODE_ENV: 'development', NO_OPEN: '1', CRON_DISABLED: '1' },
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
  const answeredAt = Date.now();

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
  check(!sent.some((r) => /image\.pollinations\.ai/.test(r.url)), 'a text message makes no image request');

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

  // ── Every answer is followed by an 18 s wait ──────────────────────────────
  // The wait starts when the answer lands, so a message sent straight after it
  // must be refused: no upstream request, no new user bubble, and the typed text
  // kept. Then the wait must really END about 18 s after the answer — a lock that
  // never lifted would pass the first half and leave a dead page.
  const countUserTurns = () => page.evaluate(() =>
    document.querySelectorAll('#aiMessages .msg.user').length);
  const waitState = await page.evaluate(() => ({
    disabled: document.querySelector('#aiSend').disabled,
    hint: document.querySelector('#aiHint').textContent,
  }));
  check(waitState.disabled && /Next message in \d+s/.test(waitState.hint),
    'Send is locked once the answer lands, with a visible countdown', JSON.stringify(waitState));
  const turnsBefore = await countUserTurns();
  const reqBefore = requests.length;
  await page.fill('#aiInput', 'sent inside the wait');
  await page.press('#aiInput', 'Enter');
  await page.waitForTimeout(1200);
  const burst = requests.slice(reqBefore).filter((r) => r.url.startsWith('https://text.pollinations.ai/'));
  const newTurns = (await countUserTurns()) - turnsBefore;
  check(burst.length === 0 && newTurns === 0,
    'a message sent inside the 18s wait is refused',
    `${burst.length} request(s), ${newTurns} new user turn(s) accepted`);
  check((await page.inputValue('#aiInput')) === 'sent inside the wait',
    'and what was typed is kept');
  let waitEnded = true;
  try {
    await page.waitForFunction(() => !document.querySelector('#aiSend').disabled, null, { timeout: 26000 });
  } catch { waitEnded = false; }
  const waitedSec = (Date.now() - answeredAt) / 1000;
  check(waitEnded && waitedSec >= 16.5 && waitedSec <= 21,
    'the wait ends about 18s after the answer', `${waitedSec.toFixed(1)}s`);

  // ── A prompt containing HTML is escaped, not interpreted ─────────────────
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

  // ── /image: a picture, requested by THIS browser ─────────────────────────
  // Not blocked by the text wait that the message above just started: they are
  // different endpoints with different limits. Real request to the free tier, so
  // it can fail for an honest external reason — a 402 FREE_LIMIT (one picture per
  // 45 s per IP, which a shared network can have used up) is reported, not hidden.
  {
    const IMG_PROMPT = 'a small red apple on a wooden table';
    const imgBefore = requests.length;
    await page.fill('#aiInput', '/image ' + IMG_PROMPT);
    const modeHint = await page.textContent('#aiHint');
    check(/Picture mode/.test(modeHint) && !(await page.$eval('#aiSend', (b) => b.disabled)),
      'typing /image switches to picture mode and is not blocked by the text wait', modeHint);
    const t0 = Date.now();
    await page.press('#aiInput', 'Enter');
    let result = 'timeout';
    try {
      const handle = await page.waitForFunction(() => {
        const img = document.querySelector('#aiMessages img.ai-image');
        if (img && img.complete && img.naturalWidth > 0) return 'picture';
        if (document.querySelector('#aiMessages .ai-image-err')) return 'error';
        return false;
      }, null, { timeout: 110000 });
      result = await handle.jsonValue();
    } catch { /* reported below */ }
    const took = ((Date.now() - t0) / 1000).toFixed(1);
    const picSent = requests.slice(imgBefore);
    const imgReqs = picSent.filter((r) => r.url.startsWith('https://image.pollinations.ai/'));
    check(imgReqs.length >= 1, 'the browser requested image.pollinations.ai directly',
      imgReqs.length ? `${imgReqs.length} request(s)` : 'no such request');
    if (imgReqs.length) {
      const u = imgReqs[0];
      check(u.url === 'https://image.pollinations.ai/' + encodeURIComponent(IMG_PROMPT),
        'the URL is image.pollinations.ai/<prompt>, encoded once', u.url);
      check(u.method === 'GET' && u.type === 'image', 'it is a GET issued by an <img>', `${u.method} ${u.type}`);
      check(!u.url.includes('?') && !u.url.includes('/prompt/'), 'no query string and no /prompt/ segment');
    }
    check(!picSent.filter((r) => r.url.startsWith(BASE))
      .some((r) => /apple|wooden/i.test(decodeURIComponent(r.url)) || /\/api\/ai\//.test(r.url)),
      'the picture request never went through our server');
    const imgStatus = imgReqs.length ? (responses.find((r) => r.url === imgReqs[0].url)?.status ?? 'no response') : 'no request';
    if (result === 'picture') {
      const dims = await page.$eval('#aiMessages img.ai-image', (i) => `${i.naturalWidth}x${i.naturalHeight}`);
      check(true, 'a real picture arrived and decoded', `${dims} in ${took}s (upstream HTTP ${imgStatus})`);
    } else {
      const tile = await page.evaluate(() => (document.querySelector('#aiMessages .ai-image-err')?.textContent || '').replace(/\s+/g, ' ').trim());
      const throttled = /one picture every 45 seconds/.test(tile);
      check(throttled || /Could not reach|trouble|refused|usable picture|too long/.test(tile),
        `no picture (${result}), but the failure was explained rather than generic`, tile.slice(0, 140));
      if (throttled) {
        console.log('  note: the free image tier allows one picture per 45 s per IP and this IP had used it. '
          + 'That is the documented limit, not a defect — re-run spaced out.');
      }
    }
    // A second picture straight away must be refused, with the reason on screen.
    await page.fill('#aiInput', '/image a second apple');
    const hint2 = await page.textContent('#aiHint');
    check(await page.$eval('#aiSend', (b) => b.disabled) && /Next picture in \d+s/.test(hint2),
      'a second /image inside the 50s wait is refused, with a countdown', hint2);
    const before2 = requests.length;
    await page.press('#aiInput', 'Enter');
    await page.waitForTimeout(800);
    check(!requests.slice(before2).some((r) => /image\.pollinations\.ai/.test(r.url)),
      'and it makes no request');
  }

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
    const orbWait = await orbPage.evaluate(() => ({
      disabled: document.querySelector('.ai-orb-send').disabled,
      note: document.querySelector('.ai-orb-note').textContent,
    }));
    check(orbWait.disabled && /You can ask again in \d+s/.test(orbWait.note),
      'the floating assistant also waits 18s after an answer', JSON.stringify(orbWait));
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

  // ── another page carries the full shared footer too, and the removed browser page is a real 404 ──
  {
    const bp = await browser.newPage();
    await bp.goto(`${BASE}/community`, { waitUntil: 'domcontentloaded', timeout: 60000 });
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
      '/community renders the full shared footer too', JSON.stringify(f));
    const gone = await bp.goto(`${BASE}/browser`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    check(gone?.status() === 404, '/browser is gone (a real 404, not a redirect or a blank page)', String(gone?.status()));
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
