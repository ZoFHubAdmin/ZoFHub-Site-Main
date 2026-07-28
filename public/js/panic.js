// ZoFHub · panic.js
// ---------------------------------------------------------------------------
// Quick-escape / cloak system. A top-right "Panic" button opens a DROPDOWN
// panel with all the details + settings. A user-customizable hotkey (default
// Ctrl+`) instantly runs the chosen action anywhere on the site.
//
// Three actions (cfg.mode):
//   - cloak    : re-host the whole site inside a fresh about:blank tab and send
//                THIS tab to a safe page (the classic filter-evasion trick).
//                Falls back to redirect if pop-ups are blocked.
//   - redirect : location.replace(url) — the traditional "bail to another page".
//   - overlay  : drop an iframe of the safe page on top of ZoFHub (URL stays).
//
// Settings persist in localStorage via store.panic (storage.js).
// ---------------------------------------------------------------------------

import { store } from './storage.js';
import { $, el, toast } from './utils.js';

// Preset cloak/escape destinations.
const PRESETS = [
  { value: 'https://classroom.google.com/h', label: 'Google Classroom', title: 'Classes', icon: 'https://www.gstatic.com/classroom/favicon.png' },
  { value: 'https://docs.google.com/document/u/0/', label: 'Google Docs',     title: 'Docs',     icon: 'https://ssl.gstatic.com/docs/documents/images/kix-favicon-2023q4.ico' },
  { value: 'https://drive.google.com',             label: 'Google Drive',    title: 'Drive',    icon: 'https://ssl.gstatic.com/images/branding/product/1x/drive_2020q4_32dp.png' },
  { value: 'https://www.khanacademy.org',          label: 'Khan Academy',    title: 'Khan Academy', icon: 'https://cdn.kastatic.org/images/favicon.ico' },
  { value: 'https://en.wikipedia.org/wiki/Main_Page', label: 'Wikipedia',    title: 'Wikipedia, the free encyclopedia', icon: 'https://en.wikipedia.org/static/favicon/wikipedia.ico' },
  { value: 'https://outlook.office.com',           label: 'Outlook',         title: 'Outlook',  icon: 'https://res.cdn.office.net/owa/prem/16.5102.0.4070300/resources/favicon.ico' },
  { value: 'https://www.google.com/search?q=homework+help', label: 'Google Search', title: 'homework help - Google Search', icon: 'https://www.google.com/favicon.ico' },
];

let panelEl, overlayEl, recording = false;

// ── Hotkey helpers ─────────────────────────────────────────────────────────
const MOD_CODES = ['ControlLeft','ControlRight','MetaLeft','MetaRight','AltLeft','AltRight','ShiftLeft','ShiftRight'];
function comboFromEvent(e) {
  if (MOD_CODES.includes(e.code)) return null;        // modifier-only press
  const parts = [];
  if (e.ctrlKey)  parts.push('ctrl');
  if (e.metaKey)  parts.push('meta');
  if (e.altKey)   parts.push('alt');
  if (e.shiftKey) parts.push('shift');
  parts.push(e.code || e.key);
  return parts.join('+');
}
function eventMatchesCombo(e, combo) {
  if (!combo) return false;
  const got = comboFromEvent(e);
  if (got && got.toLowerCase() === combo.toLowerCase()) return true;
  // Back-compat with the legacy e.key format (e.g. 'ctrl+`').
  const parts = [];
  if (e.ctrlKey)  parts.push('ctrl');
  if (e.metaKey)  parts.push('meta');
  if (e.altKey)   parts.push('alt');
  if (e.shiftKey) parts.push('shift');
  parts.push((e.key || '').toLowerCase());
  return parts.join('+') === combo.toLowerCase();
}
function prettyKey(combo) {
  if (!combo) return 'Not set';
  const map = { ctrl: 'Ctrl', meta: '⌘', alt: 'Alt', shift: 'Shift' };
  return combo.split('+').map(p => map[p] ||
    p.replace(/^Key/, '').replace(/^Digit/, '')
     .replace('Backquote', '`').replace('Escape', 'Esc')
     .replace('Space', 'Space').replace('Slash', '/').replace('Period', '.')
  ).join(' + ');
}

