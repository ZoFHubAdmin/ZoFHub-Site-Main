// ZoFHub · vibe-finder.js — "describe your mood, get your game."
// ---------------------------------------------------------------------------
// Type how you feel ("something chill", "fast and competitive", "a puzzle to
// wake my brain up") and get real games back. ALL the heavy lifting is done by
// the server's /api/vibe endpoint, which maps your mood → game genres (a mood
// map + Pollinations AI) and searches the FULL ~14k-game catalog. The old
// version searched only 400 games client-side and matched mood words against
// game TITLES (which never contain words like "chill"), so it usually found
// nothing and could hang on "Reading your vibe…". This version is server-backed,
// fast, and has a hard request timeout so it can never get stuck.
// ---------------------------------------------------------------------------
import { $, el, trapFocus, escapeHtml, wireThumbFallback } from './utils.js';
import { personalizationPayload, hasSignal, vibe as vibeSignal } from './signals.js?v=20260807';

// Quick one-tap moods (sent to the same endpoint as typed text). A mix of
// feelings and activity-moods so "how you feel" is obvious at a glance.
const VIBES = ['Happy', 'Sad', 'Angry', 'Chill', 'Competitive', 'Brainy', 'Silly', 'Romantic', 'Scary', 'Cars'];

// A recognizable "sparkles" mark (lucide-style) — the Vibe Finder's icon.
const SPARK = `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.94 14.06A2 2 0 0 0 8.5 12.6l-5.4-1.4a.5.5 0 0 1 0-.96l5.4-1.4A2 2 0 0 0 9.94 7.4l1.4-5.4a.5.5 0 0 1 .96 0l1.4 5.4a2 2 0 0 0 1.44 1.44l5.4 1.4a.5.5 0 0 1 0 .96l-5.4 1.4a2 2 0 0 0-1.44 1.44l-1.4 5.4a.5.5 0 0 1-.96 0z"/><path d="M19 3v3M20.5 4.5h-3M5 17v2M6 18H4"/></svg>`;

let modal, lastQuery = '', inFlight = null;

