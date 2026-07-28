// ZoFHub · category-page.js
// Renders one paginated page of a single category.  DOM never holds more
// than PAGE_SIZE tiles — clicking "Next" replaces the grid.
import { $, el, fetchJson, escapeHtml, toast, wireThumbFallback } from './utils.js';
import { store } from './storage.js';
import { presence, fmtCount, paintCount } from './presence.js';

// Same live-badge wiring as catalog.js — a Map<slug, Set<el>> updated on
// each presence snapshot, with stale entries cleaned out lazily.
const liveBadges = new Map();
function trackBadge(slug, node) {
  if (!slug || !node) return;
  let set = liveBadges.get(slug);
  if (!set) { set = new Set(); liveBadges.set(slug, set); }
  set.add(node);
}
presence.subscribe(snap => {
  for (const [slug, set] of liveBadges) {
    const n = snap?.games?.[slug] || 0;
    for (const node of set) {
      if (!node.isConnected) { set.delete(node); continue; }
      if (n > 0) { paintCount(node, n, v => `${fmtCount(v)} playing`); node.classList.add('on'); }
      else node.classList.remove('on');
    }
    if (set.size === 0) liveBadges.delete(slug);
  }
});

const PAGE_SIZE = 60;
const slug  = window.ZOFHUB_CATEGORY?.slug;
const total = Number(window.ZOFHUB_CATEGORY?.total) || 0;

const params = new URLSearchParams(location.search);
const page = Math.max(1, parseInt(params.get('page') || '1', 10));
const offset = (page - 1) * PAGE_SIZE;
const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

// Per-visit shuffle seed. Use the one in the URL so paging Prev/Next keeps a
// CONSISTENT order (no repeats / gaps across pages); if there isn't one yet
// (fresh arrival at the category), mint a new one — so the order is ranked by
// popularity but different each time you enter the category, and per user. We
// carry it on every page link below. The server reads &seed= and shuffles.
const seed = (params.get('seed') || Math.random().toString(36).slice(2, 10))
  .replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40);

const lazyIO = new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (!e.isIntersecting) continue;
    const img = e.target;
    if (img.dataset.src) {
      // Reveal once decoded. Tiles start at opacity:0 (.game-tile img.lz in
      // catalog.css) and only become visible when the `img-in` class is added.
      // WITHOUT this the thumbnail loads but stays invisible — the bug that
      // made every category thumbnail disappear. Multiple triggers (load event,
      // cached `complete`, and a 2s safety timeout) guarantee it can never get
      // stuck hidden if a load event is ever missed.
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
  renderSidebar();
  renderSkeletons();
  try {
    const data = await fetchJson(`/api/games?category=${encodeURIComponent(slug)}&limit=${PAGE_SIZE}&offset=${offset}&seed=${seed}`);
    renderGrid(data.games || []);
    renderPagination();
  } catch (e) {
    console.error(e);
    toast('Failed to load games', 'err');
    $('#categoryGrid').innerHTML = '<div class="grid-empty">Could not load this category. <a href="/">Back home</a>.</div>';
  }
})();

