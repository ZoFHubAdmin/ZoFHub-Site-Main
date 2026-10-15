// The free-only AI policy, and the "one client, text only" guarantee.
//
// WHY THESE ARE SOURCE-LEVEL ASSERTIONS IN PLACES. Two of the requirements here
// are NEGATIVE — "no AI image generation anywhere" and "no second AI provider"
// — and a negative cannot be shown by calling a function. So the tests that
// matter most read the actual files and fail if a removed feature comes back.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isFreeTextModel } from '../public/js/pollinations.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

/**
 * The file with its comments removed.
 *
 * Load-bearing for the "a removed feature has not come back" tests below. Those
 * removals left explanatory comments behind ON PURPOSE — a future reader needs
 * to know that /image existed and why it went — and a naive grep for the old
 * name matches the explanation as readily as a regression. So the assertions run
 * against CODE only: JS line and block comments, and HTML comments, are stripped
 * first. Anything that survives is something the browser actually executes or
 * renders.
 */
function codeOnly(p) {
  let s = read(p);
  s = s.replace(/<!--[\s\S]*?-->/g, '');        // HTML comments
  s = s.replace(/\/\*[\s\S]*?\*\//g, '');       // JS block comments
  s = s.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');   // JS line comments
  return s;
}

// The exact shape the live endpoint returned when this was verified.
const LIVE_ANONYMOUS = {
  name: 'openai-fast',
  description: 'GPT-OSS 20B Reasoning LLM (OVH)',
  reasoning: true,
  tier: 'anonymous',
  community: false,
  input_modalities: ['text'],
  output_modalities: ['text'],
  tools: true,
  aliases: ['openai', 'gpt-oss', 'gpt-oss-20b', 'ovh-reasoning'],
  vision: false,
  audio: false,
};

describe('free-only: eligibility is established, never assumed', () => {
  test('the model the live endpoint actually advertises is accepted', () => {
    assert.equal(isFreeTextModel(LIVE_ANONYMOUS), true);
  });

  test('an UNKNOWN tier is refused — "unknown cost" is not "free"', () => {
    for (const tier of ['seed', 'flower', 'nectar', 'pro', 'paid', '', undefined, null, 42]) {
      assert.equal(
        isFreeTextModel({ ...LIVE_ANONYMOUS, tier }),
        false,
        `tier ${JSON.stringify(tier)} must not count as free`,
      );
    }
  });

  test('a missing tier field is refused rather than defaulted', () => {
    const { tier, ...noTier } = LIVE_ANONYMOUS;
    assert.equal(isFreeTextModel(noTier), false);
  });

  test('a non-text model is refused even on the free tier', () => {
    assert.equal(isFreeTextModel({ ...LIVE_ANONYMOUS, output_modalities: ['image'] }), false);
    assert.equal(isFreeTextModel({ ...LIVE_ANONYMOUS, output_modalities: ['audio'] }), false);
    assert.equal(isFreeTextModel({ ...LIVE_ANONYMOUS, input_modalities: ['image'] }), false);
  });

  test('a model with no modality fields is trusted on its tier alone', () => {
    // Older /models payloads omit the modality arrays; the endpoint is the TEXT
    // endpoint, so absence is not evidence of non-text.
    const { input_modalities, output_modalities, ...bare } = LIVE_ANONYMOUS;
    assert.equal(isFreeTextModel(bare), true);
  });

  test('junk of every shape is refused without throwing', () => {
    for (const bad of [null, undefined, 0, '', 'openai-fast', [], {}, { name: '' }, { name: 'x' }]) {
      assert.equal(isFreeTextModel(bad), false, `accepted ${JSON.stringify(bad)}`);
    }
  });

  test('tier matching is case-insensitive but value-exact', () => {
    assert.equal(isFreeTextModel({ ...LIVE_ANONYMOUS, tier: 'ANONYMOUS' }), true);
    assert.equal(isFreeTextModel({ ...LIVE_ANONYMOUS, tier: ' anonymous' }), false, 'no fuzzy matching');
    assert.equal(isFreeTextModel({ ...LIVE_ANONYMOUS, tier: 'anonymous-plus' }), false);
  });
});

describe('a server secret can never reach the browser', () => {
  const client = codeOnly('public/js/pollinations.js');
  const clientRaw = read('public/js/pollinations.js');

  test('the client never names the key-bearing endpoint', () => {
    // gen.pollinations.ai requires `Authorization: Bearer sk_…`. Using it from a
    // page would mean shipping a secret or relaying every prompt through us.
    assert.doesNotMatch(client, /gen\.pollinations\.ai\/v1/,
      'the client builds a request to the endpoint that requires a secret key');
  });

  test('the client never mentions a secret key prefix', () => {
    assert.doesNotMatch(client, /['"`]sk_/, 'an sk_ key must never appear in browser code');
  });

  test('only the publishable pk_ key is ever accepted from our own origin', () => {
    assert.match(clientRaw, /startsWith\('pk_'\)/, 'the key fetch must validate the pk_ prefix');
  });
});

describe('AI image generation is gone end to end', () => {
  test('no client module generates an image', () => {
    for (const f of ['public/js/pollinations.js', 'public/js/ai.js', 'public/js/ai-helper.js']) {
      const code = codeOnly(f);
      assert.doesNotMatch(code, /image\.pollinations\.ai/, `${f} still builds an image URL`);
      assert.doesNotMatch(code, /pollImageUrl|pollImageShieldUrl/, `${f} still calls an image helper`);
    }
  });

  test('the server exposes no image-generation route', () => {
    assert.doesNotMatch(codeOnly('server.js'), /app\.get\(\s*['"]\/api\/ai\/image['"]/, 'the /api/ai/image handler is back');
  });

  test('/api/ai/providers advertises no image provider', async () => {
    const { publicProviderList, MODEL_FALLBACKS } = await import('../lib/ai-providers.mjs');
    assert.deepEqual(publicProviderList().image, [], 'an image provider is advertised again');
    assert.equal(MODEL_FALLBACKS.image, undefined, 'the flux image fallback is back');
  });

  test('the AI page offers no /image affordance', () => {
    // BOTH copies of the welcome block: the server-rendered one in ai.html and
    // the WELCOME template ai.js re-renders on a new chat. Removing one and not
    // the other is exactly the mistake this catches.
    const html = codeOnly('public/ai.html');
    const js = codeOnly('public/js/ai.js');
    assert.doesNotMatch(html, /data-prompt="\/image/, 'the /image suggestion card is back in ai.html');
    assert.doesNotMatch(js, /data-prompt="\/image/, 'the /image suggestion card is back in the WELCOME template');
    // The composer hint must not advertise a command that no longer exists.
    assert.doesNotMatch(html, /<b>\/image<\/b>/);
  });
});

describe('there is exactly one AI provider, and one client', () => {
  test('the removed provider modules are really gone', () => {
    for (const f of ['public/js/puter-ai.js', 'public/js/hf-inference.js',
      'public/js/hf-models.js', 'public/js/ai-provider.js', 'public/js/ai-settings.js']) {
      assert.equal(existsSync(join(ROOT, f)), false, `${f} is back`);
    }
  });

  test('nothing imports a second provider', () => {
    for (const f of ['public/js/ai.js', 'public/js/ai-helper.js']) {
      const src = read(f);
      assert.doesNotMatch(src, /from '\.\/(puter-ai|hf-inference|hf-models)\.js/, `${f} imports a removed provider`);
    }
  });

  test('ai.html loads neither deleted script', () => {
    const html = read('public/ai.html');
    assert.doesNotMatch(html, /ai-provider\.js|ai-settings\.js/);
  });

  test('both AI entry points import the SAME client instance', () => {
    // A module is cache-keyed by its full URL, so two different ?v= values load
    // pollinations.js twice — two model caches, two key fetches.
    const spec = /from '\.\/pollinations\.js(\?v=\d+)?'/;
    const a = read('public/js/ai.js').match(spec);
    const b = read('public/js/ai-helper.js').match(spec);
    assert.ok(a && b, 'both entry points must import the shared client');
    assert.equal(a[1], b[1], `version query differs: ${a[1]} vs ${b[1]} — the browser would load two copies`);
  });

  test('the Puter CSP allowance is withdrawn', () => {
    assert.doesNotMatch(codeOnly('server.js'), /'https:\/\/js\.puter\.com'/, 'js.puter.com is allow-listed again');
  });

  test('the dependencies went with the providers', () => {
    const pkg = JSON.parse(read('package.json'));
    assert.equal(pkg.dependencies['@heyputer/puter.js'], undefined);
    assert.equal(pkg.dependencies['@huggingface/inference'], undefined);
    // The on-device offline fallback is a DIFFERENT package and must survive.
    assert.doesNotMatch(JSON.stringify(pkg.dependencies), /@huggingface\/inference/);
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

describe('the UI tells the truth about the free tier', () => {
  test('nothing claims the AI is unlimited', () => {
    for (const f of ['public/ai.html', 'public/js/ai.js']) {
      assert.doesNotMatch(codeOnly(f), /free\s*(&amp;|&|and)\s*unlimited/i,
        `${f} still claims the AI is unlimited — the anonymous tier is rate-limited`);
    }
  });

  test('the required disclaimer is present, in full', () => {
    const html = read('public/ai.html');
    assert.match(html, /may be inaccurate, incomplete, unavailable, or limited by/);
    assert.match(html, /free tier/);
    assert.match(html, /Avoid entering\s+passwords, private personal information, or other sensitive data/);
  });
});
