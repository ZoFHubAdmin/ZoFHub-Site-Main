// ZoFHub · consent.js — lightweight cookie-consent notice.
// ---------------------------------------------------------------------------
// Shows a one-time banner where the visitor agrees to the Terms of Service and
// cookie use (links the Terms / Cookie / Privacy pages).
// It records the visitor's choice in localStorage and exposes it as
// window.ZOFHUB_CONSENT ('accepted' | 'declined') plus a 'zofhub:consent' event.
//
// IMPORTANT — for legal EEA/UK/Swiss ad-consent you must ALSO enable Google's
// own certified consent message in the AdSense dashboard
// (AdSense → Privacy & messaging → GDPR). That certified CMP does the
// geographically-gated, IAB-TCF consent that Google REQUIRES before serving
// personalised ads in those regions. THIS banner is the friendly, site-wide
// disclosure notice — it does not replace Google's CMP, it complements it.
// We also set Google Consent Mode v2 defaults to 'denied' and flip them to
// 'granted' on accept, which is the recommended low-risk pattern.
// ---------------------------------------------------------------------------

const KEY = 'zofhub:consent:v1';
const isProxyArea = /^\/(uv|scram|gust|epoxy|baremux)\//.test(location.pathname);

// ── Google Consent Mode v2 defaults (queued even before gtag.js loads) ──────
window.dataLayer = window.dataLayer || [];
function gtag() { window.dataLayer.push(arguments); }
function applyConsentMode(granted) {
  const v = granted ? 'granted' : 'denied';
  gtag('consent', granted ? 'update' : 'default', {
    ad_storage: v,
    ad_user_data: v,
    ad_personalization: v,
    analytics_storage: v,
    ...(granted ? {} : { wait_for_update: 500 }),
  });
}

let stored = null;
try { stored = localStorage.getItem(KEY); } catch {}
// Default to denied until the visitor chooses (no-op if they already accepted).
applyConsentMode(stored === 'accepted');
window.ZOFHUB_CONSENT = stored || 'unset';

function persist(choice) {
  try { localStorage.setItem(KEY, choice); } catch {}
  window.ZOFHUB_CONSENT = choice;
  applyConsentMode(choice === 'accepted');
  document.dispatchEvent(new CustomEvent('zofhub:consent', { detail: choice }));
}

// Don't nag returning visitors, and stay out of the proxy browser surface.
if (stored || isProxyArea) {
  // nothing to show
} else {
  injectStyles();
  document.addEventListener('DOMContentLoaded', mountBanner, { once: true });
  if (document.readyState !== 'loading') mountBanner();
}

function injectStyles() {
  if (document.getElementById('zofhub-consent-css')) return;
  const s = document.createElement('style');
  s.id = 'zofhub-consent-css';
  s.textContent = `
  .zh-consent{position:fixed;z-index:9999;left:50%;bottom:16px;transform:translateX(-50%);
    width:min(720px,calc(100vw - 24px));background:#122a52;color:#eaf1ff;
    border:1px solid rgba(125,170,255,.22);border-radius:16px;
    box-shadow:0 24px 60px rgba(0,0,0,.6);padding:16px 18px;
    display:flex;gap:14px;align-items:center;flex-wrap:wrap;
    font-family:Inter,system-ui,sans-serif;animation:zhConsentIn .35s ease both}
  @keyframes zhConsentIn{from{opacity:0;transform:translate(-50%,12px)}to{opacity:1;transform:translate(-50%,0)}}
  .zh-consent__text{flex:1 1 320px;font-size:14px;line-height:1.55;color:#a7bce0;margin:0}
  .zh-consent__text a{color:#29d3ff;text-decoration:none}
  .zh-consent__text a:hover{text-decoration:underline}
  .zh-consent__btns{display:flex;gap:10px;flex:0 0 auto}
  .zh-consent__btn{cursor:pointer;border-radius:10px;padding:10px 16px;font-size:14px;
    font-weight:700;border:1px solid rgba(125,170,255,.30);background:transparent;color:#eaf1ff}
  .zh-consent__btn:hover{border-color:rgba(125,170,255,.6)}
  .zh-consent__btn--primary{background:#ffe000;color:#07142b;border-color:#ffe000}
  .zh-consent__btn--primary:hover{filter:brightness(1.05)}
  @media (max-width:560px){.zh-consent{flex-direction:column;align-items:stretch}
    .zh-consent__btns{justify-content:flex-end}}`;
  document.head.appendChild(s);
}

function mountBanner() {
  if (document.querySelector('.zh-consent')) return;
  const el = document.createElement('div');
  el.className = 'zh-consent';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-label', 'Cookie consent');
  el.innerHTML = `
    <p class="zh-consent__text">
      By clicking <strong>Accept &amp; Play</strong> you agree to our
      <a href="/terms">Terms of Service</a> and our use of cookies
      (<a href="/cookies">Cookie Policy</a> · <a href="/privacy">Privacy Policy</a>).
      Heads-up: games are loaded from other sites and may occasionally be slow or
      need a reload.
    </p>
    <div class="zh-consent__btns">
      <button class="zh-consent__btn" data-choice="declined" type="button">Decline</button>
      <button class="zh-consent__btn zh-consent__btn--primary" data-choice="accepted" type="button">Accept &amp; Play</button>
    </div>`;
  el.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-choice]');
    if (!btn) return;
    persist(btn.dataset.choice);
    el.style.animation = 'zhConsentIn .25s ease reverse both';
    setTimeout(() => el.remove(), 240);
  });
  document.body.appendChild(el);
}
