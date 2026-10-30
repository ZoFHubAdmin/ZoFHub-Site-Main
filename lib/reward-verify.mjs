// lib/reward-verify.mjs — verify a reward-provider postback signature.
// ---------------------------------------------------------------------------
// Pure: no database, no provider-specific knowledge, no network. Takes the
// raw request body (so the signature covers exactly the bytes that were
// signed, not a re-serialized object — the usual way HMAC body-verification
// gets silently broken) and a secret already resolved by the caller
// (lib/reward-mock-provider.mjs today; a real provider's own secret later).
//
// Mirrors lib/admin-auth.mjs's csrfOk()'s constant-time comparison and
// lib/admin-rbac.mjs's "checked first" style: a missing or malformed
// signature is refused before anything else is even parsed.
// ---------------------------------------------------------------------------

import { createHmac, timingSafeEqual } from 'node:crypto';

const ID_RE = /^[A-Za-z0-9_-]{4,128}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Constant-time hex-digest comparison. False on any shape mismatch. */
function hmacMatches(body, secret, signatureHex) {
  if (typeof signatureHex !== 'string' || !/^[0-9a-f]+$/i.test(signatureHex)) return false;
  const want = createHmac('sha256', secret).update(body).digest();
  let got;
  try { got = Buffer.from(signatureHex, 'hex'); } catch { return false; }
  return got.length === want.length && timingSafeEqual(got, want);
}

/**
 * Verify and parse one provider postback.
 *
 * @param {object} o
 * @param {string} o.rawBody        the exact bytes the signature was computed over
 * @param {string} o.signatureHex   hex-encoded HMAC-SHA256 of rawBody
 * @param {string} o.secret         resolved by the caller; '' always refuses
 * @param {number} [o.now]          injectable clock, ms since epoch
 * @param {number} [o.maxSkewMs]    reject a timestamp further from `now` than this
 * @returns {{ ok: boolean, reason?: string, payload?: object }}
 */
export function verifyPostback({ rawBody, signatureHex, secret, now = Date.now(), maxSkewMs = 300_000 }) {
  if (!secret) return { ok: false, reason: 'no_provider_configured' };
  if (typeof rawBody !== 'string' || !rawBody) return { ok: false, reason: 'empty_body' };
  if (!hmacMatches(rawBody, secret, signatureHex)) return { ok: false, reason: 'bad_signature' };

  let parsed;
  try { parsed = JSON.parse(rawBody); } catch { return { ok: false, reason: 'malformed_json' }; }
  if (!parsed || typeof parsed !== 'object') return { ok: false, reason: 'malformed_payload' };

  const { provider, sessionId, campaignId, eventId, timestamp } = parsed;
  if (typeof provider !== 'string' || !ID_RE.test(provider)) return { ok: false, reason: 'bad_provider' };
  if (typeof sessionId !== 'string' || !UUID_RE.test(sessionId)) return { ok: false, reason: 'bad_session_id' };
  if (typeof campaignId !== 'string' || !ID_RE.test(campaignId)) return { ok: false, reason: 'bad_campaign_id' };
  if (typeof eventId !== 'string' || !ID_RE.test(eventId)) return { ok: false, reason: 'bad_event_id' };

  const t = Date.parse(timestamp);
  if (!Number.isFinite(t)) return { ok: false, reason: 'bad_timestamp' };
  if (Math.abs(now - t) > maxSkewMs) return { ok: false, reason: 'timestamp_skew' };

  return { ok: true, payload: { provider, sessionId, campaignId, eventId, timestamp: new Date(t).toISOString() } };
}

export default { verifyPostback };
