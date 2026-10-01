// ZoFHub · ad-slots.js — every ad placement that needs a place in OUR layout.
// ---------------------------------------------------------------------------
// Each placement belongs to exactly one network (lib/ad-providers.mjs), and a
// placement renders only its owner's code:
//
//   Header leaderboard  728×90 / 320×50 mobile   ExoClick    ZOFHUB_HEADER_TAG
//   Sidebar rectangle   300×250                  ExoClick    ZOFHUB_SIDEBAR_TAG
//   Native widget       below the "for you" rows Mondiad     ZOFHUB_NATIVE
//   Popunder            desktop game pages only  PopAds      ZOFHUB_POPUNDER
//   Interstitial        between games, 1/20 min  Ad-Maven    ZOFHUB_INTERSTITIAL
//
// The two placements a network positions entirely by itself are elsewhere:
// HilltopAds' in-page push loader (proxy-ads.js) and Clickadu's video pre-roll
// in front of the game frame (preroll.js).
//
// ── DESIGN RULES (all four are load-bearing, not preferences) ───────────────
//
// 1. NO TAG → NO SLOT. A slot is only created when a real tag is configured.
//    An empty reserved box is worse than nothing: it's visible dead space, and
//    on a kid-facing site an empty labelled rectangle looks broken.
//
// 2. ZERO LAYOUT SHIFT. When a slot IS created, its box is sized up-front with
//    min-height/min-width matching the ad, so the page never jumps when the
//    creative loads late. This is the whole CLS story: reserve space at create
//    time, never after.
//
// 3. NEVER OVERLAP CONTROLS. Slots are real flow elements inside their own
//    containers — no position:fixed, no negative margins, no z-index stacking
//    over game canvases, AI composers, or proxy address bars. `isolation:isolate`
//    keeps a network's own absolutely-positioned creative from escaping.
//
// 4. NEVER GOOGLE. Google bans proxy/anonymizer domains at the ACCOUNT level, so
//    a single AdSense tag here could kill an unrelated AdSense account. The
//    server strips Google URLs from every ad env var; this file re-checks before
//    touching the DOM. Belt and suspenders, deliberately.
// ---------------------------------------------------------------------------

import { adFrequencyController, INTERSTITIAL_COOLDOWN_MS } from './ad-frequency.js';

export { adFrequencyController };

const GOOGLE_AD_RE = /googlesyndication|googleadservices|adsbygoogle|doubleclick/i;

// Sizes are declared here and rendered into CSS so the reserved box and the
// creative can never disagree.
const HEADER = { w: 728, h: 90, mobileW: 320, mobileH: 50 };
const SIDEBAR = { w: 300, h: 250 };
// A native widget's height is the network's choice; this is the floor that is
// reserved when the slot opens, so the first rows it draws do not push the page.
const NATIVE_MIN_H = 180;

const CSS = `
.zad{display:grid;place-items:center;overflow:hidden;isolation:isolate;position:relative}
.zad > *{max-width:100%}

/* Header leaderboard — sits between the sticky header and the content frame.
   Centred, with breathing room top and bottom so it reads as a separate band
   and can never be mistaken for (or mis-clicked as) a nav item. */
.zad-header-bar{width:100%;display:flex;justify-content:center;padding:10px 12px 2px}
.zad-header{width:100%;max-width:${HEADER.w}px;min-height:${HEADER.h}px}
@media(max-width:820px){
  .zad-header{max-width:${HEADER.mobileW}px;min-height:${HEADER.mobileH}px}
  .zad-header-bar{padding:8px 12px 0}
}

/* Sidebar rectangle — appended INSIDE the existing category sidebar, below the
   category list. margin-top keeps it clear of the last category link. */
.zad-side-wrap{display:flex;justify-content:center;margin:18px 0 6px}
.zad-side{width:${SIDEBAR.w}px;max-width:100%;min-height:${SIDEBAR.h}px}
/* The sidebar collapses to a horizontal strip on narrow screens, where a
   300×250 block would shove the game grid off-screen. Hide it there rather than
   let it fight the layout. */
@media(max-width:900px){.zad-side-wrap{display:none}}

/* Native: the page owns the outer box (main.css reveals it only once
   data-zad-filled is set); this is the disclosure line and the reserved floor. */
.zad-native-label{margin:0 0 6px;font:600 11px/1.2 system-ui,sans-serif;letter-spacing:.08em;
  text-transform:uppercase;opacity:.6}
.zad-native{min-height:${NATIVE_MIN_H}px;width:100%;isolation:isolate;position:relative;overflow:hidden}
`;

