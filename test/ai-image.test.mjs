// /image: a picture from Pollinations, requested by the visitor's browser.
//
//     GET https://image.pollinations.ai/<url-encoded prompt>
//
// The same shape as the text request — the prompt after the final slash, encoded
// once, nothing appended. These tests pin the URL we build, the command parser,
// the loader and failure diagnosis (with injected fakes: no network, no DOM), and
// the absence of every path a prompt or a picture could take through our server.
//
// Static assertions run on CODE ONLY (comments stripped), for the same reason as
// test/ai-browser-direct.test.mjs: the removals and the rationale are explained in
// comments, and a grep that matches the explanation is not a finding.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  IMAGE_ENDPOINT, IMAGE_ORIGIN, IMAGE_TIMEOUT_MS, MAX_IMAGE_PROMPT_CHARS, IMAGE_USAGE,
  parseImageCommand, normalizeImagePrompt, buildImageUrl, loadImage, diagnoseImageFailure,
  describeImageFailure,
} from '../public/js/pollinations-image.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
function codeOnly(p) {
  let s = read(p);
  s = s.replace(/<!--[\s\S]*?-->/g, '');
  s = s.replace(/\/\*[\s\S]*?\*\//g, '');
  return s.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
}

// ───────────────────────────────────────────────────────────────────────────
describe('the URL: the prompt goes after the final slash', () => {
  test('the endpoint is exactly image.pollinations.ai', () => {
    assert.equal(IMAGE_ENDPOINT, 'https://image.pollinations.ai/');
    assert.equal(IMAGE_ORIGIN, 'https://image.pollinations.ai');
  });

  test('the prompt is appended directly to the base URL', () => {
    assert.equal(buildImageUrl('a red fox in the snow'), 'https://image.pollinations.ai/a%20red%20fox%20in%20the%20snow');
  });

  test('no /prompt/ segment, no query string, nothing appended', () => {
    const url = new URL(buildImageUrl('hello world'));
    assert.equal(url.pathname, '/hello%20world');
    assert.equal(url.search, '', 'a query string was added to the request');
    assert.equal(url.hash, '');
    assert.doesNotMatch(url.pathname, /^\/prompt\//);
  });

  test('the prompt is the WHOLE path — one segment, decoded back verbatim', () => {
    const prompt = 'a/b?c#d&e=f';
    const url = new URL(buildImageUrl(prompt));
    assert.equal(url.pathname.slice(1).includes('/'), false);
    assert.equal(url.search, '');
    assert.equal(decodeURIComponent(url.pathname.slice(1)), prompt);
  });

  test('the text and image URLs have the same shape', async () => {
    const { buildPromptUrl } = await import('../public/js/pollinations.js');
    const t = new URL(buildPromptUrl('a cat'));
    const i = new URL(buildImageUrl('a cat'));
    assert.equal(t.pathname, i.pathname);
    assert.equal(t.search, i.search);
    assert.notEqual(t.host, i.host);
  });
});

describe('encoding: exactly once, and lossless', () => {
  const CASES = {
    'spaces': 'a castle on a hill',
    'punctuation': 'A cat, wearing a hat! (really?) 50% sure',
    'accented Latin': 'un cafe a Paris, tres joli',
    'CJK': 'Ni hao, shi jie',
    'an emoji (surrogate pair)': 'a rocket ' + String.fromCodePoint(0x1f680) + ' over the sea',
    'URL delimiters': 'a?b&c=d#e/f',
    'a percent sign': '100% of 50%',
    'a plus sign': 'C++ and a + b',
    'an ampersand': 'Tom & Jerry',
    'quotes and backslash': `she said "hi" and 'bye' \\ ok`,
    'an existing escape sequence': 'already %20 encoded',
  };
  for (const [label, prompt] of Object.entries(CASES)) {
    test(`${label} survives the round trip`, () => {
      const decoded = decodeURIComponent(new URL(buildImageUrl(prompt)).pathname.slice(1));
      assert.equal(decoded, normalizeImagePrompt(prompt));
    });
  }

  test('a prompt is never DOUBLE-encoded', () => {
    assert.match(buildImageUrl('already %20 encoded'), /already%20%2520%20encoded/);
  });

  test('a space is never encoded as "+"', () => {
    assert.doesNotMatch(buildImageUrl('two words'), /\+/);
  });

  test('whitespace runs and newlines collapse to single spaces', () => {
    assert.equal(buildImageUrl('  a   cat\n\n sitting\t here '), 'https://image.pollinations.ai/a%20cat%20sitting%20here');
  });
});

describe('the destination cannot be moved by a prompt', () => {
  for (const hostile of [
    '../../etc/passwd', '//evil.example/x', 'https://evil.example/', '\\\\evil.example\\x',
    '@evil.example', '?redirect=https://evil.example', '#@evil.example', 'x\u0000y',
    'prompt/../../x', '%2e%2e%2f', 'a.jpg?download=1',
  ]) {
    test(`origin, path shape and query stay fixed for ${JSON.stringify(hostile)}`, () => {
      const url = new URL(buildImageUrl(hostile));
      assert.equal(url.origin, 'https://image.pollinations.ai');
      assert.equal(url.protocol, 'https:');
      assert.equal(url.username, '');
      assert.equal(url.password, '');
      assert.equal(url.search, '');
      assert.equal(url.hash, '');
      assert.equal(url.pathname.slice(1).includes('/'), false, 'the prompt became a second path segment');
    });
  }

  for (const dots of ['.', '..', ' . ']) {
    test(`a prompt of only dots (${JSON.stringify(dots)}) is refused, not resolved to the site root`, () => {
      // encodeURIComponent leaves "." and ".." alone and the URL parser resolves
      // them, which would request the provider's landing page instead of a picture.
      assert.throws(() => buildImageUrl(dots), (e) => e.code === 'empty-prompt');
    });
  }
});

describe('empty and oversized prompts', () => {
  for (const empty of ['', '   ', '\n\t ', null, undefined]) {
    test(`${JSON.stringify(empty)} is refused, not sent`, () => {
      assert.throws(() => buildImageUrl(empty), (e) => e.code === 'empty-prompt');
    });
  }

  test('an over-long prompt is clipped to the prompt budget, not rejected', () => {
    const url = buildImageUrl('x'.repeat(5000));
    const sent = decodeURIComponent(new URL(url).pathname.slice(1));
    assert.equal(sent.length, MAX_IMAGE_PROMPT_CHARS);
    assert.ok(url.length <= 2000, `the URL is ${url.length} characters`);
  });

  test('clipping never splits an emoji (a lone surrogate would crash encodeURIComponent)', () => {
    const emoji = String.fromCodePoint(0x1f680);
    const url = buildImageUrl(emoji.repeat(MAX_IMAGE_PROMPT_CHARS + 50));
    const sent = decodeURIComponent(new URL(url).pathname.slice(1));
    assert.equal(sent.includes('�'), false);
    assert.ok(Array.from(sent).every((c) => c === emoji), 'a surrogate pair was cut in half');
    assert.ok(url.length <= 2000);
  });

  test('worst-case multi-byte prompts still fit the URL budget', () => {
    const url = buildImageUrl('中'.repeat(MAX_IMAGE_PROMPT_CHARS));
    assert.ok(url.length <= 2000, `the URL is ${url.length} characters`);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('the /image command', () => {
  const ok = (text, prompt) => assert.deepEqual(parseImageCommand(text), { prompt });

  test('the basic form', () => ok('/image a red fox', 'a red fox'));
  test('case-insensitive', () => ok('/IMAGE A Red Fox', 'A Red Fox'));
  test('surrounding and repeated whitespace is tidied', () => ok('  /image    a   red   fox  ', 'a red fox'));
  test('a newline after the command counts as the separator', () => ok('/image\na red fox', 'a red fox'));
  test('the command alone is recognised, with an empty prompt (the caller shows usage)', () => {
    ok('/image', '');
    ok('/image   ', '');
  });

  for (const notACommand of [
    '/imagine a cat', '/images', '/image-gen cat', '/img a cat', '/draw a cat', 'image a cat',
    'please /image a cat', 'what does /image do?', '', '   ', null, undefined,
  ]) {
    test(`${JSON.stringify(notACommand)} is ordinary text`, () => assert.equal(parseImageCommand(notACommand), null));
  }

  test('the prompt is clipped by code points, not UTF-16 units', () => {
    const emoji = String.fromCodePoint(0x1f680);
    const { prompt } = parseImageCommand('/image ' + emoji.repeat(1000));
    assert.equal(Array.from(prompt).length, MAX_IMAGE_PROMPT_CHARS);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// A stand-in for `new Image()` that records what the loader does to it and lets
// the test decide how it ends.
function fakeImage() {
  const img = {
    naturalWidth: 1024, decoding: '', referrerPolicy: '', onload: null, onerror: null,
    attrs: { src: null }, srcWasSetBefore: {},
    removeAttribute(name) { delete this.attrs[name]; },
    set src(v) { this.attrs.src = v; this.srcWasSetBefore = { decoding: this.decoding, referrerPolicy: this.referrerPolicy }; },
    get src() { return this.attrs.src; },
  };
  return img;
}

describe('loadImage', () => {
  test('resolves with the very element that finished loading', async () => {
    const img = fakeImage();
    const p = loadImage('https://image.pollinations.ai/x', { createImage: () => img });
    img.onload();
    assert.equal(await p, img);
  });

  test('sets the privacy-relevant properties BEFORE the request starts', async () => {
    const img = fakeImage();
    const p = loadImage('https://image.pollinations.ai/x', { createImage: () => img });
    assert.equal(img.srcWasSetBefore.referrerPolicy, 'no-referrer', 'our page address would be sent as the referrer');
    assert.equal(img.srcWasSetBefore.decoding, 'async');
    assert.equal(img.src, 'https://image.pollinations.ai/x');
    img.onload();
    await p;
  });

  test('an error event rejects with image-failed', async () => {
    const img = fakeImage();
    const p = loadImage('https://image.pollinations.ai/x', { createImage: () => img });
    img.onerror();
    await assert.rejects(p, (e) => e.code === 'image-failed');
  });

  test('a zero-width "success" is a failure', async () => {
    const img = fakeImage();
    img.naturalWidth = 0;
    const p = loadImage('https://image.pollinations.ai/x', { createImage: () => img });
    img.onload();
    await assert.rejects(p, (e) => e.code === 'image-failed');
  });

  test('a stall times out and stops the request by dropping src', async () => {
    const img = fakeImage();
    const p = loadImage('https://image.pollinations.ai/x', { createImage: () => img, timeoutMs: 20 });
    await assert.rejects(p, (e) => e.code === 'timeout');
    assert.equal(img.attrs.src, undefined, 'the stalled request was left running');
  });

  test('aborting rejects with cancelled and stops the request', async () => {
    const img = fakeImage();
    const ac = new AbortController();
    const p = loadImage('https://image.pollinations.ai/x', { createImage: () => img, signal: ac.signal });
    ac.abort();
    await assert.rejects(p, (e) => e.code === 'cancelled');
    assert.equal(img.attrs.src, undefined);
  });

  test('an already-aborted signal never creates an image at all', async () => {
    const ac = new AbortController();
    ac.abort();
    let created = 0;
    await assert.rejects(
      loadImage('https://image.pollinations.ai/x', { signal: ac.signal, createImage: () => { created++; return fakeImage(); } }),
      (e) => e.code === 'cancelled');
    assert.equal(created, 0);
  });

  test('it settles once: a late load after a timeout changes nothing', async () => {
    const img = fakeImage();
    const p = loadImage('https://image.pollinations.ai/x', { createImage: () => img, timeoutMs: 10 });
    await assert.rejects(p, (e) => e.code === 'timeout');
    assert.equal(img.onload, null, 'handlers must be detached once settled');
    assert.equal(img.onerror, null);
  });

  test('the ceiling is generous enough for a slow free tier but finite', () => {
    assert.ok(IMAGE_TIMEOUT_MS >= 60_000 && IMAGE_TIMEOUT_MS <= 180_000, String(IMAGE_TIMEOUT_MS));
  });
});

// ───────────────────────────────────────────────────────────────────────────
// The 402 the live service sent on 2026-11-02 when the allowance was spent.
const FREE_LIMIT_BODY = JSON.stringify({
  status: 402, success: false,
  error: {
    code: 'FREE_LIMIT',
    message: 'Free limit reached: 1 image every 45 seconds per IP. Retry after 41s, or get unlimited images with a pollen key at https://enter.pollinations.ai/?ref=classic',
  },
});
const respond = (body, init) => async () => new Response(body, init);
const URL_UNDER_TEST = 'https://image.pollinations.ai/a%20red%20fox';

describe('diagnoseImageFailure', () => {
  test('402 FREE_LIMIT is a rate limit, and Retry-After wins', async () => {
    const r = await diagnoseImageFailure(URL_UNDER_TEST, {
      fetchImpl: respond(FREE_LIMIT_BODY, { status: 402, headers: { 'content-type': 'application/json', 'retry-after': '41' } }),
    });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'rate-limited');
    assert.equal(r.error.retryAfter, 41);
    assert.equal(r.error.rateLimited, true);
  });

  test('without a header, the seconds are read from the message', async () => {
    const r = await diagnoseImageFailure(URL_UNDER_TEST, {
      fetchImpl: respond(FREE_LIMIT_BODY.replace('41s', '9s'), { status: 402, headers: { 'content-type': 'application/json' } }),
    });
    assert.equal(r.error.code, 'rate-limited');
    assert.equal(r.error.retryAfter, 9);
  });

  test('with neither, it falls back to the full 45 second window', async () => {
    const r = await diagnoseImageFailure(URL_UNDER_TEST, {
      fetchImpl: respond('{"error":{"code":"FREE_LIMIT"}}', { status: 402 }),
    });
    assert.equal(r.error.retryAfter, 45);
  });

  test('a 429 is also a rate limit', async () => {
    const r = await diagnoseImageFailure(URL_UNDER_TEST, { fetchImpl: respond('slow down', { status: 429 }) });
    assert.equal(r.error.code, 'rate-limited');
  });

  test('a ridiculous Retry-After is capped at two minutes', async () => {
    const r = await diagnoseImageFailure(URL_UNDER_TEST, {
      fetchImpl: respond('{}', { status: 402, headers: { 'retry-after': '86400' } }),
    });
    assert.equal(r.error.retryAfter, 120);
  });

  test('if the request works this time, the picture is handed back instead of thrown away', async () => {
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
    const r = await diagnoseImageFailure(URL_UNDER_TEST, {
      fetchImpl: respond(bytes, { status: 200, headers: { 'content-type': 'image/jpeg' } }),
    });
    assert.equal(r.ok, true);
    assert.equal(r.blob.size, bytes.length);
  });

  test('a 200 that is not a picture is reported as such', async () => {
    const r = await diagnoseImageFailure(URL_UNDER_TEST, {
      fetchImpl: respond('<html>landing page</html>', { status: 200, headers: { 'content-type': 'text/html' } }),
    });
    assert.equal(r.error.code, 'unexpected-response');
  });

  test('an empty picture is a failure', async () => {
    const r = await diagnoseImageFailure(URL_UNDER_TEST, {
      fetchImpl: respond('', { status: 200, headers: { 'content-type': 'image/jpeg' } }),
    });
    assert.equal(r.error.code, 'image-failed');
  });

  test('a 5xx names its status', async () => {
    const r = await diagnoseImageFailure(URL_UNDER_TEST, { fetchImpl: respond('boom', { status: 503 }) });
    assert.equal(r.error.code, 'http');
    assert.equal(r.error.status, 503);
  });

  test('a request that never gets an answer is "offline"', async () => {
    const r = await diagnoseImageFailure(URL_UNDER_TEST, { fetchImpl: async () => { throw new TypeError('Failed to fetch'); } });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'offline');
  });

  const hangs = (_url, { signal }) => new Promise((_, reject) => {
    signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
  });

  test('a service that never answers times out', async () => {
    const r = await diagnoseImageFailure(URL_UNDER_TEST, { fetchImpl: hangs, timeoutMs: 20 });
    assert.equal(r.error.code, 'timeout');
  });

  test('the caller can cancel it', async () => {
    const ac = new AbortController();
    const p = diagnoseImageFailure(URL_UNDER_TEST, { fetchImpl: hangs, signal: ac.signal, timeoutMs: 5000 });
    ac.abort();
    assert.equal((await p).error.code, 'cancelled');
  });

  test('it never throws, whatever the transport does', async () => {
    for (const fetchImpl of [async () => { throw new Error('x'); }, async () => { throw 'a string'; }, async () => null]) {
      await assert.doesNotReject(async () => { await diagnoseImageFailure(URL_UNDER_TEST, { fetchImpl }); });
    }
  });

  test('the request is a plain, credential-free, referrer-free CORS GET with no custom headers', async () => {
    let seen;
    await diagnoseImageFailure(URL_UNDER_TEST, {
      fetchImpl: async (url, init) => { seen = { url, init }; return new Response('x', { status: 500 }); },
    });
    assert.equal(seen.url, URL_UNDER_TEST, 'the diagnostic request must go to the exact same URL');
    assert.equal(seen.init.method, 'GET');
    assert.equal(seen.init.mode, 'cors');
    assert.equal(seen.init.credentials, 'omit');
    assert.equal(seen.init.referrerPolicy, 'no-referrer');
    assert.equal(seen.init.headers, undefined, 'a custom header would force a CORS preflight');
  });
});

describe('describeImageFailure', () => {
  test('a rate limit names the 45 second window and the wait', () => {
    const msg = describeImageFailure({ code: 'rate-limited', retryAfter: 41 });
    assert.match(msg, /45 seconds/);
    assert.match(msg, /41 more seconds/);
    assert.match(msg, /network/i, 'a shared school network is the likely cause and should be named');
  });
  test('a rate limit without a number still reads correctly', () => {
    const msg = describeImageFailure({ code: 'rate-limited' });
    assert.match(msg, /45 seconds/);
    assert.doesNotMatch(msg, /undefined|NaN|0 more/);
  });
  test('an empty prompt gets the usage line', () => assert.equal(describeImageFailure({ code: 'empty-prompt' }), IMAGE_USAGE));
  test('the usage line shows the command', () => assert.match(IMAGE_USAGE, /\/image /));
  for (const [code, re] of [['timeout', /too long/], ['offline', /Could not reach/], ['image-failed', /usable picture/], ['unexpected-response', /usable picture/]]) {
    test(`${code} has its own message`, () => assert.match(describeImageFailure({ code }), re));
  }
  test('an HTTP failure names its status; 5xx reads as trouble on their side', () => {
    assert.match(describeImageFailure({ code: 'http', status: 503 }), /503/);
    assert.match(describeImageFailure({ code: 'http', status: 503 }), /trouble/);
    assert.match(describeImageFailure({ code: 'http', status: 404 }), /refused/);
  });
  test('junk never throws and never returns nothing', () => {
    for (const junk of [undefined, null, {}, { code: 'nope' }, 42, 'x']) {
      assert.ok(describeImageFailure(junk).length > 10);
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('a prompt or a picture never passes through our server', () => {
  const clientFiles = readdirSync(join(ROOT, 'public', 'js')).filter((f) => f.endsWith('.js'));

  test('image.pollinations.ai appears in exactly ONE client module', () => {
    const hits = clientFiles.filter((f) => /image\.pollinations\.ai/.test(codeOnly(`public/js/${f}`)));
    assert.deepEqual(hits, ['pollinations-image.js'],
      'the image host must be known to one file only, so there is one place to audit');
  });

  test('the image module never talks to our own origin', () => {
    const code = codeOnly('public/js/pollinations-image.js');
    assert.doesNotMatch(code, /['"`]\/api\//, 'pollinations-image.js references a same-origin API route');
    assert.doesNotMatch(code, /location\.(origin|host)/);
    assert.doesNotMatch(code, /XMLHttpRequest|sendBeacon|WebSocket/);
  });

  test('the image module holds no key, token or Authorization header', () => {
    const code = codeOnly('public/js/pollinations-image.js');
    assert.doesNotMatch(code, /['"`]sk_|['"`]pk_|Authorization|[?&]token=|[?&]key=/i);
  });

  test('every request it makes is credential-free and never "no-cors"', () => {
    const code = codeOnly('public/js/pollinations-image.js');
    assert.match(code, /credentials:\s*'omit'/);
    assert.doesNotMatch(code, /no-cors/, 'no-cors would make the response unreadable and hide the failure');
  });

  test('the chat page makes no fetch of its own for pictures', () => {
    const code = codeOnly('public/js/pollichat.js');
    assert.doesNotMatch(code, /\bfetch\s*\(/, 'pollichat.js fetches something directly');
    assert.match(code, /loadImage\(/);
    assert.match(code, /buildImageUrl\(/);
  });

  test('a saved chat stores the prompt, never an image URL', () => {
    const code = codeOnly('public/js/pollichat.js');
    assert.doesNotMatch(code, /imageUrl|\.src\s*=\s*m\./, 'a URL read back from storage would reach an <img> src');
    // The restore path rebuilds the URL from the prompt through the origin-checked builder.
    assert.match(code, /href = buildImageUrl\(m\.content\)/);
  });

  test('picture messages are kept out of the text model\'s conversation', () => {
    const code = codeOnly('public/js/pollichat.js');
    assert.match(code, /m\.content && m\.kind !== 'image'/);
  });

  test('the server has no image route and no copy of the host', () => {
    // Whole-line // comments stripped only: server.js has route patterns such as
    // '/embed/*' that make a block-comment stripper swallow real code.
    const server = read('server.js').split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
    assert.doesNotMatch(server, /image\.pollinations\.ai/);
    assert.doesNotMatch(server, /app\.(get|post|all|use)\(\s*\[?\s*['"`]\/api\/ai\/image/,
      'a server image route would pipe picture bytes through our host');
  });

  test('the CSP already lets the page show an https image, and is not widened for this', () => {
    // Raw source, not codeOnly(): server.js contains route patterns like '/embed/*'
    // whose "/*" a naive comment-stripper would take for the start of a block comment.
    const imgSrc = read('server.js').match(/^\s*imgSrc:\s*\[[^\]]*\]/m)?.[0] || '';
    assert.match(imgSrc, /'https:'/, 'img-src must allow https: for the picture to render');
    assert.doesNotMatch(imgSrc, /\*|image\.pollinations/, 'img-src should not be loosened or special-cased');
  });

  test('the picture is shown as a real <img> pointed at the provider, with the prompt as text', () => {
    const code = codeOnly('public/js/pollichat.js');
    assert.match(code, /alt:\s*m\.content/);
    assert.match(code, /referrerpolicy:\s*'no-referrer'/);
    assert.match(code, /rel:\s*'noopener noreferrer'/);
    // textContent / text nodes only for anything the visitor typed or the provider sent.
    const painter = code.match(/function paintImageCard[\s\S]*?\n\}\n/)?.[0] || '';
    assert.doesNotMatch(painter, /innerHTML/, 'the picture card must never be built from markup');
  });
});

describe('the page and the policies tell the truth about it', () => {
  test('the AI page advertises /image and says who makes the picture', () => {
    const html = codeOnly('public/pollichat.html');
    assert.match(html, /\/image/);
    assert.match(read('public/js/pollichat.js'), /Made by Pollinations/);
  });

  test('the privacy policy names the image host and says Pollinations receives the description', () => {
    const privacy = read('legal/privacy.html');
    assert.match(privacy, /image\.pollinations\.ai/);
    // \s+ between words: the policy is hand-wrapped HTML, so a phrase can span lines.
    assert.match(privacy, /Pollinations itself receives your picture\s+description/);
  });

  test('the terms describe pictures as an opt-in command, and still rule out audio and video', () => {
    const terms = read('legal/terms.html');
    assert.match(terms, /<code>\/image<\/code>/);
    assert.doesNotMatch(terms, /generates <strong>text only<\/strong>/);
    assert.match(terms, /does not generate audio or\s+video/);
  });

  test('the cookie policy documents the wait this feature stores', () => {
    const cookies = read('legal/cookies.html');
    assert.match(cookies, /zofhub:ai:cooldown:v1/);
  });
});
