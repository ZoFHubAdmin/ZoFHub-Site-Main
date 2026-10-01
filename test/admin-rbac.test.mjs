// Admin role-based access control.
//
// The gap this closes was real, not theoretical. requireAdmin() answered a
// single boolean, and TWO principals reach /api/admin with very different
// trust: a password session (short-lived cookie, CSRF, idle timeout) and
// ADMIN_SECRET — a static environment string documented as a "machine token
// for monitors/CLI" that never expires and has no CSRF protection. Both had
// identical power, so a leaked monitoring token could revoke every admin
// session or purge the running cache.
//
// Pure: every function takes plain values and an injected env.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PERMISSIONS, PERMISSION_IDS, ROLES, ROLE_IDS,
  serviceRole, roleForPrincipal, permissionsFor, can, principalSummary,
} from '../lib/admin-rbac.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SESSION = { username: 'admin', via: 'session' };
const BEARER = { username: 'service-token', via: 'bearer' };

describe('the permission model', () => {
  test('every role grants only declared permissions', () => {
    for (const id of ROLE_IDS) {
      const def = ROLES[id];
      if (def.permissions === '*') continue;
      for (const p of def.permissions) {
        assert.ok(PERMISSION_IDS.includes(p), `role ${id} grants unknown permission ${p}`);
      }
    }
  });

  test('every permission is documented', () => {
    for (const p of PERMISSION_IDS) {
      assert.ok(PERMISSIONS[p] && PERMISSIONS[p].length > 10, `${p} has no description`);
    }
  });

  test('owner holds everything; none holds nothing', () => {
    assert.deepEqual(permissionsFor('owner').sort(), [...PERMISSION_IDS].sort());
    assert.deepEqual(permissionsFor('none'), []);
    // An unknown role is not an error and not a wildcard — it is nothing.
    assert.deepEqual(permissionsFor('wizard'), []);
  });

  test('roles are strictly ordered in power', () => {
    // viewer ⊂ operator ⊂ owner. A role that is "lower" but holds something a
    // higher one does not is the kind of mistake that makes a permission model
    // unreasonable to reason about.
    const viewer = new Set(permissionsFor('viewer'));
    const operator = new Set(permissionsFor('operator'));
    const owner = new Set(permissionsFor('owner'));
    for (const p of viewer) assert.ok(operator.has(p), `viewer has ${p} but operator does not`);
    for (const p of operator) assert.ok(owner.has(p), `operator has ${p} but owner does not`);
    assert.ok(viewer.size < operator.size && operator.size < owner.size);
  });

  test('no role below owner may write security or config', () => {
    // These two are the whole reason this module exists: session revocation and
    // running-config changes belong to the interactive admin alone.
    for (const role of ['operator', 'viewer', 'none']) {
      const held = permissionsFor(role);
      assert.ok(!held.includes('security.write'), `${role} can revoke sessions`);
      assert.ok(!held.includes('config.write'), `${role} can change running config`);
    }
  });
});

describe('principal → role', () => {
  test('a cookie session is the owner; a bearer token is not', () => {
    assert.equal(roleForPrincipal(SESSION, {}), 'owner');
    assert.notEqual(roleForPrincipal(BEARER, {}), 'owner');
  });

  test('no principal at all holds nothing', () => {
    assert.equal(roleForPrincipal(null, {}), 'none');
    assert.equal(can(null, 'telemetry.read', {}), false);
    assert.equal(can(undefined, 'catalog.read', {}), false);
  });

  test('the bearer token defaults to operator, not owner', () => {
    assert.equal(serviceRole({}), 'operator');
    assert.equal(roleForPrincipal(BEARER, {}), 'operator');
  });

  test('ADMIN_SERVICE_ROLE can harden the token but never escalate it', () => {
    assert.equal(serviceRole({ ADMIN_SERVICE_ROLE: 'viewer' }), 'viewer');
    // The escalation guard. Setting it to owner must NOT grant owner.
    assert.equal(serviceRole({ ADMIN_SERVICE_ROLE: 'owner' }), 'operator');
    assert.equal(serviceRole({ ADMIN_SERVICE_ROLE: 'OWNER' }), 'operator');
    // A typo must fall back to the documented default, never to everything.
    for (const typo of ['vewer', '', '   ', 'admin', 'root', 'superuser']) {
      const r = serviceRole({ ADMIN_SERVICE_ROLE: typo });
      assert.equal(r, 'operator', `ADMIN_SERVICE_ROLE="${typo}" resolved to ${r}`);
      assert.ok(!permissionsFor(r).includes('security.write'));
    }
  });

  test('an explicit role on the principal wins (the future user-table hook)', () => {
    assert.equal(roleForPrincipal({ via: 'session', role: 'viewer' }, {}), 'viewer');
    // …but only when it names a real role; junk falls back to the kind default.
    // TIGHTENED when staff accounts arrived. This used to assert 'owner': an
    // unknown explicit role fell through to full control. Harmless while no
    // principal carried a role; a privilege escalation once public.admin_users
    // supplies them. An unknown role — and a claimed 'owner' — now hold nothing.
    assert.equal(roleForPrincipal({ via: 'session', role: 'wizard' }, {}), 'none');
    assert.equal(roleForPrincipal({ via: 'session', role: 'owner', userId: 'x' }, {}), 'none');
    assert.equal(roleForPrincipal({ via: 'session', userId: 'x' }, {}), 'none');
  });
});

