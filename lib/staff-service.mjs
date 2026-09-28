// lib/staff-service.mjs — staff accounts for the admin console.
// ---------------------------------------------------------------------------
// ZoFHub has no visitor accounts and this does not add any. These are the
// people who run the site. The rules that make it safe:
//
//   · NOBODY ACTS ON THEMSELVES. You cannot change your own role, suspend or
//     delete yourself here; the owner (from the environment) is not a row and
//     cannot be touched from the console at all. That removes the whole class
//     of "admin demotes the last super admin" and "suspended admin restores
//     themselves" bugs by construction.
//   · YOU ONLY ACT BELOW YOURSELF (admin-rbac canActOnRole). An admin can
//     suspend a content manager; nobody but the owner can touch a super admin.
//   · PRIVILEGE CHANGES END SESSIONS. A role change, suspension, password reset
//     or deletion revokes every live session of that account, so a demotion is
//     effective on the very next request rather than when a cookie expires.
//   · ROLE CHANGES AND DELETION NEED A FRESH PASSWORD from the actor.
//   · DELETION ANONYMISES; IT DOES NOT ERASE. The row keeps its id and username
//     (reserved forever) because the append-only audit trail refers to them;
//     display name and password hash are cleared and the account can never log
//     in again. That is the retention policy: the evidence of who did what
//     outlives the account, the personal and credential data does not.
//   · TEMPORARY PASSWORDS ARE SHOWN ONCE. They are returned in the response that
//     creates or resets them, hashed immediately, and never written to a log or
//     an audit record.
// ---------------------------------------------------------------------------

import { randomBytes } from 'node:crypto';
import { can, canActOnRole, assignableRoles, STAFF_ROLES, ROLES } from './admin-rbac.mjs';
import { ServiceError } from './cms-service.mjs';
import { redact } from './audit-redact.mjs';

export const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{2,39}$/;
const RESERVED = new Set(['admin', 'root', 'owner', 'system', 'service-token', 'support', 'security', 'administrator']);
const COMMON = new Set(['password1234', 'password12345', '123456789012', 'qwertyuiop12', 'letmein12345', 'zofhubadmin1', 'administrator']);

/** 20 characters of base64url: ~120 bits. */
export const tempPassword = () => randomBytes(15).toString('base64url');

/** Password policy for a chosen password. Returns an error string or null. */
export function passwordProblem(pw, username = '') {
  if (typeof pw !== 'string') return 'password must be text';
  if (pw.length < 12) return 'password must be at least 12 characters';
  if (pw.length > 200) return 'password is too long';
  if (username && pw.toLowerCase().includes(String(username).toLowerCase())) return 'password must not contain the username';
  if (COMMON.has(pw.toLowerCase())) return 'that password is too common';
  if (new Set(pw).size < 5) return 'password is too repetitive';
  return null;
}

const PUBLIC_COLS = ['id', 'username', 'display_name', 'role', 'status', 'must_change_password', 'status_reason',
  'created_at', 'created_by', 'updated_at', 'updated_by', 'last_login_at', 'deleted_at'];
const view = (row) => (row ? Object.fromEntries(PUBLIC_COLS.map((k) => [k, row[k] ?? null])) : null);

