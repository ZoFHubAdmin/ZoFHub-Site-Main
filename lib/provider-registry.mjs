// lib/provider-registry.mjs — who may supply games, and from where.
// ---------------------------------------------------------------------------
// Every game the console creates must name a PROVIDER, and its embed URL must be
// served from one of that provider's approved origins:
//
//     game → provider → approved origin → embedding policy
//
// That chain is what stops the CMS becoming "paste any URL and we will frame it
// for every visitor". A new origin is a provider-level decision, taken by
// someone holding providers.manage and recorded in the audit trail — not a side
// effect of editing one game.
//
// The authoritative copy lives in public.game_providers (db/control-plane.sql).
// DEFAULT_PROVIDERS mirrors the migration's seed so a deployment without a
// database — local development, the test suite — applies the same rules.
// ---------------------------------------------------------------------------

export const PROVIDER_STATUSES = Object.freeze(['approved', 'restricted', 'pending', 'suspended', 'revoked']);

/** Statuses whose EXISTING games stay public. */
export const SERVING_STATUSES = Object.freeze(['approved', 'restricted']);
/** Statuses that may receive NEW or re-pointed games. */
export const INTAKE_STATUSES = Object.freeze(['approved']);

// Provider-specific embed path shapes, where the provider documents one. A
// GameDistribution embed is exactly /<32 hex>/ — anything else under that host
// is not a game.
const EMBED_PATHS = Object.freeze({
  gamedistribution: /^\/[0-9a-f]{32}\/?$/,
  gamemonetize: /^\/[a-z0-9]{8,64}\/?$/i,
  y8: /^\/embed\/[a-z0-9_]{1,100}\/?$/i,
});

export const DEFAULT_PROVIDERS = Object.freeze([
  { id: 'gamedistribution', name: 'GameDistribution', status: 'approved', embed_mode: 'direct',
    embed_origins: ['https://html5.gamedistribution.com'], asset_origins: ['https://img.gamedistribution.com'],
    terms_url: 'https://gamedistribution.com/publishers/partnership/',
    license_basis: "Distributes its catalog to third-party portals at no cost through its official feed. Games must run unmodified in GameDistribution's own iframe with its SDK and ads intact." },
  { id: 'gamemonetize', name: 'GameMonetize', status: 'approved', embed_mode: 'direct',
    embed_origins: ['https://html5.gamemonetize.co', 'https://html5.gamemonetize.com'], asset_origins: ['https://img.gamemonetize.com'],
    terms_url: 'https://gamemonetize.com/', license_basis: 'Licensed for third-party embedding through its own iframe and SDK.' },
  { id: 'y8', name: 'Y8 (embed directory)', status: 'approved', embed_mode: 'proxied',
    embed_origins: ['https://www.y8.com', 'https://y8.com'], asset_origins: ['https://cdn.y8.com', 'https://cdn2.y8.com', 'https://img.y8.com'],
    terms_url: 'https://www.y8.com/games_for_your_website', license_basis: 'Y8\'s own "Games for your website" embed directory.' },
  { id: 'onlinegames', name: 'OnlineGames.io', status: 'restricted', embed_mode: 'direct',
    embed_origins: ['https://www.onlinegames.io', 'https://cloud.onlinegames.io'], asset_origins: ['https://www.onlinegames.io'],
    terms_url: null, license_basis: 'Permits embedding via its own codes; hotlink-protected.' },
  { id: 'htmlgames', name: 'HTMLGames', status: 'restricted', embed_mode: 'proxied',
    embed_origins: ['https://cdn.htmlgames.com', 'https://www.htmlgames.com'], asset_origins: ['https://cdn.htmlgames.com', 'https://www.htmlgames.com'],
    terms_url: null, license_basis: 'Free to embed only through its official embed programme.' },
  { id: 'famobi', name: 'Famobi', status: 'restricted', embed_mode: 'proxied',
    embed_origins: ['https://play.famobi.com'], asset_origins: ['https://img.cdn.famobi.com'],
    terms_url: null, license_basis: 'Free to embed through a publisher account and its feed.' },
  { id: 'gameflare', name: 'GameFlare', status: 'restricted', embed_mode: 'direct',
    embed_origins: ['https://distribution.gameflare.com'], asset_origins: ['https://data.gameflare.com'],
    terms_url: null, license_basis: "Requires GameFlare's distribution programme." },
  { id: 'gamezop', name: 'Gamezop', status: 'suspended', embed_mode: 'direct',
    embed_origins: [], asset_origins: ['https://static.gamezop.com'],
    terms_url: null, license_basis: "Embeds carry ANOTHER publisher's partner id — not licensed to this site." },
].map(Object.freeze));

