// ZoFHub · catalog.js
import { $, $$, el, debounce, fetchJson, toast, escapeHtml, buildFallback, wireThumbFallback } from './utils.js';
import { store } from './storage.js';
import { personalizationPayload, skips as skipSignal, searches as searchSignal } from './signals.js?v=20260807';
import { presence, fmtCount, paintCount } from './presence.js';
import { rankGames, suggestions, highlightTerms } from './search.js?v=20260727';

// Per-visit shuffle seed — minted FRESH on each page load, so the running order
// (ranked by popularity, but weighted-random) is different every time you open
// the site and different per user. Held in one const for this load so the
// first-page fetch and the background full-catalog fetch share ONE order (no
// dupes / gaps). The server reads &seed= and does the weighted shuffle.
const SEED = Math.random().toString(36).slice(2, 10);

// First page only — small + fast so the homepage paints almost immediately.
// 120 covers the Featured/Trending/New rows + the first 2 pages of "All".
// (Was 600 ≈ 237 KB; 120 ≈ 48 KB — ~5× less data before first paint.)
//
// MUST be declared above the init() IIFE below. It used to sit next to
// loadFirst(), further down the file, which put it in the temporal dead zone at
// the moment init() calls loadFirst(): that call happens during module
// evaluation, and `${INITIAL_LOAD}` is read synchronously before the first
// await. So EVERY page load threw "Cannot access 'INITIAL_LOAD' before
// initialization" on attempt 1 and only painted after the 400ms retry — the
// retry loop hid a guaranteed failure behind what looked like a flaky network.
const INITIAL_LOAD = 120;

// Per-slug live count badges on tiles.  We keep a Map<slug, Set<HTMLElement>>
// so when a snapshot arrives we update only the tiles currently rendered.
const liveBadges = new Map();

function trackBadge(slug, el) {
  if (!slug || !el) return;
  let set = liveBadges.get(slug);
  if (!set) { set = new Set(); liveBadges.set(slug, set); }
  set.add(el);
}

presence.subscribe(snap => {
  for (const [slug, set] of liveBadges) {
    // Number(...) || 0, not just || 0. `snap.games` arrives via JSON.parse, so
    // it carries Object.prototype: for a slug with nobody playing —
    // `constructor`, `toString`, and the real catalog game slugged
    // `constructor` — the lookup returns an inherited FUNCTION, which is truthy
    // and sails past `|| 0`. Number() maps that to NaN so the fallback fires.
    const n = Number(snap?.games?.[slug]) || 0;
    for (const el of set) {
      if (!el.isConnected) { set.delete(el); continue; }
      if (n > 0) {
        paintCount(el, n, v => `${fmtCount(v)} playing`);
        el.classList.add('on');
      } else {
        el.classList.remove('on');
      }
    }
    if (set.size === 0) liveBadges.delete(slug);
  }
});

// Sidebar nav.  Populated dynamically from /api/categories so it always
// matches the catalog the server is actually serving.  We render a small
// "static frame" first (Home / Featured / New) and hydrate the rest.
const STATIC_NAV = [
  { id: 'all',      name: 'All',      icon: 'grid',     href: '/' },
  { id: 'featured', name: 'Featured', icon: 'star',     href: '/?cat=featured' },
  { id: 'new',      name: 'New',      icon: 'sparkles', href: '/?cat=new' }
];
let NAV = STATIC_NAV.slice();

const PAGE_SIZE = 60;
const state = {
  category: 'all',
  q: '',
  page: 1,            // current page number (1-based)
  all: [],
  filtered: [],
  counts: { all: 0 }
};

// ── Popularity ranking ────────────────────────────────────────────────────
// Real play counts dominate when present; modest boosts (trending > featured >
// new) give a sensible order when play data is sparse or zero. Title tie-break
// keeps ordering deterministic across reloads.
// Used only by the "Popular now" row to surface the genuinely most-played games
// (real play counts from the server) — separate from this visit's main shuffle.
function popularityScore(g) {
  return (Number(g.plays) || 0)
    + (g.is_trending ? 500 : 0)
    + (g.is_featured ? 200 : 0)
    + (g.is_new ? 20 : 0);
}

// IntersectionObserver — lazy-load images smoothly.
const lazyIO = new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (!e.isIntersecting) continue;
    const img = e.target;
    if (img.dataset.src) {
      // Fade in once decoded. Multiple reveal triggers (load event, cached
      // `complete`, and a 2s safety timeout) guarantee an image can never get
      // stuck invisible if a load event is missed.
      const reveal = () => img.classList.add('img-in');
      img.addEventListener('load', reveal, { once: true });
      img.src = img.dataset.src;
      img.removeAttribute('data-src');
      if (img.complete) reveal();
      setTimeout(reveal, 2000);
    }
    lazyIO.unobserve(img);
  }
}, { rootMargin: '300px 0px' });

