// test/ai-feedback.test.mjs — the rules that decide what may become training data.
// ---------------------------------------------------------------------------
// This file guards the two ways an improvement pipeline destroys the thing it
// was built to improve:
//
//   1. INFRASTRUCTURE NOISE BECOMING TRAINING DATA. ZoFHub's measured failure
//      is a provider returning an empty stream or a 502 — during one eval run,
//      7 of 10 requests 502'd. Every one of those looks like "the AI gave a bad
//      answer" to the person sitting there. Route them into a training set and
//      the most common example in the corpus becomes a prompt whose target
//      output is nothing.
//   2. CONSENT LEAKING. A default-on training flag, or a client that can assert
//      its own eligibility, turns private chat into a dataset without anybody
//      deciding to.
//
// Both are silent failures, which is why they are asserted rather than trusted.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  SIGNALS, LANES, redact, routeSignal, isDeliveryProblem, prepareFeedbackRecord,
} from '../lib/ai-feedback.mjs';

describe('redaction happens before storage, not before export', () => {
  test('contact details and credentials are removed', () => {
    const { text, redactions } = redact(
      'mail me at kid@school.edu or 555-123-4567, my key is hf_abcdefghijklmnopqrstuvwx',
    );
    assert.ok(!text.includes('kid@school.edu'), 'email survived');
    assert.ok(!text.includes('555-123-4567'), 'phone survived');
    assert.ok(!/hf_[A-Za-z0-9]{16,}/.test(text), 'API token survived');
    assert.ok(redactions >= 3, `expected 3+ redactions, got ${redactions}`);
  });

  test('an API token pasted into chat never reaches the record', () => {
    // People paste keys into chat windows constantly. A feedback table is the
    // last place one should come to rest.
    const prepared = prepareFeedbackRecord({
      type: SIGNALS.CORRECTION,
      input: 'why does my key sk-abcdefghijklmnopqrstuvwxyz012345 not work',
      output: 'I cannot help with that.',
      correction: 'Explain that API keys should never be shared in chat.',
      consentTraining: true,
    });
    assert.equal(prepared.ok, true);
    assert.ok(!/sk-[A-Za-z0-9]{20,}/.test(JSON.stringify(prepared.record)), 'token stored');
    assert.ok(prepared.record.input.includes('[token]'));
  });

  test('the stored record has no field carrying the original text', () => {
    const prepared = prepareFeedbackRecord({
      type: SIGNALS.RATING, rating: -1,
      input: 'contact me at a@b.com', output: 'Sure.',
    });
    const keys = Object.keys(prepared.record);
    for (const k of keys) {
      assert.ok(!/raw|original|unredacted/i.test(k), `record keeps a raw copy in "${k}"`);
    }
    assert.ok(!JSON.stringify(prepared.record).includes('a@b.com'));
  });

  test('redaction is bounded and never throws on junk', () => {
    for (const bad of [null, undefined, 12345, {}, [], 'x'.repeat(10000)]) {
      assert.doesNotThrow(() => redact(bad));
    }
    assert.ok(redact('x'.repeat(10000)).text.length <= 4000);
  });
});

describe('a failed delivery is routing evidence, never model evidence', () => {
  test('an explicit delivery failure is detected', () => {
    assert.equal(isDeliveryProblem({ type: SIGNALS.DELIVERY_FAILURE }), true);
  });

  test('an empty answer is a delivery problem whatever the signal says', () => {
    assert.equal(isDeliveryProblem({ type: SIGNALS.RATING, rating: -1, output: '   ' }), true);
  });

  test("the UI's own failure text is recognised", () => {
    // This is the literal string public/js/ai.js shows when every provider
    // fails. Users thumbs-down it, and it is about our plumbing.
    assert.equal(isDeliveryProblem({
      type: SIGNALS.RATING, rating: -1,
      output: '_That reply didn’t come through — just hit send once more and it will._',
    }), true);
  });

  test('a real answer is NOT a delivery problem', () => {
    assert.equal(isDeliveryProblem({
      type: SIGNALS.RATING, rating: -1,
      output: 'The capital of Japan is Kyoto.',   // wrong, but delivered
    }), false);
  });

  test('a thumbs-down on a non-answer can never reach a training lane', () => {
    const r = routeSignal({ type: SIGNALS.RATING, rating: -1, output: '' });
    assert.deepEqual(r.lanes, [LANES.ROUTING]);
    assert.equal(r.trainingEligible, false);
    for (const lane of [LANES.SFT_CANDIDATE, LANES.PREFERENCE]) {
      assert.ok(!r.lanes.includes(lane), `leaked into ${lane}`);
    }
  });
});

