// ZoFHub · layout.js — small shared behaviors (search shortcut, active link, live-total in header)
import { $ } from './utils.js';
import { presence, fmtCount, paintCount } from './presence.js';
import { getPlayerName } from './identity.js';
// NB: the floating AI game-helper orb is NOT imported here — see mountAIStub()
// near the bottom of this file. It is loaded on demand.
// Cookie-consent notice (shows once, site-wide).
import './consent.js?v=20260729';
// The page's ONE /api/site-config request, shared with every other module that
// needs it (game-page.js, browser.js). See site-config.js.
import { siteConfig } from './site-config.js';
// Ad-block detection and the premium-engine gate. Same specifier as browser.js,
// so the lock state is shared by one module instance.
import { armAdWatch, evaluateSupport } from './support-gate.js';
// Is this page inside TikTok's / Instagram's / … own web view? Pure detector.
import { detectInAppBrowser, externalBrowserLink, INAPP_MESSAGE } from './inapp.js';
// NB: the ad loaders (proxy-ads.js + ad-slots.js) are imported LATER (bottom of
// this file) — after /api/site-config resolves. No AdSense.

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

// ════════════════════════════════════════════════════════════════════════
// In-app browser banner.
//
// TikTok, Instagram, Facebook and friends open links in their own web view,
// where the proxy engines cannot work: on iOS that view has no Service
// Workers, so Ultraviolet and Scramjet never start and GUST renders blank.
// The only fix is the visitor's — open the page in Safari or Chrome — so the
// page says so, at the top, on every page.
//
// HOW IT STAYS OUT OF THE WAY
//   • A shadow root under a custom element: the site's CSS cannot restyle it,
//     its CSS cannot leak into a game frame, and generic element-hiding rules
//     (which match class names like "banner" or "alert") have nothing to match.
//   • It RESERVES its height instead of covering anything: its measured height
//     is published as --inapp-bar-h, which main.css adds to the body's top
//     padding and the sticky header's offset, and which the fixed-height app
//     shells (/browser, /ai) subtract — the same contract --legal-bar-h uses.
//     A ResizeObserver keeps the number true when the text wraps.
//   • It can be minimised to a single line (remembered for the session), never
//     removed: the visitor is still in the wrong browser.
//   • It is invisible in fullscreen, because a fullscreen element is drawn in
//     the top layer above everything else — a game in fullscreen is untouched.
// ════════════════════════════════════════════════════════════════════════
const INAPP_MIN_KEY = 'zofhub.inapp.min';
function mountInAppBanner() {
  let hit = null;
  try { hit = detectInAppBrowser(navigator.userAgent || '', navigator.maxTouchPoints || 0); } catch { return; }
  if (!hit || !document.body || document.querySelector('zofhub-inapp')) return;

  const root = document.documentElement;
  const host = document.createElement('zofhub-inapp');
  host.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:2147482000;display:block';
  // A note, not an alert: it is on every page, and role=alert would make a
  // screen reader interrupt with it on every single navigation.
  host.setAttribute('role', 'note');
  host.setAttribute('aria-label', 'Open this page in your browser');
  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = `
:host{all:initial}
*{box-sizing:border-box}
.bar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:10px 14px;
  font:600 13.5px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#241a00;
  background:linear-gradient(90deg,#ffd426,#ffb800);box-shadow:0 2px 12px rgba(10,4,32,.45)}
.msg{flex:1 1 260px;margin:0}
.actions{display:flex;gap:8px;flex-wrap:wrap}
button,a{appearance:none;border:0;border-radius:999px;padding:7px 12px;cursor:pointer;
  font-family:inherit;font-size:12.5px;font-weight:800;line-height:1;text-decoration:none;
  color:#fff;background:#241a00;white-space:nowrap}
.ghost{background:rgba(36,26,0,.14);color:#241a00}
button:focus-visible,a:focus-visible{outline:3px solid #241a00;outline-offset:2px}
.bar.min{padding:6px 14px}
.bar.min .msg{flex:1 1 auto;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bar.min .actions > :not(.toggle){display:none}
`;
  const bar = document.createElement('div');
  bar.className = 'bar';
  const msg = document.createElement('p');
  msg.className = 'msg';
  const actions = document.createElement('div');
  actions.className = 'actions';

  const escape = externalBrowserLink(location.href, hit.os);
  if (escape) {
    const a = document.createElement('a');
    a.href = escape.url;
    a.textContent = escape.label;
    a.rel = 'noopener';
    actions.appendChild(a);
  }
  // When the app hides its menu, the link on the clipboard is the way out.
  const copy = document.createElement('button');
  copy.type = 'button';
  copy.className = 'ghost';
  copy.textContent = 'Copy link';
  copy.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(location.href); copy.textContent = 'Copied ✓'; }
    catch { copy.textContent = 'Copy failed'; }
  });
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'ghost toggle';
  actions.append(copy, toggle);

  const setMin = (min) => {
    bar.classList.toggle('min', min);
    msg.textContent = min ? '⚠️ Open this page in Safari/Chrome for full speed.' : INAPP_MESSAGE;
    toggle.textContent = min ? 'Show' : 'Hide';
    toggle.setAttribute('aria-expanded', String(!min));
    try { sessionStorage.setItem(INAPP_MIN_KEY, min ? '1' : '0'); } catch { /* per-page only */ }
  };
  toggle.addEventListener('click', () => setMin(!bar.classList.contains('min')));

  bar.append(msg, actions);
  shadow.append(style, bar);
  let startMin = false;
  try { startMin = sessionStorage.getItem(INAPP_MIN_KEY) === '1'; } catch { /* default: full banner */ }
  setMin(startMin);
  document.body.prepend(host);

  const publish = () => root.style.setProperty('--inapp-bar-h', `${Math.ceil(host.getBoundingClientRect().height)}px`);
  root.classList.add('zh-inapp');
  publish();
  if ('ResizeObserver' in window) new ResizeObserver(publish).observe(host);
  else window.addEventListener('resize', publish);
}
mountInAppBanner();

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
// Feedback dialog — lazy and self-contained: it injects its own styles and
// markup, so no page needs an empty container that could rot unnoticed.
import('./feedback.js')
  .then(m => m.mountFeedback())
  .catch(() => { /* feedback unavailable → the link is inert, site unaffected */ });