(async function init() {
  try {
    renderSidebar();
    renderSkeletons();
    hydrateUrlState();
    bindSearch();
    bindLoadMore();
    // Fast first paint: load only the first page, render, THEN stream the rest
    // in the background. The homepage is interactive in ~1 request instead of 12.
    await Promise.all([loadFirst(), loadCategoryNav()]);
    // NOTE: do NOT re-sort state.all — the server already returns it in the
    // per-visit popularity-weighted-random order. Re-sorting here would flatten
    // that back to alphabetical and kill the "different every visit" behavior.
    recomputeCounts();
    renderSidebar();        // re-render with counts
    renderFeatured();
    renderTrending();
    renderNew();
    renderRunners();
    renderFavoritesRow();
    renderForYouRow();
    renderRecentRow();
    applyFilter();
    // Defer the full-catalog background load until the browser is idle, so it
    // never competes with first paint (images, fonts, the visible grid). The
    // page is fully interactive on just the initial ~120 games; search + deep
    // pagination fill in once this completes a moment later.
    const startRest = () => { loadRest(); };
    if ('requestIdleCallback' in window) requestIdleCallback(startRest, { timeout: 3000 });
    else setTimeout(startRest, 1500);
  } catch (err) {
    // A real visible error beats a silently empty page.  Past bugs (duplicate
    // fmtCount declaration, etc.) used to whitescreen the catalog without any
    // feedback — this overlay surfaces them so we can fix instead of guess.
    console.error('[zofhub] catalog init failed:', err);
    const banner = document.createElement('div');
    banner.style.cssText = 'position:fixed;left:50%;top:80px;transform:translateX(-50%);z-index:9999;background:rgba(239,68,68,.96);color:#fff;padding:14px 18px;border-radius:10px;font:600 13.5px Inter,system-ui;max-width:640px;box-shadow:0 18px 48px rgba(0,0,0,.5)';
    banner.textContent = `Catalog failed to render — ${err?.message || err}. Check the JS console.`;
    document.body.appendChild(banner);
    setTimeout(() => banner.remove(), 15000);
  }
})();

async function loadCategoryNav() {
  try {
    const data = await fetchJson('/api/categories');
    const iconFor = id => ({
      racing:'car', arcade:'joystick', shooting:'target', action:'bolt',
      sports:'ball', puzzle:'puzzle', simulator:'cube', '2-player':'users',
      'io-games':'globe', clicker:'tap', casual:'smile', strategy:'chess',
      card:'puzzle', survival:'compass', adventure:'compass', sandbox:'cube',
      music:'star', horror:'bolt'
    })[id] || 'grid';
    const extra = (data.categories || [])
      .filter(c => c.id !== 'all')
      .map(c => ({ id: c.id, name: c.label || c.id, icon: iconFor(c.id), href: c.url, count: c.count }));
    NAV = STATIC_NAV.concat(extra);
  } catch (e) { console.warn('nav:', e); }
}

async function loadFirst() {
  state.all = [];
  let lastErr;
  // Retry a few times with backoff — a transient network/SW blip should never
  // leave the homepage empty. A stale service worker that 404s this request is
  // also cleaned up by the self-heal in layout.js (reload finishes the fix).
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const data = await fetchJson(`/api/games?limit=${INITIAL_LOAD}&offset=0&seed=${SEED}`);
      state.all.push(...(data.games || []));
      state.total = data.total ?? state.all.length;
      return;
    } catch (e) {
      lastErr = e;
      console.warn(`[zofhub] loadFirst attempt ${attempt}/3 failed:`, e?.message || e);
      if (attempt < 3) await new Promise(r => setTimeout(r, 400 * attempt));
    }
  }
  console.error('[zofhub] catalog load failed after retries:', lastErr);
  if (!state.all.length) {
    // Flag it so renderAll() can show a PERSISTENT error state. The toast alone
    // used to be the only signal, and it disappears after ~3s — after which the
    // page reads exactly like "no games matched your search", so a visitor who
    // looked away could not tell a broken site from an empty result.
    state.loadFailed = true;
    state.loadError = lastErr?.message || String(lastErr || 'network error');
    toast('Couldn’t load games — try a hard refresh (Ctrl+Shift+R).', 'err');
  }
}

// Re-run the initial load from the error state's Retry button.
async function retryLoad() {
  state.loadFailed = false;
  state.loadError = '';
  renderAll();                       // clears the error box while we retry
  await loadFirst();
  if (!state.loadFailed) {
    recomputeCounts();
    renderSidebar();
    renderFeatured(); renderTrending(); renderNew(); renderRunners(); renderCategoryRails();
    renderFavoritesRow(); renderForYouRow(); renderRecentRow();
    loadRest();
  }
  applyFilter();
}

