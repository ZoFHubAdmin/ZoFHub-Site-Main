// ZoFHub · browser.js — multi-tab proxy browser
import { $, $$, el, isLikelyUrl, normalizeUrl, fetchJson, toast } from './utils.js';
import { store } from './storage.js';

const tabs = [];
let active = -1;
let proxy = null;
let bareConn = null;        // bare-mux connection (singleton)
let transportReady = null;  // Promise<boolean> — resolves once a transport is live
let sjController = null;     // Scramjet controller instance (null if unavailable)
let companions = [];         // [{ id, label, url }] standalone browsers that are reachable

// The order Auto-failover walks through.  GUST is a full-page hand-off (it owns
// its own chrome) so it is NOT part of the in-iframe chain; it stays an explicit
// pick.  Companions (cross-origin standalone browsers) are spliced in by
// buildAutoChain() once /api/proxies tells us which are online.  `direct` is the
// last resort — it shows the raw site, which works for anything that allows
// framing even when every proxy engine is blocked.
const BASE_CHAIN = ['scramjet', 'uv', 'direct'];

(async function init() {
  // Paint an interactive UI IMMEDIATELY. Engine bring-up (service workers,
  // Scramjet wasm, the Wisp transport) used to be awaited here, which made the
  // whole page sit on a blank "loading forever" state if any of them was slow
  // or blocked. None of that is needed before first paint — the default engine
  // (GUST) is a self-contained app — so we kick it all off in the background.
  bindUI();
  newTab();
  initBareMux();
  transportReady = ensureTransport();           // not awaited — UV/Scramjet await it lazily
  loadStatus().catch(() => {});                 // background: fills the status line + card badges
  loadCompanions().catch(() => {});             // background: adds standalone-browser cards
  registerUVServiceWorker().catch(() => {});    // background: only needed if UV is picked
  initScramjet().catch(() => {});               // background: only needed if Scramjet is picked
  // NOTHING auto-loads. We show the engine CHOOSER first and only load a proxy
  // when the user picks one — so arriving at /browser is instant instead of
  // hanging on a spinner while a slow engine boots. (That auto-load was the
  // "takes forever to load" problem.)
  showChooser();
})();

function engineValue() { return $('#engineSelect')?.value || 'gust'; }
function isGustMode() { return engineValue() === 'gust'; }

// ── Engine chooser ─────────────────────────────────────────────────────────
// Screen 1: the cards (pick an engine). Screen 2 (#engineGo): enter a URL with
// the chosen engine. GUST + companions skip screen 2 (they drive themselves).
const browserBar = () => document.querySelector('.browser-bar');

function showChooser() {
  $('#startPage') && ($('#startPage').hidden = false);
  $('#engineChooser') && ($('#engineChooser').hidden = false);
  $('#engineGo') && ($('#engineGo').hidden = true);
  $('#browserFrame') && ($('#browserFrame').hidden = true);
  browserBar()?.classList.add('bar-hidden');     // no toolbar until an engine is chosen
  setActiveEngine(null);
}

// User picked an engine. GUST/companion load right away; the in-iframe engines
// (uv/scramjet/auto/direct) reveal the toolbar and the "enter a URL" screen.
function chooseEngine(engine) {
  const sel = $('#engineSelect'); if (sel) sel.value = engine;
  if (engine === 'gust') { loadGust(); return; }
  if (engine.startsWith('companion:')) {
    const c = companionById(engine.slice(10));
    if (c) loadCompanion(c); else toast('That browser is offline', 'err');
    return;
  }
  browserBar()?.classList.remove('bar-hidden');
  setEngineChrome('other');
  setActiveEngine(engine);
  const t = current();
  if (t && t.url) { load(t.url); return; }        // already browsing → just switch engine
  $('#engineChooser') && ($('#engineChooser').hidden = true);
  $('#engineGo') && ($('#engineGo').hidden = false);
  const name = $('#goEngineName'); if (name) name.textContent = engineLabel(engine);
  $('#startPage') && ($('#startPage').hidden = false);
  $('#browserFrame') && ($('#browserFrame').hidden = true);
  setTimeout(() => $('#urlInput')?.focus(), 40);
}