async function renderSidebar() {
  const wrap = $('#categoryList');
  if (!wrap) return;
  try {
    const data = await fetchJson('/api/categories');
    wrap.innerHTML = '';
    const homeLink = el('a', { class: 'cat-item', href: '/', title: 'Home' });
    homeLink.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 11l9-8 9 8v10a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z"/></svg><span class="cat-label">Home</span>`;
    wrap.appendChild(homeLink);
    for (const c of (data.categories || [])) {
      if (c.id === 'all') continue;
      const active = c.id === slug;
      const item = el('a', {
        class: `cat-item${active ? ' active' : ''}`,
        href: `/category/${c.id}`,
        title: c.id
      });
      item.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="4"/></svg><span class="cat-label">${escapeHtml(c.label || c.id)}</span><span class="cat-count">${c.count}</span>`;
      wrap.appendChild(item);
    }
  } catch (e) { console.warn('sidebar:', e); }
}

function renderSkeletons() {
  const grid = $('#categoryGrid');
  if (!grid) return;
  grid.innerHTML = '';
  const n = Math.min(PAGE_SIZE, Math.max(0, total - offset));
  for (let i = 0; i < n; i++) grid.appendChild(el('div', { class: 'skel-tile' }));
}

function renderGrid(games) {
  const grid = $('#categoryGrid');
  if (!grid) return;
  grid.innerHTML = '';
  if (!games.length) {
    grid.innerHTML = '<div class="grid-empty">No games on this page.</div>';
    return;
  }
  const frag = document.createDocumentFragment();
  games.forEach(g => frag.appendChild(tile(g)));
  grid.appendChild(frag);
}

const PLAY_SVG = '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';

function tile(game) {
  const t = el('a', { class: 'game-tile', href: `/play/${game.slug}`, 'aria-label': `Play ${game.title}` });
  const fav = store.favorites.has(game.slug);
  const safe = escapeHtml(game.title);
  t.innerHTML = `
    ${game.thumbnail
        ? `<img class="lz" data-src="${escapeHtml(game.thumbnail)}" alt="${safe}" loading="lazy" decoding="async" data-title="${safe}" />`
        : fallbackHtml(game.title)}
    ${game.is_new ? '<span class="game-tile-badge new">New</span>' : ''}
    <span class="live-pill" data-live="${escapeHtml(game.slug)}"></span>
    <button class="game-tile-fav${fav ? ' on' : ''}" aria-label="${fav ? 'Unfavorite' : 'Favorite'}" data-action="fav">
      <svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor"><path d="M12 21s-7-4.6-7-11a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 6.4-7 11-7 11z"/></svg>
    </button>
    <div class="game-tile-play">${PLAY_SVG}</div>
    <span class="game-tile-label">${safe}</span>`;
  trackBadge(game.slug, t.querySelector('.live-pill'));
  t.querySelector('[data-action="fav"]').addEventListener('click', (e) => {
    e.preventDefault(); e.stopPropagation();
    const on = store.favorites.toggle(game.slug);
    e.currentTarget.classList.toggle('on', on);
    toast(on ? 'Added to favorites' : 'Removed from favorites', 'ok');
  });
  const img = t.querySelector('img.lz');
  if (img) { wireThumbFallback(img); lazyIO.observe(img); }
  return t;
}

function initials(t) {
  return (t || 'G').split(/\s+/).slice(0, 2).map(s => s[0] || '').join('').toUpperCase() || 'G';
}

// Deterministic two-color gradient per title — same palette as the homepage so
// fallback tiles look intentional and varied (never a plain blank box).
const FALLBACK_PALETTE = ['#3a2a7a','#442f8c','#33246b','#4a3596','#382874','#402d84','#2e2160','#4d38a0'];
function fallbackColors(title) {
  const t = title || 'Game';
  let h = 0;
  for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) >>> 0;
  return [FALLBACK_PALETTE[h % FALLBACK_PALETTE.length], FALLBACK_PALETTE[(h >> 8) % FALLBACK_PALETTE.length]];
}
function fallbackHtml(title) {
  const [c1, c2] = fallbackColors(title);
  return `<div class="game-tile-fallback" style="--c1:${c1};--c2:${c2}">${initials(title)}</div>`;
}

// (Broken-thumbnail fallback now handled by wireThumbFallback from utils.js.)

function renderPagination() {
  const wrap = $('#pagination');
  if (!wrap || totalPages <= 1) return;
  wrap.innerHTML = '';

  const link = (label, p, opts = {}) => {
    const a = el('a', {
      class: `page-btn${opts.active ? ' active' : ''}${opts.disabled ? ' disabled' : ''}`,
      href: opts.disabled ? '#' : `/category/${slug}?page=${p}&seed=${seed}`,
      'aria-label': opts.aria || `Page ${p}`,
      'aria-current': opts.active ? 'page' : null
    });
    a.innerHTML = label;
    if (opts.disabled) a.addEventListener('click', (e) => e.preventDefault());
    return a;
  };

  wrap.appendChild(link('‹ Prev', page - 1, { disabled: page === 1, aria: 'Previous page' }));

  // Compact page numbers: 1, …, p-1, p, p+1, …, last
  const pages = new Set([1, totalPages, page, page - 1, page + 1]);
  // Pad a little for short paginations
  for (let i = 2; i <= Math.min(totalPages - 1, 5); i++) pages.add(i);
  const sorted = [...pages].filter(p => p >= 1 && p <= totalPages).sort((a, b) => a - b);

  let last = 0;
  for (const p of sorted) {
    if (p - last > 1) wrap.appendChild(el('span', { class: 'page-gap' }, '…'));
    wrap.appendChild(link(String(p), p, { active: p === page }));
    last = p;
  }
  wrap.appendChild(link('Next ›', page + 1, { disabled: page === totalPages, aria: 'Next page' }));

  // Page indicator
  const info = el('span', { class: 'page-info' }, `Page ${page} of ${totalPages} · ${total} games`);
  wrap.appendChild(info);
}
