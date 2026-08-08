// lib/ad-providers.mjs — the ONE place ZoFHub decides what advertising runs.
// ---------------------------------------------------------------------------
// Before this file, advertising configuration was slot-shaped: four env vars
// held raw HTML for a header/sidebar/footer/in-content box, plus a bag of
// loader-script URLs. That worked, but it could not answer the questions that
// actually matter operationally:
//
//   "Which networks are live right now?"
//   "Turn Adsterra off, leave the rest alone."
//   "Is PopAds configured, and on which surfaces?"
//
// None of those had an answer, because no layer knew a NETWORK existed — only
// slots and URLs. This module adds that layer. It is the single source of truth
// for: which networks exist, whether each is enabled, what it is allowed to
// render, and which surfaces may carry advertising at all.
//
// ── THE FIVE NETWORKS ──────────────────────────────────────────────────────
// HilltopAds · Adsterra · Monetag · Ad-Maven · PopAds. Adding a sixth means
// adding an entry below and nothing else; the server, the client and the admin
// panel all read this list rather than restating it.
//
// ── WHAT THIS MODULE DELIBERATELY DOES NOT DO ──────────────────────────────
// It makes no claim that any network has approved this site. Every policy fact
// below is tagged with how it is known (see COMPLIANCE), and the honest answer
// for most of them is "requires publisher approval" or "not verified". Encoding
// a guess as a fact is how a site gets banned while its own config file insists
// everything is fine.
//
// It also does not touch, rewrite, or inject into proxied content. See
// SURFACES — that boundary is enforced here and asserted in
// test/ad-architecture.test.mjs.

// ── How a policy fact is known ─────────────────────────────────────────────
// Used in the tables below so nothing reads as more settled than it is.
export const CONFIRMED = 'confirmed';           // stated in the network's own docs
export const NEEDS_APPROVAL = 'needs-approval'; // depends on this specific domain being reviewed
export const UNVERIFIED = 'unverified';         // could not be confirmed from an authoritative source

/**
 * The five supported networks.
 *
 * `env` is the config prefix. Every provider reads the same shape, so there is
 * no per-network special casing anywhere in the codebase:
 *
 *   <PREFIX>_ENABLED         "1" / "true" to turn the network on
 *   <PREFIX>_SCRIPT          page-level loader URL(s), comma-separated https
 *   <PREFIX>_ZONE            the network's zone/site identifier, if it issues one
 *   <PREFIX>_HEADER_TAG      raw HTML for the header leaderboard
 *   <PREFIX>_SIDEBAR_TAG     raw HTML for the sidebar rectangle
 *   <PREFIX>_FOOTER_TAG      raw HTML for the footer banner
 *   <PREFIX>_INCONTENT_TAG   raw HTML for the in-content slots
 *
 * A network with ENABLED unset renders nothing, costs nothing, and is not
 * allowlisted in the CSP. Disabled means genuinely absent, not hidden.
 */
export const PROVIDERS = [
  {
    id: 'hilltopads',
    name: 'HilltopAds',
    env: 'HILLTOPADS',
    docs: 'https://hilltopads.com/publishers/',
    // Formats this codebase can render. NOT a claim that the network has
    // approved them for this domain — that is the `approval` field.
    formats: ['banner', 'in-page-push'],
    approval: NEEDS_APPROVAL,
    notes: 'Site must be reviewed and approved by HilltopAds before serving. '
         + 'Confirm which formats are approved for THIS domain before enabling.',
  },
  {
    id: 'adsterra',
    name: 'Adsterra',
    env: 'ADSTERRA',
    docs: 'https://adsterra.com/publishers/',
    formats: ['banner', 'social-bar', 'native-banner'],
    approval: NEEDS_APPROVAL,
    notes: 'Formats are issued per approved domain. Social Bar is intentionally '
         + 'NOT enabled by default — it is an overlay format and must be checked '
         + 'against the placement rules in SURFACES before use.',
  },
  {
    id: 'monetag',
    name: 'Monetag',
    env: 'MONETAG',
    docs: 'https://monetag.com/publishers/',
    formats: ['multitag', 'banner', 'in-page-push'],
    approval: NEEDS_APPROVAL,
    notes: 'MultiTag selects formats server-side, so what it renders can change '
         + 'without a code change here. Review what it is actually serving after '
         + 'enabling, especially on game pages.',
  },
  {
    id: 'admaven',
    name: 'Ad-Maven',
    env: 'ADMAVEN',
    docs: 'https://ad-maven.com/publishers/',
    formats: ['direct-link', 'banner'],
    approval: NEEDS_APPROVAL,
    notes: 'Direct-link is a destination URL, not a script — it must be attached '
         + 'to something a person deliberately clicks, never auto-triggered and '
         + 'never disguised as site navigation.',
  },
  {
    id: 'popads',
    name: 'PopAds',
    env: 'POPADS',
    docs: 'https://www.popads.net/',
    formats: ['popunder'],
    approval: NEEDS_APPROVAL,
    // This is the one structural constraint that changes how we handle a tag.
    verbatim: true,
    notes: 'PopAds supplies a code block that must be used UNMODIFIED. This '
         + 'codebase therefore passes its tag through byte-for-byte and never '
         + 'rewrites, minifies or re-wraps it. Approve the exact URLs it runs on '
         + 'with PopAds first.',
  },
];