// Donation dialog — same lazy, self-contained pattern. It collects nothing and
// posts nothing; it fetches /api/donate and shows addresses.
import('./donate.js')
  .then(m => m.mountDonate())
  .catch(() => { /* donate unavailable → the link is inert, site unaffected */ });

function mountFooter() {
  const footer = document.querySelector('.site-footer');
  if (!footer || footer.dataset.enhanced) return;
  footer.dataset.enhanced = '1';
  const year = new Date().getFullYear();

  // A page may ship its own attribution line — the GameFlare pages state who
  // actually serves the game and that ZoFHub does not host or modify it. That
  // sentence is a legal notice, not decoration, so it is captured before the
  // rebuild and restored afterwards instead of being overwritten by the shared
  // markup. Without this, giving those pages the shared footer would silently
  // delete the disclosure that makes them accurate.
  const ownNote = footer.querySelector('.footer-legal')?.textContent.trim() || '';

  // ── Compact variant ──────────────────────────────────────────────────────
  // /ai and /browser are fixed-height app shells: their main element is sized
  // to `calc(100vh - header)`, so a six-column footer would push the composer
  // (or the proxy frame) below the fold and turn a deliberate single-screen
  // layout into a scrolling page. They opt into a one-row legal bar instead,
  // which links exactly the same documents — the legal pages stay reachable
  // from every page on the site, which is the part that actually matters.
  if (footer.classList.contains('site-footer-mini')) {
    footer.innerHTML = `
      <div class="footer-mini-inner">
        <span class="footer-copy">&copy; ${year} ZoFHub</span>
        <nav class="footer-mini-links" aria-label="Legal">
          <a href="/privacy">Privacy</a>
          <a href="/terms">Terms</a>
          <a href="/cookies">Cookies</a>
          <a href="/dmca">DMCA</a>
          <a href="/credits">Credits</a>
          <a href="/licenses">Source</a>
        </nav>
      </div>`;
    if (ownNote) {
      const p = document.createElement('p');
      p.className = 'footer-legal';
      p.textContent = ownNote;
      footer.querySelector('.footer-mini-inner')?.appendChild(p);
    }
    return;
  }

  footer.innerHTML = `
    <div class="footer-main">
      <div class="footer-brand">
        <a class="footer-logo" href="/">
          <!-- logo-72.png, not favicon.png: this renders at 36 CSS px, and the
               256x256 favicon was 73KB to draw a 36px mark. 72px covers 2x
               retina and costs 7.6KB — the same picture, 65KB lighter, on every
               page of the site. -->
          <img src="/assets/logo-72.png" alt="ZoFHub" width="36" height="36" loading="lazy" decoding="async" />
          <span>ZoFHub</span>
        </a>
        <p class="footer-tagline">Instant browser games, a free AI assistant, and a smart proxy browser — all in one hub. No downloads, no sign-up.</p>
      </div>
      <nav class="footer-col" aria-label="Play">
        <h3>Play</h3>
        <a href="/">All games</a>
        <a href="/category/arcade">Arcade</a>
        <a href="/category/racing">Racing</a>
        <a href="/category/shooting">Shooting</a>
        <a href="/category/puzzle">Puzzle</a>
      </nav>
      <nav class="footer-col" aria-label="Explore">
        <h3>Explore</h3>
        <a href="/ai">AI Assistant</a>
        <a href="/community">Community</a>
        ${proxyBrowserVisible() ? '<a href="/browser">Proxy Browser</a>' : ''}
        <a href="/api/health" target="_blank" rel="noopener">Status</a>
        <!-- Opens the feedback dialog (feedback.js). A real href so it still reads
             as a link to assistive tech and survives the module failing to load. -->
        <a href="#feedback" data-feedback>Send Feedback</a>
        <!-- Opens the donation dialog (donate.js). Real href for the same reason. -->
        <a href="#donate" data-donate>Donate</a>
      </nav>
      <nav class="footer-col" aria-label="Legal">
        <h3>Legal</h3>
        <a href="/privacy">Privacy Policy</a>
        <a href="/terms">Terms of Service</a>
        <a href="/cookies">Cookie Policy</a>
        <a href="/dmca">DMCA / Copyright</a>
        <a href="/credits">Credits &amp; Licenses</a>
        <!-- AGPL-3.0 §13 requires the source offer to be reachable by anyone
             USING the software over the network. A page nobody can find does not
             discharge that, so it gets a permanent footer link on every page. -->
        <a href="/licenses">Open Source &amp; Source Offer</a>
      </nav>
    </div>
    <div class="footer-bottom">
      <span class="footer-copy">© ${year} ZoFHub · Personal &amp; non-commercial use only.</span>
    </div>`;
  // Restore the page's own attribution line (see ownNote above), above the
  // copyright row so it reads as part of the legal block rather than a caption.
  if (ownNote) {
    const p = document.createElement('p');
    p.className = 'footer-legal';
    p.textContent = ownNote;
    footer.querySelector('.footer-bottom')?.prepend(p);
  }

  // Social cluster — only when there are REAL socials to show (no empty gaps).
  if (SOCIALS.length) {
    footer.querySelector('.footer-brand')?.appendChild(buildSocialCluster('footer-social'));
    footer.querySelector('.footer-bottom')?.appendChild(buildSocialCluster('footer-social footer-social-mini', 18));
  }
}
mountFooter();