function injectStyles() {
  if (document.getElementById('vibe-css')) return;
  const s = document.createElement('style');
  s.id = 'vibe-css';
  s.textContent = `
  /* A clean accent chip docked on the right INSIDE the search bar. Fixed height,
     vertically centered, with a thin divider so it reads as a distinct action.
     min-width:0 on the input lets it shrink instead of shoving the chip out of
     the pill (the old version overflowed and looked broken on narrow screens). */
  .header-search input,#searchForm input{min-width:0}
  .header-search:has(.vibe-trigger){padding-right:5px}     /* breathing room at the rounded edge */
  .vibe-trigger{display:inline-flex;align-items:center;justify-content:center;gap:6px;
    flex:0 0 auto;align-self:center;cursor:pointer;border:0;position:relative;
    height:30px;padding:0 14px;margin-left:12px;
    background:linear-gradient(135deg,#ffd426,#f5c518);color:#241a00;
    border-radius:999px;font-size:12.5px;font-weight:700;font-family:inherit;line-height:1;letter-spacing:.01em;
    white-space:nowrap;box-shadow:0 2px 10px rgba(0,0,0,.45),inset 0 1px 0 rgba(255,255,255,.22);
    transition:filter .15s ease,box-shadow .15s ease,transform .1s ease}
  /* thin divider separating the chip from the input */
  .vibe-trigger::before{content:'';position:absolute;left:-7px;top:50%;transform:translateY(-50%);
    width:1px;height:18px;background:rgba(255,255,255,.16)}
  .vibe-trigger:hover{filter:brightness(1.08);box-shadow:0 5px 16px rgba(0,0,0,.6),inset 0 1px 0 rgba(255,255,255,.3)}
  .vibe-trigger:active{transform:translateY(1px)}
  .vibe-trigger:focus-visible{outline:2px solid #ffd426;outline-offset:2px}
  /* The icon inherits the LABEL's colour, not the accent. It was #ffd426 with a
     yellow glow — the same yellow as this button's own gradient background, so
     the sparkle was being drawn in the background colour and was invisible. That
     rule was written for an accent icon on a dark surface; this button is not one. */
  .vibe-trigger svg{width:14px;height:14px;flex:0 0 14px;color:var(--brand-ink,#241a00);
    animation:vibeSparkle 2.6s ease-in-out infinite}
  @keyframes vibeSparkle{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.82;transform:scale(1.14)}}
  /* On small screens collapse to a round icon-only button so it never crowds the input. */
  @media (max-width:760px){.vibe-trigger span{display:none}.vibe-trigger{padding:0;width:30px;gap:0;margin-left:8px}
    .vibe-trigger::before{display:none}}
  .vibe-back{position:fixed;inset:0;z-index:10001;background:rgba(4,7,18,.74);backdrop-filter:blur(6px);
    display:flex;align-items:flex-start;justify-content:center;padding:9vh 16px 16px;animation:vibeIn .18s ease both}
  /* The [hidden] attribute alone can't hide this — the display:flex above beats the
     UA [hidden]{display:none}. This explicit rule makes close() actually close it. */
  .vibe-back[hidden]{display:none!important}
  @keyframes vibeIn{from{opacity:0}to{opacity:1}}
  .vibe-card{width:min(680px,100%);background:#0e2247;border:1px solid rgba(255,255,255,.24);border-radius:18px;
    box-shadow:0 30px 80px rgba(0,0,0,.6);padding:20px;font-family:Inter,system-ui,sans-serif;max-height:82vh;display:flex;flex-direction:column}
  .vibe-head{display:flex;align-items:center;gap:9px;margin:0 0 4px}
  .vibe-head h2{margin:0;font-size:19px;color:#f7f4ff;display:flex;align-items:center;gap:8px}
  .vibe-head h2 svg{color:#ffd426}
  .vibe-card p.sub{margin:0 0 14px;font-size:12.5px;color:#c3b6ee}
  .vibe-close{margin-left:auto;cursor:pointer;background:transparent;border:0;color:#8aa2cf;font-size:24px;line-height:1}
  .vibe-form{display:flex;gap:8px}
  .vibe-form input{flex:1;padding:12px 14px;border-radius:12px;background:#0a1a38;border:1px solid rgba(255,255,255,.24);color:#f7f4ff;font-size:14px;outline:0}
  .vibe-form input:focus{border-color:rgba(255,212,38,.55)}
  .vibe-form button{cursor:pointer;border:0;border-radius:12px;padding:0 18px;font-size:14px;font-weight:800;color:#241a00;background:linear-gradient(135deg,#ffd426,#ffb800)}
  .vibe-form button:disabled{opacity:.6;cursor:default}
  .vibe-chips{display:flex;flex-wrap:wrap;gap:7px;margin:12px 0 2px}
  .vibe-chips button{cursor:pointer;border:1px solid rgba(255,255,255,.26);background:transparent;color:#cbd9f4;border-radius:999px;padding:6px 12px;font-size:12px;font-weight:600}
  .vibe-chips button:hover{border-color:rgba(255,212,38,.5);color:#fff}
  .vibe-kw{font-size:11.5px;color:#7f96c2;margin:10px 0 0;min-height:14px}
  .vibe-kw b{color:#c3b6ee;font-weight:600}
  .vibe-pers{color:#ffd426;font-weight:600}
  /* The per-tile reason. Deliberately quiet — it explains the pick without
     competing with the game's own title for attention. */
  .vibe-tile{position:relative}
  .vt-why{position:absolute;top:6px;left:6px;background:rgba(4,7,18,.82);color:#c3b6ee;
    font-size:9.5px;font-weight:700;letter-spacing:.02em;text-transform:uppercase;
    padding:3px 6px;border-radius:6px;backdrop-filter:blur(3px);pointer-events:none;
    max-width:calc(100% - 12px);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .vibe-results{margin-top:10px;overflow:auto;display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:10px}
  .vibe-tile{display:block;text-decoration:none;border-radius:12px;overflow:hidden;background:#0a1a38;border:1px solid rgba(255,255,255,.16);transition:.12s}
  .vibe-tile:hover{border-color:rgba(255,212,38,.5);transform:translateY(-2px)}
  .vibe-tile .vt-img{width:100%;aspect-ratio:4/3;object-fit:cover;display:block;background:linear-gradient(135deg,#392a80,#241a55)}
  /* .game-tile-fallback is what the SHARED wireThumbFallback() swaps a dead
     image for. It is styled in catalog.css, which this overlay cannot count on
     being present (the Vibe Finder is self-contained and injects its own CSS),
     and which sizes it for the catalog grid rather than this 4/3 tile. Giving
     both selectors the same rule keeps a broken thumbnail looking identical to
     a missing one, on any page. */
  .vibe-tile .vt-fallback,
  .vibe-tile .game-tile-fallback{width:100%;aspect-ratio:4/3;display:grid;place-items:center;font-weight:800;font-size:20px;color:#f7f4ff;background:linear-gradient(135deg,#3a2a7a,#241a55)}
  .vibe-tile span{display:block;padding:7px 8px;font-size:11.5px;color:#c3b6ee;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .vibe-status{margin-top:16px;font-size:13px;color:#c3b6ee;text-align:center;padding:12px}
  .vibe-spin{display:inline-block;width:16px;height:16px;border:2px solid rgba(255,255,255,.18);border-top-color:#ffd426;border-radius:50%;animation:vibeSpin .8s linear infinite;vertical-align:-3px;margin-right:8px}
  @keyframes vibeSpin{to{transform:rotate(360deg)}}

  /* ── Skeletons ───────────────────────────────────────────────────────────
     Shown in place of the results grid while a search is in flight. They use
     the SAME grid and the same tile footprint as a real result, so the layout
     the player is looking at does not move when the answer arrives — the
     skeleton is the shape of the answer, not a placeholder box. */
  .vibe-skel{border-radius:10px;overflow:hidden;background:#1a1338;border:1px solid rgba(255,255,255,.06)}
  .vibe-skel i{display:block;width:100%;aspect-ratio:4/3;
    background:linear-gradient(100deg,#221a45 30%,#2e2460 50%,#221a45 70%);
    background-size:220% 100%;animation:vibeShim 1.15s ease-in-out infinite}
  .vibe-skel u{display:block;height:9px;margin:8px;border-radius:4px;background:#241c4c;text-decoration:none}
  @keyframes vibeShim{0%{background-position:120% 0}100%{background-position:-20% 0}}
  /* Respect a reduced-motion preference: the shimmer is decoration, and for
     some people it is a migraine trigger. The skeleton still communicates
     "loading" through its presence alone. */
  @media (prefers-reduced-motion:reduce){
    .vibe-skel i{animation:none}
    .vibe-spin{animation:none}
  }

  /* ── Result filters ──────────────────────────────────────────────────────
     Built from the categories actually present in the CURRENT result set, with
     live counts. Filtering happens in the browser over results already fetched:
     re-querying the server to narrow 18 results the player can already see
     would add a round trip and could change the ranking underneath them. */
  .vibe-filters{display:flex;flex-wrap:wrap;gap:6px;margin-top:12px}
  .vibe-filters:empty{display:none}
  .vibe-filters button{border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.04);
    color:#c3b6ee;border-radius:999px;padding:5px 11px;font-size:11.5px;font-weight:700;cursor:pointer;
    transition:background .14s ease,color .14s ease,border-color .14s ease}
  .vibe-filters button:hover{background:rgba(255,255,255,.09);color:#f3eeff}
  .vibe-filters button[aria-pressed="true"]{background:#ffd426;border-color:#ffd426;color:#1a1038}
  .vibe-filters .vf-count{opacity:.65;margin-left:5px;font-weight:600}

  /* ── Errors ──────────────────────────────────────────────────────────────
     An error is a state the player can act on, so it gets a retry control
     rather than a sentence telling them to try again themselves. */
  .vibe-err{display:flex;flex-direction:column;align-items:center;gap:10px}
  .vibe-err-msg{color:#ffb4b4}
  .vibe-retry{border:0;border-radius:999px;padding:9px 20px;font-weight:800;font-size:13px;
    cursor:pointer;background:#ffd426;color:#1a1038}
  .vibe-retry:hover{filter:brightness(1.06)}

  /* Results fade in rather than snapping, which also covers the one-frame gap
     between removing the skeletons and painting the tiles. */
  .vibe-results.is-fresh{animation:vibeIn .22s ease-out}
  @keyframes vibeIn{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}
  @media (prefers-reduced-motion:reduce){.vibe-results.is-fresh{animation:none}}
  @media (max-width:560px){.vibe-back{padding:5vh 10px 10px}}`;
  document.head.appendChild(s);
}

