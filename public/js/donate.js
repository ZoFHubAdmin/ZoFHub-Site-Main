// ZoFHub · donate.js — the "Support ZoFHub" dialog.
//
// Mounted from layout.js alongside feedback.js, and built the same way: it
// injects its own styles and markup on first open rather than requiring an
// empty container in every HTML file.
//
// DESIGN RULES
//  • Nothing is collected. No form, no email, no amount field, no analytics
//    ping. The dialog shows an address and closes. A donation page that tracks
//    you is worse than no donation page.
//  • Privacy is stated per method, not implied by the coin being on the list.
//    Firo is transparent unless the SENDER opts into Spark, and a donor who
//    assumes otherwise has been misled by us, not by Firo.
//  • The address is shown in full, in monospace, broken into groups. A
//    truncated "bc1q…f3t4" is unverifiable, and verifying the first and last
//    characters is exactly how people catch clipboard-hijacking malware.

// The QR is generated from the same address string this page prints, so the two
// can never disagree — see the header of qr.js.
import { qrSvg } from './qr.js';

const ENDPOINT = '/api/donate';
let dialog = null;
let cfg = null;
let lastFocus = null;

function injectStyles() {
  if (document.getElementById('dn-css')) return;
  const s = document.createElement('style');
  s.id = 'dn-css';
  s.textContent = `
  .dn-back{position:fixed;inset:0;z-index:10002;background:rgba(4,7,18,.72);
    backdrop-filter:blur(5px);display:flex;align-items:flex-start;justify-content:center;
    padding:6vh 16px 16px;overflow-y:auto;animation:dnIn .16s ease both}
  /* [hidden] cannot beat display:flex on its own — without this the close
     button appears to do nothing. Same trap as the feedback dialog. */
  .dn-back[hidden]{display:none!important}
  @keyframes dnIn{from{opacity:0}to{opacity:1}}
  .dn-card{width:min(560px,100%);background:var(--surface,#241a55);
    border:1px solid var(--line-2,rgba(170,140,255,.34));border-radius:16px;
    box-shadow:0 30px 80px rgba(0,0,0,.6);padding:20px;
    font-family:Inter,system-ui,sans-serif;color:var(--text,#f7f4ff)}
  .dn-head{display:flex;align-items:center;justify-content:space-between;gap:12px}
  .dn-head h2{margin:0;font-size:17px;font-weight:800}
  .dn-x{background:none;border:0;color:var(--text-dim,#c3b6ee);font-size:22px;
    line-height:1;cursor:pointer;padding:2px 6px;border-radius:8px}
  .dn-x:hover{color:var(--text,#fff);background:rgba(255,255,255,.08)}
  .dn-blurb{margin:6px 0 14px;font-size:12.5px;color:var(--text-dim,#c3b6ee);line-height:1.55}
  .dn-m{border:1px solid var(--line,rgba(170,140,255,.18));border-radius:12px;
    padding:12px;margin-bottom:10px;background:var(--surface-2,#2c2065)}
  .dn-m-top{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
  .dn-m-name{font-weight:800;font-size:14px}
  .dn-tag{font-size:10.5px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;
    padding:2px 7px;border-radius:999px;border:1px solid currentColor}
  .dn-tag.priv{color:#22e06a}
  .dn-tag.pub{color:#ffb020}
  .dn-note{margin:7px 0 0;font-size:11.5px;color:var(--text-dim,#c3b6ee);line-height:1.5}
  .dn-addr{margin-top:9px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
    font-size:12px;line-height:1.65;word-break:break-all;background:var(--bg,#171034);
    border:1px solid var(--line,rgba(170,140,255,.18));border-radius:9px;padding:9px 10px;
    -webkit-user-select:all;user-select:all}
  .dn-row{display:flex;gap:8px;margin-top:9px;flex-wrap:wrap}
  .dn-btn{flex:1;min-width:120px;padding:8px 10px;border-radius:9px;cursor:pointer;font:inherit;
    font-size:12.5px;font-weight:700;background:var(--brand,#ffd426);color:var(--brand-ink,#241a00);
    border:0;text-align:center;text-decoration:none;display:inline-block}
  .dn-btn.alt{background:transparent;color:var(--text,#f7f4ff);
    border:1px solid var(--line-2,rgba(170,140,255,.34))}
  .dn-btn:focus-visible{outline:2px solid var(--brand,#ffd426);outline-offset:2px}
  .dn-warn{margin:12px 0 0;font-size:11px;color:var(--text-mute,#8f81c8);line-height:1.55}
  .dn-empty{font-size:13px;color:var(--text-dim,#c3b6ee);padding:8px 0}
  @media (max-width:520px){.dn-back{padding:0;align-items:stretch}
    .dn-card{border-radius:0;min-height:100%}}
  @media (prefers-reduced-motion: reduce){.dn-back{animation:none}}`;
  document.head.appendChild(s);
}

