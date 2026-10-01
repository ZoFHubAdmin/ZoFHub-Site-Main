// Staff accounts: the hierarchy, self-protection, step-up confirmation, session
// revocation on privilege change, and deletion-as-anonymisation. Uses the real
// scrypt hashing from lib/admin-auth.mjs.

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../lib/cms-store-memory.mjs';
import { createStaffService, passwordProblem } from '../lib/staff-service.mjs';
import { ServiceError } from '../lib/cms-service.mjs';
import { hashPassword, verifyPassword } from '../lib/admin-auth.mjs';

const OWNER = { username: 'owner', via: 'session' };              // env account: no role, no userId
let store, audit, staff;
beforeEach(() => {
  store = createMemoryStore();
  audit = [];
  staff = createStaffService({ store, hashPassword, verifyPassword, audit: (e) => audit.push(e) });
});
const RE = { reauthenticated: true };
const principal = (acct) => ({ username: acct.username, via: 'session', role: acct.role, userId: acct.id });
const rejects = (fn, status, re) => assert.rejects(fn, (e) => {
  assert.ok(e instanceof ServiceError, e?.message);
  assert.equal(e.status, status, e.message);
  if (re) assert.match(e.message, re);
  return true;
});

describe('the hierarchy', () => {
  test('only the owner can mint a super admin', async () => {
    const sa = (await staff.create(OWNER, { username: 'sue', role: 'super_admin' }, RE)).account;
    await rejects(() => staff.create(principal(sa), { username: 'sam', role: 'super_admin' }, RE), 403);
    const ad = (await staff.create(principal(sa), { username: 'ada', role: 'admin' }, RE)).account;
    await rejects(() => staff.create(principal(ad), { username: 'alan', role: 'admin' }, RE), 403);
    await staff.create(principal(ad), { username: 'edith', role: 'content_manager' }, RE);
  });

  test('two super admins cannot act on each other; nobody acts on themselves', async () => {
    const a = (await staff.create(OWNER, { username: 'sue', role: 'super_admin' }, RE)).account;
    const b = (await staff.create(OWNER, { username: 'sid', role: 'super_admin' }, RE)).account;
    await rejects(() => staff.setStatus(principal(a), b.id, 'suspend', { reason: 'test' }), 403);
    await rejects(() => staff.setStatus(principal(a), a.id, 'suspend', { reason: 'test' }), 403, /your own/);
    await rejects(() => staff.setRole(principal(a), a.id, 'admin', { reauthenticated: true }), 403);
  });

  test('a content manager cannot see or touch accounts at all', async () => {
    const cm = (await staff.create(OWNER, { username: 'edith', role: 'content_manager' }, RE)).account;
    await rejects(() => staff.list(principal(cm)), 403);
    await rejects(() => staff.create(principal(cm), { username: 'x1y', role: 'support' }, RE), 403);
  });

  test('reserved and malformed usernames are refused', async () => {
    for (const u of ['admin', 'root', 'Owner', 'a', 'has space', '<script>']) {
      await rejects(() => staff.create(OWNER, { username: u, role: 'support' }, RE), 400);
    }
  });
});