// ── Styles (self-contained so the panel works on every page) ────────────────
function injectStyles() {
  if (document.getElementById('panic-css')) return;
  const s = document.createElement('style');
  s.id = 'panic-css';
  s.textContent = `
  .panic-panel{position:fixed;z-index:10000;top:58px;right:12px;width:min(360px,calc(100vw - 20px));
    background:#0e2247;color:#f7f4ff;border:1px solid rgba(255,255,255,.24);border-radius:16px;
    box-shadow:0 28px 70px rgba(0,0,0,.62);padding:16px;font-family:Inter,system-ui,sans-serif;
    animation:panicIn .18s ease both}
  @keyframes panicIn{from{opacity:0;transform:translateY(-8px)}to{opacity:1;transform:none}}
  .panic-panel h2{margin:0 0 4px;font-size:16px;display:flex;align-items:center;gap:8px}
  .panic-panel .panic-sub{margin:0 0 12px;font-size:12px;line-height:1.5;color:#c3b6ee}
  .panic-panel label{display:block;font-size:11px;font-weight:700;letter-spacing:.04em;
    text-transform:uppercase;color:#8aa2cf;margin:12px 0 5px}
  .panic-panel select,.panic-panel input[type=url]{width:100%;box-sizing:border-box;padding:9px 10px;
    background:#0a1a38;color:#f7f4ff;border:1px solid rgba(255,255,255,.24);border-radius:9px;font-size:13px}
  .panic-panel select option,.panic-panel select optgroup{background:#0a1a38;color:#f7f4ff}
  .panic-key{display:flex;align-items:center;gap:8px}
  .panic-key kbd{flex:1;display:inline-block;padding:8px 10px;background:#0a1a38;border:1px solid rgba(255,255,255,.24);
    border-radius:9px;font-size:13px;font-family:inherit;text-align:center;letter-spacing:.02em}
  .panic-key kbd.recording{border-color:#ffd426;color:#ffd426;animation:panicPulse 1s ease infinite}
  @keyframes panicPulse{50%{opacity:.55}}
  .panic-row-check{display:flex;align-items:center;justify-content:space-between;gap:10px;
    font-size:12.5px;color:#cbd9f4;text-transform:none;letter-spacing:0;font-weight:500;margin-top:12px}
  .panic-btns{display:flex;gap:8px;margin-top:14px}
  .panic-btns button{flex:1;cursor:pointer;border-radius:10px;padding:10px;font-size:13px;font-weight:700;
    border:1px solid rgba(255,255,255,.30);background:transparent;color:#f7f4ff}
  .panic-btns button:hover{border-color:rgba(255,255,255,.6)}
  .panic-now{width:100%;cursor:pointer;border:0;border-radius:11px;padding:12px;font-size:14px;font-weight:800;
    color:#241a00;background:linear-gradient(135deg,#ffd426,#ffb800);margin-bottom:4px}
  .panic-now:hover{filter:brightness(1.05)}
  .panic-mini{font-size:11px;color:#7f96c2;margin:8px 0 0;line-height:1.45}
  .panic-overlay{position:fixed;inset:0;z-index:99998;background:#0b0f1a}
  .panic-overlay iframe{border:0;position:fixed;inset:0;width:100%;height:100%}
  @media (max-width:560px){.panic-panel{top:auto;bottom:0;right:0;left:0;width:auto;border-radius:16px 16px 0 0}}`;
  document.head.appendChild(s);
}

