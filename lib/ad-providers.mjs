// lib/ad-providers.mjs — the ONE place ZoFHub decides what advertising runs.
// ---------------------------------------------------------------------------
// This module is the single source of truth for: which networks exist, which
// ONE job each of them does, whether each is enabled, what it may render, on
// which surfaces, and in which region. The server, the client, the CSP, the
// admin panel and the legal pages all follow this list rather than restating it.
//
// ── THE SIX NETWORKS AND THEIR ROLES ───────────────────────────────────────
// Every network owns exactly one role and every role has exactly one owner:
//
//   Ad-Maven    interstitial   full-screen unit between games; at most one per
//                              visitor every 20 minutes — a constant, not config
//   ExoClick    display        header 728×90 and sidebar 300×250, nothing else
//   HilltopAds  in-page-push   the in-page push notification overlay
//   Clickadu    preroll        VAST video before a game frame loads (game pages)
//   Mondiad     native         native widgets directly below the "for you" grids
//   PopAds      popunder       desktop game pages only
//
// STRICT, ON PURPOSE. A role renders only its owner's code. If the owner is off
// or unconfigured the role goes dark; another network never "fills in". The
// earlier registry let an enabled network inherit a disabled owner's slots, and
// every time that happened the site ran code the operator had not chosen for
// that position — two scripts competing for one box, layout shift, and a
// placement some network's policy did not allow.
//
// ── WHAT THIS MODULE DELIBERATELY DOES NOT DO ──────────────────────────────
// It makes no claim that any network has approved this site. Approval is per
// domain and per format, and the honest answer for all six is "requires
// publisher approval". Encoding a guess as a fact is how a site gets banned
// while its own config file insists everything is fine.
//
// It never touches, rewrites or injects into proxied content. See SURFACES —
// that boundary is enforced here and asserted in test/ad-architecture.test.mjs.
//
// ── CONFIGURATION ──────────────────────────────────────────────────────────
//   <PREFIX>_ENABLED              "1" turns the network on
//   <PREFIX>_<FIELD>              the role's code (see ROLE_FIELDS)
//   <PREFIX>_<FIELD>__<REGION>    the same field for one region of REGION_ROUTES
//                                 (lib/geo.mjs); every other field still falls
//                                 back to the global value, so a region with a
//                                 partial override never loses a placement
//   <PREFIX>_ZONE                 the network's zone id, for the admin panel only
//
// A network with ENABLED unset renders nothing, costs nothing, and is not
// allowlisted in the CSP. Disabled means genuinely absent, not hidden.

// ── How a policy fact is known ─────────────────────────────────────────────
export const CONFIRMED = 'confirmed';           // stated in the network's own docs
export const NEEDS_APPROVAL = 'needs-approval'; // depends on this specific domain being reviewed
export const UNVERIFIED = 'unverified';         // could not be confirmed from an authoritative source

/** The between-games interstitial may fire at most once per 20 minutes. Not configurable. */
export const INTERSTITIAL_COOLDOWN_MS = 20 * 60 * 1000;

// Several of these networks sell adult demand alongside mainstream. This site's
// audience includes minors, so the category setting in each dashboard is part
// of the integration, not an afterthought.
const MAINSTREAM_ONLY = 'Register the site as MAINSTREAM (non-adult) and exclude adult '
  + 'ad categories in the network dashboard: this site\'s audience includes minors.';

/**
 * The six supported networks. `tier` is the operator's own ranking of them and
 * decides nothing at runtime — every network has its own role, so there is no
 * contest to break.
 */
