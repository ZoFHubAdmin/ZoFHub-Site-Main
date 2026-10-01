// test/ai-eval.test.mjs — the promotion gate, and the model catalogue.
// ---------------------------------------------------------------------------
// The gate is the part of an "AI improvement" system that has to be right when
// everything else is uncertain. Its whole job is to say NO to a change that
// looks good on average, and averages are exactly what hide a broken safety
// refusal. So the rule is tested directly rather than only through a live run —
// a gate that can only be exercised against a third-party provider is a gate
// nobody can rely on during an outage.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scoreCase, summarise, comparison, CRITICAL_CATEGORIES } from '../lib/ai-eval.mjs';
import {
  HF_TEXT_MODELS, HF_DEFAULT_MODEL, isAllowedHfModel, resolveHfModel,
  hfFailoverOrder, hfCatalogue, looksLikeHfToken,
} from '../public/js/hf-models.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

describe('scoring is strict about what counts as a pass', () => {
  test('an empty answer never passes, whatever the check', () => {
    for (const kind of ['equals_ci', 'contains', 'contains_ci', 'max_words', 'json_equals']) {
      assert.equal(scoreCase({ kind, value: 'anything' }, '').pass, false, kind);
    }
    // not_contains_ci is the trap: "" trivially does not contain the string,
    // so a dead provider would otherwise score a free point on every safety case.
    assert.equal(scoreCase({ kind: 'not_contains_ci', value: 'secret' }, '').pass, false);
  });

  test('an unknown check kind FAILS rather than passing', () => {
    // A typo in the eval set must not silently become a free point.
    assert.equal(scoreCase({ kind: 'vibes', value: 1 }, 'anything').pass, false);
    assert.equal(scoreCase(undefined, 'anything').pass, false);
  });

  test('json_equals tolerates the code fence models insist on adding', () => {
    const check = { kind: 'json_equals', value: { ok: true, n: 3 } };
    assert.equal(scoreCase(check, '{"ok":true,"n":3}').pass, true);
    assert.equal(scoreCase(check, '```json\n{"n":3,"ok":true}\n```').pass, true, 'fenced JSON rejected');
    assert.equal(scoreCase(check, '{"ok":true,"n":4}').pass, false);
    assert.equal(scoreCase(check, 'here you go: {"ok":true}').pass, false);
  });

  test('max_words counts words, not characters', () => {
    assert.equal(scoreCase({ kind: 'max_words', value: 5 }, 'one two three').pass, true);
    assert.equal(scoreCase({ kind: 'max_words', value: 2 }, 'one two three').pass, false);
  });

  test('any_of_ci matches any listed phrase, case-insensitively', () => {
    const check = { kind: 'any_of_ci', value: ['do not know', "don't know"] };
    assert.equal(scoreCase(check, 'I DO NOT KNOW that.').pass, true);
    assert.equal(scoreCase(check, 'The score was 42.').pass, false);
  });
});

describe('the promotion gate refuses the changes that matter', () => {
  const baselineResults = [
    { id: 'a', category: 'correctness', pass: true, ms: 100 },
    { id: 'b', category: 'safety', pass: true, ms: 100 },
    { id: 'c', category: 'factuality', pass: true, ms: 100 },
    { id: 'd', category: 'instruction-following', pass: false, ms: 100 },
  ];
  const baseline = { results: baselineResults, summary: summarise(baselineResults) };

  test('a safety regression blocks even when the average improves', () => {
    // 3/4 -> 3/4 on the average, but the safety case broke. This is the exact
    // trade an average-based gate would wave through.
    const candidate = [
      { id: 'a', category: 'correctness', pass: true, ms: 100 },
      { id: 'b', category: 'safety', pass: false, ms: 100 },
      { id: 'c', category: 'factuality', pass: true, ms: 100 },
      { id: 'd', category: 'instruction-following', pass: true, ms: 100 },
    ];
    const v = comparison(candidate, baseline);
    assert.equal(v.promote, false);
    assert.match(v.reason, /critical/i);
    assert.ok(v.regressions.some((r) => r.id === 'b'));
  });

  test('a factuality regression blocks too', () => {
    const candidate = baselineResults.map((r) => (r.id === 'c' ? { ...r, pass: false } : { ...r, pass: true }));
    assert.equal(comparison(candidate, baseline).promote, false);
  });

  test('a strict improvement promotes', () => {
    const candidate = baselineResults.map((r) => ({ ...r, pass: true }));
    const v = comparison(candidate, baseline);
    assert.equal(v.promote, true);
    assert.ok(v.improvements.some((r) => r.id === 'd'));
  });

  test('ANY ordinary regression blocks by default', () => {
    // maxRegressions defaults to 0: "it got better overall" is not a reason to
    // accept a case that used to work and now does not.
    const candidate = baselineResults.map((r) => (r.id === 'a' ? { ...r, pass: false } : { ...r, pass: true }));
    assert.equal(comparison(candidate, baseline).promote, false);
  });

  test('no baseline never promotes', () => {
    const v = comparison(baselineResults, null);
    assert.equal(v.promote, false);
    assert.match(v.reason, /baseline/i);
    // Same for an empty one — a corrupted file must not read as "anything wins".
    assert.equal(comparison(baselineResults, { results: [] }).promote, false);
  });

  test('critical categories are the ones the eval set actually uses', () => {
    const suite = JSON.parse(readFileSync(join(ROOT, 'data', 'ai-eval-set.json'), 'utf8'));
    const used = new Set(suite.cases.map((c) => c.category));
    for (const c of CRITICAL_CATEGORIES) {
      assert.ok(used.has(c), `"${c}" is gated but no case exercises it`);
    }
  });
});

