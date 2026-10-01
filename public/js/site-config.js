// ZoFHub · site-config.js — the page's one request for /api/site-config.
// ---------------------------------------------------------------------------
// Several modules need the same answer: layout.js (announcement, feature
// switches, advertising), game-page.js (whether a pre-roll comes before the
// game), browser.js (the approved destinations) and support-gate.js (whether
// the ad-block gate applies). Each used to fetch it for itself — layout.js
// alone asked twice — so an ordinary page view cost two or three identical
// requests. At a million page views that is millions of requests nobody needed.
//
// Every importer shares this ONE promise. Import it with exactly this
// specifier ('./site-config.js', no query string): an ES module is a singleton
// per URL, and a different spelling would be a second module and a second fetch.
//
// It resolves to the parsed config, or null when the endpoint is unreachable —
// never rejects. Every caller already has a "no config → the page works as it
// always did" path, and a rejection would only force each of them to repeat it.
//
// The page's own path travels as ?surface= so the server can decide what
// advertising this page may carry (a proxy page gets every ad field empty).
// No credentials: nothing in the answer depends on a cookie.
// ---------------------------------------------------------------------------

export const siteConfig = fetch(`/api/site-config?surface=${encodeURIComponent(location.pathname)}`, {
  credentials: 'omit',
})
  .then((r) => (r.ok ? r.json() : null))
  .then((cfg) => (cfg && typeof cfg === 'object' ? cfg : null))
  .catch(() => null);

export default siteConfig;