describe('can()', () => {
  test('a bearer token cannot revoke sessions or purge config', () => {
    assert.equal(can(BEARER, 'security.write', {}), false);
    assert.equal(can(BEARER, 'config.write', {}), false);
    // …but keeps what the README documents it as being for.
    assert.equal(can(BEARER, 'telemetry.read', {}), true);
    assert.equal(can(BEARER, 'catalog.write', {}), true);
  });

  test('a viewer token can read and nothing else', () => {
    const env = { ADMIN_SERVICE_ROLE: 'viewer' };
    assert.equal(can(BEARER, 'telemetry.read', env), true);
    assert.equal(can(BEARER, 'catalog.read', env), true);
    for (const p of ['catalog.write', 'moderation.write', 'security.write', 'config.write']) {
      assert.equal(can(BEARER, p, env), false, `viewer token holds ${p}`);
    }
  });

  test('an unknown permission fails closed rather than throwing', () => {
    // A typo in a route guard must deny, not 500 — a 500 gets "fixed" by
    // deleting the check.
    assert.equal(can(SESSION, 'catalog.wrote', {}), false);
    assert.equal(can(SESSION, '', {}), false);
    assert.equal(can(SESSION, undefined, {}), false);
    assert.doesNotThrow(() => can(SESSION, 'nonsense', {}));
  });
});

describe('principalSummary', () => {
  test('carries the role and its permissions', () => {
    const s = principalSummary(BEARER, {});
    assert.equal(s.role, 'operator');
    assert.ok(Array.isArray(s.permissions) && s.permissions.length);
    assert.deepEqual(Object.keys(s).sort(),
      ['permissions', 'role', 'roleLabel', 'username', 'via']);
  });

  test('it copies no secret out of the principal it is handed', () => {
    // /api/admin/me returns this to the browser. req.admin is assembled by the
    // auth layer and may carry session internals, so the summary must be a
    // deliberate projection rather than a spread — asserted on VALUES, not on
    // field names, because the username is legitimately "service-token" and a
    // substring check for "token" only tests the test.
    const SECRET = 'sk-live-DO-NOT-LEAK-6f2a9';
    const summary = principalSummary({
      username: 'admin', via: 'session',
      password: SECRET, passwordHash: SECRET, csrf: SECRET,
      session: { token: SECRET, secret: SECRET },
    }, {});
    assert.ok(!JSON.stringify(summary).includes(SECRET),
      'principalSummary copied a secret out of the principal');
  });
});

describe('the routes actually enforce it', () => {
  // A permission model nothing calls is documentation. These assert the wiring,
  // because the failure mode — a route quietly reverting to the plain
  // requireAdmin gate — is invisible until someone exercises that route with a
  // low-privilege credential.
  const server = readFileSync(join(ROOT, 'server.js'), 'utf8');

  test('requirePerm exists and records every denial', () => {
    assert.match(server, /function requirePerm\(req, res, permission\)/);
    const start = server.indexOf('function requirePerm(');
    const body = server.slice(start, start + 1200);
    assert.match(body, /requireAdmin\(req, res\)/, 'requirePerm does not authenticate first');
    assert.match(body, /rbac\.can\(/, 'requirePerm does not consult the model');
    assert.match(body, /auditAction\(req, 'rbac\.denied'/, 'denials are not audited');
    assert.match(body, /status\(403\)/, 'denials do not return 403');
  });

  test('the dangerous routes are behind the right permission', () => {
    const EXPECT = [
      ["app.post('/api/admin/auth/logout-all'", 'security.write'],
      ["app.post('/api/admin/cache/clear'", 'config.write'],
      ["app.post('/api/admin/games/:slug/visibility'", 'catalog.write'],
      ["app.post('/api/admin/catalog/refresh'", 'catalog.write'],
      ["app.post('/api/admin/recommendations/:id/:action'", 'moderation.write'],
      ["app.post('/api/admin/feedback/:id/:action'", 'moderation.write'],
      ["app.get('/api/admin/security'", 'security.read'],
      ["app.get('/api/admin/audit'", 'security.read'],
      ["app.get('/api/admin/proxy'", 'telemetry.read'],
    ];
    for (const [route, perm] of EXPECT) {
      const at = server.indexOf(route);
      assert.notEqual(at, -1, `route not found: ${route}`);
      const head = server.slice(at, at + 260);
      assert.ok(head.includes(`requirePerm(req, res, '${perm}')`),
        `${route} is not gated by ${perm}`);
    }
  });

  test('every permission named in a route guard is a real one', () => {
    for (const m of server.matchAll(/requirePerm\(req, res, '([^']+)'\)/g)) {
      assert.ok(PERMISSION_IDS.includes(m[1]), `route guards on unknown permission "${m[1]}"`);
    }
  });
});