// ════════════════════════════════════════════════════════════════════════
// Mirror-update signup — censorship insurance.
//
// If this domain is blocked, an address collected beforehand is the only way
// left to tell anyone where the mirror is. The form is deliberately tiny: one
// field, one button, no name, no confirmation step, no preferences.
//
// The "zero tracking" claim in the copy is kept by the SCHEMA, not by this
// script: db/14_subscriber_emails.sql stores the address and nothing else — no
// IP, no timestamp, no user agent. It is worth not adding any of those later.
// ════════════════════════════════════════════════════════════════════════
function mountMirrorSignup() {
  const footer = document.querySelector('.site-footer');
  if (!footer || footer.querySelector('.mirror-signup')) return;
  // Not in the compact bar. /ai and /browser reserve an exact 38px for it, and
  // a two-line form with an input and a button does not fit in 38px — it pushed
  // the AI composer and the proxy frame off the bottom of the viewport. The
  // signup still appears on every content page, which is where somebody reading
  // a page is able to stop and type an address anyway.
  if (footer.classList.contains('site-footer-mini')) return;
  const anchor = footer.querySelector('.footer-bottom') || footer.lastElementChild;
  if (!anchor) return;

  const box = document.createElement('section');
  box.className = 'mirror-signup';
  box.innerHTML = `
    <form class="mirror-form" novalidate>
      <label class="mirror-copy" for="mirrorEmail">
        Lose access if this domain gets blocked? Enter your email for mirror updates.
        <span class="mirror-fine">No accounts, zero tracking.</span>
      </label>
      <div class="mirror-row">
        <input id="mirrorEmail" name="email" type="email" inputmode="email"
               autocomplete="email" spellcheck="false" placeholder="you@example.com"
               required aria-describedby="mirrorMsg" />
        <button type="submit" class="mirror-go">Notify me</button>
      </div>
      <!-- Honeypot: hidden from people, filled by bots. Never focusable. -->
      <input class="mirror-hp" type="text" name="website" tabindex="-1" autocomplete="off" aria-hidden="true" />
      <p class="mirror-msg" id="mirrorMsg" role="status" aria-live="polite"></p>
    </form>`;
  anchor.parentNode.insertBefore(box, anchor);

  const form = box.querySelector('form');
  const input = box.querySelector('#mirrorEmail');
  const btn = box.querySelector('.mirror-go');
  const msg = box.querySelector('.mirror-msg');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = input.value.trim();
    if (!email) { msg.textContent = 'Enter an email address first.'; msg.className = 'mirror-msg bad'; return; }
    btn.disabled = true;
    const wasLabel = btn.textContent;
    btn.textContent = 'Sending…';
    try {
      const r = await fetch('/api/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, website: box.querySelector('.mirror-hp').value }),
      });
      const d = await r.json().catch(() => ({}));
      if (r.ok && d.ok) {
        // The server answers the same way for a new address and one already on
        // the list — so this message must not claim to know which happened.
        msg.textContent = 'Saved. If this domain goes down, you will get the mirror link.';
        msg.className = 'mirror-msg ok';
        form.querySelector('.mirror-row').hidden = true;
      } else {
        msg.textContent = d.error || 'Could not save that right now.';
        msg.className = 'mirror-msg bad';
      }
    } catch {
      msg.textContent = 'Network problem — try again in a moment.';
      msg.className = 'mirror-msg bad';
    } finally {
      btn.disabled = false;
      btn.textContent = wasLabel;
    }
  });
}
mountMirrorSignup();