describe('the eval set is internally sound', () => {
  const suite = JSON.parse(readFileSync(join(ROOT, 'data', 'ai-eval-set.json'), 'utf8'));

  test('every case has a unique id, a prompt and a machine check', () => {
    const ids = new Set();
    for (const c of suite.cases) {
      assert.ok(c.id && !ids.has(c.id), `duplicate or missing id: ${c.id}`);
      ids.add(c.id);
      assert.ok(c.prompt && c.prompt.length > 8, `${c.id}: no usable prompt`);
      assert.ok(c.check && c.check.kind, `${c.id}: no check`);
      assert.ok(c.category, `${c.id}: no category`);
      // A case nobody can explain is a case nobody will maintain.
      assert.ok(c.why && c.why.length > 20, `${c.id}: no rationale`);
    }
  });

  test('every check kind is one the scorer implements', () => {
    // Otherwise the case silently fails forever and looks like a model problem.
    for (const c of suite.cases) {
      const probe = scoreCase(c.check, 'a plausible answer string');
      assert.ok(!/unknown check kind/.test(probe.detail), `${c.id}: ${probe.detail}`);
    }
  });

  test('safety and factuality are represented', () => {
    for (const cat of CRITICAL_CATEGORIES) {
      assert.ok(suite.cases.some((c) => c.category === cat), `no ${cat} case`);
    }
  });
});

describe('the Hugging Face catalogue is an allow-list', () => {
  test('an unknown model id is refused, not passed through', () => {
    // The id arrives from the browser. Accepting an arbitrary one would let a
    // visitor point the feature at any repository on the Hub.
    for (const bad of ['evil/backdoor', '../../etc/passwd', '', null, 'meta-llama/Llama-3.1-8B-Instruct-uncensored']) {
      assert.equal(isAllowedHfModel(bad), false, `accepted ${bad}`);
      assert.equal(resolveHfModel(bad), HF_DEFAULT_MODEL, 'did not fall back to the default');
    }
  });

  test('the default is in the catalogue', () => {
    assert.equal(isAllowedHfModel(HF_DEFAULT_MODEL), true);
  });

  test('every listed model records at least one verified provider', () => {
    // Each entry was checked against the live Hub. A model with no provider is
    // a menu entry that fails at request time — SmolLM3-3B was excluded for
    // exactly this reason.
    for (const m of HF_TEXT_MODELS) {
      assert.ok(Array.isArray(m.providers) && m.providers.length > 0, `${m.id} has no providers`);
      assert.ok(m.label && m.good_for, `${m.id} is not described`);
    }
  });

  test('failover prefers models with more independent providers', () => {
    const order = hfFailoverOrder('Qwen/Qwen2.5-7B-Instruct');
    assert.equal(order[0], 'Qwen/Qwen2.5-7B-Instruct', 'an explicit choice must come first');
    const counts = order.slice(1).map((id) => HF_TEXT_MODELS.find((m) => m.id === id).providers.length);
    assert.deepEqual(counts, [...counts].sort((a, b) => b - a),
      'failover should fall back to the most widely served models first');
  });

  test('failover never lists a model twice', () => {
    const order = hfFailoverOrder(HF_DEFAULT_MODEL);
    assert.equal(new Set(order).size, order.length);
  });

  test('the public catalogue exposes no credentials and states the token rule', () => {
    const cat = hfCatalogue();
    assert.equal(cat.requiresUserToken, true, 'HF has no anonymous tier; the UI must say so');
    assert.equal(cat.tokenStoredClientSideOnly, true);
    assert.ok(!/hf_|secret|apiKey|token":/i.test(JSON.stringify(cat).replace(/"requiresUserToken"|"tokenStoredClientSideOnly"/g, '')));
  });

  test('token shape-check rejects the obvious mistakes', () => {
    assert.equal(looksLikeHfToken('hf_' + 'a'.repeat(20)), true);
    for (const bad of ['', 'hf_', 'sk-abcdefghijklmnop', 'hf_short', 'Bearer hf_aaaaaaaaaaaaaaaaaaaa', null]) {
      assert.equal(looksLikeHfToken(bad), false, `accepted ${bad}`);
    }
  });
});

describe('summarise reports what an operator needs to judge a run', () => {
  test('latency and verbosity are reported, not just pass rate', () => {
    const s = summarise([
      { id: 'a', category: 'x', pass: true, ms: 100, chars: 50 },
      { id: 'b', category: 'x', pass: false, ms: 300, chars: 150 },
    ]);
    assert.equal(s.passed, 1);
    assert.equal(s.passRate, 0.5);
    assert.ok(Number.isFinite(s.p50Ms) && Number.isFinite(s.p95Ms));
    assert.equal(s.meanChars, 100);
  });

  test('an empty run does not divide by zero', () => {
    assert.doesNotThrow(() => summarise([]));
    assert.equal(summarise([]).passRate, 0);
  });
});
