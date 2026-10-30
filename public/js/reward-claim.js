// ZoFHub · reward-claim.js — the "Boost" badge and claim card on /browser.
// ---------------------------------------------------------------------------
// Rendered in a shadow root under a custom element name, the same reason
// support-gate.js uses one: page CSS cannot reach in, this CSS cannot leak
// out, and generic element-hiding lists have nothing to match.
//
// THE ONE RULE THIS MODULE FOLLOWS EVERYWHERE: a cached value PAINTS, it
// never DECIDES. store.rewardEntitlement (storage.js) lets the badge show
// something instantly on load instead of a blank flash, but every moment
// that actually matters — opening the claim card, finishing a claim, another
// tab reporting a change — re-fetches GET /api/rewards/entitlement and
// trusts only that answer. A stale local cache must never be read as "boosted
// now"; the whole point of a SERVER-held expiry is that a refreshed tab
// cannot extend it by itself.
//
// Does nothing, inertly, when the feature is off: GET /api/rewards/campaigns
// 404s while REWARDS_ENABLED is unset, which this module treats the same as
// "no campaigns" — the badge simply never appears.
// ---------------------------------------------------------------------------

import { getPlayerId } from './identity.js';
import { store } from './storage.js';

const POLL_MS = 3000;
const POLL_MAX_ATTEMPTS = 40;   // ~2 minutes, comfortably above a 15-minute session_ttl's first event

const CSS = `
:host{all:initial}
*{box-sizing:border-box}
.badge{font:600 12.5px/1 Inter,system-ui,-apple-system,"Segoe UI",sans-serif;display:inline-flex;
  align-items:center;gap:6px;padding:7px 12px;border-radius:999px;cursor:pointer;appearance:none;border:0;
  background:rgba(170,140,255,.14);color:#e7defc;border:1px solid rgba(170,140,255,.34)}
.badge:hover{background:rgba(170,140,255,.22)}
.badge:focus-visible{outline:2px solid #22d3ee;outline-offset:2px}
.badge.on{background:linear-gradient(135deg,#ffd426,#ffb800);color:#241a00;border-color:transparent}
.dot{width:7px;height:7px;border-radius:50%;background:#9b8ad6}
.badge.on .dot{background:#241a00}
[hidden]{display:none!important}

.backdrop{position:fixed;inset:0;z-index:2147482400;display:grid;place-items:center;padding:16px;
  background:rgba(8,6,24,.62);backdrop-filter:blur(3px)}
.card{font:14px/1.5 Inter,system-ui,-apple-system,"Segoe UI",sans-serif;color:#f7f4ff;background:#1f1646;
  border:1px solid rgba(170,140,255,.34);border-radius:16px;box-shadow:0 18px 50px rgba(10,4,32,.62);
  padding:22px 22px 18px;max-width:420px;width:100%}
h2{margin:0 0 8px;font-size:17px;line-height:1.3}
p{margin:0 0 10px;color:#d8cef7}
.muted{color:#a99bd8;font-size:12.5px}
.progress{height:8px;border-radius:999px;background:rgba(255,255,255,.1);overflow:hidden;margin:12px 0}
.progress>i{display:block;height:100%;background:linear-gradient(135deg,#ffd426,#ffb800);transition:width .25s ease}
.row{display:flex;gap:10px;flex-wrap:wrap;margin-top:14px}
button.act{appearance:none;border:0;border-radius:999px;padding:10px 18px;font-family:inherit;font-size:13.5px;
  font-weight:700;line-height:1;cursor:pointer}
.primary{background:#ffd426;color:#241a00}
.ghost{background:rgba(255,255,255,.08);color:#f7f4ff;border:1px solid rgba(170,140,255,.34)}
button.act:focus-visible{outline:3px solid #22d3ee;outline-offset:2px}
button.act:disabled{opacity:.5;cursor:default}
`;

let badgeHost = null, cardHost = null, releaseFocus = null;
let pollTimer = null;

function fmtMinutes(ms) {
  const m = Math.max(0, Math.round(ms / 60000));
  return m < 1 ? '<1m' : `${m}m`;
}