// ── Dropdown panel ──────────────────────────────────────────────────────────
function buildPanel() {
  if (panelEl) return panelEl;
  injectStyles();
  panelEl = el('div', { class: 'panic-panel', id: 'panicPanel', hidden: true, role: 'dialog', 'aria-label': 'Panic settings' });
  const cfg = store.panic.get();
  panelEl.innerHTML = `
    <h2>🛡️ Panic / Cloak</h2>
    <p class="panic-sub">Instantly hide ZoFHub. Press your hotkey anywhere, or use the button below.</p>

    <button class="panic-now" id="panicNow" type="button">Hide site now</button>
    <p class="panic-mini" id="panicNowHint"></p>

    <label>Hotkey</label>
    <div class="panic-key">
      <kbd id="panicKey" tabindex="0">${prettyKey(cfg.key)}</kbd>
      <button class="panic-rec-btn" id="panicRec" type="button" style="cursor:pointer;border-radius:9px;padding:8px 12px;font-size:12px;font-weight:700;border:1px solid rgba(255,255,255,.3);background:transparent;color:#f7f4ff">Change</button>
    </div>

    <label>When triggered</label>
    <select id="panicMode">
      <option value="cloak">Cloak — reopen inside an about:blank tab (best)</option>
      <option value="redirect">Redirect — leave for the safe page</option>
      <option value="overlay">Overlay — hide ZoFHub behind the safe page</option>
    </select>

    <label>Safe destination</label>
    <select id="panicPreset">
      ${PRESETS.map(p => `<option value="${p.value}">${p.label}</option>`).join('')}
      <option value="__custom">Custom URL…</option>
    </select>
    <input id="panicCustom" type="url" placeholder="https://example.com" hidden style="margin-top:8px" />

    <label class="panic-row-check"><span>Disguise tab title &amp; favicon</span><input type="checkbox" id="panicDisguise" /></label>

    <div class="panic-btns">
      <button id="panicClose" type="button">Close</button>
      <button id="panicSave" type="button" style="background:rgba(255,255,255,.14);border-color:rgba(255,255,255,.4)">Save</button>
    </div>`;
  document.body.appendChild(panelEl);

  const preset = $('#panicPreset', panelEl);
  const custom = $('#panicCustom', panelEl);
  const mode   = $('#panicMode', panelEl);
  const dis    = $('#panicDisguise', panelEl);
  const keyEl  = $('#panicKey', panelEl);

  // hydrate from saved config
  const matched = PRESETS.find(p => p.value === cfg.url);
  if (matched) { preset.value = matched.value; custom.hidden = true; }
  else { preset.value = '__custom'; custom.hidden = false; custom.value = cfg.url || ''; }
  mode.value = cfg.mode || 'cloak';
  dis.checked = cfg.disguise !== false;
  updateNowHint(mode.value);

  preset.addEventListener('change', () => {
    custom.hidden = preset.value !== '__custom';
    if (!custom.hidden) custom.focus();
  });
  mode.addEventListener('change', () => updateNowHint(mode.value));

  function readForm() {
    const url = preset.value === '__custom' ? (custom.value || '').trim() : preset.value;
    return { url, mode: mode.value, disguise: dis.checked, key: store.panic.get().key };
  }
  function updateNowHint(m) {
    const hint = $('#panicNowHint', panelEl);
    if (hint) hint.textContent = m === 'cloak'
      ? 'Reopens ZoFHub in a blank tab (needs pop-ups allowed) and sends this tab away.'
      : m === 'overlay' ? 'Covers ZoFHub with the safe page — your URL stays the same.'
      : 'Replaces this tab with the safe page.';
  }

  $('#panicNow', panelEl).addEventListener('click', () => { store.panic.set(readForm()); hidePanel(); panic(); });
  $('#panicSave', panelEl).addEventListener('click', () => {
    const next = readForm();
    if (!next.url) { toast('Enter a destination URL', 'err'); return; }
    store.panic.set(next);
    toast('Panic settings saved', 'ok');
    hidePanel();
  });
  $('#panicClose', panelEl).addEventListener('click', hidePanel);

  // hotkey recorder
  $('#panicRec', panelEl).addEventListener('click', () => startRecording(keyEl));
  keyEl.addEventListener('click', () => startRecording(keyEl));

  return panelEl;
}

function startRecording(keyEl) {
  recording = true;
  keyEl.textContent = 'Press keys…';
  keyEl.classList.add('recording');
  toast('Press your new hotkey (Esc to cancel)', 'ok');
}
function stopRecording(keyEl) {
  recording = false;
  keyEl?.classList.remove('recording');
  keyEl && (keyEl.textContent = prettyKey(store.panic.get().key));
}

function showPanel() { buildPanel(); panelEl.hidden = false; }
function hidePanel() { if (panelEl) panelEl.hidden = true; if (recording) stopRecording($('#panicKey', panelEl)); }
export function showSettings() { showPanel(); }

// ── Actions ─────────────────────────────────────────────────────────────────
function ensureOverlay() {
  if (overlayEl) return overlayEl;
  overlayEl = el('div', { class: 'panic-overlay', id: 'panicOverlay', hidden: true });
  overlayEl.innerHTML = `<iframe title="Loading" referrerpolicy="no-referrer"></iframe>`;
  document.body.appendChild(overlayEl);
  return overlayEl;
}

function disguise() {
  const cfg = store.panic.get();
  if (!cfg.disguise) return;
  const matched = PRESETS.find(p => p.value === cfg.url);
  document.title = matched ? matched.title : 'Untitled';
  const fav = document.querySelector('link[rel*="icon"]') || el('link', { rel: 'icon' });
  if (matched) { fav.href = matched.icon; fav.type = 'image/x-icon'; }
  else { fav.href = ''; }
  if (!fav.parentNode) document.head.appendChild(fav);
}