function injectCss() {
  if (document.getElementById('zad-css')) return;
  const st = document.createElement('style');
  st.id = 'zad-css';
  st.textContent = CSS;
  document.head.appendChild(st);
}

// Inject an ad snippet WITH script execution.
// innerHTML alone does NOT run <script> tags (HTML spec), so we parse the markup
// in an inert <template> and re-create each script node in document order. Order
// matters: banner tags are usually an inline config block followed by the loader
// that READS that global. Reversing them silently serves a blank slot. Attributes
// and inline code are copied unchanged, so a network that requires its code to
// run unmodified (PopAds) gets exactly the code it supplied.
function injectMarkup(container, html) {
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  for (const node of Array.from(tpl.content.childNodes)) {
    if (node.tagName === 'SCRIPT') {
      const s = document.createElement('script');
      for (const attr of Array.from(node.attributes)) s.setAttribute(attr.name, attr.value);
      if (node.textContent) s.textContent = node.textContent;
      container.appendChild(s);
    } else {
      container.appendChild(node);
    }
  }
}

// Read a configured tag, refusing empties and anything Google.
function readTag(name) {
  const raw = typeof window[name] === 'string' ? window[name].trim() : '';
  if (!raw) return '';
  if (GOOGLE_AD_RE.test(raw)) {
    console.warn(`[zofhub-ads] ${name} contained Google ad code and was refused (banned on proxy domains).`);
    return '';
  }
  return raw;
}

// A role payload ({ provider, tag }) from a window global, with the same checks.
function readRoleTag(name) {
  const v = typeof window !== 'undefined' ? window[name] : null;
  const tag = v && typeof v === 'object' && typeof v.tag === 'string' ? v.tag.trim() : '';
  if (!tag) return '';
  if (GOOGLE_AD_RE.test(tag)) {
    console.warn(`[zofhub-ads] ${name} contained Google ad code and was refused (banned on proxy domains).`);
    return '';
  }
  return tag;
}

// ── Header leaderboard ─────────────────────────────────────────────────────
// Mounted directly AFTER <header class="site-header">, so it lands above the
// content frame in normal document flow — no overlap with the sticky header.
export function mountHeaderAd() {
  if (typeof window === 'undefined' || !document.body) return;
  if (document.querySelector('.zad-header-bar')) return;              // mount once

  const tag = readTag('ZOFHUB_HEADER_TAG');
  if (!tag) return;                                                   // rule 1: no tag → no slot

  // The AI page is a fixed-height flex/grid shell; inserting a band above it
  // would push the composer below the fold.
  if (document.body.classList.contains('page-ai') || document.querySelector('.ai-shell')) return;

  const header = document.querySelector('header.site-header');
  if (!header || !header.parentNode) return;

  injectCss();

  const bar = document.createElement('aside');
  bar.className = 'zad-header-bar';
  bar.setAttribute('aria-label', 'Advertisement');   // a11y only — no visible label

  const slot = document.createElement('div');
  slot.className = 'zad zad-header';
  slot.dataset.adZone = 'header';

  bar.appendChild(slot);
  header.parentNode.insertBefore(bar, header.nextSibling);

  injectMarkup(slot, tag);
  return bar;
}

// ── Sidebar medium rectangle ───────────────────────────────────────────────
// Appended inside the EXISTING #categorySidebar rather than a new column, so the
// catalog grid keeps its current widths and nothing reflows.
export function mountSidebarAd() {
  if (typeof window === 'undefined' || !document.body) return;
  if (document.querySelector('.zad-side-wrap')) return;               // mount once

  const tag = readTag('ZOFHUB_SIDEBAR_TAG');
  if (!tag) return;                                                   // rule 1: no tag → no slot

  const sidebar = document.getElementById('categorySidebar');
  if (!sidebar) return;                                               // page has no sidebar

  injectCss();

  const wrap = document.createElement('aside');
  wrap.className = 'zad-side-wrap';
  wrap.setAttribute('aria-label', 'Advertisement');

  const slot = document.createElement('div');
  slot.className = 'zad zad-side';
  slot.dataset.adZone = 'sidebar';

  wrap.appendChild(slot);
  sidebar.appendChild(wrap);

  injectMarkup(slot, tag);
  return wrap;
}

