// lib/admin-api.mjs — the control-plane HTTP API.
// ---------------------------------------------------------------------------
// Every route here is registered through ONE helper, `add()`, and the helper is
// where the security properties live — so no route can forget them:
//
//   1. authentication + authorisation   requirePerm(req, res, perm) — which
//                                       authenticates FIRST (401) and only then
//                                       checks the permission (403, audited)
//   2. CSRF + Origin                    requireAdminCsrf on every non-GET, with
//                                       no opt-out parameter to misuse
//   3. rate limiting                    per ADMIN principal, not per IP, in
//                                       three budgets (read / write / expensive)
//   4. large bodies only after 1–3      the import routes parse their bigger
//                                       body only once the caller is authorised
//   5. safe errors                      a ServiceError becomes its status and a
//                                       plain message; anything else is a
//                                       generic 500 with the detail logged
//
// add() also refuses, at boot, to register a route whose permission the model
// does not define. The route table is exported so the test suite can prove the
// properties above hold for every route, including ones added later.
//
// The permission on a route is the COARSE gate ("may this principal touch
// games at all"). The service layer then decides the specific action — may
// THIS actor publish THIS game from THIS state — and a refusal there is also
// a 403 and also audited.
// ---------------------------------------------------------------------------

import express from 'express';
import { PERMISSION_IDS } from './admin-rbac.mjs';
import { ServiceError } from './cms-service.mjs';

const ID_RE = /^\d{1,12}$/;
const STAFF_ID_RE = /^[A-Za-z0-9-]{1,64}$/;
const SLUGISH_RE = /^[a-z0-9][a-z0-9 &-]{0,39}$/;