export const PROVIDERS = [
  {
    id: 'admaven',
    name: 'Ad-Maven',
    env: 'ADMAVEN',
    tier: 1,
    role: 'interstitial',
    docs: 'https://ad-maven.com/publishers/',
    privacy: 'https://ad-maven.com/privacy-policy/',
    formats: ['interstitial', 'direct-link'],
    approval: NEEDS_APPROVAL,
    notes: 'Rendered only inside ZoFHub\'s own between-games overlay, which the client '
         + 'throttles to one per visitor per 20 minutes. A direct-link is a destination '
         + 'URL: it is offered as a labelled link the visitor may click, never auto-opened '
         + 'and never disguised as the Continue control. ' + MAINSTREAM_ONLY,
  },
  {
    id: 'exoclick',
    name: 'ExoClick',
    env: 'EXOCLICK',
    tier: 1,
    role: 'display',
    docs: 'https://www.exoclick.com/publishers/',
    privacy: 'https://www.exoclick.com/privacy-policy/',
    formats: ['banner'],
    approval: NEEDS_APPROVAL,
    notes: 'Header 728×90 and sidebar 300×250 zones only; both boxes are reserved at '
         + 'their full size before the tag loads, so a late creative cannot shift the '
         + 'page. ' + MAINSTREAM_ONLY,
  },
  {
    id: 'hilltopads',
    name: 'HilltopAds',
    env: 'HILLTOPADS',
    tier: 2,
    role: 'in-page-push',
    docs: 'https://hilltopads.com/publishers/',
    privacy: 'https://hilltopads.com/privacy-policy',
    formats: ['in-page-push'],
    approval: NEEDS_APPROVAL,
    notes: 'In-page push only: a loader script the network positions itself. It needs '
         + 'no container, and gets none.',
  },
  {
    id: 'clickadu',
    name: 'Clickadu',
    env: 'CLICKADU',
    tier: 2,
    role: 'preroll',
    docs: 'https://www.clickadu.com/guidelines',
    privacy: 'https://www.clickadu.com/privacy',
    formats: ['video-preroll'],
    approval: NEEDS_APPROVAL,
    notes: 'A VAST tag URL. The game frame loads after the pre-roll completes, is '
         + 'skipped, or fails; Clickadu\'s VAST rules require skipOffset 00:00:05, and the '
         + 'player honours the creative\'s own skip offset. Game pages only. '
         + MAINSTREAM_ONLY,
  },
  {
    id: 'mondiad',
    name: 'Mondiad',
    env: 'MONDIAD',
    tier: 3,
    role: 'native',
    docs: 'https://mondiad.com/publishers',
    privacy: 'https://members.mondiad.com/privacy',
    formats: ['native'],
    approval: NEEDS_APPROVAL,
    notes: 'Paste the delivery code AND the element code together as one tag. Rendered '
         + 'below the "for you" game grids, labelled Sponsored, and only once its row is '
         + 'visible and near the viewport.',
  },
  {
    id: 'popads',
    name: 'PopAds',
    env: 'POPADS',
    tier: 3,
    role: 'popunder',
    docs: 'https://www.popads.net/',
    privacy: 'https://www.popads.net/privacy_policy',
    formats: ['popunder'],
    approval: NEEDS_APPROVAL,
    // The one structural constraint that changes how a tag is handled.
    verbatim: true,
    notes: 'PopAds supplies a code block that must be used UNMODIFIED; it is passed '
         + 'through byte for byte. Desktop game pages only — never mobile, never the hub '
         + 'pages, never a proxy surface.',
  },
];
// Every definition also answers to the older `roles` array shape.
for (const p of PROVIDERS) p.roles = [p.role];

export const PROVIDER_IDS = PROVIDERS.map((p) => p.id);

/**
 * Networks this codebase supported once and no longer does. A console setting
 * or environment variable that still names one is ignored — and reported —
 * rather than treated as an error that would discard the rest of a setting.
 */
export const RETIRED_PROVIDER_IDS = Object.freeze(['monetag', 'adsterra']);
const RETIRED_ENV_PREFIXES = Object.freeze(['MONETAG_', 'ADSTERRA_']);
// Slot-shaped variables from before the provider layer. They carry no network
// identity, so under strict roles there is nothing they could legitimately fill.
const RETIRED_ENV_NAMES = Object.freeze([
  'PROXY_AD_SCRIPTS', 'PROXY_HEADER_TAG', 'PROXY_SIDEBAR_TAG', 'PROXY_BANNER_TAG', 'PROXY_INCONTENT_TAG',
]);

// ── Roles ──────────────────────────────────────────────────────────────────
export const ROLES = ['interstitial', 'display', 'in-page-push', 'preroll', 'native', 'popunder'];

/** The fixed display boxes ZoFHub's own layout reserves. */
export const SLOTS = ['header', 'sidebar'];

