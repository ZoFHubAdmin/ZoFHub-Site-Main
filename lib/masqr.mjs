// lib/masqr.mjs — link-leak resistance for the proxy surfaces.
// ---------------------------------------------------------------------------
// THE PROBLEM THIS SOLVES. ZoFHub is built to be redeployed on throwaway mirror
// domains, because school filters block the primary one. Mirror rotation is the
// cure; this is the prevention. A mirror usually dies the same way every time:
// somebody shares the link, it reaches a filter vendor, the vendor's crawler
// fetches the URL, sees a web proxy, files the domain under
// "proxy/anonymizer", and the domain is burned — often within hours, and for
// every future visitor at once.
//
// MASQR (github.com/titaniumnetwork-dev/MasqrProject, © Mercury Workshop 2024)
// is the project that named this problem and the shape of the answer: don't
// show the proxy to a client that has not been handed a key out-of-band. This
// file is ZoFHub's own implementation of that idea. NO UPSTREAM CODE IS COPIED,
// and §"What is deliberately different" below says why that was necessary
// rather than merely preferred. See docs/proxy/MASQR.md for the provenance record.
//
// ── WHAT THIS IS NOT ──────────────────────────────────────────────────────
// It is NOT access control and must never be described as security. Anyone
// holding a key can pass it on, and the games hub — the overwhelming majority
// of this site — stays completely open either way. What it buys is that an
// UNAUTHENTICATED automated classifier does not get shown a proxy. That is a
// discovery-resistance property, not an authorisation property, and conflating
// the two is how people end up trusting a gate that was never load-bearing.
//
// It is also OFF unless an operator turns it on. ZoFHub's proxy browser is a
// headline feature and gating it is a real trade — the operator is choosing a
// key-distribution model (a bot, a Discord, a class list) over open access.
//
// ── WHAT IS DELIBERATELY DIFFERENT FROM UPSTREAM ──────────────────────────
// Upstream's reference backend is a demo, and adopting it as-is would have
// imported several defects into a production site. Each of these is a decision,
// not an oversight:
//
//   1. NO THIRD-PARTY LICENCE SERVER. Upstream validates by fetching
//      `https://license.mercurywork.shop/validate?license=<key>&host=<host>`.
//      That puts the key in a query string (logged by every hop), makes a
//      third party the gatekeeper of your site, adds an un-timeout-ed network
//      call to every request, and fails closed if that host is down. Keys here
//      are HMAC-signed and verified OFFLINE, in microseconds, with no network
//      and nobody else in the trust path.
//   2. THE GRANT IS SIGNED. Upstream sets `authcheck=true` — a plain cookie any
//      visitor can set from the console, which makes the gate bypassable by
//      typing one line. Here the cookie carries the signed key itself and is
//      re-verified on every request.
//   3. KEYS ARE NOT HOST-BOUND. Upstream ties a licence to one hostname. That
//      is exactly backwards for this site: mirrors are disposable, so a key
//      must keep working when the domain changes, or every rotation invalidates
//      every key at the worst possible moment.
//   4. THE KEY IS NEVER LOGGED. Upstream console.logs the full validation URL,
//      key included.
//   5. NO BASIC-AUTH PROMPT. Upstream triggers `WWW-Authenticate: Basic`, which
//      shows a browser credential dialog — upstream's own comment notes this
//      "gives it away". A key travels in a link instead, and is swallowed on
//      arrival so it never lingers in history, referrers or server logs.
//   6. PATHS ARE MATCHED EXACTLY, NOT BY SUBSTRING. Upstream bypasses on
//      `req.url.includes("/bare/")`, so `/anything?x=/bare/` walks straight
//      through. This repository has already been bitten by that exact class of
//      bug in the Wisp route and does prefix matching properly.
//   7. NOTHING IS FABRICATED. Upstream serves a decoy "Checkfailed.html" per
//      domain. ZoFHub just answers 404 for the proxy paths, which is what an
//      unauthenticated client is actually entitled to see, and otherwise shows
//      the real games hub. The site genuinely is a games hub; there is no need
//      to invent a cover story, and inventing one would be the dishonest part.

import { createHmac, timingSafeEqual, randomBytes } from 'node:crypto';
import { AD_SURFACES } from './ad-providers.mjs';

/** Domain-separated so a signature minted here can never be replayed as some
 *  other HMAC this project computes with the same secret. */
const SIG_CONTEXT = 'zofhub-masqr-v1';

