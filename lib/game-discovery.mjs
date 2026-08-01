// lib/game-discovery.mjs — URL safety + cross-domain duplicate detection for
// submitted games.
//
// THE PROBLEM
// The same game is published by many portals. "Bubble Shooter" on
// html5.gamemonetize.co, on y8.com and on a partner subdomain of gamezop are
// three different URLs pointing at one game, and a naive `WHERE game_url = ?`
// check sees three distinct entries. The catalog already shows the cost of
// that: 4,691 games (27.7%) share a title with another row.
//
// THE APPROACH — provider identity, not string comparison
// Every portal encodes a stable game id in its URL. Extract it and two hosts
// stop mattering:
//
//   https://html5.gamemonetize.co/abc123xyz/            -> gamemonetize:abc123xyz
//   https://www.y8.com/embed/turn_and_hit               -> y8:turn_and_hit
//   https://html5.gamedistribution.com/<uuid>/?gd_sdk…  -> gamedistribution:<uuid>
//   https://4665.play.gamezop.com/g/xyz                 -> gamezop:xyz
//   https://zv1y2i8p.play.gamezop.com/g/xyz             -> gamezop:xyz   ← same game
//
// The gamezop case is the whole point: the partner id lives in the SUBDOMAIN, so
// the same game under two partner accounts looks like two different domains and
// is in fact one game. Measured in this catalog: 129 games on one gamezop
// subdomain and 99 on another.
//
// WHAT THIS DELIBERATELY DOES NOT DO
// No crawling and no web search. Fetching a submitted URL server-side turns
// this into an SSRF vector and a way to make our server hammer third parties on
// request; a search API is a paid dependency and a rate limit. Provider-id
// matching catches the overwhelming majority of real duplicates using data we
// already hold, with no outbound request at all. The remaining cases fall back
// to normalised-title matching, which is reported as `likely` rather than
// `exact` so a human decides.

// Hosts we refuse to embed regardless of anything else. Not a moral judgement —
// these either cannot be framed, are known malware/redirect farms, or resolve
// inside our own infrastructure.
const BLOCKED_HOST_PATTERNS = [
  /(^|\.)localhost$/i, /(^|\.)local$/i, /(^|\.)internal$/i,
  /(^|\.)bit\.ly$/i, /(^|\.)tinyurl\.com$/i, /(^|\.)t\.co$/i,   // shorteners hide the real target
  /(^|\.)grabify\.link$/i, /(^|\.)iplogger\./i,                  // IP loggers
];

// Query parameters that identify a campaign, not a game. Stripping them makes
// the same game submitted from two referrers produce one canonical URL.
const TRACKING_PARAMS = new Set([
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
  'fbclid', 'gclid', 'msclkid', 'ref', 'referrer', 'source', 'src',
  'gd_sdk_referrer_url', 'partner', 'partnerid', 'pid', 'aff', 'affiliate',
  '_ga', 'mc_cid', 'mc_eid', 'igshid', 'si',
]);

/** RFC1918 / loopback / link-local / CGNAT, including decimal and hex forms.
 *  Mirrors the guard the proxy already uses — a submitted embed URL is exactly
 *  as untrusted as a proxied one. */
function isInternalAddress(host) {
  const h = String(host || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return true;
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h === '::1' || h.startsWith('fc') || h.startsWith('fd')) return true;   // IPv6 loopback / ULA
  // Dotted IPv4
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;          // link-local: cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    return false;
  }
  // A bare integer or hex literal is still a valid IPv4 to most resolvers, and
  // is the classic way to smuggle 169.254.169.254 past a naive string check.
  if (/^\d+$/.test(h) || /^0x[0-9a-f]+$/i.test(h)) return true;
  return false;
}

/**
 * Is this URL safe to put in an <iframe>?
 * Returns { ok, reason } — never throws, so a malformed submission is a
 * rejection rather than a 500.
 */
export function checkUrlSafety(raw) {
  let u;
  try { u = new URL(String(raw || '').trim()); }
  catch { return { ok: false, reason: 'unparseable_url' }; }

  // HTTPS only. An http:// frame inside an https:// page is blocked by every
  // modern browser anyway, so accepting it would only produce a blank tile.
  if (u.protocol !== 'https:') return { ok: false, reason: 'not_https' };
  // Credentials in a URL are never legitimate for a game embed and are a
  // classic phishing shape (https://trusted.com@evil.example).
  if (u.username || u.password) return { ok: false, reason: 'credentials_in_url' };
  if (isInternalAddress(u.hostname)) return { ok: false, reason: 'internal_address' };
  if (BLOCKED_HOST_PATTERNS.some(re => re.test(u.hostname))) {
    return { ok: false, reason: 'blocked_host' };
  }
  if (!u.hostname.includes('.')) return { ok: false, reason: 'invalid_hostname' };
  if (raw.length > 2048) return { ok: false, reason: 'url_too_long' };

  return { ok: true, reason: null };
}