// Paint each card's live online/offline badge from /api/health.
function updateCardStatuses() {
  const map = { gust: proxy?.gust, ultraviolet: proxy?.ultraviolet, scramjet: proxy?.scramjet };
  for (const [key, up] of Object.entries(map)) {
    const node = document.querySelector(`[data-engine-status="${key}"]`);
    if (!node) continue;
    node.textContent = up ? 'Online' : 'Offline';
    node.className = 'ec-status ' + (up ? 'ok' : 'warn');
  }
}

// Show/hide ZoFHub's own omnibox + nav. In GUST mode they're useless (GUST has
// its OWN address bar inside the page), so we hide them to stop the confusion of
// a URL bar that does nothing. For the other engines we show them.
function setEngineChrome(mode) {
  const bar = document.querySelector('.browser-bar');
  if (bar) bar.classList.toggle('gust-mode', mode === 'gust');
}

// Pull the list of standalone-browser companion services that are currently
// reachable (NautilusOS, Interstellar, …) and add each as a dropdown option.
// Companions live on their own origin, so selecting one just points the iframe
// at its URL — no service worker or transport of ours is involved.
async function loadCompanions() {
  try {
    const data = await fetchJson('/api/proxies');
    companions = (data.engines || []).filter(e => e.up && e.url);
  } catch { companions = []; }
  const group = document.getElementById('engCompanions');
  if (!group) return;
  if (!companions.length) { group.hidden = true; return; }
  group.hidden = false;
  group.innerHTML = '';
  const cards = $('#engineCards');
  for (const c of companions) {
    const opt = document.createElement('option');
    opt.value = `companion:${c.id}`;
    opt.textContent = c.label;
    group.appendChild(opt);
    // Also add a chooser CARD so it's pickable from the start screen.
    if (cards && !cards.querySelector(`[data-engine="companion:${c.id}"]`)) {
      const card = el('button', { class: 'engine-card', type: 'button' });
      card.dataset.engine = `companion:${c.id}`;
      const name = el('span', { class: 'ec-name' }); name.textContent = c.label;
      card.append(
        name,
        el('span', { class: 'ec-desc' }, 'Standalone browser app — opens in its own window right here.'),
        el('span', { class: 'ec-status ok' }, 'Online'),
      );
      card.addEventListener('click', () => chooseEngine(card.dataset.engine));
      cards.appendChild(card);
    }
  }
}

function companionById(id) { return companions.find(c => c.id === id) || null; }

// The in-iframe Auto chain: the built-in engines that are actually online,
// ending in `direct`.  These all proxy the SAME target URL, so failing over
// between them is seamless — the user keeps the page they asked for.
// Companions are NOT in this chain: they are whole separate browser apps with
// their own address bars, so picking one is a deliberate "open that browser"
// action rather than a transparent retry of the current site.
function buildAutoChain() {
  const chain = [];
  if (proxy?.scramjet && sjController) chain.push('scramjet');
  if (proxy?.ultraviolet && self.__uv$config) chain.push('uv');
  chain.push('direct');
  return [...new Set(chain.length ? chain : BASE_CHAIN)];
}

const ENGINE_LABELS = {
  auto: 'Auto', gust: 'GUST', uv: 'Ultraviolet', scramjet: 'Scramjet', direct: 'Direct',
};
function engineLabel(engine) {
  if (engine?.startsWith('companion:')) return companionById(engine.slice(10))?.label || 'Browser';
  return ENGINE_LABELS[engine] || engine;
}
function setActiveEngine(engine) {
  const pill = document.getElementById('activeEngine');
  if (!pill) return;
  if (!engine) { pill.hidden = true; return; }
  pill.hidden = false;
  pill.textContent = engineLabel(engine);
}

async function loadStatus() {
  try {
    const h = await fetchJson('/api/health');
    proxy = h.proxy || {};
    updateCardStatuses();                 // paint the per-engine Online/Offline badges
    const status = $('#proxyStatus');
    if (!status) return;
    const enabled = Object.entries(proxy).filter(([, v]) => v).map(([k]) => k);
    if (enabled.length) {
      status.className = 'start-status ok';
      status.textContent = `Active engines: ${enabled.join(', ')}. URLs are rewritten and re-served from this domain.`;
    } else {
      status.className = 'start-status warn';
      status.textContent = `No proxy engines online. The iframe will load sites directly — many public sites block this.`;
    }
  } catch {}
}