/** The provider definition that owns `role`, or undefined. */
export const roleOwner = (role) => PROVIDERS.find((p) => p.role === role);

// What each role reads from the environment, and how each value is parsed:
//   tag      raw HTML, passed through as-is (Google ad code refused)
//   url      one https URL
//   scripts  comma-separated https loader URLs
export const ROLE_FIELDS = Object.freeze({
  interstitial:   Object.freeze({ INTERSTITIAL_TAG: 'tag', INTERSTITIAL_URL: 'url' }),
  display:        Object.freeze({ HEADER_TAG: 'tag', SIDEBAR_TAG: 'tag' }),
  'in-page-push': Object.freeze({ PUSH_SCRIPT: 'scripts' }),
  preroll:        Object.freeze({ PREROLL_VAST: 'url' }),
  native:         Object.freeze({ NATIVE_TAG: 'tag' }),
  popunder:       Object.freeze({ POPUNDER_TAG: 'tag' }),
});

// ── Surfaces ───────────────────────────────────────────────────────────────
// WHICH PAGES MAY CARRY ADVERTISING. This is a compliance and security
// boundary, not a layout preference.
//
// ZoFHub serves two fundamentally different kinds of page from one origin:
//
//   NATIVE      pages ZoFHub authored — the catalog, a game page, the AI page.
//               Our HTML, our content, our layout. Advertising is ours to place.
//
//   PROXY       the web-proxy surfaces. What renders there is SOMEBODY ELSE'S
//               WEBSITE, fetched and rewritten on the visitor's behalf.
//
// Putting our advertising on a proxy surface means monetising a page we do not
// own and did not write, and injecting script into third-party content in
// transit. That is a policy breach for essentially every network, and a
// security problem regardless of policy.
//
// The boundary was NOT enforced before this: public/browser.html imports
// layout.js, which is the module that loads the ad stack — so configuring any
// network would have started serving ads on the proxy page. Nothing in the
// codebase said that was wrong, and nothing tested it.
const NATIVE_SURFACES = [
  '/', '/index.html',
  '/category', '/play',
  '/ai', '/community', '/credits', '/licenses',
  '/privacy', '/terms', '/dmca', '/cookies',
  '/leaderboard',
  '/404',
];

// DELIBERATELY NOT ABOVE: '/donate'.
// It is a native page and it would classify as one, so this is a decision, not
// an omission. Running paid advertising on the page that asks people to fund
// the site undercuts the ask and reads as double-dipping — and several networks
// treat a donation page as a poor-quality placement. It stays ad-free until
// someone decides otherwise on purpose. deny-by-default already enforces that;
// this note exists so the next reader knows it was chosen.

// Anything at or under these is proxy infrastructure. Never advertising.
const PROXY_SURFACES = [
  '/browser',      // ZoFHub's proxy UI — hosts third-party pages in a frame
  '/gust', '/proxy',
  '/uv', '/sj', '/scram', '/epoxy', '/libcurl', '/baremux',
  '/wisp', '/bare',
  // AnuraOS runs on its own origin (see COMPANION_ENGINES in server.js), so
  // ZoFHub never serves an ad into it. Listed anyway: this array is the
  // project's written answer to "is this a proxy surface?", and a future
  // same-origin mount must inherit the refusal rather than be re-argued.
  '/anura',
  // Kasm Workspaces, for the same reason as AnuraOS above: it is operator-
  // hosted on its own origin (PROXY_KASM_URL), so ZoFHub could not inject an ad
  // into it even if it wanted to. Classified anyway, because this array is the
  // project's written answer to "is this a proxy surface?" — and a Kasm session
  // is a whole remote desktop, which is the LAST place an ad script belongs.
  '/kasm',
  // InvisiProxy, for the same reason as AnuraOS and Kasm: it is a separate
  // AGPL-3.0 deployment on its own origin (PROXY_INVISI_URL), so ZoFHub never
  // serves a byte into it. Classified anyway — this array is the project's
  // written answer to "is this a proxy surface?", and it must not have to be
  // re-argued if the path ever becomes same-origin.
  '/invisi',
  '/service', '/sw.js',
];

const cleanPath = (pathname) => String(pathname || '').split('?')[0].split('#')[0].toLowerCase();

