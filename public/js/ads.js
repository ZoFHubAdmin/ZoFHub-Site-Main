// ZoFHub · ads.js — ONE switch + engine for ads across the whole site.
// ---------------------------------------------------------------------------
// HOW TO TURN ADS ON (two steps):
//   1) Put your AdSense publisher id in CONFIGURED_CLIENT below (or set
//      window.ZOFHUB_ADSENSE = 'ca-pub-…' before this module loads).
//   2) In your AdSense dashboard create ONE ad unit per format and paste the
//      numeric slot ids into SLOT_IDS. Each id is reused across every placement
//      of that format, so a handful of ids light up the whole site.
//      (Leave them blank to use AdSense Auto Ads, which need only the publisher
//      id — in that mode the manual slots stay hidden and AdSense auto-places.)
//
// Once configured this fills EVERY reserved slot on every page — top & bottom
// leaderboards, left/right skyscrapers, 300×250 boxes, in-feed grid units, the
// between-row banners, plus a dismissible sticky bottom anchor — and keeps
// their space reserved (no layout shift). While unconfigured, all ad slots are
// hidden so visitors never see empty boxes. Loaded once from layout.js on
// every page; also catches slots added later (catalog paging) via an observer.
// ---------------------------------------------------------------------------
const CONFIGURED_CLIENT = ''; // <-- e.g. 'ca-pub-1234567890123456'
const ADSENSE_CLIENT = ((typeof window !== 'undefined' && window.ZOFHUB_ADSENSE) || CONFIGURED_CLIENT || '').trim();

// AD-NETWORK COMPLIANCE — never run ANY ad code on the proxy browser / web-proxy
// utility routes. Proxy / anonymizer pages are NOT eligible for AdSense, AdX, or
// MCM (Google Publisher Policies), and serving ads — or even Auto Ads / fake
// placeholders — on them is an ACCOUNT-LEVEL risk, not just a per-page one. This
// module bails out entirely on these paths so no ad markup, no AdSense script,
// and no Auto Ads ever load there. (Belt-and-suspenders: browser.html pulls in
// layout.js → this file; the /gust page does not, but the guard covers both.)
const AD_FREE_ROUTE = /^\/(browser|gust|proxy|uv|scram|epoxy|baremux|bare|wisp)(\/|$)/i;
const onAdFreeRoute = typeof location !== 'undefined' && AD_FREE_ROUTE.test(location.pathname);

// PREVIEW MODE — when no AdSense id is configured yet, show tasteful labelled
// "Advertisement" placeholders in every reserved slot so you can SEE the ad
// inventory and layout while building. Real AdSense units replace them the
// moment you set CONFIGURED_CLIENT above.
// Ad slots are HIDDEN by default everywhere — pages render clean, no empty/fake
// boxes, no clutter. To SEE where every slot sits, add ?ads=preview to any URL
// and labelled "Advertisement" placeholders appear. A real ADSENSE_CLIENT shows
// real ads instead. Preview is opt-in only (AdSense forbids fake ad markup to
// real visitors), so normal testing and real traffic both stay clean.
const PREVIEW_PLACEHOLDERS = typeof location !== 'undefined' && /[?&]ads=preview\b/.test(location.search);
const previewMode = !ADSENSE_CLIENT && PREVIEW_PLACEHOLDERS;

// One AdSense ad-unit slot id per format. Blank → that format relies on Auto Ads.
const SLOT_IDS = {
  leaderboard: '', // 728×90 / responsive horizontal (top, bottom, between rows, in-feed)
  skyscraper:  '', // 160×600 vertical (left / right rails)
  box:         '', // 300×250 rectangle (rails, around games)
  anchor:      '', // sticky bottom banner
};

// Are the game-page side rails going to carry any real units? If not, the game
// grid collapses to full width (no empty gutters).
const railsActive = !!(SLOT_IDS.skyscraper || SLOT_IDS.box);

