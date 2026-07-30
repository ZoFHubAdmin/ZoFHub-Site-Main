// ZoFHub · ad-slots.js — header banner, sidebar rectangle, interstitial governor.
// ---------------------------------------------------------------------------
// This is the SECOND half of the ad system. The first half already exists and is
// untouched:
//   • proxy-ads.js  — injects PROXY_AD_SCRIPTS loader URLs (popunder/push/social
//                     bar/interstitial — formats the NETWORK places by itself).
//   • footer-ad.js  — the isolated footer banner from PROXY_BANNER_TAG.
//
// What this file adds is the two placements a network CANNOT place on its own,
// because they need a real container in OUR layout:
//   • Header leaderboard  728×90  (desktop) / 320×50 (mobile) → PROXY_HEADER_TAG
//   • Sidebar rectangle   300×250                             → PROXY_SIDEBAR_TAG
// …plus `adFrequencyController`, a localStorage throttle so a network's
// interstitial can't fire on every game launch.
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

const GOOGLE_AD_RE = /googlesyndication|googleadservices|adsbygoogle|doubleclick/i;

// Sizes are declared here and rendered into CSS so the reserved box and the
// creative can never disagree.
const HEADER = { w: 728, h: 90, mobileW: 320, mobileH: 50 };
const SIDEBAR = { w: 300, h: 250 };

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
// matters: banner tags are usually an inline config block (e.g. Adsterra's
// `atOptions = {...}`) followed by the loader that READS that global. Reversing
// them silently serves a blank slot.
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

// ── Header leaderboard ─────────────────────────────────────────────────────
// Mounted directly AFTER <header class="site-header">, so it lands above the
// content frame in normal document flow — no overlap with the sticky header.
export function mountHeaderAd() {
  if (typeof window === 'undefined' || !document.body) return;
  if (document.querySelector('.zad-header-bar')) return;              // mount once

  const tag = readTag('ZOFHUB_HEADER_TAG');
  if (!tag) return;                                                   // rule 1: no tag → no slot

  // The AI page is a fixed-height flex/grid shell; inserting a band above it
  // would push the composer below the fold. Same exclusion footer-ad.js uses.
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
  console.log('[zofhub-ads] header slot mounted (%d×%d reserved)', HEADER.w, HEADER.h);
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
  console.log('[zofhub-ads] sidebar slot mounted (%d×%d reserved)', SIDEBAR.w, SIDEBAR.h);
  return wrap;
}

// ── adFrequencyController ──────────────────────────────────────────────────
// Networks that sell interstitials (PropellerAds, Adcash, …) will happily fire
// one on EVERY page view. On a games site that means a full-screen ad between a
// player and the game they just clicked — the fastest way to lose the audience
// that generates the traffic in the first place.
//
// This is a local throttle: ask before triggering, and it says no unless enough
// time has passed. State lives in localStorage so it survives reloads and is
// shared across tabs on the same device.
//
//   import { adFrequencyController } from './ad-slots.js';
//   if (adFrequencyController.allow('interstitial')) { /* fire it */ }
//
// It CANNOT throttle what a network's own loader does internally (that is the
// network's dashboard setting — set the cap there too). What it does guarantee
// is that OUR code never asks more often than this.
const FREQ_KEY = 'zofhub.adfreq.v1';
const DEFAULT_COOLDOWN_MS = 20 * 60 * 1000;   // 20 minutes

function readState() {
  try {
    const raw = localStorage.getItem(FREQ_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return (parsed && typeof parsed === 'object') ? parsed : {};
  } catch { return {}; }        // private mode / storage disabled / corrupt JSON
}

function writeState(state) {
  try { localStorage.setItem(FREQ_KEY, JSON.stringify(state)); } catch { /* non-fatal */ }
}

export const adFrequencyController = {
  /**
   * May `slot` fire right now? Records the timestamp when it returns true, so a
   * caller cannot ask twice and get two yeses.
   * @param {string} slot        logical name, e.g. 'interstitial'
   * @param {number} cooldownMs  minimum gap between fires (default 20 min)
   */
  allow(slot = 'interstitial', cooldownMs = DEFAULT_COOLDOWN_MS) {
    // If storage is unavailable we cannot throttle, so we deliberately fail
    // CLOSED (return false). An untracked interstitial that fires on every
    // single game launch is far worse than no interstitial at all.
    let store;
    try { store = window.localStorage; } catch { return false; }
    if (!store) return false;

    const now = Date.now();
    const state = readState();
    const last = Number(state[slot]) || 0;

    // A clock that jumped backwards (timezone change, manual set) would leave
    // `last` in the future and block the slot forever — treat that as expired.
    if (last > now) { state[slot] = now; writeState(state); return true; }
    if (now - last < cooldownMs) return false;

    state[slot] = now;
    writeState(state);
    return true;
  },

  /** Seconds until `slot` is allowed again (0 = allowed now). Read-only. */
  cooldownRemaining(slot = 'interstitial', cooldownMs = DEFAULT_COOLDOWN_MS) {
    const last = Number(readState()[slot]) || 0;
    if (!last) return 0;
    const left = cooldownMs - (Date.now() - last);
    return left > 0 ? Math.ceil(left / 1000) : 0;
  },

  /** Clear throttle state (testing / "why isn't my ad showing" debugging). */
  reset(slot) {
    if (!slot) { try { localStorage.removeItem(FREQ_KEY); } catch {} return; }
    const state = readState();
    delete state[slot];
    writeState(state);
  },
};

// Expose for console debugging and for any non-module inline script that wants
// to gate its own interstitial call.
if (typeof window !== 'undefined') window.adFrequencyController = adFrequencyController;

/** Mount every slot this page supports. Safe to call on any page. */
export function mountAdSlots() {
  mountHeaderAd();
  mountSidebarAd();
}