/** The grant, re-verified on every request. httpOnly: JavaScript never needs it. */
export const GRANT_COOKIE = 'zh_px_grant';
/** A NON-secret hint so the site chrome can hide a link it cannot use.
 *  Values: '1' granted, '0' gated. Absent entirely when the gate is off. */
export const HINT_COOKIE = 'zh_px';

/** Never gated, whatever else is configured. Each entry is load-bearing. */
const NEVER_GATE = [
  // Gating the health probe would 404 it, Render would call the service
  // unhealthy, and the container would restart in a loop. This one is not a
  // preference.
  '/healthz', '/ping', '/api/health',
  // Legal obligations. A DMCA agent, a privacy request or a licence notice
  // must be reachable by anyone, including a crawler. Hiding these would be
  // both wrong and the fastest way to attract the wrong kind of attention.
  '/privacy', '/terms', '/dmca', '/cookies', '/licenses', '/credits',
  // Crawler contract files. A robots.txt that 404s is worse than one that
  // exists, and ads.txt must be fetchable by ad networks by definition.
  '/robots.txt', '/sitemap.xml', '/ads.txt', '/favicon.ico',
];

/** Surfaces that reveal the proxy but are not in PROXY_SURFACES. */
const EXTRA_GATED = [
  // Returns the live engine list. A crawler reading this learns the site is a
  // proxy just as surely as it would from /browser.
  '/api/proxies',
];

const truthy = (v) => /^(1|true|yes|on)$/i.test(String(v ?? '').trim());

/**
 * Resolve the configuration.
 *
 * FAILS OPEN, LOUDLY. If the gate is switched on without a secret it cannot
 * verify anything, so every visitor would be denied — a half-broken site. The
 * lesser evil is to run exactly as before and say so at boot in terms nobody
 * can miss. Compare lib/wisp-policy.mjs, which fails toward the RESTRICTIVE
 * default: there the safe direction is "refuse", here it is "do not break the
 * site over a missing setting".
 */
export function masqrConfig(env = process.env) {
  const warnings = [];
  const wanted = truthy(env.MASQR_ENABLED);
  if (!wanted) return { enabled: false, mode: 'off', warnings };

  const secret = String(env.MASQR_SECRET || '').trim();
  if (secret.length < 16) {
    warnings.push(secret
      ? 'MASQR_SECRET is shorter than 16 characters — refusing to enable the proxy gate with a guessable secret.'
      : 'MASQR_ENABLED is set but MASQR_SECRET is not — the gate cannot verify any key, so it would deny every visitor. Running ungated.');
    return { enabled: false, mode: 'misconfigured', warnings };
  }

  const days = Number(String(env.MASQR_KEY_TTL_DAYS ?? '').trim());
  const ttlDays = Number.isFinite(days) && days > 0 ? days : 30;
  if (String(env.MASQR_KEY_TTL_DAYS ?? '').trim() && !(Number.isFinite(days) && days > 0)) {
    warnings.push(`MASQR_KEY_TTL_DAYS is not a positive number ("${env.MASQR_KEY_TTL_DAYS}") — using 30.`);
  }

  const deny = String(env.MASQR_DENY || '404').trim().toLowerCase();
  const denyMode = deny === 'redirect' ? 'redirect' : '404';
  if (deny !== '404' && deny !== 'redirect') {
    warnings.push(`MASQR_DENY must be "404" or "redirect" (got "${deny}") — using 404.`);
  }

  return {
    enabled: true,
    mode: 'on',
    secret,
    ttlMs: ttlDays * 24 * 60 * 60 * 1000,
    ttlDays,
    denyMode,
    redirectTo: String(env.MASQR_REDIRECT_TO || '/').trim() || '/',
    warnings,
  };
}

// ── Keys ───────────────────────────────────────────────────────────────────
// Format: <expiry-base36>.<hmac-base64url-22>
//
// Stateless on purpose. A mirror has to work the moment it boots, on a fresh
// host with an empty database — and this repository currently has migrations
// waiting to be applied, which is precisely the situation where a key system
// backed by a table would be dead on arrival. Signing costs nothing, needs no
// storage, and survives a redeploy.
//
// The cost is that individual revocation is not possible: you rotate
// MASQR_SECRET, which invalidates every key at once. For a link-leak control
// whose keys expire in weeks anyway, that is the right trade, and it is stated
// rather than discovered.

const sign = (secret, payload) => createHmac('sha256', secret)
  .update(`${SIG_CONTEXT}:${payload}`)
  .digest('base64url')
  .slice(0, 22);                       // 132 bits — far past brute force, still short