function tileFor(g) {
  const a = el('a', { class: 'vibe-tile', href: `/play/${g.slug}` });
  const safe = escapeHtml(g.title || '');
  const why = reasonFor(g);
  if (g.thumbnail) {
    // Two things were wrong here, and they compounded.
    //
    // 1. The broken-image handler was an inline `onerror=` attribute, which the
    //    site's CSP blocks outright (`script-src-attr 'none'`, from helmet's
    //    defaults — confirmed on the live response header). It could never run,
    //    so a dead thumbnail left the browser's broken-image icon on the tile
    //    permanently. Every other tile surface on the site already uses the
    //    shared wireThumbFallback() for exactly this reason; utils.js says so in
    //    a comment right above it.
    // 2. Even had it run, it only hid the image, leaving a labelled gap — while
    //    the no-thumbnail branch below renders a proper branded initials tile.
    //    The two failure paths disagreed about what a missing image looks like.
    //
    // buildFallback() reads data-title, so that attribute is load-bearing.
    a.innerHTML = `<img class="vt-img" loading="lazy" src="${escapeHtml(g.thumbnail)}" alt="${safe}" data-title="${safe}" /><span>${safe}</span>`;
    wireThumbFallback(a.querySelector('img'));
  } else {
    const initials = String(g.title || '?').split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase();
    a.innerHTML = `<div class="vt-fallback">${initials}</div><span>${safe}</span>`;
  }
  if (why) {
    const tag = el('span', { class: 'vt-why' });
    tag.textContent = why;
    a.appendChild(tag);
  }
  return a;
}

