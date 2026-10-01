// The inference endpoints this server must never fetch (lib/ai-hosts.mjs).
//
// /asset, /thumb and /api/proxy/diag fetch caller-supplied URLs. Aimed at an AI
// provider, any of them made THIS server run inference on its own IP and bill.
// These pin the matcher itself; test/server.test.mjs pins the routes.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { AI_PROVIDER_HOSTS, normalizeHost, isAiProviderHost, mentionsAiProvider } from '../lib/ai-hosts.mjs';

// The twenty rules of the original expression, written out. Cohere and fal each
// span two TLDs, which is why the list has twenty-two entries.
const EXPECTED = [
  'pollinations.ai', 'aihorde.net', 'stablehorde.net', 'openai.com', 'anthropic.com', 'claude.ai',
  'generativelanguage.googleapis.com', 'api.groq.com', 'api.mistral.ai', 'api.cohere.ai', 'api.cohere.com',
  'api.deepseek.com', 'api.together.xyz', 'api.replicate.com', 'replicate.delivery', 'fal.ai', 'fal.run',
  'openrouter.ai', 'huggingface.co', 'api.stability.ai', 'api.x.ai', 'api.perplexity.ai',
];

describe('the list', () => {
  test('is exactly the twenty rules, written out as twenty-two domains', () => {
    assert.deepEqual([...AI_PROVIDER_HOSTS].sort(), [...EXPECTED].sort());
    assert.ok(Object.isFrozen(AI_PROVIDER_HOSTS), 'the list can be edited at runtime');
  });

  test('the spellings the old expression named explicitly are still covered', () => {
    for (const h of ['api.openrouter.ai', 'api-inference.huggingface.co', 'text.pollinations.ai',
      'image.pollinations.ai', 'gen.pollinations.ai', 'api.openai.com', 'api.anthropic.com']) {
      assert.equal(isAiProviderHost(h), true, h);
    }
  });
});

describe('isAiProviderHost', () => {
  for (const d of EXPECTED) {
    test(`blocks ${d}, its subdomains, and every spelling of it`, () => {
      for (const h of [d, `api.${d}`, `a.b.${d}`, d.toUpperCase(), `${d}.`, `${d}..`, ` ${d} `, `[${d}]`]) {
        assert.equal(isAiProviderHost(h), true, `"${h}" slipped through`);
      }
    });
  }

  test('a trailing dot is the same host — the hole the old $-anchored regex had', () => {
    assert.equal(normalizeHost('API.OpenAI.com.'), 'api.openai.com');
    assert.equal(isAiProviderHost('api.openai.com.'), true);
  });

  test('lookalikes are not blocked', () => {
    for (const h of ['notopenai.com', 'openai.com.evil.test', 'pollinations.ai.example.net',
      'myhuggingface.co', 'fal.air', 'x.ai', 'cdn.gamedistribution.com', '', null, undefined]) {
      assert.equal(isAiProviderHost(h), false, `"${h}" was blocked`);
    }
  });
});

describe('mentionsAiProvider', () => {
  test('a direct URL', () => {
    assert.equal(mentionsAiProvider('https://text.pollinations.ai/hello'), true);
    assert.equal(mentionsAiProvider(new URL('https://api.openai.com./v1/models')), true);
  });

  test('an AI URL smuggled through an intermediary', () => {
    for (const u of [
      'https://relay.example/?url=https://api.openai.com/v1/chat/completions',
      'https://relay.example/?url=https%3A%2F%2Ftext.pollinations.ai%2Fhi',
      'https://relay.example/?u=https%253A%252F%252Fapi.anthropic.com%252Fv1',   // double-encoded
      'https://token.cloudimg.io/v7/image.pollinations.ai/prompt/cat',            // image CDN path
      'https://relay.example/fetch/HUGGINGFACE.CO/models',
    ]) {
      assert.equal(mentionsAiProvider(u), true, u);
    }
  });

  test('ordinary game asset URLs are left alone', () => {
    for (const u of [
      'https://html5.gamedistribution.com/abc/?gd_sdk_referrer_url=https%3A%2F%2Fzofhub.test%2Fplay%2Fx',
      'https://cdn.example.com/game/Build/game.data.unityweb',
      'https://img.gamemonetize.com/x/512x384.jpg',
      'https://cdn.example.com/assets/openai.com.png',
      'not a url',
    ]) {
      assert.equal(mentionsAiProvider(u), false, u);
    }
  });
});