/** Groups of 4 so a human can actually compare it against their wallet. */
function chunk(addr) {
  return String(addr).replace(/(.{4})/g, '$1 ').trim();
}

function methodCard(m) {
  const el = document.createElement('div');
  el.className = 'dn-m';

  if (m.kind === 'link') {
    el.innerHTML = `
      <div class="dn-m-top"><span class="dn-m-name"></span></div>
      <p class="dn-note"></p>
      <div class="dn-row"><a class="dn-btn" target="_blank" rel="noopener noreferrer">Open</a></div>`;
    el.querySelector('.dn-m-name').textContent = m.label;
    el.querySelector('.dn-note').textContent = m.note || '';
    el.querySelector('.dn-btn').href = m.url;
    return el;
  }

  // On-chain privacy is a property of the COIN, and getting this wrong would
  // mislead a donor about whether their payment is public forever.
  const priv = ['XMR', 'ARRR'].includes(m.ticker);
  el.innerHTML = `
    <div class="dn-m-top">
      <span class="dn-m-name"></span>
      <span class="dn-tag"></span>
    </div>
    <p class="dn-note"></p>
    <div class="dn-addr"></div>
    <div class="dn-row">
      <button class="dn-btn" type="button">Copy address</button>
      <a class="dn-btn alt">Open in wallet</a>
    </div>`;
  el.querySelector('.dn-m-name').textContent = `${m.label} (${m.ticker})`;
  const tag = el.querySelector('.dn-tag');
  tag.textContent = priv ? 'private' : 'public ledger';
  tag.classList.add(priv ? 'priv' : 'pub');
  el.querySelector('.dn-note').textContent = m.note || '';
  el.querySelector('.dn-addr').textContent = chunk(m.address);

  const walletLink = el.querySelector('a.dn-btn');
  if (m.uri) walletLink.href = m.uri; else walletLink.remove();

  const copyBtn = el.querySelector('button.dn-btn');
  copyBtn.addEventListener('click', async () => {
    // Copy the REAL address, never the space-separated display form.
    try {
      await navigator.clipboard.writeText(m.address);
      copyBtn.textContent = 'Copied ✓';
    } catch {
      // Clipboard API needs a secure context and permission; on failure say so
      // rather than silently doing nothing, because the user is about to send
      // money and needs to know they must select it by hand.
      copyBtn.textContent = 'Select it manually';
    }
    setTimeout(() => { copyBtn.textContent = 'Copy address'; }, 1800);
  });
  return el;
}

