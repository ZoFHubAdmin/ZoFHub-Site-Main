// ZoFHub · browser.js — multi-engine proxy browser (dropdown-driven).
// -----------------------------------------------------------------------------
// Pick an engine from the dropdown and it LAUNCHES immediately:
//   • Scramjet / Ultraviolet — IN-APP service-worker proxies (same origin). On
//     select we wait for the SW to actually be ACTIVE + the tunnel warm, then
//     auto-open a homepage so a real page renders ("the browser pops up"). Type
//     any URL in the address bar to browse; it's encoded and loaded in-frame.
//   • GUST — self-contained proxy app at /gust/ (its own address bar).
//   • Interstellar / Nebula — standalone companion apps on their own port. Shown
//     only when reachable (probed via /api/proxies); offline ones are DISABLED so
//     you can never pick a dead engine. They load cross-origin, so if one refuses
//     to be embedded you get an "Open in new tab" fallback.
// Everything is BOUNDED + surfaces a clear error with Reload — it can never just
// spin or silently blank out.
// -----------------------------------------------------------------------------
import { $, $$, el, isLikelyUrl, normalizeUrl, fetchJson, toast } from './utils.js';

const frame   = $('#gustFrame');
const wrap    = $('#gustWrap');
const loader  = $('#gustLoader');
const caption = $('#loaderCaption');
const fsBtn   = $('#gustFs');
const select  = $('#engineSelect');
const urlForm = $('#urlForm');
const urlInput= $('#urlInput');
const startPage = $('#startPage');
const startTitle= $('#startTitle');
const startSub  = $('#startSub');
const offlineBox= $('#brOffline');
const note    = $('#engineNote');
const dot     = $('#engineDot');
const shell   = document.querySelector('.gust-shell');
// Error overlay (shown when a page can't load).
const errBox   = $('#brError');
const errTitle = $('#brErrTitle');
const errSub   = $('#brErrSub');
const errReload= $('#brErrReload');
const errOpen  = $('#brErrOpen');

// The always-available in-app engines + the two standalone companions.
// Order matters: the first entry shows on top. Scramjet is the default.
const IN_APP = [
  { id: 'scramjet', label: 'Scramjet',    kind: 'sw' },
  { id: 'uv',       label: 'Ultraviolet', kind: 'sw' },
  { id: 'gust',     label: 'GUST',        kind: 'app', url: '/gust/' },
];
const DEFAULT_ENGINE = 'scramjet';
const HOME = 'https://www.google.com/';            // homepage auto-loaded on SW select
const COMPANION_IDS = ['interstellar', 'nebula'];
let companions = [];   // [{ id, label, url, up }] from /api/proxies (filtered to COMPANION_IDS)

const LAST_KEY = 'zofhub:browser:engine:v2';
const engineById = (id) => IN_APP.find(e => e.id === id) || companions.find(c => c.id === id);

// ── Shared transport + service workers (Ultraviolet + Scramjet) ──────────────
// Warmed in the background at load; NEVER awaited unbounded. A navigation waits
// a BOUNDED time for BOTH the tunnel and the engine's SW to be active.
let bareConn = null, transportReady = null, sjController = null;
let uvReady = Promise.resolve(false), scramReady = Promise.resolve(false);
const TRANSPORT_SETUP_MS = 20000, READY_WAIT_MS = 15000;