/**
 * May this path carry ZoFHub advertising?
 *
 * Deny-by-default on the proxy list, then allow-list the native routes. A path
 * that matches neither returns false: a route nobody classified is a route
 * nobody thought about, and the safe answer for an unclassified surface is "no
 * ads" rather than "ads by default".
 */
export function isAdSurface(pathname) {
  const p = cleanPath(pathname);
  for (const deny of PROXY_SURFACES) {
    if (p === deny || p.startsWith(deny + '/')) return false;
  }
  for (const allow of NATIVE_SURFACES) {
    if (p === allow || p.startsWith(allow + '/')) return true;
  }
  return false;
}

/** A single game's page (/play/<slug>) — where the pre-roll and popunder live. */
export function isGamePage(pathname) {
  return isAdSurface(pathname) && /^\/play\/[^/]+/.test(cleanPath(pathname));
}

export const AD_SURFACES = { native: NATIVE_SURFACES, proxy: PROXY_SURFACES };

// ── Value parsing ──────────────────────────────────────────────────────────

// Google's ad stack is banned outright, on every surface, at every layer.
// AdSense/AdX prohibit proxy and anonymizer domains at the ACCOUNT level, so a
// single stray tag here could take down an unrelated AdSense account. Checked
// here, again in the server's CSP builder, and again client-side before any DOM
// write — three times on purpose.
const GOOGLE_AD_RE = /googlesyndication|googleadservices|adsbygoogle|doubleclick/i;

const truthy = (v) => /^(1|true|yes|on)$/i.test(String(v ?? '').trim());

