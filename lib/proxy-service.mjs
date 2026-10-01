// lib/proxy-service.mjs — persistence, authorisation and audit for proxy control.
// ---------------------------------------------------------------------------
// lib/proxy-control.mjs decides; this file changes what it decides with. Every
// write is permission-checked, validated, stored, audited with before/after,
// and then pushed into the live governor — so an approval or a revocation
// takes effect on the very next connection, without a restart.
//
// Widening the proxy is treated as the sensitive direction: approving a
// destination and raising a limit need a fresh password; revoking, lowering a
// limit and terminating a session do not, because an operator responding to an
// incident must never be slowed down by a confirmation prompt.
//
// Without a database the targets come from PROXY_APPROVED_TARGETS alone and are
// read-only here; with neither, every destination is refused. Fail closed.
// ---------------------------------------------------------------------------

import { can } from './admin-rbac.mjs';
import {
  ENGINES, ENGINE_IDS, DEFAULT_POLICY, validateTargetInput, validatePolicy, targetsFromEnv,
} from './proxy-control.mjs';
import { ServiceError } from './cms-service.mjs';
import { diffFields, redact } from './audit-redact.mjs';
import { StoreError, STORE_HTTP } from './cms-store-errors.mjs';

export function createProxyService({ store = null, governor, sessions, audit = () => {}, env = process.env, now = () => new Date(), onPolicy = () => {} } = {}) {
  let dbTargets = [];
  let envTargets = [];
  let engineState = Object.fromEntries(ENGINES.map((e) => [e.id, { enabled: e.defaultEnabled !== false, notes: null, updated_at: null, updated_by: null }]));
  let policy = { ...DEFAULT_POLICY };
  const problems = [];

  const need = (actor, perm) => { if (!can(actor, perm)) throw new ServiceError(403, 'forbidden', { needed: perm }); };
  const who = (a) => String(a?.username || 'unknown').slice(0, 80);
  const record = (actor, action, id, outcome, detail) => {
    try {
      audit({ actor, action, resourceType: 'proxy', resourceId: id == null ? null : String(id),
        target: id == null ? 'proxy' : `proxy:${id}`, outcome, detail: redact(detail || null) });
    } catch { /* never fail on the audit sink */ }
  };
  const wrap = async (fn) => {
    try { return await fn(); }
    catch (e) {
      if (e instanceof ServiceError) throw e;
      if (e instanceof StoreError) throw new ServiceError(STORE_HTTP[e.code] || 500, e.message);
      throw e;
    }
  };
  const needStore = () => { if (!store) throw new ServiceError(503, 'proxy targets are managed in the database, which is not configured — use PROXY_APPROVED_TARGETS'); };

  // Stored rows are re-validated before the governor sees them. The database
  // has its own CHECK, but a row written around the console — by hand in the
  // SQL editor, by a seed, by a future migration — must not be able to add a
  // destination the console itself would refuse (a public-suffix wildcard, a
  // wildcard-DNS name). Invalid rows are reported and ignored, never applied.
  function vetted(rows) {
    const ok = [];
    for (const r of rows) {
      const v = validateTargetInput({ pattern: r.pattern, ports: r.ports, purpose: r.purpose || 'stored destination' }, { now: now() });
      if (v.ok) ok.push(r);
      else if (!problems.some((p) => p.includes(String(r.pattern)))) problems.push(`destination "${String(r.pattern).slice(0, 80)}" ignored: ${v.errors.join('; ')}`);
    }
    return ok;
  }

  function apply() {
    governor.setTargets([...envTargets, ...vetted(dbTargets)]);
    governor.setPolicy(policy);
    onPolicy(policy, engineState);
  }

  const svc = {
    async load() {
      problems.length = 0;
      // The environment supplies the starting access mode (PROXY_ACCESS_MODE);
      // a policy saved in the console replaces it. Invalid values are reported
      // and ignored — never widened.
      policy = { ...DEFAULT_POLICY };
      if (String(env.PROXY_ACCESS_MODE || '').trim()) {
        const v = validatePolicy({ accessMode: String(env.PROXY_ACCESS_MODE).trim().toLowerCase() });
        if (v.ok) policy = v.value; else problems.push(`PROXY_ACCESS_MODE: ${v.errors.join('; ')}`);
      }
      const e = targetsFromEnv(env.PROXY_APPROVED_TARGETS, now());
      envTargets = e.rows;
      problems.push(...e.errors.map((x) => `PROXY_APPROVED_TARGETS: ${x}`));
      if (store) {
        try { dbTargets = await store.listTargets(); }
        catch (err) { problems.push(`targets could not be read (${err.message}); only environment targets apply`); dbTargets = []; }
        try {
          const row = await store.getProxyPolicy();
          if (row?.policy) {
            const v = validatePolicy(row.policy);
            if (v.ok) policy = v.value; else problems.push(`stored proxy policy ignored: ${v.errors.join('; ')}`);
          }
        } catch (err) { problems.push(`proxy policy could not be read (${err.message}); defaults apply`); }
        try {
          for (const r of await store.listProxyProviders()) {
            if (ENGINE_IDS.includes(r.id)) engineState[r.id] = { enabled: !!r.enabled, notes: r.notes || null, updated_at: r.updated_at, updated_by: r.updated_by };
          }
        } catch (err) { problems.push(`engine state could not be read (${err.message}); every engine enabled`); }
      }
      apply();
      return svc.snapshot();
    },

    get policy() { return { ...policy }; },
    engineEnabled: (id) => engineState[id]?.enabled !== false,
    status: () => ({ problems: [...problems], envTargets: envTargets.length, dbTargets: dbTargets.length, database: !!store }),

    snapshot() {
      return {
        policy: { ...policy },
        engines: ENGINES.map((e) => ({ ...e, ...engineState[e.id] })),
        targets: { approved: [...envTargets, ...dbTargets].filter((t) => t.status === 'approved').length, total: envTargets.length + dbTargets.length },
      };
    },

    /** What the public proxy page may show: approved destinations, no internals. */
    publicView() {
      const t = now().getTime();
      return {
        accessMode: policy.accessMode,
        engines: ENGINES.filter((e) => engineState[e.id]?.enabled !== false).map((e) => e.id),
        destinations: [...envTargets, ...dbTargets]
          .filter((r) => r.status === 'approved' && (!r.expires_at || Date.parse(r.expires_at) > t))
          .map((r) => ({ pattern: r.pattern, purpose: r.purpose })),
      };
    },

    async listTargets(actor) {
      need(actor, 'proxy.read');
      return [...envTargets.map((r) => ({ ...r, readOnly: true })), ...dbTargets.map((r) => ({ ...r, source: 'console' }))];
    },

    async createTarget(actor, input) {
      need(actor, 'proxy.targets');
      return wrap(async () => {
        needStore();
        const { ok, value, errors } = validateTargetInput(input, { now: now() });
        if (!ok) throw new ServiceError(400, 'invalid destination', { errors });
        // Created as a PROPOSAL. Approval is a separate, re-authenticated act,
        // so no single click takes a new destination live.
        const row = await store.insertTarget({ ...value, status: 'pending', created_by: who(actor), updated_by: who(actor) });
        record(actor, 'proxy.target.create', row.id, 'success', { pattern: row.pattern, ports: row.ports, purpose: row.purpose });
        dbTargets = await store.listTargets(); apply();
        return row;
      });
    },

    async updateTarget(actor, id, input) {
      need(actor, 'proxy.targets');
      return wrap(async () => {
        needStore();
        const cur = await store.getTarget(id);
        if (!cur) throw new ServiceError(404, 'no such destination');
        const { ok, value, errors } = validateTargetInput(input, { partial: true, now: now() });
        if (!ok) throw new ServiceError(400, 'invalid destination', { errors });
        // Changing WHAT an approved entry matches is a new approval.
        const widens = cur.status === 'approved' && (('pattern' in value && value.pattern !== cur.pattern)
          || ('ports' in value && value.ports.some((p) => !cur.ports.includes(p))));
        const patch = { ...value, updated_by: who(actor), ...(widens ? { status: 'pending', approved_by: null, approved_at: null } : {}) };
        const next = await store.updateTarget(cur.id, patch);
        record(actor, 'proxy.target.update', cur.id, 'success', { changes: diffFields(cur, next, ['pattern', 'ports', 'purpose', 'owner', 'expires_at', 'status']), ...(widens ? { reapprovalRequired: true } : {}) });
        dbTargets = await store.listTargets(); apply();
        return next;
      });
    },

    async setTargetStatus(actor, id, action, { reauthenticated = false } = {}) {
      need(actor, 'proxy.targets');
      return wrap(async () => {
        needStore();
        const cur = await store.getTarget(id);
        if (!cur) throw new ServiceError(404, 'no such destination');
        if (!['approve', 'revoke'].includes(action)) throw new ServiceError(400, 'action must be approve or revoke');
        if (action === 'approve') {
          if (cur.status === 'approved') return cur;
          if (!reauthenticated) throw new ServiceError(401, 'confirm your password to approve a proxy destination', { reauth: true });
          if (cur.expires_at && Date.parse(cur.expires_at) <= now().getTime()) throw new ServiceError(409, 'this destination has expired — set a new expiry first');
          // Re-validate at approval time: the rules may have tightened since
          // the proposal was made.
          const v = validateTargetInput({ pattern: cur.pattern, ports: cur.ports, purpose: cur.purpose }, { now: now() });
          if (!v.ok) throw new ServiceError(409, 'this destination no longer passes validation', { errors: v.errors });
        }
        const patch = action === 'approve'
          ? { status: 'approved', approved_by: who(actor), approved_at: now().toISOString(), updated_by: who(actor) }
          : { status: 'revoked', updated_by: who(actor) };
        const next = await store.updateTarget(cur.id, patch);
        record(actor, `proxy.target.${action}`, cur.id, 'success', { pattern: cur.pattern, from: cur.status, to: next.status });
        dbTargets = await store.listTargets(); apply();
        return next;
      });
    },

    async deleteTarget(actor, id) {
      need(actor, 'proxy.targets');
      return wrap(async () => {
        needStore();
        const cur = await store.getTarget(id);
        if (!cur) throw new ServiceError(404, 'no such destination');
        if (cur.status === 'approved') throw new ServiceError(409, 'revoke an approved destination before deleting it');
        await store.deleteTarget(cur.id);
        record(actor, 'proxy.target.delete', cur.id, 'success', { pattern: cur.pattern });
        dbTargets = await store.listTargets(); apply();
        return { deleted: true };
      });
    },

    async setPolicy(actor, input, { reauthenticated = false } = {}) {
      need(actor, 'proxy.policy');
      return wrap(async () => {
        needStore();
        const { ok, value, errors } = validatePolicy({ ...policy, ...(input && typeof input === 'object' ? input : {}) });
        if (!ok) throw new ServiceError(400, 'invalid policy', { errors });
        if (value.accessMode !== policy.accessMode) need(actor, 'proxy.manage');
        const widens = ['maxTunnels', 'maxPerClient', 'streamsPerTunnel', 'idleMinutes', 'maxSessionMinutes'].some((k) => value[k] > policy[k])
          || value.allowedPorts.some((p) => !policy.allowedPorts.includes(p))
          || (policy.accessMode !== 'public' && value.accessMode === 'public');
        if (widens && !reauthenticated) throw new ServiceError(401, 'confirm your password to raise a proxy limit or open access', { reauth: true });
        const before = { ...policy };
        await store.putProxyPolicy(value, who(actor));
        policy = value; apply();
        record(actor, 'proxy.policy.update', 'policy', 'success', { changes: diffFields(before, value, Object.keys(DEFAULT_POLICY)) });
        return { ...policy };
      });
    },

    async setEngine(actor, id, { enabled, notes } = {}) {
      need(actor, 'proxy.manage');
      return wrap(async () => {
        needStore();
        if (!ENGINE_IDS.includes(id)) throw new ServiceError(404, 'no such engine');
        if (typeof enabled !== 'boolean') throw new ServiceError(400, 'enabled must be true or false');
        let n = null;
        if (notes !== undefined && notes !== null) {
          if (typeof notes !== 'string' || notes.length > 300 || /[<>]/.test(notes)) throw new ServiceError(400, 'notes must be plain text up to 300 characters');
          n = notes.trim();
        }
        const before = engineState[id].enabled;
        const row = await store.putProxyProvider({ id, enabled, notes: n, updated_by: who(actor) });
        engineState[id] = { enabled: row.enabled, notes: row.notes || null, updated_at: row.updated_at, updated_by: row.updated_by };
        apply();
        record(actor, enabled ? 'proxy.engine.enable' : 'proxy.engine.disable', id, 'success', { from: before, to: enabled });
        return engineState[id];
      });
    },

    listSessions(actor) {
      need(actor, 'proxy.read');
      return { live: sessions.list(), recent: sessions.history().slice(0, 50), stats: sessions.stats() };
    },

    terminateSession(actor, id) {
      need(actor, 'proxy.sessions');
      if (typeof id !== 'string' || !/^[0-9a-f]{12}$/.test(id)) throw new ServiceError(400, 'bad session id');
      const ok = sessions.terminate(id, 'terminated_by_admin');
      if (!ok) throw new ServiceError(404, 'no such live session');
      record(actor, 'proxy.session.terminate', id, 'success');
      return { terminated: true };
    },

    clearUnlisted(actor) {
      need(actor, 'proxy.targets');
      governor.forgetUnlisted();
      record(actor, 'proxy.unlisted.clear', null, 'success');
      return { cleared: true };
    },
  };
  return svc;
}

export default { createProxyService };
