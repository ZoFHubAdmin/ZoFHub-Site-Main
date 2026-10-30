// lib/reward-sessions.mjs — the DB-facing half of the "Boost" reward feature.
// ---------------------------------------------------------------------------
// Every write here goes through the caller's Supabase ADMIN client (same
// trust-boundary pattern as lib/admin-auth.mjs: `if (!supa) return null/[]`,
// fail closed, never fall back to a weaker client). lib/reward-routes.mjs is
// the only caller, and is the only place an HTTP request shape is known —
// this module speaks in validated, already-typed values.
// ---------------------------------------------------------------------------

/** identity.js produces crypto.randomUUID() or a 'p_'-prefixed fallback; this
 *  bounds both shapes the way db/rewards.sql's own CHECK constraint does. */
export const PLAYER_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const CAMPAIGN_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidPlayerId(id) { return typeof id === 'string' && PLAYER_ID_RE.test(id); }
export function isValidCampaignId(id) { return typeof id === 'string' && CAMPAIGN_ID_RE.test(id); }
export function isValidSessionId(id) { return typeof id === 'string' && UUID_RE.test(id); }

/** Every campaign a visitor may currently claim. Never throws. */
export async function listActiveCampaigns(supa) {
  if (!supa) return [];
  try {
    const { data, error } = await supa.from('reward_campaigns')
      .select('id, title, description, tier, required_events, grant_minutes, session_ttl_minutes')
      .eq('status', 'active')
      .order('created_at', { ascending: true });
    return error ? [] : (data || []);
  } catch { return []; }
}

/**
 * Create a new claim session for (campaignId, playerId), enforcing the
 * campaign's daily quota as a plain count — a quota is a 24h-window
 * question, not something a token bucket models well; the per-IP token
 * buckets in server.js's LIMITS are the fast abuse guard layered on top.
 *
 * @returns {{ ok: true, session: object } | { ok: false, reason: string }}
 */
export async function createSession(supa, { campaignId, playerId, clientTag = null }) {
  if (!supa) return { ok: false, reason: 'unavailable' };
  if (!isValidCampaignId(campaignId)) return { ok: false, reason: 'bad_campaign_id' };
  if (!isValidPlayerId(playerId)) return { ok: false, reason: 'bad_player_id' };

  try {
    const { data: campaign, error: campaignErr } = await supa.from('reward_campaigns')
      .select('id, status, required_events, session_ttl_minutes, max_sessions_per_day')
      .eq('id', campaignId).maybeSingle();
    if (campaignErr || !campaign || campaign.status !== 'active') return { ok: false, reason: 'campaign_inactive' };

    const since = new Date(Date.now() - 24 * 3600_000).toISOString();
    const { count, error: countErr } = await supa.from('reward_sessions')
      .select('id', { count: 'exact', head: true })
      .eq('player_id', playerId).eq('campaign_id', campaignId).gte('created_at', since);
    if (countErr) return { ok: false, reason: 'unavailable' };
    if ((count || 0) >= campaign.max_sessions_per_day) return { ok: false, reason: 'daily_quota_reached' };

    const expiresAt = new Date(Date.now() + campaign.session_ttl_minutes * 60_000).toISOString();
    const { data: session, error: insertErr } = await supa.from('reward_sessions').insert({
      campaign_id: campaignId,
      player_id: playerId,
      events_required: campaign.required_events,
      expires_at: expiresAt,
      client_tag: clientTag,
    }).select('id, campaign_id, status, events_required, events_completed, created_at, expires_at').single();
    if (insertErr || !session) return { ok: false, reason: 'unavailable' };
    return { ok: true, session };
  } catch { return { ok: false, reason: 'unavailable' }; }
}

/**
 * Apply one verified provider event to a session. The only caller of the
 * SECURITY DEFINER grant_reward_entitlement() RPC — this is the file
 * test/schema-integrity.test.mjs's "no SECURITY DEFINER function is left
 * without a caller" check scans for, alongside server.js and cron-jobs.mjs.
 */
export async function applyRewardEvent(supa, { sessionId, provider, providerEventId, eventTimestamp }) {
  if (!supa) return { ok: false, reason: 'unavailable' };
  if (!isValidSessionId(sessionId)) return { ok: false, reason: 'bad_session_id' };
  try {
    const { data, error } = await supa.rpc('grant_reward_entitlement', {
      p_session_id: sessionId,
      p_provider: provider,
      p_provider_event_id: providerEventId,
      p_event_timestamp: eventTimestamp,
    });
    if (error) return { ok: false, reason: 'unavailable' };
    const row = Array.isArray(data) ? data[0] : data;
    if (!row) return { ok: false, reason: 'unavailable' };
    // The RPC's output columns are out_* (see db/rewards.sql's comment on
    // grant_reward_entitlement for why: the bare names collided with real
    // table columns inside the function body and Postgres refused to run it).
    return {
      ok: !!row.ok,
      reason: row.reason,
      playerId: row.out_player_id,
      tier: row.out_tier,
      expiresAt: row.out_expires_at,
      eventsCompleted: row.out_events_completed,
      eventsRequired: row.out_events_required,
      sessionStatus: row.session_status,
    };
  } catch { return { ok: false, reason: 'unavailable' }; }
}

/** The visitor's current entitlement, or 'free' if none/expired/unconfigured. */
export async function getEntitlement(supa, playerId) {
  if (!supa || !isValidPlayerId(playerId)) return { tier: 'free', expiresAt: null };
  try {
    const { data, error } = await supa.from('proxy_entitlements')
      .select('tier, expires_at').eq('player_id', playerId).maybeSingle();
    if (error || !data || !data.expires_at || new Date(data.expires_at) <= new Date()) {
      return { tier: 'free', expiresAt: null };
    }
    return { tier: data.tier, expiresAt: data.expires_at };
  } catch { return { tier: 'free', expiresAt: null }; }
}

export default { PLAYER_ID_RE, isValidPlayerId, isValidCampaignId, isValidSessionId, listActiveCampaigns, createSession, applyRewardEvent, getEntitlement };
