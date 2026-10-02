// public/js/puter-ai.js — Puter as an opt-in, user-chosen AI provider.
// The adapter is import-safe (no DOM/window/localStorage at load time), so its
// pure helpers run here without a browser. The live SDK path is feature-detected
// and always fallible, so it is exercised by the real page, not asserted here.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// A localStorage stub — the module reads it only inside functions, so setting it
// before those calls is enough. Must exist before importing is NOT required.
globalThis.localStorage = (() => {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
    clear: () => m.clear(),
  };
})();

const {
  PUTER_SDK_URL, PROVIDERS, getProvider, setProvider, getPuterModel, setPuterModel,
  extractChunkText, costLabel, freeFirstModel, normalizeModels, toPuterMessages,
} = await import('../public/js/puter-ai.js');

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

describe('provider + model preference (nothing forced)', () => {
  test('default is auto, and an unknown value never sticks', () => {
    localStorage.clear();
    assert.equal(getProvider(), 'auto');
    assert.ok(setProvider('puter'));
    assert.equal(getProvider(), 'puter');
    setProvider('nonsense');
    assert.equal(getProvider(), 'auto', 'an invalid provider must fall back to auto, not persist');
  });

  test('puter model defaults to empty (Puter picks its own free tier)', () => {
    localStorage.clear();
    assert.equal(getPuterModel(), '');
    setPuterModel('openrouter/some-model');
    assert.equal(getPuterModel(), 'openrouter/some-model');
    setPuterModel('');                       // clearing it returns to the default
    assert.equal(getPuterModel(), '');
  });

  test('the SDK is the real Puter one and the provider list is closed', () => {
    assert.equal(PUTER_SDK_URL, 'https://js.puter.com/v2/');
    assert.deepEqual([...PROVIDERS], ['auto', 'pollinations', 'puter', 'huggingface']);
  });
});

describe('streaming/non-streaming reply extraction', () => {
  test('every provider chunk shape yields its text, and junk yields empty', () => {
    assert.equal(extractChunkText({ text: 'hi' }), 'hi');
    assert.equal(extractChunkText('plain'), 'plain');
    assert.equal(extractChunkText({ choices: [{ delta: { content: 'd' } }] }), 'd');
    assert.equal(extractChunkText({ message: { content: 'm' } }), 'm');
    assert.equal(extractChunkText({ message: { content: [{ text: 'a' }, { text: 'b' }] } }), 'ab');
    for (const junk of [null, undefined, 42, {}, { message: {} }]) assert.equal(extractChunkText(junk), '');
  });
});

describe('cost honesty (never a bare "free")', () => {
  test('free only when metadata says so; cost known → Credits; else Cost varies', () => {
    assert.equal(costLabel({ free: true }), 'Free');
    assert.equal(costLabel({ cost: 'free' }), 'Free');
    assert.equal(costLabel({ cost: 0.002 }), 'Credits');
    assert.equal(costLabel({ pricing: { in: 1 } }), 'Credits');
    assert.equal(costLabel({ id: 'x' }), 'Cost varies');
    assert.equal(costLabel(null), 'Cost varies');
  });

  test('free-first picks a free model, else empty (never forces a paid one)', () => {
    assert.equal(freeFirstModel([{ id: 'paid', cost: 1 }, { id: 'f', free: true }]), 'f');
    assert.equal(freeFirstModel([{ id: 'paid', cost: 1 }]), '');
    assert.equal(freeFirstModel('nope'), '');
  });
});

describe('model list + message normalisation are defensive', () => {
  test('listModels output: strings, objects, or an id-keyed map all normalise + dedupe', () => {
    assert.deepEqual(normalizeModels(['a', 'a', 'b']).map((m) => m.id), ['a', 'b']);
    const objs = normalizeModels([{ id: 'x', name: 'X', free: true }, { model: 'y', cost: 2 }]);
    assert.deepEqual(objs.map((m) => m.id), ['x', 'y']);
    assert.equal(objs[0].label, 'X');
    assert.equal(normalizeModels({ m1: { free: true }, m2: {} }).length, 2);
    assert.equal(normalizeModels(null).length, 0);
  });

  test('messages: bad roles become user, empty are dropped, content is bounded, history capped', () => {
    const msgs = toPuterMessages([
      { role: 'system', content: 'sys' },
      { role: 'root', content: 'coerce me' },
      { role: 'user', content: '   ' },            // dropped (blank)
      { role: 'assistant', content: 'x'.repeat(9000) },
    ]);
    assert.deepEqual(msgs.map((m) => m.role), ['system', 'user', 'assistant']);
    assert.equal(msgs[2].content.length, 8000, 'content must be bounded to 8000');
    const many = toPuterMessages(Array.from({ length: 40 }, (_, i) => ({ role: 'user', content: `m${i}` })));
    assert.equal(many.length, 16, 'history must be capped at 16 turns');
  });
});

describe('the page is wired to the picker, and the CSP lets the SDK load', () => {
  const read = (p) => readFileSync(join(ROOT, p), 'utf8');

  test('ai.js honours the explicit choice and never forces a paid token', () => {
    const ai = read('public/js/ai.js');
    assert.match(ai, /from '\.\/puter-ai\.js'/, 'ai.js does not import the Puter adapter');
    assert.match(ai, /if \(provider === 'puter'\)/, 'ai.js never routes to Puter');
    // An explicit Pollinations/Puter choice must not silently spend an HF token.
    assert.match(ai, /hfAvailable\(\) && \(provider === 'auto' \|\| provider === 'huggingface'\)/);
  });

  test('the AI page loads the picker and exposes the provider control', () => {
    const html = read('public/ai.html');
    assert.match(html, /ai-provider\.js/);
    assert.match(html, /id="aiProvider"/);
    assert.match(html, /id="aiPuter"/);
  });

  test('server CSP script-src allows the Puter SDK host (and only via https)', () => {
    const server = read('server.js');
    assert.match(server, /'https:\/\/js\.puter\.com'/, 'js.puter.com is not in the CSP');
    // It must be inside scriptSrc, after the directive opens and before styleSrc.
    const scriptSrc = server.slice(server.indexOf('scriptSrc:'), server.indexOf('styleSrc:'));
    assert.ok(scriptSrc.includes("'https://js.puter.com'"), 'js.puter.com is not in scriptSrc specifically');
  });
});
