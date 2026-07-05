// ZoFHub · layout.js — small shared behaviors (search shortcut, active link, live-total in header)
import { $ } from './utils.js';
import { presence, fmtCount, paintCount } from './presence.js';
import { getPlayerName } from './identity.js';
// Floating AI game-helper orb (auto-skips on the /ai page).
import './ai-helper.js?v=20260713';
// Cookie-consent notice (shows once, site-wide; complements Google's CMP).
import './consent.js?v=20260713';
// NB: ads.js is loaded LATER (bottom of this file) — after /api/site-config so the
// AdSense publisher id can come from the environment per-deployment, and so the
// proxy domain (no AdSense) and the hub domain (AdSense on) share ONE codebase.

// ── Self-heal stale service workers ────────────────────────────────────────
// A legacy / root-scoped service worker left over from an earlier build can
// silently hijack requests (e.g. /api/games → "failed to load catalog") and
// keep serving old assets no matter how many times you refresh. On the main
// site we unregister ONLY a worker that controls the site ROOT and clear its
// caches; the proxy workers (/uv/service/, /scram/service/) are left intact.
(function killStaleServiceWorker() {
  try {
    if (!('serviceWorker' in navigator)) return;
    if (/^\/(uv|scram|gust|epoxy|baremux)\//.test(location.pathname)) return; // proxy areas: leave alone
    navigator.serviceWorker.getRegistrations().then(regs => {
      for (const r of regs) {
        if (r.scope === location.origin + '/') {        // only a ROOT-scoped worker
          r.unregister();
          if (window.caches?.keys) caches.keys().then(ks => ks.forEach(k => caches.delete(k)));
          console.warn('[zofhub] removed a stale root service worker + caches — reload to finish cleanup.');
        }
      }
    }).catch(() => {});
  } catch { /* never let cleanup break the page */ }
})();

function focusSearchShortcut(e) {
  if (e.key !== '/') return;
  if (e.target.matches('input, textarea, select, [contenteditable]')) return;
  const input = $('#searchInput') || $('.header-search input');
  if (input) { e.preventDefault(); input.focus(); }
}
document.addEventListener('keydown', focusSearchShortcut);

// Highlight the current top-nav link.
const path = location.pathname;
document.querySelectorAll('.top-nav a').forEach(a => {
  const href = a.getAttribute('href');
  if (href === path || (path.startsWith('/play') && href === '/')) a.classList.add('active');
});

// Inject the live-online pill into the header on every page.  It sits between
// the brand and the search box on desktop, and collapses to a dot on mobile.
function mountLiveTotal() {
  const header = document.querySelector('.header-inner');
  if (!header || header.querySelector('.live-total')) return;
  const pill = document.createElement('div');
  pill.className = 'live-total';
  pill.setAttribute('aria-label', 'Players online right now');
  pill.innerHTML = `
    <span class="live-dot" aria-hidden="true"></span>
    <span class="live-total-num">—</span>
    <span class="live-total-label">online</span>`;
  // Try to insert right after the brand for a left-leaning layout.
  const brand = header.querySelector('.brand');
  if (brand && brand.nextSibling) header.insertBefore(pill, brand.nextSibling);
  else header.appendChild(pill);

  const numEl = pill.querySelector('.live-total-num');
  presence.subscribe(snap => {
    const v = snap?.total || 0;
    paintCount(numEl, v);
    pill.classList.toggle('is-zero', v === 0);
  });
}
mountLiveTotal();

// ════════════════════════════════════════════════════════════════════════
// Social links — Discord + GitHub only.
// Icons served from /assets/social/ (discord.svg + github.svg, both white so they
// read on the dark bar). If you later drop in a branded discord_icon.png, point
// `icon` at it and set `fallback` to the SVG — the <img> onerror swaps once.
// 👉 TODO: paste your Discord invite URL into the Discord `href` below once the
//    server exists (replace the YOUR-INVITE placeholder).
// ════════════════════════════════════════════════════════════════════════
const SOCIALS = [
  { name: 'Discord', href: 'https://discord.gg/YOUR-INVITE', icon: '/assets/social/discord.svg?v=20260713' },
  { name: 'GitHub',  href: 'https://github.com/ZSM1010/ZoFHub-Gaming-AI-Browser-Hub', icon: '/assets/social/github.svg' },
];
// Shared builder for a row of social icon links (reused by header + footer).
function buildSocialCluster(className, size = 20) {
  const wrap = document.createElement('div');
  wrap.className = className;
  for (const s of SOCIALS) {
    const a = document.createElement('a');
    a.href = s.href; a.target = '_blank'; a.rel = 'noopener noreferrer';
    a.setAttribute('aria-label', s.name); a.title = s.name;
    const img = document.createElement('img');
    img.src = s.icon; img.alt = s.name;
    img.width = size; img.height = size; img.loading = 'lazy'; img.decoding = 'async';
    // If the primary icon (e.g. discord_icon.png before it's added) 404s, swap to the bundled fallback once.
    if (s.fallback) img.onerror = () => { img.onerror = null; img.src = s.fallback; };
    a.appendChild(img);
    wrap.appendChild(a);
  }
  return wrap;
}

// ════════════════════════════════════════════════════════════════════════
// Full multi-column footer (brand · Play · Explore · Project · social · legal).
// Built once here so all pages share one professional footer — the HTML files
// only need an empty <footer class="site-footer">.
// ════════════════════════════════════════════════════════════════════════
function mountFooter() {
  const footer = document.querySelector('.site-footer');
  if (!footer || footer.dataset.enhanced) return;
  footer.dataset.enhanced = '1';
  const year = new Date().getFullYear();
  const REPO = 'https://github.com/ZSM1010/ZoFHub-Gaming-AI-Browser-Hub';
  footer.innerHTML = `
    <div class="footer-main">
      <div class="footer-brand">
        <a class="footer-logo" href="/">
          <img src="/assets/favicon.png" alt="ZoFHub" width="36" height="36" decoding="async" />
          <span>ZoFHub</span>
        </a>
        <p class="footer-tagline">Instant browser games, a free AI assistant, and a smart proxy browser — all in one hub. No downloads, no sign-up.</p>
      </div>
      <nav class="footer-col" aria-label="Play">
        <h4>Play</h4>
        <a href="/">All games</a>
        <a href="/category/arcade">Arcade</a>
        <a href="/category/racing">Racing</a>
        <a href="/category/shooting">Shooting</a>
        <a href="/category/puzzle">Puzzle</a>
      </nav>
      <nav class="footer-col" aria-label="Explore">
        <h4>Explore</h4>
        <a href="/ai">AI Assistant</a>
        <a href="/community">Community</a>
        <a href="/leaderboard">Leaderboard</a>
        <a href="/browser">Proxy Browser</a>
        <a href="/api/health" target="_blank" rel="noopener">Status</a>
      </nav>
      <nav class="footer-col" aria-label="Project">
        <h4>Project</h4>
        <a href="${REPO}" target="_blank" rel="noopener">GitHub</a>
        <a href="${REPO}/blob/main/README.md" target="_blank" rel="noopener">About</a>
        <a href="${REPO}/blob/main/LICENSE" target="_blank" rel="noopener">License</a>
      </nav>
      <nav class="footer-col" aria-label="Legal">
        <h4>Legal</h4>
        <a href="/privacy">Privacy Policy</a>
        <a href="/terms">Terms of Service</a>
        <a href="/cookies">Cookie Policy</a>
        <a href="/dmca">DMCA / Copyright</a>
      </nav>
    </div>
    <div class="footer-bottom">
      <span class="footer-copy">© ${year} ZoFHub · Personal &amp; non-commercial use only.</span>
    </div>`;
  // Social cluster sits under the brand blurb; bottom bar gets a mirror on desktop.
  footer.querySelector('.footer-brand')?.appendChild(buildSocialCluster('footer-social'));
  footer.querySelector('.footer-bottom')?.appendChild(buildSocialCluster('footer-social footer-social-mini', 18));
}
mountFooter();

// Header social cluster — the PRIMARY, always-visible spot (the sticky top bar),
// so visitors never have to scroll to the footer to find/follow us.
function mountHeaderSocial() {
  const header = document.querySelector('.header-inner');
  if (!header || header.querySelector('.header-social')) return;
  header.appendChild(buildSocialCluster('header-social', 18));
}
mountHeaderSocial();

// ════════════════════════════════════════════════════════════════════════
// Player identity chip — shows the visitor's auto-generated username in the top
// bar on EVERY page (this is the same name the leaderboard ranks you under).
// Sits on the right of the header; collapses to just the avatar on small screens.
// ════════════════════════════════════════════════════════════════════════
function mountHeaderUser() {
  const header = document.querySelector('.header-inner');
  if (!header || header.querySelector('.header-user')) return;
  let name = 'Player';
  try { name = getPlayerName() || 'Player'; } catch {}
  const initials = (name.match(/[A-Z]/g) || name.slice(0, 2).toUpperCase().split(''))
    .slice(0, 2).join('') || 'P';
  const chip = document.createElement('div');
  chip.className = 'header-user';
  chip.title = `You are ${name} — your leaderboard name`;
  chip.innerHTML = `<span class="header-user-av" aria-hidden="true"></span><span class="header-user-name"></span>`;
  chip.querySelector('.header-user-av').textContent = initials;
  chip.querySelector('.header-user-name').textContent = name;
  header.appendChild(chip);
}
mountHeaderUser();

// ════════════════════════════════════════════════════════════════════════
// Mobile navigation — a hamburger menu for ≤880px, where the desktop .top-nav
// is hidden. WITHOUT this, every phone and portrait tablet loses ALL site
// navigation (no way to reach AI / Community / Leaderboard / Browser). Built
// from a canonical link list so every page gets the same complete menu (some
// pages' desktop nav markup is missing links).
// ════════════════════════════════════════════════════════════════════════
const NAV_LINKS = [
  { label: 'Games',         href: '/' },
  { label: 'AI Assistant',  href: '/ai' },
  { label: 'Community',     href: '/community' },
  { label: 'Leaderboard',   href: '/leaderboard' },
  { label: 'Proxy Browser', href: '/browser' },
];
function mountMobileNav() {
  const header = document.querySelector('.header-inner');
  if (!header || document.querySelector('.nav-toggle')) return;

  const toggle = document.createElement('button');
  toggle.className = 'nav-toggle';
  toggle.type = 'button';
  toggle.setAttribute('aria-label', 'Open menu');
  toggle.setAttribute('aria-expanded', 'false');
  toggle.setAttribute('aria-controls', 'mobileNav');
  toggle.innerHTML = `
    <svg class="nav-toggle-open"  viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M4 7h16M4 12h16M4 17h16"/></svg>
    <svg class="nav-toggle-close" viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>`;
  header.appendChild(toggle);

  const backdrop = document.createElement('div');
  backdrop.className = 'mobile-nav-backdrop';

  const menu = document.createElement('nav');
  menu.className = 'mobile-nav';
  menu.id = 'mobileNav';
  menu.setAttribute('aria-label', 'Site');
  const here = location.pathname;
  menu.innerHTML = NAV_LINKS.map(l => {
    const active = l.href === here
      || (l.href === '/' && (here.startsWith('/play') || here.startsWith('/category')));
    return `<a href="${l.href}"${active ? ' class="active" aria-current="page"' : ''}>${l.label}</a>`;
  }).join('');
  menu.appendChild(buildSocialCluster('mobile-nav-social'));

  document.body.appendChild(backdrop);
  document.body.appendChild(menu);

  const setOpen = (open) => {
    menu.classList.toggle('open', open);
    backdrop.classList.toggle('show', open);
    toggle.classList.toggle('is-open', open);
    toggle.setAttribute('aria-expanded', String(open));
    toggle.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
    document.body.classList.toggle('nav-open', open);
  };
  toggle.addEventListener('click', () => setOpen(!menu.classList.contains('open')));
  backdrop.addEventListener('click', () => setOpen(false));
  menu.addEventListener('click', (e) => { if (e.target.closest('a')) setOpen(false); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') setOpen(false); });
  // If the viewport grows back to desktop (where the real .top-nav shows), reset.
  window.addEventListener('resize', () => { if (window.innerWidth > 880) setOpen(false); });
}
mountMobileNav();

// ════════════════════════════════════════════════════════════════════════
// Per-deployment config + deferred ads.
// ONE codebase serves both deployments via env vars (no code forks):
//   • Hub domain  (SITE_MODE=hub)  → proxy OFF, AdSense id from ADSENSE_CLIENT.
//   • Proxy domain (SITE_MODE=full)→ proxy ON, no AdSense.
// We fetch /api/site-config, then (a) on the hub strip the proxy links from the
// nav/footer/mobile-menu, (b) hand the env AdSense id to ads.js, then load ads.
// ════════════════════════════════════════════════════════════════════════
function removeProxyLinks() {
  document.querySelectorAll('a[href="/browser"], a[href="/proxy"], a[href^="/gust"], a[href^="/browser"]')
    .forEach(a => a.remove());
}
fetch('/api/site-config')
  .then(r => r.json())
  .then(cfg => {
    window.ZOFHUB_PROXY = cfg.proxy !== false;
    if (cfg.adsenseClient) window.ZOFHUB_ADSENSE = cfg.adsenseClient;
    if (!window.ZOFHUB_PROXY) removeProxyLinks();
  })
  .catch(() => { /* config unavailable → fall back to built-in defaults */ })
  .finally(() => { import('./ads.js?v=20260713'); });   // load ads AFTER the client id is set (versioned so the fix isn't cached)