// Register the UV service worker once (only if the UV bundle + config loaded).
async function registerUVServiceWorker() {
  if (!('serviceWorker' in navigator) || !self.__uv$config) return;
  try {
    await navigator.serviceWorker.register('/uv/uv.sw.js', { scope: self.__uv$config.prefix });
  } catch (e) { console.warn('[browser] UV sw registration failed:', e); }
}

// Bring up Scramjet: configure the controller (prefix lives UNDER /scram/ so
// its service worker is allowed to claim that scope without a special header)
// and register the SW.  Scramjet uses the same bare-mux transport as UV.
async function initScramjet() {
  if (!('serviceWorker' in navigator) || typeof self.$scramjetLoadController !== 'function') {
    console.info('[browser] Scramjet bundle not present — engine unavailable.');
    return;
  }
  try {
    const { ScramjetController } = self.$scramjetLoadController();
    sjController = new ScramjetController({
      prefix: '/scram/service/',
      files: {
        wasm: '/scram/scramjet.wasm.wasm',
        all:  '/scram/scramjet.all.js',
        sync: '/scram/scramjet.sync.js',
      },
    });
    await sjController.init();
    await navigator.serviceWorker.register('/scram/scramjet.sw.js', { scope: '/scram/service/' });
  } catch (e) {
    console.warn('[browser] Scramjet init failed:', e);
    sjController = null;
  }
}

// ---------------------------------------------------------------------
// bare-mux: the transport multiplexer the proxy service workers use to
// actually reach upstream sites.  Both Ultraviolet and Scramjet talk to
// the same connection, so we configure exactly one transport — Epoxy over
// our local Wisp endpoint at wss(s)://host/wisp/ — and every engine rides it.
// ---------------------------------------------------------------------
function initBareMux() {
  if (!window.BareMux || !window.BareMux.BareMuxConnection) {
    console.warn('[browser] BareMux global missing — engines will fall back to direct iframe.');
    return;
  }
  try {
    bareConn = new window.BareMux.BareMuxConnection('/baremux/worker.js');
  } catch (e) {
    console.warn('[browser] BareMuxConnection init failed:', e);
  }
}

// Configure the shared transport once.  Resolves true when traffic can flow.
async function ensureTransport() {
  if (!bareConn) return false;
  try {
    const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
    const wispUrl = `${scheme}://${location.host}/wisp/`;
    await bareConn.setTransport('/epoxy/index.mjs', [{ wisp: wispUrl }]);
    return true;
  } catch (e) {
    console.warn('[browser] transport setup failed:', e);
    return false;
  }
}

function bindUI() {
  $('#tabAdd')?.addEventListener('click', () => newTab());
  $('#urlForm')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const v = $('#urlInput').value.trim();
    if (v) navigate(v);
  });
  $('#bBack')?.addEventListener('click', () => { if (isGustMode()) return; const t = current(); if (!t || t.pos <= 0) return; t.pos--; t.url = t.history[t.pos]; load(t.url); });
  $('#bFwd')?.addEventListener('click',  () => { if (isGustMode()) return; const t = current(); if (!t || t.pos >= t.history.length - 1) return; t.pos++; t.url = t.history[t.pos]; load(t.url); });
  $('#bReload')?.addEventListener('click', () => { if (isGustMode()) { loadGust(); return; } const t = current(); if (t?.url) load(t.url); });
  $('#bHome')?.addEventListener('click', () => { const t = current(); if (t) { t.url = ''; t.history = []; t.pos = -1; } showChooser(); });
  $('#bFullscreen')?.addEventListener('click', () => {
    const frame = $('#browserFrame');
    if (!document.fullscreenElement && frame?.requestFullscreen) frame.requestFullscreen();
    else document.exitFullscreen?.();
  });
  $('#engineSelect')?.addEventListener('change', () => chooseEngine($('#engineSelect').value));
  // Engine chooser cards (Screen 1).
  $$('.engine-card[data-engine]').forEach(c => c.addEventListener('click', () => chooseEngine(c.dataset.engine)));
  // "← Choose a different engine" (Screen 2) goes back to the cards.
  $('#engineBack')?.addEventListener('click', showChooser);
  $$('.start-quicklinks button').forEach(b => b.addEventListener('click', () => navigate(b.dataset.url)));
}

