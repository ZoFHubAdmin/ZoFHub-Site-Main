// public/admin/assets/admin.js
// ---------------------------------------------------------------------------
// The dashboard. Holds no credential and makes no security decision.
//
// Reaching this file at all means the server already validated a session cookie
// and chose to serve the document — an unauthenticated request to /admin is
// redirected and never receives this page. Everything below assumes it may be
// wrong about that at any moment: every response is checked for 401, and a 401
// sends the user back to the login page rather than leaving a dead UI on screen.
//
// The CSRF token comes from a readable cookie and is echoed in a header on every
// state-changing request. That is the double-submit pattern: an attacker on
// another origin can cause the browser to SEND the session cookie but cannot
// READ the CSRF cookie to copy it into the header.
// ---------------------------------------------------------------------------

const $ = (s) => document.querySelector(s);
const banner = $('#banner');

function say(text, kind = 'error') {
  banner.textContent = text;
  banner.className = 'msg ' + kind;
  banner.hidden = false;
}
const clear = () => { banner.hidden = true; };

// Escape everything that reaches the DOM as markup. Most values here are
// operational strings, but a game title or player name is user-supplied.
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function csrfToken() {
  // Null-prototype-safe read: a cookie literally named `constructor` must not
  // read back as a function.
  const jar = Object.create(null);
  for (const part of (document.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) jar[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return jar['zh_admin_csrf'] || '';
}

async function api(path, { method = 'GET', body } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (method !== 'GET') headers['x-csrf-token'] = csrfToken();
  const r = await fetch(path, {
    method, headers, credentials: 'same-origin',
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (r.status === 401) { window.location.replace('/admin/login'); throw new Error('unauthorized'); }
  let data = {};
  try { data = await r.json(); } catch { /* leave {} */ }
  if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
  return data;
}

const fmt = (n) => (n === null || n === undefined ? '—' : Number(n).toLocaleString());
const when = (t) => (t ? new Date(t).toLocaleString() : '—');

function table(rows, cols, empty = 'Nothing to show.') {
  if (!rows.length) return `<p class="hint">${esc(empty)}</p>`;
  const head = cols.map((c) => `<th>${esc(c.label)}</th>`).join('');
  const body = rows.map((r) => '<tr>' + cols.map((c) => `<td>${c.cell(r)}</td>`).join('') + '</tr>').join('');
  return `<table class="tbl"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

// ── Tabs ───────────────────────────────────────────────────────────────────
// The visible state was a CSS class only. Sighted users could see which tab was
// active; anyone on a screen reader heard five tabs and no indication of which
// one they were in, because aria-selected never moved off its initial value.
const loaders = {};
const tabs = [...document.querySelectorAll('.tab')];

function activate(tab, { focus = false } = {}) {
  for (const t of tabs) {
    const on = t === tab;
    t.classList.toggle('is-active', on);
    t.setAttribute('aria-selected', String(on));
    // Roving tabindex: one stop for the whole tablist, then arrow keys inside
    // it. Otherwise Tab has to walk past every tab to reach the panel.
    t.tabIndex = on ? 0 : -1;
  }
  const name = tab.dataset.panel;
  document.querySelectorAll('.panel').forEach((p) => p.classList.toggle('is-active', p.dataset.panel === name));
  if (focus) tab.focus();
  clear();
  loaders[name]?.();
}

tabs.forEach((tab, i) => {
  tab.tabIndex = tab.classList.contains('is-active') ? 0 : -1;
  tab.addEventListener('click', () => activate(tab));
  tab.addEventListener('keydown', (e) => {
    const step = { ArrowRight: 1, ArrowLeft: -1, Home: -i, End: tabs.length - 1 - i }[e.key];
    if (step === undefined) return;
    e.preventDefault();
    activate(tabs[(i + step + tabs.length) % tabs.length], { focus: true });
  });
});

// ── Overview ───────────────────────────────────────────────────────────────
loaders.overview = async () => {
  try {
    const d = await api('/api/admin/dashboard');
    const db = d.database || {};
    const stats = [
      ['Games served',      fmt(d.catalog?.served)],
      ['Catalogued',        fmt(db.games)],
      ['Working',           fmt(db.working)],
      ['Broken',            fmt(db.broken)],
      ['Community posts',   fmt(db.recommendations)],
      ['Hidden posts',      fmt(db.hiddenRecommendations)],
    ];
    $('#statGrid').innerHTML = stats.map(([k, v]) =>
      `<div class="stat"><span class="stat-v">${esc(v)}</span><span class="stat-k">${esc(k)}</span></div>`).join('');

    const up = d.server?.uptimeSec || 0;
    const sys = [
      ['Environment',   d.server?.env],
      ['Node',          d.server?.node],
      ['Uptime',        `${Math.floor(up / 3600)}h ${Math.floor((up % 3600) / 60)}m`],
      ['Memory (RSS)',  `${d.server?.memoryMB} MB`],
      ['Catalog source', d.catalog?.source],
      ['Categories',    fmt(d.catalog?.categories)],
      ['Cron jobs',     d.server?.cronDisabled ? 'disabled' : 'running'],
      ['Supabase',      d.supabase?.connected ? `connected (${fmt(d.supabase.games)} games)` : 'not connected'],
      ['Database writes', d.supabase?.writable ? 'enabled' : 'READ ONLY — no admin key'],
      ['AI',            `${d.ai?.mode} · server inference ${d.ai?.serverInference ? 'ON' : 'off'}`],
      ['Proxy engines', Object.entries(d.proxy || {}).filter(([, v]) => v).map(([k]) => k).join(', ') || 'none'],
    ];
    $('#sysGrid').innerHTML = sys.map(([k, v]) =>
      `<div class="kv"><span class="kv-k">${esc(k)}</span><span class="kv-v">${esc(v)}</span></div>`).join('');
  } catch (e) { say(e.message); }
};

// ── Games ──────────────────────────────────────────────────────────────────
// Catalog health. Deliberately read-only: hiding a game is done by
// `npm run quality -- --write`, which lands the change in a reviewable diff
// instead of mutating the live site from a dashboard button nobody can audit.
async function loadQuality() {
  try {
    const d = await api('/api/admin/catalog/quality');
    const sev = d.bySeverity || {};
    const tone = d.score >= 99 ? 'ok' : d.score >= 95 ? 'warn' : 'bad';
    const rows = Object.entries(d.byKind || {}).sort((a, b) => b[1] - a[1]);

    $('#qualityOut').innerHTML = `
      <div class="quality-head">
        <div class="quality-score">
          <span class="pill ${tone}">${esc(d.score)}% structurally sound</span>
          <span class="hint-inline">${fmt(d.healthy)} of ${fmt(d.total)} served games have no issues</span>
        </div>
        <span class="hint-inline">source: ${esc(d.source || '—')}</span>
      </div>` +
      (rows.length ? `<div class="quality-list">` + rows.map(([kind, n]) => {
        // Cosmetic issues are called out as harmless on the row itself. Without
        // that, "3,000 games have no thumbnail" reads as an outage.
        const cosmetic = kind === 'no-thumbnail' || kind === 'no-category';
        return `<div class="fact${cosmetic ? '' : ' is-hot'}">
          <span class="fact-k">${esc((d.labels || {})[kind] || kind)}${cosmetic ? ' <em>— cosmetic, stays visible</em>' : ''}</span>
          <span class="fact-v">${fmt(n)}</span></div>`;
      }).join('') + `</div>` : '')
      + (d.removable?.length
        ? `<p class="hint">${fmt(d.removable.length)} entr${d.removable.length === 1 ? 'y is' : 'ies are'} unusable or redundant.
           Hide them with <code>${esc(d.applyWith)}</code> — it writes reviewable rules to
           <code>data/catalog-overrides.json</code>.</p>`
        : `<p class="hint">Nothing is unusable or redundant. Cosmetic gaps above do not hide a game.</p>`);
  } catch (e) {
    // A failed audit must not take the games table down with it.
    $('#qualityOut').innerHTML = `<p class="hint">Catalog health unavailable: ${esc(e.message)}</p>`;
  }
}

async function loadGames() {
  const q = $('#gameSearch').value.trim();
  try {
    const d = await api('/api/admin/games?limit=40&q=' + encodeURIComponent(q));
    $('#gamesOut').innerHTML =
      `<p class="hint">${fmt(d.total)} match${d.total === 1 ? '' : 'es'}${d.total > d.games.length ? ` · showing ${d.games.length}` : ''}</p>` +
      table(d.games, [
        { label: 'Title',    cell: (g) => esc(g.title) },
        { label: 'Slug',     cell: (g) => `<code>${esc(g.slug)}</code>` },
        { label: 'Category', cell: (g) => esc(g.category) },
        { label: 'Provider', cell: (g) => esc(g.provider) },
        { label: 'State',    cell: (g) => g.is_working
            ? '<span class="pill ok">visible</span>' : '<span class="pill bad">hidden</span>' },
        { label: '',         cell: (g) => `<button class="btn-sm" data-vis="${esc(g.slug)}" data-to="${g.is_working ? 'hide' : 'show'}">${g.is_working ? 'Hide' : 'Show'}</button>` },
      ], q ? 'No games match that search.' : 'No games loaded.');
  } catch (e) { say(e.message); }
}
loaders.games = () => { loadQuality(); loadGames(); };
$('#gameSearch').addEventListener('input', () => {
  clearTimeout(window.__gt); window.__gt = setTimeout(loadGames, 250);
});
$('#refreshCatalog').addEventListener('click', async () => {
  clear();
  try {
    const d = await api('/api/admin/catalog/refresh', { method: 'POST' });
    say(`Catalog refreshed — ${fmt(d.games)} games from ${esc(d.source)}.`, 'ok');
    loadGames();
  } catch (e) { say(e.message); }
});
$('#gamesOut').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-vis]');
  if (!b) return;
  clear();
  b.disabled = true;
  try {
    await api(`/api/admin/games/${encodeURIComponent(b.dataset.vis)}/visibility`,
      { method: 'POST', body: { visible: b.dataset.to === 'show' } });
    loadGames();
  } catch (err) { say(err.message); b.disabled = false; }
});

// ── Community ──────────────────────────────────────────────────────────────
loaders.community = async () => {
  try {
    const d = await api('/api/admin/recommendations');
    const rows = d.recommendations || d.items || [];
    $('#communityOut').innerHTML = table(rows, [
      { label: 'Title',  cell: (r) => esc(r.title) },
      { label: 'Author', cell: (r) => esc(r.author) },
      { label: 'In catalog', cell: (r) => r.inCatalog
          ? `<span class="pill warn">duplicate of ${esc(r.matchedSlug)}</span>` : '<span class="pill">new</span>' },
      { label: 'State',  cell: (r) => r.is_visible === false
          ? '<span class="pill bad">hidden</span>' : '<span class="pill ok">visible</span>' },
      { label: 'When',   cell: (r) => esc(when(r.created_at)) },
      { label: '',       cell: (r) => `<button class="btn-sm" data-rec="${esc(r.id)}" data-act="${r.is_visible === false ? 'show' : 'hide'}">${r.is_visible === false ? 'Show' : 'Hide'}</button>` },
    ], 'No community submissions.');
  } catch (e) { say(e.message); }
};
$('#communityOut').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-rec]');
  if (!b) return;
  clear(); b.disabled = true;
  try {
    await api(`/api/admin/recommendations/${encodeURIComponent(b.dataset.rec)}/${b.dataset.act}`, { method: 'POST' });
    loaders.community();
  } catch (err) { say(err.message); b.disabled = false; }
});

// ── Feedback ───────────────────────────────────────────────────────────────
// Private by construction: RLS denies the publishable key SELECT entirely, so
// this is the only place feedback is readable.
const KIND_PILL = { bug: '<span class="pill bad">bug</span>', idea: '<span class="pill ok">idea</span>' };

loaders.feedback = async () => {
  const status = $('#fbStatus').value;
  try {
    const d = await api('/api/admin/feedback?status=' + encodeURIComponent(status));
    const c = d.counts || {};
    // Counts on the labels, so a moderator can see work is waiting without
    // switching filters to find out.
    for (const opt of $('#fbStatus').options) {
      const base = { new: 'Unread', read: 'Read', archived: 'Archived', all: 'All' }[opt.value];
      opt.textContent = opt.value === 'all' ? base : `${base} (${fmt(c[opt.value] ?? 0)})`;
    }
    $('#feedbackOut').innerHTML = table(d.feedback || [], [
      { label: 'When',    cell: (f) => esc(when(f.created_at)) },
      { label: 'Type',    cell: (f) => KIND_PILL[f.kind] || '<span class="pill">other</span>' },
      { label: 'Message', cell: (f) => `<div class="fb-text">${esc(f.message)}</div>` },
      { label: 'Page',    cell: (f) => f.page ? `<code>${esc(f.page)}</code>` : '—' },
      // A reply address only matters if they left one; showing "—" in a column
      // of blanks is noise.
      { label: 'Reply to', cell: (f) => f.email
          ? `<a href="mailto:${esc(f.email)}">${esc(f.email)}</a>` : '<span class="hint-inline">none</span>' },
      { label: '', cell: (f) => [
          f.status === 'new'      ? `<button class="btn-sm" data-fb="${esc(f.id)}" data-act="read">Mark read</button>` : '',
          f.status !== 'archived' ? `<button class="btn-sm" data-fb="${esc(f.id)}" data-act="archive">Archive</button>` : '',
          `<button class="btn-sm bad ghost" data-fb="${esc(f.id)}" data-act="delete">Delete</button>`,
        ].filter(Boolean).join(' ') },
    ], status === 'new' ? 'No unread feedback.' : 'Nothing here.');
  } catch (e) { say(e.message); }
};

$('#fbStatus').addEventListener('change', () => loaders.feedback());
$('#feedbackOut').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-fb]');
  if (!b) return;
  if (b.dataset.act === 'delete' && !confirm('Permanently delete this feedback? This cannot be undone.')) return;
  clear(); b.disabled = true;
  try {
    await api(`/api/admin/feedback/${encodeURIComponent(b.dataset.fb)}/${b.dataset.act}`, { method: 'POST' });
    loaders.feedback();
  } catch (err) { say(err.message); b.disabled = false; }
});

// ── Security ───────────────────────────────────────────────────────────────
loaders.security = async () => {
  try {
    const d = await api('/api/admin/security');
    $('#sessionsOut').innerHTML = table(d.sessions || [], [
      { label: 'Started',  cell: (s) => esc(when(s.created_at)) },
      { label: 'Last seen', cell: (s) => esc(when(s.last_seen_at)) },
      { label: 'Expires',  cell: (s) => esc(when(s.expires_at)) },
      { label: 'Network',  cell: (s) => `<code>${esc((s.ip_hash || '').slice(0, 10))}</code>` },
      { label: 'State',    cell: (s) => s.revoked_at
          ? `<span class="pill bad">revoked · ${esc(s.revoked_reason || '')}</span>` : '<span class="pill ok">active</span>' },
    ], 'No sessions recorded.');

    $('#loginsOut').innerHTML = table(d.logins || [], [
      { label: 'When',    cell: (l) => esc(when(l.at)) },
      { label: 'Result',  cell: (l) => l.ok ? '<span class="pill ok">success</span>' : '<span class="pill bad">failed</span>' },
      { label: 'Reason',  cell: (l) => esc(l.reason) },
      { label: 'Network', cell: (l) => `<code>${esc((l.ip_hash || '').slice(0, 10))}</code>` },
    ], 'No sign-in attempts recorded.');

    $('#eventsOut').innerHTML = table(d.events || [], [
      { label: 'When',     cell: (v) => esc(when(v.at)) },
      { label: 'Event',    cell: (v) => esc(v.kind) },
      { label: 'Severity', cell: (v) => `<span class="pill ${v.severity === 'critical' ? 'bad' : v.severity === 'warn' ? 'warn' : ''}">${esc(v.severity)}</span>` },
      { label: 'Network',  cell: (v) => `<code>${esc((v.ip_hash || '').slice(0, 10))}</code>` },
    ], 'No security events. That is the good outcome.');

    $('#auditOut').innerHTML = table(d.actions || [], [
      { label: 'When',    cell: (a) => esc(when(a.at)) },
      { label: 'Who',     cell: (a) => esc(a.username) },
      { label: 'Action',  cell: (a) => `<code>${esc(a.action)}</code>` },
      { label: 'Target',  cell: (a) => esc(a.target) },
      { label: 'Outcome', cell: (a) => `<span class="pill ${a.outcome === 'success' ? 'ok' : 'bad'}">${esc(a.outcome)}</span>` },
    ], 'No admin actions recorded yet.');
  } catch (e) { say(e.message); }
};

// ── Analytics ──────────────────────────────────────────────────────────────
loaders.analytics = async () => {
  try {
    const d = await api('/api/admin/analytics');
    $('#anStats').innerHTML = [
      ['Games served',  fmt(d.games)],
      ['Total plays',   fmt(d.totalPlays)],
      ['Games played',  fmt(d.playedGames)],
      // On a 12,000-game catalogue this is the number that says whether
      // discovery works: the share anyone has ever actually opened.
      ['Catalog reach', `${fmt(d.coverage)}%`],
    ].map(([k, v]) => `<div class="stat"><span class="stat-v">${esc(v)}</span><span class="stat-k">${esc(k)}</span></div>`).join('');

    $('#anTop').innerHTML = table(d.topGames || [], [
      { label: '#',        cell: (g, i) => String((d.topGames || []).indexOf(g) + 1) },
      { label: 'Game',     cell: (g) => esc(g.title || g.slug) },
      { label: 'Slug',     cell: (g) => `<code>${esc(g.slug)}</code>` },
      { label: 'Category', cell: (g) => esc(g.category) },
      { label: 'Plays',    cell: (g) => `<strong>${fmt(g.plays)}</strong>` },
    ], 'No game has been played yet.');

    // A bar per row rather than a bare count: with 40 categories the relative
    // shape is the point, and a column of numbers hides it.
    const bars = (rows, heading) => {
      const max = Math.max(1, ...rows.map((r) => r.count));
      return `<div><h3>${esc(heading)}</h3>` + rows.map((r) => `
        <div class="bar-row">
          <span class="bar-k">${esc(r.name)}</span>
          <span class="bar-track"><span class="bar-fill" style="width:${(r.count / max) * 100}%"></span></span>
          <span class="bar-v">${fmt(r.count)}</span>
        </div>`).join('') + '</div>';
    };
    $('#anBreakdown').innerHTML =
      bars((d.categories || []).slice(0, 14), 'By category') +
      bars(d.providers || [], 'By provider');
  } catch (e) { say(e.message); }
};

// ── System ─────────────────────────────────────────────────────────────────
const kvGrid = (pairs) => pairs
  .filter(([, v]) => v !== null && v !== undefined && v !== '')
  .map(([k, v]) => `<div class="kv"><span class="kv-k">${esc(k)}</span><span class="kv-v">${esc(v)}</span></div>`)
  .join('');

const bytes = (n) => {
  if (!Number.isFinite(Number(n))) return '—';
  const v = Number(n);
  if (v < 1024) return `${v} B`;
  if (v < 1048576) return `${(v / 1024).toFixed(1)} KB`;
  return `${(v / 1048576).toFixed(1)} MB`;
};

loaders.system = async () => {
  try {
    const d = await api('/api/admin/system');
    const up = d.runtime?.uptimeSec || 0;
    $('#sysRuntime').innerHTML = kvGrid([
      ['Node', d.runtime?.node], ['Platform', d.runtime?.platform],
      ['Environment', d.runtime?.env], ['Process id', d.runtime?.pid],
      ['Uptime', `${Math.floor(up / 3600)}h ${Math.floor((up % 3600) / 60)}m`],
      ['Memory (RSS)', `${d.runtime?.rssMB} MB`],
      ['Heap', `${d.runtime?.heapUsedMB} / ${d.runtime?.heapTotalMB} MB`],
    ]);

    const dep = d.deployment || {};
    // Render sets these; running locally they are simply absent, which is not a
    // fault and should not render as a row of dashes.
    $('#sysDeploy').innerHTML = kvGrid([
      ['Host', dep.instance], ['Service', dep.service], ['Region', dep.region],
      ['Branch', dep.branch], ['Commit', dep.commit],
    ]) || '<p class="hint">No deployment metadata — this process is not running on Render.</p>';

    const j = d.jobs || {};
    $('#sysJobs').innerHTML = kvGrid([
      ['Cron jobs', j.cron], ['Catalog source', j.catalogSource],
      ['Catalog built', j.catalogGeneratedAt ? new Date(j.catalogGeneratedAt).toLocaleString() : null],
      ['Games in catalog', fmt(j.catalogGames)],
      ['Play counts tracked', fmt(j.playCountsTracked)],
      ['Unflushed play counts', fmt(j.playCountsPending)],
    ]);

    $('#sysFeatures').innerHTML = (d.features || []).map((f) => `
      <div class="kv"><span class="kv-k">${esc(f.name)}${f.note ? ` <em class="hint-inline">${esc(f.note)}</em>` : ''}</span>
      <span class="kv-v"><span class="pill ${f.on ? 'ok' : ''}">${f.on ? 'on' : 'off'}</span></span></div>`).join('');

    const c = d.caches || {};
    $('#sysCaches').innerHTML = kvGrid([
      ['Thumbnail cache', c.thumbnails?.files === null
        ? 'not created yet'
        : `${fmt(c.thumbnails?.files)} file(s), ${bytes(c.thumbnails?.bytes)}`],
      ['Cache directory', c.thumbnails?.dir],
      ['Catalog in memory', fmt(c.catalogInMemory)],
    ]);

    const e = d.errors || {};
    $('#sysErrors').innerHTML =
      `<p class="hint">${fmt(e.distinct)} distinct, ${fmt(e.total)} total since boot` +
      `${e.dropped ? ` · ${fmt(e.dropped)} evicted (buffer holds ${fmt(e.capacity)})` : ''}</p>` +
      table(e.recent || [], [
        { label: 'Last seen', cell: (x) => esc(when(x.lastAt)) },
        { label: 'Count',     cell: (x) => x.count > 1 ? `<strong>${fmt(x.count)}×</strong>` : '1' },
        { label: 'Where',     cell: (x) => x.where ? `<code>${esc(x.where)}</code>` : '—' },
        { label: 'Error',     cell: (x) => esc(x.message) },
      ], 'No server errors since boot. That is the good outcome.');
  } catch (err) { say(err.message); }
};

$('#clearCache').addEventListener('click', async (ev) => {
  clear();
  ev.target.disabled = true;
  try {
    const d = await api('/api/admin/cache/clear', { method: 'POST' });
    // Safe by construction: every entry is a copy of a remote image that is
    // re-fetched on demand, so the worst case is one slow page load.
    say(`Thumbnail cache cleared — ${fmt(d.removed)} file(s) removed.`, 'ok');
    loaders.system();
  } catch (e) { say(e.message); } finally { ev.target.disabled = false; }
});

// ── Session controls ───────────────────────────────────────────────────────
$('#logout').addEventListener('click', async () => {
  try { await api('/api/admin/auth/logout', { method: 'POST' }); } catch { /* leaving anyway */ }
  window.location.replace('/admin/login');
});
$('#logoutAll').addEventListener('click', async () => {
  if (!confirm('Revoke every admin session, including this one?')) return;
  try { await api('/api/admin/auth/logout-all', { method: 'POST' }); } catch { /* leaving anyway */ }
  window.location.replace('/admin/login');
});

// ── Boot ───────────────────────────────────────────────────────────────────
(async () => {
  try {
    const me = await api('/api/admin/me');
    $('#whoami').textContent = me.username + (me.via === 'bearer' ? ' (token)' : '');
  } catch { return; }             // api() already redirected on 401
  loaders.overview();
})();