function initBareMux() {
  if (!window.BareMux || !window.BareMux.BareMuxConnection) {
    console.warn('[browser] BareMux global missing — UV/Scramjet unavailable.');
    return;
  }
  try { bareConn = new window.BareMux.BareMuxConnection('/baremux/worker.js'); }
  catch (e) { console.warn('[browser] BareMux init failed:', e); }
}
async function ensureTransport() {
  if (!bareConn) return false;
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  const wispUrl = `${scheme}://${location.host}/wisp/`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await Promise.race([
        bareConn.setTransport('/epoxy/index.mjs', [{ wisp: wispUrl }]),
        new Promise((_, rej) => setTimeout(() => rej(new Error('transport setup timed out')), TRANSPORT_SETUP_MS)),
      ]);
      return true;
    } catch (e) { console.warn(`[browser] transport attempt ${attempt + 1} failed:`, e?.message || e); }
  }
  return false;
}
// Resolve only once the service worker is genuinely ACTIVATED — registering is
// not enough; requests aren't intercepted until it's active (this was the
// "select an engine, type a URL, nothing loads" bug).
async function awaitActive(reg) {
  const sw = reg.installing || reg.waiting || reg.active;
  if (!sw) return false;
  if (sw.state === 'activated') return true;
  await new Promise((res) => {
    const onState = () => { if (sw.state === 'activated') { sw.removeEventListener('statechange', onState); res(); } };
    sw.addEventListener('statechange', onState);
  });
  return true;
}
async function registerUVServiceWorker() {
  if (!('serviceWorker' in navigator) || !self.__uv$config) return false;
  try {
    const reg = await navigator.serviceWorker.register('/uv/uv.sw.js', { scope: self.__uv$config.prefix });
    return await awaitActive(reg);
  } catch (e) { console.warn('[browser] UV sw registration failed:', e); return false; }
}
async function initScramjet() {
  if (!('serviceWorker' in navigator) || typeof self.$scramjetLoadController !== 'function') {
    console.info('[browser] Scramjet bundle not present.');
    return false;
  }
  try {
    const { ScramjetController } = self.$scramjetLoadController();
    sjController = new ScramjetController({
      prefix: '/scram/service/',
      files: { wasm: '/scram/scramjet.wasm.wasm', all: '/scram/scramjet.all.js', sync: '/scram/scramjet.sync.js' },
    });
    await sjController.init();
    const reg = await navigator.serviceWorker.register('/scram/scramjet.sw.js', { scope: '/scram/service/' });
    return await awaitActive(reg);
  } catch (e) { console.warn('[browser] Scramjet init failed:', e); sjController = null; return false; }
}
const swReadyFor = (id) => (id === 'scramjet' ? scramReady : id === 'uv' ? uvReady : Promise.resolve(true));

// Encode a target URL for the chosen SW engine. null → engine not ready.
function buildProxyUrl(url, engine) {
  if (engine === 'scramjet') {
    if (!sjController) return null;
    try { return sjController.encodeUrl(url); } catch (e) { console.warn('[browser] Scramjet encode failed:', e); return null; }
  }
  if (engine === 'uv') {
    if (!self.__uv$config) return null;
    try { return self.__uv$config.prefix + self.__uv$config.encodeUrl(url); } catch (e) { console.warn('[browser] UV encode failed:', e); return null; }
  }
  return url;
}

// ── Dropdown ─────────────────────────────────────────────────────────────────
function buildDropdown() {
  const cur = select.value;
  select.innerHTML = '';
  const optgIn = el('optgroup', { label: 'Built-in (always available)' });
  for (const e of IN_APP) optgIn.appendChild(el('option', { value: e.id }, e.label));
  select.appendChild(optgIn);
  const optgCo = el('optgroup', { label: 'Standalone browsers' });
  for (const id of COMPANION_IDS) {
    const c = companions.find(x => x.id === id);
    const label = c ? c.label : (id.charAt(0).toUpperCase() + id.slice(1));
    const up = !!(c && c.up);
    const opt = el('option', { value: id }, `${label}${up ? '' : ' — offline'}`);
    if (!up) opt.disabled = true;   // can't pick a dead engine
    optgCo.appendChild(opt);
  }
  select.appendChild(optgCo);
  if (cur) select.value = cur;
}

async function loadCompanions() {
  try {
    const data = await fetchJson('/api/proxies');
    companions = (data.engines || []).filter(e => COMPANION_IDS.includes(e.id));
  } catch { companions = []; }
  buildDropdown();
  // If the currently-selected companion just came online, launch it now.
  const sel = engineById(select.value);
  if (sel && sel.kind !== 'sw' && sel.kind !== 'app' && sel.up) selectEngine(select.value);
}