function setStatus(html) {
  const s = $('.vibe-status', modal);
  if (s) s.innerHTML = html || '';
}
// What the server understood, in the player's own vocabulary ("relaxing · about
// 10 min"), not the ranker's ("calm=0.92 session=10"). Showing this is the
// difference between a search that feels intelligent and one that feels random:
// when the results are surprising, you can see whether it misread you.
function setKw(understood, keywords, personalized) {
  const k = $('.vibe-kw', modal);
  if (!k) return;
  if (understood) {
    k.innerHTML = `Looking for: <b>${escapeHtml(understood)}</b>`
      + (personalized ? ' · <span class="vibe-pers">tuned to what you play</span>' : '');
  } else if (keywords && keywords.length) {
    k.innerHTML = `Matched genres: <b>${escapeHtml(keywords.slice(0, 8).join(', '))}</b>`;
  } else {
    k.innerHTML = '';
  }
}

// Per-tile explanation. Only ever states something the ranker actually used —
// `because.reasons` comes straight from the axes that scored the game, so a tile
// claiming "matches your vibe" really did match on an axis.
const REASON_LABEL = {
  calm: 'right mood', pace: 'right speed', brainy: 'brain-teaser',
  challenge: 'right difficulty', social: 'competitive', cozy: 'cute',
  session: 'fits your time', keyword: 'what you asked for',
};
function reasonFor(g) {
  const r = g && g.because && Array.isArray(g.because.reasons) ? g.because.reasons : [];
  for (const key of ['session', 'keyword', 'challenge', 'social', 'cozy', 'brainy', 'calm', 'pace']) {
    if (r.includes(key)) return REASON_LABEL[key];
  }
  return '';
}

