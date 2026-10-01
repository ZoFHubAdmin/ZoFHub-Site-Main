// ============================================================================
// trust-proxy.mjs — which X-Forwarded-For hops to believe, decided explicitly.
//
// WHY THIS IS A SECURITY SETTING. Every per-client control in this server —
// rate limits, the admin lockout, the "local development only" gate on the
// server-side AI routes, the leaderboard and presence budgets — keys on
// req.ip. Express derives req.ip from X-Forwarded-For only for hops it has
// been told to trust, and anything to the left of those is text the CLIENT
// wrote.
//
// It used to be hard-coded to `1` ("trust one hop"). That is correct behind
// exactly one reverse proxy (Render's edge) and wrong everywhere else:
//
//   · with NO proxy in front (a VPS, `npm start` on a LAN, a tunnel), the
//     "one trusted hop" is the attacker's own TCP connection, so a request
//     carrying `X-Forwarded-For: 127.0.0.1` became req.ip = 127.0.0.1. That
//     reopened the loopback-only AI routes on any non-production host and let
//     one client present a fresh address to every rate limiter per request;
//   · with TWO proxies (a CDN in front of Render), req.ip became the CDN's
//     edge address, so every visitor behind one edge node shared one bucket.
//
// So the value now comes from TRUST_PROXY, with a default chosen per
// environment rather than one guess for all of them:
//
//   production  → 1          one hop: the documented Render deployment
//   otherwise   → loopback   a proxy on this same machine is believed; nobody
//                            on the network can spoof an address
//
// Accepted values: a hop count ("1", "2"), "false"/"0" (never trust a
// forwarded header), or anything Express's `trust proxy` accepts as a string —
// "loopback", "uniquelocal", CIDRs like "10.0.0.0/8, 173.245.48.0/20".
// "true" (trust every hop) is refused: it makes req.ip entirely client-chosen.
// ============================================================================

/**
 * Resolve TRUST_PROXY to the value handed to app.set('trust proxy', …).
 * Returns { value, source, warning? } so the boot log can say what it chose.
 */
export function trustProxySetting(env = process.env) {
  const raw = String(env.TRUST_PROXY ?? '').trim();
  const isProd = env.NODE_ENV === 'production';
  if (!raw) {
    return isProd
      ? { value: 1, source: 'default (production: one proxy hop)' }
      : { value: 'loopback', source: 'default (non-production: loopback only)' };
  }
  const lower = raw.toLowerCase();
  if (lower === 'false' || lower === '0' || lower === 'off' || lower === 'none') {
    return { value: false, source: 'TRUST_PROXY' };
  }
  if (lower === 'true' || lower === '*') {
    // Refused rather than honoured: with every hop trusted, req.ip is the
    // left-most X-Forwarded-For entry, which the client writes.
    return {
      value: isProd ? 1 : 'loopback',
      source: 'fallback',
      warning: 'TRUST_PROXY=true would make every client address spoofable; using the default instead. Set a hop count or the proxy CIDRs.',
    };
  }
  if (/^\d+$/.test(raw)) return { value: Number(raw), source: 'TRUST_PROXY' };
  return { value: raw, source: 'TRUST_PROXY' };
}

/**
 * The client address of a RAW request (an HTTP upgrade), resolved with the same
 * rule Express applies to req.ip. `trustFn` is Express's compiled
 * `app.get('trust proxy fn')`, so the two can never disagree.
 *
 * Algorithm (proxy-addr's): walk from the socket peer leftwards through
 * X-Forwarded-For, and stop at the first address that is NOT trusted.
 */
export function resolveClientIp(req, socket, trustFn) {
  const peer = String(socket?.remoteAddress || req?.socket?.remoteAddress || '');
  const chain = [peer];
  const xff = String(req?.headers?.['x-forwarded-for'] || '');
  if (xff) {
    const parts = xff.split(',').map((s) => s.trim()).filter(Boolean);
    for (let i = parts.length - 1; i >= 0; i--) chain.push(parts[i]);
  }
  if (typeof trustFn !== 'function') return peer || 'unknown';
  for (let i = 0; i < chain.length - 1; i++) {
    if (!trustFn(chain[i], i)) return chain[i] || 'unknown';
  }
  return chain[chain.length - 1] || 'unknown';
}