// ════════════════════════════════════════════════════════════════════════
// Header Donate button.
//
// It already existed — as one link in a footer column headed "Explore", below
// the fold on every page. That is not an entry point, it is an archive. The
// site has exactly one place where money is asked for, and it now sits in the
// sticky bar where it can actually be seen.
//
// It is an <a> with a real href, not a <button>: the donation dialog is
// progressive enhancement, so if donate.js fails to load the link still goes
// to a page that works. Same reasoning as the footer link it mirrors.
// ════════════════════════════════════════════════════════════════════════
// Leaderboard link. Added here rather than by hand in eight HTML files, which
// is how the nav drifted out of sync between pages in the first place.
function mountHeaderLeaderboard() {
  const nav = document.querySelector('.header-inner .top-nav');
  if (!nav || nav.querySelector('a[href="/leaderboard"]')) return;
  const a = document.createElement('a');
  a.href = '/leaderboard';
  a.textContent = 'Leaderboard';
  if (location.pathname.replace(/\/+$/, '') === '/leaderboard') a.className = 'active';
  // After "Games" when that exists, otherwise first — it is a play destination,
  // not a utility, so it belongs with the play links rather than beside Browser.
  const games = nav.querySelector('a[href="/"]');
  if (games) games.insertAdjacentElement('afterend', a);
  else nav.prepend(a);
}
mountHeaderLeaderboard();

