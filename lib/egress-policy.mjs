// lib/egress-policy.mjs — may a visitor-driven connection leave this server directly?
// ---------------------------------------------------------------------------
// The answer is NO, everywhere, unless a developer explicitly says otherwise on a
// machine that is not production. That one rule is this whole module.
//
// WHAT "VISITOR-DRIVEN" COVERS. Anything this server connects out to because of a
// visitor or a third party rather than because the operator configured it: every
// Wisp tunnel stream (lib/singbox-socket.mjs) and every server-side fetch of a
// URL we did not write ourselves — embeds, thumbnails, assets, link checks,
// importers (lib/safe-fetch.mjs). All of it must cross sing-box, whose routing
// layer is the one place the destination policy is enforced again and the one
// place that counts what actually left.
//
// WHAT IT DOES NOT COVER. The operator's own infrastructure — the database, the
// cache, the mail provider — is not routed through the daemon. Putting the
// database behind a proxy that the site itself supervises would make a daemon
// restart an outage of the whole site. Those hosts are named explicitly instead
// (lib/egress-guard.mjs) and nothing else is let through.
//
// WHY THE DEFAULT FLIPPED. This used to fall back to a direct connection when the
// daemon was not answering, "degraded and visible beats broken and mysterious".
// That is the right trade for a dashboard and the wrong one for a control whose
// purpose is that the server's own address is never exposed to a destination: a
// fallback fires exactly when the daemon is down, which is exactly when an
// attacker (or a crash loop) would want it to. A refused stream is a visible,
// retryable error; a silent direct one is a leak nobody sees.
//
// PRODUCTION IS NOT NEGOTIABLE. Outside production a developer with no sing-box
// binary on their laptop can opt out, loudly. In production those same variables
// are ignored — the check reads NODE_ENV first, with no flag that reopens it —
// the same rule lib/ai-guard.mjs applies to the server-side AI fallback.

const truthy = (v) => /^(1|true|yes|on)$/i.test(String(v ?? '').trim());
// Explicitly negative, not merely absent: an unset variable means "the default".
const negative = (v) => /^(0|false|no|off)$/i.test(String(v ?? '').trim());

export const isProduction = (env = process.env) =>
  String(env.NODE_ENV || '').trim().toLowerCase() === 'production';

/**
 * A connection that could not be carried by sing-box, and may not go direct.
 * Distinct from lib/safe-fetch.mjs's BlockedDestinationError on purpose: that one
 * means "you asked for somewhere we never go" (a client error); this one means
 * "we would have gone, and the egress path is down" (a server-side outage, to be
 * retried). Callers that turn the first into a 4xx must not turn this into one.
 */
export class EgressUnavailableError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'EgressUnavailableError';
    this.code = 'EEGRESS';
  }
}

/**
 * The egress posture for an environment.
 *
 * @returns {{
 *   production: boolean,
 *   directAllowed: boolean,    may a stream go direct when sing-box cannot carry it
 *   singboxEnabled: boolean,   is the daemon tried at all
 *   mode: 'enforced'|'direct-permitted',
 *   requestedOverrides: string[],  every opt-out the environment asked for
 *   ignoredOverrides: string[],    …and the ones refused because this is production
 * }}
 */
export function egressPolicy(env = process.env) {
  const production = isProduction(env);

  const requested = [];
  if (truthy(env.SINGBOX_ALLOW_DIRECT)) requested.push('SINGBOX_ALLOW_DIRECT');
  if (negative(env.SINGBOX_REQUIRE)) requested.push('SINGBOX_REQUIRE=0');
  if (negative(env.SINGBOX_EGRESS)) requested.push('SINGBOX_EGRESS=0');

  const directAllowed = !production && requested.length > 0;
  return {
    production,
    directAllowed,
    // The daemon is tried first unless a developer switched egress off outright
    // (and never in production, where that switch is ignored).
    singboxEnabled: production || !negative(env.SINGBOX_EGRESS),
    mode: directAllowed ? 'direct-permitted' : 'enforced',
    requestedOverrides: requested,
    ignoredOverrides: production ? requested : [],
  };
}

/** One human-readable line for the boot log. Carries no secret. */
export function describeEgressPolicy(policy = egressPolicy()) {
  if (policy.ignoredOverrides.length) {
    return `[egress] production: direct egress is refused unconditionally — ignoring ${policy.ignoredOverrides.join(', ')}`;
  }
  if (policy.directAllowed) {
    return `[egress] DEVELOPMENT: direct egress is PERMITTED (${policy.requestedOverrides.join(', ')}). `
      + 'Traffic that cannot cross sing-box will leave this machine directly. Never set this in production.';
  }
  return '[egress] enforced: every visitor-driven connection crosses sing-box, or is refused';
}
