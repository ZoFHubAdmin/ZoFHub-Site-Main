// lib/reward-mock-provider.mjs — the ONLY reward provider this codebase ships.
// ---------------------------------------------------------------------------
// None of ZoFHub's six ad networks (lib/ad-providers.mjs) are rewarded-video
// or offerwall networks with a server-verified completion postback — they are
// display/interstitial/popunder networks. So there is no real provider to
// integrate yet. This module is the mock adapter the master spec's own §2.3
// asks for in exactly this situation: "implement a mock adapter for
// development and leave production reward granting disabled until a
// trustworthy verification mechanism is configured."
//
// THE RULE, mirroring lib/ai-guard.mjs's AI_FALLBACK_ROUTES exactly:
//
//   NODE_ENV=production   → mockAllowed() is false. Always. Checked first,
//                            so no flag, env var or header can re-open it.
//   anything else          → allowed only when REWARD_MOCK_PROVIDER is set.
//
// A real provider is added later by giving it its own secretForProvider()
// branch (REWARD_<ID>_SECRET) — a config change, not a rewrite of
// lib/reward-verify.mjs, which never knows which provider it is checking.
// ---------------------------------------------------------------------------

import { createHmac, randomBytes } from 'node:crypto';
import { truthy } from './reward-policy.mjs';

/** Is the mock provider allowed to run at all, in this process? */
export function mockAllowed(env = process.env) {
  if (env.NODE_ENV === 'production') return false;   // checked first, no exceptions
  return truthy(env.REWARD_MOCK_PROVIDER);
}

/**
 * The HMAC secret for one provider id. Production reward-granting is
 * disabled with zero special-casing beyond the one NODE_ENV check above:
 * mockAllowed() is always false in production, so this always returns '',
 * so lib/reward-verify.mjs's verifyPostback() always refuses.
 */
export function secretForProvider(providerId, env = process.env) {
  if (providerId === 'mock') {
    return mockAllowed(env) ? String(env.REWARD_MOCK_SECRET || 'zofhub-dev-mock-secret') : '';
  }
  // A real provider, once one is configured: REWARD_<PROVIDERID>_SECRET.
  return String(env[`REWARD_${String(providerId).toUpperCase()}_SECRET`] || '');
}

/**
 * Dev-only helper: self-sign a postback payload exactly the way a real
 * provider's server-to-server callback would carry a signature, so
 * /api/rewards/dev/mock-complete exercises the SAME verify+RPC path a real
 * provider's callback would use — never a shortcut around it.
 */
export function signMockPostback({ sessionId, campaignId, eventId, timestamp, env = process.env }) {
  const secret = secretForProvider('mock', env);
  if (!secret) return null;
  const body = JSON.stringify({ provider: 'mock', sessionId, campaignId, eventId, timestamp });
  const signature = createHmac('sha256', secret).update(body).digest('hex');
  return { body, signature };
}

/** A fresh, unguessable event id for one mock completion. */
export function newMockEventId() {
  return `mock_${randomBytes(16).toString('hex')}`;
}

export default { mockAllowed, secretForProvider, signMockPostback, newMockEventId };