const ID_RE = /^[a-z0-9][a-z0-9-]{1,39}$/;

/**
 * Canonical https origin, or null. No credentials, no path, no non-default
 * port, and never an IP literal or an internal-looking name — an origin is a
 * standing permission to frame content from it, so it must name a real site.
 */
export function normalizeOrigin(raw) {
  let u;
  try { u = new URL(String(raw || '').trim()); } catch { return null; }
  if (u.protocol !== 'https:') return null;
  if (u.username || u.password) return null;
  if (u.port && u.port !== '443') return null;
  if (u.pathname !== '/' || u.search || u.hash) return null;
  const host = u.hostname.toLowerCase();
  if (!host.includes('.') || /^[\d.]+$/.test(host) || host.startsWith('[')) return null;
  if (/(^|\.)(localhost|local|internal|lan|home\.arpa|test|invalid|example)$/.test(host)) return null;
  return `https://${host}`;
}

/** Validate a provider record from the console. Returns { ok, value, errors }. */
export function validateProvider(input, { partial = false } = {}) {
  const errors = [];
  const v = {};
  const has = (k) => Object.prototype.hasOwnProperty.call(input || {}, k);
  const str = (k, max, { required = false } = {}) => {
    if (!has(k)) { if (required && !partial) errors.push(`${k} is required`); return; }
    const raw = input[k];
    if (raw === null || raw === '') { if (required) errors.push(`${k} is required`); else v[k] = null; return; }
    if (typeof raw !== 'string') { errors.push(`${k} must be text`); return; }
    const t = raw.trim();
    if (t.length > max) { errors.push(`${k} is longer than ${max} characters`); return; }
    if (/[<>]/.test(t)) { errors.push(`${k} must not contain < or >`); return; }
    v[k] = t;
  };
  if (!partial) {
    if (typeof input?.id !== 'string' || !ID_RE.test(input.id)) errors.push('id must be 2–40 lowercase letters, digits or hyphens');
    else v.id = input.id;
  }
  str('name', 80, { required: true });
  str('license_basis', 600);
  str('notes', 1000);
  if (has('terms_url')) {
    if (input.terms_url === null || input.terms_url === '') v.terms_url = null;
    else {
      let ok = false;
      try { const u = new URL(String(input.terms_url)); ok = u.protocol === 'https:' && !u.username && !u.password; } catch {}
      if (!ok) errors.push('terms_url must be an https URL'); else v.terms_url = String(input.terms_url).trim();
    }
  }
  if (has('status')) {
    if (!PROVIDER_STATUSES.includes(input.status)) errors.push(`status must be one of ${PROVIDER_STATUSES.join(', ')}`);
    else v.status = input.status;
  } else if (!partial) v.status = 'pending';
  if (has('embed_mode')) {
    if (!['direct', 'proxied'].includes(input.embed_mode)) errors.push('embed_mode must be direct or proxied');
    else v.embed_mode = input.embed_mode;
  }
  for (const k of ['embed_origins', 'asset_origins']) {
    if (!has(k)) continue;
    if (!Array.isArray(input[k]) || input[k].length > 12) { errors.push(`${k} must be a list of at most 12 origins`); continue; }
    const out = [];
    for (const o of input[k]) {
      const n = normalizeOrigin(o);
      if (!n) { errors.push(`${k}: "${String(o).slice(0, 80)}" is not a valid https origin`); continue; }
      if (!out.includes(n)) out.push(n);
    }
    v[k] = out;
  }
  if (has('allow_features')) {
    const OK = ['autoplay', 'fullscreen', 'gamepad', 'accelerometer', 'gyroscope', 'clipboard-write'];
    if (!Array.isArray(input.allow_features) || input.allow_features.some((f) => !OK.includes(f))) {
      errors.push(`allow_features may only contain ${OK.join(', ')}`);
    } else v.allow_features = [...new Set(input.allow_features)];
  }
  if (has('sandbox_policy')) {
    // Either none, or a space-separated list of known sandbox tokens. Never
    // allow-same-origin together with allow-scripts: that pair lets the framed
    // document remove its own sandbox.
    const raw = input.sandbox_policy;
    if (raw === null || raw === '') v.sandbox_policy = null;
    else {
      const TOK = ['allow-scripts', 'allow-same-origin', 'allow-forms', 'allow-pointer-lock', 'allow-popups', 'allow-orientation-lock'];
      const toks = String(raw).trim().split(/\s+/);
      if (toks.some((t) => !TOK.includes(t))) errors.push(`sandbox_policy may only contain ${TOK.join(', ')}`);
      else if (toks.includes('allow-scripts') && toks.includes('allow-same-origin')) {
        errors.push('sandbox_policy must not combine allow-scripts with allow-same-origin');
      } else v.sandbox_policy = [...new Set(toks)].join(' ');
    }
  }
  return { ok: errors.length === 0, value: v, errors };
}

