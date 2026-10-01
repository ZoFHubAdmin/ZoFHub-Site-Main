// admin-ui/assets/admin.js — the ZoFHub admin console.
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
//
// ── TWO RULES ABOUT WHAT THIS SHOWS ───────────────────────────────────────
//
// 1. Every number comes from an endpoint that actually measures it, and every
//    field name below was read off a live response rather than guessed.
//
// 2. Where the site genuinely does not collect something an operator expects —
//    donation revenue is the real case — this says so in ONE quiet line next to
//    the thing it relates to. Not an empty chart, not a zero, and not the
//    paragraph-long explanation the previous version used, which is what made
//    the console feel heavy. A dashboard that invents a metric is worse than one
//    that admits the gap, because the invented one gets believed and acted on.
// ---------------------------------------------------------------------------

import { controlViews, CONTROL_NAV } from './admin-control.js';

const $ = (s) => document.querySelector(s);
const banner = $('#banner');

// Who is signed in, and what they may do. Filled by /api/admin/me at boot and
// used ONLY to hide controls a role cannot use — every one is enforced again on
// the server, because a hidden button is not an access control.
let ME = null;

function say(text, kind = 'error') {
  banner.textContent = text;
  banner.className = 'msg ' + kind;
  banner.hidden = false;
}
const clearBanner = () => { banner.hidden = true; };

// Escape everything that reaches the DOM as markup. Most values here are
// operational strings, but a game title, a username and a feedback message are
// all user-supplied.
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

/** Fetch that resolves to null instead of throwing — for optional panels. */
const maybe = (path) => api(path).catch(() => null);

// ── Formatting ─────────────────────────────────────────────────────────────
const fmt = (n) => (n === null || n === undefined || Number.isNaN(Number(n)) ? '—' : Number(n).toLocaleString());
const when = (t) => (t ? new Date(t).toLocaleString() : '—');

