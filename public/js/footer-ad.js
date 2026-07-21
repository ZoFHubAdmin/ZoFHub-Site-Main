// ZoFHub · footer-ad.js — one clean, isolated footer banner (PROXY build).
// ---------------------------------------------------------------------------
// A single responsive display banner (728×90 desktop / 320×50 mobile) mounted at
// the ABSOLUTE bottom of the page, inside its own bar with a top divider and
// generous spacing so it can NEVER be mistaken for — or overlap — a nav control.
// That accidental-click isolation is what protects your ad-account reputation.
//
// WHERE IT RUNS
//   • PROXY build only (window.ZOFHUB_PROXY === true). On the HUB build, ads.js
//     already injects a bottom leaderboard, so this stays out to avoid a double
//     bar. The proxy build never loads Google (that's banned on proxy domains).
//
// WHAT FILLS IT
//   • Your proxy-friendly network's fixed BANNER tag, configured server-side in
//     the PROXY_BANNER_TAG env var → /api/site-config → window.ZOFHUB_PROXY_BANNER.
//     It's usually two <script> tags (e.g. an Adsterra / HilltopAds 728×90 unit).
//   • If NOTHING is configured, the bar never appears — no empty "Advertisement"
//     box is ever shown to a visitor. So it's armed and harmless until you set it.
//
// USAGE (already wired from layout.js on the proxy build):
//   import { mountFooterAd } from './footer-ad.js';
//   mountFooterAd();                 // appends to <body> (or pass a container)
// ---------------------------------------------------------------------------

// Belt-and-suspenders: never render Google ad markup on the proxy build (the
// server already refuses it, but we re-check the tag here before touching the DOM).
const GOOGLE_AD_RE = /googlesyndication|googleadservices|adsbygoogle|doubleclick/i;

const CSS = `
.fad-bar{width:100%;margin-top:28px;padding:10px 12px 14px;border-top:1px solid rgba(255,255,255,.08);background:rgba(6,10,22,.6);display:flex;flex-direction:column;align-items:center;gap:6px}
.fad-label{font-size:9px;font-weight:800;letter-spacing:.22em;text-transform:uppercase;color:rgba(190,210,255,.4)}
.fad-slot{display:grid;place-items:center;overflow:hidden;width:100%;max-width:728px;min-height:90px;border-radius:10px;background:rgba(255,255,255,.03);isolation:isolate;position:relative}
.fad-slot > *{max-width:100%}
@media(max-width:500px){.fad-slot{max-width:320px;min-height:50px}}
`;

function injectCss() {
  if (document.getElementById('fad-css')) return;
  const st = document.createElement('style');
  st.id = 'fad-css';
  st.textContent = CSS;
  document.head.appendChild(st);
}

// Inject an ad snippet WITH script execution. Setting innerHTML alone will NOT
// run <script> tags, so we parse the configured markup in an inert <template>
// and re-create each script node (copying attributes + inline code) in order, so
// an inline config script runs before the loader that reads it — how banner tags
// like Adsterra's atOptions + invoke.js pair expect to execute.
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

export function mountFooterAd(target = document.body) {
  if (typeof window === 'undefined' || !document.body) return;
  if (document.querySelector('.fad-bar')) return;               // mount once

  // PROXY build only — the hub build's banner is owned by ads.js.
  if (window.ZOFHUB_PROXY !== true) return;

  // Only render when a REAL banner tag is configured. No tag → no bar (no empty box).
  const bannerTag = (typeof window.ZOFHUB_PROXY_BANNER === 'string' ? window.ZOFHUB_PROXY_BANNER : '').trim();
  if (!bannerTag) return;
  if (GOOGLE_AD_RE.test(bannerTag)) return;                     // never Google on the proxy build

  // Layout-sensitive pages: the AI chat is a fixed-height grid — a bottom bar
  // would cover the composer. Skip there, exactly as ads.js does.
  if (document.body.classList.contains('page-ai') || document.querySelector('.ai-shell')) return;

  injectCss();

  const bar = document.createElement('aside');
  bar.className = 'fad-bar';
  bar.setAttribute('aria-label', 'Advertisement');

  const label = document.createElement('span');
  label.className = 'fad-label';
  label.textContent = 'Advertisement';

  const slot = document.createElement('div');
  slot.className = 'fad-slot';
  slot.dataset.proxyBanner = '1';

  bar.appendChild(label);
  bar.appendChild(slot);
  (target || document.body).appendChild(bar);

  injectMarkup(slot, bannerTag);
  return bar;
}