function mountHeaderDonate() {
  const header = document.querySelector('.header-inner');
  if (!header || header.querySelector('.header-donate')) return;
  const a = document.createElement('a');
  a.className = 'header-donate';
  a.href = '/donate';
  // Navigates to the payment page rather than opening the quick dialog. The
  // page is where a donor picks a coin and sees exactly one address next to its
  // QR; the dialog shows every method at once, which is how somebody ends up
  // pasting a Monero address into a Bitcoin wallet. The footer link still opens
  // the dialog for a quick look.
  if (location.pathname.replace(/\/+$/, '') === '/donate') a.setAttribute('aria-current', 'page');
  a.setAttribute('aria-label', 'Donate to ZoFHub');
  a.innerHTML = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" ' +
    'stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8l1 1.1L12 21.2l7.8-7.7 1-1.1a5.5 5.5 0 0 0 0-7.8z"/>' +
    '</svg><span>Donate</span>';
  const nav = header.querySelector('.top-nav');
  if (nav) nav.insertAdjacentElement('afterend', a);
  else header.appendChild(a);
}
mountHeaderDonate();

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
// bar on EVERY page. It is device-local: nothing is registered and no account
// exists. It pre-fills the author field on a community post.
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
  chip.title = `You are ${name} — a name this device generated, stored only here`;
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
// Is the proxy browser reachable for THIS visitor?
//
// When the operator turns on the proxy discovery gate (MASQR_ENABLED — see
// lib/masqr.mjs), /browser answers 404 for anyone without a key. A header that
// still advertises "Proxy Browser" would then look like a broken site rather
// than a quiet one, so the server leaves a one-character, non-secret hint
// cookie and the chrome reads it:
//
//   absent  → the gate is off entirely. Show the link. This is the default and
//             every deployment that never touches MASQR.
//   '1'     → gate on, this visitor has a valid key. Show it.
//   '0'     → gate on, no key. Hide it.
//
// Deliberately fails toward SHOWING the link: a storage-blocked or cookie-less
// browser should get the site it has always had, not a silently reduced one.
function proxyBrowserVisible() {
  try {
    const m = /(?:^|;\s*)zh_px=([01])/.exec(document.cookie || '');
    return !m || m[1] === '1';
  } catch { return true; }
}

const NAV_LINKS = [
  { label: 'Games',         href: '/' },
  { label: 'AI Assistant',  href: '/ai' },
  { label: 'Community',     href: '/community' },
  { label: 'Proxy Browser', href: '/browser', requiresProxyAccess: true },
].filter(l => !l.requiresProxyAccess || proxyBrowserVisible());

/**
 * Remove proxy links this visitor cannot follow.
 *
 * NAV_LINKS above only builds the MOBILE nav; the desktop header is static
 * markup in every .html file, and the footer is a template string. Editing
 * twenty pages to add a conditional would be churn, and would still miss any
 * page added later — so the links are pruned from the live DOM instead, which
 * covers header, footer and anything else that points at a gated surface.
 *
 * Runs only when the gate is ON and this visitor has no key. With the gate off
 * — the default, and every deployment that never touches MASQR — the hint
 * cookie is absent, proxyBrowserVisible() is true, and this does nothing at all.
 */
function pruneGatedLinks() {
  if (proxyBrowserVisible()) return;
  for (const a of document.querySelectorAll('a[href^="/browser"], a[href^="/gust"]')) {
    // Drop the whole list item where there is one, so the nav does not keep a
    // stray separator or an empty bullet where the link used to be.
    (a.closest('li') || a).remove();
  }
}
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
// After the footer and the mobile nav exist, so it prunes both along with the
// static desktop header.
pruneGatedLinks();

// ── Site configuration from the admin console ──────────────────────────────
// /api/site-config carries the PUBLIC settings only (lib/settings-registry.mjs):
// an announcement, and which features are switched on. The announcement is set
// with textContent, never innerHTML — it is operator text, and operator text is
// still text. A switched-off feature is already refused by the server; removing
// its links here just stops the site pointing people at a 404.
const FEATURE_LINKS = { ai: '/ai', community: '/community', leaderboard: '/leaderboard', donate: '/donate' };
siteConfig
  .then((cfg) => {
    if (!cfg) return;
    const a = cfg.announcement;
    if (a && typeof a.text === 'string' && a.text.trim() && !document.querySelector('.site-announce')) {
      const bar = document.createElement('div');
      bar.className = 'site-announce' + (a.level === 'warning' ? ' is-warning' : '');
      bar.setAttribute('role', a.level === 'warning' ? 'alert' : 'status');
      bar.textContent = a.text;
      document.body.prepend(bar);
    }
    const off = Object.entries(cfg.features || {}).filter(([, on]) => on === false).map(([k]) => FEATURE_LINKS[k]).filter(Boolean);
    if (cfg.proxy && cfg.proxy.accessMode === 'disabled') off.push('/browser');
    for (const href of off) {
      for (const el of document.querySelectorAll(`a[href="${href}"], a[href^="${href}?"]`)) (el.closest('li') || el).remove();
    }
  })
  .catch(() => { /* no config → the page works as it always did */ });

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
// Advertising (loaded after config). ZoFHub is ALWAYS a proxy site and never
// loads Google AdSense. Six networks, one role each (lib/ad-providers.mjs):
// the server resolves which are live for THIS page and THIS visitor's region,
// and this loads only what it was handed — so the site stays clean until a
// network is configured.
// ════════════════════════════════════════════════════════════════════════
// ── The proxy/ad boundary, client side ────────────────────────────────────
// Mirrors isAdSurface() in lib/ad-providers.mjs. Deliberately duplicated rather
// than fetched, because the whole point is to decide BEFORE asking the server
// for anything ad-related — a page that never requests an ad config cannot
// accidentally render one.
//
// browser.html imports this module for the site chrome (header, nav, theme), so
// without this check configuring any network would have started serving ads on
// the proxy page. That is what this exists to prevent.
const PROXY_SURFACE_RE = /^\/(browser|gust|proxy|uv|sj|scram|epoxy|libcurl|baremux|wisp|bare|service)(\/|$)/i;
const ADS_ALLOWED_HERE = !PROXY_SURFACE_RE.test(location.pathname);

