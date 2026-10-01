// lib/geo.mjs — regional domain isolation and regional ad localisation.
// ---------------------------------------------------------------------------
// WHY REGIONS. ZoFHub is redeployed on mirror domains because networks block
// the ones they learn about, and the parties doing the blocking are regional:
// US school filters build their lists from US school traffic; an Indian ISP
// blocks what it is told to block. A domain that serves both audiences collects
// both sets of blocks. Giving each region its own domain(s), and keeping each
// region's visitors on them, means one market's block list stops reaching the
// other market's domain.
//
// CONFIGURATION (all optional; with none of it set, nothing here does anything)
//
//   REGION_ROUTES   Regions, separated by ';'. Each is
//                     ID:COUNTRIES[=HOST,HOST...]
//                   ID        letters, digits and _ ; used as the suffix for
//                             regional ad tags (EXOCLICK_HEADER_TAG__SOUTH_ASIA)
//                   COUNTRIES ISO 3166-1 alpha-2 codes, comma-separated. `*`
//                             marks the one catch-all region for every
//                             country no other region names.
//                   HOSTS     the domain(s) that region is served from, first
//                             one canonical. Optional: a region with no hosts
//                             still gets its regional ad tags, just no routing.
//                   e.g.
//                     SOUTH_ASIA:IN,PK,BD,LK,NP,BT,MV=play-in.example.com;
//                     NORTH_AMERICA:US,CA=play-us.example.com;
//                     GLOBAL:*=zofhub.example.com
//
//   GEO_COUNTRY_HEADER  The request header carrying the visitor's country.
//                   Default cf-ipcountry (Cloudflare). It must be set by YOUR
//                   edge — Cloudflare overwrites any client-sent CF-IPCountry,
//                   but a host with no geo-aware edge in front passes the
//                   client's own value through. The worst a spoofed value can
//                   do is send the spoofer to another region's domain or show
//                   them another region's ad tags; it grants nothing.
//
// SCALE. Everything is parsed and validated ONCE, at boot, into Maps. A request
// costs one header read and two Map lookups, allocates nothing unless it is
// redirected, and keeps no per-visitor state — so a traffic spike from any
// region adds no memory, and the /healthz memory ceiling (HEALTH_MEM_MAX_PCT)
// sees exactly the load it saw before. No DNS, no network, no cache that grows.
//
// WHAT IS ROUTED. Top-level page navigations only (GET/HEAD, a browser loading
// a document). Never an API call, an asset, an iframe, a service-worker fetch,
// a health probe, ads.txt / robots.txt / sitemap.xml (each domain must answer
// for itself — ad networks crawl ads.txt per domain), or a legal page.
// ---------------------------------------------------------------------------

export const DEFAULT_COUNTRY_HEADER = 'cf-ipcountry';
/** Opt-out cookie: a visitor whose regional domain is unreachable for them. */
export const STAY_COOKIE = 'zh_geo';
const STAY_MAX_AGE_S = 7 * 24 * 60 * 60;

// Country values an edge sends when it does not know: Cloudflare's XX (unknown)
// and T1 (Tor), and the legacy MaxMind pseudo-codes. Not countries — ignored.
const PSEUDO_COUNTRIES = new Set(['XX', 'T1', 'A1', 'A2', 'O1', 'AP', 'EU', 'ZZ']);

// Paths that are never redirected. Prefix match on a segment boundary.
const NEVER_ROUTE = Object.freeze([
  '/api', '/admin', '/healthz', '/ping', '/ads.txt', '/robots.txt', '/sitemap.xml',
  '/favicon.ico', '/privacy', '/terms', '/dmca', '/cookies', '/licenses', '/credits',
  '/assets', '/js', '/css', '/thumbs', '/thumb', '/asset', '/embed', '/hf',
  '/uv', '/sj', '/scram', '/epoxy', '/libcurl', '/baremux', '/wisp', '/bare', '/service',
]);