describe('credentials', () => {
  test('minting a credential — creating an account, resetting a password — needs a fresh password', async () => {
    await rejects(() => staff.create(OWNER, { username: 'edith', role: 'content_manager' }), 401);
    const { account } = await staff.create(OWNER, { username: 'edith', role: 'content_manager' }, RE);
    await rejects(() => staff.resetPassword(OWNER, account.id), 401);
    const r = await staff.resetPassword(OWNER, account.id, RE);
    assert.ok(r.temporaryPassword.length >= 20);
  });

  test('a temporary password is returned once, stored only as a hash, and never audited', async () => {
    const { account, temporaryPassword } = await staff.create(OWNER, { username: 'edith', role: 'content_manager' }, RE);
    assert.ok(temporaryPassword.length >= 20);
    const row = await store.getStaff(account.id);
    assert.match(row.password_hash, /^scrypt\$/);
    assert.ok(!row.password_hash.includes(temporaryPassword));
    assert.equal('password_hash' in account, false, 'the hash left the service');
    assert.ok(!JSON.stringify(audit).includes(temporaryPassword), 'the temporary password reached the audit trail');
    assert.equal(row.must_change_password, true);
  });

  test('authenticate: right password works; wrong, unknown and suspended do not', async () => {
    const { account, temporaryPassword } = await staff.create(OWNER, { username: 'edith', role: 'content_manager' }, RE);
    assert.equal((await staff.authenticate('edith', temporaryPassword)).user.id, account.id);
    assert.equal((await staff.authenticate('edith', 'wrong-password')).user, null);
    assert.equal((await staff.authenticate('nobody', 'whatever')).reason, 'unknown_user');
    await staff.setStatus(OWNER, account.id, 'suspend', { reason: 'left the team' });
    const r = await staff.authenticate('edith', temporaryPassword);
    assert.equal(r.user, null);
    assert.equal(r.reason, 'account_suspended');
  });

  test('changing your own password enforces the policy and clears the temporary flag', async () => {
    const { account, temporaryPassword } = await staff.create(OWNER, { username: 'edith', role: 'content_manager' }, RE);
    const me = principal(account);
    await rejects(() => staff.changeOwnPassword(me, 'wrong', 'a-long-enough-password'), 400, /current/);
    await rejects(() => staff.changeOwnPassword(me, temporaryPassword, 'short'), 400, /12/);
    await rejects(() => staff.changeOwnPassword(me, temporaryPassword, 'edith-is-great-99'), 400, /username/);
    await staff.changeOwnPassword(me, temporaryPassword, 'correct horse battery staple');
    assert.equal((await store.getStaff(account.id)).must_change_password, false);
    assert.equal(passwordProblem('aaaaaaaaaaaaaa'), 'password is too repetitive');
  });
});

describe('privilege changes', () => {
  test('a role change needs a fresh password and ends every session', async () => {
    const { account } = await staff.create(OWNER, { username: 'edith', role: 'content_manager' }, RE);
    store._sessions.set(account.id, 3);
    await rejects(() => staff.setRole(OWNER, account.id, 'moderator', { reauthenticated: false }), 401);
    const r = await staff.setRole(OWNER, account.id, 'moderator', { reauthenticated: true });
    assert.equal(r.role, 'moderator');
    assert.deepEqual(store._revocations.at(-1), { userId: account.id, reason: 'role_change', n: 3 });
    const e = audit.find((a) => a.action === 'user.role');
    assert.deepEqual([e.detail.from, e.detail.to], ['content_manager', 'moderator']);
  });

  test('suspension needs a reason and revokes sessions', async () => {
    const { account } = await staff.create(OWNER, { username: 'edith', role: 'content_manager' }, RE);
    await rejects(() => staff.setStatus(OWNER, account.id, 'suspend', {}), 400, /reason/);
    await staff.setStatus(OWNER, account.id, 'suspend', { reason: 'investigating' });
    assert.equal(store._revocations.at(-1).reason, 'suspend');
    await staff.setStatus(OWNER, account.id, 'restore');
    assert.equal((await store.getStaff(account.id)).status, 'active');
  });
});

describe('deletion is anonymisation, and the audit trail survives it', () => {
  test('credentials and display name are cleared; the username stays reserved', async () => {
    const { account } = await staff.create(OWNER, { username: 'edith', display_name: 'Edith E.', role: 'content_manager' }, RE);
    await rejects(() => staff.remove(OWNER, account.id, { confirm: 'edith', reauthenticated: false }), 401);
    await rejects(() => staff.remove(OWNER, account.id, { confirm: 'EDITH', reauthenticated: true }), 400);
    await staff.remove(OWNER, account.id, { confirm: 'edith', reauthenticated: true });
    const row = await store.getStaff(account.id);
    assert.equal(row.status, 'deleted');
    assert.equal(row.password_hash, null);
    assert.equal(row.display_name, null);
    assert.equal((await staff.authenticate('edith', 'anything')).user, null);
    await rejects(() => staff.create(OWNER, { username: 'edith', role: 'support' }, RE), 409, /taken/);
    assert.ok(audit.some((a) => a.action === 'user.create') && audit.some((a) => a.action === 'user.delete'));
  });
});