const cleanScripts = (raw) => String(raw || '')
  .split(',')
  .map((s) => s.trim())
  .filter((s) => /^https:\/\//i.test(s) && !GOOGLE_AD_RE.test(s));

// One https URL, or ''. Used for destinations (Ad-Maven direct-link) and the
// VAST tag, where a list would be meaningless.
const cleanUrl = (raw) => {
  const s = String(raw || '').trim();
  if (!/^https:\/\//i.test(s) || GOOGLE_AD_RE.test(s)) return '';
  try { new URL(s); } catch { return ''; }
  return s;
};

const cleanTag = (raw) => {
  const s = String(raw || '').trim();
  return GOOGLE_AD_RE.test(s) ? '' : s;
};

const PARSE = { tag: cleanTag, url: cleanUrl, scripts: cleanScripts };
const present = (v) => (Array.isArray(v) ? v.length > 0 : Boolean(v));

/** The role's fields for one provider, globally (suffix '') or for one region. */
function readFields(env, prefix, role, suffix) {
  const out = {};
  for (const [field, kind] of Object.entries(ROLE_FIELDS[role])) {
    const v = PARSE[kind](env[`${prefix}_${field}${suffix}`]);
    if (present(v)) out[field] = v;
  }
  return Object.keys(out).length ? out : null;
}

function emptyPlacements() {
  return { header: null, sidebar: null, push: null, interstitial: null, preroll: null, native: null, popunder: null };
}

// Turn one provider's fields into the placement(s) its role fills.
function place(role, provider, f, into) {
  switch (role) {
    case 'display':
      if (f.HEADER_TAG) into.header = { provider, tag: f.HEADER_TAG };
      if (f.SIDEBAR_TAG) into.sidebar = { provider, tag: f.SIDEBAR_TAG };
      break;
    case 'in-page-push':
      if (f.PUSH_SCRIPT) into.push = { provider, scripts: [...f.PUSH_SCRIPT] };
      break;
    case 'interstitial':
      if (f.INTERSTITIAL_TAG || f.INTERSTITIAL_URL) {
        into.interstitial = {
          provider,
          tag: f.INTERSTITIAL_TAG || '',
          url: f.INTERSTITIAL_URL || '',
          cooldownMs: INTERSTITIAL_COOLDOWN_MS,
        };
      }
      break;
    case 'preroll':
      if (f.PREROLL_VAST) into.preroll = { provider, vast: f.PREROLL_VAST };
      break;
    case 'native':
      if (f.NATIVE_TAG) into.native = { provider, tag: f.NATIVE_TAG };
      break;
    case 'popunder':
      if (f.POPUNDER_TAG) into.popunder = { provider, tag: f.POPUNDER_TAG };
      break;
    default:
      break;
  }
}

// Every environment name the registry READS for a provider, including the
// regional variants. Anything else under the provider's prefix is ignored.
function readNames(def, regions) {
  const names = new Set([`${def.env}_ENABLED`, `${def.env}_ZONE`]);
  for (const field of Object.keys(ROLE_FIELDS[def.role])) {
    names.add(`${def.env}_${field}`);
    for (const r of regions) names.add(`${def.env}_${field}__${r}`);
  }
  return names;
}

/**
 * Read the environment and produce the complete advertising picture.
 *
 * Pure: takes an env object, returns a plain value, touches nothing global.
 *
 * @param {object}   env                defaults to process.env
 * @param {object}   [o]
 * @param {string[]} [o.regions]        region ids from lib/geo.mjs
 */
export function resolveAdConfig(env = process.env, { regions = [] } = {}) {
  const regionIds = [...new Set(regions.map((r) => String(r).toUpperCase()))];
  const providers = [];
  const global = emptyPlacements();
  const activeFields = [];
  const ignored = [];

  for (const def of PROVIDERS) {
    const enabled = truthy(env[`${def.env}_ENABLED`]);
    const zone = String(env[`${def.env}_ZONE`] || '').trim();
    const g = readFields(env, def.env, def.role, '');
    const byRegion = {};
    for (const r of regionIds) {
      const f = readFields(env, def.env, def.role, `__${r}`);
      if (f) byRegion[r] = f;
    }
    const configured = Boolean(g || Object.keys(byRegion).length);
    const active = enabled && configured;

    providers.push({
      id: def.id,
      name: def.name,
      env: def.env,
      tier: def.tier,
      role: def.role,
      roles: [def.role],
      docs: def.docs,
      privacy: def.privacy,
      formats: def.formats,
      approval: def.approval,
      notes: def.notes,
      verbatim: Boolean(def.verbatim),
      enabled,
      configured,
      // `active` is the only field that decides whether anything renders.
      // Enabled-but-unconfigured is a common half-finished state and must
      // produce exactly nothing rather than an empty box.
      active,
      zone,
      fieldsProvided: g ? Object.keys(g) : [],
      regionsOverridden: Object.keys(byRegion),
    });

    const known = readNames(def, regionIds);
    for (const [k, v] of Object.entries(env)) {
      if (k.startsWith(def.env + '_') && !known.has(k) && String(v ?? '').trim()) ignored.push(k);
    }

    if (!active) continue;
    if (g) place(def.role, def.id, g, global);
    activeFields.push({ def, g, byRegion });
  }

  // Regional placement sets. A region gets its own entry only when at least one
  // active network overrides something for it; the entry is the global set with
  // those fields replaced, so a partial override never loses a placement.
  const regional = {};
  for (const r of regionIds) {
    if (!activeFields.some((a) => a.byRegion[r])) continue;
    const p = emptyPlacements();
    for (const { def, g, byRegion } of activeFields) {
      const f = byRegion[r] ? { ...(g || {}), ...byRegion[r] } : g;
      if (f) place(def.role, def.id, f, p);
    }
    regional[r] = p;
  }

  for (const [k, v] of Object.entries(env)) {
    if (!String(v ?? '').trim()) continue;
    if (RETIRED_ENV_NAMES.includes(k) || RETIRED_ENV_PREFIXES.some((pre) => k.startsWith(pre))) ignored.push(k);
  }

  const scripts = global.push ? [...global.push.scripts] : [];
  return {
    providers,
    global,
    regional,
    regions: regionIds,
    // Flat views of the GLOBAL set, for the boot log and older readers.
    scripts,
    slots: { header: global.header?.tag || '', sidebar: global.sidebar?.tag || '' },
    slotOwner: Object.fromEntries(SLOTS.filter((s) => global[s]).map((s) => [s, global[s].provider])),
    push: global.push,
    interstitial: global.interstitial,
    ignored: [...new Set(ignored)].sort(),
    anyActive: providers.some((p) => p.active),
    activeIds: providers.filter((p) => p.active).map((p) => p.id),
  };
}

/** The placement set a visitor in `region` sees: its own, else the global one. */
export function placementsFor(cfg, region) {
  if (!cfg) return emptyPlacements();
  return (region && cfg.regional?.[String(region).toUpperCase()]) || cfg.global || emptyPlacements();
}

// Every script origin a placement's markup can load. Tags are raw HTML, so the
// sources come from `src` attributes AND from quoted .js URLs inside inline code
// — PopAds, for one, builds its loader URL in JavaScript, protocol-relative, and
// an attribute-only scan never saw it. A tag whose origin is not allowlisted is
// refused by the browser with only a console line, indistinguishable from the
// network not paying out.
function tagScriptUrls(tag) {
  const out = [];
  const s = String(tag || '');
  for (const m of s.matchAll(/src\s*=\s*["']?((?:https:)?\/\/[^"'\s>]+)/gi)) out.push(m[1]);
  for (const m of s.matchAll(/["'`]((?:https:)?\/\/[a-z0-9.-]+\.[a-z]{2,}(?::\d+)?\/[^"'`\s]*?\.js)(?:[?#][^"'`\s]*)?["'`]/gi)) out.push(m[1]);
  return out.map((u) => (u.startsWith('//') ? 'https:' + u : u));
}

/**
 * The CSP script-src origins the resolved configuration needs, across the
 * global set and every regional one.
 *
 * Derived from configuration rather than hardcoded, because these networks
 * rotate loader domains constantly — a static list would rot silently.
 *
 * @param {object}   cfg      from resolveAdConfig()
 * @param {string[]} extra    PROXY_AD_ORIGINS entries (wildcards allowed)
 */
export function adOrigins(cfg, extra = []) {
  const set = new Set();
  // Only single-label generic TLDs get a registrable-domain wildcard. Without
  // this check, a network on "ads.example.co.uk" would widen the allowlist to
  // ALL of *.co.uk.
  const GENERIC_TLDS = new Set(['com', 'net', 'org', 'io', 'co', 'xyz', 'online', 'site',
    'top', 'pro', 'info', 'biz', 'app', 'dev', 'cloud', 'live', 'media', 'digital',
    'space', 'fun', 'click', 'link', 'shop', 'store']);

  const add = (raw) => {
    const s = String(raw || '').trim();
    if (!/^https:\/\//i.test(s) || GOOGLE_AD_RE.test(s)) return;
    let u; try { u = new URL(s); } catch { return; }
    set.add(u.origin);
    const parts = u.hostname.split('.');
    if (parts.length > 2 && GENERIC_TLDS.has(parts[parts.length - 1])) {
      set.add(`https://*.${parts.slice(-2).join('.')}`);
    }
  };

  const sets = [cfg?.global, ...Object.values(cfg?.regional || {})].filter(Boolean);
  for (const p of sets) {
    for (const url of p.push?.scripts || []) add(url);
    for (const key of ['header', 'sidebar', 'interstitial', 'native', 'popunder']) {
      for (const url of tagScriptUrls(p[key]?.tag)) add(url);
    }
    // The VAST document itself is fetched (connect-src) and its media played
    // (media-src); both are already https-wide. No script-src entry needed.
  }
  for (const raw of extra) {
    const s = String(raw || '').trim();
    if (!s || !/^https:\/\//i.test(s) || GOOGLE_AD_RE.test(s)) continue;
    set.add(s);
    // A CSP wildcard does not cover its own apex: "https://*.foo.com" permits
    // cdn.foo.com but blocks foo.com. Nobody hand-writing this expects that,
    // and the failure is invisible, so honour the obvious intent.
    if (s.startsWith('https://*.')) set.add('https://' + s.slice('https://*.'.length));
  }
  return [...set];
}

/** What a page receives when it may not carry advertising: every field, all empty. */
export function emptyPublicAdConfig() {
  return {
    adScripts: [],
    slots: { header: '', sidebar: '' },
    push: null,
    interstitial: null,
    native: null,
    preroll: null,
    popunder: null,
    proxyAdScripts: [],
    proxyHeaderTag: '',
    proxySidebarTag: '',
  };
}

/**
 * The shape sent to the browser by /api/site-config.
 *
 * Surface-gated (a proxy or unclassified surface gets the empty shape), region-
 * localised, and minimal: NO zone identifiers, NO provider internals, NO env
 * var names — only what the page must actually render. The pre-roll and the
 * popunder travel only to game pages.
 *
 * @param {object} cfg                from resolveAdConfig()
 * @param {object} [o]
 * @param {string} [o.surface]        the page's pathname
 * @param {string} [o.region]         the visitor's region id, if any
 */
export function publicAdConfig(cfg, { surface = '', region = null } = {}) {
  if (!cfg || !isAdSurface(surface)) return emptyPublicAdConfig();
  const p = placementsFor(cfg, region);
  const game = isGamePage(surface);
  const scripts = p.push ? [...p.push.scripts] : [];
  return {
    adScripts: scripts,
    slots: { header: p.header?.tag || '', sidebar: p.sidebar?.tag || '' },
    // `provider` is a network id, not a credential — the client needs it only
    // for disclosure lines and attribution in the ad-block check.
    push: p.push ? { provider: p.push.provider } : null,
    interstitial: p.interstitial ? {
      provider: p.interstitial.provider,
      tag: p.interstitial.tag,
      url: p.interstitial.url,
      cooldownMs: INTERSTITIAL_COOLDOWN_MS,
    } : null,
    native: p.native ? { provider: p.native.provider, tag: p.native.tag } : null,
    preroll: game && p.preroll ? { provider: p.preroll.provider, vast: p.preroll.vast } : null,
    popunder: game && p.popunder ? { provider: p.popunder.provider, tag: p.popunder.tag } : null,
    // Older field names, kept so a copy of layout.js still cached in a visitor's
    // browser keeps working through a deploy.
    proxyAdScripts: scripts,
    proxyHeaderTag: p.header?.tag || '',
    proxySidebarTag: p.sidebar?.tag || '',
  };
}

/**
 * The shape shown in the admin panel.
 *
 * Reports whether each network is configured WITHOUT echoing any tag, zone or
 * credential. An admin needs to know "is PopAds on and does it have a tag" —
 * never the tag itself, which is a bearer credential for that account's revenue.
 */
export function adminAdConfig(cfg) {
  const g = cfg.global || emptyPlacements();
  const ownerOf = (role) => {
    switch (role) {
      case 'display': return g.header?.provider || g.sidebar?.provider || null;
      case 'in-page-push': return g.push?.provider || null;
      default: return g[role]?.provider || null;
    }
  };
  return {
    providers: cfg.providers.map((p) => ({
      id: p.id,
      name: p.name,
      tier: p.tier,
      role: p.role,
      roles: p.roles,
      docs: p.docs,
      privacy: p.privacy,
      formats: p.formats,
      approval: p.approval,
      notes: p.notes,
      enabled: p.enabled,
      configured: p.configured,
      active: p.active,
      hasZone: Boolean(p.zone),
      fieldsProvided: p.fieldsProvided,
      regionsOverridden: p.regionsOverridden,
      slotsProvided: p.fieldsProvided.length,
      envPrefix: p.env,
    })),
    slotOwner: { ...cfg.slotOwner },
    // Who is actually serving each role right now (global set). A role whose
    // owner is off shows null — strict roles never hand it to anyone else.
    roleOwner: Object.fromEntries(ROLES.map((r) => [r, ownerOf(r)])),
    regionsLocalised: Object.keys(cfg.regional || {}),
    interstitialCooldownMs: INTERSTITIAL_COOLDOWN_MS,
    // Names only — never values. Variables that are set but read by nothing.
    ignored: [...(cfg.ignored || [])],
    activeIds: cfg.activeIds,
    anyActive: cfg.anyActive,
  };
}

export default {
  PROVIDERS, PROVIDER_IDS, RETIRED_PROVIDER_IDS, SLOTS, ROLES, ROLE_FIELDS, AD_SURFACES,
  INTERSTITIAL_COOLDOWN_MS, roleOwner, isAdSurface, isGamePage, resolveAdConfig, placementsFor,
  adOrigins, publicAdConfig, emptyPublicAdConfig, adminAdConfig,
  CONFIRMED, NEEDS_APPROVAL, UNVERIFIED,
};
