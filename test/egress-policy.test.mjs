// lib/egress-policy.mjs — the one rule: no visitor-driven connection leaves this
// server directly. Production cannot opt out; a developer outside production can,
// explicitly and audibly. These tests pin the matrix so the rule cannot drift.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  egressPolicy, describeEgressPolicy, isProduction, EgressUnavailableError,
} from '../lib/egress-policy.mjs';

describe('the default is enforcement, everywhere', () => {
  for (const env of [{}, { NODE_ENV: 'development' }, { NODE_ENV: 'test' }, { NODE_ENV: 'production' }]) {
    test(`NODE_ENV=${env.NODE_ENV ?? '(unset)'}: direct egress is refused and the daemon is tried`, () => {
      const p = egressPolicy(env);
      assert.equal(p.directAllowed, false);
      assert.equal(p.singboxEnabled, true);
      assert.equal(p.mode, 'enforced');
      assert.deepEqual(p.requestedOverrides, []);
      assert.deepEqual(p.ignoredOverrides, []);
    });
  }

  test('the old strict flag is just the default now', () => {
    for (const v of ['1', 'true', 'yes', 'on']) {
      const p = egressPolicy({ SINGBOX_REQUIRE: v });
      assert.equal(p.directAllowed, false, `SINGBOX_REQUIRE=${v}`);
      assert.deepEqual(p.requestedOverrides, [], 'a flag that agrees with the default is not an override');
    }
  });

  test('an empty or garbage value is not an opt-out', () => {
    for (const env of [
      { SINGBOX_ALLOW_DIRECT: '' }, { SINGBOX_ALLOW_DIRECT: 'maybe' }, { SINGBOX_ALLOW_DIRECT: '0' },
      { SINGBOX_REQUIRE: '' }, { SINGBOX_REQUIRE: 'sometimes' }, { SINGBOX_EGRESS: '' }, { SINGBOX_EGRESS: 'banana' },
    ]) {
      assert.equal(egressPolicy(env).directAllowed, false, JSON.stringify(env));
    }
  });
});

describe('a developer outside production can opt out, explicitly', () => {
  const cases = [
    ['SINGBOX_ALLOW_DIRECT=1', { SINGBOX_ALLOW_DIRECT: '1' }, 'SINGBOX_ALLOW_DIRECT'],
    ['SINGBOX_ALLOW_DIRECT=true', { SINGBOX_ALLOW_DIRECT: 'true' }, 'SINGBOX_ALLOW_DIRECT'],
    ['SINGBOX_REQUIRE=0', { SINGBOX_REQUIRE: '0' }, 'SINGBOX_REQUIRE=0'],
    ['SINGBOX_REQUIRE=off', { SINGBOX_REQUIRE: 'off' }, 'SINGBOX_REQUIRE=0'],
    ['SINGBOX_EGRESS=0', { SINGBOX_EGRESS: '0' }, 'SINGBOX_EGRESS=0'],
    ['SINGBOX_EGRESS=false', { SINGBOX_EGRESS: 'false' }, 'SINGBOX_EGRESS=0'],
  ];
  for (const [label, env, named] of cases) {
    test(`${label} permits direct egress and is named in the policy`, () => {
      const p = egressPolicy({ NODE_ENV: 'development', ...env });
      assert.equal(p.directAllowed, true);
      assert.equal(p.mode, 'direct-permitted');
      assert.ok(p.requestedOverrides.includes(named), JSON.stringify(p.requestedOverrides));
      assert.deepEqual(p.ignoredOverrides, []);
    });
  }

  test('turning the daemon OFF is the only thing that stops it being tried', () => {
    assert.equal(egressPolicy({ SINGBOX_EGRESS: '0' }).singboxEnabled, false);
    assert.equal(egressPolicy({ SINGBOX_ALLOW_DIRECT: '1' }).singboxEnabled, true,
      'permitting a fallback must not stop the daemon being tried first');
  });
});

describe('production cannot opt out', () => {
  const flags = [
    { SINGBOX_ALLOW_DIRECT: '1' }, { SINGBOX_REQUIRE: '0' }, { SINGBOX_EGRESS: '0' },
    { SINGBOX_ALLOW_DIRECT: '1', SINGBOX_REQUIRE: '0', SINGBOX_EGRESS: '0' },
    { SINGBOX_ALLOW_DIRECT: 'TRUE', SINGBOX_REQUIRE: 'No', SINGBOX_EGRESS: 'OFF' },
  ];
  for (const f of flags) {
    test(`NODE_ENV=production with ${JSON.stringify(f)}`, () => {
      const p = egressPolicy({ NODE_ENV: 'production', ...f });
      assert.equal(p.directAllowed, false, 'a flag reopened direct egress in production');
      assert.equal(p.singboxEnabled, true, 'a flag switched the daemon off in production');
      assert.equal(p.mode, 'enforced');
      assert.ok(p.ignoredOverrides.length > 0, 'the ignored override must be reported, not swallowed');
    });
  }

  test('production is recognised case-insensitively and with stray whitespace', () => {
    for (const v of ['production', 'PRODUCTION', ' Production ', 'production\n']) {
      assert.equal(isProduction({ NODE_ENV: v }), true, JSON.stringify(v));
      assert.equal(egressPolicy({ NODE_ENV: v, SINGBOX_ALLOW_DIRECT: '1' }).directAllowed, false, JSON.stringify(v));
    }
    assert.equal(isProduction({ NODE_ENV: 'prod' }), false, 'only the exact word counts');
  });
});

describe('what the operator is told', () => {
  test('production names every override it ignored', () => {
    const line = describeEgressPolicy(egressPolicy({
      NODE_ENV: 'production', SINGBOX_ALLOW_DIRECT: '1', SINGBOX_EGRESS: '0',
    }));
    assert.match(line, /refused unconditionally/);
    assert.match(line, /SINGBOX_ALLOW_DIRECT/);
    assert.match(line, /SINGBOX_EGRESS=0/);
  });

  test('a developer opt-out is announced loudly', () => {
    const line = describeEgressPolicy(egressPolicy({ SINGBOX_ALLOW_DIRECT: '1' }));
    assert.match(line, /DEVELOPMENT/);
    assert.match(line, /PERMITTED/);
    assert.match(line, /Never set this in production/);
  });

  test('the enforced default says what enforced means', () => {
    assert.match(describeEgressPolicy(egressPolicy({})), /crosses sing-box, or is refused/);
  });
});

describe('the refusal is its own error class', () => {
  test('EgressUnavailableError is distinguishable from a blocked destination', async () => {
    const { BlockedDestinationError } = await import('../lib/safe-fetch.mjs');
    const e = new EgressUnavailableError('daemon down');
    assert.equal(e.name, 'EgressUnavailableError');
    assert.equal(e.code, 'EEGRESS');
    assert.ok(!(e instanceof BlockedDestinationError),
      'a server-side outage must not be reported as the visitor asking for a forbidden place');
    assert.equal(new BlockedDestinationError('x').code, 'EBLOCKED');
  });

  test('it carries its cause', () => {
    const cause = new Error('ECONNREFUSED');
    assert.equal(new EgressUnavailableError('down', { cause }).cause, cause);
  });
});
