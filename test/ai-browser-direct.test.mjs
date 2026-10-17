// The AI is ONE request, made by the visitor's browser:
//
//     GET https://text.pollinations.ai/<url-encoded prompt>
//
// These tests pin the two things that can silently break that: the URL we build
// (where the prompt goes, and how it is encoded), and the absence of every
// alternative path a prompt could take instead — a server route, a local
// inference engine, a second provider, an image endpoint.
//
// The static assertions below run against CODE ONLY. The removals deliberately
// left explanatory comments behind, so a naive grep for an old name matches the
// explanation as readily as a regression. codeOnly() strips comments first;
// anything that survives is something the browser actually executes or renders.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ENDPOINT, TIMEOUT_MS, buildPromptUrl, composePrompt, fitToUrlBudget, askAI, askPrompt,
  describeFailure,
} from '../public/js/pollinations.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

function codeOnly(p) {
  let s = read(p);
  s = s.replace(/<!--[\s\S]*?-->/g, '');                             // HTML comments
  s = s.replace(/\/\*[\s\S]*?\*\//g, '');                            // JS block comments
  s = s.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');   // JS line comments
  return s;
}

const CLIENT_FILES = ['public/js/pollinations.js', 'public/js/ai.js', 'public/js/ai-helper.js'];

// ───────────────────────────────────────────────────────────────────────────
describe('the URL: the prompt goes after the final slash', () => {
  test('the endpoint is exactly the one specified', () => {
    assert.equal(ENDPOINT, 'https://text.pollinations.ai/');
  });

  test('the prompt is appended directly to the base URL', () => {
    assert.equal(
      buildPromptUrl('Explain how solar panels work'),
      'https://text.pollinations.ai/Explain%20how%20solar%20panels%20work',
    );
  });

  test('no query string, no extra path segment, nothing appended', () => {
    const url = new URL(buildPromptUrl('hello world'));
    assert.equal(url.search, '', 'a query string was added to the request');
    assert.equal(url.hash, '');
    assert.equal(url.pathname, '/hello%20world');
  });

  test('the prompt is the WHOLE path — one segment, decoded back verbatim', () => {
    const prompt = 'a/b?c#d&e=f';
    const url = new URL(buildPromptUrl(prompt));
    // The encoded form contains no raw delimiter, so the path is one segment...
    assert.equal(url.pathname.slice(1).includes('/'), false);
    assert.equal(url.search, '');
    // ...and decoding that one segment returns exactly what was typed.
    assert.equal(decodeURIComponent(url.pathname.slice(1)), prompt);
  });
});

describe('encoding: exactly once, and lossless', () => {
  // Each prompt must survive the round trip unchanged. That is the real
  // requirement; the specific escapes are an implementation detail.
  const CASES = {
    'spaces': 'how do solar panels work',
    'punctuation': 'What is 2+2? Really — 50% sure, right?! (yes/no)',
    'a newline': 'line one\nline two',
    'CRLF and tabs': 'a\r\n\tb',
    'accented Latin': 'Comment ca va, naive cafe? Zuruck!',
    'non-Latin script': 'Privet, kak dela',
    'CJK': 'Ni hao, shi jie',
    'an emoji (surrogate pair)': 'rocket ' + String.fromCodePoint(0x1f680) + ' go',
    'URL delimiters': 'a?b&c=d#e/f',
    'a percent sign': '100% of 50%',
    'a plus sign': 'C++ and a + b',
    'an ampersand': 'Tom & Jerry',
    'quotes and backslash': `she said "hi" and 'bye' \\ ok`,
    'an existing escape sequence': 'already %20 encoded',
  };

  for (const [label, prompt] of Object.entries(CASES)) {
    test(`${label} survives the round trip`, () => {
      const url = buildPromptUrl(prompt);
      const decoded = decodeURIComponent(new URL(url).pathname.slice(1));
      assert.equal(decoded, prompt, `${label} was corrupted in the URL`);
    });
  }

  test('a prompt is never DOUBLE-encoded', () => {
    // '%20' typed by a user must come back as '%20', not as a space. If the
    // prompt were encoded twice, one decode would leave '%2520'.
    const url = buildPromptUrl('already %20 encoded');
    assert.match(url, /already%20%2520%20encoded/);
    assert.equal(decodeURIComponent(new URL(url).pathname.slice(1)), 'already %20 encoded');
  });

  test('a space is never encoded as "+"', () => {
    // '+' is a space only in a query string. This is a PATH, where '+' is a
    // literal plus — so encoding a space as '+' would change the prompt.
    assert.doesNotMatch(buildPromptUrl('two words'), /\+/);
  });
});

describe('the destination cannot be moved by a prompt', () => {
  for (const hostile of [
    '../../etc/passwd',
    '//evil.example/x',
    'https://evil.example/',
    '\\\\evil.example\\x',
    '@evil.example',
    '?redirect=https://evil.example',
    '#@evil.example',
    'x\u0000y',
  ]) {
    test(`origin stays fixed for ${JSON.stringify(hostile)}`, () => {
      const url = new URL(buildPromptUrl(hostile));
      assert.equal(url.origin, 'https://text.pollinations.ai');
      assert.equal(url.host, 'text.pollinations.ai');
      assert.equal(url.protocol, 'https:');
      assert.equal(url.username, '');
      assert.equal(url.password, '');
    });
  }
});

describe('empty and oversized prompts', () => {
  for (const empty of ['', '   ', '\n\t ', null, undefined]) {
    test(`${JSON.stringify(empty)} is refused, not sent`, () => {
      assert.throws(() => buildPromptUrl(empty), (e) => e.code === 'empty-prompt');
    });
  }

  test('a very long prompt is trimmed to fit the URL budget', () => {
    const url = buildPromptUrl('word '.repeat(5000));
    assert.ok(url.length <= 6000, `URL was ${url.length} chars — over the budget`);
    assert.ok(url.length > 1000, 'the prompt was trimmed to almost nothing');
  });

  test('trimming never splits a surrogate pair', () => {
    // String.prototype.slice can cut an emoji in half, and encodeURIComponent
    // throws URIError on a lone surrogate — so a naive trim turns a long prompt
    // containing an emoji into a crash instead of a short prompt.
    const emoji = String.fromCodePoint(0x1f680);
    for (const n of [900, 1500, 1999, 2000, 2001, 4000]) {
      const prompt = emoji.repeat(n);
      assert.doesNotThrow(() => buildPromptUrl(prompt), `${n} emoji threw`);
      const decoded = decodeURIComponent(new URL(buildPromptUrl(prompt)).pathname.slice(1));
      // Every surviving code point must be a WHOLE emoji. Checking for the
      // surrogate RANGE would be wrong: a valid astral character IS a surrogate
      // pair, so a correct result matches that range too.
      assert.ok(Array.from(decoded).every((ch) => ch === emoji),
        'the trim produced a half character');
      assert.ok(prompt.startsWith(decoded), 'the trim changed the text, not just its length');
    }
  });

  test('fitToUrlBudget returns the largest prefix that fits', () => {
    assert.equal(fitToUrlBudget('abc', 100), 'abc');       // already fits
    assert.equal(fitToUrlBudget('abcdef', 3), 'abc');       // plain ASCII
    assert.equal(fitToUrlBudget('', 100), '');
    // A space encodes to 3 chars, so a budget of 3 holds exactly one space.
    assert.equal(fitToUrlBudget('  ', 3), ' ');
  });
});

describe('composePrompt: context folded into one string', () => {
  test('the system prompt leads, and the transcript follows in order', () => {
    const out = composePrompt([
      { role: 'system', content: 'SYSTEM-RULES' },
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'second' },
      { role: 'user', content: 'third' },
    ]);
    assert.ok(out.startsWith('SYSTEM-RULES'));
    assert.ok(out.indexOf('User: first') < out.indexOf('Assistant: second'));
    assert.ok(out.indexOf('Assistant: second') < out.indexOf('User: third'));
    assert.ok(out.endsWith('Assistant:'), 'the model should be cued to continue');
  });

  test('the site system prompt is applied when the caller omits one', () => {
    const out = composePrompt([{ role: 'user', content: 'hi' }]);
    assert.match(out, /ZoFHub AI/, 'the shared grounding prompt was not applied');
  });

  test('history is bounded, keeping the MOST RECENT turns', () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ role: 'user', content: `m${i}` }));
    const out = composePrompt(many);
    assert.match(out, /m39/, 'the newest turn was dropped');
    assert.doesNotMatch(out, /\bm0\b/, 'an ancient turn survived the bound');
  });

  test('junk input does not throw', () => {
    for (const junk of [null, undefined, 'nope', 42, [null, 7, {}, { role: 'user' }]]) {
      assert.doesNotThrow(() => composePrompt(junk));
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// askAI against a stubbed fetch. These assert the CONTRACT the UI relies on:
// what is requested, how the body is read, and what each failure looks like.
describe('askAI: the request it actually makes', () => {
  const withFetch = async (impl, fn) => {
    const original = globalThis.fetch;
    const calls = [];
    globalThis.fetch = (url, init) => { calls.push({ url, init }); return impl(url, init); };
    try { return await fn(calls); } finally { globalThis.fetch = original; }
  };

  const textResponse = (body, init = {}) => new Response(body, {
    status: init.status ?? 200,
    headers: { 'content-type': init.contentType ?? 'text/plain; charset=utf-8', ...(init.headers || {}) },
  });

  test('it GETs the prompt URL, with cors and no custom headers', async () => {
    await withFetch(() => Promise.resolve(textResponse('the answer')), async (calls) => {
      const out = await askAI('hello there');
      assert.equal(out, 'the answer');
      assert.equal(calls.length, 1, 'exactly one request should be made');
      assert.equal(calls[0].url, 'https://text.pollinations.ai/hello%20there');
      assert.equal(calls[0].init.method, 'GET');
      // 'no-cors' would make the body unreadable and hide the failure.
      assert.equal(calls[0].init.mode, 'cors');
      assert.equal(calls[0].init.credentials, 'omit');
      // A custom header would force a CORS preflight before the real request.
      assert.equal(calls[0].init.headers, undefined);
      assert.equal(calls[0].init.body, undefined);
    });
  });

  test('the body is read as TEXT, not parsed as JSON', async () => {
    // A plain-text answer that merely looks like JSON must come back verbatim.
    const looksLikeJson = '{"this": "is the literal answer text"}';
    await withFetch(() => Promise.resolve(textResponse(looksLikeJson)), async () => {
      assert.equal(await askAI('q'), looksLikeJson);
    });
  });

  test('a <think> block is stripped from the answer', async () => {
    await withFetch(() => Promise.resolve(textResponse('<think>musing</think>Real answer.')), async () => {
      assert.equal(await askAI('q'), 'Real answer.');
    });
  });

  test('an OpenAI-shaped JSON answer is unwrapped (content type decides)', async () => {
    const envelope = JSON.stringify({ choices: [{ message: { content: 'unwrapped' } }] });
    await withFetch(() => Promise.resolve(textResponse(envelope, { contentType: 'application/json' })), async () => {
      assert.equal(await askAI('q'), 'unwrapped');
    });
  });

  test('a JSON error object is reported, never rendered as an answer', async () => {
    const body = JSON.stringify({ error: { message: 'model is overloaded' } });
    await withFetch(() => Promise.resolve(textResponse(body, { contentType: 'application/json' })), async () => {
      await assert.rejects(askAI('q'), (e) => {
        assert.equal(e.code, 'unexpected-response');
        assert.match(e.message, /overloaded/);
        return true;
      });
    });
  });

  test('an empty body is a failure, not an empty reply', async () => {
    for (const body of ['', '   ', '\n']) {
      await withFetch(() => Promise.resolve(textResponse(body)), async () => {
        await assert.rejects(askAI('q'), (e) => e.code === 'empty-answer');
      });
    }
  });

  test('an HTTP error carries its status', async () => {
    await withFetch(() => Promise.resolve(textResponse('nope', { status: 503 })), async () => {
      await assert.rejects(askAI('q'), (e) => {
        assert.equal(e.code, 'http');
        assert.equal(e.status, 503);
        assert.equal(e.rateLimited, undefined);
        return true;
      });
    });
  });

  test('429 is typed as a rate limit and honours Retry-After', async () => {
    await withFetch(() => Promise.resolve(textResponse('slow down', {
      status: 429, headers: { 'retry-after': '42' },
    })), async () => {
      await assert.rejects(askAI('q'), (e) => {
        assert.equal(e.rateLimited, true);
        assert.equal(e.retryAfter, 42);
        return true;
      });
    });
  });

  test('429 without Retry-After falls back to the documented window', async () => {
    await withFetch(() => Promise.resolve(textResponse('slow down', { status: 429 })), async () => {
      await assert.rejects(askAI('q'), (e) => e.rateLimited === true && e.retryAfter === 15);
    });
  });

  test('a network failure is "offline", and keeps the cause', async () => {
    const boom = new TypeError('Failed to fetch');
    await withFetch(() => Promise.reject(boom), async () => {
      await assert.rejects(askAI('q'), (e) => {
        assert.equal(e.code, 'offline');
        assert.equal(e.cause, boom);
        return true;
      });
    });
  });

  test('it never retries on its own — one send is one request', async () => {
    await withFetch(() => Promise.reject(new TypeError('Failed to fetch')), async (calls) => {
      await assert.rejects(askAI('q'));
      assert.equal(calls.length, 1, 'a retry loop would multiply load on a failing endpoint');
    });
  });

  test('a timeout aborts the request and is typed as such', async () => {
    // Never resolves until aborted — exactly what a hung endpoint looks like.
    const hang = (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    });
    await withFetch(hang, async () => {
      await assert.rejects(askAI('q', { timeoutMs: 25 }), (e) => {
        assert.equal(e.code, 'timeout');
        assert.match(e.message, /longer than/);
        return true;
      });
    });
  });

  test('a stall DURING the body read is still typed as a timeout', async () => {
    // The endpoint sends headers first and can then stall mid-answer. Before
    // this was handled the abort escaped as a bare AbortError with no .code,
    // and the UI showed its generic message instead of saying it timed out.
    const stallingBody = (_url, init) => Promise.resolve(new Response(
      new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode('partial'));
          init.signal.addEventListener('abort', () => c.error(new DOMException('Aborted', 'AbortError')));
        },
      }),
      { status: 200, headers: { 'content-type': 'text/plain' } },
    ));
    await withFetch(stallingBody, async () => {
      await assert.rejects(askAI('q', { timeoutMs: 30 }), (e) => {
        assert.equal(e.code, 'timeout');
        return true;
      });
    });
  });

  test('a caller-cancelled request is "cancelled", not an error to show', async () => {
    const hang = (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    });
    const ctrl = new AbortController();
    await withFetch(hang, async () => {
      const p = askAI('q', { signal: ctrl.signal });
      ctrl.abort();
      await assert.rejects(p, (e) => e.code === 'cancelled');
    });
  });

  test('a signal already aborted never reaches the network', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    await withFetch(() => { throw new Error('fetch must not be called'); }, async (calls) => {
      await assert.rejects(askAI('q', { signal: ctrl.signal }), (e) => e.code === 'cancelled');
      assert.equal(calls.length, 0, 'a cancelled request still hit the network');
    });
  });

  test('askPrompt applies the system prompt and still sends one GET', async () => {
    await withFetch(() => Promise.resolve(textResponse('ok')), async (calls) => {
      const { text } = await askPrompt('tips for this game');
      assert.equal(text, 'ok');
      assert.equal(calls.length, 1);
      const decoded = decodeURIComponent(new URL(calls[0].url).pathname.slice(1));
      assert.match(decoded, /ZoFHub AI/, 'the grounding prompt was not sent');
      assert.match(decoded, /tips for this game/);
    });
  });

  test('onStatus reports progress before the request resolves', async () => {
    const seen = [];
    await withFetch(() => Promise.resolve(textResponse('ok')), async () => {
      await askAI('q', { onStatus: (s) => seen.push(s) });
    });
    assert.ok(seen.length > 0, 'the UI was given no progress signal');
  });

  test('the request budget is a single bounded value', () => {
    assert.ok(Number.isFinite(TIMEOUT_MS) && TIMEOUT_MS > 0);
    // The bug this replaced was a CHAIN of budgets (15s connect + 45s first byte
    // + 45s fallback + backoff) that let one message hang for over a minute.
    assert.ok(TIMEOUT_MS <= 90000, 'one request should not be allowed to hang this long');
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('the browser talks to Pollinations, and nothing else does', () => {
  test('no client file posts a prompt to our own server', () => {
    for (const f of CLIENT_FILES) {
      const code = codeOnly(f);
      assert.doesNotMatch(code, /['"`]\/api\/ai\//,
        `${f} still references a same-origin AI endpoint — the prompt must not pass through our server`);
    }
  });

  test('only the shared client names the endpoint', () => {
    // Two places building this URL is how one of them drifts.
    for (const f of ['public/js/ai.js', 'public/js/ai-helper.js']) {
      assert.doesNotMatch(codeOnly(f), /text\.pollinations\.ai/,
        `${f} builds its own request instead of using the shared client`);
    }
    assert.match(codeOnly('public/js/pollinations.js'), /text\.pollinations\.ai/);
  });

  test('both AI entry points import the SAME client instance', () => {
    // A module specifier is cache-keyed by its full URL, so two different ?v=
    // values load pollinations.js twice as two independent instances.
    const versionOf = (f) => codeOnly(f).match(/\.\/pollinations\.js(\?v=[\w.-]+)?/)?.[1] ?? null;
    const a = versionOf('public/js/ai.js');
    const b = versionOf('public/js/ai-helper.js');
    assert.ok(a !== null && b !== null, 'an AI entry point does not import the shared client');
    assert.equal(a, b, 'the two entry points import pollinations.js at different ?v= versions');
  });

  test('mode: no-cors is never used', () => {
    // An opaque response cannot be read, so this would turn a visible failure
    // into a silent blank reply.
    for (const f of CLIENT_FILES) {
      assert.doesNotMatch(codeOnly(f), /no-cors/, `${f} uses mode: no-cors`);
    }
  });

  test('no server-side AI generation route survives', () => {
    const server = codeOnly('server.js');
    for (const route of ['/api/ai/text', '/api/ai/echo', '/api/ai/image',
                         '/api/ai/audio', '/api/ai/video', '/api/ai/key',
                         '/api/ai/providers', '/api/ai/health']) {
      assert.doesNotMatch(server, new RegExp(`app\\.(get|post|put|all|use)\\(\\s*['"\`]${route.replace(/\//g, '\\/')}`),
        `server.js still registers a handler on ${route}`);
    }
  });

  test('the server never calls an inference endpoint itself', () => {
    const server = codeOnly('server.js');
    assert.doesNotMatch(server, /fetch\(\s*[`'"]https:\/\/(text|image|gen)\.pollinations\.ai/,
      'server.js makes an outbound Pollinations request');
    // The Vibe Finder's optional refinement was the one path outside /api/ai/*.
    assert.doesNotMatch(server, /vibeKeywordsFromAI\s*\(/,
      'the Vibe Finder still calls out to an AI from the server');
  });

  test('the server-side generation pipeline modules are deleted', () => {
    for (const f of ['lib/ai-pipeline.mjs', 'lib/ai-providers.mjs']) {
      assert.equal(existsSync(join(ROOT, f)), false, `${f} still exists`);
    }
  });

  test('the removed-route guard is kept as a regression guard', async () => {
    // The routes are gone; their paths must still be refused, so that re-adding
    // a handler on one of them cannot ship ungated.
    const { AI_FALLBACK_ROUTES, aiServerAllowed } = await import('../lib/ai-guard.mjs');
    assert.ok(AI_FALLBACK_ROUTES.includes('/api/ai/text'));
    assert.equal(aiServerAllowed({ nodeEnv: 'production', ip: '127.0.0.1' }), false);
  });
});

describe('no local inference engine', () => {
  test('nothing downloads a model into the browser', () => {
    for (const f of CLIENT_FILES) {
      const code = codeOnly(f);
      assert.doesNotMatch(code, /@huggingface\/transformers/, `${f} loads Transformers.js`);
      assert.doesNotMatch(code, /SmolLM|onnx|webgpu|TextStreamer/i, `${f} still has on-device inference`);
    }
  });

  test('the AI page loads no inference library', () => {
    assert.doesNotMatch(codeOnly('public/ai.html'), /transformers|onnxruntime|webllm/i);
  });

  test('no second AI provider is imported anywhere', () => {
    for (const f of [...CLIENT_FILES, 'public/ai.html']) {
      const code = codeOnly(f);
      assert.doesNotMatch(code, /puter/i, `${f} references Puter.js`);
      assert.doesNotMatch(code, /huggingface|hf-inference|hf-models/i, `${f} references Hugging Face`);
    }
  });

  test('the removed provider modules are really gone', () => {
    for (const f of ['public/js/puter-ai.js', 'public/js/ai-provider.js', 'public/js/ai-settings.js',
                     'public/js/hf-inference.js', 'public/js/hf-models.js']) {
      assert.equal(existsSync(join(ROOT, f)), false, `${f} still exists`);
    }
  });

  test('the provider dependencies went with them', () => {
    const pkg = JSON.parse(read('package.json'));
    const deps = JSON.stringify({ ...pkg.dependencies, ...pkg.devDependencies });
    assert.doesNotMatch(deps, /@heyputer\/puter/);
    assert.doesNotMatch(deps, /@huggingface\//);
  });

  test('huggingface.co stays on the server-side DENYLIST', async () => {
    // Easy to delete by mistake while removing the provider — but this list is
    // what stops /asset and /thumb being used as an inference proxy, so dropping
    // the entry would OPEN a hole rather than close one.
    const { isAiProviderHost } = await import('../lib/ai-hosts.mjs');
    assert.equal(isAiProviderHost('api-inference.huggingface.co'), true);
    assert.equal(isAiProviderHost('text.pollinations.ai'), true);
  });
});

describe('a server secret can never reach the browser', () => {
  test('the client never names the key-bearing endpoint', () => {
    // gen.pollinations.ai requires `Authorization: Bearer sk_…`. Using it from a
    // page would mean shipping a secret or relaying every prompt through us.
    assert.doesNotMatch(codeOnly('public/js/pollinations.js'), /gen\.pollinations\.ai/);
  });

  test('no client file carries a key, a token or an Authorization header', () => {
    for (const f of CLIENT_FILES) {
      const code = codeOnly(f);
      assert.doesNotMatch(code, /['"`]sk_/, `${f} mentions a secret key prefix`);
      assert.doesNotMatch(code, /['"`]pk_/, `${f} mentions a publishable key prefix`);
      assert.doesNotMatch(code, /Authorization/i, `${f} sends an Authorization header`);
      assert.doesNotMatch(code, /POLLINATIONS_(API_KEY|TOKEN|PUBLIC_KEY)/, `${f} reads a key variable`);
    }
  });
});

describe('AI image, audio and video generation are gone end to end', () => {
  test('no client module generates media', () => {
    for (const f of [...CLIENT_FILES, 'public/js/layout.js', 'public/js/utils.js']) {
      const code = codeOnly(f);
      assert.doesNotMatch(code, /image\.pollinations\.ai/, `${f} builds an image-generation URL`);
      assert.doesNotMatch(code, /pollImage/, `${f} still has an image helper`);
      assert.doesNotMatch(code, /openai-audio/, `${f} builds a speech URL`);
    }
  });

  test('the server exposes no media-generation route and no voice list', () => {
    const server = codeOnly('server.js');
    assert.doesNotMatch(server, /image\.pollinations\.ai/);
    assert.doesNotMatch(server, /AUDIO_VOICES/);
    assert.doesNotMatch(server, /VIDEO_API_KEY/);
  });

  test('the AI page offers no image affordance', () => {
    const html = codeOnly('public/ai.html');
    assert.doesNotMatch(html, /\/image\b/, 'the /image command is still advertised');
    assert.doesNotMatch(html, /\bdraw\b/i);
    assert.doesNotMatch(html, /generate an image/i);
  });

  test('the committed data files advertise no AI provider catalogue', () => {
    // ai_gaming_hub_final.json is a games source that server.js merges into the
    // catalog. It also carried an unread `ai_models` block listing a text
    // provider, an IMAGE provider and web search, each marked "Unlimited" — a
    // committed file advertising a capability the product does not have, and a
    // limit the free tier does not offer.
    const hub = JSON.parse(read('ai_gaming_hub_final.json'));
    assert.equal(hub.ai_models, undefined, 'the AI provider catalogue is back');
    assert.ok(Array.isArray(hub.games) && hub.games.length > 0,
      'the games this file exists for must survive');
    const blob = JSON.stringify(hub);
    assert.doesNotMatch(blob, /image\.pollinations\.ai/, 'an image-generation URL is back');
    assert.doesNotMatch(blob, /Unlimited/, 'an "Unlimited" AI claim is back');
  });

  test('the legal pages do not promise image generation', () => {
    for (const f of ['legal/privacy.html', 'legal/terms.html', 'legal/credits.html', 'legal/cookies.html']) {
      const text = codeOnly(f);
      assert.doesNotMatch(text, /generated image/i, `${f} still mentions generated images`);
      assert.doesNotMatch(text, /chat &amp; images|chat & images/i, `${f} still advertises images`);
    }
  });

  test('privacy and terms describe a text-only assistant honestly', () => {
    const privacy = read('legal/privacy.html');
    // The honest claim: direct requests keep prompts away from US, not from THEM.
    assert.match(privacy, /Pollinations itself receives your prompt/,
      'privacy must not imply a direct request makes the prompt private from the provider');
    assert.match(privacy, /text\.pollinations\.ai/);
    const terms = read('legal/terms.html');
    assert.match(terms, /generates <strong>text only<\/strong>/);
  });

  test('the stale provider-preference storage keys are gone from the cookie policy', () => {
    const cookies = read('legal/cookies.html');
    assert.doesNotMatch(cookies, /puter-model/, 'cookies.html documents a key nothing writes');
    assert.doesNotMatch(cookies, /zofhub:ai:provider/);
  });
});

describe('the UI tells the truth about the free tier', () => {
  test('nothing claims the AI is unlimited', () => {
    for (const f of ['public/ai.html', 'public/js/ai.js', 'README.md', 'docs/README.md']) {
      assert.doesNotMatch(codeOnly(f), /free\s*(&amp;|&|and)\s*unlimited/i,
        `${f} claims the AI is unlimited — the anonymous tier is rate-limited`);
    }
  });

  test('the required disclaimer is present, in full', () => {
    const html = read('public/ai.html');
    assert.match(html, /may be inaccurate, incomplete, unavailable, or limited by/);
    assert.match(html, /free tier/);
    assert.match(html, /Avoid entering\s+passwords, private personal information, or other sensitive data/);
  });

  test('a failure is shown as a failure, never as an answer', () => {
    const ai = codeOnly('public/js/ai.js');
    assert.match(ai, /describeFailure/, 'there is no typed error path to the UI');
    assert.match(ai, /showError/);
    // The reply bubble must be dropped before the notice is rendered, so a
    // failed turn never leaves an empty assistant message behind.
    assert.match(ai, /current\.messages\.pop\(\)/);
  });

  test('model output is never inserted as raw HTML', () => {
    const ai = codeOnly('public/js/ai.js');
    assert.match(ai, /renderMarkdownLite\(m\.content\)/, 'assistant text must go through the sanitising renderer');
    assert.match(ai, /escapeHtml\(m\.content\)/, 'user text must be escaped');
  });
});

describe('every page carries the same footer', () => {
  const PAGES = [
    'public/index.html', 'public/ai.html', 'public/browser.html', 'public/community.html',
    'public/leaderboard.html', 'public/donate.html', 'public/category.html', 'public/game.html',
    'public/404.html', 'public/gameflare.html', 'public/gameflare-play.html',
    'legal/privacy.html', 'legal/terms.html', 'legal/cookies.html', 'legal/dmca.html',
    'legal/licenses.html', 'legal/credits.html',
  ];

  // Two GameFlare pages legitimately keep ONE child: a <p class="footer-legal">
  // disclosure naming who actually serves the game. mountFooter() captures and
  // restores it, so it is part of the shared footer rather than a rival to it.
  const MAY_KEEP_LEGAL_NOTE = new Set(['public/gameflare.html', 'public/gameflare-play.html']);

  for (const page of PAGES) {
    test(`${page} carries the shared footer, and nothing else`, () => {
      const html = read(page);
      assert.match(html, /<footer class="site-footer">/,
        `${page} does not carry <footer class="site-footer">`);
      const inner = html.match(/<footer class="site-footer">([\s\S]*?)<\/footer>/)?.[1] ?? null;
      assert.notEqual(inner, null, `${page} has no closing </footer>`);
      if (MAY_KEEP_LEGAL_NOTE.has(page)) {
        assert.match(inner, /class="footer-legal"/, `${page} lost its serving-party disclosure`);
      } else {
        assert.equal(inner.trim(), '',
          `${page} ships its own footer markup, which mountFooter() overwrites — so it is a second, wronger footer sitting in the source`);
      }
      // Whatever a page keeps, it must not re-list the shared footer's links.
      assert.doesNotMatch(inner, /footer-inner|footer-sep/,
        `${page} still has the pre-shared-footer fallback markup`);
    });
  }

  test('no page opts into a second footer variant', () => {
    for (const page of PAGES) {
      assert.doesNotMatch(read(page), /site-footer-mini/,
        `${page} still asks for the removed compact footer`);
    }
  });

  test('the compact variant is gone from the builder and the stylesheet', () => {
    assert.doesNotMatch(codeOnly('public/js/layout.js'), /site-footer-mini|footer-mini-inner/,
      'layout.js still branches on the removed footer variant');
    assert.doesNotMatch(codeOnly('public/css/main.css'), /site-footer-mini|footer-mini-/,
      'main.css still styles the removed footer variant');
  });

  test('the app shells no longer reserve height for the removed legal bar', () => {
    for (const f of ['public/css/ai.css', 'public/css/browser.css']) {
      assert.doesNotMatch(codeOnly(f), /--legal-bar-h/,
        `${f} still subtracts the height of a bar that no longer exists`);
    }
    assert.doesNotMatch(codeOnly('public/css/main.css'), /--legal-bar-h/);
  });

  test('the footer is built in exactly one place', () => {
    const layout = codeOnly('public/js/layout.js');
    assert.match(layout, /\.site-footer/);
    for (const page of PAGES) {
      // A page shipping its own footer links would drift from the shared one.
      assert.doesNotMatch(read(page), /<footer[^>]*>\s*<div class="footer-main"/,
        `${page} hard-codes footer markup instead of using the shared builder`);
    }
  });
});

describe('one failure, one wording, both entry points', () => {
  // The orb used to answer a 503 with "ask once more and it will" while /ai
  // named the status. Same failure, two stories, and the orb's was advice that
  // would not have worked.
  const CODES = ['timeout', 'offline', 'empty-answer', 'unexpected-response', 'empty-prompt'];

  for (const code of CODES) {
    test(`${code} has its own message`, () => {
      const msg = describeFailure({ code });
      assert.equal(typeof msg, 'string');
      assert.ok(msg.length > 10, 'too terse to act on');
      assert.notEqual(msg, describeFailure({ code: '__unknown__' }),
        `${code} falls through to the generic message`);
    });
  }

  test('an HTTP failure names its status, and 429 reads as a wait', () => {
    assert.match(describeFailure({ code: 'http', status: 503 }), /503/);
    assert.match(describeFailure({ code: 'http', status: 400 }), /400/);
    assert.match(describeFailure({ code: 'http', status: 429 }), /rate.?limited/i);
    // A 5xx is worth retrying; a 4xx is not, and the wording should differ.
    assert.notEqual(describeFailure({ code: 'http', status: 503 }),
                    describeFailure({ code: 'http', status: 400 }));
  });

  test('a Turnstile 403 is tagged origin-blocked, not a generic refusal', async () => {
    // MEASURED: the endpoint keys its Turnstile check on the Origin header and
    // refuses http://localhost:* with 403 {"error":"Missing Turnstile token"},
    // while http://127.0.0.1:* and a deployed https origin both return 200.
    // A bare "error 403" gave a developer nothing to act on.
    const original = globalThis.fetch;
    globalThis.fetch = () => Promise.resolve(new Response(
      JSON.stringify({ error: 'Missing Turnstile token' }),
      { status: 403, headers: { 'content-type': 'application/json' } },
    ));
    try {
      await assert.rejects(askAI('q'), (e) => {
        assert.equal(e.code, 'origin-blocked', 'a Turnstile 403 must be its own kind of failure');
        assert.equal(e.status, 403);
        assert.match(e.detail, /turnstile/i, 'the failure body should be kept for diagnosis');
        return true;
      });
    } finally { globalThis.fetch = original; }
  });

  test('a 403 that is NOT Turnstile stays a generic http failure', async () => {
    // Only the Turnstile body earns the special message. Any other 403 is a
    // real refusal and must not be explained away as a localhost quirk.
    const original = globalThis.fetch;
    globalThis.fetch = () => Promise.resolve(new Response('forbidden', {
      status: 403, headers: { 'content-type': 'text/plain' },
    }));
    try {
      await assert.rejects(askAI('q'), (e) => e.code === 'http' && e.status === 403);
    } finally { globalThis.fetch = original; }
  });

  test('origin-blocked names the fix, and does not claim a rate limit', () => {
    const msg = describeFailure({ code: 'origin-blocked' });
    assert.match(msg, /127\.0\.0\.1/, 'the message must name the address that works');
    assert.doesNotMatch(msg, /rate.?limit/i);
    assert.notEqual(msg, describeFailure({ code: 'http', status: 403 }),
      'it must not fall through to the generic 403 wording');
  });

  test('404 advises waiting, because that is what this endpoint means by it', () => {
    // MEASURED: two requests back to back (the /ai page, then the floating
    // assistant) returned 200 then 404, and the identical second request
    // returned 200 when spaced out. So this endpoint can express throttling as
    // a 404. The wording tells the user the thing that works.
    const msg = describeFailure({ code: 'http', status: 404 });
    assert.match(msg, /wait a few seconds/i, '404 should advise waiting, not just report a refusal');
    assert.notEqual(msg, describeFailure({ code: 'http', status: 400 }),
      '404 must not fall through to the generic 4xx wording');
  });

  test('a 404 does NOT claim to be a rate limit', async () => {
    // `rateLimited` drives a countdown and locks the composer. A real 404 (the
    // endpoint moving) is indistinguishable from a throttled one, so the flag
    // is never set on a guess — only an actual 429 sets it.
    const withFetch = async (status, fn) => {
      const original = globalThis.fetch;
      globalThis.fetch = () => Promise.resolve(new Response('no', {
        status, headers: { 'content-type': 'text/plain' },
      }));
      try { return await fn(); } finally { globalThis.fetch = original; }
    };
    await withFetch(404, async () => {
      await assert.rejects(askAI('q'), (e) => {
        assert.equal(e.status, 404);
        assert.equal(e.rateLimited, undefined, 'a 404 must not set rateLimited');
        assert.equal(e.retryAfter, undefined, 'a 404 must not fabricate a retry window');
        return true;
      });
    });
    await withFetch(429, async () => {
      await assert.rejects(askAI('q'), (e) => e.rateLimited === true);
    });
  });

  test('junk never throws and never returns nothing', () => {
    for (const junk of [null, undefined, {}, 'nope', 42, new Error('x')]) {
      const msg = describeFailure(junk);
      assert.equal(typeof msg, 'string');
      assert.ok(msg.length > 0);
    }
  });

  test('a cancelled request has NO message — it is not an error to show', () => {
    // Cancellation means a newer message superseded this one. Both callers
    // return before reaching describeFailure; this pins that it is not treated
    // as a reportable failure anywhere.
    for (const f of ['public/js/ai.js', 'public/js/ai-helper.js']) {
      const code = codeOnly(f);
      assert.match(code, /code === 'cancelled'/, `${f} does not special-case cancellation`);
    }
  });

  test('neither entry point carries its own copy of the prose', () => {
    for (const f of ['public/js/ai.js', 'public/js/ai-helper.js']) {
      const code = codeOnly(f);
      assert.match(code, /describeFailure/, `${f} does not use the shared wording`);
      assert.doesNotMatch(code, /ask once more and it will/,
        `${f} still has its own hand-written failure text`);
      assert.doesNotMatch(code, /function errorMessageFor/,
        `${f} still has a second failure-wording function`);
    }
  });
});
