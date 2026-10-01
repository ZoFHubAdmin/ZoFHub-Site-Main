// lib/settings-registry.mjs — the configuration an admin may change at runtime.
// ---------------------------------------------------------------------------
// An allowlist of typed keys. Each has a default, a validator with hard bounds,
// the permission that may change it, and whether it is safe to show visitors.
// public.site_settings stores only VALUES; a key that is not defined here is
// ignored when read and refused when written.
//
// WHAT CAN NEVER BE A SETTING
//   · an environment variable — secrets and deployment wiring stay in the host
//     dashboard, where the console cannot read or write them;
//   · code, HTML or a script URL — nothing stored here is ever executed or
//     injected into a page. The announcement is plain text rendered with
//     textContent; ad networks can be switched OFF here but never configured,
//     because their tags live in the environment;
//   · anything that widens the proxy — that is proxy policy, with its own
//     bounds, permission and audit trail (lib/proxy-control.mjs).
// ---------------------------------------------------------------------------

import { PROVIDER_IDS as AD_PROVIDER_IDS, RETIRED_PROVIDER_IDS } from './ad-providers.mjs';

const HTML_RE = /<\s*[a-z!/?]|javascript:|data:text\/html/i;

function plain(v, max, name) {
  if (typeof v !== 'string') return [null, `${name} must be text`];
  const t = v.trim();
  if (t.length > max) return [null, `${name} is longer than ${max} characters`];
  if (HTML_RE.test(t)) return [null, `${name} must be plain text`];
  for (const ch of t) {
    const c = ch.codePointAt(0);
    if ((c < 0x20 && c !== 0x0a) || c === 0x7f || c === 0x2028 || c === 0x2029 || (c >= 0x202a && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069)) {
      return [null, `${name} contains control characters`];
    }
  }
  return [t, null];
}

const bool = (name, def, perm, extra = {}) => ({
  default: def, perm, ...extra,
  describe: extra.describe || name,
  validate: (v) => (typeof v === 'boolean' ? [v, null] : [null, 'must be true or false']),
});

export const SETTINGS = Object.freeze({
  'site.announcement': {
    default: { active: false, text: '', level: 'info' },
    perm: 'settings.manage', public: true,
    describe: 'A one-line banner shown on every public page.',
    validate(v) {
      if (!v || typeof v !== 'object' || Array.isArray(v)) return [null, 'must be an object'];
      const [text, e] = plain(v.text ?? '', 280, 'text');
      if (e) return [null, e];
      if (typeof v.active !== 'boolean') return [null, 'active must be true or false'];
      if (!['info', 'warning'].includes(v.level)) return [null, 'level must be info or warning'];
      if (v.active && !text) return [null, 'an active announcement needs text'];
      return [{ active: v.active, text, level: v.level }, null];
    },
  },
  'site.maintenance': {
    default: { enabled: false, message: '' },
    perm: 'settings.manage', public: true, reauth: true,
    describe: 'Maintenance mode: public pages answer 503 with this message. The admin console and health checks stay up.',
    validate(v) {
      if (!v || typeof v !== 'object' || Array.isArray(v)) return [null, 'must be an object'];
      if (typeof v.enabled !== 'boolean') return [null, 'enabled must be true or false'];
      const [message, e] = plain(v.message ?? '', 200, 'message');
      if (e) return [null, e];
      return [{ enabled: v.enabled, message }, null];
    },
  },
  'features.ai':          bool('AI assistant', true, 'settings.manage', { public: true, describe: 'The AI assistant page and its API.' }),
  'features.community':   bool('Community', true, 'settings.manage', { public: true, describe: 'Community game recommendations.' }),
  'features.leaderboard': bool('Leaderboards', true, 'settings.manage', { public: true, describe: 'Score submission and leaderboards.' }),
  'features.donate':      bool('Donations', true, 'settings.manage', { public: true, describe: 'The donation dialog and /donate.' }),
  'features.subscribe':   bool('Mirror updates', true, 'settings.manage', { public: true, describe: 'The mirror-update email sign-up.' }),
  'features.feedback':    bool('Feedback', true, 'settings.manage', { public: true, describe: 'The contact / feedback form.' }),
  'catalog.gd_auto_import': bool('GameDistribution weekly import', true, 'games.import',
    { describe: 'Run the weekly GameDistribution catalog import.' }),
  'catalog.gd_auto_publish_clean': bool('Auto-publish clean imports', true, 'games.publish',
    { describe: 'Publish imported games that pass every licensing check. Flagged games always wait for review.' }),
  'ads.enabled': bool('Advertising', true, 'ads.manage',
    { describe: 'Master switch. Off removes every ad network from every page, whatever the environment enables.' }),
  'ads.disabled_networks': {
    default: [], perm: 'ads.manage',
    describe: 'Networks switched off from the console. A network can only be ENABLED in the environment.',
    validate(v) {
      const known = AD_PROVIDER_IDS.length + RETIRED_PROVIDER_IDS.length;
      if (!Array.isArray(v) || v.length > known) return [null, 'must be a list of network ids'];
      // A RETIRED id is dropped, not rejected. This validator also runs over
      // stored rows (resolveSettings), and rejecting there discards the WHOLE
      // stored list — so a console that had switched off a network that was
      // later retired would silently switch every other network back on.
      const current = v.filter((x) => !RETIRED_PROVIDER_IDS.includes(x));
      const bad = current.filter((x) => !AD_PROVIDER_IDS.includes(x));
      if (bad.length) return [null, `unknown network(s): ${bad.join(', ')}`];
      return [[...new Set(current)].sort(), null];
    },
  },
  'ads.adblock_gate': bool('Ad-block premium gate', true, 'ads.manage',
    { describe: 'When an ad-blocker is still on after 3 pages, lock AnuraOS and the standalone proxy engines until '
      + 'it is paused. The games hub and the built-in engines are never locked. Only applies while at least one '
      + 'ad network is active.' }),
});

export const SETTING_KEYS = Object.freeze(Object.keys(SETTINGS));

/** Resolve stored rows onto the registry: unknown keys dropped, bad values defaulted. */
export function resolveSettings(rows = []) {
  const out = {};
  const problems = [];
  for (const k of SETTING_KEYS) out[k] = structuredClone(SETTINGS[k].default);
  for (const r of rows || []) {
    if (!r || !Object.hasOwn(SETTINGS, r.key)) continue;
    const [v, err] = SETTINGS[r.key].validate(r.value);
    if (err) problems.push(`${r.key}: stored value ignored (${err})`);
    else out[r.key] = v;
  }
  return { values: out, problems };
}

/** The subset a visitor's browser may see. */
export function publicSettings(values) {
  const out = {};
  for (const k of SETTING_KEYS) if (SETTINGS[k].public) out[k] = values[k];
  return out;
}

export default { SETTINGS, SETTING_KEYS, resolveSettings, publicSettings };