describe('consent gates training, and only training', () => {
  const correction = {
    type: SIGNALS.CORRECTION,
    input: 'Who wrote the game Slope?',
    output: 'Slope was written by Nintendo in 1984.',
    correction: 'I do not have reliable information about who developed Slope.',
  };

  test('without consent a correction is still useful — just not for training', () => {
    const r = routeSignal({ ...correction, consentTraining: false });
    assert.ok(r.lanes.includes(LANES.EVAL), 'a correction should always become a regression case');
    assert.ok(r.lanes.includes(LANES.PREFERENCE));
    assert.ok(!r.lanes.includes(LANES.SFT_CANDIDATE), 'trained without consent');
    assert.equal(r.trainingEligible, false);
  });

  test('with consent it becomes a CANDIDATE, which is not the same as used', () => {
    const r = routeSignal({ ...correction, consentTraining: true });
    assert.ok(r.lanes.includes(LANES.SFT_CANDIDATE));
    assert.equal(r.trainingEligible, true);
  });

  test('consent is explicit true — nothing else counts', () => {
    // 'true', 1 and 'yes' are what a sloppy client sends. Each must fail closed.
    for (const v of ['true', 1, 'yes', {}, [], 'on']) {
      const r = routeSignal({ ...correction, consentTraining: v });
      assert.equal(r.trainingEligible, false, `consentTraining=${JSON.stringify(v)} was accepted`);
    }
  });

  test('a delivery failure with consent is STILL not trainable', () => {
    // Consent does not make noise into signal.
    const r = routeSignal({ type: SIGNALS.CORRECTION, correction: 'x'.repeat(40), output: '', consentTraining: true });
    assert.equal(r.trainingEligible, false);
    assert.deepEqual(r.lanes, [LANES.ROUTING]);
  });
});

describe('each signal reaches the mechanism that can actually fix it', () => {
  const cases = [
    [{ type: SIGNALS.REPORT, output: 'something offensive' }, LANES.SAFETY,
      'a report must reach a human'],
    [{ type: SIGNALS.REGENERATE, output: 'a mediocre answer' }, LANES.ROUTING,
      'asking again says the model/provider underperformed'],
    [{ type: SIGNALS.ACCEPTED, output: 'a good answer' }, LANES.PREFERENCE,
      'acceptance is weak preference evidence'],
    [{ type: SIGNALS.RATING, rating: -1, output: 'a wrong answer' }, LANES.EVAL,
      'a negative rating is a regression case, not a weight change'],
  ];
  for (const [signal, expectedLane, why] of cases) {
    test(`${signal.type} → ${expectedLane} (${why})`, () => {
      const r = routeSignal(signal);
      assert.ok(r.lanes.includes(expectedLane), `got ${r.lanes.join(',')}`);
    });
  }

  test('a report is never trainable even though it is the strongest signal', () => {
    const r = routeSignal({ type: SIGNALS.REPORT, output: 'policy-breaking text' });
    assert.equal(r.trainingEligible, false);
    assert.ok(!r.lanes.includes(LANES.SFT_CANDIDATE));
  });

  test('an unknown signal type is discarded, not guessed at', () => {
    const r = routeSignal({ type: 'vibes', output: 'hello' });
    assert.deepEqual(r.lanes, [LANES.DISCARD]);
  });

  test('a neutral rating carries no direction and is dropped', () => {
    assert.deepEqual(routeSignal({ type: SIGNALS.RATING, rating: 0, output: 'hi there' }).lanes,
      [LANES.DISCARD]);
  });

  test('a one-word "correction" is not a correction', () => {
    const r = routeSignal({ type: SIGNALS.CORRECTION, correction: 'no', output: 'an answer' });
    assert.deepEqual(r.lanes, [LANES.DISCARD]);
  });
});

describe('the stored record carries what a curator needs', () => {
  test('provenance is recorded, or the row is unusable later', () => {
    const p = prepareFeedbackRecord({
      type: SIGNALS.CORRECTION,
      input: 'Which engine does the browser use?',
      output: 'It uses Chrome.',
      correction: 'It offers Scramjet, Ultraviolet, GUST and AnuraOS.',
      provider: 'huggingface', model: 'meta-llama/Llama-3.1-8B-Instruct',
      promptVersion: '2026-09', consentTraining: true,
    });
    assert.equal(p.ok, true);
    // Without these you cannot tell whether a complaint is about the model, the
    // provider, or a prompt that has since been rewritten.
    assert.equal(p.record.provider, 'huggingface');
    assert.equal(p.record.model, 'meta-llama/Llama-3.1-8B-Instruct');
    assert.equal(p.record.prompt_version, '2026-09');
    assert.ok(p.record.route_reason.length > 10, 'no reason recorded for the routing decision');
    assert.ok(Array.isArray(p.record.lanes) && p.record.lanes.length);
  });

  test('no identifier ties a row to a person or a conversation', () => {
    const p = prepareFeedbackRecord({
      type: SIGNALS.RATING, rating: 1, input: 'hello there friend', output: 'Hi!',
      // A client trying to attach identity must not succeed by accident.
      userId: 'user-123', conversationId: 'conv-abc', ip: '203.0.113.5', sessionId: 's-1',
    });
    const keys = Object.keys(p.record);
    for (const forbidden of ['userId', 'user_id', 'conversationId', 'conversation_id', 'ip', 'sessionId', 'session_id']) {
      assert.ok(!keys.includes(forbidden), `record carries ${forbidden}`);
    }
  });

  test('a client cannot declare itself training-eligible', () => {
    // The verdict is the server's. This is the second of two enforcement
    // points; the first is the CHECK on the RLS insert policy.
    const p = prepareFeedbackRecord({
      type: SIGNALS.RATING, rating: 1, input: 'a normal question here', output: 'an answer',
      training_eligible: true, trainingEligible: true, lanes: ['sft_candidate'],
    });
    assert.equal(p.record.training_eligible, false);
    assert.ok(!p.record.lanes.includes(LANES.SFT_CANDIDATE));
  });

  test('junk input is refused rather than stored', () => {
    for (const bad of [{}, { type: '' }, { type: 'nope' }]) {
      assert.equal(prepareFeedbackRecord(bad).ok, false);
    }
  });
});