/** Canonical form: https, no www, no tracking params, sorted query, no hash. */
export function normalizeUrl(raw) {
  let u;
  try { u = new URL(String(raw || '').trim()); } catch { return null; }
  u.hash = '';
  u.hostname = u.hostname.toLowerCase().replace(/^www\./, '');
  for (const p of [...u.searchParams.keys()]) {
    if (TRACKING_PARAMS.has(p.toLowerCase())) u.searchParams.delete(p);
  }
  u.searchParams.sort();
  // A trailing slash is not a different game.
  if (u.pathname.length > 1 && u.pathname.endsWith('/')) u.pathname = u.pathname.slice(0, -1);
  return u.toString();
}

/**
 * Provider identity. `${provider}:${id}` is stable across whatever host,
 * subdomain or query string a given portal happens to serve the game under.
 */
export function providerFingerprint(raw) {
  let u;
  try { u = new URL(String(raw || '').trim()); } catch { return null; }
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  const seg = u.pathname.split('/').filter(Boolean);

  // gamezop: the partner id is in the SUBDOMAIN, so it must be ignored — this
  // is the case that makes two "different domains" the same game.
  if (host.endsWith('play.gamezop.com') || host.endsWith('gamezop.com')) {
    const id = seg[seg.length - 1] || u.searchParams.get('id');
    return id ? { provider: 'gamezop', id: id.toLowerCase() } : null;
  }
  if (host.endsWith('gamemonetize.co') || host.endsWith('gamemonetize.com')) {
    return seg[0] ? { provider: 'gamemonetize', id: seg[0].toLowerCase() } : null;
  }
  if (host.endsWith('gamedistribution.com')) {
    // A 32-char hex uuid identifies the game; everything else is SDK plumbing.
    const uuid = seg.find(s => /^[0-9a-f]{32}$/i.test(s));
    return uuid ? { provider: 'gamedistribution', id: uuid.toLowerCase() } : null;
  }
  if (host.endsWith('y8.com')) {
    const i = seg.indexOf('embed');
    const id = i >= 0 ? seg[i + 1] : seg[seg.length - 1];
    return id ? { provider: 'y8', id: id.toLowerCase() } : null;
  }
  if (host.endsWith('famobi.com')) {
    return seg[0] ? { provider: 'famobi', id: seg[0].toLowerCase() } : null;
  }
  if (host.endsWith('htmlgames.com')) {
    return seg[0] ? { provider: 'htmlgames', id: seg[0].toLowerCase() } : null;
  }
  if (host.endsWith('onlinegames.io')) {
    const id = seg[seg.length - 1] || '';
    return id ? { provider: 'onlinegames', id: id.replace(/\.html?$/, '').toLowerCase() } : null;
  }
  if (host.endsWith('gameflare.com')) {
    return seg[seg.length - 1] ? { provider: 'gameflare', id: seg[seg.length - 1].toLowerCase() } : null;
  }
  // Unknown portal: fall back to host + path, which still collapses tracking
  // params and www/trailing-slash variants.
  const norm = normalizeUrl(raw);
  return norm ? { provider: 'url', id: norm.replace(/^https:\/\//, '').toLowerCase() } : null;
}

/** Title reduced to a comparison key. */
export function normalizeTitle(t) {
  return String(t || '')
    .toLowerCase()
    .replace(/\b(online|free|game|games|play|unblocked|html5|3d|2d)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Does this game already exist in the catalog?
 *
 * @param {{url:string, title?:string}} candidate
 * @param {Array<{slug:string,title:string,game_url?:string,embed_url?:string}>} catalog
 * @returns {{status:'exact'|'likely'|'new', matches:Array, reason:string}}
 */
export function findDuplicates(candidate, catalog) {
  const url = candidate && candidate.url;
  const fp = providerFingerprint(url);
  const norm = normalizeUrl(url);
  const titleKey = normalizeTitle(candidate && candidate.title);
  const matches = [];

  for (const g of catalog || []) {
    const gUrl = g.game_url || g.embed_url || '';
    if (!gUrl) continue;

    if (norm && normalizeUrl(gUrl) === norm) {
      matches.push({ slug: g.slug, title: g.title, kind: 'same_url' });
      continue;
    }
    const gfp = providerFingerprint(gUrl);
    if (fp && gfp && gfp.provider === fp.provider && gfp.id === fp.id) {
      // The valuable case: identical game, different host or subdomain.
      matches.push({ slug: g.slug, title: g.title, kind: 'same_provider_id' });
      continue;
    }
    if (titleKey && titleKey.length > 3 && normalizeTitle(g.title) === titleKey) {
      matches.push({ slug: g.slug, title: g.title, kind: 'same_title' });
    }
  }

  const strong = matches.filter(m => m.kind !== 'same_title');
  if (strong.length) {
    return {
      status: 'exact',
      matches: strong,
      reason: strong[0].kind === 'same_url'
        ? 'This exact URL is already in the catalog.'
        : 'The same provider game id is already in the catalog under a different URL.',
    };
  }
  if (matches.length) {
    // Title-only agreement is evidence, not proof — two different games really
    // are both called "Bubble Shooter". Reported for a human to decide.
    return { status: 'likely', matches, reason: 'A game with the same title already exists.' };
  }
  return { status: 'new', matches: [], reason: 'No match found in the catalog.' };
}

export default {
  checkUrlSafety, normalizeUrl, providerFingerprint, normalizeTitle, findDuplicates,
};
