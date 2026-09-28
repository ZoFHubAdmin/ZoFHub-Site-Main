// lib/cms-store-supabase.mjs — the control plane's storage, in Postgres.
// ---------------------------------------------------------------------------
// Same interface as lib/cms-store-memory.mjs. Takes the ADMIN client: every
// table it touches is RLS deny-by-default with no public policy
// (db/control-plane.sql), so the publishable key could not read them anyway.
//
// PAGING IS KEYSET, ALWAYS. The admin game table is written while it is read —
// by editors, by the importer, by the hourly link checker — and OFFSET paging
// under concurrent writes silently skips or repeats rows. Every list here
// orders by a total order ending in the primary key and pages with a cursor
// over those values. test/schema-integrity.test.mjs forbids .range() for the
// same reason.
//
// Values interpolated into a PostgREST `or=(...)` filter are double-quoted and
// escaped (pgrstQuote). That filter is a small language of its own: an
// unquoted title containing a comma or a parenthesis would change its meaning.
// ---------------------------------------------------------------------------

import { StoreError, fromPg } from './cms-store-errors.mjs';

export const GAME_COLS = [
  'id', 'slug', 'title', 'game_url', 'thumbnail_url', 'category', 'is_working', 'last_checked',
  'created_at', 'updated_at', 'status', 'provider_id', 'external_id', 'description',
  'short_description', 'publisher', 'developer', 'featured', 'sort_order', 'embed_width',
  'embed_height', 'license_review', 'review_note', 'created_by', 'updated_by', 'published_at', 'archived_at',
].join(', ');

const LIST_COLS = 'id, slug, title, thumbnail_url, category, is_working, status, provider_id, external_id, featured, sort_order, updated_at, updated_by, license_review';

/** Quote a value for a PostgREST logic-tree filter. */
export function pgrstQuote(v) {
  return '"' + String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}
const escapeLike = (v) => String(v).replace(/[\\%_]/g, (c) => '\\' + c);

async function run(p, fallback) {
  let r;
  try { r = await p; } catch (e) { throw new StoreError('unavailable', 'database request failed'); }
  if (r.error) throw fromPg(r.error, fallback);
  return r.data;
}

