// admin-ui/assets/admin-control.js — the control-plane sections of the console.
// ---------------------------------------------------------------------------
// Content (the game CMS), Review, Taxonomy, Providers, Staff, Settings, Proxy
// control, Audit and My account. Loaded by admin.js, which owns routing and the
// shared markup helpers.
//
// TWO RULES, same as admin.js:
//   · This file makes NO security decision. Controls a role cannot use are
//     hidden as a courtesy; every action is authorised again on the server,
//     which is the only place that counts.
//   · Every value that reaches innerHTML goes through esc(). Game titles,
//     descriptions, usernames, notes and hostnames are all user-supplied.
//
// Step-up: a destructive request the server answers with { reauth: true } opens
// a password prompt, confirms it at /api/admin/auth/reauth, and retries ONCE.
// ---------------------------------------------------------------------------

const STATUSES = ['draft', 'pending_review', 'approved', 'published', 'unpublished', 'archived', 'rejected'];
const STATUS_LABEL = {
  draft: 'Draft', pending_review: 'Pending review', approved: 'Approved', published: 'Published',
  unpublished: 'Unpublished', archived: 'Archived', rejected: 'Rejected',
};
const ACTION_LABEL = {
  submit: 'Submit for review', withdraw: 'Withdraw', approve: 'Approve', reject: 'Reject', publish: 'Publish',
  unpublish: 'Unpublish', reopen: 'Reopen as draft', archive: 'Archive', restore: 'Restore', delete: 'Delete permanently',
};
const BULK_OPS = [
  ['publish', 'Publish'], ['unpublish', 'Unpublish'], ['approve', 'Approve'], ['submit', 'Submit for review'],
  ['archive', 'Archive'], ['restore', 'Restore'], ['feature', 'Feature'], ['unfeature', 'Unfeature'],
  ['set_category', 'Set category…'], ['add_tag', 'Add tag…'], ['remove_tag', 'Remove tag…'],
];
const DESTRUCTIVE_BULK = new Set(['unpublish', 'archive', 'remove_tag']);

/** Nav entries this module adds, with the permission that makes each useful. */
export const CONTROL_NAV = {
  content: 'games.read', review: 'games.review', taxonomy: 'games.read', providers: 'games.read',
  staff: 'users.read', settings: 'games.read', proxyctl: 'proxy.read', audit: 'security.read', account: null,
};