// Start watching for blocked ad scripts BEFORE any can be injected: load and
// error events are not replayed for a listener that arrives late.
if (ADS_ALLOWED_HERE) armAdWatch();

let adConfig = null;
siteConfig
  .then((cfg) => {
    if (!cfg) return;
    adConfig = cfg;
    window.ZOFHUB_PROXY = cfg.proxy !== false;
    if (!ADS_ALLOWED_HERE || cfg.adsAllowed === false) return;   // proxy surface: nothing further
    // HilltopAds' in-page push loader — the one role that is only a script.
    if (Array.isArray(cfg.adScripts) && cfg.adScripts.length) {
      window.ZOFHUB_PROXY_ADS = cfg.adScripts;
    }
    // ExoClick's two fixed boxes. Each renders ONLY when its own tag is set.
    const slots = cfg.slots || {};
    if (typeof slots.header === 'string' && slots.header.trim()) window.ZOFHUB_HEADER_TAG = slots.header;
    if (typeof slots.sidebar === 'string' && slots.sidebar.trim()) window.ZOFHUB_SIDEBAR_TAG = slots.sidebar;
    // Role payloads: { provider, tag | url }. The interstitial's 20-minute cap
    // is a constant in ad-frequency.js; nothing in this payload can change it.
    if (cfg.interstitial && (cfg.interstitial.tag || cfg.interstitial.url)) window.ZOFHUB_INTERSTITIAL = cfg.interstitial;
    if (cfg.native && cfg.native.tag) window.ZOFHUB_NATIVE = cfg.native;
    // The server sends the popunder only for game pages; ad-slots.js adds the
    // desktop check. The pre-roll is game-page.js's to run, not this file's.
    if (cfg.popunder && cfg.popunder.tag) window.ZOFHUB_POPUNDER = cfg.popunder;
  })
  .finally(() => {
    // Second gate. A cached window.ZOFHUB_* from an earlier navigation must
    // not be able to start the ad stack on a proxy surface.
    if (ADS_ALLOWED_HERE) {
      // (a) page-level loader scripts, only if configured. Loads NO Google code.
      if (window.ZOFHUB_PROXY_ADS) import('./proxy-ads.js?v=20260928');
      // (b) every placement with a container in our layout. Each self-checks
      //     its own payload and does nothing when unset, so the module is
      //     fetched only when at least one is present.
      if (window.ZOFHUB_HEADER_TAG || window.ZOFHUB_SIDEBAR_TAG || window.ZOFHUB_INTERSTITIAL
          || window.ZOFHUB_NATIVE || window.ZOFHUB_POPUNDER) {
        import('./ad-slots.js?v=20260928').then((m) => m.mountAdSlots()).catch(() => {});
      }
    }
    // (c) the ad-block check. On a hub or game page it judges the ads that
    //     just loaded; on /browser it re-checks, without contacting any ad
    //     network, whether a previous verdict still holds — that is where the
    //     premium engines it may lock live.
    evaluateSupport(adConfig, { adSurface: ADS_ALLOWED_HERE && adConfig?.adsAllowed === true })
      .catch(() => { /* a failed check never locks anything */ });
  });
