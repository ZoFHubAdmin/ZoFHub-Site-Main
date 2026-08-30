// Swap-donation backend.
//
// The tests that matter most here are the NEGATIVE ones: that the API key never
// leaves the server, that a provider error cannot leak the proxy or request URL
// to a donor, and that createInvoice has no way to record who asked. A privacy
// property nobody tests is a privacy property nobody has.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  createInvoice, swapConfig, swapStatusLine, SwapError, DEPOSIT_COINS, PROVIDERS,
} from '../lib/swap.mjs';

const CFG = {
  provider: PROVIDERS.sideshift,
  key: 'secret-key-value-that-must-never-escape',
  collect: '4' + 'A'.repeat(94),
  missing: [],
  enabled: true,
};

/** A fetch stub that records what it was asked to do. */
function stub(response, { status = 200 } = {}) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    return { ok: status < 400, status, json: async () => response };
  };
  fn.calls = calls;
  return fn;
}

describe('createInvoice cannot record who asked', () => {
  test('its signature accepts no user identity at all', () => {
    // Structural, not behavioural: there is no ip/session/user/device argument
    // to forget to strip. Guarding the shape stops a future edit adding one
    // without somebody noticing.
    const src = readFileSync(new URL('../lib/swap.mjs', import.meta.url), 'utf8');
    const sig = /export async function createInvoice\(\{([^}]*)\}/.exec(src);
    assert.ok(sig, 'createInvoice signature not found');
    const params = sig[1];
    for (const banned of ['ip', 'session', 'user', 'device', 'fingerprint', 'cookie', 'agent']) {
      assert.ok(!new RegExp('\\b' + banned, 'i').test(params),
        `createInvoice takes "${banned}" — it must not be able to see one`);
    }
  });

  test('the request body carries no identifier beyond coin and destination', async () => {
    const f = stub({ depositAddress: 'bc1qexample', id: 'ref123' });
    await createInvoice({ from: 'btc', fetchImpl: f, config: CFG });
    const body = JSON.parse(f.calls[0].init.body);
    // A SUBSET assertion, not an equality one: affiliateId is dropped by
    // JSON.stringify when unconfigured, but any field a later edit adds must
    // still fail this test. That is the property worth guarding.
    const ALLOWED = new Set(['affiliateId', 'depositCoin', 'depositNetwork',
      'settleAddress', 'settleCoin', 'settleNetwork']);
    for (const k of Object.keys(body)) {
      assert.ok(ALLOWED.has(k), `unexpected field sent to the provider: ${k}`);
    }
    assert.equal(body.settleAddress, CFG.collect);
    assert.equal(typeof body.affiliateId, 'string', 'must always be a string — see the regression test below');
  });
});

describe('the API key stays on the server', () => {
  test('it is sent to the provider as a header, and appears nowhere in the result', async () => {
    const f = stub({ depositAddress: 'bc1qexample', id: 'ref123' });
    const out = await createInvoice({ from: 'btc', fetchImpl: f, config: CFG });
    assert.equal(f.calls[0].init.headers['x-sideshift-secret'], CFG.key, 'provider must receive it');
    assert.ok(!JSON.stringify(out).includes(CFG.key), 'and the caller must never see it');
  });

  test('the status line reports presence, never the value', () => {
    const line = swapStatusLine(CFG);
    assert.ok(!line.includes(CFG.key));
    assert.ok(!line.includes(CFG.collect), 'nor the collection address');
    assert.match(line, /key present/);
  });

  test('with no key it still works, and says so', () => {
    assert.match(swapStatusLine({ ...CFG, key: '' }), /key absent/);
  });
});

describe('provider failures do not leak infrastructure', () => {
  test('a transport error becomes a generic message', async () => {
    const boom = async () => { throw new Error('connect ECONNREFUSED 127.0.0.1:9050 via proxy tor-internal:9080'); };
    await assert.rejects(
      () => createInvoice({ from: 'btc', fetchImpl: boom, config: CFG }),
      (e) => {
        assert.ok(e instanceof SwapError);
        assert.equal(e.message, 'swap provider unreachable');
        assert.ok(!/9050|proxy|tor-internal/i.test(e.message), 'must not name the proxy');
        return true;
      });
  });

  test('a provider HTTP error surfaces its message but not our request', async () => {
    const f = stub({ error: { message: 'deposit coin not supported' } }, { status: 400 });
    await assert.rejects(
      () => createInvoice({ from: 'btc', fetchImpl: f, config: CFG }),
      /deposit coin not supported/);
  });

  test('a 200 with no deposit address is refused rather than shown empty', async () => {
    const f = stub({ id: 'ref123' });
    await assert.rejects(() => createInvoice({ from: 'btc', fetchImpl: f, config: CFG }),
      /no deposit address/);
  });
});