/**
 * An in-memory view of the providers, rebuilt whenever the table changes.
 * Holds no I/O; the server feeds it rows.
 */
export function createProviderIndex(rows = DEFAULT_PROVIDERS) {
  const byId = new Map();
  const byEmbedOrigin = new Map();
  for (const r of rows || []) {
    if (!r || !ID_RE.test(r.id)) continue;
    const rec = {
      ...r,
      embed_origins: (r.embed_origins || []).map(normalizeOrigin).filter(Boolean),
      asset_origins: (r.asset_origins || []).map(normalizeOrigin).filter(Boolean),
    };
    byId.set(rec.id, rec);
    for (const o of rec.embed_origins) byEmbedOrigin.set(o, rec);
  }
  const originOf = (url) => { try { const u = new URL(url); return u.protocol === 'https:' ? `https://${u.hostname.toLowerCase()}` : null; } catch { return null; } };
  return {
    get: (id) => byId.get(id) || null,
    list: () => [...byId.values()],
    /** The provider whose approved embed origin serves this URL, or null. */
    forEmbedUrl(url) { const o = originOf(url); return o ? byEmbedOrigin.get(o) || null : null; },
    /** Is `url` an acceptable embed for provider `id`? Returns a reason when not. */
    checkEmbed(id, url) {
      const p = byId.get(id);
      if (!p) return 'unknown provider';
      const o = originOf(url);
      if (!o || !p.embed_origins.includes(o)) return `embed URL must be served from ${p.name}'s approved origins (${p.embed_origins.join(', ') || 'none configured'})`;
      const re = EMBED_PATHS[id];
      if (re) { try { if (!re.test(new URL(url).pathname)) return `not a ${p.name} game URL`; } catch { return 'unparseable URL'; } }
      return null;
    },
    checkAsset(id, url) {
      const p = byId.get(id);
      if (!p) return 'unknown provider';
      const o = originOf(url);
      if (!o || !p.asset_origins.includes(o)) return `thumbnail must come from ${p.name}'s approved image origins (${p.asset_origins.join(', ') || 'none configured'}) or this site's /thumbs/`;
      return null;
    },
    /**
     * Should this provider's existing games be served? NO provider (a legacy
     * row predating the registry) is served; an id the registry does not know
     * is NOT — naming a provider that was never approved is not a licence.
     */
    serves(id) {
      if (!id) return true;
      const p = byId.get(id);
      return !!p && SERVING_STATUSES.includes(p.status);
    },
    acceptsNew(id) { const p = byId.get(id); return !!p && INTAKE_STATUSES.includes(p.status); },
  };
}

export default { PROVIDER_STATUSES, SERVING_STATUSES, INTAKE_STATUSES, DEFAULT_PROVIDERS, normalizeOrigin, validateProvider, createProviderIndex };
