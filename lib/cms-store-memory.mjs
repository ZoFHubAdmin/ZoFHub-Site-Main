// lib/cms-store-memory.mjs — the control plane's storage, held in memory.
// ---------------------------------------------------------------------------
// The SAME interface as lib/cms-store-supabase.mjs, used by the test suite and
// by a local server running with no database.
//
// It is not a toy: it enforces the constraints the migration puts in Postgres —
// unique slugs, one row per provider game, category and provider foreign keys
// with RESTRICT, status CHECKs, optimistic concurrency, all-or-nothing bulk
// transitions — so a service-layer test that passes here is exercising the rules
// the database will actually apply. What it cannot prove is the SQL itself;
// test/control-plane-db.test.mjs runs the real migration in PGlite for that.
// ---------------------------------------------------------------------------

import { StoreError } from './cms-store-errors.mjs';
import { STATUSES } from './cms-rules.mjs';
import { DEFAULT_PROVIDERS } from './provider-registry.mjs';

const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

export function createMemoryStore({ now = () => new Date(), seedProviders = true, categories = ['arcade'] } = {}) {
  let gameSeq = 0;
  let targetSeq = 0;
  let clock = 0;
  // Strictly increasing timestamps, so optimistic-concurrency tokens differ
  // even when two writes land in the same millisecond.
  const stamp = () => {
    const t = Math.max(now().getTime(), clock + 1);
    clock = t;
    return new Date(t).toISOString();
  };

  const games = new Map();          // id -> row
  const tags = new Map();           // slug -> row
  const links = new Map();          // gameId -> Set(tag)
  const cats = new Map();           // slug -> row
  const providers = new Map();      // id -> row
  const settings = new Map();       // key -> row
  const staff = new Map();          // id -> row
  const targets = new Map();        // id -> row
  const engines = new Map();        // id -> row
  let policy = null;
  const audit = [];                 // appended by the audit sink in tests

  for (const c of categories) cats.set(c, { slug: c, label: c[0].toUpperCase() + c.slice(1), description: null, parent_slug: null, sort_order: 0, visible: true });
  if (seedProviders) for (const p of DEFAULT_PROVIDERS) providers.set(p.id, { ...clone(p), notes: null, reviewed_at: null, reviewed_by: 'migration', updated_at: stamp() });

  const checkGame = (row, selfId) => {
    if (!STATUSES.includes(row.status)) throw new StoreError('invalid', 'status violates games_status_check');
    if (!cats.has(row.category)) throw new StoreError('fk', `category "${row.category}" does not exist`);
    if (row.provider_id && !providers.has(row.provider_id)) throw new StoreError('fk', `provider "${row.provider_id}" does not exist`);
    for (const g of games.values()) {
      if (g.id === selfId) continue;
      if (g.slug === row.slug) throw new StoreError('conflict', `slug "${row.slug}" is already used`);
      if (row.external_id && g.provider_id === row.provider_id && g.external_id === row.external_id) {
        throw new StoreError('conflict', 'this provider game is already in the catalog');
      }
    }
  };

  const store = {
    kind: 'memory',
    _audit: audit,

    // ── games ────────────────────────────────────────────────────────────
    async getGame(id) { return clone(games.get(Number(id))) || null; },
    async getGameBySlug(slug) { for (const g of games.values()) if (g.slug === slug) return clone(g); return null; },
    async findGameByExternal(providerId, externalId) {
      for (const g of games.values()) if (g.provider_id === providerId && g.external_id === externalId) return clone(g);
      return null;
    },
    async listGames(f = {}) {
      let rows = [...games.values()];
      if (f.q) {
        const q = f.q.toLowerCase();
        rows = rows.filter((g) => g.title.toLowerCase().includes(q) || g.slug.includes(q) || String(g.id) === f.q);
      }
      if (f.status) rows = rows.filter((g) => g.status === f.status);
      if (f.provider) rows = rows.filter((g) => g.provider_id === f.provider);
      if (f.category) rows = rows.filter((g) => g.category === f.category);
      if (f.featured !== undefined) rows = rows.filter((g) => g.featured === f.featured);
      if (f.updatedBy) rows = rows.filter((g) => g.updated_by === f.updatedBy);
      if (f.since) rows = rows.filter((g) => g.updated_at >= f.since);
      if (f.until) rows = rows.filter((g) => g.updated_at <= f.until);
      const sort = f.sort || 'new';
      const cmp = {
        new: (a, b) => b.id - a.id,
        old: (a, b) => a.id - b.id,
        title: (a, b) => (a.title < b.title ? -1 : a.title > b.title ? 1 : a.id - b.id),
        updated: (a, b) => (a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : b.id - a.id),
      }[sort];
      rows.sort(cmp);
      if (f.cursor) {
        const c = f.cursor;
        rows = rows.filter((g) => {
          if (sort === 'new') return g.id < c.id;
          if (sort === 'old') return g.id > c.id;
          if (sort === 'title') return g.title > c.v || (g.title === c.v && g.id > c.id);
          return g.updated_at < c.v || (g.updated_at === c.v && g.id < c.id);
        });
      }
      const limit = f.limit || 50;
      const page = rows.slice(0, limit + 1);
      return { rows: clone(page.slice(0, limit)), hasMore: page.length > limit };
    },
    async insertGame(row) {
      const t = stamp();
      const full = { id: ++gameSeq, is_working: true, featured: false, sort_order: 0, created_at: t, updated_at: t, last_checked: t, ...clone(row) };
      checkGame(full, null);
      games.set(full.id, full);
      return clone(full);
    },
    async insertGamesBatch(rows) {
      let n = 0;
      for (const r of rows) {
        try { await store.insertGame(r); n++; } catch (e) { if (e.code !== 'conflict') throw e; }
      }
      return n;
    },
    async updateGame(id, patch, { expectUpdatedAt } = {}) {
      const cur = games.get(Number(id));
      if (!cur) return null;
      if (expectUpdatedAt && cur.updated_at !== expectUpdatedAt) return null;
      const next = { ...cur, ...clone(patch), updated_at: stamp() };
      checkGame(next, cur.id);
      games.set(cur.id, next);
      return clone(next);
    },
    async deleteGame(id) { links.delete(Number(id)); return games.delete(Number(id)); },
    async bulkTransition(ids, to, from, actor) {
      if (ids.length > 500) throw new StoreError('precondition', 'bulk operations are limited to 500 games');
      if (new Set(ids).size !== ids.length) throw new StoreError('precondition', 'duplicate ids in bulk request');
      for (const id of ids) {
        const g = games.get(Number(id));
        if (!g || !from.includes(g.status)) throw new StoreError('precondition', `one or more games are missing or not in an allowed state for ${to}`);
      }
      const t = stamp();
      for (const id of ids) {
        const g = games.get(Number(id));
        games.set(g.id, { ...g, status: to, updated_by: actor, updated_at: t,
          published_at: to === 'published' ? t : g.published_at || null,
          archived_at: to === 'archived' ? t : null });
      }
      return ids.length;
    },
    async bulkPatch(ids, patch) {
      for (const id of ids) {
        const g = games.get(Number(id));
        if (!g) throw new StoreError('precondition', `game ${id} does not exist`);
        checkGame({ ...g, ...patch }, g.id);
      }
      const t = stamp();
      for (const id of ids) { const g = games.get(Number(id)); games.set(g.id, { ...g, ...clone(patch), updated_at: t }); }
      return ids.length;
    },
    async statusCounts() {
      const out = {};
      for (const g of games.values()) out[g.status] = (out[g.status] || 0) + 1;
      return out;
    },
    async catalogIndex() {
      return [...games.values()].map(({ id, slug, title, provider_id, external_id }) => ({ id, slug, title, provider_id, external_id }));
    },
    async setGameTags(id, list) {
      if (list.length > 30) throw new StoreError('precondition', 'a game may carry at most 30 tags');
      for (const t of list) if (!tags.has(t)) tags.set(t, { slug: t, label: t.replace(/-/g, ' ') });
      links.set(Number(id), new Set(list));
      return list.length;
    },
    async getGameTags(id) { return [...(links.get(Number(id)) || [])].sort(); },

    // ── taxonomy ─────────────────────────────────────────────────────────
    async listCategories() {
      const counts = {};
      for (const g of games.values()) counts[g.category] = (counts[g.category] || 0) + 1;
      return [...cats.values()].map((c) => ({ ...clone(c), games: counts[c.slug] || 0 }))
        .sort((a, b) => a.sort_order - b.sort_order || a.slug.localeCompare(b.slug));
    },
    async getCategory(slug) { return clone(cats.get(slug)) || null; },
    async insertCategory(row) {
      if (cats.has(row.slug)) throw new StoreError('conflict', `category "${row.slug}" already exists`);
      if (row.parent_slug && !cats.has(row.parent_slug)) throw new StoreError('fk', 'parent category does not exist');
      const full = { description: null, parent_slug: null, sort_order: 0, visible: true, ...clone(row), updated_at: stamp() };
      cats.set(row.slug, full);
      return clone(full);
    },
    async updateCategory(slug, patch) {
      const cur = cats.get(slug);
      if (!cur) return null;
      if (patch.parent_slug) {
        if (!cats.has(patch.parent_slug)) throw new StoreError('fk', 'parent category does not exist');
        if (patch.parent_slug === slug) throw new StoreError('invalid', 'a category cannot be its own parent');
      }
      const next = { ...cur, ...clone(patch), updated_at: stamp() };
      cats.set(slug, next);
      return clone(next);
    },
    async deleteCategory(slug) {
      if (!cats.has(slug)) return false;
      for (const g of games.values()) if (g.category === slug) throw new StoreError('fk', 'category still holds games');
      for (const c of cats.values()) if (c.parent_slug === slug) throw new StoreError('fk', 'category has subcategories');
      return cats.delete(slug);
    },
    async listTags({ q, limit = 200 } = {}) {
      const counts = {};
      for (const s of links.values()) for (const t of s) counts[t] = (counts[t] || 0) + 1;
      return [...tags.values()].filter((t) => !q || t.slug.includes(q))
        .map((t) => ({ ...clone(t), games: counts[t.slug] || 0 }))
        .sort((a, b) => a.slug.localeCompare(b.slug)).slice(0, limit);
    },
    async upsertTag(row) { tags.set(row.slug, { ...clone(row) }); return clone(row); },
    async deleteTag(slug) {
      for (const s of links.values()) s.delete(slug);
      return tags.delete(slug);
    },

    // ── providers ────────────────────────────────────────────────────────
    async listProviders() { return [...providers.values()].map(clone).sort((a, b) => a.id.localeCompare(b.id)); },
    async getProvider(id) { return clone(providers.get(id)) || null; },
    async insertProvider(row) {
      if (providers.has(row.id)) throw new StoreError('conflict', `provider "${row.id}" already exists`);
      const full = { embed_origins: [], asset_origins: [], embed_mode: 'direct', allow_features: [], sandbox_policy: null, ...clone(row), updated_at: stamp() };
      providers.set(row.id, full);
      return clone(full);
    },
    async updateProvider(id, patch) {
      const cur = providers.get(id);
      if (!cur) return null;
      const next = { ...cur, ...clone(patch), updated_at: stamp() };
      providers.set(id, next);
      return clone(next);
    },

    // ── settings ─────────────────────────────────────────────────────────
    async listSettings() { return [...settings.values()].map(clone); },
    async putSetting(key, value, actor) {
      const row = { key, value: clone(value), updated_at: stamp(), updated_by: actor };
      settings.set(key, row);
      return clone(row);
    },

    // ── staff ────────────────────────────────────────────────────────────
    async listStaff() { return [...staff.values()].map(clone).sort((a, b) => a.username.localeCompare(b.username)); },
    async getStaff(id) { return clone(staff.get(id)) || null; },
    async getStaffByUsername(u) {
      const k = String(u || '').toLowerCase();
      for (const s of staff.values()) if (s.username.toLowerCase() === k) return clone(s);
      return null;
    },
    async insertStaff(row) {
      for (const s of staff.values()) if (s.username.toLowerCase() === row.username.toLowerCase()) throw new StoreError('conflict', 'that username is taken');
      const t = stamp();
      const full = { id: `u-${staff.size + 1}-${Math.random().toString(16).slice(2, 10)}`, status: 'active', must_change_password: true, created_at: t, updated_at: t, last_login_at: null, deleted_at: null, status_reason: null, display_name: null, ...clone(row) };
      staff.set(full.id, full);
      return clone(full);
    },
    async updateStaff(id, patch) {
      const cur = staff.get(id);
      if (!cur) return null;
      const next = { ...cur, ...clone(patch), updated_at: stamp() };
      staff.set(id, next);
      return clone(next);
    },
    // Sessions are the auth layer's; tests register them here to observe
    // revocation. `_sessions` maps userId -> live count.
    _sessions: new Map(),
    async revokeStaffSessions(userId, reason) {
      const n = store._sessions.get(userId) || 0;
      store._sessions.set(userId, 0);
      store._revocations = [...(store._revocations || []), { userId, reason, n }];
      return n;
    },
    async liveSessionCounts() { return Object.fromEntries(store._sessions); },

    // ── proxy governance ─────────────────────────────────────────────────
    async listTargets() { return [...targets.values()].map(clone).sort((a, b) => a.pattern.localeCompare(b.pattern)); },
    async getTarget(id) { return clone(targets.get(Number(id))) || null; },
    async insertTarget(row) {
      for (const t of targets.values()) if (t.pattern.toLowerCase() === row.pattern.toLowerCase()) throw new StoreError('conflict', 'that destination is already listed');
      const ts = stamp();
      const full = { id: ++targetSeq, ports: [443], status: 'pending', owner: null, expires_at: null, approved_by: null, approved_at: null, created_at: ts, updated_at: ts, ...clone(row) };
      targets.set(full.id, full);
      return clone(full);
    },
    async updateTarget(id, patch) {
      const cur = targets.get(Number(id));
      if (!cur) return null;
      const next = { ...cur, ...clone(patch), updated_at: stamp() };
      targets.set(cur.id, next);
      return clone(next);
    },
    async deleteTarget(id) { return targets.delete(Number(id)); },
    async listProxyProviders() { return [...engines.values()].map(clone); },
    async putProxyProvider(row) {
      const next = { ...(engines.get(row.id) || {}), ...clone(row), updated_at: stamp() };
      engines.set(row.id, next);
      return clone(next);
    },
    async getProxyPolicy() { return policy ? clone(policy) : null; },
    async putProxyPolicy(p, actor) { policy = { id: 'default', policy: clone(p), updated_at: stamp(), updated_by: actor }; return clone(policy); },

    // ── history ──────────────────────────────────────────────────────────
    async auditFor(type, id, limit = 50) {
      return clone(audit.filter((a) => a.resource_type === type && a.resource_id === String(id)).slice(-limit).reverse());
    },
  };
  return store;
}

export default { createMemoryStore };
