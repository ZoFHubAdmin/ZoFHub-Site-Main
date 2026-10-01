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
import { $, el, toast, trapFocus } from './utils.js';

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
  /* The cover screen. Rendered LOCALLY and never from a remote URL: the old
     build dropped an <iframe> of Google Classroom/Docs/Drive on top of the page,
     and every one of those sends X-Frame-Options, so the "cover" was a blank
     box that announced something was being hidden. A local screen also paints
     instantly, works offline, and cannot break when somebody else changes a
     header. Deliberately unbranded — it imitates no real company's product. */
  .panic-overlay{position:fixed;inset:0;z-index:2147483600;background:#ffffff;
    display:flex;flex-direction:column;font-family:ui-sans-serif,system-ui,"Segoe UI",Arial,sans-serif;color:#202124}
  .panic-overlay[hidden]{display:none}
  .pq-bar{display:flex;align-items:center;gap:10px;padding:10px 16px;border-bottom:1px solid #e3e3e3;background:#fff}
  .pq-doc{font-size:15px;color:#202124}
  .pq-tools{display:flex;gap:14px;padding:7px 16px;border-bottom:1px solid #e8eaed;background:#f8f9fa;
    font-size:12.5px;color:#5f6368}
  .pq-page{flex:1;overflow:auto;background:#f1f3f4;padding:26px 16px}
  .pq-sheet{max-width:760px;margin:0 auto;background:#fff;border:1px solid #e0e0e0;border-radius:2px;
    min-height:70vh;padding:64px 72px;box-shadow:0 1px 3px rgba(60,64,67,.16)}
  .pq-sheet h1{font-size:21px;font-weight:600;margin:0 0 18px;color:#202124}
  .pq-sheet p{font-size:14.5px;line-height:1.9;color:#3c4043;margin:0 0 14px}
  .pq-line{height:12px;border-radius:3px;background:#eceff1;margin:0 0 14px}
  /* The way back. Small and quiet, but always visible, always focusable, and
     never underneath anything — an emergency screen that traps the user is a
     bug, not a safety feature. */
  .pq-back{margin-left:auto;display:inline-flex;align-items:center;gap:6px;
    padding:6px 12px;border-radius:999px;border:1px solid #dadce0;background:#fff;color:#5f6368;
    font:600 12px inherit;cursor:pointer}
  .pq-back:hover{background:#f1f3f4;color:#202124}
  .pq-back:focus-visible{outline:2px solid #1a73e8;outline-offset:2px}
  @media (max-width:560px){.pq-sheet{padding:32px 24px}.pq-page{padding:14px 10px}}
  /* Everything the cover is hiding. Raising the overlay's z-index instead would
     be a race against every future banner, toast and dialog on the site — the
     cookie-consent bar already won that race and stayed on screen through a
     panic. visibility:hidden keeps the layout intact so nothing jumps on the way
     back, and removes the element from hit-testing as well as from view. */
  .pq-concealed{visibility:hidden!important}
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
      <option value="screen">Cover screen — hide ZoFHub behind a blank document</option>
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
  // 'overlay' is the retired name for 'screen'; a saved setting must not read
  // back as an empty select.
  mode.value = cfg.mode === 'overlay' ? 'screen' : (cfg.mode || 'cloak');
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
      : m === 'screen' ? 'Instantly covers ZoFHub with a blank document and mutes any game. Your URL stays the same; press Esc or Return to come back.'
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

let releasePanelFocus = null;
function showPanel() {
  buildPanel();
  panelEl.hidden = false;
  // This panel captures keystrokes to record a custom hotkey, so it matters
  // more than most that Tab can't walk out of it mid-recording.
  releasePanelFocus = trapFocus(panelEl);
}
function hidePanel() {
  if (panelEl) panelEl.hidden = true;
  if (recording) stopRecording($('#panicKey', panelEl));
  releasePanelFocus?.(); releasePanelFocus = null;
}
export function showSettings() { showPanel(); }

// ── Actions ─────────────────────────────────────────────────────────────────
function ensureOverlay() {
  // injectStyles() used to run only from buildPanel(), so a user who clicked
  // Panic without ever opening settings got an overlay with no stylesheet.
  injectStyles();
  if (overlayEl) return overlayEl;
  overlayEl = el('div', {
    class: 'panic-overlay', id: 'panicOverlay', hidden: true,
    role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Private mode',
  });
  overlayEl.innerHTML =
    '<div class="pq-bar">' +
      '<span class="pq-doc" id="pqDocName">Untitled document</span>' +
      '<button type="button" class="pq-back" id="pqBack">' +
        '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" ' +
        'stroke-width="2.4" aria-hidden="true"><path d="M9 14 4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-1"/></svg>' +
        'Return to ZoFHub</button>' +
    '</div>' +
    '<div class="pq-tools"><span>File</span><span>Edit</span><span>View</span><span>Insert</span><span>Format</span></div>' +
    '<div class="pq-page"><div class="pq-sheet">' +
      '<h1>Notes</h1>' +
      '<p>Reading response — draft.</p>' +
      '<div class="pq-line" style="width:96%"></div><div class="pq-line" style="width:88%"></div>' +
      '<div class="pq-line" style="width:92%"></div><div class="pq-line" style="width:64%"></div>' +
      '<p>&nbsp;</p>' +
      '<div class="pq-line" style="width:90%"></div><div class="pq-line" style="width:85%"></div>' +
      '<div class="pq-line" style="width:47%"></div>' +
    '</div></div>';
  document.body.appendChild(overlayEl);
  overlayEl.querySelector('#pqBack').addEventListener('click', unpanic);
  return overlayEl;
}

// ── Silencing ───────────────────────────────────────────────────────────────
// A cover screen that leaves a game's audio playing is not concealment. Page
// media is paused; a cross-origin game iframe cannot be controlled from here, so
// its src is parked and restored on the way back. That does restart the game —
// worth saying plainly in the UI, and still the right trade when the point of
// the button is that the room has gone quiet.
const parked = [];
function silenceMedia() {
  for (const m of document.querySelectorAll('audio, video')) {
    try { if (!m.paused) { m.pause(); parked.push({ media: m }); } } catch { /* ignore */ }
  }
  for (const f of document.querySelectorAll('iframe')) {
    if (f.closest('.panic-overlay')) continue;
    const src = f.getAttribute('src');
    if (!src || src === 'about:blank') continue;
    parked.push({ frame: f, src });
    try { f.setAttribute('src', 'about:blank'); } catch { /* ignore */ }
  }
}
function restoreMedia() {
  for (const p of parked.splice(0)) {
    try {
      if (p.frame) p.frame.setAttribute('src', p.src);
      else if (p.media) p.media.play?.().catch(() => {});
    } catch { /* ignore */ }
  }
}

function disguise() {
  const cfg = store.panic.get();
  if (!cfg.disguise) return;
  const matched = PRESETS.find(p => p.value === cfg.url);
  document.title = matched ? matched.title : 'Untitled';
  const fav = document.querySelector('link[rel*="icon"]') || el('link', { rel: 'icon' });
  if (realIcon === null) realIcon = fav.getAttribute('href') || '';
  if (matched) { fav.href = matched.icon; fav.type = 'image/x-icon'; }
  else { fav.href = ''; }
  if (!fav.parentNode) document.head.appendChild(fav);
}

/** Is the cover screen currently up? */
export const isPanicked = () => !!overlayEl && !overlayEl.hidden;

// Remembered so the way back restores the real tab identity, not a guess.
let realTitle = null, realIcon = null;
// Siblings hidden while the cover is up, with the inline value they had before,
// so restoring puts each one back exactly as it was rather than blanking it.
const concealed = [];

export function panic() {
  const cfg = store.panic.get();
  // No configured destination is not a reason to do NOTHING and pop settings in
  // front of someone who just hit the panic button. Cover the screen first;
  // settings can be adjusted later, in their own time.
  const mode = cfg.mode === 'overlay' ? 'screen' : (cfg.mode || 'cloak');

  if (mode === 'cloak' && cfg.url) { openAboutBlank(); return; }
  if (mode === 'redirect' && cfg.url) {
    try { location.replace(cfg.url); } catch { location.href = cfg.url; }
    return;
  }

  // 'screen' — and the fallback whenever no destination is configured.
  if (isPanicked()) return;
  hidePanel();
  if (realTitle === null) realTitle = document.title;
  disguise();

  const ov = ensureOverlay();
  const matched = PRESETS.find(p => p.value === cfg.url);
  const name = ov.querySelector('#pqDocName');
  if (name) name.textContent = (cfg.disguise !== false && matched) ? matched.title : 'Untitled document';

  silenceMedia();
  // Flag on <html> so any page's own CSS can react, and so tests have one
  // authoritative thing to assert on instead of poking at an element.
  document.documentElement.dataset.privacy = 'on';
  // The real app is hidden from assistive tech too — a screen reader reading out
  // the page behind an opaque cover would defeat the entire point.
  // Inline, not a class. A class depends on this stylesheet outranking whatever
  // the hidden element brought with it, and the cookie-consent bar won that
  // fight and stayed on screen through a panic. An inline declaration has no
  // such argument to lose. visibility (not display) keeps the layout intact so
  // nothing jumps on the way back, and it removes the node from hit-testing too.
  concealed.length = 0;
  for (const n of document.body.children) {
    if (n === ov) continue;
    concealed.push({ el: n, prev: n.style.visibility });
    n.style.visibility = 'hidden';
    n.setAttribute('aria-hidden', 'true');
  }
  ov.hidden = false;
  ov.querySelector('#pqBack')?.focus();
}

export function unpanic() {
  if (!overlayEl || overlayEl.hidden) return;
  overlayEl.hidden = true;
  delete document.documentElement.dataset.privacy;
  for (const { el: n, prev } of concealed.splice(0)) {
    n.style.visibility = prev || '';
    n.removeAttribute('aria-hidden');
  }
  for (const n of document.body.children) n.removeAttribute('aria-hidden');
  restoreMedia();
  if (realTitle !== null) { document.title = realTitle; realTitle = null; }
  if (realIcon !== null) {
    const fav = document.querySelector('link[rel*="icon"]');
    if (fav) fav.href = realIcon;
    realIcon = null;
  }
  document.getElementById('panicBtn')?.focus();
}

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
  // Escape leaves the cover screen. Checked before the hotkey so the way out
  // works even if someone has bound their hotkey to something unreachable.
  if (e.key === 'Escape' && isPanicked()) { e.preventDefault(); unpanic(); return; }

  // Trigger the configured action on the user's hotkey.
  if (eventMatchesCombo(e, store.panic.get().key)) {
    e.preventDefault();
    if (isPanicked()) { unpanic(); return; }   // same key toggles back
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
  // THE FIX. This button used to open a settings dropdown. A control labelled
  // "Panic" that responds to a click by presenting a form is the one behaviour
  // it must never have — in the moment it exists for, the user has no time to
  // read a panel. Clicking it now panics, immediately. Settings moved to their
  // own adjacent control.
  btn.setAttribute('title', 'Hide this site now');
  btn.setAttribute('aria-label', 'Panic — hide this site now');
  btn.addEventListener('click', (e) => { e.preventDefault(); hidePanel(); panic(); });

  if (!$('#panicGear')) {
    const gear = el('button', {
      class: 'panic-gear', id: 'panicGear', type: 'button',
      title: 'Panic settings', 'aria-label': 'Panic settings',
      'aria-expanded': 'false', 'aria-haspopup': 'dialog',
    });
    gear.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" ' +
      'stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="3"/>' +
      '<path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1A1.6 1.6 0 0 0 9 19.4a1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1A1.6 1.6 0 0 0 4.6 9a1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z"/></svg>';
    gear.addEventListener('click', (e) => {
      e.preventDefault();
      buildPanel();
      if (panelEl.hidden) showPanel(); else hidePanel();
      gear.setAttribute('aria-expanded', String(!panelEl.hidden));
    });
    btn.insertAdjacentElement('afterend', gear);
  }
}

// Close the panel on outside-click.
document.addEventListener('click', (e) => {
  if (!panelEl || panelEl.hidden) return;
  if (panelEl.contains(e.target)) return;
  if (e.target.closest('#panicBtn, .panic-btn, #panicGear, .panic-gear')) return;
  hidePanel();
});

if (document.readyState !== 'loading') wireHeaderButton();
else document.addEventListener('DOMContentLoaded', wireHeaderButton);