/** Mint a key valid for `ttlMs` from now. */
export function mintKey(secret, { ttlMs, now = Date.now() } = {}) {
  if (!secret) throw new Error('mintKey: no secret');
  const exp = now + (ttlMs || 30 * 24 * 60 * 60 * 1000);
  const payload = exp.toString(36);
  return `${payload}.${sign(secret, payload)}`;
}

/**
 * Verify a key. Returns { ok, exp?, reason? } and never throws.
 *
 * Constant-time on the signature compare so the gate cannot be used as an
 * oracle to recover a valid signature byte by byte.
 */
export function verifyKey(secret, key, { now = Date.now() } = {}) {
  if (!secret) return { ok: false, reason: 'no-secret' };
  const raw = String(key || '');
  // Bound the work before doing any: an attacker should not be able to make us
  // hash a megabyte by putting it in a cookie.
  if (!raw || raw.length > 128) return { ok: false, reason: 'malformed' };

  const dot = raw.indexOf('.');
  if (dot <= 0 || dot === raw.length - 1) return { ok: false, reason: 'malformed' };
  const payload = raw.slice(0, dot);
  const got = raw.slice(dot + 1);
  if (!/^[0-9a-z]{1,12}$/.test(payload)) return { ok: false, reason: 'malformed' };
  if (!/^[A-Za-z0-9_-]{22}$/.test(got)) return { ok: false, reason: 'malformed' };

  const want = sign(secret, payload);
  const a = Buffer.from(got);
  const b = Buffer.from(want);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: 'bad-signature' };

  const exp = parseInt(payload, 36);
  if (!Number.isFinite(exp)) return { ok: false, reason: 'malformed' };
  if (exp <= now) return { ok: false, reason: 'expired', exp };
  return { ok: true, exp };
}

/** A fresh secret, for the operator to paste into their environment. */
export const suggestSecret = () => randomBytes(32).toString('base64url');

/**
 * The visitor's grant, if it is currently valid — for carrying across a
 * regional redirect (lib/geo.mjs), and for nothing else.
 *
 * WHY THIS EXISTS. The grant is a host-only cookie, and cookies do not cross
 * domains. When regional routing moves a visitor from one ZoFHub domain to their
 * region's domain, a keyed visitor would otherwise arrive with no grant and be
 * shown a 404 for the proxy they were just using. The key rides that one
 * redirect as `?k=`, which is exactly how keys are distributed in the first
 * place; the gate on the other side consumes it, sets its own cookie, and
 * strips it from the URL before history, a Referer or an access log sees it.
 *
 * Only a key that verifies is ever returned. An expired or forged cookie is
 * never promoted into a link.
 *
 * @returns {string} the key, or '' when the gate is off or there is no valid grant
 */
export function grantKeyFor(config, cookieHeader, { now = Date.now() } = {}) {
  if (!config?.enabled) return '';
  const key = readCookie(cookieHeader, GRANT_COOKIE);
  return key && verifyKey(config.secret, key, { now }).ok ? key : '';
}

// ── Which requests are gated ───────────────────────────────────────────────

/**
 * Is this path a proxy surface?
 *
 * Reuses PROXY_SURFACES from lib/ad-providers.mjs rather than restating it.
 * That list is already the project's written answer to "is this proxy
 * infrastructure?", and two copies of it would drift — one of them silently,
 * which is how a newly added engine ends up advertised to a crawler.
 */
export function isGatedPath(pathname) {
  const p = String(pathname || '').split('?')[0].split('#')[0].toLowerCase();
  for (const open of NEVER_GATE) {
    if (p === open || p.startsWith(open + '/')) return false;
  }
  for (const deny of [...AD_SURFACES.proxy, ...EXTRA_GATED]) {
    if (p === deny || p.startsWith(deny + '/')) return true;
  }
  return false;
}

/**
 * Is this a request a classifier would judge the site by?
 *
 * Only top-level documents are gated. A crawler fetches the PAGE; it does not
 * go hunting for /uv/uv.bundle.js, and those paths are only discoverable from
 * the page it cannot read. Letting subresources through avoids the ugly failure
 * where a grant expires mid-session and a service worker starts receiving HTML
 * where it expected JavaScript.
 *
 * Sec-Fetch-Dest is authoritative where the browser sends it; the Accept header
 * is the fallback for clients that do not — including most crawlers, which is
 * the case that matters most here.
 */
export function looksLikeDocument(req) {
  const dest = String(req?.headers?.['sec-fetch-dest'] || '').toLowerCase();
  if (dest) return dest === 'document' || dest === 'iframe' || dest === 'empty';
  const accept = String(req?.headers?.accept || '').toLowerCase();
  return accept.includes('text/html') || accept === '' || accept === '*/*';
}

