// lib/telemetry.mjs — aggregate-only, identity-free quality telemetry.
// ---------------------------------------------------------------------------
// WHAT THIS IS FOR
//
// Two questions this site could not previously answer:
//
//   1. "Which games are broken, and broken for WHOM?" A game that black-screens
//      only on iOS Safari looks perfectly healthy to the server-side link-check
//      (the URL returns 200) and to render-verification (it framed fine in
//      headless Chromium). Only a real browser failing to render it knows.
//   2. "Which pages are slow, for real visitors, on real networks?"
//
// WHAT THIS DELIBERATELY IS NOT
//
// There is no visitor here. Nothing in this module takes, derives, returns or
// stores an identifier, and that is enforced by shape rather than by promise:
// every function below maps its input onto a SMALL CLOSED VOCABULARY, and the
// counters the caller keeps are keyed by that vocabulary alone.
//
//   • No IP, no hash of an IP, no session id, no device id, no cookie.
//   • No raw user-agent string is ever stored. The UA is read ONCE, on the
//     request, reduced to one of seven browser families plus desktop/mobile,
//     and discarded. Seven families x two platforms = 14 possible values, so a
//     row cannot be narrowed toward a person no matter how many are collected.
//   • No raw metric VALUES. A Core Web Vital arrives as a number and is stored
//     as good / needs_improvement / poor. An exact LCP of 2473.8ms is a far
//     stronger identifier than the bucket anyone actually acts on.
//   • No timestamps finer than the flush, and no ordering between rows, so two
//     events cannot be stitched into one visitor's session.
//
// Everything is a COUNTER. The unit of storage is "this combination happened N
// times", never "this visitor did this". That is what makes the whole feature
// safe to run with no consent gate: there is no personal data to consent to.
//
// ── TRUST DIRECTION (the security rule that shapes the API) ────────────────
// Client-supplied values are REJECTED when unrecognised; server-derived values
// are COERCED to a safe default. The asymmetry is deliberate:
//
//   normalizeFailure('wat')  -> null      caller must drop the request
//   browserFamily('wat')     -> 'other'   derived from a header we already have
//
// Rejecting unknown client input is what keeps free text out of the database.
// Nothing here interpolates a string into SQL, and nothing here is rendered as
// HTML, but a closed vocabulary means a malicious body cannot even become a ROW.
//
// This module is pure: no DB, no network, no clock, no randomness. The server
// owns the counters and the flush; this owns the vocabulary and the maths.
// ---------------------------------------------------------------------------

/** How a game can fail to render. Client-supplied; unknown values are refused. */
export const FAILURE_KINDS = Object.freeze([
  'blank',        // the frame loaded but painted nothing — the black-screen case
  'timeout',      // never finished loading inside the budget
  'refused',      // X-Frame-Options / CSP frame-ancestors refused to be framed
  'http_error',   // the embed URL answered with an error status
  'script_error', // the game threw inside the frame
]);

/** Browser families. Server-derived from the UA, so this list is exhaustive. */
export const BROWSERS = Object.freeze([
  'chrome', 'edge', 'safari', 'firefox', 'samsung', 'opera', 'other',
]);

/** Platform classes. Coarse on purpose — two values, not a device model. */
export const PLATFORMS = Object.freeze(['desktop', 'mobile']);

/** The Core Web Vitals worth acting on. Client-supplied; others are refused. */
export const VITALS = Object.freeze(['LCP', 'CLS', 'INP', 'FCP', 'TTFB']);

/** Every metric reduces to one of these three. No raw values are kept. */
export const BUCKETS = Object.freeze(['good', 'needs_improvement', 'poor']);

/** Page classes. Derived from the path, so a URL never reaches storage. */
export const ROUTES = Object.freeze(['home', 'play', 'category', 'ai', 'browser', 'other']);

// Google's published Core Web Vitals thresholds: [good_max, needs_improvement_max].
// A value at or below the first number is good; at or below the second it needs
// improvement; above it is poor. CLS is unitless, the rest are milliseconds.
const THRESHOLDS = Object.freeze({
  LCP:  [2500, 4000],
  CLS:  [0.1, 0.25],
  INP:  [200, 500],
  FCP:  [1800, 3000],
  TTFB: [800, 1800],
});

const FAILURE_SET = new Set(FAILURE_KINDS);
const VITAL_SET = new Set(VITALS);