async function fetchEntitlement() {
  try {
    const res = await fetch('/api/rewards/entitlement', { credentials: 'same-origin' });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

async function fetchCampaigns() {
  try {
    const res = await fetch('/api/rewards/campaigns', { credentials: 'same-origin' });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

function renderBadge(state) {
  if (!badgeHost) return;
  const btn = badgeHost.shadowRoot.querySelector('.badge');
  if (!btn) return;
  const active = state?.tier === 'boost' && state.expiresAt && new Date(state.expiresAt) > new Date();
  btn.classList.toggle('on', !!active);
  const dot = btn.querySelector('.dot');
  const label = btn.querySelector('.label');
  if (active) {
    label.textContent = `Boost: ${fmtMinutes(new Date(state.expiresAt) - Date.now())} left`;
  } else {
    label.textContent = 'Get a free Boost';
  }
}

/** The authoritative check. Also updates the display-only cache for next paint. */
async function refresh() {
  const state = await fetchEntitlement();
  if (state?.ok) store.rewardEntitlement.set({ tier: state.tier, expiresAt: state.expiresAt });
  renderBadge(state?.ok ? state : store.rewardEntitlement.get());
  return state;
}

function stopPolling() { if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; } }

function pollEntitlement(onDone) {
  stopPolling();
  let attempts = 0;
  const tick = async () => {
    attempts++;
    const state = await refresh();
    if (state?.ok && state.tier === 'boost') { onDone?.('granted', state); return; }
    if (attempts >= POLL_MAX_ATTEMPTS) { onDone?.('timeout'); return; }
    pollTimer = setTimeout(tick, POLL_MS);
  };
  pollTimer = setTimeout(tick, POLL_MS);
}

function closeCard() {
  stopPolling();
  releaseFocus?.(); releaseFocus = null;
  cardHost?.remove();
  cardHost = null;
}

async function openCard() {
  if (cardHost) return;
  const data = await fetchCampaigns();
  cardHost = document.createElement('zofhub-reward-card');
  const root = cardHost.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = CSS;
  const backdrop = document.createElement('div');
  backdrop.className = 'backdrop';
  const card = document.createElement('div');
  card.className = 'card';
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-modal', 'true');
  card.setAttribute('aria-labelledby', 'zbr-title');

  const title = document.createElement('h2');
  title.id = 'zbr-title';
  title.textContent = '🚀 Get a Boost';

  const campaigns = data?.ok ? (data.campaigns || []) : [];
  const campaign = campaigns[0];

  const body = document.createElement('div');
  if (!campaign) {
    const p = document.createElement('p');
    p.textContent = data?.ok === false || !data
      ? 'Rewarded access is not available right now.'
      : 'No reward provider is configured yet — there is nothing to claim at the moment. Check back later.';
    body.appendChild(p);
  } else {
    const p1 = document.createElement('p');
    p1.textContent = campaign.description
      || `Complete ${campaign.required_events} rewarded video${campaign.required_events === 1 ? '' : 's'} for ${campaign.grant_minutes} minutes of boosted proxy access.`;
    const progress = document.createElement('div');
    progress.className = 'progress';
    const bar = document.createElement('i');
    bar.style.width = '0%';
    progress.appendChild(bar);
    const status = document.createElement('p');
    status.className = 'muted';
    status.textContent = `0 of ${campaign.required_events} completed`;
    body.append(p1, progress, status);

    const row = document.createElement('div');
    row.className = 'row';
    const act = document.createElement('button');
    act.type = 'button';
    act.className = 'act primary';
    act.textContent = data.mockAvailable ? 'Simulate watching a rewarded ad (dev mode)' : 'Watch a rewarded ad';
    if (!data.mockAvailable) {
      act.disabled = true;
      act.title = 'No rewarded-video provider is configured on this deployment yet.';
    }
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'act ghost';
    close.textContent = 'Close';
    close.addEventListener('click', closeCard);
    row.append(act, close);
    body.appendChild(row);

    let session = null;
    act.addEventListener('click', async () => {
      act.disabled = true;
      try {
        if (!session) {
          const created = await fetch('/api/rewards/sessions', {
            method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ campaignId: campaign.id, playerId: getPlayerId() }),
          }).then((r) => r.json()).catch(() => null);
          if (!created?.ok) { status.textContent = 'Could not start — try again shortly.'; act.disabled = false; return; }
          session = created.session;
        }
        const done = await fetch('/api/rewards/dev/mock-complete', {
          method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId: session.id, campaignId: campaign.id }),
        }).then((r) => r.json()).catch(() => null);
        const completed = done?.eventsCompleted ?? 0;
        const required = done?.eventsRequired ?? campaign.required_events;
        bar.style.width = `${Math.min(100, Math.round((completed / Math.max(1, required)) * 100))}%`;
        status.textContent = `${completed} of ${required} completed`;
        if (done?.ok && done.reason === 'entitlement_granted') {
          status.textContent = 'Boost granted!';
          pollEntitlement((outcome) => { if (outcome === 'granted') closeCard(); });
        } else if (done?.reason === 'session_expired' || done?.reason === 'campaign_inactive') {
          status.textContent = 'This claim expired — close and try again.';
        } else {
          act.disabled = false;
        }
      } catch { status.textContent = 'Something went wrong — try again shortly.'; act.disabled = false; }
    });
  }

  card.append(title, body);
  backdrop.appendChild(card);
  root.append(style, backdrop);

  const prevFocus = document.activeElement;
  const onKey = (e) => { if (e.key === 'Escape') closeCard(); };
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) closeCard(); });
  document.addEventListener('keydown', onKey, true);
  releaseFocus = () => { document.removeEventListener('keydown', onKey, true); try { prevFocus?.focus?.(); } catch {} };
  document.body.appendChild(cardHost);
  try { card.querySelector('button, [tabindex]')?.focus(); } catch {}
}

/**
 * Mount the badge into `container` (the /browser toolbar). Does nothing if
 * the feature is off (no active campaigns and the entitlement check 404s).
 */
export async function mountRewardBadge(container) {
  if (!container || badgeHost) return;
  const cached = store.rewardEntitlement.get();
  badgeHost = document.createElement('zofhub-reward');
  badgeHost.style.display = 'inline-flex';
  const root = badgeHost.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = CSS;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'badge';
  btn.innerHTML = '<span class="dot" aria-hidden="true"></span><span class="label">Boost</span>';
  btn.addEventListener('click', openCard);
  root.append(style, btn);
  container.appendChild(badgeHost);

  renderBadge(cached);
  const state = await refresh();
  // Hide entirely if the feature is unreachable AND there is nothing cached
  // to show — a visitor on a deployment that never enabled this should see
  // no trace of it, same as the server's 404-when-disabled routes.
  if (!state && cached.tier === 'free') badgeHost.hidden = true;

  // Multi-tab sync: another tab's successful refresh() wrote the same
  // localStorage key. Re-fetch from the server rather than trusting the
  // event's payload directly — the event only tells us something changed.
  window.addEventListener('storage', (e) => {
    if (e.key && e.key.endsWith(':rewardEntitlement')) refresh();
  });
}

export default { mountRewardBadge };