describe('input from the browser is allowlisted', () => {
  test('only known coins are accepted', async () => {
    for (const bad of ['', 'xyz', '../../etc', 'btc; drop', null, undefined, 42, 'BTC\n']) {
      await assert.rejects(() => createInvoice({ from: bad, fetchImpl: stub({}), config: CFG }),
        (e) => e.status === 400, `accepted ${JSON.stringify(bad)}`);
    }
  });

  test('the allowlisted coins map to real networks', () => {
    for (const [k, v] of Object.entries(DEPOSIT_COINS)) {
      assert.equal(v.coin, k);
      assert.ok(v.network && v.label);
    }
  });

  test('case is normalised, so BTC and btc are the same request', async () => {
    const f = stub({ depositAddress: 'bc1qexample', id: 'r' });
    await createInvoice({ from: 'BTC', fetchImpl: f, config: CFG });
    assert.equal(JSON.parse(f.calls[0].init.body).depositCoin, 'btc');
  });
});

describe('it fails closed when unconfigured', () => {
  test('no provider or no collection address means disabled', async () => {
    for (const cfg of [
      { provider: null, key: '', collect: '', enabled: false },
      { provider: PROVIDERS.sideshift, key: '', collect: '', enabled: false },
    ]) {
      await assert.rejects(() => createInvoice({ from: 'btc', fetchImpl: stub({}), config: cfg }),
        (e) => e.status === 503);
    }
  });

  test('swapConfig reads the environment and defaults to off', () => {
    const saved = { p: process.env.SWAP_PROVIDER, a: process.env.DONATE_XMR_ADDRESS };
    try {
      delete process.env.SWAP_PROVIDER; delete process.env.DONATE_XMR_ADDRESS;
      assert.equal(swapConfig().enabled, false, 'must be off unless deliberately switched on');
    } finally {
      if (saved.p !== undefined) process.env.SWAP_PROVIDER = saved.p;
      if (saved.a !== undefined) process.env.DONATE_XMR_ADDRESS = saved.a;
    }
  });
});

describe('nothing in the repo hardcodes a wallet address', () => {
  test('data/donate.json ships every address empty and names an env var instead', () => {
    const cfg = JSON.parse(readFileSync(new URL('../data/donate.json', import.meta.url), 'utf8'));
    for (const m of cfg.methods) {
      if (m.kind !== 'crypto') continue;
      assert.equal(String(m.address || ''), '', `${m.id} has an address committed`);
      assert.ok(m.addressEnv, `${m.id} must name an addressEnv`);
    }
  });
});

describe('REGRESSION: SideShift rejects a request with no affiliateId', () => {
  // Found by calling the live API, not by reading docs. Sending
  // `affiliateId: undefined` makes JSON.stringify drop the key, and the
  // endpoint answers 'Invalid parameters: affiliateId: expected string,
  // received undefined'. Every donation would have failed at the moment a
  // donor clicked, with nothing wrong at boot to hint at it.
  test('affiliateId is always sent as a string, never dropped', async () => {
    const saved = process.env.SIDESHIFT_AFFILIATE_ID;
    try {
      delete process.env.SIDESHIFT_AFFILIATE_ID;
      const f = stub({ depositAddress: 'bc1qexample', id: 'r' });
      await createInvoice({ from: 'btc', fetchImpl: f, config: CFG });
      const body = JSON.parse(f.calls[0].init.body);
      assert.ok('affiliateId' in body, 'the key must be present');
      assert.equal(typeof body.affiliateId, 'string');
    } finally {
      if (saved !== undefined) process.env.SIDESHIFT_AFFILIATE_ID = saved;
    }
  });

  test('and the whole swap path is disabled at CONFIG time when it is unset', () => {
    const saved = { p: process.env.SWAP_PROVIDER, a: process.env.DONATE_XMR_ADDRESS, f: process.env.SIDESHIFT_AFFILIATE_ID };
    try {
      process.env.SWAP_PROVIDER = 'sideshift';
      process.env.DONATE_XMR_ADDRESS = '4' + 'A'.repeat(94);
      delete process.env.SIDESHIFT_AFFILIATE_ID;
      const cfg = swapConfig();
      assert.equal(cfg.enabled, false, 'must fail at boot, not at donation time');
      assert.deepEqual(cfg.missing, ['SIDESHIFT_AFFILIATE_ID']);
      assert.match(swapStatusLine(cfg), /requires SIDESHIFT_AFFILIATE_ID/);
    } finally {
      for (const [k, v] of [['SWAP_PROVIDER', saved.p], ['DONATE_XMR_ADDRESS', saved.a], ['SIDESHIFT_AFFILIATE_ID', saved.f]]) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
    }
  });
});