/** A CSV cell that no spreadsheet will execute. */
export function csvCell(v) {
  let s = v === null || v === undefined ? '' : (typeof v === 'object' ? JSON.stringify(v) : String(v));
  // Formula injection: a cell beginning = + - @ (or a tab / CR) is evaluated by
  // Excel and Sheets. A leading apostrophe makes it inert text.
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function mountAdminApi(app, deps) {
  const routes = [];
  const bodyParsers = new Map();

  const svc = (name) => {
    const s = deps.services[name]?.();
    if (!s) throw new ServiceError(503, deps.unavailableReason?.(name) || `${name} is not available`);
    return s;
  };

  function parseBody(req, res, limit) {
    if (!bodyParsers.has(limit)) bodyParsers.set(limit, express.json({ limit }));
    return new Promise((resolve, reject) => bodyParsers.get(limit)(req, res, (err) => (err ? reject(err) : resolve())));
  }

  function add(method, path, perm, handler, opts = {}) {
    if (!PERMISSION_IDS.includes(perm)) throw new Error(`admin-api: ${method.toUpperCase()} ${path} guards on unknown permission "${perm}"`);
    if (!path.startsWith('/api/admin/')) throw new Error(`admin-api: ${path} is outside /api/admin/`);
    const write = method !== 'get';
    const scope = opts.limit || (write ? 'adminWrite' : 'adminRead');
    routes.push({ method: method.toUpperCase(), path, perm, csrf: write, limit: scope, bodyLimit: opts.bodyLimit || null });

    app[method](path, async (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      if (!deps.requirePerm(req, res, perm)) return;
      if (write && !deps.requireAdminCsrf(req, res)) return;
      const actor = deps.actorOf(req);
      const gate = deps.limiter.allow(scope, `admin:${actor.username}`);
      if (!gate) {
        res.setHeader('Retry-After', String(deps.limiter.retryAfterSec(scope, `admin:${actor.username}`) || 5));
        return res.status(429).json({ ok: false, error: 'Too many admin requests — slow down and retry shortly.' });
      }
      if (opts.bodyLimit) {
        try { await parseBody(req, res, opts.bodyLimit); }
        catch (e) {
          return res.status(e.type === 'entity.too.large' ? 413 : 400)
            .json({ ok: false, error: e.type === 'entity.too.large' ? `the upload is larger than ${opts.bodyLimit}` : 'the upload is not valid JSON' });
        }
      }
      try {
        const out = await handler(req, actor, res);
        if (res.headersSent) return;
        res.json({ ok: true, ...(out && typeof out === 'object' && !Array.isArray(out) ? out : { data: out ?? null }) });
      } catch (e) {
        if (e instanceof ServiceError) {
          if (e.status === 403) deps.auditDenied(req, e.needed || perm, e.message);
          const body = { ok: false, error: e.message };
          for (const k of ['errors', 'needed', 'reauth', 'failures', 'confirmRequired', 'requested', 'valid', 'op', 'plan', 'code']) {
            if (e[k] !== undefined) body[k] = e[k];
          }
          return res.status(e.status).json(body);
        }
        deps.log(`[admin-api] ${method.toUpperCase()} ${path} failed:`, e?.message || e);
        return res.status(500).json({ ok: false, error: 'internal error' });
      }
    });
  }

  const idParam = (req) => {
    if (!ID_RE.test(String(req.params.id || ''))) throw new ServiceError(400, 'bad id');
    return Number(req.params.id);
  };
  const body = (req) => (req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {});
  const reauth = (req) => deps.isRecentAuth(req);

  // ── Status: is the control plane usable here? ────────────────────────────
  add('get', '/api/admin/cms/status', 'games.read', async () => deps.status());

  // ── Games ────────────────────────────────────────────────────────────────
  add('get', '/api/admin/cms/games', 'games.read', (req, a) => svc('cms').listGames(a, req.query));
  add('post', '/api/admin/cms/games', 'games.create', async (req, a) => ({ game: await svc('cms').createGame(a, body(req)) }));
  add('get', '/api/admin/cms/games/:id', 'games.read', (req, a) => svc('cms').getGame(a, idParam(req)));
  add('patch', '/api/admin/cms/games/:id', 'games.update', (req, a) => {
    const b = body(req);
    return svc('cms').updateGame(a, idParam(req), b.changes, { expectUpdatedAt: typeof b.expectUpdatedAt === 'string' ? b.expectUpdatedAt : null });
  });
  add('post', '/api/admin/cms/games/:id/transition', 'games.read', async (req, a) => {
    const b = body(req);
    return { game: await svc('cms').transition(a, idParam(req), String(b.action || ''), {
      note: b.note, expectUpdatedAt: typeof b.expectUpdatedAt === 'string' ? b.expectUpdatedAt : null,
    }) };
  });
  add('delete', '/api/admin/cms/games/:id', 'games.delete', (req, a) =>
    svc('cms').deleteGame(a, idParam(req), { confirm: body(req).confirm, reauthenticated: reauth(req) }));
  add('get', '/api/admin/cms/games/:id/history', 'games.read', async (req, a) => ({ history: await svc('cms').history(a, idParam(req)) }));
  add('post', '/api/admin/cms/bulk', 'games.bulk', (req, a) => {
    const b = body(req);
    return svc('cms').bulk(a, { ids: b.ids, op: b.op, value: b.value, preview: b.preview === true, confirm: b.confirm });
  }, { limit: 'adminExpensive' });

  // Export — JSON or CSV, audited, rate limited as an expensive read.
  add('get', '/api/admin/cms/export', 'games.read', async (req, a, res) => {
    const status = typeof req.query.status === 'string' ? req.query.status.slice(0, 20) : undefined;
    const provider = typeof req.query.provider === 'string' ? req.query.provider.slice(0, 40) : undefined;
    const rows = await svc('cms').exportGames(a, { status: status || undefined, provider: provider || undefined });
    const stamp = new Date().toISOString().slice(0, 10);
    if (req.query.format === 'csv') {
      const cols = ['id', 'slug', 'title', 'status', 'provider_id', 'external_id', 'category', 'featured', 'sort_order', 'is_working', 'thumbnail_url', 'updated_at', 'updated_by'];
      const csv = [cols.join(','), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(','))].join('\r\n');
      res.setHeader('Content-Disposition', `attachment; filename="zofhub-games-${stamp}.csv"`);
      return res.type('text/csv; charset=utf-8').send(csv);
    }
    res.setHeader('Content-Disposition', `attachment; filename="zofhub-games-${stamp}.json"`);
    return res.json({ ok: true, exportedAt: new Date().toISOString(), rows });
  }, { limit: 'adminExpensive' });

  // File import: preview first, then apply with the exact count. Larger body,
  // parsed only after authorisation.
  add('post', '/api/admin/cms/import/preview', 'games.create', async (req, a) => {
    const plan = await svc('cms').importPreview(a, body(req).games);
    return { total: plan.total, valid: plan.valid.map((v) => ({ index: v.index, slug: v.slug, title: v.title })), invalid: plan.invalid };
  }, { limit: 'adminExpensive', bodyLimit: '2mb' });
  add('post', '/api/admin/cms/import/apply', 'games.create', (req, a) =>
    svc('cms').importApply(a, body(req).games, { confirm: body(req).confirm }), { limit: 'adminExpensive', bodyLimit: '2mb' });

  // Provider feed import (GameDistribution). Runs in the background; one at a time.
  add('get', '/api/admin/cms/import/gamedistribution', 'games.read', async () => ({ job: deps.gdImport.status() }));
  add('post', '/api/admin/cms/import/gamedistribution', 'games.import', async (req, a) => {
    const b = body(req);
    let onlyIds = null;
    if (b.onlyIds !== undefined) {
      if (!Array.isArray(b.onlyIds) || b.onlyIds.length > 50 || b.onlyIds.some((x) => typeof x !== 'string' || !/^[0-9a-f]{32}$/i.test(x))) {
        throw new ServiceError(400, 'onlyIds must be up to 50 GameDistribution ids (32 hex characters)');
      }
      onlyIds = b.onlyIds.map((x) => x.toLowerCase());
    }
    return { job: deps.gdImport.start(a, { dryRun: b.dryRun === true, onlyIds }) };
  }, { limit: 'adminExpensive' });

  // ── Taxonomy ─────────────────────────────────────────────────────────────
  add('get', '/api/admin/cms/categories', 'games.read', async (req, a) => ({ categories: await svc('cms').listCategories(a) }));
  add('post', '/api/admin/cms/categories', 'taxonomy.manage', async (req, a) => ({ category: await svc('cms').createCategory(a, body(req)) }));
  add('post', '/api/admin/cms/categories/reorder', 'taxonomy.manage', async (req, a) => ({ results: await svc('cms').reorderCategories(a, body(req).order) }));
  add('patch', '/api/admin/cms/categories/:slug', 'taxonomy.manage', async (req, a) => {
    if (!SLUGISH_RE.test(req.params.slug)) throw new ServiceError(400, 'bad category');
    return { category: await svc('cms').updateCategory(a, req.params.slug, body(req)) };
  });
  add('delete', '/api/admin/cms/categories/:slug', 'taxonomy.manage', (req, a) => {
    if (!SLUGISH_RE.test(req.params.slug)) throw new ServiceError(400, 'bad category');
    return svc('cms').deleteCategory(a, req.params.slug);
  });
  add('get', '/api/admin/cms/tags', 'games.read', async (req, a) => ({ tags: await svc('cms').listTags(a, req.query.q) }));
  add('delete', '/api/admin/cms/tags/:slug', 'taxonomy.manage', (req, a) => svc('cms').deleteTag(a, req.params.slug));

  // ── Providers ────────────────────────────────────────────────────────────
  add('get', '/api/admin/cms/providers', 'games.read', async (req, a) => ({ providers: await svc('cms').listProviders(a) }));
  add('post', '/api/admin/cms/providers', 'providers.manage', async (req, a) => ({ provider: await svc('cms').createProvider(a, body(req)) }));
  add('patch', '/api/admin/cms/providers/:pid', 'providers.manage', async (req, a) => {
    if (!/^[a-z0-9][a-z0-9-]{1,39}$/.test(req.params.pid)) throw new ServiceError(400, 'bad provider id');
    return { provider: await svc('cms').updateProvider(a, req.params.pid, body(req), { reauthenticated: reauth(req) }) };
  });

  // ── Staff ────────────────────────────────────────────────────────────────
  const staffId = (req) => { if (!STAFF_ID_RE.test(req.params.uid || '')) throw new ServiceError(400, 'bad account id'); return req.params.uid; };
  add('get', '/api/admin/staff', 'users.read', (req, a) => svc('staff').list(a));
  add('post', '/api/admin/staff', 'users.manage', (req, a) => svc('staff').create(a, body(req), { reauthenticated: reauth(req) }));
  add('get', '/api/admin/staff/:uid', 'users.read', (req, a) => svc('staff').get(a, staffId(req)));
  add('patch', '/api/admin/staff/:uid', 'users.manage', async (req, a) => ({ account: await svc('staff').update(a, staffId(req), body(req)) }));
  add('post', '/api/admin/staff/:uid/role', 'users.roles', async (req, a) =>
    ({ account: await svc('staff').setRole(a, staffId(req), body(req).role, { reauthenticated: reauth(req) }) }));
  add('post', '/api/admin/staff/:uid/status', 'users.manage', async (req, a) =>
    ({ account: await svc('staff').setStatus(a, staffId(req), body(req).action, { reason: body(req).reason }) }));
  add('post', '/api/admin/staff/:uid/password-reset', 'users.manage', (req, a) => svc('staff').resetPassword(a, staffId(req), { reauthenticated: reauth(req) }));
  add('post', '/api/admin/staff/:uid/revoke-sessions', 'users.manage', (req, a) => svc('staff').revokeSessions(a, staffId(req)));
  add('delete', '/api/admin/staff/:uid', 'users.delete', async (req, a) =>
    ({ account: await svc('staff').remove(a, staffId(req), { confirm: body(req).confirm, reauthenticated: reauth(req) }) }));

  // ── Settings ─────────────────────────────────────────────────────────────
  add('get', '/api/admin/settings', 'games.read', async (req, a) => ({ settings: svc('settings').describe(a), status: svc('settings').status() }));
  add('put', '/api/admin/settings/:key', 'settings.manage', async (req, a) => {
    const key = String(req.params.key || '');
    if (!/^[a-z][a-z0-9_.]{2,63}$/.test(key)) throw new ServiceError(400, 'bad setting key');
    return { key, value: await svc('settings').set(a, key, body(req).value, { reauthenticated: reauth(req) }) };
  });

  // ── Proxy governance ─────────────────────────────────────────────────────
  add('get', '/api/admin/proxy/control', 'proxy.read', async () => deps.proxyOverview());
  add('get', '/api/admin/proxy/targets', 'proxy.read', async (req, a) => ({ targets: await svc('proxy').listTargets(a) }));
  add('post', '/api/admin/proxy/targets', 'proxy.targets', async (req, a) => ({ target: await svc('proxy').createTarget(a, body(req)) }));
  add('patch', '/api/admin/proxy/targets/:id', 'proxy.targets', async (req, a) => ({ target: await svc('proxy').updateTarget(a, idParam(req), body(req)) }));
  add('post', '/api/admin/proxy/targets/:id/:action', 'proxy.targets', async (req, a) => {
    if (!['approve', 'revoke'].includes(req.params.action)) throw new ServiceError(404, 'not found');
    return { target: await svc('proxy').setTargetStatus(a, idParam(req), req.params.action, { reauthenticated: reauth(req) }) };
  });
  add('delete', '/api/admin/proxy/targets/:id', 'proxy.targets', (req, a) => svc('proxy').deleteTarget(a, idParam(req)));
  add('put', '/api/admin/proxy/policy', 'proxy.policy', async (req, a) => ({ policy: await svc('proxy').setPolicy(a, body(req).policy, { reauthenticated: reauth(req) }) }));
  add('put', '/api/admin/proxy/engines/:engine', 'proxy.manage', async (req, a) => ({ engine: await svc('proxy').setEngine(a, String(req.params.engine || ''), body(req)) }));
  add('get', '/api/admin/proxy/sessions', 'proxy.read', async (req, a) => svc('proxy').listSessions(a));
  add('post', '/api/admin/proxy/sessions/:sid/terminate', 'proxy.sessions', async (req, a) => svc('proxy').terminateSession(a, String(req.params.sid || '')));
  add('post', '/api/admin/proxy/unlisted/clear', 'proxy.targets', async (req, a) => svc('proxy').clearUnlisted(a));

  return { routes };
}

export default { mountAdminApi, csvCell };