async function build() {
  injectStyles();
  const back = document.createElement('div');
  back.className = 'dn-back';
  back.hidden = true;
  back.innerHTML = `
    <div class="dn-card" role="dialog" aria-modal="true" aria-labelledby="dnTitle">
      <div class="dn-head">
        <h2 id="dnTitle">Support ZoFHub</h2>
        <button class="dn-x" type="button" id="dnClose" aria-label="Close">&times;</button>
      </div>
      <p class="dn-blurb" id="dnBlurb"></p>
      <div id="dnList"><p class="dn-empty">Loading…</p></div>
      <p class="dn-warn">
        Donations are voluntary and <strong>non-refundable</strong>, and they buy nothing —
        no perks, no ad removal, no special access. Crypto transactions cannot be reversed:
        check the address and the network before sending, and send a small test amount first.
        ZoFHub never asks for a payment through chat, email or a game.
      </p>
    </div>`;
  document.body.appendChild(back);
  back.addEventListener('click', (e) => { if (e.target === back) close(); });
  back.querySelector('#dnClose').addEventListener('click', close);

  const list = back.querySelector('#dnList');
  try {
    const r = await fetch(ENDPOINT, { headers: { Accept: 'application/json' } });
    cfg = await r.json();
  } catch {
    cfg = null;
  }

  list.textContent = '';
  if (!cfg || !cfg.enabled || !cfg.methods?.length) {
    const p = document.createElement('p');
    p.className = 'dn-empty';
    p.textContent = 'Donations are not set up yet — check back soon.';
    list.appendChild(p);
  } else {
    back.querySelector('#dnTitle').textContent = cfg.heading || 'Support ZoFHub';
    back.querySelector('#dnBlurb').textContent = cfg.blurb || '';
    for (const m of cfg.methods) list.appendChild(methodCard(m));
  }
  return back;
}

function onKey(e) { if (e.key === 'Escape') close(); }

function close() {
  if (dialog) dialog.hidden = true;
  document.removeEventListener('keydown', onKey);
  if (lastFocus && lastFocus.isConnected) lastFocus.focus();
}

export async function openDonate() {
  lastFocus = document.activeElement;
  if (!dialog) dialog = await build();
  dialog.hidden = false;
  document.addEventListener('keydown', onKey);
  dialog.querySelector('#dnClose').focus();
}

/** Wire any element carrying [data-donate] to open the dialog. */
export function mountDonate() {
  document.addEventListener('click', (e) => {
    const t = e.target.closest('[data-donate]');
    if (!t) return;
    e.preventDefault();
    openDonate();
  });
}

/**
 * Render the donation methods into a container on a PAGE, rather than into the
 * modal. Shares methodCard() and the same /api/donate response as the dialog,
 * so the two can never drift into showing different addresses — which, for a
 * page whose whole job is displaying wallet addresses, is the failure that
 * matters most.
 */
export async function renderDonateInto(container) {
  if (!container) return;
  injectStyles();
  container.textContent = '';
  const loading = document.createElement('p');
  loading.className = 'dn-empty';
  loading.textContent = 'Loading…';
  container.appendChild(loading);

  let data = null;
  try {
    const r = await fetch(ENDPOINT, { headers: { Accept: 'application/json' } });
    data = await r.json();
  } catch { data = null; }

  container.textContent = '';
  if (!data || !data.enabled || !data.methods?.length) {
    const p = document.createElement('p');
    p.className = 'dn-empty';
    p.textContent = 'Donations are not set up yet — check back soon.';
    container.appendChild(p);
    return;
  }
  cfg = data;
  const h = document.getElementById('donateHeading');
  if (h && data.heading) h.textContent = data.heading;
  const b = document.getElementById('donateBlurb');
  if (b && data.blurb) b.textContent = data.blurb;

  buildPicker(container, data.methods);
}

/**
 * The payment page: pick a coin, then see exactly one address.
 *
 * Showing every wallet at once is how a donor pastes a Monero address into a
 * Bitcoin wallet. One selection, one address, one QR, and the network named on
 * screen — the whole layout exists to make that mistake harder.
 */
