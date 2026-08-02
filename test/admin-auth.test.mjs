// Unit tests for lib/admin-auth.mjs — the primitives the admin console's
// security rests on. No network, no database, no credentials: every case is
// pure logic driven from this file.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  hashPassword, hashPasswordSync, verifyPassword,
  parseCookies, csrfOk, originOk, adminConfigStatus, hashIp, hashToken,
  CSRF_COOKIE, CSRF_HEADER, SESSION_COOKIE,
} from '../lib/admin-auth.mjs';

describe('password hashing', () => {
  test('a correct password verifies and a wrong one does not', async () => {
    const h = await hashPassword('correct horse battery staple');
    assert.equal(await verifyPassword('correct horse battery staple', h), true);
    assert.equal(await verifyPassword('correct horse battery stapl', h), false);
    assert.equal(await verifyPassword('', h), false);
  });

  test('the same password hashes differently every time (per-hash salt)', async () => {
    const a = await hashPassword('same-password');
    const b = await hashPassword('same-password');
    assert.notEqual(a, b, 'identical hashes would mean no salt — rainbow-table fodder');
    assert.equal(await verifyPassword('same-password', a), true);
    assert.equal(await verifyPassword('same-password', b), true);
  });

  test('the hash string is versioned so the KDF can be swapped later', async () => {
    const h = await hashPassword('x');
    const [algo, N, r, p, salt, digest] = h.split('$');
    assert.equal(algo, 'scrypt');
    assert.ok(Number(N) >= 16384, `cost parameter too low: ${N}`);
    assert.ok(Number(r) >= 8 && Number(p) >= 1);
    assert.ok(salt.length > 10 && digest.length > 40);
  });

  test('a malformed, foreign or absent hash FAILS CLOSED', async () => {
    // A deployment with a broken ADMIN_PASSWORD_HASH must reject every login,
    // never accept every login.
    for (const bad of ['', null, undefined, 'not-a-hash', 'scrypt$only$three$parts',
                       '$2b$12$abcdefghijklmnopqrstuv', 'argon2id$v=19$m=65536', 'scrypt$a$b$c$d$e']) {
      assert.equal(await verifyPassword('anything', bad), false, `should reject ${JSON.stringify(bad)}`);
    }
  });

  test('the sync generator agrees with the async verifier', async () => {
    const h = hashPasswordSync('cli-generated-password');
    assert.equal(await verifyPassword('cli-generated-password', h), true);
    assert.equal(await verifyPassword('other', h), false);
  });
});

describe('cookie parsing', () => {
  test('reads normal cookies and url-decodes values', () => {
    const c = parseCookies('a=1; b=hello%20world; c=x=y');
    assert.equal(c.a, '1');
    assert.equal(c.b, 'hello world');
    assert.equal(c.c, 'x=y', 'only the FIRST = separates name from value');
  });

  test('a cookie named after a prototype member does not read back as one', () => {
    // Same class of bug as the presence-count regression: on a plain object
    // jar['constructor'] returns a function, which downstream code treats as a
    // present-and-truthy session token.
    const c = parseCookies('constructor=x; toString=y');
    assert.equal(typeof c.constructor, 'string');
    assert.equal(typeof c.toString, 'string');
    const empty = parseCookies('');
    assert.equal(empty.constructor, undefined, 'an absent cookie must be undefined, not inherited');
    assert.equal(empty[SESSION_COOKIE], undefined);
  });

  test('junk input yields an empty jar rather than throwing', () => {
    for (const v of [undefined, null, '', '   ', ';;;', '=nokey', 'noequals']) {
      assert.doesNotThrow(() => parseCookies(v));
    }
  });
});

describe('CSRF double-submit', () => {
  const req = (cookie, header) => ({
    headers: { cookie },
    get: (n) => (String(n).toLowerCase() === CSRF_HEADER ? header : undefined),
  });

  test('accepts only when the cookie and header match exactly', () => {
    assert.equal(csrfOk(req(`${CSRF_COOKIE}=tok123456`, 'tok123456')), true);
    assert.equal(csrfOk(req(`${CSRF_COOKIE}=tok123456`, 'tok123457')), false);
    assert.equal(csrfOk(req(`${CSRF_COOKIE}=tok123456`, 'tok12345')), false, 'length mismatch');
  });

  test('a missing half is a rejection, not a pass', () => {
    // The failure that matters: if an absent header were treated as "nothing to
    // check", every cross-site request would sail through.
    assert.equal(csrfOk(req(`${CSRF_COOKIE}=tok`, undefined)), false);
    assert.equal(csrfOk(req('', 'tok')), false);
    assert.equal(csrfOk(req('', undefined)), false);
    assert.equal(csrfOk(req(`${CSRF_COOKIE}=`, '')), false);
  });
});

