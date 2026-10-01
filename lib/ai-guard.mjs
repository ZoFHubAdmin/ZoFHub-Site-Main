// lib/ai-guard.mjs — the server-side AI routes are a local-development aid only.
// ---------------------------------------------------------------------------
// Every AI call the site makes in production goes browser-direct to Pollinations
// from the visitor's own machine. /api/ai/text, /api/ai/image and /api/ai/echo
// exist only because Pollinations' text endpoint fronts a Turnstile check that
// rejects browser fetches from http/localhost origins, so a developer running
// the site on localhost would otherwise have no working AI at all.
//
// THE RULE, with no exceptions:
//
//   NODE_ENV=production        → refused. Always. Checked FIRST, so nothing
//                                else — no header, no flag, no address — is
//                                even consulted.
//   anything else              → allowed only for a LOOPBACK client, and only
//                                when no forwarding header names someone else.
//
// WHAT CHANGED, AND WHY. The previous check read AI_SERVER_FALLBACK=1 before it
// read NODE_ENV, so that one variable re-opened the routes in production — the
// exact thing the check exists to prevent. The escape hatch is gone; there is no
// supported way to run server-side inference on a live deployment.
//
// SPOOFING. `trust proxy` decides req.ip (lib/trust-proxy.mjs), and outside
// production only a proxy on this same machine is trusted, so a remote client
// cannot claim 127.0.0.1 through X-Forwarded-For. The header check below closes
// the remaining case: a tunnel (cloudflared, ngrok) that connects FROM loopback
// on behalf of an internet visitor. Its own forwarding headers name that
// visitor, and a non-loopback address in any of them refuses the request.
// Host and Origin are never consulted — they are client-chosen text, and
// `Host: localhost` proves nothing.
// ---------------------------------------------------------------------------

import { isIP } from 'node:net';

/** The routes that perform server-side inference or pipe its output. */
export const AI_FALLBACK_ROUTES = Object.freeze(['/api/ai/text', '/api/ai/image', '/api/ai/echo']);

// Headers a proxy or tunnel uses to name the real client. Any of them carrying
// a non-loopback address means the request did not originate on this machine.
const FORWARDING_HEADERS = Object.freeze([
  'x-forwarded-for', 'x-real-ip', 'forwarded', 'cf-connecting-ip',
  'true-client-ip', 'x-client-ip', 'fastly-client-ip', 'x-cluster-client-ip',
]);

/** Is `ip` a loopback address (127.0.0.0/8, ::1, or an IPv4-mapped 127/8)? */
export function isLoopbackAddress(ip) {
  let s = String(ip ?? '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!s) return false;
  // Strip an IPv6 zone index ("::1%lo0") before validating.
  const pct = s.indexOf('%');
  if (pct !== -1) s = s.slice(0, pct);
  if (s.startsWith('::ffff:')) s = s.slice(7);
  const fam = isIP(s);
  if (fam === 4) return s.startsWith('127.');
  if (fam === 6) return /^(0{1,4}:){7}0{0,3}1$|^::1$/.test(s);
  return false;
}

// Pull the addresses out of one forwarding header. `Forwarded` (RFC 7239) uses
// `for=` pairs, possibly quoted and bracketed; the X- family is a plain list.
function addressesIn(name, value) {
  const raw = Array.isArray(value) ? value.join(',') : String(value ?? '');
  if (!raw.trim()) return [];
  if (name === 'forwarded') {
    // for="[::1]:8080" captures "::1"; for="192.0.2.60:4711" captures the port
    // too, which is dropped for an IPv4 address.
    return [...raw.matchAll(/for\s*=\s*"?\[?([^\]";,\s]+)/gi)]
      .map((m) => (m[1].includes('.') ? m[1].replace(/:\d+$/, '') : m[1]));
  }
  return raw.split(',').map((s) => s.trim()).filter(Boolean)
    // "1.2.3.4:5678" → "1.2.3.4"; a bare IPv6 address is left alone.
    .map((s) => (s.includes('.') ? s.replace(/:\d+$/, '') : s));
}

/** Does any forwarding header name a client that is not this machine? */
export function forwardedForSomeoneElse(headers = {}) {
  for (const name of FORWARDING_HEADERS) {
    const v = headers[name];
    if (v === undefined) continue;
    const addrs = addressesIn(name, v);
    // A header that is present but unparseable is treated as someone else: a
    // proxy that bothered to send it was not this machine talking to itself.
    if (!addrs.length && String(v).trim()) return true;
    if (addrs.some((a) => !isLoopbackAddress(a))) return true;
  }
  return false;
}

/**
 * May this request use the server-side AI routes?
 *
 * @param {object} o
 * @param {string} o.nodeEnv   process.env.NODE_ENV
 * @param {string} o.ip        req.ip — already resolved through `trust proxy`
 * @param {object} [o.headers] req.headers
 */
export function aiServerAllowed({ nodeEnv, ip, headers = {} } = {}) {
  if (nodeEnv === 'production') return false;
  if (!isLoopbackAddress(ip)) return false;
  if (forwardedForSomeoneElse(headers)) return false;
  return true;
}

/**
 * The path as a router might come to see it: percent-decoding applied (up to
 * three rounds), backslashes treated as separators, repeated slashes
 * collapsed, `;` parameters and trailing slashes dropped, lower-cased.
 *
 * Express itself would not route most of these spellings to the handlers — but
 * "zero exceptions" is a property of this guard, not an assumption about the
 * router, so every spelling that NORMALISES to a fallback route is refused.
 */
export function normalizeRoutePath(rawPath) {
  let p = String(rawPath ?? '');
  const q = p.search(/[?#]/);
  if (q !== -1) p = p.slice(0, q);
  for (let i = 0; i < 3; i++) {
    let next;
    try { next = decodeURIComponent(p); } catch { break; }
    if (next === p) break;
    p = next;
  }
  p = p.replace(/\\/g, '/').replace(/;[^/]*/g, '').replace(/\/{2,}/g, '/').toLowerCase();
  if (p.length > 1) p = p.replace(/\/+$/, '');
  return p.startsWith('/') ? p : '/' + p;
}

/** Is this one of the three fallback routes, in any spelling or beneath it? */
export function isAiFallbackPath(rawPath) {
  const p = normalizeRoutePath(rawPath);
  return AI_FALLBACK_ROUTES.some((r) => p === r || p.startsWith(r + '/'));
}

export default {
  AI_FALLBACK_ROUTES, isLoopbackAddress, forwardedForSomeoneElse,
  aiServerAllowed, normalizeRoutePath, isAiFallbackPath,
};