function compact(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '—';
  if (Math.abs(v) >= 1e9) return (v / 1e9).toFixed(1).replace(/\.0$/, '') + 'B';
  if (Math.abs(v) >= 1e6) return (v / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  if (Math.abs(v) >= 1e3) return (v / 1e3).toFixed(1).replace(/\.0$/, '') + 'k';
  return String(v);
}

function duration(sec) {
  const s = Number(sec);
  if (!Number.isFinite(s) || s < 0) return '—';
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${m}m`;
}

const bytes = (b) => {
  const v = Number(b);
  if (!Number.isFinite(v)) return '—';
  if (v >= 1073741824) return (v / 1073741824).toFixed(1) + ' GB';
  if (v >= 1048576) return (v / 1048576).toFixed(0) + ' MB';
  if (v >= 1024) return (v / 1024).toFixed(0) + ' KB';
  return v + ' B';
};

/**
 * A user-agent string is 120 characters of boilerplate wrapping about three
 * useful words. Dumping it raw pushed the column after it out of the card, and
 * nobody reads "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit…" anyway.
 * The full string stays in the title attribute for the rare time it matters.
 */
function shortUA(ua) {
  const s = String(ua || '');
  if (!s) return '—';
  const br = /Edg\//.test(s) ? 'Edge'
    : /OPR\//.test(s) ? 'Opera'
    : /Firefox\//.test(s) ? 'Firefox'
    : /Chrome\//.test(s) ? 'Chrome'
    : /Safari\//.test(s) ? 'Safari' : 'Browser';
  const os = /Windows NT 10/.test(s) ? 'Windows'
    : /Mac OS X/.test(s) ? 'macOS'
    : /Android/.test(s) ? 'Android'
    : /iPhone|iPad/.test(s) ? 'iOS'
    : /Linux/.test(s) ? 'Linux' : '';
  return os ? `${br} · ${os}` : br;
}

const ago = (t) => {
  if (!t) return '—';
  const s = Math.round((Date.now() - new Date(t).getTime()) / 1000);
  if (s < 60) return s + 's ago';
  if (s < 3600) return Math.round(s / 60) + 'm ago';
  if (s < 86400) return Math.round(s / 3600) + 'h ago';
  return Math.round(s / 86400) + 'd ago';
};

// ── Markup builders ────────────────────────────────────────────────────────
const card = (title, inner, { hint, state } = {}) =>
  `<section class="card${state ? ' is-' + state : ''}">
     ${title ? `<h2>${title}</h2>` : ''}
     ${hint ? `<p class="hint">${esc(hint)}</p>` : ''}
     ${inner}
   </section>`;

const stat = (k, v, sub, { unit, state } = {}) =>
  `<section class="card${state ? ' is-' + state : ''}">
     <div class="stat">
       <span class="stat-k">${esc(k)}</span>
       <span class="stat-v">${v}${unit ? `<span class="unit">${esc(unit)}</span>` : ''}</span>
       ${sub ? `<span class="stat-s">${sub}</span>` : ''}
     </div>
   </section>`;

const pill = (text, kind = '') => `<span class="pill${kind ? ' ' + kind : ''}">${esc(text)}</span>`;
const onOff = (v, on = 'on', off = 'off') => pill(v ? on : off, v ? 'ok' : '');

const kv = (rows) =>
  `<dl class="kv">${rows.filter(Boolean).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('')}</dl>`;

const table = (cols, rows) => {
  if (!rows.length) return '<p class="empty">Nothing to show.</p>';
  return `<div class="tblwrap"><table class="tbl">
    <thead><tr>${cols.map((c) => `<th${c.n ? ' class="n"' : ''}>${esc(c.t)}</th>`).join('')}</tr></thead>
    <tbody>${rows.map((r) => `<tr>${r.map((cell, i) =>
      `<td${cols[i]?.n ? ' class="n"' : ''}${cols[i]?.cls ? ` class="${cols[i].cls}"` : ''}>${cell}</td>`).join('')}</tr>`).join('')}
    </tbody></table></div>`;
};

/** Proportion bars. `items` = [{label, value}]; scaled against the largest. */
const bars = (items, kind = '') => {
  if (!items.length) return '<p class="empty">No data yet.</p>';
  const max = Math.max(...items.map((i) => Number(i.value) || 0), 1);
  return items.map((i) => `
    <div class="barrow">
      <span class="lbl">${esc(i.label)}</span>
      <span class="val">${fmt(i.value)}</span>
      <span class="bar ${kind}"><i style="width:${Math.max(2, Math.round((Number(i.value) || 0) / max * 100))}%"></i></span>
    </div>`).join('');
};

const skeleton = (n = 3) =>
  `<div class="grid g-2">${Array.from({ length: n }, () =>
    `<section class="card"><div class="sk" style="width:40%;margin-bottom:12px"></div>
     <div class="sk" style="width:85%;margin-bottom:7px"></div><div class="sk" style="width:65%"></div></section>`).join('')}</div>`;

// ===========================================================================
// Views
// ===========================================================================
// Why the external sing-box instance is not answering, in words an operator can
// act on. A bare `unreachable` sends someone to the wrong place; "is it running,
// is the port right" is the actual next step.
const SB_REASON = {
  'not-configured': 'SINGBOX_API_URL is not set',
  'unreachable': 'no answer on SINGBOX_API_URL — is the daemon running?',
  'timeout': 'the daemon did not answer in time',
  'unauthorized': 'SINGBOX_API_SECRET is wrong or missing',
  'bad-response': 'answered, but not with Clash-API JSON',
};

const VIEWS = {

  // ── Overview: the whole picture, because that is the actual ask ──────────
  overview: {
    title: 'Overview',
    sub: 'Everything at a glance',
    async render() {
      const [d, a, q, fb, don] = await Promise.all([
        api('/api/admin/dashboard'),
        maybe('/api/admin/analytics'),
        maybe('/api/admin/catalog/quality'),
        maybe('/api/admin/feedback'),
        maybe('/api/admin/donations'),
      ]);

      const db = d.database || {};
      const broken = Number(db.broken || 0);
      const newFb = Number(fb?.counts?.new || 0);
      const donProblems = (don?.problems || []).length;
      const score = q?.score;

      // Health state drives the stripe colour, so severity reads before text.
      const health = broken > 50 || !d.supabase?.connected ? 'bad'
        : (broken > 0 || donProblems > 0) ? 'warn' : 'ok';

      const strip = `<div class="grid g-stats">
        ${stat('Live now', `<span id="live-tile">${fmt(d.liveNow)}</span>`,
          `peak ${fmt(d.peakConcurrent)} since restart`, { state: d.liveNow > 0 ? 'ok' : '' })}
        ${stat('Visitors today', fmt(d.audience?.today), 'distinct, this instance')}
        ${stat('Lifetime plays', compact(a?.totalPlays ?? d.plays?.lifetime),
          `${fmt(a?.playedGames ?? d.plays?.tracked)} games played`)}
        ${stat('Games served', compact(d.catalog?.served), `${fmt(d.catalog?.categories)} categories`)}
        ${stat('AI requests', fmt(d.ai?.total), 'server-side, since restart')}
        ${stat('Catalog quality', score == null ? '—' : score + '<span class="unit">%</span>',
          q?.affected ? `${fmt(q.affected)} row${q.affected > 1 ? 's' : ''} need work` : 'no issues found',
          { state: health })}
      </div>`;

      const top = (a?.topGames || []).slice(0, 10);
      const topCard = card('Most played',
        table(
          [{ t: '#' }, { t: 'Game' }, { t: 'Category' }, { t: 'Plays', n: true }],
          top.map((g, i) => [
            `<span class="rank">${i + 1}</span>`,
            `<span class="ttl">${esc(g.title || g.slug)}</span>`,
            pill(g.category || 'uncategorised'),
            fmt(g.plays),
          ])),
        { hint: 'Ranked by lifetime plays, stored in game_stats.' });

      // "Needs attention" lists only things that are actually true right now.
      const issues = [];
      if (!d.supabase?.connected) issues.push(['Database unreachable', pill('critical', 'bad')]);
      if (broken) issues.push([`${fmt(broken)} games marked broken`, pill('review', 'warn')]);
      if (donProblems) issues.push([`${donProblems} donation method${donProblems > 1 ? 's' : ''} not live`, pill('config', 'warn')]);
      if (newFb) issues.push([`${fmt(newFb)} unread message${newFb > 1 ? 's' : ''}`, pill('inbox', 'info')]);
      if (q?.affected) issues.push([`${fmt(q.affected)} catalog row${q.affected > 1 ? 's' : ''} with issues`, pill('quality', 'warn')]);

      const statusCard = card('Status', kv([
        ['Database', d.supabase?.connected ? pill('connected', 'ok') : pill('unreachable', 'bad')],
        ['Catalog source', esc(d.catalog?.source || '—')],
        ['Games working', `${fmt(db.working)}${broken ? ' · ' + pill(fmt(broken) + ' broken', 'warn') : ''}`],
        ['Scheduled jobs', d.server?.cronDisabled ? pill('disabled') : pill('running', 'ok')],
        ['Environment', pill(d.server?.env || '—', d.server?.env === 'production' ? 'ok' : '')],
        ['Uptime', duration(d.server?.uptimeSec)],
        ['Memory', fmt(d.server?.memoryMB) + ' MB'],
      ]));

      const cp = d.controlPlane || {};
      const cc = d.content || {};
      const sec = d.security || {};
      const pc = d.proxyControl || {};
      if (cp.schema && cp.schema !== 'ready') issues.push([cp.schema === 'memory' ? 'Control plane in memory (not saved)' : 'Control-plane migration not applied', pill(cp.schema, cp.schema === 'memory' ? 'info' : 'warn')]);
      if (cc.pending_review) issues.push([`${fmt(cc.pending_review)} game${cc.pending_review > 1 ? 's' : ''} awaiting review`, pill('review', 'warn')]);
      if (sec.failedLogins24h > 5) issues.push([`${fmt(sec.failedLogins24h)} failed sign-ins in 24h`, pill('security', 'bad')]);
      const controlCard = card('Control plane', kv([
        ['Storage', cp.schema === 'ready' ? pill('database', 'ok') : pill(cp.schema || 'unknown', cp.schema === 'memory' ? 'info' : 'warn')],
        ['Published', fmt(cc.published)],
        ['Pending review', cc.pending_review ? pill(fmt(cc.pending_review), 'warn') : '0'],
        ['Drafts · archived', `${fmt(cc.draft || 0)} · ${fmt(cc.archived || 0)}`],
        ['Staff active', d.staff ? `${fmt(d.staff.active)}${d.staff.suspended ? ' · ' + pill(fmt(d.staff.suspended) + ' suspended', 'warn') : ''}` : '—'],
        ['Failed sign-ins (24h)', fmt(sec.failedLogins24h)],
        ['Denied actions (24h)', fmt(sec.deniedActions24h)],
        ['Proxy access', `${esc(pc.accessMode || '—')} · ${fmt(pc.approvedTargets)} destination${pc.approvedTargets === 1 ? '' : 's'}`],
        ['Build', esc([d.build?.version, d.build?.commit].filter(Boolean).join(' · ') || '—')],
      ]), { hint: cp.reason || undefined, state: cp.schema && cp.schema !== 'ready' && cp.schema !== 'memory' ? 'warn' : '' });

      const attention = card('Needs attention',
        issues.length
          ? kv(issues)
          : '<p class="empty">Nothing needs attention.</p>',
        { state: issues.length ? health : 'ok' });

      const cats = (a?.categories || []).slice(0, 8).map((c) => ({ label: c.name, value: c.count }));
      const provs = (a?.providers || []).slice(0, 8).map((p) => ({ label: p.name, value: p.count }));

      return `
        ${strip}
        <div class="grid g-wide">
          ${topCard}
          <div class="grid">${statusCard}${attention}${controlCard}</div>
        </div>
        <div class="grid g-2">
          ${card('Categories', bars(cats), { hint: 'Games per category across the served catalog.' })}
          ${card('Providers', bars(provs, 'info'), { hint: 'Where the embedded games are hosted.' })}
        </div>`;
    },
  },

  // ── Games ────────────────────────────────────────────────────────────────
  games: {
    title: 'Games',
    sub: 'What people actually play',
    async render() {
      const [a, q] = await Promise.all([api('/api/admin/analytics'), maybe('/api/admin/catalog/quality')]);
      const top = a.topGames || [];

      const coverage = Number(a.coverage || 0);
      const strip = `<div class="grid g-stats">
        ${stat('In catalog', compact(a.games), 'served to visitors')}
        ${stat('Total plays', compact(a.totalPlays), 'lifetime')}
        ${stat('Games played', fmt(a.playedGames), `${coverage}% of catalog`)}
        ${stat('Quality score', q?.score == null ? '—' : q.score + '<span class="unit">%</span>',
          `${fmt(q?.healthy)} clean rows`, { state: q?.score >= 95 ? 'ok' : q?.score >= 80 ? 'warn' : 'bad' })}
      </div>`;

      const sev = q?.bySeverity || {};
      const sevRows = Object.entries(sev).filter(([, v]) => v)
        .map(([k, v]) => [esc(k), pill(fmt(v), k === 'broken' ? 'bad' : k === 'duplicate' ? 'warn' : '')]);

      const kindRows = Object.entries(q?.byKind || {})
        .map(([k, v]) => [esc(q?.labels?.[k] || k), fmt(v)]);

      return `
        ${strip}
        <div class="grid g-wide">
          ${card('Top 25 by plays',
            table([{ t: '#' }, { t: 'Game' }, { t: 'Slug' }, { t: 'Category' }, { t: 'Plays', n: true }],
              top.slice(0, 25).map((g, i) => [
                `<span class="rank">${i + 1}</span>`,
                `<span class="ttl">${esc(g.title || g.slug)}</span>`,
                `<span class="mono trunc">${esc(g.slug)}</span>`,
                pill(g.category || '—'),
                fmt(g.plays),
              ])))}
          <div class="grid">
            ${card('Issues by severity', sevRows.length ? kv(sevRows) : '<p class="empty">No issues found.</p>',
              { hint: q?.source ? `From ${esc(q.source)}` : undefined })}
            ${card('Issues by kind', kindRows.length ? kv(kindRows) : '<p class="empty">No issues found.</p>')}
          </div>
        </div>
        <div class="grid g-2">
          ${card('Categories', bars((a.categories || []).slice(0, 12).map((c) => ({ label: c.name, value: c.count }))))}
          ${card('Providers', bars((a.providers || []).slice(0, 12).map((p) => ({ label: p.name, value: p.count })), 'info'))}
        </div>`;
    },
  },

  // ── Players ──────────────────────────────────────────────────────────────
  players: {
    title: 'Players',
    sub: 'Who is here, and what they sent you',
    async render() {
      const [p, d, fb, recs] = await Promise.all([
        api('/api/presence'),
        api('/api/admin/dashboard'),
        maybe('/api/admin/feedback'),
        maybe('/api/admin/recommendations'),
      ]);

      const playing = Object.entries(p.games || {}).sort((a, b) => b[1] - a[1]);
      const inGame = playing.reduce((s, [, n]) => s + n, 0);

      const strip = `<div class="grid g-stats">
        ${stat('Live now', fmt(p.total), 'on the site', { state: p.total > 0 ? 'ok' : '' })}
        ${stat('In a game', fmt(inGame), `${fmt(Math.max(0, p.total - inGame))} browsing`)}
        ${stat('Visitors today', fmt(d.audience?.today), 'distinct, this instance')}
        ${stat('Peak', fmt(d.peakConcurrent), 'since restart')}
      </div>`;

      const fbRows = (fb?.feedback || []).slice(0, 25).map((f) => [
        pill(f.status || 'new', f.status === 'new' ? 'info' : ''),
        `<span class="trunc">${esc(f.message || f.body || '')}</span>`,
        ago(f.created_at || f.at),
      ]);

      const recRows = (recs?.recommendations || []).slice(0, 25).map((r) => [
        r.inCatalog ? pill('duplicate', 'warn') : pill('new', 'ok'),
        `<span class="ttl">${esc(r.title)}</span>`,
        `<span class="mono trunc">${esc(r.embed_url || '')}</span>`,
      ]);

      return `
        ${strip}
        <div class="grid g-wide">
          ${card('Playing right now',
            playing.length
              ? bars(playing.slice(0, 14).map(([slug, n]) => ({ label: slug, value: n })), 'ok')
              : '<p class="empty">Nobody is in a game right now.</p>',
            { hint: 'Live presence, 8-second TTL. Not stored anywhere.' })}
          ${card('Counts', kv([
            ['Unread messages', pill(fmt(fb?.counts?.new ?? 0), fb?.counts?.new ? 'info' : '')],
            ['Read', fmt(fb?.counts?.read ?? 0)],
            ['Archived', fmt(fb?.counts?.archived ?? 0)],
            ['Game suggestions', fmt(recs?.counts?.total ?? 0)],
            ['— already in catalog', fmt(recs?.counts?.alreadyInCatalog ?? 0)],
            ['— new to add', pill(fmt(recs?.counts?.newToAdd ?? 0), recs?.counts?.newToAdd ? 'ok' : '')],
          ]))}
        </div>
        <div class="grid g-2">
          ${card('Messages', fbRows.length
            ? table([{ t: 'Status' }, { t: 'Message' }, { t: 'When' }], fbRows)
            : '<p class="empty">No messages.</p>')}
          ${card('Suggested games', recRows.length
            ? table([{ t: 'State' }, { t: 'Title' }, { t: 'Embed URL' }], recRows)
            : '<p class="empty">No suggestions submitted.</p>')}
        </div>
        <p class="note"><b>No accounts, no per-person history.</b> The site has no sign-in and
        stores no visitor record, so "visitors today" is a count of distinct hashed
        addresses held in memory for the current day only.</p>`;
    },
  },

  // ── Money ────────────────────────────────────────────────────────────────
  money: {
    title: 'Money',
    sub: 'Donations and advertising',
    async render() {
      const [don, ads] = await Promise.all([maybe('/api/admin/donations'), maybe('/api/admin/ads')]);

      const live = don?.live || [];
      const problems = don?.problems || [];
      const providers = ads?.providers || [];
      const activeAds = providers.filter((p) => p.active);

      const strip = `<div class="grid g-stats">
        ${stat('Donation methods live', fmt(live.length),
          problems.length ? `${problems.length} not live` : 'all configured',
          { state: live.length ? (problems.length ? 'warn' : 'ok') : 'bad' })}
        ${stat('Ad networks active', fmt(activeAds.length), `${fmt(providers.length)} available`,
          { state: activeAds.length ? 'ok' : '' })}
        ${stat('Swap to Monero', don?.swap?.configured ? 'On' : 'Off',
          don?.swap?.configured ? `settles to ${esc(don.swap.collectsTo || 'XMR')}` : 'not configured',
          { state: don?.swap?.configured ? 'ok' : '' })}
      </div>`;

      const liveRows = live.map((m) => [
        `<span class="ttl">${esc(m.label)}</span>`,
        pill(m.ticker || m.kind || '—', 'brand'),
        `<span class="mono trunc addr" title="${esc(m.address || m.url || '')}">${esc(m.address || m.url || '')}</span>`,
        m.verified ? pill('checksum ok', 'ok') : pill('shape only', 'warn'),
      ]);

      // One role per network (lib/ad-providers.mjs), so the role IS the
      // placement. Regions listed when the network has regional overrides.
      const adRows = providers.map((p) => [
        `<span class="ttl">${esc(p.name)}</span>`,
        esc(p.role || '—') + (p.regionsOverridden?.length ? ` <span class="hint">+ ${esc(p.regionsOverridden.join(', '))}</span>` : ''),
        p.active ? pill('active', 'ok') : p.configured ? pill('configured', 'warn') : pill('off'),
        esc(p.approval || '—'),
      ]);
      const ignored = ads?.ignored || [];

      return `
        ${strip}
        <div class="grid g-wide">
          ${card('Live donation methods',
            liveRows.length
              ? table([{ t: 'Method' }, { t: 'Coin' }, { t: 'Address' }, { t: 'Checked' }], liveRows)
              : '<p class="empty">No donation method is live.</p>',
            { hint: don?.heading || undefined, state: live.length ? 'ok' : 'bad' })}
          ${card('Not live', problems.length
            ? `<ul style="margin:0;padding-left:18px;color:var(--dim);font-size:12.5px;line-height:1.9">
                 ${problems.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>`
            : '<p class="empty">Every configured method is live.</p>',
            { state: problems.length ? 'warn' : 'ok' })}
        </div>
        ${card('Advertising',
          (adRows.length ? table([{ t: 'Network' }, { t: 'Role' }, { t: 'State' }, { t: 'Approval' }], adRows)
                         : '<p class="empty">No ad networks available.</p>')
          + (ignored.length
            ? `<p class="note warn"><b>Set but not used:</b> ${ignored.map((n) => `<code>${esc(n)}</code>`).join(' ')}
               — a retired network, a legacy slot variable, or a field outside that network's role.</p>` : '')
          + `<p class="hint">Ad-block premium gate: ${ads?.adblockGate ? 'on' : 'off'}.</p>`,
          { hint: ads?.surfaces?.adsAllowedOn ? `Allowed on: ${ads.surfaces.adsAllowedOn}` : undefined,
            state: ignored.length ? 'warn' : undefined })}
        <p class="note warn"><b>Revenue is not tracked, and cannot be.</b> A donor's wallet
        pays your address on a public chain; this server is never in that path, so there is
        no amount for it to report. Check the balances in your wallet.
        ${don?.mutable === false ? 'Addresses come from environment variables and are not editable here.' : ''}</p>`;
    },
  },

  // ── Proxy ──────────────────────────────────────────────────────────────
  // Telemetry for the proxy layer this server actually runs — the Wisp tunnel
  // and the engines mounted by proxy-engine/mount.mjs. Everything shown is
  // measured in-process by /api/admin/proxy, so there is no external daemon to
  // scrape and nothing that can be out of sync with what the server is doing.
  proxy: {
    title: 'Proxy',
    sub: 'Tunnels, engines and live traffic',
    async render() {
      const p = await api('/api/admin/proxy');
      const t = p.tunnels || {};
      const eng = p.engines || {};
      const proc = p.process || {};
      const sb = p.singbox || { reachable: false, configured: false, reason: 'not-configured' };
      const sbp = p.singboxProcess || { managed: false };

      // Saturation is the number an operator acts on: how close the tunnel pool
      // is to refusing new connections. `rejected > 0` means it already has.
      const satState = t.saturationPct >= 90 ? 'bad' : t.saturationPct >= 70 ? 'warn' : 'ok';

      const strip = `<div class="grid g-stats">
        ${stat('Live tunnels', fmt(t.live), `of ${fmt(t.capacity)} capacity`, { state: satState })}
        ${stat('Saturation', `${t.saturationPct ?? 0}`, `peak ${fmt(t.peak)} concurrent`,
          { unit: '%', state: satState })}
        ${stat('Refused', fmt(t.rejected), t.rejected ? 'at capacity — raise the cap' : 'none turned away',
          { state: t.rejected ? 'bad' : 'ok' })}
        ${stat('Traffic', bytes((t.bytesIn || 0) + (t.bytesOut || 0)),
          `${bytes(t.bytesIn)} in / ${bytes(t.bytesOut)} out`)}
      </div>`;

      // Engines are the reason a given proxy route works or 404s. A `false`
      // here is otherwise only visible in the boot log.
      const engineRows = Object.entries(eng).map(([name, on]) => [
        esc(name), onOff(on, 'mounted', 'unavailable'),
      ]);

      return `
        ${strip}
        <div class="grid g-2">
          ${card('Tunnel lifecycle', kv([
            ['Opened (lifetime)', fmt(t.opened)],
            ['Closed (lifetime)', fmt(t.closed)],
            ['Currently open', fmt(t.live)],
            ['Peak concurrent', fmt(t.peak)],
            ['Idle reclaim', `${Math.round((t.idleTimeoutMs || 0) / 60000)} min`],
            ['Keepalive probe', `${Math.round((t.keepAliveMs || 0) / 1000)} s`],
          ]), { hint: 'A tunnel is reclaimed after the idle window, or when TCP keepalive finds the peer gone.' })}
          ${card('Proxy engines', engineRows.length
            ? table([{ t: 'Engine' }, { t: 'State' }], engineRows)
            : '<p class="empty">No engines reported.</p>',
            { hint: 'Mounted at boot from proxy-engine/mount.mjs.' })}
        </div>
        ${card('sing-box (external)', sb.reachable
          ? kv([
            ['State', pill('connected', 'ok')],
            ['Live connections', fmt(sb.live)],
            ['Uploaded', bytes(sb.uploadBytes)],
            ['Downloaded', bytes(sb.downloadBytes)],
            ['Daemon memory', sb.memoryBytes ? bytes(sb.memoryBytes) : '—'],
          ])
          // Never a zero-filled table. "Not connected" and "connected but idle"
          // are different facts and must not look identical.
          // No trailing full stop: several reasons already end in '?' or '.',
          // and "is the daemon running?." reads like a typo in the product.
          : `<p class="empty">Not connected${sb.reason ? ` — ${esc(SB_REASON[sb.reason] || sb.reason)}` : ''}</p>`,
          {
            state: sb.reachable ? 'ok' : sb.configured ? 'warn' : '',
            hint: sb.configured
              ? 'Read over the loopback Clash API.'
              : 'Optional. Unset — set SINGBOX_API_URL to read an instance. See docs/proxy/SINGBOX.md.',
          })}
        ${card('sing-box process', sbp.managed
          ? kv([
            ['State', sbp.running ? pill('running', 'ok') : pill('stopped', 'bad')],
            ['Process id', sbp.pid ? esc(String(sbp.pid)) : '—'],
            ['Uptime', sbp.running ? duration(sbp.uptimeSec) : '—'],
            ['Restarts', fmt(sbp.restarts)],
            sbp.lastExit ? ['Last exit', `code ${esc(String(sbp.lastExit.code))} · ${ago(sbp.lastExit.at)}`] : null,
            sbp.lastError ? ['Last error', `<span class="stat-s">${esc(sbp.lastError)}</span>`] : null,
          ])
          // Not managed is the DEFAULT, not a fault — ZoFHub reads a daemon you
          // start yourself unless you opt into supervision.
          : '<p class="empty">Not managed — ZoFHub is not starting this daemon.</p>',
          {
            state: !sbp.managed ? '' : sbp.running ? 'ok' : 'bad',
            hint: sbp.managed
              ? 'ZoFHub renders the config, runs sing-box check, spawns and restarts it.'
              : 'Set SINGBOX_MANAGED=1 to have ZoFHub start and supervise it.',
          })}
        ${card('Process', kv([
          ['Uptime', duration(proc.uptimeSec)],
          ['Memory (RSS)', `${fmt(proc.rssMb)} MB`],
          ['Heap used', `${fmt(proc.heapUsedMb)} MB`],
          ['Active handles', fmt(proc.handles)],
        ]), { hint: 'Auto-refreshes every 5 seconds while this view is open.' })}`;
    },
    // The one view that keeps refreshing: tunnel counts are live state, and a
    // static snapshot of "live tunnels" is close to useless. The interval is
    // cleared by the view switcher (see stopViewTimers) so it cannot leak or
    // keep polling a section nobody is looking at.
    wire() {
      startViewTimer(async () => {
        try {
          const p = await api('/api/admin/proxy');
          const t = p.tunnels || {};
          const nav = document.querySelector('#n-tunnels');
          if (nav) nav.textContent = t.live ? String(t.live) : '';
          // Only repaint if this view is still the one on screen — the timer is
          // cleared on switch, but a request already in flight can still land.
          if (current === 'proxy') renderCurrent({ quiet: true });
        } catch { /* a failed poll is not worth a banner */ }
      }, 5000);
    },
  },

  // ── System ───────────────────────────────────────────────────────────────
  system: {
    title: 'System',
    sub: 'Runtime, security and sessions',
    async render() {
      const [s, sec, me] = await Promise.all([
        api('/api/admin/system'),
        maybe('/api/admin/security'),
        maybe('/api/admin/me'),
      ]);
      const r = s.runtime || {}, dep = s.deployment || {}, jobs = s.jobs || {}, ca = s.caches || {};
      const errs = s.errors?.recent || s.errors || [];
      const logins = sec?.logins || [];
      const failed = logins.filter((l) => !l.ok).length;

      const strip = `<div class="grid g-stats">
        ${stat('Uptime', duration(r.uptimeSec), esc(r.env || ''))}
        ${stat('Memory', fmt(r.rssMB), `heap ${fmt(r.heapUsedMB)} / ${fmt(r.heapTotalMB)} MB`, { unit: 'MB' })}
        ${stat('Failed sign-ins', fmt(failed), `of ${fmt(logins.length)} recorded`,
          { state: failed > 5 ? 'warn' : 'ok' })}
        ${stat('Active sessions', fmt((sec?.sessions || []).filter((x) => !x.revoked_at).length), 'for this account')}
      </div>`;

      const featRows = (s.features || []).map((f) => [
        esc(f.name), onOff(f.on), `<span class="stat-s">${esc(f.note || '')}</span>`,
      ]);

      const sessRows = (sec?.sessions || []).slice(0, 10).map((x) => [
        x.revoked_at ? pill('revoked') : pill('active', 'ok'),
        `<span class="mono">${esc(String(x.ip_hash || '').slice(0, 12))}</span>`,
        `<span title="${esc(x.user_agent || '')}">${esc(shortUA(x.user_agent))}</span>`,
        ago(x.last_seen_at),
      ]);

      const loginRows = logins.slice(0, 12).map((l) => [
        l.ok ? pill('ok', 'ok') : pill(l.reason || 'failed', 'bad'),
        esc(l.username || '—'),
        `<span class="mono">${esc(String(l.ip_hash || '').slice(0, 12))}</span>`,
        ago(l.at),
      ]);

      const actionRows = (sec?.actions || []).slice(0, 10).map((x) => [
        esc(x.action), `<span class="trunc">${esc(x.target || '—')}</span>`,
        x.outcome === 'success' ? pill('ok', 'ok') : pill(x.outcome || '?', 'warn'), ago(x.at),
      ]);

      const lock = sec?.lockout || {};

      return `
        ${strip}
        <div class="grid g-2">
          ${card('Runtime', kv([
            ['Node', esc(r.node || '—')], ['Platform', esc(r.platform || '—')],
            ['Environment', pill(r.env || '—', r.env === 'production' ? 'ok' : '')],
            ['Process id', esc(String(r.pid ?? '—'))],
          ]))}
          ${card('Deployment', kv([
            ['Instance', esc(dep.instance || '—')], ['Service', esc(dep.service || '—')],
            ['Region', esc(dep.region || '—')], ['Branch', esc(dep.branch || '—')],
            ['Commit', dep.commit ? `<span class="mono">${esc(String(dep.commit).slice(0, 8))}</span>` : '—'],
          ]))}
          ${card('Jobs & catalog', kv([
            ['Scheduled jobs', jobs.cron === 'disabled' ? pill('disabled') : pill(jobs.cron || '—', 'ok')],
            ['Catalog source', esc(jobs.catalogSource || '—')],
            ['Games in memory', fmt(jobs.catalogGames ?? ca.catalogInMemory)],
            ['Play counts tracked', fmt(jobs.playCountsTracked)],
            ['Pending writes', fmt(jobs.playCountsPending)],
            ['Generated', ago(jobs.catalogGeneratedAt)],
          ]))}
          ${card('Caches', kv([
            ['Thumbnail files', fmt(ca.thumbnails?.files)],
            ['Thumbnail size', bytes(ca.thumbnails?.bytes)],
            ['Directory', `<span class="mono">${esc(ca.thumbnails?.dir || '—')}</span>`],
          ]))}
        </div>
        ${featRows.length ? card('Features', table([{ t: 'Feature' }, { t: 'State' }, { t: 'Note' }], featRows)) : ''}
        <div class="grid g-2">
          ${card('Your sessions', sessRows.length
            ? table([{ t: 'State' }, { t: 'IP (hashed)' }, { t: 'Browser' }, { t: 'Last seen' }], sessRows)
            : '<p class="empty">No sessions.</p>',
            { hint: `Signed in as ${esc(me?.username || '—')} via ${esc(me?.via || '—')}.` })}
          ${card('Sign-in attempts', loginRows.length
            ? table([{ t: 'Result' }, { t: 'Username' }, { t: 'IP (hashed)' }, { t: 'When' }], loginRows)
            : '<p class="empty">No attempts recorded.</p>',
            { hint: `Locks after ${lock.threshold ?? '—'} failures in ${Math.round((lock.windowMs || 0) / 60000)} min.` })}
        </div>
        <div class="grid g-2">
          ${card('Admin actions', actionRows.length
            ? table([{ t: 'Action' }, { t: 'Target' }, { t: 'Outcome' }, { t: 'When' }], actionRows)
            : '<p class="empty">No actions recorded.</p>')}
          ${(s.warnings || []).length ? card('Configuration warnings',
            `<ul style="margin:0;padding-left:18px;color:var(--warn);font-size:12.5px;line-height:1.8">
               ${s.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>`,
            { state: 'bad', hint: 'Development-only settings detected on a live deployment.' }) : ''}
          ${card('Recent errors', (errs || []).length
            ? `<ul style="margin:0;padding-left:18px;color:var(--dim);font-size:12px;line-height:1.8">
                 ${errs.slice(0, 8).map((e) => `<li>${esc(typeof e === 'string' ? e : e.message || JSON.stringify(e))}</li>`).join('')}</ul>`
            : '<p class="empty">No errors recorded.</p>',
            { state: (errs || []).length ? 'warn' : 'ok' })}
        </div>
        <div style="margin-top:14px;display:flex;gap:10px;flex-wrap:wrap">
          <button class="btn" id="clear-cache">Clear caches</button>
          <button class="btn danger" id="revoke-all">Sign out everywhere</button>
        </div>`;
    },
    wire() {
      const cc = $('#clear-cache');
      if (cc) cc.onclick = async () => {
        cc.disabled = true;
        try { await api('/api/admin/cache/clear', { method: 'POST' }); say('Caches cleared.', 'ok'); }
        catch (e) { say(e.message); }
        cc.disabled = false;
      };
      const ra = $('#revoke-all');
      if (ra) ra.onclick = async () => {
        if (!confirm('Sign out every session for this account, including this one?')) return;
        try { await api('/api/admin/auth/logout-all', { method: 'POST' }); window.location.replace('/admin/login'); }
        catch (e) { say(e.message); }
      };
    },
  },
};

// ===========================================================================
// Router + render
// ===========================================================================
// The control-plane sections (admin-control.js). They share this file's markup
// helpers and router rather than growing a second copy of either.
Object.assign(VIEWS, controlViews({
  esc, card, stat, pill, table, kv, fmt, when, ago, compact, say, maybe,
  me: () => ME,
  reloadMe: () => loadMe(),
  rerender: () => renderCurrent({ quiet: true }),
}));

const ORDER = ['overview', 'games', 'players', 'money', 'system'];
let current = 'overview';

// A render is async, so two of them can be in flight at once. Without this
// guard the SLOWER one wins simply by finishing last, which showed up as the
// console displaying the section you clicked BEFORE the one you are on.
let renderSeq = 0;

// A view may register a polling timer (Proxy does, for live tunnel counts).
// Tracked centrally so switching away ALWAYS clears it — a per-view interval
// that outlives its view is a leak that keeps hitting the API for a section
// nobody is looking at.
let viewTimer = null;
function stopViewTimers() { if (viewTimer) { clearInterval(viewTimer); viewTimer = null; } }
function startViewTimer(fn, ms) { stopViewTimers(); viewTimer = setInterval(fn, ms); }

async function renderCurrent({ quiet = false } = {}) {
  const seq = ++renderSeq;
  const v = VIEWS[current];
  if (!v) return;

  $('#view-title').textContent = v.title;
  $('#view-sub').textContent = v.sub || '';
  for (const b of document.querySelectorAll('.nav-item')) {
    if (b.dataset.view === current) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  }

  if (!quiet) { stopViewTimers(); $('#views').innerHTML = skeleton(); clearBanner(); }
  try {
    const html = await v.render();
    if (seq !== renderSeq) return;      // superseded by a newer render
    $('#views').innerHTML = html;
    v.wire?.();
    clearBanner();
  } catch (e) {
    if (seq !== renderSeq) return;
    if (e.message === 'unauthorized') return;
    $('#views').innerHTML = '';
    say(`Could not load ${v.title}: ${e.message}`);
  }
}

function go(view) {
  if (!VIEWS[view]) view = 'overview';
  current = view;
  if (location.hash.slice(1) !== view) location.hash = view;
  closeDrawer();
  renderCurrent();
}

for (const b of document.querySelectorAll('.nav-item')) {
  b.addEventListener('click', () => go(b.dataset.view));
}
window.addEventListener('hashchange', () => {
  const h = location.hash.slice(1);
  if (h && h !== current && VIEWS[h]) { current = h; renderCurrent(); }
});

$('#refresh').addEventListener('click', () => renderCurrent());

// ── Sidebar drawer (narrow screens) ────────────────────────────────────────
const side = $('#side'), scrim = $('#scrim');
function closeDrawer() { side.classList.remove('open'); scrim.hidden = true; }
$('#side-open').addEventListener('click', () => { side.classList.add('open'); scrim.hidden = false; });
scrim.addEventListener('click', closeDrawer);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrawer(); });

// ── Sign out ───────────────────────────────────────────────────────────────
$('#signout').addEventListener('click', async () => {
  try { await api('/api/admin/auth/logout', { method: 'POST' }); }
  catch { /* logging out must not be blockable */ }
  window.location.replace('/admin/login');
});

// ── Live presence ──────────────────────────────────────────────────────────
// Polls the public presence endpoint. It updates the chip and, when Overview is
// on screen, the one number inside it — it must NEVER re-render a whole view,
// which is what previously made sections swap themselves out while being read.
async function pollPresence() {
  try {
    const p = await api('/api/presence');
    const chip = $('#livechip');
    $('#live-n').textContent = fmt(p.total);
    chip.className = 'livechip' + (p.total > 0 ? ' on' : ' idle');
    const tile = $('#live-tile');
    if (tile) tile.textContent = fmt(p.total);
    const np = $('#n-players');
    if (np) np.textContent = p.total > 0 ? String(p.total) : '';
  } catch { /* a failed poll is not worth a banner */ }
}

// ── Boot ───────────────────────────────────────────────────────────────────
async function loadMe() {
  const me = await api('/api/admin/me');
  ME = me;
  $('#who-name').textContent = me.username || 'admin';
  $('#who-via').textContent = me.via === 'bearer' ? 'service token' : (me.roleLabel || 'session');
  $('#user-mark').textContent = (me.username || '?').slice(0, 1).toUpperCase();
  // Courtesy only: hide sections this role has no permission to use.
  const held = new Set(me.permissions || []);
  for (const b of document.querySelectorAll('.nav-item[data-view]')) {
    const need = CONTROL_NAV[b.dataset.view];
    b.hidden = !!need && !held.has(need);
  }
  // A temporary password may do nothing but be replaced — the server enforces
  // that on every route; this just takes the person straight to the form.
  if (me.mustChangePassword && current !== 'account') go('account');
  return me;
}
loadMe().catch(() => {});

api('/api/admin/dashboard').then((d) => {
  const g = $('#n-games');
  if (g) g.textContent = compact(d.catalog?.served || 0);
  // The review queue's size, so waiting work is visible from any section.
  const rq = $('#n-review');
  if (rq) rq.textContent = d.content?.pending_review ? compact(d.content.pending_review) : '';
}).catch(() => {});

current = VIEWS[location.hash.slice(1)] ? location.hash.slice(1) : 'overview';
renderCurrent();
pollPresence();
setInterval(pollPresence, 10000);