// ── Result state ───────────────────────────────────────────────────────────
// The full result set as returned, plus the category filter applied over it.
// Kept at module scope so a filter click can re-render without re-querying.
let lastResults = [];
let activeFilter = null;

const CATEGORY_LABEL = (c) => String(c || 'arcade').replace(/[-_]+/g, ' ')
  .replace(/\b\w/g, m => m.toUpperCase());

/**
 * Skeleton tiles in the results grid.
 *
 * Deliberately the same count and footprint as a real page of results, so the
 * grid does not resize when the answer lands. A spinner alone gave no sense of
 * how much was coming, and the results appearing into an empty box made the
 * whole dialog jump.
 */
function renderSkeletons(n = 12) {
  const wrap = $('.vibe-results', modal);
  if (!wrap) return;
  wrap.setAttribute('aria-busy', 'true');
  wrap.classList.remove('is-fresh');
  wrap.innerHTML = '';
  for (let i = 0; i < n; i++) {
    const sk = el('div', { class: 'vibe-skel' });
    sk.innerHTML = '<i></i><u></u>';
    wrap.appendChild(sk);
  }
}

/**
 * Why the search failed, in terms the player can act on.
 *
 * The old handler had two outcomes — "took too long" or "something went wrong"
 * — and reached the second one for a 500, a 503, a dropped connection and a
 * malformed body alike. Worse, it never checked `response.ok` at all: an error
 * body was parsed as though it were a result, so a 500 rendered as "no matches"
 * and looked like a search that had worked and found nothing.
 */
function describeFailure({ aborted, status, kind }) {
  if (!navigator.onLine) {
    return { msg: 'You appear to be offline. Check your connection and try again.', retry: true };
  }
  if (aborted) {
    return { msg: 'That took too long to answer. The server may be waking up — try again.', retry: true };
  }
  if (status === 429) {
    return { msg: 'Too many searches just now. Give it a few seconds and try again.', retry: true };
  }
  if (status === 503) {
    return { msg: 'The server is busy or restarting. Try again in a moment.', retry: true };
  }
  if (status >= 500) {
    return { msg: `The server had a problem (error ${status}). Try again.`, retry: true };
  }
  if (status >= 400) {
    return { msg: `That search could not be processed (error ${status}).`, retry: false };
  }
  if (kind === 'parse') {
    return { msg: 'The server sent something unreadable. Try again.', retry: true };
  }
  return { msg: 'Something went wrong finding games. Try again.', retry: true };
}

/** An error state with a real retry control, not a sentence about retrying. */
function setError(failure, retryQuery) {
  const s = $('.vibe-status', modal);
  const wrap = $('.vibe-results', modal);
  if (wrap) { wrap.innerHTML = ''; wrap.removeAttribute('aria-busy'); }
  setFilters([]);
  if (!s) return;
  s.innerHTML = '';
  const box = el('div', { class: 'vibe-err' });
  const msg = el('div', { class: 'vibe-err-msg' });
  msg.textContent = failure.msg;
  box.appendChild(msg);
  if (failure.retry && retryQuery) {
    const btn = el('button', { class: 'vibe-retry', type: 'button' });
    btn.textContent = 'Try again';
    btn.addEventListener('click', () => runSearch(retryQuery));
    box.appendChild(btn);
  }
  s.appendChild(box);
}

/**
 * Category filter chips, built from the result set that is actually on screen.
 *
 * Only categories present in the results are offered, each with its real count,
 * so a chip can never lead to an empty grid — the commonest way a filter UI
 * wastes a click.
 */