export function createStaffService({ store, hashPassword, verifyPassword, audit = () => {} }) {
  const record = (actor, action, id, outcome, detail) => {
    try {
      audit({ actor, action, resourceType: 'user', resourceId: id == null ? null : String(id),
        target: id == null ? null : `user:${id}`, outcome, detail: redact(detail || null) });
    } catch { /* never fail on the audit sink */ }
  };
  const need = (actor, perm) => { if (!can(actor, perm)) throw new ServiceError(403, 'forbidden', { needed: perm }); };
  const who = (actor) => String(actor?.username || 'unknown').slice(0, 80);

  async function target(actor, id, { allowDeleted = false } = {}) {
    if (typeof id !== 'string' || id.length > 64) throw new ServiceError(400, 'bad account id');
    const row = await store.getStaff(id);
    if (!row) throw new ServiceError(404, 'no such account');
    if (row.status === 'deleted' && !allowDeleted) throw new ServiceError(409, 'this account has been deleted');
    if (actor?.userId && actor.userId === row.id) throw new ServiceError(403, 'you cannot change your own account here');
    if (!canActOnRole(actor, row.role)) throw new ServiceError(403, `your role cannot manage a ${ROLES[row.role]?.label || row.role}`);
    return row;
  }

  const svc = {
    async list(actor) {
      need(actor, 'users.read');
      const [rows, sessions] = await Promise.all([store.listStaff(), store.liveSessionCounts().catch(() => ({}))]);
      return {
        accounts: rows.map((r) => ({ ...view(r), liveSessions: sessions[r.id] || 0,
          manageable: !(actor?.userId === r.id) && canActOnRole(actor, r.role) && r.status !== 'deleted' })),
        assignableRoles: assignableRoles(actor),
        roles: STAFF_ROLES.map((r) => ({ id: r, label: ROLES[r].label, describe: ROLES[r].describe })),
      };
    },

    async get(actor, id) {
      need(actor, 'users.read');
      const row = await store.getStaff(id);
      if (!row) throw new ServiceError(404, 'no such account');
      const history = await store.auditFor('user', id, 50).catch(() => []);
      return { account: view(row), history };
    },

    async create(actor, { username, display_name, role } = {}, { reauthenticated = false } = {}) {
      need(actor, 'users.manage');
      const u = typeof username === 'string' ? username.trim().toLowerCase() : '';
      if (!USERNAME_RE.test(u)) throw new ServiceError(400, 'username must be 3–40 lowercase letters, digits, dots, hyphens or underscores');
      if (RESERVED.has(u) || u === String(process.env.ADMIN_USERNAME || '').toLowerCase()) throw new ServiceError(400, 'that username is reserved');
      if (!STAFF_ROLES.includes(role)) throw new ServiceError(400, `role must be one of ${STAFF_ROLES.join(', ')}`);
      if (!canActOnRole(actor, role)) throw new ServiceError(403, `your role cannot create a ${ROLES[role].label}`);
      let name = null;
      if (display_name !== undefined && display_name !== null && display_name !== '') {
        if (typeof display_name !== 'string' || display_name.length > 80 || /[<>]/.test(display_name)) throw new ServiceError(400, 'display name must be plain text up to 80 characters');
        name = display_name.trim();
      }
      if (await store.getStaffByUsername(u)) throw new ServiceError(409, 'that username is taken');
      // Minting a credential needs a fresh password. The response carries a
      // working temporary password, so without this, any script that could ride
      // an admin's session — third-party game code proxied on this origin is the
      // concrete case (docs/admin/CONTROL-PLANE.md §11) — could create itself an
      // account. A script can replay a session; it cannot type a password.
      if (!reauthenticated) throw new ServiceError(401, 'confirm your password to create an account', { reauth: true });
      const pw = tempPassword();
      const row = await store.insertStaff({
        username: u, display_name: name, role, status: 'active',
        password_hash: await hashPassword(pw), must_change_password: true, created_by: who(actor),
      });
      record(actor, 'user.create', row.id, 'success', { username: u, role });
      return { account: view(row), temporaryPassword: pw };
    },

    async update(actor, id, { display_name } = {}) {
      need(actor, 'users.manage');
      const row = await target(actor, id);
      if (display_name !== null && (typeof display_name !== 'string' || display_name.length > 80 || /[<>]/.test(display_name))) {
        throw new ServiceError(400, 'display name must be plain text up to 80 characters');
      }
      const next = await store.updateStaff(row.id, { display_name: display_name ? display_name.trim() : null, updated_by: who(actor) });
      record(actor, 'user.update', row.id, 'success', { display_name: { from: row.display_name, to: next.display_name } });
      return view(next);
    },

    async setRole(actor, id, role, { reauthenticated = false } = {}) {
      need(actor, 'users.roles');
      const row = await target(actor, id);
      if (!STAFF_ROLES.includes(role)) throw new ServiceError(400, `role must be one of ${STAFF_ROLES.join(', ')}`);
      if (!canActOnRole(actor, role)) throw new ServiceError(403, `your role cannot grant ${ROLES[role].label}`);
      if (role === row.role) return view(row);
      if (!reauthenticated) throw new ServiceError(401, 'confirm your password to change a role', { reauth: true });
      const next = await store.updateStaff(row.id, { role, updated_by: who(actor) });
      const revoked = await store.revokeStaffSessions(row.id, 'role_change');
      record(actor, 'user.role', row.id, 'success', { from: row.role, to: role, sessionsRevoked: revoked });
      return view(next);
    },

    async setStatus(actor, id, action, { reason } = {}) {
      need(actor, 'users.manage');
      const row = await target(actor, id);
      const r = typeof reason === 'string' ? reason.trim().slice(0, 300) : '';
      if (/[<>]/.test(r)) throw new ServiceError(400, 'reason must be plain text');
      const MOVES = {
        suspend:    { from: ['active'], to: 'suspended', needsReason: true },
        deactivate: { from: ['active', 'suspended'], to: 'deactivated', needsReason: false },
        restore:    { from: ['suspended', 'deactivated'], to: 'active', needsReason: false },
      };
      const m = MOVES[action];
      if (!m) throw new ServiceError(400, 'action must be suspend, deactivate or restore');
      if (!m.from.includes(row.status)) throw new ServiceError(409, `cannot ${action} an account that is ${row.status}`);
      if (m.needsReason && r.length < 3) throw new ServiceError(400, `a reason is required to ${action}`);
      const next = await store.updateStaff(row.id, { status: m.to, status_reason: r || null, updated_by: who(actor) });
      const revoked = m.to === 'active' ? 0 : await store.revokeStaffSessions(row.id, action);
      record(actor, `user.${action}`, row.id, 'success', { from: row.status, to: m.to, reason: r || null, sessionsRevoked: revoked });
      return view(next);
    },

    async resetPassword(actor, id, { reauthenticated = false } = {}) {
      need(actor, 'users.manage');
      const row = await target(actor, id);
      if (!reauthenticated) throw new ServiceError(401, 'confirm your password to issue a new password', { reauth: true });
      const pw = tempPassword();
      await store.updateStaff(row.id, { password_hash: await hashPassword(pw), must_change_password: true, updated_by: who(actor) });
      const revoked = await store.revokeStaffSessions(row.id, 'password_reset');
      record(actor, 'user.password_reset', row.id, 'success', { sessionsRevoked: revoked });
      return { temporaryPassword: pw };
    },

    async revokeSessions(actor, id) {
      need(actor, 'users.manage');
      const row = await target(actor, id);
      const n = await store.revokeStaffSessions(row.id, 'revoked_by_admin');
      record(actor, 'user.sessions_revoked', row.id, 'success', { revoked: n });
      return { revoked: n };
    },

    async remove(actor, id, { confirm, reauthenticated = false } = {}) {
      need(actor, 'users.delete');
      const row = await target(actor, id);
      if (!reauthenticated) throw new ServiceError(401, 'confirm your password to delete an account', { reauth: true });
      if (confirm !== row.username) throw new ServiceError(400, `type the username (${row.username}) to confirm`);
      const next = await store.updateStaff(row.id, {
        status: 'deleted', display_name: null, password_hash: null, must_change_password: false,
        status_reason: `deleted by ${who(actor)}`, deleted_at: new Date().toISOString(), updated_by: who(actor),
      });
      const revoked = await store.revokeStaffSessions(row.id, 'account_deleted');
      record(actor, 'user.delete', row.id, 'success', { username: row.username, role: row.role, sessionsRevoked: revoked });
      return view(next);
    },

    /** Login lookup. Returns the row for an ACTIVE account whose password matches, else null. */
    async authenticate(username, password) {
      const u = typeof username === 'string' ? username.trim().toLowerCase() : '';
      const row = USERNAME_RE.test(u) ? await store.getStaffByUsername(u).catch(() => null) : null;
      // Verify even when there is no row, so a missing account is not measurably
      // faster to reject than a wrong password.
      const ok = await verifyPassword(password, row?.password_hash || 'scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==');
      if (!row || !ok) return { user: null, reason: row ? 'bad_password' : 'unknown_user' };
      if (row.status !== 'active') return { user: null, reason: `account_${row.status}` };
      return { user: row, reason: 'ok' };
    },

    async noteLogin(id) { try { await store.updateStaff(id, { last_login_at: new Date().toISOString() }); } catch {} },

    /** A staff member changing their OWN password (the only self-service path). */
    async changeOwnPassword(principal, current, next) {
      if (!principal?.userId) throw new ServiceError(400, 'the owner password is set in the environment (npm run admin-hash)');
      const row = await store.getStaff(principal.userId);
      if (!row || row.status !== 'active') throw new ServiceError(403, 'account is not active');
      if (!(await verifyPassword(current, row.password_hash))) {
        record(principal, 'user.password_change', row.id, 'failure', { reason: 'bad current password' });
        throw new ServiceError(400, 'current password is wrong');
      }
      const problem = passwordProblem(next, row.username);
      if (problem) throw new ServiceError(400, problem);
      if (await verifyPassword(next, row.password_hash)) throw new ServiceError(400, 'choose a password you have not used for this account');
      await store.updateStaff(row.id, { password_hash: await hashPassword(next), must_change_password: false, updated_by: row.username });
      record(principal, 'user.password_change', row.id, 'success');
      return { changed: true };
    },
  };
  return svc;
}

export default { createStaffService, passwordProblem, tempPassword, USERNAME_RE };
