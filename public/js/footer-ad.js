// ZoFHub · footer-ad.js — one clean, isolated footer banner.
// ---------------------------------------------------------------------------
// A single responsive banner (728×90 desktop / 320×50 mobile) mounted at the
// ABSOLUTE bottom of the layout, inside its own bar with a top divider and
// generous spacing so it can NEVER be mistaken for — or overlap — a nav button.
// That accidental-click isolation is what protects your ad-account reputation.
//
// It also honors your existing hub/proxy split automatically:
//   • HUB build  (window.ZOFHUB_ADSENSE set) → renders an AdSense unit slot
//     that your ads.js fills. Set data-ad-slot to your 728×90 unit id.
//   • PROXY build (window.ZOFHUB_PROXY) → does NOT load Google (that's banned on
//     proxy domains). Instead it leaves a clearly-marked container where you drop
//     your proxy-friendly network's banner tag (Monetag / Adsterra / HilltopAds).
//   • Neither configured → the bar stays hidden, so visitors never see an empty box.
//
// USAGE:
//   import { mountFooterAd } from './footer-ad.js';
//   mountFooterAd();                 // appends to <body> (or pass a container)
// ---------------------------------------------------------------------------

// Your AdSense 728×90 ad-unit slot id (numbers only), if you use manual units on
// the hub. Leave '' to rely on AdSense Auto Ads (the slot then just reserves space).
const ADSENSE_LEADERBOARD_SLOT = '';

export function mountFooterAd(target = document.body) {
  if (!target || document.querySelector('.fad-bar')) return; // mount once

  const onProxyBuild = typeof window !== 'undefined' && window.ZOFHUB_PROXY === true;
  const adsenseClient = (typeof window !== 'undefined' && window.ZOFHUB_ADSENSE) || '';

  // Compliance guard: never render Google ad markup on the proxy build/routes.
  // With no hub AdSense AND no proxy network wired up, don't show an empty bar.
  const hasProxyNetwork = onProxyBuild && Array.isArray(window.ZOFHUB_PROXY_ADS) && window.ZOFHUB_PROXY_ADS.length;
  if (!onProxyBuild && !adsenseClient) return;   // hub, but ads not configured → hide
  if (onProxyBuild && !hasProxyNetwork) return;  // proxy, but no network → hide

  const bar = document.createElement('aside');
  bar.className = 'fad-bar';
  bar.setAttribute('aria-label', 'Advertisement');

  const label = document.createElement('span');
  label.className = 'fad-label';
  label.textContent = 'Advertisement';

  const slot = document.createElement('div');
  slot.className = 'fad-slot';

  if (onProxyBuild) {
    // PROXY BUILD — no Google. Your proxy-ads.js already injects the network's
    // page-level script from PROXY_AD_SCRIPTS; if that network also gives you an
    // inline BANNER tag for a fixed container, paste it here. Example (Adsterra):
    //
    //   slot.innerHTML = `<script async data-cfasync="false"
    //     src="//your-adsterra-domain/INVOKE.js"></script>
    //     <div id="container-XXXXXXXX"></div>`;
    //
    // Until you add one, this container simply reserves clean, labeled space.
    slot.dataset.proxyBanner = '1';
  } else {
    // HUB BUILD — a standard AdSense leaderboard unit. ads.js fills .ad-slot
    // elements, so we speak its data-* convention and let it do the work.
    slot.classList.add('ad-slot');
    slot.setAttribute('data-ad-type', 'leaderboard');
    if (ADSENSE_LEADERBOARD_SLOT) slot.setAttribute('data-ad-slot', ADSENSE_LEADERBOARD_SLOT);
  }

  bar.appendChild(label);
  bar.appendChild(slot);
  target.appendChild(bar);
  return bar;
}
