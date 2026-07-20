// ZoFHub · proxy-ads.js — monetization for the PROXY build ONLY.
// ---------------------------------------------------------------------------
// Google AdSense/AdX are prohibited on proxy / anonymizer domains (an
// account-LEVEL ban, not per-page). So the proxy build earns from a
// proxy-friendly ad network instead — e.g. Monetag, Adsterra, HilltopAds,
// Galaksion. You paste your network's loader-script URL(s) into the
// PROXY_AD_SCRIPTS env var (comma-separated https URLs); the server hands them
// to the page via /api/site-config → window.ZOFHUB_PROXY_ADS, and this file
// injects them.
//
// HARD GUARANTEES (so your AdSense account can never be put at risk):
//   • Runs ONLY when window.ZOFHUB_PROXY === true (the proxy build).
//   • Injects ONLY the exact https script URLs you configured.
//   • Loads NO Google/AdSense/AdX code and imports nothing from ads.js.
// If nothing is configured, this file does nothing — the proxy site just runs
// ad-free until you add a network.
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