function setFilters(games) {
  const bar = $('.vibe-filters', modal);
  if (!bar) return;
  bar.innerHTML = '';
  if (!games.length) return;

  const counts = new Map();
  for (const g of games) {
    const c = g.category || 'arcade';
    counts.set(c, (counts.get(c) || 0) + 1);
  }
  // One category means the filter can only ever be a no-op.
  if (counts.size < 2) return;

  const mk = (key, label, count) => {
    const b = el('button', { type: 'button' });
    b.setAttribute('aria-pressed', String(activeFilter === key));
    b.innerHTML = `${escapeHtml(label)}<span class="vf-count">${count}</span>`;
    b.addEventListener('click', () => {
      // Clicking the active chip clears it — the chip is a toggle, so "All" is
      // a shortcut rather than the only way back.
      activeFilter = (activeFilter === key) ? null : key;
      renderResults();
      setFilters(lastResults);
    });
    return b;
  };

  bar.appendChild(mk(null, 'All', games.length));
  for (const [cat, n] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
    bar.appendChild(mk(cat, CATEGORY_LABEL(cat), n));
  }
}

/** Paint `lastResults` through the active filter. */
function renderResults() {
  const wrap = $('.vibe-results', modal);
  if (!wrap) return;
  const shown = activeFilter
    ? lastResults.filter(g => (g.category || 'arcade') === activeFilter)
    : lastResults;
  wrap.removeAttribute('aria-busy');
  wrap.innerHTML = '';
  shown.forEach(g => wrap.appendChild(tileFor(g)));
  // Restart the entry animation on each paint.
  wrap.classList.remove('is-fresh');
  void wrap.offsetWidth;
  wrap.classList.add('is-fresh');
}

async function runSearch(text) {
  const q = (text || '').trim();
  if (!q) return;
  lastQuery = q;
  activeFilter = null;
  if (inFlight) { try { inFlight.abort(); } catch {} }
  const ctrl = new AbortController();
  inFlight = ctrl;
  // Hard cap so it can never hang on "finding…". 15s is generous enough to ride
  // out a sleeping/cold Render dyno (which can take 10s+ to wake) — the server
  // itself answers in well under 3s once awake.
  const timer = setTimeout(() => ctrl.abort(), 15000);
  const btn = $('.vibe-form button', modal);
  if (btn) btn.disabled = true;
  setKw('', [], false);
  setFilters([]);
  setStatus('<span class="vibe-spin"></span>Finding games that match your vibe…');
  renderSkeletons();

  let status = 0;
  try {
    // POST when there is something to personalize with, GET otherwise. The GET
    // path stays anonymous AND server-cacheable, which is what keeps the quick
    // mood chips instant for first-time visitors — the majority of uses.
    const personalize = hasSignal();
    const r = personalize
      ? await fetch('/api/vibe', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ q, ...personalizationPayload() }),
          signal: ctrl.signal,
        })
      : await fetch(`/api/vibe?q=${encodeURIComponent(q)}`, { signal: ctrl.signal });
    clearTimeout(timer);
    status = r.status;
    if (q !== lastQuery) return;                         // a newer search superseded this one

    // Check the STATUS before the body. Without this an error page was parsed
    // as a result and rendered as "no matches".
    if (!r.ok) { setError(describeFailure({ status }), q); return; }

    let d;
    try { d = await r.json(); }
    catch { setError(describeFailure({ kind: 'parse' }), q); return; }
    if (q !== lastQuery) return;

    // Every field is guaranteed present by the server-side contract
    // (lib/vibe-engine.mjs → vibeResponse), so this reads them directly rather
    // than defending against absence. It still guards the ARRAY, because a
    // proxy or captive portal can return a 200 that is not our JSON at all.
    lastResults = Array.isArray(d.games) ? d.games : [];
    setKw(d.understood, d.keywords, d.personalized);
    // Remember the mood so the homepage feed can lean this way for a while.
    // Expires on its own (signals.js, VIBE_TTL_MS) — a mood is a state, not a
    // standing preference.
    vibeSignal.set(q);

    if (!lastResults.length) {
      $('.vibe-results', modal).removeAttribute('aria-busy');
      $('.vibe-results', modal).innerHTML = '';
      setStatus('No matches — try a different vibe or tap a quick mood above.');
      return;
    }
    setStatus('');
    renderResults();
    setFilters(lastResults);
  } catch (e) {
    clearTimeout(timer);
    if (q !== lastQuery) return;
    setError(describeFailure({ aborted: ctrl.signal.aborted, status }), q);
  } finally {
    if (btn) btn.disabled = false;
    if (inFlight === ctrl) inFlight = null;
  }
}

