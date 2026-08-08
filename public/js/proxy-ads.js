// ZoFHub · proxy-ads.js — page-level ad loader scripts.
// ---------------------------------------------------------------------------
// NAME NOTE: "proxy-ads" means "ads on a site that HAPPENS to host a proxy",
// not "ads on proxied pages". It has never meant the latter, and must not: this
// module is only ever imported from layout.js, which refuses to load the ad
// stack on a proxy surface at all. See lib/ad-providers.mjs → isAdSurface.
//
// Loads the page-level loader script URL(s) contributed by whichever of the five
// supported networks (HilltopAds, Adsterra, Monetag, Ad-Maven, PopAds) are
// enabled. The server resolves those in lib/ad-providers.mjs and hands the final
// list to the page via /api/site-config → window.ZOFHUB_PROXY_ADS.
//
// HARD GUARANTEES:
//   • Injects ONLY the exact https URLs the server resolved. No rewriting, no
//     wrapping, no parameter injection — several networks require their code to
//     run unmodified, and modifying it would also look like tampering with
//     their attribution.
//   • Each URL is injected AT MOST ONCE per page, so a misconfiguration that
//     lists the same loader under two networks cannot double-load it.
//   • Loads NO Google/AdSense/AdX code, ever. Google bans proxy domains at the
//     ACCOUNT level, so one stray tag could take down an unrelated account.
//   • Failure is silent and total: a blocked or offline network leaves the page
//     exactly as it was. No retries, no reloads, no placeholder boxes.
// If nothing is configured, this file does nothing.
// ---------------------------------------------------------------------------

(function () {
  // Belt-and-suspenders: never run outside the proxy build.
  if (typeof window === 'undefined' || window.ZOFHUB_PROXY !== true) return;

  const scripts = Array.isArray(window.ZOFHUB_PROXY_ADS) ? window.ZOFHUB_PROXY_ADS : [];
  if (!scripts.length) return;

  const injected = new Set();
  for (const raw of scripts) {
    const url = String(raw || '').trim();
    // Only allow https script URLs, and never anything that looks like Google's
    // ad stack (that belongs on the hub build only).
    if (!/^https:\/\//i.test(url)) continue;
    if (/googlesyndication|googleadservices|adsbygoogle|doubleclick/i.test(url)) continue;
    if (injected.has(url)) continue;
    injected.add(url);
    try {
      const s = document.createElement('script');
      s.src = url;
      s.async = true;
      s.dataset.proxyAd = '1';
      // Most pop/interstitial networks want to run as-is; do not set crossOrigin
      // (many of their tags 404 the CORS preflight). They self-manage from here.
      document.head.appendChild(s);
    } catch (e) { /* ad blocker / offline — ignore, the site still works */ }
  }
})();