// ── Middleware ─────────────────────────────────────────────────────────────

function serializeCookie(name, value, { maxAgeMs, httpOnly, secure, sameSite = 'Lax' }) {
  const bits = [`${name}=${encodeURIComponent(value)}`, 'Path=/', `SameSite=${sameSite}`];
  if (httpOnly) bits.push('HttpOnly');
  if (secure) bits.push('Secure');
  bits.push(`Max-Age=${Math.max(0, Math.floor((maxAgeMs ?? 0) / 1000))}`);
  return bits.join('; ');
}

/** Read one cookie without pulling in a parser dependency. */
export function readCookie(header, name) {
  if (!header) return '';
  for (const part of String(header).split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() !== name) continue;
    try { return decodeURIComponent(part.slice(i + 1).trim()); }
    catch { return part.slice(i + 1).trim(); }
  }
  return '';
}

/**
 * The gate.
 *
 * `now` is injectable so the tests can drive expiry without waiting, and
 * `deny404` so this module does not have to know how server.js renders a not-
 * found page. The default is deliberately plain: a module that cannot find the
 * site's 404 template should still deny, not fall open.
 */
export function masqrMiddleware(config, {
  now = () => Date.now(),
  deny404 = (req, res) => { res.statusCode = 404; res.end('not found'); },
} = {}) {
  if (!config?.enabled) return (req, res, next) => next();

  const secure = process.env.NODE_ENV === 'production';

  return function masqrGate(req, res, next) {
    const t = now();

    // 1. A key arriving in the link. Consume it, then get it out of the URL —
    //    it must not survive into history, a Referer header, or an access log.
    const url = new URL(req.originalUrl || req.url || '/', 'http://masqr.invalid');
    const offered = url.searchParams.get('k');
    if (offered) {
      const v = verifyKey(config.secret, offered, { now: t });
      url.searchParams.delete('k');
      if (v.ok) {
        res.append('Set-Cookie', serializeCookie(GRANT_COOKIE, offered, {
          // The cookie cannot outlive the key it carries; the key is re-verified
          // on every request regardless, so this is tidiness, not enforcement.
          maxAgeMs: Math.max(0, v.exp - t), httpOnly: true, secure,
        }));
        res.append('Set-Cookie', serializeCookie(HINT_COOKIE, '1', {
          maxAgeMs: Math.max(0, v.exp - t), httpOnly: false, secure,
        }));
      }
      // Redirect either way. Echoing "that key was wrong" turns the gate into a
      // key-checking oracle that an attacker can run at full speed.
      const clean = url.pathname + (url.searchParams.toString() ? `?${url.searchParams}` : '');
      res.statusCode = 302;
      res.setHeader('Location', clean);
      res.setHeader('Cache-Control', 'no-store');
      return res.end();
    }

    // 2. An existing grant, re-verified every time — a cookie is an assertion by
    //    the client, never evidence on its own.
    const grant = verifyKey(config.secret, readCookie(req.headers.cookie, GRANT_COOKIE), { now: t });
    req.masqrGranted = grant.ok;

    // 3. Tell the site chrome what it may advertise. Carries no secret: it is a
    //    single character, and it exists so the header does not show a
    //    "Proxy Browser" link that would 404 for this visitor.
    res.append('Set-Cookie', serializeCookie(HINT_COOKIE, grant.ok ? '1' : '0', {
      maxAgeMs: grant.ok ? Math.max(0, grant.exp - t) : 6 * 60 * 60 * 1000,
      httpOnly: false, secure,
    }));

    if (grant.ok) return next();
    if (!isGatedPath(url.pathname)) return next();
    if (!looksLikeDocument(req)) return next();

    // 4. Denied. A crawler is told this path is not here, which is what an
    //    unauthenticated client is entitled to know, and the games hub — the
    //    real, larger half of this site — remains completely open.
    res.setHeader('Cache-Control', 'no-store');
    if (config.denyMode === 'redirect') {
      res.statusCode = 302;
      res.setHeader('Location', config.redirectTo);
      return res.end();
    }
    return deny404(req, res);
  };
}

/** One line for the boot banner, in the shape the other status lines print. */
export function masqrStatusLine(config) {
  switch (config?.mode) {
    case 'on': return `→ masqr:   proxy surfaces gated · keys valid ${config.ttlDays}d · deny ${config.denyMode}`;
    case 'misconfigured': return '→ masqr:   NOT enabled — see the [masqr] warning above';
    default: return '→ masqr:   off (proxy is open to everyone)';
  }
}
