// ZoFHub · layout.js — small shared behaviors (search shortcut, active link, live-total in header)
import { $ } from './utils.js';
import { presence, fmtCount, paintCount } from './presence.js';
import { getPlayerName } from './identity.js';
// NB: the floating AI game-helper orb is NOT imported here — see mountAIStub()
// near the bottom of this file. It is loaded on demand.
// Cookie-consent notice (shows once, site-wide).
import './consent.js?v=20260729';
// NB: the proxy-friendly ad loaders (proxy-ads.js + footer-ad.js) are imported
// LATER (bottom of this file) — after /api/site-config resolves. No AdSense.

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
// Brand social links — ONLY pseudonymous brand accounts that point somewhere
// REAL. Never a GitHub link (private repo → 404s for visitors AND advertises
// the account — pure anonymity leak). Add future accounts here, e.g.:
//   { name: 'TikTok', href: 'https://www.tiktok.com/@zofhub', icon: '/assets/social/tiktok.svg' },
// ════════════════════════════════════════════════════════════════════════
const SOCIALS = [
  { name: 'Discord', href: 'https://discord.gg/SeMuMRG9gG', icon: '/assets/social/discord.svg' },
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
      <nav class="footer-col" aria-label="Legal">
        <h4>Legal</h4>
        <a href="/privacy">Privacy Policy</a>
        <a href="/terms">Terms of Service</a>
        <a href="/cookies">Cookie Policy</a>
        <a href="/dmca">DMCA / Copyright</a>
        <a href="/credits">Credits &amp; Licenses</a>
      </nav>
    </div>
    <div class="footer-bottom">
      <span class="footer-copy">© ${year} ZoFHub · Personal &amp; non-commercial use only.</span>
    </div>`;
  // Social cluster — only when there are REAL socials to show (no empty gaps).
  if (SOCIALS.length) {
    footer.querySelector('.footer-brand')?.appendChild(buildSocialCluster('footer-social'));
    footer.querySelector('.footer-bottom')?.appendChild(buildSocialCluster('footer-social footer-social-mini', 18));
  }
}
mountFooter();

// Header social cluster — the PRIMARY, always-visible spot (the sticky top bar),
// so visitors never have to scroll to the footer to find/follow us.
function mountHeaderSocial() {
  const header = document.querySelector('.header-inner');
  if (!header || !SOCIALS.length || header.querySelector('.header-social')) return;
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
// AI helper orb — placeholder now, real module on first click.
// ai-helper.js + pollinations.js are ~25KB, and they used to be a static
// import at the top of this file: every visitor on every page paid to fetch,
// parse and execute the whole AI assistant before layout.js could finish,
// including the large majority who never touch it. What they actually need up
// front is a button. So we render the button — same id, same classes, so
// main.css styles it identically — and fetch the real thing when it's clicked.
// ════════════════════════════════════════════════════════════════════════
function mountAIStub() {
  if (document.body.classList.contains('page-ai')) return;   // /ai IS the assistant
  if (document.getElementById('aiOrb') || document.getElementById('aiRestore')) return;

  // Respect a previously dismissed assistant: that visitor gets the small
  // restore chip instead of the orb, exactly as ai-helper.js would render it.
  let dismissed = false;
  try { dismissed = localStorage.getItem('zofhub_ai_hidden') === '1'; } catch {}
  const onGamePage = !!(window.ZOFHUB_GAME && window.ZOFHUB_GAME.slug);

  const stub = document.createElement('button');
  stub.type = 'button';
  if (dismissed) {
    stub.id = 'aiRestore';
    stub.className = 'ai-restore';
    stub.setAttribute('aria-label', 'Show AI assistant');
    stub.innerHTML = `<span class="ai-restore-dot" aria-hidden="true"></span>AI`;
  } else {
    stub.id = 'aiOrb';
    stub.className = 'ai-orb';
    stub.setAttribute('aria-label', onGamePage ? 'AI game tips' : 'Ask ZoFHub AI');
    stub.innerHTML = `
      <span class="ai-orb-ring" aria-hidden="true"></span>
      <span class="ai-orb-ring ai-orb-ring-2" aria-hidden="true"></span>
      <svg class="ai-orb-icon" viewBox="0 0 24 24" width="26" height="26" fill="currentColor" aria-hidden="true">
        <path d="M12 2.4l1.8 4.8 4.8 1.8-4.8 1.8L12 15.6l-1.8-4.8L5.4 9l4.8-1.8z"/>
        <path d="M18.3 13.4l.85 2.25 2.25.85-2.25.85-.85 2.25-.85-2.25-2.25-.85 2.25-.85z"/>
      </svg>`;
  }

  let booting = false;
  function boot() {
    if (booting) return;
    booting = true;
    stub.classList.add('is-loading');
    // Remove the stub BEFORE mounting — ai-helper.js bails out if #aiOrb
    // already exists, which is what stops it double-mounting normally.
    stub.remove();
    import('./ai-helper.js?v=20260729')
      .then(m => m.mountAIHelper(true))
      .catch(err => {
        // Put the button back so the failure is retryable rather than terminal.
        console.warn('[ai-orb] load failed:', err?.message || err);
        booting = false;
        stub.classList.remove('is-loading');
        document.body.appendChild(stub);
      });
  }

  stub.addEventListener('click', boot);
  document.body.appendChild(stub);

  // Game pages have a separate "AI Help" button above the frame. Once the real
  // module mounts it wires its own listener, so this one only covers the gap.
  document.getElementById('aiHelpBtn')?.addEventListener('click', boot, { once: true });

  // Same one-time attention nudge the real orb used to do on game pages.
  if (onGamePage && !dismissed) setTimeout(() => stub.classList.add('nudge'), 2500);
}
mountAIStub();

// ════════════════════════════════════════════════════════════════════════
// Proxy-friendly ads (loaded after config). ZoFHub is ALWAYS a proxy site and
// never loads Google AdSense. We fetch /api/site-config, then load the page-level
// ad scripts (PROXY_AD_SCRIPTS) and the isolated footer banner (PROXY_BANNER_TAG)
// — each only if configured, so the site stays clean until you set them.
// ════════════════════════════════════════════════════════════════════════
fetch('/api/site-config')
  .then(r => r.json())
  .then(cfg => {
    window.ZOFHUB_PROXY = cfg.proxy !== false;
    // Page-level proxy-friendly ad scripts (Adsterra popunder, Monetag push, …).
    if (Array.isArray(cfg.proxyAdScripts) && cfg.proxyAdScripts.length) {
      window.ZOFHUB_PROXY_ADS = cfg.proxyAdScripts;
    }
    // Optional fixed footer display banner (independent of the scripts above).
    if (typeof cfg.proxyBannerTag === 'string' && cfg.proxyBannerTag.trim()) {
      window.ZOFHUB_PROXY_BANNER = cfg.proxyBannerTag;
    }
  })
  .catch(() => { /* config unavailable → site still works, just no ads */ })
  .finally(() => {
    // (a) page-level proxy-friendly ad scripts (popunder / push / interstitial),
    //     only if configured. Loads NO Google code.
    if (window.ZOFHUB_PROXY_ADS) import('./proxy-ads.js?v=20260720');
    // (b) the clean, isolated footer display banner. It self-checks
    //     window.ZOFHUB_PROXY_BANNER and stays hidden until a banner tag is set,
    //     so a real banner appears the moment you configure PROXY_BANNER_TAG.
    import('./footer-ad.js?v=20260721').then(m => m.mountFooterAd()).catch(() => {});
  });