/**
 * Reduce a user-agent string to one of BROWSERS.
 *
 * Order matters and is the whole correctness story: every Chromium browser also
 * says "Chrome", and every one of them also says "Safari". Testing for Chrome
 * first would label Edge, Samsung Internet and Opera as Chrome; testing Safari
 * first would label all of them as Safari. So the most specific claim wins, and
 * the two generic ones are checked last.
 *
 * Never stored, never returned to a client — the result is a bucket key.
 */
export function browserFamily(ua) {
  const s = String(ua || '');
  if (!s) return 'other';
  if (/edg(?:e|a|ios)?\//i.test(s)) return 'edge';
  if (/samsungbrowser/i.test(s)) return 'samsung';
  if (/\bopr\/|\bopera\b/i.test(s)) return 'opera';
  if (/firefox\/|fxios\//i.test(s)) return 'firefox';
  if (/chrome\/|crios\/|chromium\//i.test(s)) return 'chrome';
  if (/safari\//i.test(s)) return 'safari';
  return 'other';
}

/**
 * Reduce a user-agent string to 'mobile' or 'desktop'.
 *
 * Two buckets, not a device model. Tablets are counted as mobile: iPadOS now
 * reports a desktop-shaped UA, so any attempt to separate tablets would be
 * wrong about half the time AND would add a third bucket for no decision
 * anybody makes. "Does this game work on a touch device" is the real question.
 */
export function platformClass(ua) {
  const s = String(ua || '');
  if (!s) return 'desktop';
  return /mobi|android|iphone|ipad|ipod|iemobile|opera mini/i.test(s) ? 'mobile' : 'desktop';
}

/**
 * Validate a client-supplied failure kind.
 * @returns the kind, or null when it is not one we recognise (caller drops it).
 */
export function normalizeFailure(kind) {
  const k = String(kind || '').toLowerCase().trim();
  return FAILURE_SET.has(k) ? k : null;
}

/**
 * Validate a client-supplied metric name. Case is normalised ('lcp' -> 'LCP')
 * because the web-vitals ecosystem is inconsistent about it; anything that is
 * not a metric we track is refused rather than coerced.
 * @returns the canonical metric name, or null.
 */
export function normalizeMetric(metric) {
  const m = String(metric || '').toUpperCase().trim();
  return VITAL_SET.has(m) ? m : null;
}

/**
 * Bucket a metric value against the published thresholds.
 *
 * Returns null for an unknown metric or a value that is not a finite number,
 * so a malformed or hostile body produces no row at all. Negative values are
 * refused too: no real measurement is negative, and accepting one would let a
 * caller push a game into 'good' with -1.
 *
 * @returns 'good' | 'needs_improvement' | 'poor' | null
 */
export function vitalBucket(metric, value) {
  const m = normalizeMetric(metric);
  if (!m) return null;
  // Deliberately NOT a bare Number(value). Number(null), Number(true) and
  // Number([]) are all 0 — finite, non-negative, and therefore 'good'. A client
  // sending `value: null` would score a perfect result and quietly poison the
  // distribution, which is worse than no data because it looks like data.
  // So: a real number, or a non-empty numeric string, and nothing else.
  const v = typeof value === 'number' ? value
    : (typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN);
  if (!Number.isFinite(v) || v < 0) return null;
  const [good, ni] = THRESHOLDS[m];
  if (v <= good) return 'good';
  if (v <= ni) return 'needs_improvement';
  return 'poor';
}

/**
 * Reduce a URL path to one of ROUTES, so no full URL (and no query string,
 * which on this site can carry a search term) ever reaches storage.
 */
export function routeClass(path) {
  const p = String(path || '').split('?')[0].split('#')[0].toLowerCase();
  if (!p || p === '/' || p === '/index.html') return 'home';
  if (p.startsWith('/play/') || p === '/play') return 'play';
  if (p.startsWith('/category/') || p.startsWith('/games/')) return 'category';
  if (p.startsWith('/ai')) return 'ai';
  if (p.startsWith('/browser') || p.startsWith('/proxy')) return 'browser';
  return 'other';
}

// ── Counter keys ───────────────────────────────────────────────────────────
// A flat string key keeps the in-memory counter a plain Map (same shape as the
// existing playCounts map) and makes the flush a split() rather than a join.
// '|' is safe as a separator: slugs are [a-z0-9-] and every other component
// comes from a closed vocabulary, so no component can contain one.

const SEP = '|';

/** Key for one failure combination: slug|browser|platform|kind. */
export function failureKey(slug, browser, platform, kind) {
  return [slug, browser, platform, kind].join(SEP);
}

/** Inverse of failureKey. Returns null if the key is not well-formed. */
export function parseFailureKey(key) {
  const parts = String(key || '').split(SEP);
  if (parts.length !== 4) return null;
  const [slug, browser, platform, kind] = parts;
  if (!slug) return null;
  return { slug, browser, platform, kind };
}

/** Key for one vitals combination: metric|bucket|route|platform. */
export function vitalKey(metric, bucket, route, platform) {
  return [metric, bucket, route, platform].join(SEP);
}

/** Inverse of vitalKey. Returns null if the key is not well-formed. */
export function parseVitalKey(key) {
  const parts = String(key || '').split(SEP);
  if (parts.length !== 4) return null;
  const [metric, bucket, route, platform] = parts;
  if (!metric) return null;
  return { metric, bucket, route, platform };
}

/**
 * Validate and reduce a failure report into the counter key it should bump.
 *
 * `slugOk` is injected rather than imported so this module stays pure and the
 * server keeps ownership of what a valid slug is (it already has bySlug). An
 * unknown slug is refused: without that check, this endpoint would accept
 * unbounded arbitrary strings and the table would grow without limit.
 *
 * @returns { key, slug, browser, platform, kind } or null when anything is invalid.
 */
export function buildFailure({ slug, kind, ua }, slugOk) {
  const s = String(slug || '').toLowerCase().trim().slice(0, 80);
  if (!s || typeof slugOk !== 'function' || !slugOk(s)) return null;
  const k = normalizeFailure(kind);
  if (!k) return null;
  const browser = browserFamily(ua);
  const platform = platformClass(ua);
  return { key: failureKey(s, browser, platform, k), slug: s, browser, platform, kind: k };
}

/**
 * Validate and reduce a vitals report into the counter key it should bump.
 * @returns { key, metric, bucket, route, platform } or null when invalid.
 */
export function buildVital({ metric, value, path, ua }) {
  const m = normalizeMetric(metric);
  if (!m) return null;
  const bucket = vitalBucket(m, value);
  if (!bucket) return null;
  const route = routeClass(path);
  const platform = platformClass(ua);
  return { key: vitalKey(m, bucket, route, platform), metric: m, bucket, route, platform };
}

/**
 * Summarise failure counters for the admin console: the worst combinations
 * first, so "which games are broken for whom" is the first thing on screen.
 *
 * Pure: takes the Map, returns rows. Sorted by count desc then key asc, so the
 * output is stable for a given input and testable without a fixed clock.
 */
export function summarizeFailures(counts, { top = 50 } = {}) {
  const rows = [];
  for (const [key, count] of counts) {
    const parsed = parseFailureKey(key);
    if (parsed) rows.push({ ...parsed, count });
  }
  rows.sort((a, b) => b.count - a.count || (a.slug + a.kind).localeCompare(b.slug + b.kind));
  const byKind = {};
  const byBrowser = {};
  let total = 0;
  for (const r of rows) {
    total += r.count;
    byKind[r.kind] = (byKind[r.kind] || 0) + r.count;
    byBrowser[r.browser] = (byBrowser[r.browser] || 0) + r.count;
  }
  return { total, combinations: rows.length, byKind, byBrowser, worst: rows.slice(0, top) };
}

/**
 * Summarise vitals counters as pass rates per metric and route.
 *
 * `good / total` is the number Google reports and the only one worth watching,
 * so it is computed here rather than left to a dashboard to get wrong.
 */
export function summarizeVitals(counts) {
  const byMetric = {};
  const byRoute = {};
  let total = 0;
  for (const [key, count] of counts) {
    const p = parseVitalKey(key);
    if (!p) continue;
    total += count;
    const m = (byMetric[p.metric] ||= { good: 0, needs_improvement: 0, poor: 0, total: 0 });
    m[p.bucket] += count; m.total += count;
    const r = (byRoute[p.route] ||= { good: 0, total: 0 });
    if (p.bucket === 'good') r.good += count;
    r.total += count;
  }
  for (const m of Object.values(byMetric)) {
    m.goodRate = m.total ? Number((m.good / m.total).toFixed(4)) : null;
  }
  for (const r of Object.values(byRoute)) {
    r.goodRate = r.total ? Number((r.good / r.total).toFixed(4)) : null;
  }
  return { total, byMetric, byRoute };
}

export default {
  FAILURE_KINDS, BROWSERS, PLATFORMS, VITALS, BUCKETS, ROUTES,
  browserFamily, platformClass, normalizeFailure, normalizeMetric, vitalBucket,
  routeClass, failureKey, parseFailureKey, vitalKey, parseVitalKey,
  buildFailure, buildVital, summarizeFailures, summarizeVitals,
};