// ── Native widgets below the "for you" rows ────────────────────────────────
// The page declares the positions (`.zad-native-slot` inside #featuredRow and
// #forYouRow); this fills them. Two conditions on top of rule 1:
//
//   • the row must be VISIBLE. #forYouRow stays hidden until this device has
//     enough history to personalise; a widget loaded into a hidden row is an
//     impression nobody could see, which networks treat as invalid traffic.
//   • the row must be NEAR THE VIEWPORT. The widget's script loads only when
//     the visitor scrolls within reach of it, so it never competes with the
//     catalog for the first paint.
//
// The ROW is what is observed, not the slot: main.css keeps an unfilled slot at
// display:none (rule 1), and an element with no box never intersects anything.
// `data-zad-filled` is set BEFORE the markup goes in, so the reserved floor is
// in place before the creative can draw (rule 2).
export function mountNativeAds() {
  if (typeof window === 'undefined' || !document.body) return 0;
  const tag = readRoleTag('ZOFHUB_NATIVE');
  if (!tag) return 0;                                                 // rule 1

  const slots = [...document.querySelectorAll('.zad-native-slot:not([data-zad-filled])')];
  if (!slots.length) return 0;
  injectCss();

  const fill = (slot) => {
    if (slot.dataset.zadFilled) return;
    slot.dataset.zadFilled = '1';
    if (!slot.getAttribute('aria-label')) slot.setAttribute('aria-label', 'Sponsored');
    const label = document.createElement('p');
    label.className = 'zad-native-label';
    label.textContent = 'Sponsored';
    // A fresh child per slot: the same tag injected twice must not share a
    // container, or a network's loader overwrites its own earlier widget.
    const inner = document.createElement('div');
    inner.className = 'zad-native';
    slot.append(label, inner);
    injectMarkup(inner, tag);
  };

  if (!('IntersectionObserver' in window)) {
    // No observer: fill only rows that are visible right now.
    for (const s of slots) if (!s.closest('[hidden]')) fill(s);
    return slots.length;
  }
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      const slot = e.target.querySelector('.zad-native-slot:not([data-zad-filled])');
      if (slot) fill(slot);
      io.unobserve(e.target);
    }
  }, { rootMargin: '300px 0px' });
  for (const s of slots) io.observe(s.closest('section') || s.parentElement || s);
  return slots.length;
}

// ── Popunder: desktop game pages only ──────────────────────────────────────
// PopAds works "behind the scenes" — its code opens the popunder on a later
// click — so it needs no visible container. It is confined three ways, each
// independently sufficient:
//   • the server sends it only for /play/<slug> pages (lib/ad-providers.mjs);
//   • layout.js never loads this module on a proxy surface;
//   • this function re-checks the path and requires a DESKTOP browser: a fine
//     pointer that can hover, a wide viewport, and no mobile user agent.
// The code is injected byte-for-byte as supplied (see injectMarkup).
export function isDesktopBrowser() {
  try {
    const ua = navigator.userAgent || '';
    if (/Mobi|Android|iPhone|iPad|iPod|Tablet|Silk|Kindle/i.test(ua)) return false;
    // iPadOS reports a desktop Safari user agent; touch points give it away.
    if (/Macintosh/.test(ua) && (navigator.maxTouchPoints || 0) > 1) return false;
    const fine = window.matchMedia?.('(hover: hover) and (pointer: fine)')?.matches;
    return Boolean(fine) && window.innerWidth >= 1024;
  } catch { return false; }
}

export function mountPopunder() {
  if (typeof window === 'undefined' || !document.body) return false;
  if (document.querySelector('[data-zad-popunder]')) return false;    // mount once
  if (!/^\/play\/[^/]+/.test(location.pathname)) return false;
  if (!isDesktopBrowser()) return false;
  const tag = readRoleTag('ZOFHUB_POPUNDER');
  if (!tag) return false;                                             // rule 1

  const holder = document.createElement('div');
  holder.dataset.zadPopunder = '1';
  holder.hidden = true;
  holder.setAttribute('aria-hidden', 'true');
  document.body.appendChild(holder);
  injectMarkup(holder, tag);
  return true;
}