// ── Loader + error overlays ──────────────────────────────────────────────────
let poll, cap, errTimer;
function showLoader(msg) { if (caption && msg) caption.textContent = msg; if (loader) loader.hidden = false; }
function hideLoader() { clearInterval(poll); clearTimeout(cap); if (loader) loader.hidden = true; }
function hideError() { if (errBox) errBox.hidden = true; }
function showError(title, sub, openUrl) {
  clearTimeout(errTimer); hideLoader();
  frame.hidden = true; startPage.hidden = true;
  if (errTitle) errTitle.textContent = title;
  if (errSub) errSub.textContent = sub;
  if (errOpen) { if (openUrl) { errOpen.hidden = false; errOpen.onclick = () => window.open(openUrl, '_blank', 'noopener'); } else errOpen.hidden = true; }
  if (errBox) errBox.hidden = false;
}
// Watch the frame: hide the loader as soon as it paints; if NOTHING loads within
// a long window, surface a real error (instead of a silent blank frame).
function armFrameWatch(openUrl) {
  clearInterval(poll); clearTimeout(cap); clearTimeout(errTimer);
  let loaded = false;
  const done = () => { loaded = true; hideLoader(); };
  frame.onload = done;
  poll = setInterval(() => {
    let ready = false;
    try { ready = frame.contentDocument && frame.contentDocument.readyState !== 'loading'; }
    catch { ready = true; }   // cross-origin (companion) → it responded
    if (ready) done();
  }, 200);
  cap = setTimeout(hideLoader, 12000);         // stop the spinner even if onload is late
  errTimer = setTimeout(() => {
    if (!loaded) showError('This page didn’t load',
      'It may block embedding, need a sign-in, or the proxy hit a snag. Try Reload, a different site' + (openUrl ? ', or open it in a new tab.' : '.'),
      openUrl);
  }, 25000);
}

// ── Views ────────────────────────────────────────────────────────────────────
function showStart(title, sub) {
  if (title) startTitle.textContent = title;
  if (sub) startSub.textContent = sub;
  offlineBox.hidden = true; hideError();
  startPage.hidden = false;
  frame.hidden = true;
  hideLoader();
}
function showOffline(label, id) {
  hideError();
  startTitle.textContent = `${label} isn't running`;
  startSub.textContent = 'This browser runs as its own service. Start it, then reopen this page.';
  offlineBox.hidden = false;
  offlineBox.innerHTML =
    `<code>npm run proxies</code> in the ZoFHub folder starts <b>${label}</b>` +
    (id === 'nebula' || id === 'interstellar'
      ? ` (first time: <code>cd ${label} &amp;&amp; npm install${id === 'nebula' ? ' &amp;&amp; npm run build' : ''}</code>).`
      : '.') +
    ` Or set <code>PROXY_${id.toUpperCase()}_URL</code> to a deployed instance.`;
  startPage.hidden = false;
  frame.hidden = true;
  hideLoader();
}
function loadApp(url, label, openUrl) {
  startPage.hidden = true; hideError();
  frame.hidden = false;
  showLoader(`Starting ${label}…`);
  frame.src = url;
  armFrameWatch(openUrl);
}

// ── Engine selection ─────────────────────────────────────────────────────────
function selectEngine(id) {
  const e = engineById(id);
  if (!e) return;
  select.value = id;
  try { localStorage.setItem(LAST_KEY, id); } catch {}

  const driving = e.kind !== 'sw';          // apps/companions have their OWN address bar
  shell.classList.toggle('is-driving', driving);
  const online = e.kind === 'sw' || e.kind === 'app' || !!e.up;
  dot.classList.toggle('off', !online);
  hideError();

  if (e.kind === 'sw') {
    note.textContent = `${e.label} — type a site above, or use a shortcut.`;
    resetHistory();
    navigate(HOME);                          // pop the browser up on a real homepage
  } else if (e.kind === 'app') {
    note.textContent = `${e.label} — use its own address bar inside the page.`;
    loadApp(e.url, e.label);                 // same-origin (/gust/), no new-tab fallback needed
  } else {
    // companion (separate server, cross-origin). Embedding can be silently
    // refused (X-Frame-Options), so ALWAYS offer a new-tab escape hatch.
    if (e.up) {
      note.innerHTML = `${e.label} runs in its own window — <a href="${e.url}" target="_blank" rel="noopener" class="br-note-link">open in a new tab ↗</a> if it doesn't appear below.`;
      loadApp(e.url, e.label, e.url);        // pass its URL as the new-tab fallback too
    } else {
      note.textContent = `${e.label} is offline.`;
      showOffline(e.label, e.id);
    }
  }
}

