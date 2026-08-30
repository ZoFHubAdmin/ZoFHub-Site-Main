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