function newTab(url) {
  const id = tabs.length;
  tabs.push({ id, title: 'New tab', url: '', history: [], pos: -1 });
  active = id;
  rebuildTabs();
  if (url) navigate(url); else renderStart();
}
function current() { return tabs.find(t => t.id === active); }

function rebuildTabs() {
  const wrap = $('#tabs'); if (!wrap) return;
  $$('.tab', wrap).forEach(n => n.remove());
  const add = $('#tabAdd');
  tabs.forEach(t => {
    const tab = el('button', { class: `tab${t.id === active ? ' tab-active' : ''}`, dataset: { tab: t.id } });
    tab.innerHTML = `<span class="tab-title">${t.title || 'New tab'}</span><span class="tab-x" aria-label="Close">×</span>`;
    tab.addEventListener('click', () => { active = t.id; rebuildTabs(); restoreCurrent(); });
    tab.querySelector('.tab-x').addEventListener('click', (e) => { e.stopPropagation(); closeTab(t.id); });
    wrap.insertBefore(tab, add);
  });
}

function closeTab(id) {
  const i = tabs.findIndex(t => t.id === id);
  if (i < 0) return;
  tabs.splice(i, 1);
  if (!tabs.length) newTab();
  else { active = tabs[Math.max(0, i - 1)].id; rebuildTabs(); restoreCurrent(); }
}

function restoreCurrent() {
  const t = current(); if (!t) return;
  if (t.url) load(t.url); else renderStart();
}