// ── Address-bar navigation (Scramjet / Ultraviolet) ──────────────────────────
let history = [], pos = -1;
function resetHistory() { history = []; pos = -1; updateNav(); }
function updateNav() {
  $('#bBack').disabled = pos <= 0;
  $('#bFwd').disabled = pos >= history.length - 1;
}
function navigate(input) {
  const url = isLikelyUrl(input) ? normalizeUrl(input) : `https://duckduckgo.com/?q=${encodeURIComponent(input)}`;
  history = history.slice(0, pos + 1);
  history.push(url); pos = history.length - 1;
  updateNav();
  loadUrl(url);
}
async function loadUrl(url) {
  const engine = select.value;
  urlInput.value = url;
  startPage.hidden = true; hideError();
  frame.hidden = false;
  showLoader('Connecting secure tunnel…');
  // Wait (bounded) for BOTH the tunnel AND the engine's SW to be ACTIVE.
  let ready = false;
  try {
    ready = await Promise.race([
      Promise.all([transportReady, swReadyFor(engine)]).then(([t, s]) => t !== false && s !== false),
      new Promise(r => setTimeout(() => r(false), READY_WAIT_MS)),
    ]);
  } catch {}
  const target = buildProxyUrl(url, engine);
  if (target == null) {
    return showError(`${engineById(engine)?.label || engine} is still starting`,
      'The proxy engine hasn’t finished loading. Give it a few seconds, then hit Reload.');
  }
  if (!ready) toast('Tunnel still warming up — if the page fails, hit Reload.', 'warn');
  showLoader(`Loading via ${engineById(engine)?.label || engine}…`);
  frame.src = target;
  armFrameWatch();
}

// ── Reload / Home ────────────────────────────────────────────────────────────
function reloadCurrent() {
  const e = engineById(select.value);
  hideError();
  if (e?.kind === 'sw') {
    if (pos >= 0) loadUrl(history[pos]); else navigate(HOME);
  } else if (frame.src && frame.src !== 'about:blank') {
    showLoader('Reloading…');
    const s = frame.src; frame.src = 'about:blank';
    requestAnimationFrame(() => { frame.src = s; armFrameWatch(e?.kind === 'companion' ? e.url : undefined); });
  } else {
    selectEngine(select.value);
  }
}
function goHome() {
  const e = engineById(select.value);
  if (e?.kind === 'sw') { hideError(); resetHistory(); showStart('New tab', `Type a site above, or jump to one below. Powered by ${e.label}.`); }
  else selectEngine(select.value);
}

// ── UI wiring ────────────────────────────────────────────────────────────────
function bindUI() {
  select.addEventListener('change', () => selectEngine(select.value));
  urlForm.addEventListener('submit', (e) => { e.preventDefault(); const v = urlInput.value.trim(); if (v) navigate(v); });
  $$('#quickLinks button').forEach(b => b.addEventListener('click', () => { urlInput.value = b.dataset.url; navigate(b.dataset.url); }));
  $('#bBack').addEventListener('click', () => { if (pos > 0) { pos--; updateNav(); loadUrl(history[pos]); } });
  $('#bFwd').addEventListener('click', () => { if (pos < history.length - 1) { pos++; updateNav(); loadUrl(history[pos]); } });
  $('#bReload').addEventListener('click', reloadCurrent);
  $('#bHome').addEventListener('click', goHome);
  if (errReload) errReload.addEventListener('click', reloadCurrent);
  const disX = $('#brDisclaimerX'), dis = $('#brDisclaimer');
  if (disX && dis) disX.addEventListener('click', () => { dis.hidden = true; });   // session-only; reappears next load
  fsBtn.addEventListener('click', toggleFullscreen);
  document.addEventListener('fullscreenchange', () => wrap.classList.toggle('is-fullscreen', document.fullscreenElement === wrap));
}
function toggleFullscreen() {
  const elx = wrap || frame;
  if (!document.fullscreenElement) (elx.requestFullscreen || elx.webkitRequestFullscreen || elx.msRequestFullscreen)?.call(elx);
  else (document.exitFullscreen || document.webkitExitFullscreen)?.call(document);
}

// ── Init ─────────────────────────────────────────────────────────────────────
(function init() {
  initBareMux();
  transportReady = ensureTransport();          // background, bounded, not awaited
  uvReady = registerUVServiceWorker().catch(() => false);
  scramReady = initScramjet().catch(() => false);

  buildDropdown();
  bindUI();

  let saved = DEFAULT_ENGINE;
  try { saved = localStorage.getItem(LAST_KEY) || DEFAULT_ENGINE; } catch {}
  if (!IN_APP.some(e => e.id === saved) && !COMPANION_IDS.includes(saved)) saved = DEFAULT_ENGINE;
  // Never boot straight into a companion (may be offline) — start on the default.
  if (COMPANION_IDS.includes(saved)) saved = DEFAULT_ENGINE;
  select.value = saved;
  selectEngine(saved);

  loadCompanions();   // fill in Interstellar/Nebula online-state (background)
})();
