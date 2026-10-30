// lib/reward-routes.mjs — the public HTTP surface for "Boost", the rewarded
// proxy-access entitlement feature.
// ---------------------------------------------------------------------------
// Structured like lib/admin-api.mjs's mountAdminApi(): one add() helper so no
// route can forget the properties that matter, with the route table kept so
// tests can walk it. The differences from admin-api.mjs are deliberate —
// these routes are PUBLIC (no admin session, no CSRF token), so the
// properties that replace authentication are:
//
//   1. deps.enabled()        checked FIRST, every request — both the
//                             REWARDS_ENABLED env switch (checked once, at
//                             mount time, by the caller) and the live admin
//                             console kill-switch (checked every request,
//                             so turning it off takes effect without a
//                             restart). Disabled => 404, not 403: a visitor
//                             with the feature off should see no trace of it.
//   2. deps.limits.allow(...) a rate-limit scope per route (server.js's
//                             LIMITS registry — rewardSession/rewardCallback/
//                             rewardEntitlement), exactly like every other
//                             public write route in this app.
//   3. TRUST MODEL, stated once: playerId is identity.js's EXISTING device-
//      local id, already used bare (no stronger auth) for score/leaderboard
//      attribution elsewhere on this site. Binding an entitlement to it is
//      the same trust level the rest of the site already has for that value
//      — anyone who learns another visitor's id could in principle act as
//      them. This feature adds no new authentication layer; it reuses the
//      one the site already relies on.
// ---------------------------------------------------------------------------

import express from 'express';
import { parseCookies } from './admin-auth.mjs';
import { rewardsEnabled } from './reward-policy.mjs';
import { mockAllowed, secretForProvider, signMockPostback, newMockEventId } from './reward-mock-provider.mjs';
import { verifyPostback } from './reward-verify.mjs';
import {
  listActiveCampaigns, createSession, applyRewardEvent, getEntitlement,
  isValidCampaignId, isValidPlayerId,
} from './reward-sessions.mjs';

export const PLAYER_COOKIE = 'zh_player_id';
const isSecureEnv = () => process.env.NODE_ENV === 'production';

function setPlayerCookie(res, playerId) {
  const bits = [`${PLAYER_COOKIE}=${encodeURIComponent(playerId)}`, 'Path=/', 'SameSite=Strict', 'HttpOnly', `Max-Age=${31536000}`];
  if (isSecureEnv()) bits.push('Secure');
  res.append('Set-Cookie', bits.join('; '));
}

function playerIdFromRequest(req) {
  const cookie = parseCookies(req.headers?.cookie)[PLAYER_COOKIE];
  if (isValidPlayerId(cookie)) return cookie;
  // Before the first successful session, there is no cookie yet — the client
  // sends its identity.js id directly. Only used to CREATE a session; every
  // other route requires the cookie, so a guess cannot read someone else's
  // entitlement without also knowing their exact id, which this adds no new
  // way to learn (see the trust-model note above).
  return null;
}