function buildModal() {
  if (modal) return modal;
  injectStyles();
  modal = el('div', { class: 'vibe-back', id: 'vibeFinder', hidden: true });
  modal.innerHTML = `
    <div class="vibe-card" role="dialog" aria-label="Vibe Finder">
      <div class="vibe-head">
        <h2>${SPARK} Vibe Finder</h2>
        <button class="vibe-close" aria-label="Close">&times;</button>
      </div>
      <p class="sub">Tell me how you feel and I'll pick games from all ${'14,000+'} on ZoFHub. Powered by ZoFHub AI.</p>
      <form class="vibe-form">
        <input type="text" placeholder="e.g. something chill to relax after school…" aria-label="Describe your vibe" autocomplete="off" />
        <button type="submit">Find</button>
      </form>
      <div class="vibe-chips">${VIBES.map(v => `<button type="button" data-vibe="${v}">${v}</button>`).join('')}</div>
      <div class="vibe-kw"></div>
      <div class="vibe-filters" role="group" aria-label="Filter results by category"></div>
      <div class="vibe-status" role="status" aria-live="polite">Type a vibe above, or tap a quick mood.</div>
      <div class="vibe-results"></div>
    </div>`;
  document.body.appendChild(modal);
  modal.addEventListener('click', (e) => { if (e.target === modal || e.target.closest('.vibe-close')) close(); });
  $('.vibe-form', modal).addEventListener('submit', (e) => { e.preventDefault(); runSearch($('.vibe-form input', modal).value); });
  modal.querySelectorAll('.vibe-chips button').forEach(b => b.addEventListener('click', () => {
    const input = $('.vibe-form input', modal);
    input.value = b.dataset.vibe;
    runSearch(b.dataset.vibe);
  }));
  return modal;
}

let releaseFocus = null;
function open() {
  buildModal();
  modal.hidden = false;
  // trapFocus also does the initial focus (deferred, so the unhide above has
  // landed first) — keyboard users can now reach the close button and the mood
  // chips without Tab wandering into the catalog behind the dialog.
  releaseFocus = trapFocus(modal, { initial: '.vibe-form input' });
}
function close() {
  if (modal) modal.hidden = true;
  releaseFocus?.(); releaseFocus = null;
}

function mountTrigger() {
  if ($('.vibe-trigger')) return;
  const form = $('#searchForm') || document.querySelector('.header-search');
  if (!form) return;
  // Inject the styles NOW (at mount), not lazily on first click. Previously the
  // CSS only loaded inside buildModal()→open(), so until you clicked it the
  // button rendered as a raw unstyled <button> — that's why it "looked no good".
  injectStyles();
  const btn = el('button', { class: 'vibe-trigger', type: 'button', title: 'Vibe Finder — describe your mood, get a game (Ctrl+K)' });
  btn.innerHTML = `${SPARK}<span>Vibe Finder</span>`;
  btn.addEventListener('click', open);
  // Place it as a trailing pill INSIDE the search bar (not crammed between the
  // bar and the nav, which looked broken on smaller screens).
  form.appendChild(btn);
}

// Ctrl/Cmd+K opens it from anywhere.
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.code === 'KeyK')) {
    e.preventDefault();
    modal && !modal.hidden ? close() : open();
  } else if (e.key === 'Escape' && modal && !modal.hidden) {
    close();
  }
});

if (document.readyState !== 'loading') mountTrigger();
else document.addEventListener('DOMContentLoaded', mountTrigger);