export const PROVIDER_IDS = PROVIDERS.map(p => p.id);

// ── Slots ──────────────────────────────────────────────────────────────────
// The four fixed display positions ZoFHub's own layout provides. Order is the
// resolution order: for each slot, the FIRST enabled provider that supplies a
// tag wins it. One slot, one provider, always — two networks in one box means
// duplicate scripts, a broken layout and, on several networks, a policy breach.
export const SLOTS = ['header', 'sidebar', 'footer', 'incontent'];

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
  '/404',
];

// Anything at or under these is proxy infrastructure. Never advertising.
const PROXY_SURFACES = [
  '/browser',      // ZoFHub's proxy UI — hosts third-party pages in a frame
  '/gust', '/proxy',
  '/uv', '/sj', '/scram', '/epoxy', '/libcurl', '/baremux',
  '/wisp', '/bare',
  '/service', '/sw.js',
];

/**
 * May this path carry ZoFHub advertising?
 *
 * Deny-by-default on the proxy list, then allow-list the native routes. A path
 * that matches neither returns false: a route nobody classified is a route
 * nobody thought about, and the safe answer for an unclassified surface is "no
 * ads" rather than "ads by default".
 */
export function isAdSurface(pathname) {
  const p = String(pathname || '').split('?')[0].split('#')[0].toLowerCase();
  for (const deny of PROXY_SURFACES) {
    if (p === deny || p.startsWith(deny + '/')) return false;
  }
  for (const allow of NATIVE_SURFACES) {
    if (p === allow || p.startsWith(allow + '/')) return true;
  }
  return false;
}

export const AD_SURFACES = { native: NATIVE_SURFACES, proxy: PROXY_SURFACES };

// ── Config resolution ──────────────────────────────────────────────────────

// Google's ad stack is banned outright, on every surface, at every layer.
// AdSense/AdX prohibit proxy and anonymizer domains at the ACCOUNT level, so a
// single stray tag here could take down an unrelated AdSense account. Checked
// here, again in the server's CSP builder, and again client-side before any DOM
// write — three times on purpose.
const GOOGLE_AD_RE = /googlesyndication|googleadservices|adsbygoogle|doubleclick/i;

const truthy = (v) => /^(1|true|yes|on)$/i.test(String(v ?? '').trim());