const FILL_SELECTOR = '.ad-slot, .catalog-ad-top, .catalog-ad-bottom';
const HIDE_SELECTOR = '.ad-slot, .ad-rail, .ad-leaderboard, .catalog-ad-top, .catalog-ad-bottom, .zad-anchor';

const CSS = `
.ad-slot{display:grid;place-items:center;background:rgba(255,255,255,.03);border:1px dashed rgba(255,255,255,.12);border-radius:12px;overflow:hidden;contain:layout}
.ad-slot ins{display:block;width:100%;height:100%}
.ad-300x250{width:100%;max-width:300px;min-height:250px;margin:14px auto 0}
.ad-inline{width:100%;max-width:970px;min-height:90px;margin:18px auto}
.ad-ingrid{grid-column:1/-1;width:100%;min-height:90px;margin:6px 0}
.ad-leaderboard.ad-top{margin:0 0 14px}
.ad-rail{flex-direction:column;align-items:center;gap:14px}
.play-layout.zad-norails{grid-template-columns:minmax(0,1fr)}
.play-layout.zad-norails .ad-rail{display:none}
.zad-anchor{position:fixed;left:0;right:0;bottom:0;z-index:60;display:flex;align-items:center;justify-content:center;min-height:60px;padding:6px 42px 6px 8px;background:rgba(10,12,24,.92);border-top:1px solid rgba(255,255,255,.12)}
.zad-anchor .ad-slot{border:none;background:none;min-height:50px;width:100%;max-width:970px}
.zad-anchor-close{position:absolute;right:8px;top:50%;transform:translateY(-50%);width:28px;height:28px;border-radius:50%;border:none;cursor:pointer;background:rgba(255,255,255,.14);color:#fff;font-size:18px;line-height:1}
body.has-anchor-ad{padding-bottom:80px}
body.has-anchor-ad #aiOrb,body.has-anchor-ad #aiRestore,body.has-anchor-ad .ai-orb,body.has-anchor-ad .ai-restore{bottom:94px!important}
@media(max-width:560px){body.has-anchor-ad{padding-bottom:66px}.zad-anchor{min-height:52px}}

/* ===== Preview placeholders (shown until a real AdSense id is set) ===== */
.ad-slot.ad-preview{
  position:relative;display:grid;place-items:center;
  background:
    repeating-linear-gradient(135deg,rgba(125,170,255,.05) 0 12px,rgba(125,170,255,.02) 12px 24px),
    linear-gradient(180deg,rgba(255,255,255,.035),rgba(255,255,255,.015));
  border:1px dashed rgba(125,170,255,.28);border-radius:12px;min-height:90px;overflow:hidden;
}
.ad-160x600{min-height:600px;width:160px}
.ad-728x90,.ad-leaderboard .ad-slot{min-height:90px}
.ad-preview-tag{
  display:inline-flex;align-items:center;gap:6px;
  font-size:10px;font-weight:800;letter-spacing:.18em;text-transform:uppercase;
  color:rgba(190,210,255,.55);
}
.ad-preview-tag::before{content:"";width:6px;height:6px;border-radius:50%;background:rgba(125,170,255,.5)}
.ad-preview-dim{font-size:9px;letter-spacing:.1em;color:rgba(190,210,255,.34);margin-top:3px}
.ad-rail{flex-direction:column;align-items:center;gap:14px}
.zad-anchor .ad-slot.ad-preview{border:none;background:linear-gradient(180deg,rgba(255,255,255,.04),rgba(255,255,255,.02))}
`;

function injectCss() {
  if (document.getElementById('zad-css')) return;
  const st = document.createElement('style');
  st.id = 'zad-css';
  st.textContent = CSS;
  document.head.appendChild(st);
}

function loadAdSenseOnce() {
  if (document.querySelector('script[data-adsense]')) return;
  const s = document.createElement('script');
  s.async = true; s.crossOrigin = 'anonymous'; s.dataset.adsense = '1';
  s.src = 'https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=' + encodeURIComponent(ADSENSE_CLIENT);
  document.head.appendChild(s);
}