// ── Between-games interstitial ─────────────────────────────────────────────
// WHAT FIRES IT. A click on a game-launch link (`a[href^="/play/"]`). Those are
// ordinary anchors built by catalog.js and game-page.js, so one delegated
// listener on the document covers every tile on every page, including tiles
// rendered long after load.
//
// THE FOUR RULES IT CANNOT BREAK:
//
//   1. THE PLAYER ALWAYS REACHES THE GAME. Every exit path navigates, and a
//      failsafe timer navigates even if the creative hangs, throws, or the
//      Continue button never renders. An ad that can trap a player costs the
//      audience, not just the impression.
//
//   2. IT NEVER STEALS A DELIBERATE NAVIGATION. Modified clicks (ctrl / cmd /
//      shift / alt / middle) and target=_blank anchors are left completely
//      alone — someone opening a game in a new tab gets exactly that.
//
//   3. AT MOST ONE PER 20 MINUTES, DEVICE-WIDE. Enforced by
//      adFrequencyController with INTERSTITIAL_COOLDOWN_MS — a constant; the
//      server payload carries no value this code reads for it. The controller
//      records the timestamp on the way through and fails CLOSED when
//      localStorage is unavailable.
//
//   4. A DIRECT-LINK IS NEVER AUTO-OPENED. Ad-Maven's direct-link format is a
//      destination URL, and their rules (restated in lib/ad-providers.mjs)
//      require it to sit behind something a person deliberately clicks. So a
//      URL-only configuration renders a labelled sponsored link the visitor may
//      ignore. It never becomes a redirect, and it is never dressed up as the
//      "Continue" control.
const INTERSTITIAL_CSS = `
.zad-int{position:fixed;inset:0;z-index:2147483000;display:flex;flex-direction:column;
  align-items:center;justify-content:center;gap:16px;padding:24px;
  background:rgba(8,10,18,.92);backdrop-filter:blur(6px)}
.zad-int-note{margin:0;font:600 12px/1.4 system-ui,sans-serif;letter-spacing:.08em;
  text-transform:uppercase;color:rgba(255,255,255,.55)}
.zad-int-box{display:grid;place-items:center;min-width:300px;min-height:250px;
  max-width:100%;max-height:70vh;overflow:hidden;isolation:isolate;position:relative;
  border-radius:12px;background:rgba(255,255,255,.04)}
.zad-int-box > *{max-width:100%}
.zad-int-actions{display:flex;align-items:center;gap:14px;flex-wrap:wrap;justify-content:center}
.zad-int-btn{appearance:none;border:0;border-radius:999px;padding:12px 26px;cursor:pointer;
  font:700 15px/1 system-ui,sans-serif;background:#fff;color:#111}
.zad-int-btn[disabled]{opacity:.55;cursor:default}
.zad-int-link{font:600 13px/1 system-ui,sans-serif;color:rgba(255,255,255,.75);
  text-decoration:underline;text-underline-offset:3px}
@media(max-width:480px){.zad-int-box{min-width:0;width:100%}}
`;

// How long Continue stays disabled. Short on purpose: a viewability floor for
// the advertiser, not a punishment for the player.
const INTERSTITIAL_DWELL_MS = 5000;
// Absolute ceiling. If nothing has navigated by now something is broken, and
// the player goes to the game regardless. Rule 1.
const INTERSTITIAL_FAILSAFE_MS = 15000;