function buildPicker(container, methods) {
  const wrap = document.createElement('div');
  wrap.className = 'pay';

  const tabs = document.createElement('div');
  tabs.className = 'pay-tabs';
  tabs.setAttribute('role', 'tablist');
  tabs.setAttribute('aria-label', 'Choose a currency');

  const panel = document.createElement('div');
  panel.className = 'pay-panel';
  panel.setAttribute('role', 'tabpanel');

  methods.forEach((m, i) => {
    const t = document.createElement('button');
    t.type = 'button';
    t.className = 'pay-tab';
    t.id = `paytab-${m.id}`;
    t.setAttribute('role', 'tab');
    t.setAttribute('aria-selected', i === 0 ? 'true' : 'false');
    t.tabIndex = i === 0 ? 0 : -1;
    t.innerHTML =
      `<span class="pay-tick">${escapeHtml(m.ticker || '')}</span>` +
      `<span class="pay-name">${escapeHtml(m.label || m.id)}</span>`;
    t.addEventListener('click', () => select(i));
    tabs.appendChild(t);
  });

  // Arrow keys move between tabs, which is what a tablist is expected to do and
  // what makes this usable without a mouse.
  tabs.addEventListener('keydown', (e) => {
    const keys = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };
    if (!(e.key in keys)) return;
    e.preventDefault();
    const cur = methods.findIndex((m) => document.getElementById(`paytab-${m.id}`).tabIndex === 0);
    select((cur + keys[e.key] + methods.length) % methods.length, true);
  });

  function select(index, focus = false) {
    methods.forEach((m, i) => {
      const t = document.getElementById(`paytab-${m.id}`);
      t.setAttribute('aria-selected', i === index ? 'true' : 'false');
      t.tabIndex = i === index ? 0 : -1;
    });
    const m = methods[index];
    if (focus) document.getElementById(`paytab-${m.id}`).focus();
    renderMethod(panel, m);
  }

  wrap.appendChild(tabs);
  wrap.appendChild(panel);
  container.appendChild(wrap);
  select(0);
}

const escapeHtml = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function renderMethod(panel, m) {
  panel.setAttribute('aria-labelledby', `paytab-${m.id}`);
  // The QR encodes the payment URI when there is one, because that carries the
  // network and any token id with it; otherwise the bare address. Either way it
  // is generated from the SAME string printed below it, so the two cannot drift.
  const payload = m.uri || m.address || '';
  let qr = '<p class="pay-qr-fail">QR unavailable for this address.</p>';
  try {
    qr = qrSvg(payload, { ecl: 'M', label: `${m.label} address` });
  } catch { /* leave the fallback; the address text is the thing that matters */ }

  const verified = m.verified === 'checksum'
    ? '<span class="pay-badge ok">Checksum verified</span>'
    : '<span class="pay-badge warn">Format checked only</span>';

  panel.innerHTML = `
    <div class="pay-grid">
      <figure class="pay-qr">${qr}<figcaption>Scan with a ${escapeHtml(m.label)} wallet</figcaption></figure>
      <div class="pay-detail">
        <h3>${escapeHtml(m.label)} <span class="pay-chip">${escapeHtml(m.ticker || '')}</span></h3>
        ${m.note ? `<p class="pay-note">${escapeHtml(m.note)}</p>` : ''}
        <label class="pay-lbl" for="payAddr">Address — ${escapeHtml(m.label)} network only</label>
        <div class="pay-addr-row">
          <code class="pay-addr" id="payAddr">${escapeHtml(m.address || '')}</code>
          <button type="button" class="pay-copy" id="payCopy">Copy</button>
        </div>
        <p class="pay-verify">${verified}</p>
        ${m.uri ? `<a class="pay-open" href="${escapeHtml(m.uri)}">Open in a wallet app</a>` : ''}
      </div>
    </div>`;

  const copy = panel.querySelector('#payCopy');
  if (copy) {
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(m.address || '');
        copy.textContent = 'Copied';
      } catch {
        // Clipboard can be refused (insecure context, permissions). Select the
        // text instead so the donor can still copy it by hand, rather than
        // showing a success message for something that did not happen.
        const range = document.createRange();
        range.selectNodeContents(panel.querySelector('#payAddr'));
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        copy.textContent = 'Select & copy';
      }
      setTimeout(() => { copy.textContent = 'Copy'; }, 2200);
    });
  }
}