// Stream the REST of the catalog in the background (after first paint) so
// search + deep browsing eventually cover every game, without blocking the
// initial render. The DOM never holds more than PAGE_SIZE tiles, so memory
// stays flat regardless of catalog size.
let restLoaded = false;
let restStarted = false;
async function loadRest() {
  if (restStarted) return;          // run once (idle trigger OR an early search)
  restStarted = true;
  const CHUNK = 1000;
  const HARD_CAP = 30000;
  let offset = state.all.length;
  const total = state.total || HARD_CAP;
  try {
    while (offset < total && offset < HARD_CAP) {
      const data = await fetchJson(`/api/games?limit=${CHUNK}&offset=${offset}&seed=${SEED}`);
      const got = data.games || [];
      if (!got.length) break;
      state.all.push(...got);
      offset += got.length;
      if (got.length < CHUNK) break;
    }
  } catch (e) { console.warn('[zofhub] background catalog load:', e); }
  restLoaded = true;
  // Full catalog is now in memory — keep the server's per-visit order as-is.
  recomputeCounts();
  renderSidebar();
  renderFeatured(); renderTrending(); renderNew(); renderRunners(); renderCategoryRails();
  renderForYouRow();   // now that the full catalog is loaded, recs can pull from every game
  // Re-run if the user is searching (so results now cover the FULL catalog, not
  // just the first 600) or is on the default all-games view. resetView=false
  // keeps however many games the user already expanded via "Load more".
  if (state.q || state.category === 'all') {
    applyFilter(false);
  } else {
    const count = $('#allRowCount');
    if (count && state.category === 'all' && !state.q) {
      count.textContent = `${state.all.length.toLocaleString()} games`;
    }
  }
}

function recomputeCounts() {
  // Null-prototype accumulator: `c` is keyed by a category string that comes
  // from catalog data, and on a plain object `c['constructor']` reads back the
  // Object constructor rather than undefined — so `(fn || 0) + 1` would
  // concatenate and the count would become "function Object() {…}1".
  const c = Object.assign(Object.create(null), { all: state.all.length });
  for (const g of state.all) c[g.category] = (c[g.category] || 0) + 1;
  c.featured = state.all.filter(g => g.is_featured).length;
  c.new      = state.all.filter(g => g.is_new).length;
  state.counts = c;
}

function hydrateUrlState() {
  const p = new URLSearchParams(location.search);
  if (p.get('q')) {
    state.q = p.get('q');
    // Recorded HERE rather than at the search box, because this is the point a
    // search actually produced results the visitor looked at. Keystroke-level
    // capture would store abandoned and mistyped queries too, which is both
    // noisier as a signal and more data than the feature needs.
    searchSignal.add(state.q);
  }
  if (p.get('cat')) state.category = p.get('cat');
  if (state.q) { const inp = $('#searchInput'); if (inp) inp.value = state.q; }
}