export function mountRewardApi(app, deps) {
  const routes = [];
  const json = express.json({ limit: '4kb' });
  const rawBody = express.text({ limit: '4kb', type: '*/*' });

  function add(method, path, { limitScope, parse } = {}, handler) {
    routes.push({ method: method.toUpperCase(), path, limitScope: limitScope || null });
    app[method](path, async (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      if (!deps.enabled()) return res.status(404).json({ ok: false, error: 'not found' });
      if (limitScope && !deps.limits.allow(limitScope, deps.clientIp(req))) {
        return res.status(429).json({ ok: false, error: 'Too many requests — slow down and retry shortly.' });
      }
      if (parse) {
        try { await new Promise((resolve, reject) => parse(req, res, (e) => (e ? reject(e) : resolve()))); }
        catch { return res.status(400).json({ ok: false, error: 'bad request body' }); }
      }
      try { await handler(req, res); }
      catch (e) {
        console.error('[rewards]', method.toUpperCase(), path, e?.message || e);
        res.status(500).json({ ok: false, error: 'internal error' });
      }
    });
  }

  add('get', '/api/rewards/campaigns', { limitScope: 'rewardEntitlement' }, async (req, res) => {
    const supa = deps.getSupabaseAdmin();
    const campaigns = await listActiveCampaigns(supa);
    // Tells the client whether a provider exists at all, so it can show an
    // honest "no reward provider configured yet" message instead of a dev-only
    // button that would not exist in a real deployment, or a dead "watch ad"
    // button that calls a route nothing answers.
    res.json({ ok: true, campaigns, mockAvailable: mockAllowed(process.env) });
  });

  add('post', '/api/rewards/sessions', { limitScope: 'rewardSession', parse: json }, async (req, res) => {
    const campaignId = typeof req.body?.campaignId === 'string' ? req.body.campaignId : '';
    // The FIRST session for a visitor carries their identity.js id directly
    // (no cookie exists yet); every later request uses the cookie this sets.
    const bodyPlayerId = typeof req.body?.playerId === 'string' ? req.body.playerId : '';
    const playerId = playerIdFromRequest(req) || bodyPlayerId;
    if (!isValidCampaignId(campaignId) || !isValidPlayerId(playerId)) {
      return res.status(400).json({ ok: false, error: 'invalid campaignId or playerId' });
    }
    const clientTag = deps.clientTag(req);
    const result = await createSession(deps.getSupabaseAdmin(), { campaignId, playerId, clientTag });
    if (!result.ok) {
      const status = result.reason === 'daily_quota_reached' ? 429 : result.reason === 'campaign_inactive' ? 404 : 503;
      return res.status(status).json({ ok: false, error: result.reason });
    }
    setPlayerCookie(res, playerId);
    await deps.securityEvent?.({ kind: 'reward_session_created', ipHash: clientTag, detail: { campaignId } });
    res.json({ ok: true, session: result.session });
  });

  add('get', '/api/rewards/entitlement', { limitScope: 'rewardEntitlement' }, async (req, res) => {
    const playerId = playerIdFromRequest(req);
    if (!playerId) return res.json({ ok: true, tier: 'free', expiresAt: null });
    const entitlement = await getEntitlement(deps.getSupabaseAdmin(), playerId);
    res.json({ ok: true, tier: entitlement.tier, expiresAt: entitlement.expiresAt });
  });

  // The real postback route. Shape-compatible with the mock callback below —
  // a real provider is wired in later by giving it its own secret in
  // lib/reward-mock-provider.mjs's secretForProvider(), nothing here changes.
  add('post', '/api/rewards/callback', { limitScope: 'rewardCallback', parse: rawBody }, async (req, res) => {
    const sigHeader = req.get('x-reward-signature') || '';
    let providerId = 'mock';
    try { providerId = JSON.parse(req.body)?.provider || 'mock'; } catch { /* verifyPostback below reports malformed_json */ }
    const secret = secretForProvider(providerId, process.env);
    const verdict = verifyPostback({ rawBody: req.body, signatureHex: sigHeader, secret });
    if (!verdict.ok) {
      await deps.securityEvent?.({
        kind: verdict.reason === 'bad_signature' ? 'reward_event_rejected_invalid_signature' : 'reward_event_rejected',
        severity: 'warn', ipHash: deps.clientTag(req), detail: { reason: verdict.reason },
      });
      return res.status(400).json({ ok: false, error: verdict.reason });
    }
    const { sessionId, provider, eventId, timestamp } = verdict.payload;
    const result = await applyRewardEvent(deps.getSupabaseAdmin(), {
      sessionId, provider, providerEventId: eventId, eventTimestamp: timestamp,
    });
    if (result.reason === 'event_already_consumed') {
      await deps.securityEvent?.({ kind: 'reward_event_rejected_replay', severity: 'warn', ipHash: deps.clientTag(req), detail: { sessionId } });
    }
    if (result.ok && result.reason === 'entitlement_granted') {
      deps.entitlementCache?.invalidate(result.playerId);
      await deps.securityEvent?.({ kind: 'reward_entitlement_granted', ipHash: deps.clientTag(req), detail: { playerId: result.playerId, tier: result.tier } });
    }
    res.json({ ok: result.ok, reason: result.reason, eventsCompleted: result.eventsCompleted, eventsRequired: result.eventsRequired, sessionStatus: result.sessionStatus });
  });

  // Dev/test only. Mounted ONLY when mockAllowed(process.env) is true at boot
  // — the same NODE_ENV=production-refuses-first rule as lib/ai-guard.mjs, so
  // there is no code path by which this route exists in production.
  if (mockAllowed(process.env)) {
    add('post', '/api/rewards/dev/mock-complete', { limitScope: 'rewardCallback', parse: json }, async (req, res) => {
      const sessionId = typeof req.body?.sessionId === 'string' ? req.body.sessionId : '';
      const campaignId = typeof req.body?.campaignId === 'string' ? req.body.campaignId : '';
      if (!sessionId || !campaignId) return res.status(400).json({ ok: false, error: 'sessionId and campaignId are required' });
      const signed = signMockPostback({
        sessionId, campaignId, eventId: newMockEventId(), timestamp: new Date().toISOString(), env: process.env,
      });
      if (!signed) return res.status(503).json({ ok: false, error: 'mock provider not configured' });
      const verdict = verifyPostback({ rawBody: signed.body, signatureHex: signed.signature, secret: secretForProvider('mock', process.env) });
      if (!verdict.ok) return res.status(500).json({ ok: false, error: 'mock self-signature failed verification' });
      const result = await applyRewardEvent(deps.getSupabaseAdmin(), {
        sessionId: verdict.payload.sessionId, provider: 'mock',
        providerEventId: verdict.payload.eventId, eventTimestamp: verdict.payload.timestamp,
      });
      if (result.ok && result.reason === 'entitlement_granted') deps.entitlementCache?.invalidate(result.playerId);
      res.json({ ok: result.ok, reason: result.reason, eventsCompleted: result.eventsCompleted, eventsRequired: result.eventsRequired, sessionStatus: result.sessionStatus });
    });
  }

  return { routes, mockMounted: mockAllowed(process.env) };
}

export function rewardApiEnabled(env, settingsGet) {
  if (!rewardsEnabled(env)) return false;
  const consoleValue = settingsGet ? settingsGet('rewards.enabled') : true;
  return consoleValue !== false;
}

export default { mountRewardApi, rewardApiEnabled, PLAYER_COOKIE };