function slotIdFor(slot) {
  const explicit = slot.getAttribute('data-ad-slot');
  if (explicit) return explicit;
  const type = slot.getAttribute('data-ad-type');
  return (type && SLOT_IDS[type]) ? SLOT_IDS[type] : '';
}

function fillSlot(slot) {
  if (slot.dataset.adDone) return;
  slot.dataset.adDone = '1';
  const id = slotIdFor(slot);
  if (!id) { slot.style.display = 'none'; return; } // no id → Auto Ads handles the page; hide empty box
  const ins = document.createElement('ins');
  ins.className = 'adsbygoogle';
  ins.style.cssText = 'display:block;width:100%;height:100%';
  ins.setAttribute('data-ad-client', ADSENSE_CLIENT);
  ins.setAttribute('data-ad-slot', id);
  ins.setAttribute('data-ad-format', 'auto');
  ins.setAttribute('data-full-width-responsive', 'true');
  slot.innerHTML = '';
  slot.appendChild(ins);
  try { (window.adsbygoogle = window.adsbygoogle || []).push({}); } catch (e) { /* blocked / offline */ }
}

// Friendly size hint per format, shown under the "Advertisement" tag.
const DIM_HINT = { leaderboard: '728 × 90', skyscraper: '160 × 600', box: '300 × 250', anchor: '970 × 90' };

function fillPlaceholder(slot) {
  if (slot.dataset.adDone) return;
  slot.dataset.adDone = '1';
  // Reserve plain, UNLABELLED space — no "Advertisement" text, no announcement.
  // Just a clean, subtle block that holds the slot's reserved size so the layout
  // is stable and you can see where an ad will sit. Inline styles override the
  // base .ad-slot dashed look so it reads as intentional empty space.
  slot.classList.add('ad-space');
  slot.style.background = 'rgba(255,255,255,.03)';
  slot.style.border = '1px solid rgba(255,255,255,.06)';
  slot.style.borderRadius = '12px';
  slot.innerHTML = '';
}

// Route a slot to the right behavior: real ad → placeholder preview → hide.
function mountSlot(slot) {
  if (ADSENSE_CLIENT) return fillSlot(slot);
  if (PREVIEW_PLACEHOLDERS) return fillPlaceholder(slot);
  return hideEl(slot);
}

function hideEl(el) { el.style.display = 'none'; }

function makeSlot(type, extraClass) {
  const d = document.createElement('div');
  d.className = 'ad-slot ' + (extraClass || '');
  d.setAttribute('data-ad-type', type);
  return d;
}

// Slots injected on every page (or only on pages that don't author their own),
// so ad coverage is guaranteed even on pages this file doesn't edit.
function injectUniversal() {
  // The AI page is a fixed-height chat app (.ai-shell, a 100dvh grid): a sticky
  // bottom anchor would cover the composer and an inline leaderboard would land
  // as a stray grid cell. Inject NO ads there (it has no authored slots either).
  if (document.body.classList.contains('page-ai') || document.querySelector('.ai-shell')) return;

  // Dismissible sticky bottom anchor — the highest-viewability spot, every page.
  if (!document.querySelector('.zad-anchor')) {
    const bar = document.createElement('div');
    bar.className = 'zad-anchor';
    const slot = makeSlot('anchor', 'zad-anchor-slot');
    const close = document.createElement('button');
    close.className = 'zad-anchor-close';
    close.setAttribute('aria-label', 'Close ad');
    close.innerHTML = '&times;';
    close.addEventListener('click', () => { bar.remove(); document.body.classList.remove('has-anchor-ad'); });
    bar.appendChild(slot); bar.appendChild(close);
    document.body.appendChild(bar);
    document.body.classList.add('has-anchor-ad');
    mountSlot(slot);
    if (slot.style.display === 'none') { bar.remove(); document.body.classList.remove('has-anchor-ad'); } // no anchor id → no bar
  }

  // Top + pre-footer leaderboards on pages WITHOUT their own catalog/game slots
  // (ai, community, browser, …). Catalog & game pages author their own.
  if (!document.querySelector('.catalog-main, .play-layout')) {
    const main = document.querySelector('main') || document.querySelector('.frame-inner') || document.body;
    const top = makeSlot('leaderboard', 'ad-inline zad-top');
    main.insertBefore(top, main.firstChild);
    mountSlot(top);
    const footer = document.querySelector('.site-footer');
    if (footer && footer.parentNode) {
      const bottom = makeSlot('leaderboard', 'ad-inline zad-bottom');
      footer.parentNode.insertBefore(bottom, footer);
      mountSlot(bottom);
    }
  }
}