// ============ Sidebar ============
// Real categories link to /category/:slug (separate page, fresh DOM, paginated).
// The pseudo-filters (All / Featured / New) stay client-side on the homepage.
function renderSidebar() {
  const wrap = $('#categoryList');
  if (!wrap) return;
  wrap.innerHTML = '';
  for (const c of NAV) {
    const isPseudo = c.id === 'all' || c.id === 'featured' || c.id === 'new';
    const href = c.href || (isPseudo ? `/?cat=${c.id}` : `/category/${c.id}`);
    const item = el('a', {
      class: `cat-item${isPseudo && c.id === state.category ? ' active' : ''}`,
      href,
      dataset: { cat: c.id, pseudo: isPseudo ? '1' : '0' },
      title: c.name
    });
    const count = c.count != null ? c.count : state.counts[c.id];
    // c.name is the category LABEL from /api/categories — catalog data, so
    // untrusted. It was written raw; escaped like every other catalog field.
    item.innerHTML = `${icon(c.icon)}<span class="cat-label">${escapeHtml(c.name)}</span>${
      count != null ? `<span class="cat-count">${fmtCount(count)}</span>` : ''
    }`;
    // Pseudo-filters stay on the homepage; real categories navigate fresh.
    if (isPseudo) {
      item.addEventListener('click', (e) => {
        e.preventDefault();
        state.category = c.id; state.shown = 60;
        const url = new URL(location.href);
        url.searchParams.set('cat', c.id);
        history.replaceState({}, '', url);
        $$('.cat-item').forEach(x => x.classList.toggle('active', x.dataset.cat === c.id));
        applyFilter();
        $('#allRow')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    }
    wrap.appendChild(item);
  }
}
// fmtCount is imported from presence.js — no local re-declaration.

function icon(name) {
  const I = {
    grid:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>',
    star:    '<svg viewBox="0 0 24 24" fill="currentColor"><polygon points="12 2 15 9 22 10 17 15 18 22 12 19 6 22 7 15 2 10 9 9 12 2"/></svg>',
    sparkles:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5 5l2 2M17 17l2 2M5 19l2-2M17 7l2-2"/></svg>',
    users:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="9" cy="8" r="3"/><path d="M3 21c0-3 3-5 6-5s6 2 6 5"/><circle cx="17" cy="9" r="2.5"/><path d="M14 21c0-2 2-3.5 4.5-3.5S23 19 23 21"/></svg>',
    globe:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/></svg>',
    bolt:    '<svg viewBox="0 0 24 24" fill="currentColor"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>',
    target:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.5" fill="currentColor"/></svg>',
    car:     '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 13l2-5h14l2 5v6h-3v-2H6v2H3z"/><circle cx="7" cy="17" r="1.5"/><circle cx="17" cy="17" r="1.5"/></svg>',
    puzzle:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 3h4v3a2 2 0 0 0 4 0v0h3v4h-3a2 2 0 0 0 0 4h3v4h-4v-3a2 2 0 0 0-4 0v3H6v-3a2 2 0 0 0 0-4H3v-4h3a2 2 0 0 0 0-4H6V3h4"/></svg>',
    joystick:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="7" r="4"/><path d="M12 11v6M8 22h8"/></svg>',
    compass: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><polygon points="16 8 10 10 8 16 14 14 16 8"/></svg>',
    ball:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3v18M5 6c4 3 10 3 14 0M5 18c4-3 10-3 14 0"/></svg>',
    smile:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><circle cx="9" cy="10" r="1" fill="currentColor"/><circle cx="15" cy="10" r="1" fill="currentColor"/></svg>',
    tap:     '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 12V6a2 2 0 1 1 4 0v6"/><path d="M13 9a2 2 0 0 1 4 0v6a5 5 0 0 1-10 0v-4"/></svg>',
    chess:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M7 3h10v4l-3 2v6l3 2v4H7v-4l3-2V9L7 7z"/></svg>',
    heart:   '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 21s-7-4.6-7-11a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 6.4-7 11-7 11z"/></svg>',
    cube:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3l9 5v8l-9 5-9-5V8z"/><path d="M12 3v18M3 8l9 5 9-5"/></svg>'
  };
  return I[name] || I.grid;
}

// ============ Skeletons (first paint) ============
function renderSkeletons() {
  const hero = $('#heroGrid');
  if (hero && !hero.children.length) {
    for (let i = 0; i < 6; i++) hero.appendChild(el('div', { class: 'skel-hero' }));
  }
  for (const id of ['trendingGrid', 'newGrid', 'allGrid']) {
    const g = document.getElementById(id);
    if (g && !g.children.length) {
      for (let i = 0; i < 12; i++) g.appendChild(el('div', { class: 'skel-tile' }));
    }
  }
}

// ============ Tiles ============
const PLAY_SVG = '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';

function tileFallbackHtml(title) {
  let h = 0;
  for (let i = 0; i < title.length; i++) h = (h * 31 + title.charCodeAt(i)) >>> 0;
  const palette = ['#3a2a7a','#442f8c','#33246b','#4a3596','#382874','#402d84','#2e2160','#4d38a0'];
  const c1 = palette[h % palette.length];
  const c2 = palette[(h >> 8) % palette.length];
  const initials = title.split(/\s+/).slice(0, 2).map(s => s[0] || '').join('').toUpperCase() || 'G';
  return `<div class="game-tile-fallback" style="--c1:${c1};--c2:${c2}">${initials}</div>`;
}

// buildFallback + wireThumbFallback are imported from utils.js (shared with the
// category, game, and search surfaces so every broken thumbnail degrades the
// same branded way).

// ── Skip detection ─────────────────────────────────────────────────────────
// A tile that was genuinely ON SCREEN and was not opened is a weak "no". The
// two thresholds are what keep it honest:
//
//   • 60% visible — a tile clipped at the fold was not really seen.
//   • 1.2 seconds — fast scrolling past a whole grid is not a judgement on
//     every tile in it. Without the dwell requirement, one flick to the bottom
//     of the page would register 200 skips and poison the profile outright.
//
// Opening a game retracts its skip (signals.js: skips.clear), so a game you
// scrolled past twice and then played is not suppressed.
let skipObserver = null;
const pendingSkips = new Map();       // slug -> timer id

function observeForSkips(root) {
  if (!('IntersectionObserver' in window)) return;   // older browsers just opt out
  if (!skipObserver) {
    skipObserver = new IntersectionObserver((entries) => {
      for (const e of entries) {
        const slug = e.target.dataset.slug;
        if (!slug) continue;
        if (e.isIntersecting) {
          if (pendingSkips.has(slug)) continue;
          pendingSkips.set(slug, setTimeout(() => {
            pendingSkips.delete(slug);
            skipSignal.add([slug]);
            skipObserver.unobserve(e.target);
          }, 1200));
        } else {
          const t = pendingSkips.get(slug);
          if (t) { clearTimeout(t); pendingSkips.delete(slug); }
        }
      }
    }, { threshold: 0.6 });
  }
  root.querySelectorAll('.game-tile[data-slug]').forEach(elm => skipObserver.observe(elm));
}

function tile(game, opts = {}) {
  const t = el('a', {
    class: 'game-tile',
    href: `/play/${game.slug}`,
    'data-slug': game.slug,
    'aria-label': `Play ${game.title}`
  });
  const fav = store.favorites.has(game.slug);
  const safe = escapeHtml(game.title);
  // When searching, highlight the matched part of the title in the tile label.
  const labelHtml = opts.highlight ? highlightTerms(game.title, opts.highlight) : safe;
  const badge = opts.badge
    ? `<span class="game-tile-badge ${opts.badge.kind || ''}">${opts.badge.label}</span>`
    : (game.is_new ? '<span class="game-tile-badge new">New</span>' : '');
  t.innerHTML = `
    ${game.thumbnail
        ? `<img class="lz" data-src="${escapeHtml(game.thumbnail)}" alt="${safe}" loading="lazy" decoding="async" data-title="${safe}" />`
        : tileFallbackHtml(game.title)}
    ${badge}
    <span class="live-pill" data-live="${escapeHtml(game.slug)}"></span>
    <button class="game-tile-fav${fav ? ' on' : ''}" aria-label="${fav ? 'Unfavorite' : 'Favorite'}" data-action="fav">
      <svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor"><path d="M12 21s-7-4.6-7-11a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 6.4-7 11-7 11z"/></svg>
    </button>
    <div class="game-tile-play">${PLAY_SVG}</div>
    <span class="game-tile-label">${labelHtml}</span>`;
  trackBadge(game.slug, t.querySelector('.live-pill'));
  t.querySelector('[data-action="fav"]').addEventListener('click', (e) => {
    e.preventDefault(); e.stopPropagation();
    const on = store.favorites.toggle(game.slug);
    e.currentTarget.classList.toggle('on', on);
    e.currentTarget.setAttribute('aria-label', on ? 'Unfavorite' : 'Favorite');
    toast(on ? 'Added to favorites' : 'Removed from favorites', 'ok');
    renderFavoritesRow();
  });
  const img = t.querySelector('img.lz');
  if (img) { wireThumbFallback(img); lazyIO.observe(img); }
  return t;
}

// ============ Featured (horizontal carousel) ============
function renderFeatured() {
  const grid = $('#heroGrid'); if (!grid) return;
  let list = state.all.filter(g => g.is_featured).slice(0, 12);
  // Pad up to 12 with non-featured games. MUST exclude what's already in `list`:
  // featured games get a popularity bump server-side, so they sort toward the
  // front of state.all — a naive slice(0, N) would re-add the very games we just
  // picked and show them twice in the carousel.
  if (list.length < 12) {
    const seen = new Set(list.map(g => g.slug));
    for (const g of state.all) {
      if (list.length >= 12) break;
      if (seen.has(g.slug)) continue;
      seen.add(g.slug);
      list.push(g);
    }
  }
  const frag = document.createDocumentFragment();
  list.forEach(g => {
    const t = el('a', { class: 'hero-tile', href: `/play/${g.slug}`, 'aria-label': `Play ${g.title}` });
    const safe = escapeHtml(g.title);
    t.innerHTML = `
      ${g.thumbnail
          ? `<img class="lz" loading="eager" data-src="${escapeHtml(g.thumbnail)}" alt="${safe}" data-title="${safe}" />`
          : tileFallbackHtml(g.title)}
      <span class="hero-tile-badge">Featured</span>
      <div class="hero-tile-play"><svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><path d="M8 5v14l11-7z"/></svg></div>
      <span class="hero-tile-label">${safe}</span>`;
    const img = t.querySelector('img.lz');
    if (img) { wireThumbFallback(img); img.src = img.dataset.src; img.removeAttribute('data-src'); }   // hero loads eagerly
    frag.appendChild(t);
  });
  grid.innerHTML = '';
  grid.appendChild(frag);
}

function renderTrending() {
  const grid = $('#trendingGrid'); if (!grid) return;
  // "Popular now" — the genuinely most-played games (by real play count),
  // independent of this visit's shuffle. When counts are all 0 (cold start)
  // this just keeps the current order, so the row is never empty.
  const top = [...state.all].sort((a, b) => popularityScore(b) - popularityScore(a)).slice(0, 18);
  paintGrid(grid, top);
}
function renderNew() {
  const row = $('#newRow'), grid = $('#newGrid'); if (!grid) return;
  const items = state.all.filter(g => g.is_new).slice(0, 18);
  // Hide the whole section if there are no "new" games — never show an empty
  // heading with a blank grid under it.
  if (row) row.hidden = items.length === 0;
  paintGrid(grid, items, { badge: { kind: 'new', label: 'New' } });
}
// "Endless Runners" — the closest embeddable substitutes for Subway-Surfers-style
// games (Slope, Run Clash, Dash, Surfer, Parkour…). Title-matched from the live
// catalog; the row hides itself if fewer than 6 matches exist.
const RUNNER_RE = /\b(runner|running|run|dash|surfer|surfing|surf|slope|parkour|subway|sprint|endless|rush|temple)\b/i;
function renderRunners() {
  const row = $('#runnersRow'), grid = $('#runnersGrid'); if (!row || !grid) return;
  const items = state.all.filter(g => RUNNER_RE.test(g.title)).slice(0, 18);
  if (items.length < 6) { row.hidden = true; return; }
  row.hidden = false;
  paintGrid(grid, items);
}
function renderFavoritesRow() {
  const row = $('#favoritesRow'), grid = $('#favoritesGrid'); if (!row || !grid) return;
  const slugs = store.favorites.get();
  const items = slugs.map(s => state.all.find(g => g.slug === s)).filter(Boolean);
  if (!items.length) { row.hidden = true; return; }
  row.hidden = false;
  paintGrid(grid, items);
}
function renderRecentRow() {
  const row = $('#recentRow'), grid = $('#recentGrid'); if (!row || !grid) return;
  const hist = store.history.get();
  const items = hist.slice(0, 12).map(h => state.all.find(g => g.slug === h.id)).filter(Boolean);
  if (!items.length) { row.hidden = true; return; }
  row.hidden = false;
  paintGrid(grid, items);
}

// "Recommended for you" — personalized from THIS device's play history. Builds a
// category-affinity profile (recent plays weighted higher), then surfaces the
// most popular games you HAVEN'T played yet from the categories you play most.
// Stays hidden until there's enough history to be meaningful, and re-renders as
// the full catalog streams in (so the pool covers every game, not just page 1).
// Cached across re-renders. renderAll() runs again every time another chunk of
// the catalog streams in, and this must not fire a request each time.
let _forYou = { fetched: false, games: null, inflight: null };

/** Proper Fisher-Yates. `sort(() => Math.random() - .5)` — which this row used
 *  to use — is not a shuffle: the comparator is inconsistent, so the result is
 *  neither uniform nor stable across browsers. */
function shuffled(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * LOCAL fallback, used only when /api/for-you is unreachable.
 *
 * Same idea as the version this replaces — category affinity over play history
 * — with its two real bugs fixed:
 *   • weight was Math.max(1, 12 - i), which is FLAT past the 12th entry while
 *     history holds 80, so 68 stale plays could outvote the 12 recent ones.
 *     Now exponential, matching the server (RECENCY_DECAY).
 *   • `state.all.find()` inside the loop is O(n·m) — ~1M string compares on a
 *     12k catalog with 80 history entries, re-run on every catalog chunk. Now a
 *     single Map.
 */
function forYouLocal(histIds, favIds, limit) {
  const bySlug = new Map(state.all.map(g => [g.slug, g]));
  const played = new Set([...histIds, ...favIds]);
  const affinity = new Map();
  histIds.forEach((id, i) => {
    const g = bySlug.get(id);
    if (!g || !g.category) return;
    affinity.set(g.category, (affinity.get(g.category) || 0) + Math.pow(0.85, i));
  });
  for (const id of favIds) {
    const g = bySlug.get(id);
    if (g && g.category) affinity.set(g.category, (affinity.get(g.category) || 0) + 1.25);
  }
  if (!affinity.size) return [];
  const favCats = new Set([...affinity.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(e => e[0]));
  const pool = state.all
    .filter(g => favCats.has(g.category) && !played.has(g.slug) && g.thumbnail)
    .sort((a, b) => popularityScore(b) - popularityScore(a))
    .slice(0, 80);
  return shuffled(pool).slice(0, limit).map(g => ({ ...g, because: { kind: 'category', category: g.category } }));
}

/**
 * "Recommended for you".
 *
 * Asks the server, which ranks against a precomputed game-similarity index
 * (tools/build-recommendations.py) — that is what lets it say "because you
 * played Moto X3M" rather than just "you seem to like racing". Falls back to
 * local category affinity if the request fails, so the row still appears
 * offline or if the endpoint is down.
 *
 * Nothing is sent that the browser did not already have: the history and
 * favourites in localStorage, and nothing else. The server stores none of it.
 */
function renderForYouRow() {
  const row = $('#forYouRow'), grid = $('#forYouGrid');
  if (!row || !grid) return;

  const histIds = store.history.get().map(h => h.id).filter(Boolean);
  const favIds = store.favorites.get().filter(Boolean);
  if (histIds.length < 3 && favIds.length < 2) { row.hidden = true; return; }

  const paint = (games) => {
    if (!games || games.length < 6) { row.hidden = true; return; }
    // Resolve against the live client catalog so a game hidden since the index
    // was built never renders, and so tiles carry the same fields as every
    // other row (thumbnail, plays, favourite state).
    const bySlug = new Map(state.all.map(g => [g.slug, g]));
    const items = games
      .map(g => (bySlug.has(g.slug) ? { ...bySlug.get(g.slug), because: g.because } : null))
      .filter(Boolean);
    if (items.length < 6) { row.hidden = true; return; }
    row.hidden = false;
    paintGrid(grid, items);
    // Say WHY, using the strongest attributed pick. Honest attribution matters:
    // a row that claims a reason it cannot back up is worse than no reason —
    // so every branch below is backed by something the ranker actually did.
    const seed = items.find(g => g.because && g.because.kind === 'similar' && g.because.title);
    let sub = row.querySelector('.row-sub');
    const setSub = (text) => {
      if (!text) { sub?.remove(); return; }
      if (!sub) {
        sub = document.createElement('p');
        sub.className = 'row-sub';
        row.querySelector('.row-title')?.after(sub);
      }
      sub.textContent = text;
    };

    if (seed) {
      setSub(`Because you played ${seed.because.title}`);
    } else {
      // No single seed dominated. Fall back to the category the row leans on,
      // which is the honest description of a category-affinity ranking.
      const counts = new Map();
      for (const g of items) {
        if (g.category) counts.set(g.category, (counts.get(g.category) || 0) + 1);
      }
      const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
      setSub(top && top[1] >= 3
        ? `More ${top[0].replace(/-/g, ' ')} games, based on what you play`
        : 'Based on what you play');
    }
  };

  if (_forYou.fetched) { paint(_forYou.games); return; }
  if (_forYou.inflight) { _forYou.inflight.then(() => paint(_forYou.games)); return; }

  _forYou.inflight = fetch('/api/for-you', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    // personalizationPayload() is the single definition of what leaves the
    // browser — history, favourites, skipped slugs and the last mood typed.
    // See public/js/signals.js for exactly what each one is and why.
    body: JSON.stringify({ ...personalizationPayload(), limit: 18 }),
  })
    .then(r => (r.ok ? r.json() : null))
    .then(j => {
      _forYou.games = (j && Array.isArray(j.games) && j.games.length)
        ? j.games
        : forYouLocal(histIds, favIds, 18);
    })
    .catch(() => { _forYou.games = forYouLocal(histIds, favIds, 18); })
    .finally(() => { _forYou.fetched = true; _forYou.inflight = null; paint(_forYou.games); });
}

function paintGrid(grid, items, opts = {}) {
  const frag = document.createDocumentFragment();
  items.forEach((g, i) => {
    frag.appendChild(tile(g, opts));
    // In-feed ad every `adsEvery` tiles (used only for the big "All games" grid).
    // ads.js fills (or hides) these; the slot spans a full grid row.
    if (opts.adsEvery && (i + 1) % opts.adsEvery === 0 && i < items.length - 1) {
      const ad = document.createElement('div');
      ad.className = 'ad-slot ad-ingrid';
      ad.setAttribute('data-ad-type', 'leaderboard');
      frag.appendChild(ad);
    }
  });
  grid.innerHTML = '';
  grid.appendChild(frag);
  observeForSkips(grid);
}

// ============ Category rails ============
// The discovery problem, measured: of ~12,700 games in the catalog, 52 had ever
// been opened — 0.4% reach. The homepage surfaced roughly 90 games across its
// fixed rows and everything else sat behind "All games", which nobody scrolls.
//
// A rail per category turns 20 hidden sidebar links into ~240 visible games,
// each with a way through to the full paginated /category/:slug page. The
// categories shown rotate per visit, so a returning player meets a different
// slice instead of the same 90 tiles.

const RAIL_SIZE = 12;          // tiles per rail — one row on a wide screen
const RAIL_COUNT = 8;          // rails per visit; more than this and the page is a wall
const RAIL_MIN = 8;            // a category with fewer games than this looks broken as a rail

function railHead(name, href, count) {
  const head = el('div', { class: 'row-head' });
  head.innerHTML =
    `<h2 class="row-title">${escapeHtml(name)}</h2>` +
    `<a class="row-more" href="${href}">View all${count ? ` <span class="row-more-n">${fmtCount(count)}</span>` : ''}
       <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor"
            stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
         <path d="M5 12h13M13 6l6 6-6 6"/></svg></a>`;
  return head;
}

function renderCategoryRails() {
  const host = $('#categoryRails');
  if (!host) return;
  // Only ever built from what is already loaded, so a rail cannot show a game
  // the rest of the page has filtered out.
  const byCat = new Map();
  for (const g of state.all) {
    const c = (g.category || '').toLowerCase();
    if (!c) continue;
    if (!byCat.has(c)) byCat.set(c, []);
    byCat.get(c).push(g);
  }

  // Skip categories the fixed rows above already cover, or the same games
  // appear twice within one screen.
  const covered = new Set(['featured', 'new', 'all']);
  const eligible = [...byCat.entries()]
    .filter(([id, games]) => !covered.has(id) && games.length >= RAIL_MIN);
  if (!eligible.length) { host.innerHTML = ''; return; }

  const pick = shuffled(eligible).slice(0, RAIL_COUNT);
  const frag = document.createDocumentFragment();
  for (const [id, games] of pick) {
    const nav = NAV.find(c => c.id === id);
    const section = el('section', { class: 'row rail-row' });
    section.appendChild(railHead(nav?.name || id, `/category/${encodeURIComponent(id)}`, games.length));
    const grid = el('div', { class: 'game-grid' });
    // Shuffled, not "first N": taking the head of the list would show the same
    // tiles on every visit and defeat the point of the rail.
    paintGrid(grid, shuffled(games).slice(0, RAIL_SIZE));
    section.appendChild(grid);
    frag.appendChild(section);
  }
  host.innerHTML = '';
  host.appendChild(frag);
}

// ============ Filtering / "All games" ============
function applyFilter(resetView = true) {
  const q = state.q.trim();
  let list = state.all;
  if (state.category === 'featured')      list = list.filter(g => g.is_featured);
  else if (state.category === 'new')      list = list.filter(g => g.is_new);
  else if (state.category !== 'all')      list = list.filter(g => g.category === state.category || (g.platform || '').toLowerCase() === state.category);

  // Spotlight mode: a non-empty query hides the browse rows (see catalog.css)
  // and shows ONLY the ranked results, focused like a search-results page.
  const searching = q.length > 0;
  document.body.classList.toggle('is-searching', searching);
  state.searchQuery = '';
  state.searchFuzzy = false;

  // If the user searches/filters before the deferred full load has run, kick it
  // now so results cover the whole catalog (loadRest re-applies when it finishes).
  if (searching && !restLoaded) loadRest();

  if (searching) {
    // Fuzzy, typo-tolerant, relevance-ranked (search.js). If nothing scores,
    // fall back to "closest matches" so the user is never shown an empty page.
    let ranked = rankGames(list, q);
    if (ranked.length === 0) {
      ranked = suggestions(list, q, PAGE_SIZE * 3);
      state.searchFuzzy = ranked.length > 0;
    }
    list = ranked;
    state.searchQuery = q;
  }

  state.filtered = list;
  // A real filter change (search / category / favorites) collapses the grid back
  // to the first page. The background loadRest re-apply passes resetView=false so
  // it never yanks away games the user already expanded with "Load more".
  if (resetView) { state.shown = PAGE_SIZE; state.loadMoreClicks = 0; }
  renderAll();

  const title = $('#allRowTitle');
  if (title) {
    if (searching) title.textContent = state.searchFuzzy ? `Closest matches for “${q}”` : `Results for “${q}”`;
    else if (state.category !== 'all') {
      const cat = NAV.find(c => c.id === state.category);
      title.textContent = cat ? `${cat.name} games` : 'Games';
    } else title.textContent = 'All games';
  }
  const count = $('#allRowCount');
  if (count) count.textContent = `${state.filtered.length.toLocaleString()} ${state.filtered.length === 1 ? 'game' : 'games'}`;
}

function renderAll() {
  const grid = $('#allGrid'); const empty = $('#allEmpty');
  if (!grid) return;
  const total = state.filtered.length;
  if (!state.shown) state.shown = PAGE_SIZE;
  if (state.shown > total) state.shown = Math.max(PAGE_SIZE, total);
  const slice = state.filtered.slice(0, state.shown);
  // Pass the active query so matched text is highlighted in each tile label.
  paintGrid(grid, slice, { adsEvery: 12, highlight: state.searchQuery });
  if (empty) {
    if (slice.length > 0) { empty.hidden = true; empty.classList.remove('is-error'); }
    else if (state.loadFailed) {
      // Distinct from "no results": the catalog never arrived. Stays on screen
      // until it succeeds, and offers a way out that isn't a full page reload.
      empty.hidden = false;
      empty.classList.add('is-error');
      empty.innerHTML = `
        <strong>Couldn’t load the games.</strong>
        <span>This is a connection problem on our side, not an empty search —
              your filters are fine.</span>
        <button type="button" class="btn-primary btn-sm" id="catalogRetry">Try again</button>`;
      empty.querySelector('#catalogRetry')?.addEventListener('click', retryLoad, { once: true });
    } else {
      empty.hidden = false;
      empty.classList.remove('is-error');
      empty.innerHTML = state.searchQuery
        ? `No games match “${escapeHtml(state.q)}”. Try fewer or different words.`
        : 'No games match.';
    }
  }
  renderLoadMore(total);
}

// "Load more" appends the next PAGE_SIZE games to the grid (they don't replace
// what's there). It's HARD-CAPPED at MAX_SHOWN tiles so the DOM can never balloon
// to thousands of nodes and freeze the tab — that's ~5 taps from the first page.
// Past the cap we hide the button and point users at Search / categories, which
// cover the entire catalog without holding it all in the DOM at once.
const MAX_SHOWN = PAGE_SIZE * 6;   // 360 tiles = first page + 5 "Load more" taps
function renderLoadMore(total) {
  $('#homePagination')?.remove();          // remove any legacy numbered pager
  const btn = $('#loadMore');
  if (!btn) return;
  let hint = $('#loadMoreHint');
  if (!hint) {
    hint = el('div', { class: 'load-more-hint', id: 'loadMoreHint' });
    hint.hidden = true;
    btn.after(hint);
  }
  const cap = Math.min(total, MAX_SHOWN);
  if (state.shown < cap) {                  // more games can still fit in the grid
    btn.hidden = false;
    btn.textContent = `Load more (${Math.min(PAGE_SIZE, cap - state.shown)})`;
    hint.hidden = true;
  } else {
    btn.hidden = true;
    if (total > MAX_SHOWN) {                 // capped, but more games exist
      hint.hidden = false;
      hint.textContent = `Showing ${state.shown.toLocaleString()} of ${total.toLocaleString()} games — use Search or a category to find any specific game.`;
    } else {
      hint.hidden = true;                    // everything is already on screen
    }
  }
}

function bindLoadMore() {
  const btn = $('#loadMore');
  if (!btn) return;
  btn.hidden = true;
  btn.addEventListener('click', () => {
    const total = state.filtered.length;
    const cap = Math.min(total, MAX_SHOWN);
    if (state.shown >= cap) return;          // guard the hard cap
    state.shown = Math.min(state.shown + PAGE_SIZE, cap);
    state.loadMoreClicks = (state.loadMoreClicks || 0) + 1;
    renderAll();
  });
}

// ============ Search ============
function bindSearch() {
  const input = $('#searchInput');
  if (!input) return;
  // Typing is handled by the header typeahead dropdown (search-suggest.js) so
  // results no longer dump down the page on every keystroke. Submitting (Enter
  // with no suggestion chosen) still filters the full grid as a "see all" path.
  $('#searchForm')?.addEventListener('submit', (e) => {
    e.preventDefault();
    state.q = input.value;
    state.shown = 60;
    applyFilter();
    $('#allRow')?.scrollIntoView({ behavior: 'smooth' });
  });
}
