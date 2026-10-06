// ZoFHub · telemetry.js — the two aggregate quality signals, and nothing else.
// ---------------------------------------------------------------------------
// WHAT THIS SENDS
//
//   1. A game failed to render  -> { slug, kind }
//   2. Core Web Vitals, sampled -> { path, metrics: [{ name, value }] }
//
// WHAT THIS DELIBERATELY DOES NOT TOUCH
//
// This file reads NONE of the following, and that is the point of it existing as
// one small auditable module rather than scattered calls:
//
//   screen.width / height / availWidth      devicePixelRatio
//   navigator.connection / effectiveType    navigator.hardwareConcurrency
//   navigator.deviceMemory                  navigator.getBattery
//   Intl…resolvedOptions().timeZone         canvas toDataURL / WebGL info
//   navigator.userAgentData.getHighEntropyValues
//
// Every one of those is a fingerprinting vector, and none of them answers a
// question we actually have. `grep` this file for any of them and you get
// nothing — that is a test anybody can run in five seconds.
//
// There is no identifier here either: no cookie, no localStorage, no session id,
// no generated visitor id. Nothing is persisted between page loads, so there is
// nothing for a later request to be correlated against. The server reduces the
// User-Agent it already received to one of seven browser families and throws the
// rest away (see lib/telemetry.mjs); the client never sends it.
//
// The raw metric value IS sent, then bucketed server-side into
// good/needs_improvement/poor and discarded. It is sent rather than bucketed
// here so the thresholds live in exactly one place and can be corrected without
// a cache-busting deploy of this file.
//
// No dependency. The `web-vitals` npm package would do this more thoroughly, but
// it would be a third-party script on a site whose whole premise is that filtered
// networks block third-party scripts — so these are implemented against the
// native PerformanceObserver API instead.
// ---------------------------------------------------------------------------

// Sample rate for Core Web Vitals. One in ten page loads is plenty: these are
// distributions, and the tenth decimal place of a good-rate changes no decision.
// Failures are NOT sampled — a broken game is rare and every report matters.
const VITALS_SAMPLE_RATE = 0.1;

/** Fire-and-forget POST. Beacon when we can, keepalive fetch otherwise. */
function send(url, payload) {
  try {
    const body = JSON.stringify(payload);
    if (navigator.sendBeacon) {
      // A Blob with an explicit JSON type so the server's express.json() parses
      // it; a bare string would arrive as text/plain.
      if (navigator.sendBeacon(url, new Blob([body], { type: 'application/json' }))) return;
    }
    // keepalive lets the request outlive the page, which matters on pagehide.
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      keepalive: true,
    }).catch(() => {});
  } catch { /* telemetry must never throw into the page */ }
}

// ── 1. Game render failures ────────────────────────────────────────────────

let failureSent = false;

/**
 * Report that this game did not render. Called from the ONE place that already
 * knows it for certain: the iframe loader's showError(), i.e. the moment a
 * visitor is actually shown "Couldn't load this game".
 *
 * Reported at most once per page load. A retry that fails again is the same
 * broken game, and counting it twice would make a game look worse the more
 * patient the visitor was.
 *
 * @param {'blank'|'timeout'|'refused'|'http_error'|'script_error'} kind
 */
export function reportGameFailure(kind) {
  if (failureSent) return;
  const slug = window.ZOFHUB_GAME?.slug;
  if (!slug) return;
  failureSent = true;
  send('/api/telemetry/failure', { slug, kind: kind || 'timeout' });
}

// ── 2. Core Web Vitals ─────────────────────────────────────────────────────

/**
 * Observe the vitals that exist on this browser and report them once, on the way
 * out. Safe to call on any page; does nothing if the APIs are missing (Safari
 * has no INP support, for instance) or if this load was not sampled.
 */
export function startVitals() {
  if (typeof PerformanceObserver === 'undefined') return;
  if (Math.random() >= VITALS_SAMPLE_RATE) return;

  const metrics = new Map();   // name -> value (last value wins)
  const observers = [];

  const observe = (type, handler, extra = {}) => {
    try {
      const po = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) handler(entry);
      });
      // buffered:true collects entries that fired before this ran — without it,
      // FCP and LCP are usually already gone by the time a module executes.
      po.observe({ type, buffered: true, ...extra });
      observers.push(po);
    } catch { /* unsupported entry type on this browser — skip it */ }
  };

  // LCP: the last largest-contentful-paint entry before the page is backgrounded.
  observe('largest-contentful-paint', (e) => metrics.set('LCP', e.startTime));

  // FCP: one entry, among the paint timings.
  observe('paint', (e) => {
    if (e.name === 'first-contentful-paint') metrics.set('FCP', e.startTime);
  });

  // CLS: the real metric is the largest SESSION WINDOW, not the lifetime sum --
  // a window ends after a 1s gap or at 5s total. Summing everything instead
  // would punish a long session for shifts a visitor never saw together, and a
  // game page that is open for an hour would drift into 'poor' on its own.
  let clsValue = 0, sessionValue = 0, sessionStart = 0, sessionLast = 0;
  observe('layout-shift', (e) => {
    if (e.hadRecentInput) return;              // a shift the user caused is not a defect
    if (sessionValue && (e.startTime - sessionLast > 1000 || e.startTime - sessionStart > 5000)) {
      sessionValue = 0;
    }
    if (!sessionValue) sessionStart = e.startTime;
    sessionLast = e.startTime;
    sessionValue += e.value;
    if (sessionValue > clsValue) clsValue = sessionValue;
    metrics.set('CLS', clsValue);
  });

  // INP: the worst interaction latency we saw. True INP is a high percentile of
  // all interactions; the max is the honest simplification for a good/poor
  // bucket, and it errs pessimistic rather than flattering.
  observe('event', (e) => {
    if (!e.interactionId) return;              // not a real user interaction
    const worst = Math.max(metrics.get('INP') || 0, e.duration);
    metrics.set('INP', worst);
  }, { durationThreshold: 40 });

  // TTFB: straight off the navigation entry, no observer needed.
  try {
    const nav = performance.getEntriesByType('navigation')[0];
    if (nav && Number.isFinite(nav.responseStart) && nav.responseStart > 0) {
      metrics.set('TTFB', nav.responseStart);
    }
  } catch { /* no navigation timing */ }

  let flushed = false;
  const flush = () => {
    if (flushed) return;
    flushed = true;
    for (const po of observers) { try { po.takeRecords?.(); po.disconnect(); } catch {} }
    if (!metrics.size) return;
    send('/api/telemetry/vitals', {
      // The PATH only. The server reduces it to a page class, and a query string
      // on this site can carry a search term, so it is stripped here as well --
      // the data should not leave the browser in the first place.
      path: location.pathname,
      metrics: [...metrics].map(([name, value]) => ({ name, value })),
    });
  };

  // pagehide is the reliable end-of-page event; visibilitychange catches the
  // mobile case where a tab is backgrounded and never formally unloaded.
  addEventListener('pagehide', flush, { once: true });
  addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush();
  });
}

export default { reportGameFailure, startVitals };
