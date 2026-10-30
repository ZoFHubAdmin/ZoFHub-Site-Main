// lib/reward-policy.mjs — config and the master kill-switch for "Boost", the
// rewarded-access proxy entitlement feature.
// ---------------------------------------------------------------------------
// OFF BY DEFAULT, the same posture as the ad system (lib/ad-providers.mjs):
// fully implemented, but inert until an operator deliberately opts in. Two
// independent switches both have to agree before anything is reachable:
//
//   REWARDS_ENABLED=1          (environment — can the feature exist at all)
//   settings['rewards.enabled'] (admin console — can be flipped off live,
//                                mirroring ads.enabled; cannot re-enable past
//                                what the environment allows)
//
// See docs/README.md's "no offer-to-unlock gates, no forced surveys" line —
// this feature does not contradict it: nothing here ever gates the games hub,
// the catalog, or any BUILT-IN proxy engine's baseline access. The only thing
// a grant ever changes is one stream-count ceiling on one anonymous tunnel;
// free-tier access is full, unblocked access at the cap every visitor has
// always had (lib/proxy-control.mjs's DEFAULT_POLICY.streamsPerTunnel).
// ---------------------------------------------------------------------------

/** Tiers this feature can grant. A second tier would extend both this list
 *  and reward_campaigns' CHECK constraint in db/rewards.sql together. */
export const TIERS = Object.freeze(['boost']);

export function truthy(v) {
  const s = String(v ?? '').trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'on';
}

/** Is the feature enabled at the environment level at all? */
export function rewardsEnabled(env = process.env) {
  return truthy(env.REWARDS_ENABLED);
}

export default { TIERS, truthy, rewardsEnabled };