const cleanScripts = (raw) => String(raw || '')
  .split(',')
  .map(s => s.trim())
  .filter(s => /^https:\/\//i.test(s) && !GOOGLE_AD_RE.test(s));

const cleanTag = (raw) => {
  const s = String(raw || '').trim();
  return GOOGLE_AD_RE.test(s) ? '' : s;
};

/**
 * Read the environment and produce the complete advertising picture.
 *
 * Pure: takes an env object, returns a plain value, touches nothing global.
 * That is what makes it testable — every test below constructs a fake env and
 * asserts on the result, with no server and no network.
 *
 * @param {object} env  defaults to process.env
 */
export function resolveAdConfig(env = process.env) {
  const providers = [];
  const slots = { header: '', sidebar: '', footer: '', incontent: '' };
  const slotOwner = {};
  const scripts = [];
  const seenScripts = new Set();

  for (const def of PROVIDERS) {
    const prefix = def.env;
    const enabled = truthy(env[`${prefix}_ENABLED`]);
    const provScripts = cleanScripts(env[`${prefix}_SCRIPT`]);
    const zone = String(env[`${prefix}_ZONE`] || '').trim();
    const tags = {};
    for (const slot of SLOTS) {
      tags[slot] = cleanTag(env[`${prefix}_${slot.toUpperCase()}_TAG`]);
    }
    const configured = Boolean(provScripts.length || zone || SLOTS.some(s => tags[s]));

    providers.push({
      id: def.id,
      name: def.name,
      env: prefix,
      docs: def.docs,
      formats: def.formats,
      approval: def.approval,
      notes: def.notes,
      verbatim: Boolean(def.verbatim),
      enabled,
      configured,
      // `active` is the only field that decides whether anything renders.
      // Enabled-but-unconfigured is a common half-finished state and must
      // produce exactly nothing rather than an empty box.
      active: enabled && configured,
      zone,
      scriptCount: provScripts.length,
      slotsProvided: SLOTS.filter(s => tags[s]),
    });

    if (!(enabled && configured)) continue;

    for (const url of provScripts) {
      // Deduplicate across providers: two networks handed the same CDN URL
      // would otherwise inject the same script twice.
      if (seenScripts.has(url)) continue;
      seenScripts.add(url);
      scripts.push(url);
    }
    // First active provider to offer a slot owns it. Deterministic, because
    // PROVIDERS is an ordered list.
    for (const slot of SLOTS) {
      if (!slots[slot] && tags[slot]) {
        slots[slot] = tags[slot];
        slotOwner[slot] = def.id;
      }
    }
  }

  // ── Legacy slot variables ────────────────────────────────────────────────
  // PROXY_AD_SCRIPTS / PROXY_*_TAG predate the provider layer and are what a
  // currently-deployed instance is configured with. They are still honoured, as
  // a LAST resort, so upgrading this code cannot silently switch off a live
  // site's revenue. They fill only slots no provider claimed.
  //
  // They are deprecated: they carry no network identity, so nothing can report
  // which network is serving or turn one off. `legacyInUse` surfaces that in the
  // admin panel and at boot.
  let legacyInUse = false;
  for (const url of cleanScripts(env.PROXY_AD_SCRIPTS)) {
    if (seenScripts.has(url)) continue;
    seenScripts.add(url);
    scripts.push(url);
    legacyInUse = true;
  }
  // Written as four explicit reads rather than a name->slot lookup table.
  //
  // A table means the variable names only ever exist as string VALUES, so
  // `grep PROXY_BANNER_TAG` finds nothing that looks like a read — and
  // test/deploy-config.test.mjs, which audits render.yaml against what the code
  // actually consumes, reported it as a dead declaration. An env read that no
  // static scan can see is one that eventually gets "cleaned up" by someone
  // tidying config, taking a live site's revenue with it.
  const legacySlots = [
    ['header', cleanTag(env.PROXY_HEADER_TAG)],
    ['sidebar', cleanTag(env.PROXY_SIDEBAR_TAG)],
    ['footer', cleanTag(env.PROXY_BANNER_TAG)],
    ['incontent', cleanTag(env.PROXY_INCONTENT_TAG)],
  ];
  for (const [slot, tag] of legacySlots) {
    if (slots[slot] || !tag) continue;
    slots[slot] = tag;
    slotOwner[slot] = 'legacy';
    legacyInUse = true;
  }

  return {
    providers,
    scripts,
    slots,
    slotOwner,
    legacyInUse,
    anyActive: providers.some(p => p.active) || legacyInUse,
    activeIds: providers.filter(p => p.active).map(p => p.id),
  };
}

/**
 * The CSP script-src origins the resolved configuration needs.
 *
 * Derived from configuration rather than hardcoded, because these networks
 * rotate loader domains constantly — a static list would rot silently, and the
 * only symptom of a blocked ad script is a console message and no revenue.
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

  for (const url of cfg.scripts) add(url);
  // Slot tags are raw HTML; pull the script sources out of them. A tag whose
  // origin is not allowlisted is refused by the browser with only a console
  // line — indistinguishable from the network not paying out.
  for (const slot of SLOTS) {
    for (const m of String(cfg.slots[slot] || '').matchAll(/src\s*=\s*["']?(https:\/\/[^"'\s>]+)/gi)) {
      add(m[1]);
    }
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

/**
 * The shape sent to the browser by /api/site-config.
 *
 * Contains NO zone identifiers, NO provider internals and NO env var names —
 * only the script URLs and slot markup the page must actually render. A visitor
 * has no use for the rest, and every extra field is something an attacker gets
 * to read.
 */
export function publicAdConfig(cfg) {
  return {
    adScripts: cfg.scripts,
    slots: { ...cfg.slots },
    // Legacy field names, kept so an older cached copy of layout.js keeps
    // working through a deploy. Remove once cache TTLs have rolled over.
    proxyAdScripts: cfg.scripts,
    proxyBannerTag: cfg.slots.footer,
    proxyHeaderTag: cfg.slots.header,
    proxySidebarTag: cfg.slots.sidebar,
    proxyInContentTag: cfg.slots.incontent,
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
  return {
    providers: cfg.providers.map(p => ({
      id: p.id,
      name: p.name,
      docs: p.docs,
      formats: p.formats,
      approval: p.approval,
      notes: p.notes,
      enabled: p.enabled,
      configured: p.configured,
      active: p.active,
      hasZone: Boolean(p.zone),
      scriptCount: p.scriptCount,
      slotsProvided: p.slotsProvided,
      envPrefix: p.env,
    })),
    slotOwner: { ...cfg.slotOwner },
    activeIds: cfg.activeIds,
    anyActive: cfg.anyActive,
    legacyInUse: cfg.legacyInUse,
  };
}

export default {
  PROVIDERS, PROVIDER_IDS, SLOTS, AD_SURFACES,
  isAdSurface, resolveAdConfig, adOrigins, publicAdConfig, adminAdConfig,
  CONFIRMED, NEEDS_APPROVAL, UNVERIFIED,
};