export function createSupabaseStore(supa) {
  if (!supa) throw new Error('createSupabaseStore needs an admin client');
  const one = async (q) => { const d = await run(q.limit(1)); return (d && d[0]) || null; };

  return {
    kind: 'supabase',

    // ── games ────────────────────────────────────────────────────────────
    getGame: (id) => one(supa.from('games').select(GAME_COLS).eq('id', Number(id))),
    getGameBySlug: (slug) => one(supa.from('games').select(GAME_COLS).eq('slug', slug)),
    findGameByExternal: (providerId, externalId) =>
      one(supa.from('games').select(GAME_COLS).eq('provider_id', providerId).eq('external_id', externalId)),

    async listGames(f = {}) {
      const limit = f.limit || 50;
      let q = supa.from('games').select(LIST_COLS).limit(limit + 1);
      if (f.q) {
        if (/^\d{1,12}$/.test(f.q)) q = q.eq('id', Number(f.q));
        else q = q.ilike('title', `%${escapeLike(f.q)}%`);
      }
      if (f.status) q = q.eq('status', f.status);
      if (f.provider) q = q.eq('provider_id', f.provider);
      if (f.category) q = q.eq('category', f.category);
      if (f.featured !== undefined) q = q.eq('featured', f.featured);
      if (f.updatedBy) q = q.eq('updated_by', f.updatedBy);
      if (f.since) q = q.gte('updated_at', f.since);
      if (f.until) q = q.lte('updated_at', f.until);
      const c = f.cursor;
      switch (f.sort || 'new') {
        case 'old':
          q = q.order('id', { ascending: true });
          if (c) q = q.gt('id', c.id);
          break;
        case 'title':
          q = q.order('title', { ascending: true }).order('id', { ascending: true });
          if (c) q = q.or(`title.gt.${pgrstQuote(c.v)},and(title.eq.${pgrstQuote(c.v)},id.gt.${Number(c.id)})`);
          break;
        case 'updated':
          q = q.order('updated_at', { ascending: false }).order('id', { ascending: false });
          if (c) q = q.or(`updated_at.lt.${pgrstQuote(c.v)},and(updated_at.eq.${pgrstQuote(c.v)},id.lt.${Number(c.id)})`);
          break;
        default:
          q = q.order('id', { ascending: false });
          if (c) q = q.lt('id', c.id);
      }
      const rows = (await run(q)) || [];
      return { rows: rows.slice(0, limit), hasMore: rows.length > limit };
    },

    async insertGame(row) {
      const d = await run(supa.from('games').insert(row).select(GAME_COLS));
      return d[0];
    },
    async insertGamesBatch(rows) {
      if (!rows.length) return 0;
      const d = await run(supa.from('games').upsert(rows, { onConflict: 'slug', ignoreDuplicates: true }).select('id'));
      return d?.length || 0;
    },
    async updateGame(id, patch, { expectUpdatedAt } = {}) {
      let q = supa.from('games').update(patch).eq('id', Number(id));
      if (expectUpdatedAt) q = q.eq('updated_at', expectUpdatedAt);
      const d = await run(q.select(GAME_COLS));
      return (d && d[0]) || null;
    },
    async deleteGame(id) {
      const d = await run(supa.from('games').delete().eq('id', Number(id)).select('id'));
      return !!d?.length;
    },
    async bulkTransition(ids, to, from, actor) {
      return run(supa.rpc('cms_bulk_transition', { p_ids: ids, p_to: to, p_from: from, p_actor: actor }), 'precondition');
    },
    async bulkPatch(ids, patch) {
      const d = await run(supa.from('games').update(patch).in('id', ids).select('id'));
      if ((d?.length || 0) !== ids.length) {
        throw new StoreError('precondition', `${ids.length - (d?.length || 0)} of the games no longer exist`);
      }
      return d.length;
    },
    async statusCounts() {
      const d = await run(supa.rpc('cms_status_counts'));
      const out = {};
      for (const r of d || []) out[r.status] = Number(r.games);
      return out;
    },
    /** Every game's identity, for the importer's duplicate and slug checks. Keyset on id. */
    async catalogIndex() {
      const out = [];
      let cursor = 0;
      for (let i = 0; i < 200; i++) {
        const d = await run(supa.from('games').select('id, slug, title, provider_id, external_id')
          .order('id', { ascending: true }).gt('id', cursor).limit(1000));
        if (!d?.length) break;
        out.push(...d);
        if (d.length < 1000) break;
        cursor = d[d.length - 1].id;
      }
      return out;
    },
    setGameTags: (id, list) => run(supa.rpc('cms_set_game_tags', { p_game_id: Number(id), p_tags: list })),
    async getGameTags(id) {
      const d = await run(supa.from('game_tag_links').select('tag_slug').eq('game_id', Number(id)).order('tag_slug').limit(30));
      return (d || []).map((r) => r.tag_slug);
    },

    // ── taxonomy ─────────────────────────────────────────────────────────
    listCategories: () => run(supa.from('game_categories').select('*').order('sort_order').order('slug').limit(1000)),
    getCategory: (slug) => one(supa.from('game_categories').select('*').eq('slug', slug)),
    async insertCategory(row) { return (await run(supa.from('game_categories').insert(row).select('*')))[0]; },
    async updateCategory(slug, patch) {
      const d = await run(supa.from('game_categories').update({ ...patch, updated_at: new Date().toISOString() }).eq('slug', slug).select('*'));
      return (d && d[0]) || null;
    },
    async deleteCategory(slug) {
      const d = await run(supa.from('game_categories').delete().eq('slug', slug).select('slug'));
      return !!d?.length;
    },
    listTags: ({ q, limit = 200 } = {}) => {
      let s = supa.from('game_tags').select('slug, label').order('slug').limit(limit);
      if (q) s = s.ilike('slug', `%${escapeLike(q)}%`);
      return run(s);
    },
    async upsertTag(row) { return (await run(supa.from('game_tags').upsert(row).select('*')))[0]; },
    async deleteTag(slug) { const d = await run(supa.from('game_tags').delete().eq('slug', slug).select('slug')); return !!d?.length; },

    // ── providers ────────────────────────────────────────────────────────
    listProviders: () => run(supa.from('game_providers').select('*').order('id').limit(200)),
    getProvider: (id) => one(supa.from('game_providers').select('*').eq('id', id)),
    async insertProvider(row) { return (await run(supa.from('game_providers').insert(row).select('*')))[0]; },
    async updateProvider(id, patch) {
      const d = await run(supa.from('game_providers').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', id).select('*'));
      return (d && d[0]) || null;
    },

    // ── settings ─────────────────────────────────────────────────────────
    listSettings: () => run(supa.from('site_settings').select('*').order('key').limit(500)),
    async putSetting(key, value, actor) {
      const d = await run(supa.from('site_settings').upsert({ key, value, updated_by: actor, updated_at: new Date().toISOString() }).select('*'));
      return d[0];
    },

    // ── staff ────────────────────────────────────────────────────────────
    listStaff: () => run(supa.from('admin_users')
      .select('id, username, display_name, role, status, must_change_password, status_reason, created_at, created_by, updated_at, updated_by, last_login_at, deleted_at')
      .order('username').limit(500)),
    getStaff: (id) => one(supa.from('admin_users').select('*').eq('id', id)),
    getStaffByUsername: (u) => one(supa.from('admin_users').select('*').ilike('username', escapeLike(String(u || '').toLowerCase()))),
    async insertStaff(row) { return (await run(supa.from('admin_users').insert(row).select('*')))[0]; },
    async updateStaff(id, patch) {
      const d = await run(supa.from('admin_users').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', id).select('*'));
      return (d && d[0]) || null;
    },
    async revokeStaffSessions(userId, reason) {
      const d = await run(supa.from('admin_sessions')
        .update({ revoked_at: new Date().toISOString(), revoked_reason: reason })
        .eq('user_id', userId).is('revoked_at', null).select('id'));
      return d?.length || 0;
    },
    async liveSessionCounts() {
      const d = await run(supa.from('admin_sessions').select('user_id, username')
        .is('revoked_at', null).gt('expires_at', new Date().toISOString()).order('id', { ascending: false }).limit(1000));
      const out = {};
      for (const r of d || []) { const k = r.user_id || `env:${r.username}`; out[k] = (out[k] || 0) + 1; }
      return out;
    },

    // ── proxy governance ─────────────────────────────────────────────────
    listTargets: () => run(supa.from('proxy_targets').select('*').order('pattern').limit(2000)),
    getTarget: (id) => one(supa.from('proxy_targets').select('*').eq('id', Number(id))),
    async insertTarget(row) { return (await run(supa.from('proxy_targets').insert(row).select('*')))[0]; },
    async updateTarget(id, patch) {
      const d = await run(supa.from('proxy_targets').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', Number(id)).select('*'));
      return (d && d[0]) || null;
    },
    async deleteTarget(id) { const d = await run(supa.from('proxy_targets').delete().eq('id', Number(id)).select('id')); return !!d?.length; },
    listProxyProviders: () => run(supa.from('proxy_providers').select('*').order('id').limit(50)),
    async putProxyProvider(row) {
      return (await run(supa.from('proxy_providers').upsert({ ...row, updated_at: new Date().toISOString() }).select('*')))[0];
    },
    getProxyPolicy: () => one(supa.from('proxy_policies').select('*').eq('id', 'default')),
    async putProxyPolicy(policy, actor) {
      return (await run(supa.from('proxy_policies').upsert({ id: 'default', policy, updated_by: actor, updated_at: new Date().toISOString() }).select('*')))[0];
    },

    // ── history ──────────────────────────────────────────────────────────
    auditFor: (type, id, limit = 50) => run(supa.from('admin_audit_logs')
      .select('id, at, username, actor_role, action, outcome, detail')
      .eq('resource_type', type).eq('resource_id', String(id))
      .order('id', { ascending: false }).limit(Math.min(200, limit))),
  };
}

export default { createSupabaseStore, pgrstQuote, GAME_COLS };
