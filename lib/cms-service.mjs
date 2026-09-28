// lib/cms-service.mjs — the game CMS: every rule, one place.
// ---------------------------------------------------------------------------
// The HTTP layer (lib/admin-api.mjs) authenticates, checks CSRF and rate
// limits, then calls in here. This layer then AUTHORISES AGAIN for the specific
// operation, validates, enforces the provider chain and the lifecycle, writes,
// and audits. Authorising twice is deliberate: the route guard is coarse ("may
// this principal touch games at all"), and the real decision — may THIS actor
// publish THIS game from THIS state — can only be made here, next to the data.
//
// Storage is injected (cms-store-supabase in production, cms-store-memory in
// tests and database-less development), and so is the audit sink, so every
// rule below is testable without a network.
// ---------------------------------------------------------------------------

import { can } from './admin-rbac.mjs';
import {
  STATUSES, TRANSITIONS, MATERIAL_FIELDS, REVIEWED_STATUSES, AUDITED_FIELDS, LOCAL_THUMB_RE,
  transitionFor, validateGameInput, validateCategoryInput, slugify, SLUG_RE,
} from './cms-rules.mjs';
import { createProviderIndex, validateProvider } from './provider-registry.mjs';
import { diffFields, redact } from './audit-redact.mjs';
import { StoreError, STORE_HTTP } from './cms-store-errors.mjs';

export class ServiceError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.name = 'ServiceError';
    this.status = status;
    Object.assign(this, extra);
  }
}

export const BULK_MAX = 200;
export const IMPORT_MAX = 500;

// Bulk operations that remove something from public view or from the working
// set. These need an explicit confirmation carrying the exact target count.
const DESTRUCTIVE_BULK = new Set(['unpublish', 'archive', 'reject', 'remove_tag']);

const encodeCursor = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function decodeCursor(s) {
  if (!s) return null;
  try {
    const o = JSON.parse(Buffer.from(String(s), 'base64url').toString('utf8'));
    if (!o || typeof o !== 'object' || !Number.isInteger(o.id)) return null;
    if (o.v !== undefined && typeof o.v !== 'string') return null;
    return o;
  } catch { return null; }
}

const actorName = (a) => String(a?.username || 'unknown').slice(0, 80);

