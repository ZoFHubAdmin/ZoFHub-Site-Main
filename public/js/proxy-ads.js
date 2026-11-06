// ZoFHub · proxy-ads.js — page-level ad loader scripts.
// ---------------------------------------------------------------------------
// NAME NOTE: "proxy-ads" is a historical name, from when this site also hosted a
// proxy browser. The browser is gone; this is simply the page-level ad loader for
// the hub pages. It is only ever imported from layout.js, after the server has
// approved an ad config. See lib/ad-providers.mjs.
//
// Loads the page-level loader script URL(s) for the one role that is nothing but
// a loader: HilltopAds' in-page push (HILLTOPADS_PUSH_SCRIPT). Every other
// network owns a placement with a container and is mounted by ad-slots.js or
// preroll.js. The server resolves this in lib/ad-providers.mjs and hands the
// final list to the page via /api/site-config → window.ZOFHUB_PROXY_ADS.
//
// HARD GUARANTEES:
//   • Injects ONLY the exact https URLs the server resolved. No rewriting, no
//     wrapping, no parameter injection — several networks require their code to
//     run unmodified, and modifying it would also look like tampering with
//     their attribution.
//   • Each URL is injected AT MOST ONCE per page, so a misconfiguration that
//     lists the same loader under two networks cannot double-load it.
//   • Loads NO Google/AdSense/AdX code, ever.
//   • Failure is silent and total: a blocked or offline network leaves the page
//     exactly as it was. No retries, no reloads, no placeholder boxes.
// If nothing is configured, this file does nothing.
// ---------------------------------------------------------------------------

(function () {
  if (typeof window === 'undefined') return;

  const scripts = Array.isArray(window.ZOFHUB_PROXY_ADS) ? window.ZOFHUB_PROXY_ADS : [];
  if (!scripts.length) return;

  const injected = new Set();
  for (const raw of scripts) {
    const url = String(raw || '').trim();
    // Only allow https script URLs, and never anything that looks like Google's
    // ad stack.
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