export function panic() {
  const cfg = store.panic.get();
  if (!cfg.url) { showSettings(); return; }
  if (cfg.mode === 'cloak') { openAboutBlank(); return; }
  disguise();
  if (cfg.mode === 'overlay') {
    const ov = ensureOverlay();
    ov.querySelector('iframe').src = cfg.url;
    ov.hidden = false;
  } else {
    try { location.replace(cfg.url); } catch { location.href = cfg.url; }
  }
}

export function unpanic() { if (overlayEl) overlayEl.hidden = true; }

// about:blank cloak — re-host the whole site inside a fresh about:blank tab (the
// visible URL becomes "about:blank", no readable address / history entry points
// at ZoFHub), then send THIS tab somewhere harmless. Falls back to a plain
// redirect if pop-ups are blocked so the escape still works.
export function openAboutBlank() {
  const cfg = store.panic.get();
  const matched = PRESETS.find(p => p.value === cfg.url);
  const useDisguise = cfg.disguise !== false && matched;
  const title = useDisguise ? matched.title : (document.title || 'New Tab');
  const icon  = useDisguise ? matched.icon : '';
  const here  = location.href;
  const safe  = matched ? matched.value : (cfg.url || 'https://www.google.com');

  const win = window.open('about:blank', '_blank');
  if (!win || !win.document) {
    toast('Pop-ups blocked — escaping instead. Allow pop-ups for the cloak.', 'warn');
    try { location.replace(safe); } catch { location.href = safe; }
    return;
  }
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const d = win.document;
  d.open();
  d.write(
    '<!doctype html><html><head><meta charset="utf-8">' +
    '<title>' + esc(title) + '</title>' +
    (icon ? '<link rel="icon" href="' + esc(icon) + '">' : '') +
    '<style>html,body{margin:0;height:100%;background:#0b0f1a;overflow:hidden}' +
    'iframe{border:0;position:fixed;inset:0;width:100%;height:100%;display:block}</style></head>' +
    '<body><iframe src="' + esc(here) + '" allow="autoplay; fullscreen; clipboard-read; clipboard-write; gamepad; encrypted-media"></iframe></body></html>'
  );
  d.close();
  try { location.replace(safe); } catch { location.href = safe; }
}

// ── Global wire-up ──────────────────────────────────────────────────────────
function onKey(e) {
  // Recording a new hotkey?
  if (recording) {
    if (e.key === 'Escape') { e.preventDefault(); stopRecording($('#panicKey', panelEl)); return; }
    const combo = comboFromEvent(e);
    if (!combo) return;               // wait for a non-modifier key
    e.preventDefault();
    store.panic.set({ key: combo });
    stopRecording($('#panicKey', panelEl));
    toast(`Hotkey set to ${prettyKey(combo)}`, 'ok');
    return;
  }
  // Trigger the configured action on the user's hotkey.
  if (eventMatchesCombo(e, store.panic.get().key)) {
    e.preventDefault();
    if (overlayEl && !overlayEl.hidden) { unpanic(); return; }  // toggle overlay off
    panic();
  }
}
document.addEventListener('keydown', onKey, true);

// Header "Panic" button (auto-injected if the page didn't author one).
function wireHeaderButton() {
  let btn = $('#panicBtn') || $('.panic-btn');
  if (!btn) {
    const header = $('.site-header .header-inner') || $('.topbar');
    if (!header) return;
    btn = el('button', { class: 'panic-btn', id: 'panicBtn', title: 'Panic / cloak', 'aria-label': 'Panic / cloak' });
    btn.innerHTML = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M12 9v4M12 17h.01"/><path d="M10.3 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/></svg><span>Panic</span>`;
    header.appendChild(btn);
  }
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    buildPanel();
    panelEl.hidden ? showPanel() : hidePanel();
  });
}

// Close the panel on outside-click.
document.addEventListener('click', (e) => {
  if (!panelEl || panelEl.hidden) return;
  if (panelEl.contains(e.target)) return;
  if (e.target.closest('#panicBtn, .panic-btn')) return;
  hidePanel();
});

if (document.readyState !== 'loading') wireHeaderButton();
else document.addEventListener('DOMContentLoaded', wireHeaderButton);