function processNew(node) {
  if (ADSENSE_CLIENT) {
    if (node.matches && node.matches('.ad-slot')) fillSlot(node);
    if (node.querySelectorAll) node.querySelectorAll('.ad-slot').forEach(fillSlot);
  } else if (PREVIEW_PLACEHOLDERS) {
    if (node.matches && node.matches('.ad-slot')) fillPlaceholder(node);
    if (node.querySelectorAll) node.querySelectorAll('.ad-slot').forEach(fillPlaceholder);
  } else {
    if (node.matches && node.matches(HIDE_SELECTOR)) hideEl(node);
    if (node.querySelectorAll) node.querySelectorAll(HIDE_SELECTOR).forEach(hideEl);
  }
}

function tidyWrappers() {
  // Hide rail / leaderboard wrappers that ended up with no real ad unit so the
  // page never shows an empty reserved box.
  document.querySelectorAll('.ad-rail, .ad-leaderboard').forEach(w => {
    if (!w.querySelector('ins.adsbygoogle')) w.style.display = 'none';
  });
}

function start() {
  // Proxy / utility routes: no ads of any kind (compliance — see AD_FREE_ROUTE).
  // ALSO bail on the entire proxy DOMAIN (full build, window.ZOFHUB_PROXY===true):
  // a proxy/anonymizer site must carry no Google ads ANYWHERE, account-level rule.
  // (Server already withholds the ad client there; this is belt-and-suspenders.)
  // Also strip any author-placed ad slots so nothing renders if the page shipped some.
  const onProxyBuild = typeof window !== 'undefined' && window.ZOFHUB_PROXY === true;
  if (onAdFreeRoute || onProxyBuild) {
    document.querySelectorAll(HIDE_SELECTOR).forEach(hideEl);
    return;
  }
  document.querySelectorAll('.ad-label').forEach(el => el.remove()); // dev labels never reach users
  injectCss();

  if (ADSENSE_CLIENT) {
    // Reveal ad containers (they're hidden by default in CSS until ads are live,
    // so no empty placeholder boxes ever flash before this runs — see main.css).
    document.body.classList.add('zad-on');
    loadAdSenseOnce();
    injectUniversal();
    document.querySelectorAll(FILL_SELECTOR).forEach(fillSlot);
    tidyWrappers();
    if (!railsActive) { const pl = document.querySelector('.play-layout'); if (pl) pl.classList.add('zad-norails'); }
  } else if (PREVIEW_PLACEHOLDERS) {
    // Show the full ad inventory as labelled placeholders so layout is visible.
    document.body.classList.add('zad-preview');
    injectUniversal();
    document.querySelectorAll(FILL_SELECTOR).forEach(fillPlaceholder);
  } else {
    document.body.classList.add('zad-off');
    document.querySelectorAll(HIDE_SELECTOR).forEach(hideEl);
    const pl = document.querySelector('.play-layout'); if (pl) pl.classList.add('zad-norails');
  }

  // Catalog paging adds more tiles/ad nodes later — handle them too, cheaply
  // (only react to added subtrees, ~60 nodes per page render).
  const obs = new MutationObserver(muts => {
    for (const m of muts) for (const n of m.addedNodes) {
      if (n.nodeType === 1) processNew(n);
    }
  });
  obs.observe(document.body, { childList: true, subtree: true });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
else start();
