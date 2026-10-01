// ZoFHub · consent.js — lightweight cookie-consent notice.
// ---------------------------------------------------------------------------
// Shows a one-time banner where the visitor agrees to the Terms of Service and
// cookie use (links the Terms / Cookie / Privacy pages).
// It records the visitor's choice in localStorage and exposes it as
// window.ZOFHUB_CONSENT ('accepted' | 'declined') plus a 'zofhub:consent' event.
//
// NOTE — the Google Consent Mode v2 shim that used to live here was REMOVED.
// It pushed ad_storage / ad_user_data / ad_personalization signals into a
// dataLayer for a gtag.js that this site never loads: ZoFHub is a proxy site, so
// Google's ad programs aren't available to it and no Google ad code is served
// (see lib/ad-providers.mjs, proxy-ads.js and ad-slots.js). Signalling
// consent to a tag that doesn't exist did nothing except imply, in code and in
// the legal pages, that Google advertising was active here. If a Google-
// compatible network is ever added, re-add the shim together with Google's own
// certified CMP — not on its own.
//
// This banner remains what it always really was: a site-wide disclosure notice
// for the Terms and cookie use.
// ---------------------------------------------------------------------------

const KEY = 'zofhub:consent:v1';
const isProxyArea = /^\/(uv|scram|gust|epoxy|baremux)\//.test(location.pathname);

let stored = null;
try { stored = localStorage.getItem(KEY); } catch {}
window.ZOFHUB_CONSENT = stored || 'unset';

function persist(choice) {
  try { localStorage.setItem(KEY, choice); } catch {}
  window.ZOFHUB_CONSENT = choice;
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
    width:min(720px,calc(100vw - 24px));background:#2c2065;color:#f7f4ff;
    border:1px solid rgba(255,255,255,.22);border-radius:16px;
    box-shadow:0 24px 60px rgba(0,0,0,.6);padding:16px 18px;
    display:flex;gap:14px;align-items:center;flex-wrap:wrap;
    font-family:Inter,system-ui,sans-serif;animation:zhConsentIn .35s ease both}
  @keyframes zhConsentIn{from{opacity:0;transform:translate(-50%,12px)}to{opacity:1;transform:translate(-50%,0)}}
  .zh-consent__text{flex:1 1 320px;font-size:14px;line-height:1.55;color:#c3b6ee;margin:0}
  .zh-consent__text a{color:#ffd426;text-decoration:none}
  .zh-consent__text a:hover{text-decoration:underline}
  .zh-consent__btns{display:flex;gap:10px;flex:0 0 auto}
  .zh-consent__btn{cursor:pointer;border-radius:10px;padding:10px 16px;font-size:14px;
    font-weight:700;border:1px solid rgba(255,255,255,.30);background:transparent;color:#f7f4ff}
  .zh-consent__btn:hover{border-color:rgba(255,255,255,.6)}
  .zh-consent__btn--primary{background:#ffd426;color:#241a00;border-color:#ffd426}
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