export function createCmsService({ store, audit = () => {}, countsByCategory = () => ({}), onChange = () => {} } = {}) {
  let providers = createProviderIndex();

  const need = (actor, perm) => {
    if (!can(actor, perm)) throw new ServiceError(403, 'forbidden', { needed: perm });
  };
  const wrap = async (fn) => {
    try { return await fn(); }
    catch (e) {
      if (e instanceof ServiceError) throw e;
      if (e instanceof StoreError) throw new ServiceError(STORE_HTTP[e.code] || 500, e.message, { code: e.code });
      throw e;
    }
  };
  const record = (actor, action, resourceType, resourceId, outcome, detail) => {
    try {
      audit({ actor, action, resourceType, resourceId: resourceId == null ? null : String(resourceId),
        target: resourceId == null ? null : `${resourceType}:${resourceId}`, outcome, detail: redact(detail || null) });
    } catch { /* the audit sink must never fail a request */ }
  };

  async function refreshProviders() {
    const rows = await store.listProviders();
    providers = createProviderIndex(rows);
    return providers;
  }

  /** Provider + origin rules for a game's embed and thumbnail. */
  function checkChain(providerId, gameUrl, thumbUrl, { intake }) {
    const errs = [];
    const p = providers.get(providerId);
    if (!p) { errs.push(`provider "${providerId}" is not registered`); return errs; }
    if (intake && !providers.acceptsNew(providerId)) {
      errs.push(`${p.name} is ${p.status} — new or re-pointed games are only accepted from approved providers`);
    }
    if (gameUrl !== undefined) { const r = providers.checkEmbed(providerId, gameUrl); if (r) errs.push(r); }
    if (thumbUrl && !LOCAL_THUMB_RE.test(thumbUrl)) { const r = providers.checkAsset(providerId, thumbUrl); if (r) errs.push(r); }
    return errs;
  }

  function allowedActions(actor, game) {
    const out = [];
    for (const [action, t] of Object.entries(TRANSITIONS)) {
      if (t.from.includes(game.status) && can(actor, t.perm)) out.push(action);
    }
    if (game.status === 'archived' && can(actor, 'games.delete')) out.push('delete');
    return out;
  }

  const service = {
    get providers() { return providers; },
    refreshProviders,

    // ── read ─────────────────────────────────────────────────────────────
    async listGames(actor, query = {}) {
      need(actor, 'games.read');
      return wrap(async () => {
        const f = {};
        const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
        const q = str(query.q, 80); if (q) f.q = q;
        const status = str(query.status, 20);
        if (status) { if (!STATUSES.includes(status)) throw new ServiceError(400, `status must be one of ${STATUSES.join(', ')}`); f.status = status; }
        const provider = str(query.provider, 40); if (provider) f.provider = provider;
        const category = str(query.category, 40); if (category) f.category = category.toLowerCase();
        if (query.featured === 'true' || query.featured === true) f.featured = true;
        else if (query.featured === 'false' || query.featured === false) f.featured = false;
        const by = str(query.updatedBy, 80); if (by) f.updatedBy = by;
        for (const k of ['since', 'until']) {
          const v = str(query[k], 40);
          if (v) { if (Number.isNaN(Date.parse(v))) throw new ServiceError(400, `${k} must be an ISO date`); f[k] = new Date(v).toISOString(); }
        }
        const sort = str(query.sort, 10) || 'new';
        if (!['new', 'old', 'title', 'updated'].includes(sort)) throw new ServiceError(400, 'sort must be new, old, title or updated');
        f.sort = sort;
        if (query.cursor) {
          f.cursor = decodeCursor(query.cursor);
          if (!f.cursor) throw new ServiceError(400, 'invalid cursor');
        }
        f.limit = Math.min(100, Math.max(1, parseInt(query.limit, 10) || 50));
        const { rows, hasMore } = await store.listGames(f);
        const last = rows[rows.length - 1];
        const nextCursor = hasMore && last ? encodeCursor({
          id: last.id, v: sort === 'title' ? last.title : sort === 'updated' ? last.updated_at : undefined,
        }) : null;
        return { rows, nextCursor, filters: { ...f, cursor: undefined } };
      });
    },

    async getGame(actor, id) {
      need(actor, 'games.read');
      return wrap(async () => {
        const g = await store.getGame(id);
        if (!g) throw new ServiceError(404, 'no such game');
        const tags = await store.getGameTags(g.id).catch(() => []);
        const p = g.provider_id ? providers.get(g.provider_id) : null;
        return {
          game: g, tags,
          provider: p ? { id: p.id, name: p.name, status: p.status, embed_mode: p.embed_mode } : null,
          actions: allowedActions(actor, g),
          editable: g.status !== 'archived' && can(actor, 'games.update'),
        };
      });
    },

    async history(actor, id) {
      need(actor, 'games.read');
      return wrap(() => store.auditFor('game', id, 100));
    },

    async statusCounts(actor) {
      need(actor, 'games.read');
      return wrap(() => store.statusCounts());
    },

    // ── create / edit ────────────────────────────────────────────────────
    async createGame(actor, input) {
      need(actor, 'games.create');
      return wrap(async () => {
        const { ok, value, errors } = validateGameInput(input);
        if (!ok) throw new ServiceError(400, 'invalid game', { errors });
        const chain = checkChain(value.provider_id, value.game_url, value.thumbnail_url, { intake: true });
        if (chain.length) throw new ServiceError(400, 'invalid game', { errors: chain });
        if (!(await store.getCategory(value.category))) throw new ServiceError(400, 'invalid game', { errors: [`category "${value.category}" does not exist`] });
        const { tags, ...row } = value;
        const created = await store.insertGame({
          ...row, status: 'draft', is_working: true,
          created_by: actorName(actor), updated_by: actorName(actor),
        });
        if (tags?.length) await store.setGameTags(created.id, tags);
        record(actor, 'game.create', 'game', created.id, 'success', { slug: created.slug, title: created.title, provider: created.provider_id });
        onChange('game');
        return created;
      });
    },

    async updateGame(actor, id, input, { expectUpdatedAt } = {}) {
      need(actor, 'games.update');
      return wrap(async () => {
        if (!expectUpdatedAt) throw new ServiceError(400, 'expectUpdatedAt is required — reload the game and try again');
        const cur = await store.getGame(id);
        if (!cur) throw new ServiceError(404, 'no such game');
        if (cur.status === 'archived') throw new ServiceError(409, 'restore the game from the archive before editing it');
        const { ok, value, errors } = validateGameInput(input, { partial: true });
        if (!ok) throw new ServiceError(400, 'invalid game', { errors });
        const { tags, ...patch } = value;
        for (const k of Object.keys(patch)) if (JSON.stringify(patch[k]) === JSON.stringify(cur[k])) delete patch[k];

        const material = MATERIAL_FIELDS.filter((f) => f in patch);
        if (material.length) {
          const providerId = patch.provider_id ?? cur.provider_id;
          const repointed = 'game_url' in patch || 'provider_id' in patch;
          const chain = checkChain(providerId,
            repointed ? (patch.game_url ?? cur.game_url) : undefined,
            patch.thumbnail_url, { intake: repointed });
          if (chain.length) throw new ServiceError(400, 'invalid game', { errors: chain });
        }
        if ('category' in patch && !(await store.getCategory(patch.category))) {
          throw new ServiceError(400, 'invalid game', { errors: [`category "${patch.category}" does not exist`] });
        }
        // A reviewed game whose embed or image changes goes back to review
        // unless the editor could have published it themselves.
        let sentBack = false;
        if (material.length && REVIEWED_STATUSES.includes(cur.status) && !can(actor, 'games.publish')) {
          patch.status = 'pending_review';
          sentBack = true;
        }
        if (!Object.keys(patch).length && !tags) return { game: cur, changed: false };
        let next = cur;
        if (Object.keys(patch).length) {
          next = await store.updateGame(cur.id, { ...patch, updated_by: actorName(actor) }, { expectUpdatedAt });
          if (!next) throw new ServiceError(409, 'this game was changed by someone else — reload it and reapply your edit');
        }
        let tagChange = null;
        if (tags) {
          const before = await store.getGameTags(cur.id);
          if (JSON.stringify(before) !== JSON.stringify([...tags].sort())) {
            await store.setGameTags(cur.id, tags);
            tagChange = { from: before, to: [...tags].sort() };
          }
        }
        record(actor, sentBack ? 'game.update.resubmitted' : 'game.update', 'game', cur.id, 'success', {
          changes: diffFields(cur, next, AUDITED_FIELDS), ...(tagChange ? { tags: tagChange } : {}),
          ...(sentBack ? { reason: `changed ${material.join(', ')} on a ${cur.status} game` } : {}),
        });
        onChange('game');
        return { game: next, changed: true, sentBackToReview: sentBack };
      });
    },

    async transition(actor, id, action, { note, expectUpdatedAt } = {}) {
      return wrap(async () => {
        if (!TRANSITIONS[action]) throw new ServiceError(400, 'unknown action');
        need(actor, TRANSITIONS[action].perm);
        const cur = await store.getGame(id);
        if (!cur) throw new ServiceError(404, 'no such game');
        const t = transitionFor(action, cur.status);
        if (!t.ok) {
          record(actor, `game.${action}`, 'game', cur.id, 'failure', { reason: t.reason });
          throw new ServiceError(409, t.reason);
        }
        const cleanNote = typeof note === 'string' ? note.trim().slice(0, 1000) : '';
        if (t.needsNote && cleanNote.length < 3) throw new ServiceError(400, `a reason is required to ${action}`);
        if (/<\s*[a-z!/?]/i.test(cleanNote)) throw new ServiceError(400, 'the note must be plain text');
        if (action === 'publish') {
          const errs = checkChain(cur.provider_id, cur.game_url, cur.thumbnail_url, { intake: true });
          if (errs.length) throw new ServiceError(409, 'this game cannot be published', { errors: errs });
        }
        const patch = { status: t.to, updated_by: actorName(actor) };
        if (t.to === 'published') patch.published_at = new Date().toISOString();
        if (t.to === 'archived') patch.archived_at = new Date().toISOString();
        if (cur.status === 'archived') patch.archived_at = null;
        if (cleanNote) patch.review_note = cleanNote;
        const next = await store.updateGame(cur.id, patch, { expectUpdatedAt: expectUpdatedAt || cur.updated_at });
        if (!next) throw new ServiceError(409, 'this game was changed by someone else — reload it and try again');
        record(actor, `game.${action}`, 'game', cur.id, 'success', { from: cur.status, to: t.to, ...(cleanNote ? { note: cleanNote } : {}) });
        onChange('game');
        return next;
      });
    },

    async deleteGame(actor, id, { confirm, reauthenticated }) {
      need(actor, 'games.delete');
      return wrap(async () => {
        const cur = await store.getGame(id);
        if (!cur) throw new ServiceError(404, 'no such game');
        if (cur.status !== 'archived') throw new ServiceError(409, 'only an archived game can be permanently deleted — archive it first');
        if (!reauthenticated) throw new ServiceError(401, 'confirm your password to delete permanently', { reauth: true });
        if (confirm !== cur.slug) throw new ServiceError(400, `type the game's slug (${cur.slug}) to confirm`);
        // The audit row keeps enough to rebuild the record by hand: the only
        // recovery path once a row is gone, and the reason deletion is rare.
        const snapshot = {
          slug: cur.slug, title: cur.title, game_url: cur.game_url, thumbnail_url: cur.thumbnail_url,
          provider_id: cur.provider_id, external_id: cur.external_id, category: cur.category,
          description: cur.description, created_by: cur.created_by, created_at: cur.created_at,
        };
        const gone = await store.deleteGame(cur.id);
        if (!gone) throw new ServiceError(404, 'no such game');
        record(actor, 'game.delete', 'game', cur.id, 'success', { snapshot });
        onChange('game');
        return { deleted: true, id: cur.id };
      });
    },

    // ── bulk ─────────────────────────────────────────────────────────────
    async bulk(actor, { ids, op, value, preview = false, confirm } = {}) {
      need(actor, 'games.bulk');
      return wrap(async () => {
        if (!Array.isArray(ids) || !ids.length) throw new ServiceError(400, 'ids must be a non-empty list');
        if (ids.length > BULK_MAX) throw new ServiceError(400, `at most ${BULK_MAX} games per bulk operation`);
        const clean = [...new Set(ids.map(Number))];
        if (clean.some((n) => !Number.isInteger(n) || n <= 0) || clean.length !== ids.length) {
          throw new ServiceError(400, 'ids must be distinct positive integers');
        }
        const isTransition = Object.hasOwn(TRANSITIONS, op);
        const OPS = ['set_category', 'feature', 'unfeature', 'add_tag', 'remove_tag'];
        if (!isTransition && !OPS.includes(op)) throw new ServiceError(400, 'unknown bulk operation');
        need(actor, isTransition ? TRANSITIONS[op].perm : (op.endsWith('_tag') ? 'taxonomy.manage' : 'games.update'));
        if (isTransition && TRANSITIONS[op].needsNote) throw new ServiceError(400, `${op} needs a per-game reason — do it one game at a time`);

        let arg = null;
        if (op === 'set_category') {
          arg = typeof value === 'string' ? value.trim().toLowerCase() : '';
          if (!arg || !(await store.getCategory(arg))) throw new ServiceError(400, 'value must be an existing category');
        }
        if (op === 'add_tag' || op === 'remove_tag') {
          arg = slugify(String(value || '')).slice(0, 40);
          if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(arg)) throw new ServiceError(400, 'value must be a tag');
        }

        // Validate EVERY target before writing anything.
        const failures = [];
        const games = [];
        for (const id of clean) {
          const g = await store.getGame(id);
          if (!g) { failures.push({ id, reason: 'no such game' }); continue; }
          if (isTransition) {
            const t = transitionFor(op, g.status);
            if (!t.ok) { failures.push({ id, slug: g.slug, reason: t.reason }); continue; }
            if (op === 'publish') {
              const errs = checkChain(g.provider_id, g.game_url, g.thumbnail_url, { intake: true });
              if (errs.length) { failures.push({ id, slug: g.slug, reason: errs[0] }); continue; }
            }
          } else if (g.status === 'archived') {
            failures.push({ id, slug: g.slug, reason: 'archived games cannot be edited' }); continue;
          }
          games.push(g);
        }
        const summary = { op, requested: clean.length, valid: games.length, failures };
        if (preview) return { ...summary, preview: true };
        if (failures.length) {
          record(actor, `game.bulk.${op}`, 'game', null, 'failure', { requested: clean.length, failures: failures.slice(0, 20) });
          throw new ServiceError(409, 'nothing was changed: some games cannot take this operation', summary);
        }
        if (DESTRUCTIVE_BULK.has(op) && Number(confirm) !== clean.length) {
          throw new ServiceError(400, `confirm with the number of games (${clean.length}) to apply ${op}`, { confirmRequired: clean.length });
        }

        let applied = 0;
        const perItem = [];
        if (isTransition) {
          const t = TRANSITIONS[op];
          applied = await store.bulkTransition(clean, t.to, t.from, actorName(actor));
        } else if (op === 'set_category') {
          applied = await store.bulkPatch(clean, { category: arg, updated_by: actorName(actor) });
        } else if (op === 'feature' || op === 'unfeature') {
          applied = await store.bulkPatch(clean, { featured: op === 'feature', updated_by: actorName(actor) });
        } else {
          // Tags are one row set per game, so this is per-game and reported per
          // game — never summarised as a success it was not.
          for (const g of games) {
            try {
              const cur = await store.getGameTags(g.id);
              const next = op === 'add_tag' ? [...new Set([...cur, arg])] : cur.filter((t) => t !== arg);
              if (next.length > 30) { perItem.push({ id: g.id, ok: false, reason: 'tag limit reached' }); continue; }
              await store.setGameTags(g.id, next);
              perItem.push({ id: g.id, ok: true });
              applied++;
            } catch (e) { perItem.push({ id: g.id, ok: false, reason: e.message }); }
          }
        }
        record(actor, `game.bulk.${op}`, 'game', null, perItem.some((r) => !r.ok) ? 'failure' : 'success', {
          ids: clean.slice(0, 200), applied, ...(arg ? { value: arg } : {}),
          ...(perItem.length ? { failed: perItem.filter((r) => !r.ok) } : {}),
        });
        onChange('game');
        return { ...summary, applied, results: perItem.length ? perItem : undefined };
      });
    },

    // ── import / export ──────────────────────────────────────────────────
    async importPreview(actor, items) {
      need(actor, 'games.create');
      return wrap(() => planImport(items));
    },

    async importApply(actor, items, { confirm } = {}) {
      need(actor, 'games.create');
      need(actor, 'games.bulk');
      return wrap(async () => {
        const plan = await planImport(items);
        if (Number(confirm) !== plan.valid.length) {
          throw new ServiceError(400, `confirm with the number of games to import (${plan.valid.length})`, { plan: { ...plan, valid: plan.valid.length } });
        }
        const created = [];
        const failed = [];
        for (const v of plan.valid) {
          try { created.push((await service.createGame(actor, v.input)).id); }
          catch (e) { failed.push({ index: v.index, reason: e.message, errors: e.errors }); }
        }
        record(actor, 'game.import.file', 'game', null, failed.length ? 'failure' : 'success',
          { created: created.length, failed: failed.length, rejected: plan.invalid.length });
        return { created: created.length, failed, rejected: plan.invalid };
      });
    },

    async exportGames(actor, { status, provider } = {}) {
      need(actor, 'games.read');
      return wrap(async () => {
        const out = [];
        let cursor;
        for (let i = 0; i < 400; i++) {
          const page = await service.listGames(actor, { status, provider, sort: 'old', limit: 100, cursor });
          out.push(...page.rows);
          if (!page.nextCursor) break;
          cursor = page.nextCursor;
        }
        record(actor, 'game.export', 'game', null, 'success', { rows: out.length, status: status || null, provider: provider || null });
        return out;
      });
    },

    // ── system import (the provider feeds) ───────────────────────────────
    /**
     * Insert games that a provider feed produced. The caller is the importer,
     * not a request, but every record still goes through validateGameInput and
     * the provider chain — an import never bypasses the rules an editor faces.
     */
    async importFromProvider(actor, rows) {
      need(actor, 'games.import');
      return wrap(async () => {
        const accepted = [];
        const rejected = [];
        for (const r of rows) {
          const { ok, value, errors } = validateGameInput(r.input);
          const chain = ok ? checkChain(value.provider_id, value.game_url, value.thumbnail_url, { intake: true }) : [];
          if (!ok || chain.length) { rejected.push({ external_id: r.external_id, errors: [...errors, ...chain] }); continue; }
          if (!STATUSES.includes(r.status)) { rejected.push({ external_id: r.external_id, errors: ['bad status'] }); continue; }
          const { tags, ...row } = value;
          accepted.push({
            ...row, status: r.status, external_id: r.external_id, license_review: r.license_review || null,
            is_working: true, created_by: actorName(actor), updated_by: actorName(actor),
            ...(r.status === 'published' ? { published_at: new Date().toISOString() } : {}),
          });
        }
        let inserted = 0;
        for (let i = 0; i < accepted.length; i += 250) inserted += await store.insertGamesBatch(accepted.slice(i, i + 250));
        if (inserted) onChange('game');
        return { inserted, rejected };
      });
    },

    // ── categories and tags ──────────────────────────────────────────────
    async listCategories(actor) {
      need(actor, 'games.read');
      return wrap(async () => {
        const rows = await store.listCategories();
        const counts = countsByCategory();
        return rows.map((c) => ({ ...c, games: c.games ?? counts[c.slug] ?? 0 }));
      });
    },
    async createCategory(actor, input) {
      need(actor, 'taxonomy.manage');
      return wrap(async () => {
        const { ok, value, errors } = validateCategoryInput(input);
        if (!ok) throw new ServiceError(400, 'invalid category', { errors });
        const c = await store.insertCategory({ ...value, updated_by: actorName(actor) });
        record(actor, 'category.create', 'category', c.slug, 'success', value);
        onChange('category');
        return c;
      });
    },
    async updateCategory(actor, slug, input) {
      need(actor, 'taxonomy.manage');
      return wrap(async () => {
        const cur = await store.getCategory(slug);
        if (!cur) throw new ServiceError(404, 'no such category');
        const { ok, value, errors } = validateCategoryInput(input, { partial: true });
        if (!ok) throw new ServiceError(400, 'invalid category', { errors });
        if (value.parent_slug === slug) throw new ServiceError(400, 'a category cannot be its own parent');
        const next = await store.updateCategory(slug, { ...value, updated_by: actorName(actor) });
        record(actor, 'category.update', 'category', slug, 'success', { changes: diffFields(cur, next, ['label', 'description', 'parent_slug', 'sort_order', 'visible']) });
        onChange('category');
        return next;
      });
    },
    async reorderCategories(actor, order) {
      need(actor, 'taxonomy.manage');
      return wrap(async () => {
        if (!Array.isArray(order) || !order.length || order.length > 200) throw new ServiceError(400, 'order must list 1–200 categories');
        const results = [];
        for (const [i, slug] of order.entries()) {
          if (typeof slug !== 'string') { results.push({ slug, ok: false }); continue; }
          const r = await store.updateCategory(slug, { sort_order: i * 10, updated_by: actorName(actor) }).catch(() => null);
          results.push({ slug, ok: !!r });
        }
        record(actor, 'category.reorder', 'category', null, results.every((r) => r.ok) ? 'success' : 'failure', { order: order.slice(0, 200) });
        onChange('category');
        return results;
      });
    },
    async deleteCategory(actor, slug) {
      need(actor, 'taxonomy.manage');
      return wrap(async () => {
        const cur = await store.getCategory(slug);
        if (!cur) throw new ServiceError(404, 'no such category');
        try { await store.deleteCategory(slug); }
        catch (e) {
          if (e instanceof StoreError && e.code === 'fk') {
            record(actor, 'category.delete', 'category', slug, 'failure', { reason: 'in use' });
            throw new ServiceError(409, 'this category still holds games or subcategories — move them first, or hide the category instead');
          }
          throw e;
        }
        record(actor, 'category.delete', 'category', slug, 'success', { label: cur.label });
        onChange('category');
        return { deleted: true };
      });
    },
    async listTags(actor, q) {
      need(actor, 'games.read');
      return wrap(() => store.listTags({ q: typeof q === 'string' ? q.slice(0, 40) : undefined }));
    },
    async deleteTag(actor, slug) {
      need(actor, 'taxonomy.manage');
      return wrap(async () => {
        if (typeof slug !== 'string' || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(slug)) throw new ServiceError(400, 'bad tag');
        const gone = await store.deleteTag(slug);
        if (!gone) throw new ServiceError(404, 'no such tag');
        record(actor, 'tag.delete', 'tag', slug, 'success');
        return { deleted: true };
      });
    },

    // ── providers ────────────────────────────────────────────────────────
    async listProviders(actor) {
      need(actor, 'games.read');
      return wrap(() => store.listProviders());
    },
    async createProvider(actor, input) {
      need(actor, 'providers.manage');
      return wrap(async () => {
        const { ok, value, errors } = validateProvider(input);
        if (!ok) throw new ServiceError(400, 'invalid provider', { errors });
        const row = await store.insertProvider({ ...value, updated_by: actorName(actor), reviewed_by: actorName(actor), reviewed_at: new Date().toISOString() });
        record(actor, 'provider.create', 'provider', row.id, 'success', value);
        await refreshProviders();
        onChange('provider');
        return row;
      });
    },
    async updateProvider(actor, id, input, { reauthenticated = false } = {}) {
      need(actor, 'providers.manage');
      return wrap(async () => {
        const cur = await store.getProvider(id);
        if (!cur) throw new ServiceError(404, 'no such provider');
        const { ok, value, errors } = validateProvider(input, { partial: true });
        if (!ok) throw new ServiceError(400, 'invalid provider', { errors });
        // Suspending or revoking withdraws every game from that provider at
        // once, and widening origins widens what the site will frame. Both are
        // re-authenticated, not just clicked.
        const withdrawing = value.status && ['suspended', 'revoked'].includes(value.status) && value.status !== cur.status;
        const widening = ['embed_origins', 'asset_origins'].some((k) => value[k] && value[k].some((o) => !(cur[k] || []).includes(o)));
        if ((withdrawing || widening) && !reauthenticated) {
          throw new ServiceError(401, 'confirm your password to make this change', { reauth: true });
        }
        const next = await store.updateProvider(id, {
          ...value, updated_by: actorName(actor),
          ...(value.status ? { reviewed_by: actorName(actor), reviewed_at: new Date().toISOString() } : {}),
        });
        record(actor, 'provider.update', 'provider', id, 'success', {
          changes: diffFields(cur, next, ['name', 'status', 'embed_origins', 'asset_origins', 'embed_mode', 'sandbox_policy', 'allow_features', 'terms_url', 'license_basis', 'notes']),
        });
        await refreshProviders();
        onChange('provider');
        return next;
      });
    },
  };

  async function planImport(items) {
    if (!Array.isArray(items)) throw new ServiceError(400, 'the file must contain a JSON array of games');
    if (items.length > IMPORT_MAX) throw new ServiceError(400, `at most ${IMPORT_MAX} games per import`);
    const valid = [];
    const invalid = [];
    const seen = new Set();
    for (const [index, raw] of items.entries()) {
      const { ok, value, errors } = validateGameInput(raw);
      const errs = [...errors];
      if (ok) {
        errs.push(...checkChain(value.provider_id, value.game_url, value.thumbnail_url, { intake: true }));
        if (!(await store.getCategory(value.category))) errs.push(`category "${value.category}" does not exist`);
        if (seen.has(value.slug)) errs.push(`slug "${value.slug}" appears twice in this file`);
        else if (await store.getGameBySlug(value.slug)) errs.push(`slug "${value.slug}" is already in the catalog`);
        seen.add(value.slug);
      }
      if (errs.length) invalid.push({ index, title: typeof raw?.title === 'string' ? raw.title.slice(0, 80) : null, errors: errs });
      else valid.push({ index, input: raw, slug: value.slug, title: value.title });
    }
    return { total: items.length, valid, invalid };
  }

  return service;
}

export default { createCmsService, ServiceError, BULK_MAX, IMPORT_MAX };