function navigate(input) {
  const t = current(); if (!t) return;
  let url;
  if (isLikelyUrl(input)) url = normalizeUrl(input);
  else url = `https://duckduckgo.com/?q=${encodeURIComponent(input)}`;
  if (t.url) {
    t.history = t.history.slice(0, t.pos + 1);
    t.history.push(url); t.pos = t.history.length - 1;
  } else { t.history = [url]; t.pos = 0; }
  t.url = url;
  t.title = url.replace(/^https?:\/\//, '').replace(/\/$/, '').slice(0, 30);
  rebuildTabs();
  load(url);
}

// Build the iframe src for a SINGLE in-iframe engine.  Returns null when the
// engine can't encode the URL (so the caller can fail over instead of loading
// a broken frame).
function buildProxyUrl(url, engine) {
  if (engine === 'scramjet') {
    if (!sjController) return null;
    try { return sjController.encodeUrl(url); }
    catch (e) { console.warn('[browser] Scramjet encode failed:', e); return null; }
  }
  if (engine === 'uv') {
    if (!self.__uv$config) return null;
    try { return self.__uv$config.prefix + self.__uv$config.encodeUrl(url); }
    catch (e) { console.warn('[browser] UV encode failed:', e); return null; }
  }
  // Direct mode — many public sites block this with X-Frame-Options; it's the
  // explicit "show me the raw page" / last-resort option.
  return url;
}

// Entry point for loading a URL.  Decides the engine strategy from the dropdown
// and hands off to attemptChain() for the actual (failover-aware) loading.
async function load(url) {
  const start = $('#startPage');
  const frame = $('#browserFrame');
  if (!frame) return;
  if (start) start.hidden = true;
  $('#urlInput').value = url;
  frame.hidden = false;

  const selected = $('#engineSelect').value;

  // GUST drives itself (own omnibox) — never route a typed URL through the flaky
  // SW chain when GUST is the engine; just (re)open GUST.
  if (selected === 'gust') { loadGust(); return; }
  setEngineChrome('other');

  // A companion is a whole separate browser app on its own origin — point the
  // iframe at it and let it drive.  (Its own omnibox handles navigation.)
  if (selected.startsWith('companion:')) {
    const c = companionById(selected.slice(10));
    if (!c) { toast('That browser is offline', 'err'); return; }
    loadCompanion(c);
    return;
  }

  // Build the failover chain.  Auto walks every online in-iframe engine.  A
  // specific pick still falls through to the engines AFTER it, so a blocked
  // choice recovers instead of leaving the user on a dead frame.
  let chain;
  if (selected === 'auto') chain = buildAutoChain();
  else {
    const rest = buildAutoChain().filter(e => e !== selected);
    chain = [selected, ...rest];
  }
  attemptChain(url, chain, 0);
}

// Load the GUST proxy app into the stage iframe. GUST owns its own omnibox, so
// the ZoFHub URL bar doesn't drive it — the user types inside GUST. Sized to the
// stage (CSS: .browser-frame is 100%×100% of .browser-stage) so it never spills.
function loadGust() {
  const start  = $('#startPage');
  const frame  = $('#browserFrame');
  const loader = $('#browserLoader');
  if (!frame) return;
  if (start) start.hidden = true;
  frame.hidden = false;
  browserBar()?.classList.remove('bar-hidden');   // show the bar (GUST shows its own note)
  setActiveEngine('gust');
  setEngineChrome('gust');
  setLoaderCaption('Starting GUST — this can take a few seconds the first time…');
  loader.hidden = false;
  const done = () => { loader.hidden = true; };
  const timeout = setTimeout(done, 12000);
  frame.onload = () => { clearTimeout(timeout); done(); };
  frame.onerror = () => { clearTimeout(timeout); done(); toast('GUST failed to load', 'err'); };
  frame.src = '/gust/';
}

function setLoaderCaption(text) { const c = $('#loaderCaption'); if (c) c.textContent = text; }

// Load a cross-origin companion browser into the stage.
function loadCompanion(c) {
  const frame = $('#browserFrame');
  const loader = $('#browserLoader');
  const start = $('#startPage');
  if (start) start.hidden = true;
  frame.hidden = false;
  browserBar()?.classList.remove('bar-hidden');
  setActiveEngine(`companion:${c.id}`);
  setLoaderCaption(`Opening ${c.label}…`);
  loader.hidden = false;
  const timeout = setTimeout(() => { loader.hidden = true; }, 12000);
  frame.onload = () => { clearTimeout(timeout); loader.hidden = true; };
  frame.onerror = () => { clearTimeout(timeout); loader.hidden = true; toast(`${c.label} failed to load`, 'err'); };
  toast(`Opening ${c.label} — use its address bar to browse`, 'ok');
  frame.src = c.url;
}

// Try chain[idx]; on timeout/error advance to chain[idx+1].  This is the heart
// of "in case nothing works": when one engine is blocked, the next is tried
// automatically against the very same target URL.
async function attemptChain(url, chain, idx) {
  const frame = $('#browserFrame');
  const loader = $('#browserLoader');
  if (!frame) return;

  if (idx >= chain.length) {
    loader.hidden = true;
    setActiveEngine(null);
    toast('Every engine was blocked. Try GUST from the dropdown.', 'err');
    return;
  }

  const engine = chain[idx];
  setActiveEngine(engine);
  loader.hidden = false;

  // Proxy service workers fetch through bare-mux at request time, so the shared
  // transport must be LIVE before we set frame.src. If the Wisp tunnel is down,
  // a proxied engine would just hang for the full timeout on EVERY engine
  // ("loads forever") — so when the transport isn't ready, skip straight to the
  // next engine (the chain ends at Direct, which needs no tunnel).
  if (engine !== 'direct') {
    let tReady = false;
    try { tReady = await transportReady; } catch {}
    if (!tReady) { advance(`${engineLabel(engine)} tunnel offline`); return; }
  }

  const target = buildProxyUrl(url, engine);
  if (target == null) { advance(`${engineLabel(engine)} unavailable`); return; }

  let settled = false;
  const next = (why) => { if (settled) return; settled = true; clearTimeout(timer); advance(why); };
  const ok = () => {
    if (settled) return; settled = true; clearTimeout(timer);
    loader.hidden = true;
    // Tell the user when a fallback engine — not their pick — ended up serving.
    if (idx > 0) toast(`Loaded with ${engineLabel(engine)}`, 'ok');
  };
  const timer = setTimeout(() => next(`${engineLabel(engine)} timed out`), 6000);
  frame.onload = ok;
  frame.onerror = () => next(`${engineLabel(engine)} errored`);
  frame.src = target;

  function advance(why) {
    if (idx + 1 < chain.length) {
      toast(`${why} — trying ${engineLabel(chain[idx + 1])}…`, 'warn');
      attemptChain(url, chain, idx + 1);
    } else {
      loader.hidden = true;
      setActiveEngine(null);
      toast('Every engine was blocked. Try GUST from the dropdown.', 'err');
    }
  }
}

function renderStart() {
  const input = $('#urlInput'); if (input) input.value = '';
  showChooser();   // "start" = the engine chooser
}
