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
      ['Scores',            fmt(db.scores)],
      ['Flagged scores',    fmt(db.flagged)],
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
loaders.games = loadGames;
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

// ── Leaderboard ────────────────────────────────────────────────────────────
loaders.scores = async () => {
  try {
    const d = await api('/api/admin/scores/flagged');
    const rows = d.scores || d.flagged || [];
    $('#scoresOut').innerHTML = table(rows, [
      { label: 'Player', cell: (s) => esc(s.player_name) },
      { label: 'Game',   cell: (s) => `<code>${esc(s.slug)}</code>` },
      { label: 'Score',  cell: (s) => fmt(s.score) },
      { label: 'Reason', cell: (s) => esc(s.flag_reason || s.status) },
      { label: 'When',   cell: (s) => esc(when(s.created_at)) },
      { label: '',       cell: (s) => `<button class="btn-sm ok" data-score="${esc(s.id)}" data-act="approve">Approve</button> <button class="btn-sm bad" data-score="${esc(s.id)}" data-act="reject">Reject</button>` },
    ], 'No scores are awaiting review.');
  } catch (e) { say(e.message); }
};
$('#scoresOut').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-score]');
  if (!b) return;
  clear(); b.disabled = true;
  try {
    await api(`/api/admin/scores/${encodeURIComponent(b.dataset.score)}/${b.dataset.act}`, { method: 'POST' });
    loaders.scores();
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
