// Unit tests for lib/ai-pipeline.mjs
//
// Uses node:test — built into Node 22, so the suite adds ZERO dependencies to a
// project that deliberately has no build step. `npm test` just works.
//
// These are mostly REGRESSION tests: nearly every case below encodes a bug that
// was actually observed against the live Pollinations API, so a future refactor
// that reintroduces it fails here instead of in production.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  isTransient, withRetry, modelPriority, candidateModels,
  healthyModels, isHealthy, markFailure, markSuccess, healthSnapshot,
} from '../lib/ai-pipeline.mjs';

describe('isTransient — decides retry vs immediate failover', () => {
  test('402 is transient (Pollinations returns it under load, not as a hard billing error)', () => {
    // Observed live: openai-fast returned 402, then 200 seconds later. Treating
    // 402 as fatal made the pipeline abandon a working model.
    assert.equal(isTransient(new Error('upstream 402')), true);
  });

  test('429 and 408 are transient', () => {
    assert.equal(isTransient(new Error('upstream 429')), true);
    assert.equal(isTransient(new Error('upstream 408')), true);
  });

  test('5xx is transient', () => {
    for (const code of [500, 502, 503, 504]) {
      assert.equal(isTransient(new Error('upstream ' + code)), true, `${code} should retry`);
    }
  });

  test('other 4xx is NOT transient — retrying a bad model id just wastes the user\'s time', () => {
    for (const code of [400, 401, 403, 404]) {
      assert.equal(isTransient(new Error('upstream ' + code)), false, `${code} should fail over`);
    }
  });

  test('network faults are transient', () => {
    for (const msg of ['fetch failed', 'ECONNRESET', 'ENOTFOUND', 'timeout', 'This operation was aborted']) {
      assert.equal(isTransient(new Error(msg)), true, `${msg} should retry`);
    }
  });
});

describe('withRetry — exponential backoff', () => {
  test('returns on first success without retrying', async () => {
    let calls = 0;
    const out = await withRetry(async () => { calls++; return 'ok'; });
    assert.equal(out, 'ok');
    assert.equal(calls, 1);
  });

  test('retries transient failures then succeeds', async () => {
    let calls = 0;
    const out = await withRetry(async () => {
      calls++;
      if (calls < 3) throw new Error('upstream 503');
      return 'recovered';
    }, { attempts: 4, baseMs: 1 });
    assert.equal(out, 'recovered');
    assert.equal(calls, 3);
  });

  test('does NOT retry a non-transient failure', async () => {
    let calls = 0;
    await assert.rejects(
      () => withRetry(async () => { calls++; throw new Error('upstream 404'); }, { attempts: 5, baseMs: 1 }),
      /404/,
    );
    assert.equal(calls, 1, 'a 404 must not be retried');
  });

  test('gives up after the attempt limit', async () => {
    let calls = 0;
    await assert.rejects(
      () => withRetry(async () => { calls++; throw new Error('upstream 500'); }, { attempts: 3, baseMs: 1 }),
      /500/,
    );
    assert.equal(calls, 3);
  });
});

describe('model priority', () => {
  test('default priority is non-empty and includes a broadly available model', () => {
    const p = modelPriority();
    assert.ok(p.length > 0);
    assert.ok(p.includes('openai-fast'), 'needs a model that works without a key');
  });

  test('AI_MODEL_PRIORITY overrides the default', () => {
    const prev = process.env.AI_MODEL_PRIORITY;
    process.env.AI_MODEL_PRIORITY = 'model-a, model-b ,model-c';
    try {
      assert.deepEqual(modelPriority(), ['model-a', 'model-b', 'model-c']);
    } finally {
      if (prev === undefined) delete process.env.AI_MODEL_PRIORITY;
      else process.env.AI_MODEL_PRIORITY = prev;
    }
  });

  test('candidateModels is endpoint-aware', () => {
    // REGRESSION: the keyless endpoint serves only openai-fast. Offering it the
    // community-namespaced models produced a 404, burned the whole time budget,
    // and dumped every request onto the AI Horde fallback.
    const keyless = candidateModels(false);
    assert.ok(!keyless.some(m => m.includes('/')),
      'keyless endpoint must not be offered namespaced community models');
    assert.ok(keyless.includes('openai-fast'));
    assert.ok(candidateModels(true).length >= keyless.length);
  });
});

describe('health tracking', () => {
  const M = '__test_model__';

  test('a single failure does NOT sideline the model', () => {
    // REGRESSION: Pollinations blips constantly — within one run openai-fast
    // returned 402 and openai returned 502, and both returned 200 moments
    // later. Sidelining on one blip means avoiding models that work.
    markSuccess(M);                      // reset
    markFailure(M, new Error('upstream 502'));
    assert.equal(isHealthy(M), true, 'one failure is a blip, not a pattern');
  });

  test('two consecutive failures do sideline it', () => {
    markSuccess(M);
    markFailure(M, new Error('upstream 502'));
    markFailure(M, new Error('upstream 502'));
    assert.equal(isHealthy(M), false);
  });

  test('success clears the failure record', () => {
    markSuccess(M);
    markFailure(M, new Error('x'));
    markFailure(M, new Error('x'));
    assert.equal(isHealthy(M), false);
    markSuccess(M);
    assert.equal(isHealthy(M), true);
  });

  test('healthyModels never returns empty, even when everything is down', () => {
    // Refusing to try is strictly worse than trying something that may have
    // recovered — an empty list would mean a guaranteed failure.
    const models = ['__a__', '__b__'];
    for (const m of models) { markSuccess(m); markFailure(m, new Error('e')); markFailure(m, new Error('e')); }
    assert.equal(healthyModels(models).length, models.length);
    for (const m of models) markSuccess(m);
  });

  test('healthSnapshot exposes no secrets', () => {
    const snap = healthSnapshot();
    assert.ok(Array.isArray(snap));
    const blob = JSON.stringify(snap);
    assert.ok(!/sb_secret|pk_|Bearer|apikey/i.test(blob), 'snapshot must not leak credentials');
    for (const row of snap) {
      assert.ok(typeof row.model === 'string');
      assert.ok(typeof row.healthy === 'boolean');
    }
  });
});