/** A hostname from "example.com" or "https://example.com", or null. */
function parseHost(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  let u;
  try { u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`); } catch { return null; }
  if (u.protocol !== 'https:') return null;
  if (u.username || u.password || u.port) return null;
  if ((u.pathname && u.pathname !== '/') || u.search || u.hash) return null;
  const h = u.hostname.toLowerCase().replace(/\.+$/, '');
  // A real, dotted DNS name. No IP literals, no localhost — a region is a
  // public domain, and routing visitors to an address would be a typo.
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(h)) return null;
  if (/^\d+(\.\d+){3}$/.test(h)) return null;
  return h;
}

/**
 * Parse and validate the regional configuration.
 * Never throws: a bad entry is skipped and reported, the rest still apply.
 */
export function geoConfig(env = process.env) {
  const warnings = [];
  let header = String(env.GEO_COUNTRY_HEADER || DEFAULT_COUNTRY_HEADER).trim().toLowerCase();
  if (!/^[a-z0-9-]{1,64}$/.test(header)) {
    warnings.push(`GEO_COUNTRY_HEADER "${env.GEO_COUNTRY_HEADER}" is not a header name — using ${DEFAULT_COUNTRY_HEADER}.`);
    header = DEFAULT_COUNTRY_HEADER;
  }

  const regions = [];
  const byCountry = new Map();
  const byHost = new Map();
  let fallback = null;

  const raw = String(env.REGION_ROUTES || '').trim();
  for (const entry of raw.split(';').map((x) => x.trim()).filter(Boolean)) {
    const m = /^([A-Za-z][A-Za-z0-9_]{0,31})\s*:\s*([^=]*?)\s*(?:=\s*(.*))?$/.exec(entry);
    if (!m) { warnings.push(`REGION_ROUTES: "${entry}" is not ID:COUNTRIES[=HOSTS] — skipped.`); continue; }
    const id = m[1].toUpperCase();
    if (regions.some((r) => r.id === id)) { warnings.push(`REGION_ROUTES: region ${id} is defined twice — the second is skipped.`); continue; }

    const countries = [];
    let isDefault = false;
    for (const c of m[2].split(',').map((x) => x.trim().toUpperCase()).filter(Boolean)) {
      if (c === '*') {
        if (fallback) warnings.push(`REGION_ROUTES: ${id} and ${fallback.id} both claim "*" — ${id} is not the catch-all.`);
        else isDefault = true;
        continue;
      }
      if (!/^[A-Z]{2}$/.test(c) || PSEUDO_COUNTRIES.has(c)) {
        warnings.push(`REGION_ROUTES: "${c}" in ${id} is not an ISO country code — skipped.`);
        continue;
      }
      if (byCountry.has(c) || countries.includes(c)) {
        warnings.push(`REGION_ROUTES: ${c} already belongs to ${byCountry.get(c)?.id || id} — not added to ${id}.`);
        continue;
      }
      countries.push(c);
    }

    const hosts = [];
    for (const h of String(m[3] || '').split(',').map((x) => x.trim()).filter(Boolean)) {
      const host = parseHost(h);
      if (!host) { warnings.push(`REGION_ROUTES: "${h}" in ${id} is not an https domain — skipped.`); continue; }
      if (byHost.has(host) || hosts.includes(host)) {
        warnings.push(`REGION_ROUTES: ${host} is already assigned to ${byHost.get(host)?.id || id} — a domain can serve one region only.`);
        continue;
      }
      hosts.push(host);
    }

    if (!countries.length && !isDefault) {
      warnings.push(`REGION_ROUTES: region ${id} names no valid country and is not "*" — skipped.`);
      continue;
    }

    const region = Object.freeze({ id, countries: Object.freeze(countries), hosts: Object.freeze(hosts), isDefault });
    regions.push(region);
    for (const c of countries) byCountry.set(c, region);
    for (const h of hosts) byHost.set(h, region);
    if (isDefault) fallback = region;
  }

  return Object.freeze({
    enabled: regions.length > 0,
    routing: regions.some((r) => r.hosts.length > 0),
    header,
    regions: Object.freeze(regions),
    regionIds: Object.freeze(regions.map((r) => r.id)),
    byCountry,
    byHost,
    fallback,
    warnings: Object.freeze(warnings),
  });
}

/** The visitor's ISO country from the configured header, or null. */
export function countryOf(headers, cfg) {
  if (!cfg?.enabled) return null;
  const v = headers?.[cfg.header];
  const s = String(Array.isArray(v) ? v[0] : (v ?? '')).trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(s) || PSEUDO_COUNTRIES.has(s)) return null;
  return s;
}

/** The region a country belongs to: its own, else the catch-all, else null. */
export function regionOf(country, cfg) {
  if (!cfg?.enabled || !country) return null;
  return cfg.byCountry.get(country) || cfg.fallback || null;
}

/** Is this a browser loading a top-level page (not an asset, API call or frame)? */
export function isTopLevelNavigation(method, headers = {}) {
  const m = String(method || '').toUpperCase();
  if (m !== 'GET' && m !== 'HEAD') return false;
  const dest = String(headers['sec-fetch-dest'] || '').toLowerCase();
  if (dest) return dest === 'document';
  return String(headers.accept || '').toLowerCase().includes('text/html');
}

/** Is `path` one that must never be redirected to another domain? */
export function isNeverRouted(path) {
  const p = String(path || '').split('?')[0].split('#')[0].toLowerCase();
  return NEVER_ROUTE.some((x) => p === x || p.startsWith(x + '/'));
}

// Compiled once. Spelled out rather than built from STAY_COOKIE so that no
// request ever pays for constructing a RegExp.
const STAY_COOKIE_RE = /(?:^|;\s*)zh_geo=stay\s*(?:;|$)/;
function hasStayCookie(cookieHeader) {
  return STAY_COOKIE_RE.test(String(cookieHeader || ''));
}

/**
 * Decide what to do with one request. Pure: no I/O, no state.
 *
 * @param {object} r
 * @param {string} r.method
 * @param {string} r.host        the hostname the visitor asked for (no port)
 * @param {string} r.url         path + query, as received
 * @param {object} r.headers
 * @param {object} cfg           from geoConfig()
 * @param {object} [o]
 * @param {string|(() => string)} [o.grant]  a verified MASQR key to carry across
 *                               the hop — or a function returning one, called
 *                               only when a redirect is actually issued
 * @returns {{action:'none'} | {action:'stay', cookie:string} | {action:'redirect', location:string, region:string}}
 */
export function routeDecision({ method, host, url, headers = {} }, cfg, { grant = '' } = {}) {
  if (!cfg?.routing) return { action: 'none' };
  if (!isTopLevelNavigation(method, headers)) return { action: 'none' };

  const target = String(url || '/');
  const qIndex = target.indexOf('?');
  const path = qIndex === -1 ? target : target.slice(0, qIndex);
  // Origin-form only. An absolute-form target ("GET http://host/...") is a
  // proxy-style request, not a page a visitor navigated to.
  if (!path.startsWith('/')) return { action: 'none' };
  if (isNeverRouted(path)) return { action: 'none' };

  const params = new URLSearchParams(qIndex === -1 ? '' : target.slice(qIndex + 1));
  if (params.get('geo') === 'stay') {
    return { action: 'stay', cookie: `${STAY_COOKIE}=stay; Path=/; Max-Age=${STAY_MAX_AGE_S}; SameSite=Lax` };
  }
  if (hasStayCookie(headers.cookie)) return { action: 'none' };

  const region = regionOf(countryOf(headers, cfg), cfg);
  if (!region || !region.hosts.length) return { action: 'none' };

  const here = String(host || '').toLowerCase().replace(/\.+$/, '');
  if (region.hosts.includes(here)) return { action: 'none' };

  // A MASQR grant lives in a cookie, and cookies do not cross domains — without
  // this a keyed visitor would arrive on their regional domain with no access
  // to the proxy. The key rides the redirect once; MASQR on the other side
  // consumes it and strips it from the URL before anything else sees it.
  const key = typeof grant === 'function' ? grant() : grant;
  if (key && !params.has('k')) params.set('k', key);
  const qs = params.toString();
  return {
    action: 'redirect',
    region: region.id,
    location: `https://${region.hosts[0]}${path}${qs ? '?' + qs : ''}`,
  };
}

/** One line for the boot banner. */
export function geoStatusLine(cfg) {
  if (!cfg?.enabled) return '→ regions:  off (one audience, one domain set)';
  const parts = cfg.regions.map((r) => `${r.id}${r.isDefault ? '(*)' : ''}:${r.countries.length}cc${r.hosts.length ? '→' + r.hosts[0] : ''}`);
  return `→ regions:  ${parts.join(' · ')} · country from ${cfg.header}${cfg.routing ? '' : ' · ad localisation only'}`;
}

export default {
  DEFAULT_COUNTRY_HEADER, STAY_COOKIE, geoConfig, countryOf, regionOf,
  isTopLevelNavigation, isNeverRouted, routeDecision, geoStatusLine,
};