export function controlViews(h) {
  const { esc, card, stat, pill, table, kv, fmt, when, ago, say } = h;
  const vroot = () => document.querySelector('#views > [data-vr]') || document.createElement('div');
  const me = () => h.me() || { permissions: [] };
  const can = (p) => (me().permissions || []).includes(p);

  // ── HTTP with step-up retry ──────────────────────────────────────────────
  function csrf() {
    const jar = Object.create(null);
    for (const part of (document.cookie || '').split(';')) {
      const i = part.indexOf('=');
      if (i > 0) jar[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    }
    return jar.zh_admin_csrf || '';
  }
  async function raw(path, method, body) {
    const headers = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (method !== 'GET') headers['x-csrf-token'] = csrf();
    const r = await fetch(path, { method, headers, credentials: 'same-origin', body: body === undefined ? undefined : JSON.stringify(body) });
    let data = {};
    try { data = await r.json(); } catch { /* not JSON */ }
    return { status: r.status, data };
  }
  async function call(path, { method = 'GET', body } = {}, retried = false) {
    const r = await raw(path, method, body);
    if (r.status === 401 && r.data.reauth && !retried) {
      if (await reauthPrompt(r.data.error)) return call(path, { method, body }, true);
      const e = new Error('Cancelled — the change needs your password.'); e.data = r.data; throw e;
    }
    if (r.status === 401 && !r.data.reauth) { window.location.replace('/admin/login'); throw new Error('unauthorized'); }
    if (r.status === 403 && r.data.passwordChangeRequired) { location.hash = 'account'; }
    if (!r.data.ok) { const e = new Error(r.data.error || `HTTP ${r.status}`); e.data = r.data; e.status = r.status; throw e; }
    return r.data;
  }

  // ── Small UI kit ─────────────────────────────────────────────────────────
  const statusPill = (s) => `<span class="pill s-${esc(s)}">${esc(STATUS_LABEL[s] || s)}</span>`;
  const opt = (v, label, sel) => `<option value="${esc(v)}"${sel ? ' selected' : ''}>${esc(label)}</option>`;
  const errorsHtml = (e) => {
    const list = e?.data?.errors || e?.data?.failures?.map((f) => `#${f.id}${f.slug ? ` (${f.slug})` : ''}: ${f.reason}`) || [];
    return `<div class="form-errors" role="alert">${esc(e?.message || 'Something went wrong')}${list.length ? `<ul>${list.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}</div>`;
  };
  function sheet(title, body, { size = '' } = {}) {
    const d = document.createElement('dialog');
    d.className = `sheet ${size}`;
    d.innerHTML = `<div class="sheet-head"><h2>${esc(title)}</h2><span class="spacer"></span>
      <button class="btn sm ghost" data-close aria-label="Close">Close</button></div><div class="sheet-body">${body}</div>`;
    document.body.appendChild(d);
    d.addEventListener('close', () => d.remove());
    d.querySelector('[data-close]').addEventListener('click', () => d.close());
    d.showModal();
    return d;
  }
  function reauthPrompt(reason) {
    return new Promise((resolve) => {
      const d = sheet('Confirm your password', `
        <p class="hint" style="margin-top:0">${esc(reason || 'This change needs your password.')}</p>
        <form data-f>
          <label class="field"><span>Password</span><input type="password" name="pw" autocomplete="current-password" required></label>
          <div data-err></div>
          <div class="form-actions"><button class="btn primary" type="submit">Confirm</button></div>
        </form>`, { size: 'sm' });
      let done = false;
      d.addEventListener('close', () => { if (!done) resolve(false); });
      d.querySelector('[data-f]').addEventListener('submit', async (ev) => {
        ev.preventDefault();
        const r = await raw('/api/admin/auth/reauth', 'POST', { password: d.querySelector('[name=pw]').value });
        if (r.data.ok) { done = true; d.close(); resolve(true); return; }
        d.querySelector('[data-err]').innerHTML = errorsHtml({ message: r.data.error });
      });
      d.querySelector('[name=pw]').focus();
    });
  }
  function download(name, text, type) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type }));
    a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }
  const flash = (text, kind = 'ok') => say(text, kind);
  const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

  // ── Shared lookups ───────────────────────────────────────────────────────
  let lookups = null;
  async function getLookups(force = false) {
    if (lookups && !force) return lookups;
    const [p, c] = await Promise.all([call('/api/admin/cms/providers'), call('/api/admin/cms/categories')]);
    lookups = { providers: p.providers || [], categories: c.categories || [] };
    return lookups;
  }

  // ===========================================================================
  // Game editor (create + edit), shared by Content and Review
  // ===========================================================================
  async function openEditor(id, onDone) {
    const lk = await getLookups();
    let data = { game: { status: 'draft', provider_id: 'gamedistribution', category: 'arcade', featured: false, sort_order: 0 }, tags: [], actions: [], editable: can('games.create') };
    if (id) data = await call(`/api/admin/cms/games/${id}`);
    const g = data.game;
    const editable = id ? data.editable : can('games.create');
    const ro = editable ? '' : ' disabled';
    const provOpts = lk.providers.map((p) => opt(p.id, `${p.name} (${p.status})`, p.id === g.provider_id)).join('');
    const catOpts = lk.categories.map((c) => opt(c.slug, c.label, c.slug === g.category)).join('');
    const flags = g.license_review?.flags || [];
    const actions = (data.actions || []).filter((a) => a !== 'delete');
    const d = sheet(id ? `Edit · ${g.title}` : 'New game', `
      ${id ? `<div class="tabs" role="tablist"><button role="tab" aria-selected="true" data-tab="edit">Details</button><button role="tab" aria-selected="false" data-tab="history">History</button></div>` : ''}
      <div data-pane="edit">
        ${id ? `<p class="hint" style="margin-top:0">${statusPill(g.status)} · #${esc(g.id)} · updated ${esc(ago(g.updated_at))} by ${esc(g.updated_by || '—')}</p>` : ''}
        ${flags.length ? `<div class="note warn"><b>Licensing review:</b> ${flags.map((f) => esc(`${f.code.replace(/_/g, ' ')} — ${f.detail || ''}`)).join('; ')}</div>` : ''}
        <form data-f>
          <div class="form-grid">
            <label class="field wide"><span>Title</span><input name="title" maxlength="120" required value="${esc(g.title || '')}"${ro}></label>
            <label class="field"><span>Slug</span><input name="slug" maxlength="120" value="${esc(g.slug || '')}" placeholder="from the title"${ro}></label>
            <label class="field"><span>Category</span><select name="category"${ro}>${catOpts}</select></label>
            <label class="field"><span>Provider</span><select name="provider_id"${ro}>${provOpts}</select></label>
            <label class="field"><span>Featured</span><select name="featured"${ro}>${opt('false', 'No', !g.featured)}${opt('true', 'Yes', g.featured)}</select></label>
            <label class="field wide"><span>Embed URL</span><input name="game_url" type="url" maxlength="2048" required value="${esc(g.game_url || '')}" placeholder="https://html5.gamedistribution.com/…/"${ro}>
              <small>Must be served from the provider's approved origins. Changing it on a reviewed game sends it back to review unless you can publish.</small></label>
            <label class="field wide"><span>Thumbnail URL</span><input name="thumbnail_url" maxlength="2048" value="${esc(g.thumbnail_url || '')}"${ro}>
              <small>The provider's image origin, or /thumbs/&lt;file&gt;. SVG is refused.</small></label>
            ${g.thumbnail_url && /^https:\/\//.test(g.thumbnail_url) ? `<div class="wide"><img class="thumb lg" alt="" src="${esc(g.thumbnail_url)}" referrerpolicy="no-referrer"></div>` : ''}
            <label class="field wide"><span>Short description</span><input name="short_description" maxlength="280" value="${esc(g.short_description || '')}"${ro}></label>
            <label class="field wide"><span>Description</span><textarea name="description" maxlength="4000"${ro}>${esc(g.description || '')}</textarea></label>
            <label class="field"><span>Tags</span><input name="tags" value="${esc((data.tags || []).join(', '))}" placeholder="comma separated"${ro}></label>
            <label class="field"><span>Sort order</span><input name="sort_order" type="number" min="-100000" max="100000" value="${esc(g.sort_order ?? 0)}"${ro}></label>
            <label class="field"><span>Publisher</span><input name="publisher" maxlength="120" value="${esc(g.publisher || '')}"${ro}></label>
            <label class="field"><span>Developer</span><input name="developer" maxlength="120" value="${esc(g.developer || '')}"${ro}></label>
          </div>
          <div data-err></div>
          <div class="form-actions">
            ${editable ? `<button class="btn primary" type="submit">${id ? 'Save changes' : 'Create draft'}</button>` : ''}
            ${actions.map((a) => `<button class="btn${['reject', 'archive', 'unpublish'].includes(a) ? ' danger' : ''}" type="button" data-act="${esc(a)}">${esc(ACTION_LABEL[a] || a)}</button>`).join('')}
            ${(data.actions || []).includes('delete') ? '<button class="btn danger" type="button" data-act="delete">Delete permanently</button>' : ''}
          </div>
        </form>
      </div>
      <div data-pane="history" hidden><p class="empty">Loading…</p></div>`);

    const form = d.querySelector('[data-f]');
    const err = d.querySelector('[data-err]');
    const collect = () => {
      const f = new FormData(form);
      const out = {};
      for (const k of ['title', 'slug', 'category', 'provider_id', 'game_url', 'thumbnail_url', 'short_description', 'description', 'publisher', 'developer']) {
        const v = String(f.get(k) ?? '').trim();
        out[k] = v === '' ? null : v;
      }
      if (!out.slug) delete out.slug;
      out.featured = f.get('featured') === 'true';
      out.sort_order = parseInt(f.get('sort_order'), 10) || 0;
      out.tags = String(f.get('tags') || '').split(',').map((t) => t.trim()).filter(Boolean);
      return out;
    };
    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      err.innerHTML = '';
      try {
        if (id) {
          const r = await call(`/api/admin/cms/games/${id}`, { method: 'PATCH', body: { changes: collect(), expectUpdatedAt: g.updated_at } });
          flash(r.sentBackToReview ? 'Saved — the change went back to review.' : 'Saved.');
        } else {
          const r = await call('/api/admin/cms/games', { method: 'POST', body: collect() });
          flash(`Draft “${r.game.title}” created.`);
        }
        d.close(); onDone?.();
      } catch (e) { err.innerHTML = errorsHtml(e); }
    });
    d.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', async () => {
      const action = b.dataset.act;
      err.innerHTML = '';
      try {
        if (action === 'delete') {
          const typed = window.prompt(`Type the slug (${g.slug}) to delete this game permanently. This cannot be undone.`);
          if (typed === null) return;
          await call(`/api/admin/cms/games/${id}`, { method: 'DELETE', body: { confirm: typed } });
          flash('Deleted. A snapshot of the record is kept in the audit trail.');
        } else {
          let note;
          if (action === 'reject') { note = window.prompt('Why is this game rejected? (shown in its history)'); if (note === null) return; }
          await call(`/api/admin/cms/games/${id}/transition`, { method: 'POST', body: { action, note, expectUpdatedAt: g.updated_at } });
          flash(`${ACTION_LABEL[action] || action}: done.`);
        }
        d.close(); onDone?.();
      } catch (e) { err.innerHTML = errorsHtml(e); }
    }));
    d.querySelectorAll('[data-tab]').forEach((t) => t.addEventListener('click', async () => {
      d.querySelectorAll('[data-tab]').forEach((x) => x.setAttribute('aria-selected', String(x === t)));
      d.querySelector('[data-pane=edit]').hidden = t.dataset.tab !== 'edit';
      const hp = d.querySelector('[data-pane=history]');
      hp.hidden = t.dataset.tab !== 'history';
      if (t.dataset.tab === 'history') {
        try { hp.innerHTML = historyList((await call(`/api/admin/cms/games/${id}/history`)).history); }
        catch (e) { hp.innerHTML = errorsHtml(e); }
      }
    }));
  }

  function historyList(rows) {
    if (!rows?.length) return '<p class="empty">No recorded changes yet.</p>';
    return `<ol class="timeline">${rows.map((r) => `<li>
      <time datetime="${esc(r.at)}">${esc(when(r.at))}</time>
      <div><b>${esc(r.action)}</b> ${r.outcome && r.outcome !== 'success' ? pill(r.outcome, r.outcome === 'denied' ? 'bad' : 'warn') : ''}
        · ${esc(r.username || '—')}${r.actor_role ? ` <span class="hint">(${esc(r.actor_role)})</span>` : ''}</div>
      ${r.detail ? `<pre>${esc(JSON.stringify(r.detail, null, 1)).slice(0, 1600)}</pre>` : ''}
    </li>`).join('')}</ol>`;
  }

  // ===========================================================================
  // Content
  // ===========================================================================
  const content = {
    state: { f: { q: '', status: '', provider: '', category: '', featured: '', sort: 'new' }, rows: [], cursor: null, sel: new Set() },
    title: 'Content',
    sub: 'Every game, in every state',
    async render() {
      const s = content.state;
      s.sel.clear();
      const [lk, page, st] = await Promise.all([getLookups(true), content.fetch(null), call('/api/admin/cms/status').catch(() => null)]);
      s.rows = page.rows; s.cursor = page.nextCursor;
      const f = s.f;
      const banner = st && st.schema !== 'ready'
        ? `<p class="msg ${st.schema === 'memory' ? 'info' : 'error'}">${esc(st.reason || st.schema)}</p>` : '';
      return `${banner}
        <div class="toolbar">
          <label class="field grow"><span>Search</span><input class="ctl" data-f="q" placeholder="Title or #id" value="${esc(f.q)}"></label>
          <label class="field"><span>Status</span><select class="ctl" data-f="status">${opt('', 'Any')}${STATUSES.map((x) => opt(x, STATUS_LABEL[x], f.status === x)).join('')}</select></label>
          <label class="field"><span>Provider</span><select class="ctl" data-f="provider">${opt('', 'Any')}${lk.providers.map((p) => opt(p.id, p.name, f.provider === p.id)).join('')}</select></label>
          <label class="field"><span>Category</span><select class="ctl" data-f="category">${opt('', 'Any')}${lk.categories.map((c) => opt(c.slug, c.label, f.category === c.slug)).join('')}</select></label>
          <label class="field"><span>Featured</span><select class="ctl" data-f="featured">${opt('', 'Any')}${opt('true', 'Featured', f.featured === 'true')}${opt('false', 'Not featured', f.featured === 'false')}</select></label>
          <label class="field"><span>Sort</span><select class="ctl" data-f="sort">${[['new', 'Newest'], ['old', 'Oldest'], ['title', 'Title A–Z'], ['updated', 'Recently edited']].map(([v, l]) => opt(v, l, f.sort === v)).join('')}</select></label>
        </div>
        <div class="toolbar">
          ${can('games.create') ? '<button class="btn primary" data-act="new">New game</button>' : ''}
          ${can('games.create') ? '<button class="btn" data-act="import">Import file…</button>' : ''}
          <button class="btn" data-act="export-csv">Export CSV</button>
          <button class="btn" data-act="export-json">Export JSON</button>
          ${can('games.import') ? '<span class="spacer"></span><button class="btn" data-act="gd">GameDistribution import…</button>' : ''}
        </div>
        ${card('', `<div data-table>${content.tableHtml()}</div>
          <div class="form-actions" data-more-wrap ${s.cursor ? '' : 'hidden'}><button class="btn" data-act="more">Load more</button></div>`)}
        ${can('games.bulk') ? `<div class="bulkbar" data-bulk hidden>
          <b data-count>0</b> selected
          <select class="ctl" data-bulk-op style="width:auto">${BULK_OPS.map(([v, l]) => opt(v, l)).join('')}</select>
          <input class="ctl" data-bulk-val placeholder="category or tag" style="width:180px" hidden>
          <button class="btn" data-act="bulk-preview">Preview</button>
          <button class="btn sm ghost" data-act="bulk-clear">Clear</button>
          <span data-bulk-msg class="hint"></span>
        </div>` : ''}`;
    },
    async fetch(cursor) {
      const q = new URLSearchParams();
      for (const [k, v] of Object.entries(content.state.f)) if (v) q.set(k, v);
      q.set('limit', '50');
      if (cursor) q.set('cursor', cursor);
      return call(`/api/admin/cms/games?${q}`);
    },
    tableHtml() {
      const s = content.state;
      const bulk = can('games.bulk');
      return table(
        [...(bulk ? [{ t: '', cls: 'sel-col' }] : []), { t: '' }, { t: 'Game' }, { t: 'Status' }, { t: 'Provider' }, { t: 'Category' }, { t: 'Edited' }],
        s.rows.map((g) => [
          ...(bulk ? [`<input type="checkbox" data-sel="${esc(g.id)}" aria-label="Select ${esc(g.title)}"${s.sel.has(g.id) ? ' checked' : ''}>`] : []),
          g.thumbnail_url && /^https:\/\//.test(g.thumbnail_url) ? `<img class="thumb" alt="" loading="lazy" referrerpolicy="no-referrer" src="${esc(g.thumbnail_url)}">` : '',
          `<button class="linkish" data-open="${esc(g.id)}"><span class="ttl">${esc(g.title)}</span></button><br><span class="mono trunc">${esc(g.slug)}</span>${g.featured ? ' ' + pill('featured', 'brand') : ''}${g.license_review?.flags?.length ? ' ' + pill('licence flag', 'warn') : ''}${g.is_working === false ? ' ' + pill('not loading', 'bad') : ''}`,
          statusPill(g.status),
          esc(g.provider_id || '—'),
          esc(g.category || '—'),
          `<span title="${esc(when(g.updated_at))}">${esc(ago(g.updated_at))}</span>`,
        ]),
      );
    },
    wire() {
      const root = vroot();
      const s = content.state;
      const reload = async () => {
        const page = await content.fetch(null);
        s.rows = page.rows; s.cursor = page.nextCursor; s.sel.clear();
        root.querySelector('[data-table]').innerHTML = content.tableHtml();
        root.querySelector('[data-more-wrap]').hidden = !s.cursor;
        syncBulk();
      };
      const syncBulk = () => {
        const bar = root.querySelector('[data-bulk]');
        if (!bar) return;
        bar.hidden = s.sel.size === 0;
        bar.querySelector('[data-count]').textContent = String(s.sel.size);
      };
      root.querySelectorAll('[data-f]').forEach((el) => {
        const upd = () => { s.f[el.dataset.f] = el.value.trim(); reload().catch((e) => say(e.message)); };
        el.addEventListener(el.tagName === 'INPUT' ? 'input' : 'change', el.tagName === 'INPUT' ? debounce(upd, 300) : upd);
      });
      root.addEventListener('change', (ev) => {
        const cb = ev.target.closest('[data-sel]');
        if (!cb) return;
        const id = Number(cb.dataset.sel);
        if (cb.checked) { if (s.sel.size >= 200) { cb.checked = false; say('At most 200 games per bulk operation.'); return; } s.sel.add(id); }
        else s.sel.delete(id);
        syncBulk();
      });
      const opSel = root.querySelector('[data-bulk-op]');
      opSel?.addEventListener('change', () => { root.querySelector('[data-bulk-val]').hidden = !['set_category', 'add_tag', 'remove_tag'].includes(opSel.value); });
      root.addEventListener('click', async (ev) => {
        const open = ev.target.closest('[data-open]');
        if (open) { openEditor(Number(open.dataset.open), reload).catch((e) => say(e.message)); return; }
        const b = ev.target.closest('[data-act]');
        if (!b || !root.contains(b)) return;
        try {
          switch (b.dataset.act) {
            case 'new': await openEditor(null, reload); break;
            case 'more': {
              const page = await content.fetch(s.cursor);
              s.rows.push(...page.rows); s.cursor = page.nextCursor;
              root.querySelector('[data-table]').innerHTML = content.tableHtml();
              root.querySelector('[data-more-wrap]').hidden = !s.cursor;
              break;
            }
            case 'export-csv': case 'export-json': {
              const fmtName = b.dataset.act === 'export-csv' ? 'csv' : 'json';
              const q = new URLSearchParams({ format: fmtName });
              if (s.f.status) q.set('status', s.f.status);
              if (s.f.provider) q.set('provider', s.f.provider);
              const r = await fetch(`/api/admin/cms/export?${q}`, { credentials: 'same-origin' });
              if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.error || `HTTP ${r.status}`); }
              download(`zofhub-games.${fmtName}`, await r.text(), fmtName === 'csv' ? 'text/csv' : 'application/json');
              break;
            }
            case 'import': importDialog(reload); break;
            case 'gd': gdDialog(); break;
            case 'bulk-clear': s.sel.clear(); root.querySelectorAll('[data-sel]').forEach((x) => { x.checked = false; }); syncBulk(); break;
            case 'bulk-preview': await bulkFlow(root, reload); break;
            default: break;
          }
        } catch (e) { say(e.message); }
      });
    },
  };

  async function bulkFlow(root, reload) {
    const s = content.state;
    const op = root.querySelector('[data-bulk-op]').value;
    const value = root.querySelector('[data-bulk-val]').value.trim();
    const ids = [...s.sel];
    const msg = root.querySelector('[data-bulk-msg]');
    let preview;
    try { preview = await call('/api/admin/cms/bulk', { method: 'POST', body: { ids, op, value, preview: true } }); }
    catch (e) { msg.textContent = e.message; return; }
    const fails = preview.failures || [];
    const d = sheet(`Bulk: ${op.replace(/_/g, ' ')}`, `
      <p style="margin-top:0">${fmt(preview.valid)} of ${fmt(preview.requested)} games can take this change.</p>
      ${fails.length ? `<div class="form-errors"><b>Nothing will change until these are resolved or deselected:</b><ul>${fails.slice(0, 40).map((f) => `<li>#${esc(f.id)} ${esc(f.slug || '')} — ${esc(f.reason)}</li>`).join('')}</ul></div>` : ''}
      ${!fails.length && DESTRUCTIVE_BULK.has(op) ? `<label class="field"><span>Type ${fmt(ids.length)} to confirm</span><input data-confirm inputmode="numeric"></label>` : ''}
      <div data-err></div>
      <div class="form-actions">${fails.length ? '' : '<button class="btn primary" data-go>Apply to all</button>'}</div>`, { size: 'sm' });
    d.querySelector('[data-go]')?.addEventListener('click', async () => {
      try {
        const confirm = d.querySelector('[data-confirm]')?.value;
        const r = await call('/api/admin/cms/bulk', { method: 'POST', body: { ids, op, value, confirm: confirm === undefined ? undefined : Number(confirm) } });
        const failed = (r.results || []).filter((x) => !x.ok);
        flash(failed.length ? `${fmt(r.applied)} changed; ${fmt(failed.length)} failed (see history).` : `${fmt(r.applied)} game(s) changed.`, failed.length ? 'error' : 'ok');
        d.close(); reload();
      } catch (e) { d.querySelector('[data-err]').innerHTML = errorsHtml(e); }
    });
  }

  function importDialog(reload) {
    const d = sheet('Import games from a file', `
      <p class="hint" style="margin-top:0">A JSON array of games (max 500). Every row is validated exactly like the editor, and imported games arrive as <b>drafts</b> — nothing is published by an import.</p>
      <label class="field"><span>File</span><input type="file" accept="application/json,.json" data-file></label>
      <div data-plan></div><div data-err></div>
      <div class="form-actions"><button class="btn" data-preview>Preview</button><button class="btn primary" data-apply hidden>Import</button></div>`);
    let games = null; let plan = null;
    d.querySelector('[data-preview]').addEventListener('click', async () => {
      d.querySelector('[data-err]').innerHTML = '';
      try {
        const f = d.querySelector('[data-file]').files[0];
        if (!f) throw new Error('Choose a file first.');
        if (f.size > 2 * 1024 * 1024) throw new Error('That file is larger than 2 MB.');
        games = JSON.parse(await f.text());
        plan = await call('/api/admin/cms/import/preview', { method: 'POST', body: { games } });
        d.querySelector('[data-plan]').innerHTML = `
          <p>${fmt(plan.valid.length)} valid · ${fmt(plan.invalid.length)} rejected (of ${fmt(plan.total)})</p>
          ${plan.invalid.length ? `<div class="form-errors"><ul>${plan.invalid.slice(0, 30).map((x) => `<li>row ${esc(x.index)}${x.title ? ` “${esc(x.title)}”` : ''}: ${esc(x.errors.join('; '))}</li>`).join('')}</ul></div>` : ''}`;
        d.querySelector('[data-apply]').hidden = !plan.valid.length;
      } catch (e) { d.querySelector('[data-err]').innerHTML = errorsHtml(e); }
    });
    d.querySelector('[data-apply]').addEventListener('click', async () => {
      try {
        const r = await call('/api/admin/cms/import/apply', { method: 'POST', body: { games, confirm: plan.valid.length } });
        flash(`Imported ${fmt(r.created)} draft(s)${r.failed.length ? `; ${fmt(r.failed.length)} failed` : ''}.`, r.failed.length ? 'error' : 'ok');
        d.close(); reload();
      } catch (e) { d.querySelector('[data-err]').innerHTML = errorsHtml(e); }
    });
  }

  function gdDialog() {
    const d = sheet('GameDistribution import', `
      <p class="hint" style="margin-top:0">Reads GameDistribution's official catalog feed. Every game is screened: not-live, non-https or mismatched embeds are rejected; any title, tag or description naming a third-party mark is held for review. Clean games are published only if the <b>Auto-publish clean imports</b> setting is on.</p>
      <label class="field"><span>Only these ids (optional)</span><textarea data-ids placeholder="32-character ids, one per line (max 50)"></textarea></label>
      <div class="form-actions"><button class="btn" data-run="dry">Dry run</button><button class="btn primary" data-run="real">Run import</button><button class="btn ghost" data-refresh>Refresh status</button></div>
      <div data-err></div><div data-status><p class="empty">Loading…</p></div>`);
    const show = async () => {
      try {
        const { job } = await call('/api/admin/cms/import/gamedistribution');
        const r = job.report;
        d.querySelector('[data-status]').innerHTML = `
          ${kv([
            ['State', job.running ? pill('running', 'info') : job.error ? pill('failed', 'bad') : r ? pill('finished', 'ok') : pill('never run')],
            ['Started', `${esc(when(job.startedAt))}${job.by ? ` by ${esc(job.by)}` : ''}`],
            ['Mode', job.dryRun ? 'dry run (nothing written)' : 'import'],
            job.error ? ['Error', esc(job.error)] : null,
          ])}
          ${r ? `<h3 style="font-size:13px;margin:14px 0 6px">Result</h3>${kv(Object.entries(r.counts).map(([k, v]) => [k, fmt(v)]))}
            ${Object.keys(r.flagCounts || {}).length ? `<p class="hint">Held for review: ${Object.entries(r.flagCounts).map(([k, v]) => `${esc(k.replace(/_/g, ' '))} ${fmt(v)}`).join(' · ')}</p>` : ''}
            ${(r.planned || []).length ? table([{ t: 'Game' }, { t: 'Status' }, { t: 'Flags' }], r.planned.slice(0, 30).map((p) => [esc(p.title), statusPill(p.status), esc((p.flags || []).join(', ') || '—')])) : ''}` : ''}`;
      } catch (e) { d.querySelector('[data-err]').innerHTML = errorsHtml(e); }
    };
    d.querySelectorAll('[data-run]').forEach((b) => b.addEventListener('click', async () => {
      d.querySelector('[data-err]').innerHTML = '';
      const ids = d.querySelector('[data-ids]').value.split(/\s+/).map((x) => x.trim()).filter(Boolean);
      try {
        await call('/api/admin/cms/import/gamedistribution', { method: 'POST', body: { dryRun: b.dataset.run === 'dry', ...(ids.length ? { onlyIds: ids } : {}) } });
        show();
      } catch (e) { d.querySelector('[data-err]').innerHTML = errorsHtml(e); }
    }));
    d.querySelector('[data-refresh]').addEventListener('click', show);
    show();
  }

  // ===========================================================================
  // Review queue
  // ===========================================================================
  const review = {
    title: 'Review',
    sub: 'Games waiting for a decision',
    async render() {
      const page = await call('/api/admin/cms/games?status=pending_review&limit=60&sort=old');
      if (!page.rows.length) return card('Review queue', '<p class="empty">Nothing is waiting for review.</p>');
      const both = can('games.review') && can('games.publish');
      return `<p class="hint">Oldest first. Licence flags come from the automated screen; approving a flagged game records that a person looked at it and decided.</p>
        <div class="grid g-2">${page.rows.map((g) => card('', `
          <div style="display:flex;gap:12px;align-items:flex-start">
            ${g.thumbnail_url && /^https:\/\//.test(g.thumbnail_url) ? `<img class="thumb lg" alt="" loading="lazy" referrerpolicy="no-referrer" src="${esc(g.thumbnail_url)}">` : ''}
            <div style="min-width:0">
              <b>${esc(g.title)}</b><br><span class="mono trunc">${esc(g.slug)}</span>
              <p class="hint" style="margin:6px 0">${esc(g.provider_id || '—')} · ${esc(g.category)} · waiting ${esc(ago(g.updated_at))}</p>
              <div class="flags">${(g.license_review?.flags || []).map((f) => pill(`${f.code.replace(/_/g, ' ')}${f.detail ? ': ' + f.detail : ''}`, 'warn')).join('') || pill('no flags', 'ok')}</div>
            </div>
          </div>
          <div class="form-actions">
            <button class="btn sm" data-open="${esc(g.id)}">Open</button>
            ${can('games.review') ? `<button class="btn sm" data-t="approve" data-id="${esc(g.id)}">Approve</button>` : ''}
            ${both ? `<button class="btn sm primary" data-t="approve+publish" data-id="${esc(g.id)}">Approve &amp; publish</button>` : ''}
            ${can('games.review') ? `<button class="btn sm danger" data-t="reject" data-id="${esc(g.id)}">Reject</button>` : ''}
          </div>`, { state: g.license_review?.flags?.length ? 'warn' : '' })).join('')}</div>`;
    },
    wire() {
      const root = vroot();
      root.addEventListener('click', async (ev) => {
        const open = ev.target.closest('[data-open]');
        if (open) { openEditor(Number(open.dataset.open), () => h.rerender()).catch((e) => say(e.message)); return; }
        const b = ev.target.closest('[data-t]');
        if (!b) return;
        const id = b.dataset.id;
        try {
          if (b.dataset.t === 'reject') {
            const note = window.prompt('Why is this game rejected?');
            if (note === null) return;
            await call(`/api/admin/cms/games/${id}/transition`, { method: 'POST', body: { action: 'reject', note } });
          } else {
            await call(`/api/admin/cms/games/${id}/transition`, { method: 'POST', body: { action: 'approve' } });
            if (b.dataset.t === 'approve+publish') await call(`/api/admin/cms/games/${id}/transition`, { method: 'POST', body: { action: 'publish' } });
          }
          flash('Done.'); h.rerender();
        } catch (e) { say(e.message); }
      });
    },
  };

  // ===========================================================================
  // Taxonomy
  // ===========================================================================
  const taxonomy = {
    title: 'Taxonomy',
    sub: 'Categories and tags',
    async render() {
      const [c, t] = await Promise.all([call('/api/admin/cms/categories'), call('/api/admin/cms/tags')]);
      const edit = can('taxonomy.manage');
      const cats = c.categories || [];
      return `<div class="grid g-wide">
        ${card('Categories', `${table([{ t: 'Label' }, { t: 'Key' }, { t: 'Games', n: true }, { t: 'Shown' }, { t: '' }],
          cats.map((x, i) => [
            esc(x.label), `<span class="mono">${esc(x.slug)}</span>`, fmt(x.games),
            x.visible ? pill('shown', 'ok') : pill('hidden'),
            edit ? `<div class="btn-row">
              <button class="btn sm" data-up="${i}" ${i === 0 ? 'disabled' : ''} aria-label="Move up">↑</button>
              <button class="btn sm" data-down="${i}" ${i === cats.length - 1 ? 'disabled' : ''} aria-label="Move down">↓</button>
              <button class="btn sm" data-cedit="${esc(x.slug)}">Edit</button>
              <button class="btn sm danger" data-cdel="${esc(x.slug)}" ${x.games ? 'disabled title="Holds games — move them first or hide it"' : ''}>Delete</button></div>` : '',
          ]))}`, { hint: 'Order and visibility apply to the public category navigation. A category that holds games cannot be deleted; hide it instead.' })}
        <div class="grid">
          ${edit ? card('New category', `<form data-cnew class="form-grid">
            <label class="field"><span>Key</span><input name="slug" required pattern="[a-z0-9][a-z0-9-]{0,39}" placeholder="e.g. rhythm"></label>
            <label class="field"><span>Label</span><input name="label" required maxlength="60"></label>
            <div class="wide form-actions"><button class="btn primary">Create</button></div></form>`) : ''}
          ${card('Tags', (t.tags || []).length ? `<div class="flags">${t.tags.map((x) => `${pill(x.slug)}${edit ? ` <button class="btn sm ghost" data-tdel="${esc(x.slug)}" aria-label="Delete tag ${esc(x.slug)}">×</button>` : ''}`).join(' ')}</div>` : '<p class="empty">No tags yet.</p>')}
        </div></div>`;
    },
    wire() {
      const root = vroot();
      let cats = null;
      const load = async () => { cats = cats || (await call('/api/admin/cms/categories')).categories; return cats; };
      root.querySelector('[data-cnew]')?.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        const f = new FormData(ev.target);
        try { await call('/api/admin/cms/categories', { method: 'POST', body: { slug: f.get('slug'), label: f.get('label') } }); lookups = null; h.rerender(); }
        catch (e) { say(e.message); }
      });
      root.addEventListener('click', async (ev) => {
        const b = ev.target.closest('button');
        if (!b) return;
        try {
          if (b.dataset.up || b.dataset.down) {
            const list = (await load()).map((c) => c.slug);
            const i = Number(b.dataset.up ?? b.dataset.down);
            const j = b.dataset.up !== undefined ? i - 1 : i + 1;
            [list[i], list[j]] = [list[j], list[i]];
            await call('/api/admin/cms/categories/reorder', { method: 'POST', body: { order: list } });
            h.rerender();
          } else if (b.dataset.cedit) {
            const c = (await load()).find((x) => x.slug === b.dataset.cedit);
            const d = sheet(`Category · ${c.label}`, `<form data-ce class="form-grid">
              <label class="field"><span>Label</span><input name="label" required maxlength="60" value="${esc(c.label)}"></label>
              <label class="field"><span>Shown in navigation</span><select name="visible">${opt('true', 'Yes', c.visible)}${opt('false', 'No', !c.visible)}</select></label>
              <label class="field wide"><span>Description</span><textarea name="description" maxlength="500">${esc(c.description || '')}</textarea></label>
              <div class="wide" data-err></div>
              <div class="wide form-actions"><button class="btn primary">Save</button></div></form>`, { size: 'sm' });
            d.querySelector('[data-ce]').addEventListener('submit', async (e2) => {
              e2.preventDefault();
              const f = new FormData(e2.target);
              try {
                await call(`/api/admin/cms/categories/${encodeURIComponent(c.slug)}`, { method: 'PATCH', body: { label: f.get('label'), visible: f.get('visible') === 'true', description: f.get('description') || null } });
                d.close(); lookups = null; h.rerender();
              } catch (e) { d.querySelector('[data-err]').innerHTML = errorsHtml(e); }
            });
          } else if (b.dataset.cdel) {
            if (!window.confirm(`Delete the category “${b.dataset.cdel}”?`)) return;
            await call(`/api/admin/cms/categories/${encodeURIComponent(b.dataset.cdel)}`, { method: 'DELETE' });
            lookups = null; h.rerender();
          } else if (b.dataset.tdel) {
            if (!window.confirm(`Delete the tag “${b.dataset.tdel}” from every game?`)) return;
            await call(`/api/admin/cms/tags/${encodeURIComponent(b.dataset.tdel)}`, { method: 'DELETE' });
            h.rerender();
          }
        } catch (e) { say(e.message); }
      });
    },
  };

  // ===========================================================================
  // Providers
  // ===========================================================================
  const PSTATE = { approved: 'ok', restricted: 'warn', pending: 'info', suspended: 'bad', revoked: 'bad' };
  const providers = {
    title: 'Providers',
    sub: 'Who may supply games, and from where',
    async render() {
      const { providers: rows } = await call('/api/admin/cms/providers');
      return `${can('providers.manage') ? '<div class="toolbar"><button class="btn primary" data-pnew>New provider</button></div>' : ''}
        ${card('', table([{ t: 'Provider' }, { t: 'Status' }, { t: 'Embed origins' }, { t: 'Mode' }, { t: 'Reviewed' }, { t: '' }],
          rows.map((p) => [
            `<b>${esc(p.name)}</b><br><span class="mono">${esc(p.id)}</span>`,
            pill(p.status, PSTATE[p.status] || ''),
            (p.embed_origins || []).map((o) => `<span class="mono">${esc(o)}</span>`).join('<br>') || '<span class="hint">none</span>',
            esc(p.embed_mode),
            `${esc(ago(p.reviewed_at))}${p.reviewed_by ? `<br><span class="hint">${esc(p.reviewed_by)}</span>` : ''}`,
            can('providers.manage') ? `<button class="btn sm" data-pedit="${esc(p.id)}">Edit</button>` : '',
          ])), { hint: 'A game can only be created against an APPROVED provider, and only with an embed URL from one of its origins. Suspending or revoking a provider withdraws all of its games from the public site at once.' })}`;
    },
    wire() {
      const root = vroot();
      const form = (p = {}) => `<form data-pf class="form-grid">
        ${p.id ? '' : '<label class="field"><span>Id</span><input name="id" required pattern="[a-z0-9][a-z0-9-]{1,39}"></label>'}
        <label class="field"><span>Name</span><input name="name" required maxlength="80" value="${esc(p.name || '')}"></label>
        <label class="field"><span>Status</span><select name="status">${['approved', 'restricted', 'pending', 'suspended', 'revoked'].map((s) => opt(s, s, (p.status || 'pending') === s)).join('')}</select></label>
        <label class="field"><span>Embed mode</span><select name="embed_mode">${opt('direct', 'direct (provider iframe)', p.embed_mode !== 'proxied')}${opt('proxied', 'proxied via /embed', p.embed_mode === 'proxied')}</select></label>
        <label class="field wide"><span>Embed origins (one per line)</span><textarea name="embed_origins">${esc((p.embed_origins || []).join('\n'))}</textarea></label>
        <label class="field wide"><span>Image origins (one per line)</span><textarea name="asset_origins">${esc((p.asset_origins || []).join('\n'))}</textarea></label>
        <label class="field wide"><span>Terms URL</span><input name="terms_url" value="${esc(p.terms_url || '')}"></label>
        <label class="field wide"><span>Licence basis</span><textarea name="license_basis" maxlength="600">${esc(p.license_basis || '')}</textarea></label>
        <label class="field wide"><span>Notes</span><textarea name="notes" maxlength="1000">${esc(p.notes || '')}</textarea></label>
        <div class="wide" data-err></div>
        <div class="wide form-actions"><button class="btn primary">${p.id ? 'Save' : 'Create'}</button></div></form>`;
      const collect = (f) => ({
        name: f.get('name'), status: f.get('status'), embed_mode: f.get('embed_mode'),
        embed_origins: String(f.get('embed_origins') || '').split(/\s+/).filter(Boolean),
        asset_origins: String(f.get('asset_origins') || '').split(/\s+/).filter(Boolean),
        terms_url: f.get('terms_url') || null, license_basis: f.get('license_basis') || null, notes: f.get('notes') || null,
      });
      root.querySelector('[data-pnew]')?.addEventListener('click', () => {
        const d = sheet('New provider', form());
        d.querySelector('[data-pf]').addEventListener('submit', async (ev) => {
          ev.preventDefault();
          const f = new FormData(ev.target);
          try { await call('/api/admin/cms/providers', { method: 'POST', body: { id: f.get('id'), ...collect(f) } }); d.close(); lookups = null; h.rerender(); }
          catch (e) { d.querySelector('[data-err]').innerHTML = errorsHtml(e); }
        });
      });
      root.addEventListener('click', async (ev) => {
        const b = ev.target.closest('[data-pedit]');
        if (!b) return;
        const { providers: rows } = await call('/api/admin/cms/providers');
        const p = rows.find((x) => x.id === b.dataset.pedit);
        const d = sheet(`Provider · ${p.name}`, form(p));
        d.querySelector('[data-pf]').addEventListener('submit', async (ev2) => {
          ev2.preventDefault();
          try { await call(`/api/admin/cms/providers/${encodeURIComponent(p.id)}`, { method: 'PATCH', body: collect(new FormData(ev2.target)) }); d.close(); lookups = null; h.rerender(); }
          catch (e) { d.querySelector('[data-err]').innerHTML = errorsHtml(e); }
        });
      });
    },
  };

  // ===========================================================================
  // Staff
  // ===========================================================================
  const USTATE = { active: 'ok', suspended: 'bad', deactivated: '', deleted: '' };
  const staff = {
    title: 'Staff',
    sub: 'People who run the site',
    async render() {
      const r = await call('/api/admin/staff');
      const rows = r.accounts || [];
      return `<p class="hint">ZoFHub has no visitor accounts — these are staff. The owner configured in the environment is not listed and cannot be changed here.</p>
        ${can('users.manage') && r.assignableRoles.length ? '<div class="toolbar"><button class="btn primary" data-unew>New staff account</button></div>' : ''}
        ${card('', table([{ t: 'Account' }, { t: 'Role' }, { t: 'Status' }, { t: 'Last sign-in' }, { t: 'Sessions', n: true }, { t: '' }],
          rows.map((u) => [
            `<b>${esc(u.username)}</b>${u.display_name ? `<br><span class="hint">${esc(u.display_name)}</span>` : ''}${u.must_change_password && u.status === 'active' ? ' ' + pill('temporary password', 'warn') : ''}`,
            esc((r.roles.find((x) => x.id === u.role) || {}).label || u.role),
            `${pill(u.status, USTATE[u.status] || '')}${u.status_reason ? `<br><span class="hint">${esc(u.status_reason)}</span>` : ''}`,
            esc(ago(u.last_login_at)),
            fmt(u.liveSessions),
            u.manageable ? `<div class="btn-row">
              ${can('users.roles') ? `<button class="btn sm" data-u="role" data-id="${esc(u.id)}">Role</button>` : ''}
              ${u.status === 'active' ? `<button class="btn sm" data-u="suspend" data-id="${esc(u.id)}">Suspend</button>` : `<button class="btn sm" data-u="restore" data-id="${esc(u.id)}">Restore</button>`}
              <button class="btn sm" data-u="reset" data-id="${esc(u.id)}">Reset password</button>
              <button class="btn sm" data-u="revoke" data-id="${esc(u.id)}">Sign out everywhere</button>
              <button class="btn sm ghost" data-u="history" data-id="${esc(u.id)}">History</button>
              ${can('users.delete') ? `<button class="btn sm danger" data-u="delete" data-id="${esc(u.id)}" data-name="${esc(u.username)}">Delete</button>` : ''}</div>` : '',
          ])))}
        ${card('Roles', kv(r.roles.map((x) => [x.label, esc(x.describe)])))}`;
    },
    wire() {
      const root = vroot();
      const once = (title, pw) => sheet(title, `<p style="margin-top:0">Give this to the person over a private channel. It is shown <b>once</b>, is not stored anywhere readable, and must be changed at first sign-in.</p><div class="secret">${esc(pw)}</div>`, { size: 'sm' });
      root.querySelector('[data-unew]')?.addEventListener('click', async () => {
        const r = await call('/api/admin/staff');
        const d = sheet('New staff account', `<form data-nf class="form-grid">
          <label class="field"><span>Username</span><input name="username" required pattern="[a-z0-9][a-z0-9._-]{2,39}" autocomplete="off"></label>
          <label class="field"><span>Display name</span><input name="display_name" maxlength="80"></label>
          <label class="field wide"><span>Role</span><select name="role">${r.assignableRoles.map((x) => opt(x, (r.roles.find((y) => y.id === x) || {}).label || x)).join('')}</select></label>
          <div class="wide" data-err></div>
          <div class="wide form-actions"><button class="btn primary">Create</button></div></form>`, { size: 'sm' });
        d.querySelector('[data-nf]').addEventListener('submit', async (ev) => {
          ev.preventDefault();
          const f = new FormData(ev.target);
          try {
            const out = await call('/api/admin/staff', { method: 'POST', body: { username: f.get('username'), display_name: f.get('display_name') || null, role: f.get('role') } });
            d.close(); h.rerender(); once(`Temporary password for ${out.account.username}`, out.temporaryPassword);
          } catch (e) { d.querySelector('[data-err]').innerHTML = errorsHtml(e); }
        });
      });
      root.addEventListener('click', async (ev) => {
        const b = ev.target.closest('[data-u]');
        if (!b) return;
        const id = b.dataset.id;
        try {
          switch (b.dataset.u) {
            case 'role': {
              const r = await call('/api/admin/staff');
              const u = r.accounts.find((x) => x.id === id);
              const d = sheet(`Role · ${u.username}`, `<form data-rf><label class="field"><span>Role</span><select name="role">${r.assignableRoles.map((x) => opt(x, (r.roles.find((y) => y.id === x) || {}).label || x, x === u.role)).join('')}</select></label>
                <p class="hint">Changing a role signs the person out everywhere and needs your password.</p><div data-err></div>
                <div class="form-actions"><button class="btn primary">Change role</button></div></form>`, { size: 'sm' });
              d.querySelector('[data-rf]').addEventListener('submit', async (e2) => {
                e2.preventDefault();
                try { await call(`/api/admin/staff/${encodeURIComponent(id)}/role`, { method: 'POST', body: { role: new FormData(e2.target).get('role') } }); d.close(); h.rerender(); }
                catch (e) { d.querySelector('[data-err]').innerHTML = errorsHtml(e); }
              });
              break;
            }
            case 'suspend': {
              const reason = window.prompt('Reason for suspending (kept in the audit trail):');
              if (reason === null) return;
              await call(`/api/admin/staff/${encodeURIComponent(id)}/status`, { method: 'POST', body: { action: 'suspend', reason } });
              flash('Suspended and signed out.'); h.rerender(); break;
            }
            case 'restore':
              await call(`/api/admin/staff/${encodeURIComponent(id)}/status`, { method: 'POST', body: { action: 'restore' } });
              flash('Restored.'); h.rerender(); break;
            case 'reset': {
              if (!window.confirm('Issue a new temporary password and sign this person out?')) return;
              const out = await call(`/api/admin/staff/${encodeURIComponent(id)}/password-reset`, { method: 'POST' });
              once('New temporary password', out.temporaryPassword); h.rerender(); break;
            }
            case 'revoke': {
              const out = await call(`/api/admin/staff/${encodeURIComponent(id)}/revoke-sessions`, { method: 'POST' });
              flash(`${fmt(out.revoked)} session(s) ended.`); h.rerender(); break;
            }
            case 'history': {
              const out = await call(`/api/admin/staff/${encodeURIComponent(id)}`);
              sheet(`History · ${out.account.username}`, historyList(out.history));
              break;
            }
            case 'delete': {
              const typed = window.prompt(`Type the username (${b.dataset.name}) to delete this account. Its audit history is kept.`);
              if (typed === null) return;
              await call(`/api/admin/staff/${encodeURIComponent(id)}`, { method: 'DELETE', body: { confirm: typed } });
              flash('Account deleted (anonymised).'); h.rerender(); break;
            }
            default: break;
          }
        } catch (e) { say(e.message); }
      });
    },
  };

  // ===========================================================================
  // Settings
  // ===========================================================================
  const settings = {
    title: 'Settings',
    sub: 'Typed, allowlisted configuration',
    async render() {
      const [s, ads] = await Promise.all([call('/api/admin/settings'), h.maybe('/api/admin/ads')]);
      const nets = (ads?.providers || ads?.networks || []).map((n) => ({ id: n.id, name: n.name || n.id, active: n.active ?? n.enabled }));
      const row = (x) => {
        const dis = x.editable ? '' : ' disabled';
        let input;
        if (typeof x.default === 'boolean') {
          input = `<select class="ctl" data-k="${esc(x.key)}" data-type="bool"${dis}>${opt('true', 'On', x.value === true)}${opt('false', 'Off', x.value === false)}</select>`;
        } else if (x.key === 'site.announcement') {
          input = `<div class="form-grid" data-k="${esc(x.key)}" data-type="announcement">
            <label class="field"><span>Show</span><select name="active"${dis}>${opt('true', 'Yes', x.value.active)}${opt('false', 'No', !x.value.active)}</select></label>
            <label class="field"><span>Tone</span><select name="level"${dis}>${opt('info', 'Info', x.value.level === 'info')}${opt('warning', 'Warning', x.value.level === 'warning')}</select></label>
            <label class="field wide"><span>Text (plain, 280 max)</span><input name="text" maxlength="280" value="${esc(x.value.text)}"${dis}></label></div>`;
        } else if (x.key === 'site.maintenance') {
          input = `<div class="form-grid" data-k="${esc(x.key)}" data-type="maintenance">
            <label class="field"><span>Maintenance mode</span><select name="enabled"${dis}>${opt('false', 'Off', !x.value.enabled)}${opt('true', 'On — public pages answer 503', x.value.enabled)}</select></label>
            <label class="field wide"><span>Message (plain, 200 max)</span><input name="message" maxlength="200" value="${esc(x.value.message)}"${dis}></label></div>`;
        } else if (x.key === 'ads.disabled_networks') {
          input = `<div class="flags" data-k="${esc(x.key)}" data-type="networks">${(nets.length ? nets : x.value.map((id) => ({ id, name: id }))).map((n) =>
            `<label class="field inline"><input type="checkbox" value="${esc(n.id)}"${x.value.includes(n.id) ? ' checked' : ''}${dis}><span>${esc(n.name)} off</span></label>`).join('') || '<span class="hint">No networks configured.</span>'}</div>`;
        } else input = `<code>${esc(JSON.stringify(x.value))}</code>`;
        return card(esc(x.key), `<p class="hint">${esc(x.describe)}${x.reauth ? ' Needs your password.' : ''}${x.public ? ' Visible to visitors.' : ''}</p>${input}
          ${x.editable ? `<div class="form-actions"><button class="btn sm primary" data-save="${esc(x.key)}">Save</button></div>` : `<p class="hint">Needs ${esc(x.perm)}.</p>`}`);
      };
      return `${s.status?.problems?.length ? `<p class="msg error">${esc(s.status.problems.join(' · '))}</p>` : ''}
        <p class="hint">Only the keys below exist. Secrets and deployment wiring stay in the host's environment and cannot be read or changed from here, and nothing saved here is ever run as code.</p>
        <div class="grid g-2">${s.settings.map(row).join('')}</div>`;
    },
    wire() {
      const root = vroot();
      root.addEventListener('click', async (ev) => {
        const b = ev.target.closest('[data-save]');
        if (!b) return;
        const key = b.dataset.save;
        const el = root.querySelector(`[data-k="${CSS.escape(key)}"]`);
        let value;
        const t = el.dataset.type;
        if (t === 'bool') value = el.value === 'true';
        else if (t === 'announcement') value = { active: el.querySelector('[name=active]').value === 'true', level: el.querySelector('[name=level]').value, text: el.querySelector('[name=text]').value };
        else if (t === 'maintenance') value = { enabled: el.querySelector('[name=enabled]').value === 'true', message: el.querySelector('[name=message]').value };
        else if (t === 'networks') value = [...el.querySelectorAll('input:checked')].map((x) => x.value);
        try { await call(`/api/admin/settings/${encodeURIComponent(key)}`, { method: 'PUT', body: { value } }); flash(`${key} saved.`); }
        catch (e) { say(e.message); }
      });
    },
  };

  // ===========================================================================
  // Proxy control
  // ===========================================================================
  const TSTATE = { approved: 'ok', pending: 'warn', revoked: 'bad' };
  const proxyctl = {
    title: 'Proxy control',
    sub: 'Engines, approved destinations, limits and live sessions',
    async render() {
      const [o, t, s] = await Promise.all([
        call('/api/admin/proxy/control'), call('/api/admin/proxy/targets'), call('/api/admin/proxy/sessions'),
      ]);
      const p = o.policy;
      const approved = t.targets.filter((x) => x.status === 'approved').length;
      const dec = o.decisions?.decisions || {};
      const strip = `<div class="grid g-stats">
        ${stat('Access', esc(p.accessMode), p.accessMode === 'public' ? 'anyone, approved destinations only' : p.accessMode === 'staff' ? 'signed-in staff only' : 'no tunnels', { state: p.accessMode === 'disabled' ? 'warn' : 'ok' })}
        ${stat('Approved destinations', fmt(approved), `${fmt(t.targets.length)} listed`, { state: approved ? 'ok' : 'warn' })}
        ${stat('Live sessions', fmt(s.stats.live), `${fmt(s.stats.opened)} opened since restart`)}
        ${stat('Refused streams', fmt(Object.entries(dec).filter(([k]) => k !== 'approved_target').reduce((a, [, v]) => a + v, 0)), 'not an approved destination')}
      </div>`;
      const canT = can('proxy.targets');
      const targets = card('Approved destinations', `
        ${canT ? `<form data-tnew class="form-grid">
          <label class="field"><span>Host or *.domain</span><input name="pattern" required placeholder="example.org or *.example.org"></label>
          <label class="field"><span>Ports</span><input name="ports" value="443" placeholder="443, 80"></label>
          <label class="field wide"><span>Purpose (why the platform is authorised to reach it)</span><input name="purpose" required minlength="3" maxlength="300"></label>
          <label class="field"><span>Owner</span><input name="owner" maxlength="80"></label>
          <label class="field"><span>Expires</span><input name="expires_at" type="date"></label>
          <div class="wide form-actions"><button class="btn">Propose destination</button><span class="hint">A proposal is not live until approved, which needs your password.</span></div></form>` : ''}
        ${table([{ t: 'Destination' }, { t: 'Ports' }, { t: 'Status' }, { t: 'Purpose' }, { t: 'Expires' }, { t: '' }],
          t.targets.map((x) => [
            `<span class="mono">${esc(x.pattern)}</span>${x.readOnly ? ' ' + pill('env') : ''}`,
            esc((x.ports || []).join(', ')),
            `${pill(x.status, TSTATE[x.status] || '')}${x.approved_by ? `<br><span class="hint">by ${esc(x.approved_by)}</span>` : ''}`,
            esc(x.purpose || ''),
            x.expires_at ? esc(when(x.expires_at)) : '—',
            canT && !x.readOnly ? `<div class="btn-row">
              ${x.status !== 'approved' ? `<button class="btn sm primary" data-tact="approve" data-id="${esc(x.id)}">Approve</button>` : ''}
              ${x.status !== 'revoked' ? `<button class="btn sm" data-tact="revoke" data-id="${esc(x.id)}">Revoke</button>` : ''}
              ${x.status !== 'approved' ? `<button class="btn sm danger" data-tact="delete" data-id="${esc(x.id)}">Delete</button>` : ''}</div>` : '',
          ]))}`, { hint: 'The tunnel connects ONLY to hosts on this list, on the listed ports. Wildcards cover subdomains of the named site; public suffixes (*.com) and wildcard-DNS services cannot be approved.' });

      const unl = o.decisions?.unlisted || [];
      const requested = card('Requested, not approved', unl.length
        ? `${table([{ t: 'Host' }, { t: 'Attempts', n: true }, { t: 'Last' }, { t: '' }], unl.slice(0, 25).map((u) => [
          `<span class="mono">${esc(u.host)}</span>`, fmt(u.count), esc(ago(u.lastSeen)),
          canT ? `<button class="btn sm" data-propose="${esc(u.host)}">Propose</button>` : '']))}
          ${canT ? '<div class="form-actions"><button class="btn sm ghost" data-clear-unl>Forget this list</button></div>' : ''}`
        : '<p class="empty">No refused hostnames recorded.</p>', { hint: 'Hostnames and counts only, in memory, never who asked. Cleared on restart.' });

      const eng = card('Engines', table([{ t: 'Engine' }, { t: 'Installed' }, { t: 'Offered' }, { t: '' }], (o.engines || []).map((e) => [
        esc(e.name), o.installed?.[e.id] ? pill('yes', 'ok') : pill('no'),
        e.enabled ? pill('on', 'ok') : pill('off', 'bad'),
        can('proxy.manage') ? `<button class="btn sm" data-eng="${esc(e.id)}" data-on="${e.enabled ? '0' : '1'}">${e.enabled ? 'Turn off' : 'Turn on'}</button>` : '',
      ])));

      const canP = can('proxy.policy');
      const lim = (k, label, [lo, hi]) => `<label class="field"><span>${esc(label)}</span><input type="number" name="${k}" min="${lo}" max="${hi}" value="${esc(p[k])}"${canP ? '' : ' disabled'}></label>`;
      const policy = card('Access and limits', `<form data-pol class="form-grid">
        <label class="field"><span>Access mode</span><select name="accessMode"${can('proxy.manage') ? '' : ' disabled'}>${[['public', 'Public'], ['staff', 'Staff only'], ['disabled', 'Off']].map(([v, l]) => opt(v, l, p.accessMode === v)).join('')}</select></label>
        ${lim('maxTunnels', 'Max tunnels', [1, 2000])}${lim('maxPerClient', 'Per client', [1, 256])}${lim('streamsPerTunnel', 'Streams / tunnel', [1, 1024])}
        ${lim('idleMinutes', 'Idle minutes', [1, 120])}${lim('maxSessionMinutes', 'Max session minutes', [5, 1440])}
        <label class="field"><span>Ports</span><input name="allowedPorts" value="${esc(p.allowedPorts.join(', '))}"${canP ? '' : ' disabled'}></label>
        <div class="wide form-actions">${canP ? '<button class="btn primary">Save policy</button><span class="hint">Raising a limit or opening access needs your password; lowering never does.</span>' : ''}</div></form>`);

      const live = card('Live sessions', `${table([{ t: 'Session' }, { t: 'Client' }, { t: 'Age' }, { t: 'Idle' }, { t: 'Streams', n: true }, { t: 'Refused', n: true }, { t: '' }],
        s.live.map((x) => [`<span class="mono">${esc(x.id)}</span>${x.staff ? ' ' + pill('staff', 'info') : ''}`, `<span class="mono">${esc(x.clientTag || '—')}</span>`,
          `${fmt(Math.round(x.ageSec / 60))}m`, `${fmt(x.idleSec)}s`, `${fmt(x.activeStreams)} / ${fmt(x.streams)}`, fmt(x.denied),
          can('proxy.sessions') ? `<button class="btn sm danger" data-kill="${esc(x.id)}">End</button>` : '']))}
        ${s.recent.length ? `<p class="hint">Recently ended: ${s.recent.slice(0, 8).map((r) => `${esc(r.id)} (${esc(r.reason)})`).join(' · ')}</p>` : ''}`,
        { hint: 'Counts and timestamps only. Destinations are never recorded per session, and nothing here is written to the database.' });

      const reasons = Object.entries(dec).sort((a, b) => b[1] - a[1]).map(([k, v]) => [k.replace(/_/g, ' '), fmt(v)]);
      return `${strip}
        <div class="grid g-wide">${targets}<div class="grid">${policy}${eng}</div></div>
        <div class="grid g-2">${live}<div class="grid">${requested}${card('Decisions since restart', reasons.length ? kv(reasons) : '<p class="empty">No connections yet.</p>')}</div></div>
        ${o.status?.problems?.length ? `<p class="msg error">${esc(o.status.problems.join(' · '))}</p>` : ''}`;
    },
    wire() {
      const root = vroot();
      const ports = (v) => String(v || '').split(/[\s,]+/).filter(Boolean).map(Number);
      root.querySelector('[data-tnew]')?.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        const f = new FormData(ev.target);
        const exp = f.get('expires_at');
        try {
          await call('/api/admin/proxy/targets', { method: 'POST', body: { pattern: f.get('pattern'), ports: ports(f.get('ports')), purpose: f.get('purpose'), owner: f.get('owner') || null, ...(exp ? { expires_at: new Date(`${exp}T23:59:59Z`).toISOString() } : {}) } });
          flash('Destination proposed. Approve it to make it live.'); h.rerender();
        } catch (e) { say(e.data?.errors?.join('; ') || e.message); }
      });
      root.querySelector('[data-pol]')?.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        const f = new FormData(ev.target);
        const policy = { allowedPorts: ports(f.get('allowedPorts')) };
        for (const k of ['maxTunnels', 'maxPerClient', 'streamsPerTunnel', 'idleMinutes', 'maxSessionMinutes']) if (f.get(k) !== null) policy[k] = parseInt(f.get(k), 10);
        if (f.get('accessMode')) policy.accessMode = f.get('accessMode');
        try { await call('/api/admin/proxy/policy', { method: 'PUT', body: { policy } }); flash('Policy saved and applied.'); h.rerender(); }
        catch (e) { say(e.data?.errors?.join('; ') || e.message); }
      });
      root.addEventListener('click', async (ev) => {
        const b = ev.target.closest('button');
        if (!b) return;
        try {
          if (b.dataset.tact) {
            if (b.dataset.tact === 'delete') { if (!window.confirm('Delete this destination?')) return; await call(`/api/admin/proxy/targets/${b.dataset.id}`, { method: 'DELETE' }); }
            else await call(`/api/admin/proxy/targets/${b.dataset.id}/${b.dataset.tact}`, { method: 'POST' });
            h.rerender();
          } else if (b.dataset.eng) {
            await call(`/api/admin/proxy/engines/${encodeURIComponent(b.dataset.eng)}`, { method: 'PUT', body: { enabled: b.dataset.on === '1' } }); h.rerender();
          } else if (b.dataset.kill) {
            await call(`/api/admin/proxy/sessions/${encodeURIComponent(b.dataset.kill)}/terminate`, { method: 'POST' }); h.rerender();
          } else if (b.dataset.propose) {
            const f = root.querySelector('[data-tnew]');
            if (f) { f.querySelector('[name=pattern]').value = b.dataset.propose; f.querySelector('[name=purpose]').focus(); }
          } else if (b.dataset.clearUnl !== undefined) {
            await call('/api/admin/proxy/unlisted/clear', { method: 'POST' }); h.rerender();
          }
        } catch (e) { say(e.message); }
      });
    },
  };

  // ===========================================================================
  // Audit
  // ===========================================================================
  const audit = {
    state: { f: { action: '', outcome: '', username: '', q: '' }, rows: [], cursor: null },
    title: 'Audit',
    sub: 'Every administrative action, append-only',
    async render() {
      const s = audit.state;
      const page = await audit.fetch(null);
      s.rows = page.rows; s.cursor = page.nextCursor;
      return `<div class="toolbar">
          <label class="field"><span>Action prefix</span><input class="ctl" data-af="action" placeholder="game. / user. / proxy." value="${esc(s.f.action)}"></label>
          <label class="field"><span>Outcome</span><select class="ctl" data-af="outcome">${opt('', 'Any')}${['success', 'failure', 'denied'].map((o) => opt(o, o, s.f.outcome === o)).join('')}</select></label>
          <label class="field"><span>User</span><input class="ctl" data-af="username" value="${esc(s.f.username)}"></label>
          <label class="field grow"><span>Target contains</span><input class="ctl" data-af="q" value="${esc(s.f.q)}"></label>
          <span class="spacer"></span>
          <button class="btn" data-verify>Verify integrity</button>
          ${can('audit.export') ? '<button class="btn" data-exp="csv">Export CSV</button><button class="btn" data-exp="json">Export JSON</button>' : ''}
        </div>
        <div data-vres></div>
        ${card('', `<div data-at>${audit.table()}</div><div class="form-actions" data-amore ${s.cursor ? '' : 'hidden'}><button class="btn" data-more>Load more</button></div>`)}`;
    },
    async fetch(cursor) {
      const q = new URLSearchParams({ limit: '100' });
      for (const [k, v] of Object.entries(audit.state.f)) if (v) q.set(k, v);
      if (cursor) q.set('cursor', cursor);
      return call(`/api/admin/audit?${q}`);
    },
    table() {
      return table([{ t: 'When' }, { t: 'Who' }, { t: 'Action' }, { t: 'Target' }, { t: 'Outcome' }, { t: 'Detail' }],
        audit.state.rows.map((r) => [
          `<span title="${esc(r.at)}">${esc(when(r.at))}</span>`, esc(r.username || '—'), `<span class="mono">${esc(r.action)}</span>`,
          `<span class="mono trunc">${esc(r.target || '')}</span>`,
          pill(r.outcome, r.outcome === 'success' ? 'ok' : r.outcome === 'denied' ? 'bad' : 'warn'),
          r.detail ? `<span class="mono trunc" title="${esc(JSON.stringify(r.detail))}">${esc(JSON.stringify(r.detail).slice(0, 80))}</span>` : '',
        ]));
    },
    wire() {
      const root = vroot();
      const s = audit.state;
      const reload = async () => { const p = await audit.fetch(null); s.rows = p.rows; s.cursor = p.nextCursor; root.querySelector('[data-at]').innerHTML = audit.table(); root.querySelector('[data-amore]').hidden = !s.cursor; };
      root.querySelectorAll('[data-af]').forEach((el) => {
        const upd = () => { s.f[el.dataset.af] = el.value.trim(); reload().catch((e) => say(e.message)); };
        el.addEventListener(el.tagName === 'INPUT' ? 'input' : 'change', el.tagName === 'INPUT' ? debounce(upd, 350) : upd);
      });
      root.querySelector('[data-more]')?.addEventListener('click', async () => {
        const p = await audit.fetch(s.cursor); s.rows.push(...p.rows); s.cursor = p.nextCursor;
        root.querySelector('[data-at]').innerHTML = audit.table(); root.querySelector('[data-amore]').hidden = !s.cursor;
      });
      root.querySelector('[data-verify]')?.addEventListener('click', async () => {
        try {
          const v = await call('/api/admin/audit/verify');
          root.querySelector('[data-vres]').innerHTML = v.firstBadId
            ? `<p class="msg error">Integrity check FAILED at record #${esc(v.firstBadId)} (checked ${fmt(v.checked)}). A record was altered or inserted outside the application.</p>`
            : `<p class="msg ok">${fmt(v.checked)} chained record(s) verified — no alteration detected.${v.note ? ' ' + esc(v.note) : ''}</p>`;
        } catch (e) { say(e.message); }
      });
      root.querySelectorAll('[data-exp]').forEach((b) => b.addEventListener('click', async () => {
        const q = new URLSearchParams({ format: b.dataset.exp });
        for (const [k, v] of Object.entries(s.f)) if (v) q.set(k, v);
        const r = await fetch(`/api/admin/audit/export?${q}`, { credentials: 'same-origin' });
        if (!r.ok) { const j = await r.json().catch(() => ({})); say(j.error || `HTTP ${r.status}`); return; }
        download(`zofhub-audit.${b.dataset.exp}`, await r.text(), b.dataset.exp === 'csv' ? 'text/csv' : 'application/json');
      }));
    },
  };

  // ===========================================================================
  // My account
  // ===========================================================================
  const account = {
    title: 'My account',
    sub: 'Password and sessions',
    async render() {
      const m = me();
      const mustChange = !!m.mustChangePassword;
      const staffAcct = !!m.userId;
      return `${mustChange ? '<p class="msg error">You are signed in with a temporary password. Choose your own before doing anything else.</p>' : ''}
        <div class="grid g-2">
          ${card('Signed in as', kv([
            ['Username', esc(m.username || '—')], ['Role', esc(m.roleLabel || m.role || '—')],
            ['Via', esc(m.via === 'bearer' ? 'service token' : 'session')],
            ['Session expires', esc(when(m.session?.expiresAt))],
            ['Password confirmed recently', m.reauthFresh ? pill('yes', 'ok') : pill('no')],
          ]))}
          ${staffAcct ? card('Change password', `<form data-pw class="form-grid">
            <label class="field wide"><span>Current password</span><input type="password" name="current" autocomplete="current-password" required></label>
            <label class="field wide"><span>New password (12+ characters)</span><input type="password" name="next" autocomplete="new-password" minlength="12" required></label>
            <label class="field wide"><span>Repeat new password</span><input type="password" name="again" autocomplete="new-password" minlength="12" required></label>
            <div class="wide" data-err></div>
            <div class="wide form-actions"><button class="btn primary">Change password</button></div></form>`)
            : card('Password', '<p class="hint">The owner account\'s password is set in the environment (<span class="mono">npm run admin-hash</span>), not here.</p>')}
        </div>`;
    },
    wire() {
      const f = vroot().querySelector('[data-pw]');
      f?.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        const d = new FormData(f);
        const err = f.querySelector('[data-err]');
        if (d.get('next') !== d.get('again')) { err.innerHTML = errorsHtml({ message: 'The new passwords do not match.' }); return; }
        try {
          await call('/api/admin/auth/password', { method: 'POST', body: { current: d.get('current'), next: d.get('next') } });
          flash('Password changed.');
          await h.reloadMe(); h.rerender();
        } catch (e) { err.innerHTML = errorsHtml(e); }
      });
    },
  };

  const views = { content, review, taxonomy, providers, staff, settings, proxyctl, audit, account };
  // Each render lands in a FRESH container, and every listener a view adds is
  // bound to that container. Binding to the long-lived #views element instead
  // would stack one more listener per render, so a click would fire N times.
  for (const v of Object.values(views)) {
    const inner = v.render;
    v.render = async () => `<div data-vr>${await inner()}</div>`;
  }
  return views;
}
