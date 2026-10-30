// lib/reward-entitlement.mjs — a short-TTL cache so the proxy upgrade path
// (one per tunnel; hundreds of tunnels per minute on a busy deployment) does
// not cost a database round trip per tunnel.
// ---------------------------------------------------------------------------
// Mirrors server.js's existing staffProxyCache idiom: "cached for a minute per
// session token so a proxied page's hundreds of asset requests cost one
// database round trip, not hundreds." Same shape, new purpose.
//
// Fails closed: no Supabase client, no row, an expired row, or any error all
// resolve to the 'free' tier — never to 'boost'. A cache miss costs a visitor
// nothing they did not already have; it must never GRANT something a lookup
// failure cannot prove.
// ---------------------------------------------------------------------------

import { getEntitlement, isValidPlayerId } from './reward-sessions.mjs';

export function createEntitlementCache({ getSupabaseAdmin, ttlMs = 60_000, now = () => Date.now() } = {}) {
  const cache = new Map();   // playerId -> { tier, cachedAt }

  return {
    async tierFor(playerId) {
      if (!isValidPlayerId(playerId)) return 'free';
      const hit = cache.get(playerId);
      if (hit && now() - hit.cachedAt < ttlMs) return hit.tier;

      const supa = getSupabaseAdmin?.();
      if (!supa) return 'free';
      const { tier } = await getEntitlement(supa, playerId);
      cache.set(playerId, { tier, cachedAt: now() });
      return tier;
    },
    /** Forces the next lookup to hit the database — used right after a grant
     *  so the visitor's OWN next tunnel sees it without waiting out the TTL. */
    invalidate(playerId) { cache.delete(playerId); },
    size: () => cache.size,
  };
}

export default { createEntitlementCache };