function readInterstitialConfig() {
  const cfg = (typeof window !== 'undefined' && window.ZOFHUB_INTERSTITIAL) || null;
  if (!cfg || typeof cfg !== 'object') return null;
  const tag = typeof cfg.tag === 'string' ? cfg.tag.trim() : '';
  const url = typeof cfg.url === 'string' ? cfg.url.trim() : '';
  if (!tag && !url) return null;
  // Same belt-and-suspenders re-check the other slots do, before any DOM write.
  if (GOOGLE_AD_RE.test(tag) || GOOGLE_AD_RE.test(url)) {
    console.warn('[zofhub-ads] interstitial contained Google ad code and was refused.');
    return null;
  }
  if (url && !/^https:\/\//i.test(url)) return null;
  return {
    tag,
    url,
    provider: typeof cfg.provider === 'string' ? cfg.provider : '',
  };
}

/** Show the interstitial, then go to `href`. Always ends in a navigation. */
function showInterstitial(cfg, href) {
  injectCss();
  if (!document.getElementById('zad-int-css')) {
    const st = document.createElement('style');
    st.id = 'zad-int-css';
    st.textContent = INTERSTITIAL_CSS;
    document.head.appendChild(st);
  }

  const prevFocus = document.activeElement;
  let done = false;

  // One funnel for every exit, so cleanup and navigation can never be skipped
  // by whichever path happened to fire.
  const go = () => {
    if (done) return;
    done = true;
    clearTimeout(failsafe);
    clearInterval(ticker);
    document.removeEventListener('keydown', onKey, true);
    try { overlay.remove(); } catch { /* already gone */ }
    try { prevFocus?.focus?.(); } catch { /* not focusable */ }
    window.location.assign(href);
  };
  const failsafe = setTimeout(go, INTERSTITIAL_FAILSAFE_MS);
  const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); go(); } };

  const overlay = document.createElement('div');
  overlay.className = 'zad-int';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', 'Advertisement — your game is loading');

  // Deliberately a <p>, not a heading: this overlay is injected into pages whose
  // heading outline is asserted by test/page-structure.test.mjs, and a stray h2
  // here would break the outline that test checks.
  const note = document.createElement('p');
  note.className = 'zad-int-note';
  note.textContent = 'Advertisement';

  const box = document.createElement('div');
  box.className = 'zad-int-box zad';

  const actions = document.createElement('div');
  actions.className = 'zad-int-actions';

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'zad-int-btn';
  btn.disabled = true;
  let left = Math.ceil(INTERSTITIAL_DWELL_MS / 1000);
  btn.textContent = `Continue in ${left}`;
  btn.addEventListener('click', go);
  const ticker = setInterval(() => {
    left -= 1;
    if (left > 0) { btn.textContent = `Continue in ${left}`; return; }
    clearInterval(ticker);
    btn.disabled = false;
    btn.textContent = 'Continue to game →';
    try { btn.focus(); } catch { /* ignore */ }
  }, 1000);
  actions.appendChild(btn);

  // Rule 4: the direct-link is offered, never taken on the visitor's behalf,
  // and never styled as the primary control.
  if (cfg.url) {
    const a = document.createElement('a');
    a.className = 'zad-int-link';
    a.href = cfg.url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer sponsored';
    a.textContent = 'Open sponsored offer';
    actions.appendChild(a);
  }

  overlay.append(note, box, actions);
  document.body.appendChild(overlay);
  document.addEventListener('keydown', onKey, true);

  if (cfg.tag) {
    // A creative that throws must not be able to block the navigation, so it is
    // isolated from the exit path entirely.
    try { injectMarkup(box, cfg.tag); }
    catch (e) { console.warn('[zofhub-ads] interstitial creative failed:', e); }
  }
}

/**
 * Install the game-launch interstitial. Idempotent, safe on any page, and does
 * nothing at all unless a network actually supplied an interstitial.
 */
export function mountInterstitial() {
  if (typeof window === 'undefined' || !document.body) return false;
  if (window.__zadInterstitialBound) return false;

  const cfg = readInterstitialConfig();
  if (!cfg) return false;                 // rule 1 of this file: no tag → nothing

  window.__zadInterstitialBound = true;

  document.addEventListener('click', (e) => {
    // Rule 2: never intercept a click the visitor meant to handle themselves.
    if (e.defaultPrevented || e.button !== 0) return;
    if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;

    const a = e.target?.closest?.('a[href]');
    if (!a || a.target === '_blank' || a.hasAttribute('download')) return;

    // Same-origin game launches only. Comparing the RESOLVED URL rather than the
    // raw attribute means a relative, absolute or mirror-domain spelling of the
    // same link all behave identically — which is the point of this site being
    // domain-portable.
    let dest;
    try { dest = new URL(a.href, location.href); } catch { return; }
    if (dest.origin !== location.origin) return;
    if (!/^\/play\//.test(dest.pathname)) return;

    // Rule 3. allow() records the timestamp, so a declined click costs nothing
    // and a permitted one cannot be permitted twice.
    if (!adFrequencyController.allow('interstitial', INTERSTITIAL_COOLDOWN_MS)) return;

    e.preventDefault();
    showInterstitial(cfg, dest.href);
  }, true);

  return true;
}

/** Mount every placement this page supports. Safe to call on any page. */
export function mountAdSlots() {
  mountHeaderAd();
  mountSidebarAd();
  mountNativeAds();
  mountPopunder();
  mountInterstitial();
}