describe('origin validation', () => {
  const req = (origin, host) => ({ get: (n) => ({ origin, host }[String(n).toLowerCase()]) });

  test('same-origin passes, cross-origin fails', () => {
    assert.equal(originOk(req('https://zofhub.example', 'zofhub.example')), true);
    assert.equal(originOk(req('https://evil.example', 'zofhub.example')), false);
  });

  test('an absent Origin is allowed (same-origin fetches may omit it)', () => {
    assert.equal(originOk(req(undefined, 'zofhub.example')), true);
  });

  test('a malformed Origin is refused rather than throwing', () => {
    assert.equal(originOk(req('not a url', 'zofhub.example')), false);
  });
});

describe('configuration is fail-closed', () => {
  const KEYS = ['ADMIN_USERNAME', 'ADMIN_PASSWORD_HASH', 'ADMIN_SESSION_SECRET'];
  const withEnv = (env, fn) => {
    const saved = Object.fromEntries(KEYS.map(k => [k, process.env[k]]));
    try {
      for (const k of KEYS) delete process.env[k];
      Object.assign(process.env, env);
      return fn();
    } finally {
      for (const k of KEYS) {
        if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
      }
    }
  };

  test('every missing piece is reported and blocks login', () => {
    assert.equal(withEnv({}, () => adminConfigStatus().ok), false);
    assert.equal(withEnv({ ADMIN_USERNAME: 'a' }, () => adminConfigStatus().ok), false);
    assert.equal(withEnv({
      ADMIN_USERNAME: 'a', ADMIN_PASSWORD_HASH: hashPasswordSync('pw'),
    }, () => adminConfigStatus().ok), false, 'no session secret must block login');
  });

  test('a password hash from the wrong tool is rejected up front', () => {
    const s = withEnv({
      ADMIN_USERNAME: 'a',
      ADMIN_PASSWORD_HASH: '$2b$12$abcdefghijklmnopqrstuv',   // bcrypt
      ADMIN_SESSION_SECRET: 'x'.repeat(48),
    }, () => adminConfigStatus());
    assert.equal(s.ok, false);
    assert.ok(s.problems.some(p => /hash/i.test(p)));
  });

  test('a short session secret is rejected', () => {
    const s = withEnv({
      ADMIN_USERNAME: 'a', ADMIN_PASSWORD_HASH: hashPasswordSync('pw'), ADMIN_SESSION_SECRET: 'short',
    }, () => adminConfigStatus());
    assert.equal(s.ok, false);
    assert.ok(s.problems.some(p => /32/.test(p)));
  });

  test('a complete configuration passes', () => {
    const s = withEnv({
      ADMIN_USERNAME: 'admin', ADMIN_PASSWORD_HASH: hashPasswordSync('a-real-password'),
      ADMIN_SESSION_SECRET: 'x'.repeat(48),
    }, () => adminConfigStatus());
    assert.deepEqual(s, { ok: true, problems: [] });
  });
});

describe('identifier hashing', () => {
  test('session tokens are stored as a hash, never in the clear', () => {
    const token = 'a-session-token';
    const h = hashToken(token);
    assert.notEqual(h, token);
    assert.match(h, /^[0-9a-f]{64}$/);
    assert.equal(hashToken(token), h, 'must be stable, or no session would validate twice');
  });

  test('IP hashing is keyed, stable, and yields nothing without the key', () => {
    const saved = process.env.ADMIN_SESSION_SECRET;
    try {
      process.env.ADMIN_SESSION_SECRET = 'k'.repeat(48);
      const a = hashIp('203.0.113.9');
      assert.equal(hashIp('203.0.113.9'), a, 'stable, or session drift detection breaks');
      assert.notEqual(hashIp('203.0.113.10'), a);
      assert.ok(!a.includes('203.0.113'), 'the address itself must not survive');

      // A different key must produce a different hash — otherwise rotating the
      // secret would leave old hashes correlatable with new ones.
      process.env.ADMIN_SESSION_SECRET = 'j'.repeat(48);
      assert.notEqual(hashIp('203.0.113.9'), a);

      delete process.env.ADMIN_SESSION_SECRET;
      assert.equal(hashIp('203.0.113.9'), null, 'no key means no hash, not a weak one');
    } finally {
      if (saved === undefined) delete process.env.ADMIN_SESSION_SECRET;
      else process.env.ADMIN_SESSION_SECRET = saved;
    }
  });
});
