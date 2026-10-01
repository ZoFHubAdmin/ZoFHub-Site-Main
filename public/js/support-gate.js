// ZoFHub · support-gate.js — ad-block detection, and the premium-engine gate.
// ---------------------------------------------------------------------------
// WHAT IT DOES
//   1. Detects a content blocker, with evidence from three independent places:
//        cosmetic   a bait element carrying the class names blockers' element-
//                   hiding lists target is hidden or removed;
//        container  one of our own ad containers (ExoClick header/sidebar,
//                   Mondiad native) is hidden or has no box;
//        network    a real ad script (or the pre-roll's VAST tag) failed to load
//                   AND a follow-up HEAD request to the same URL is refused too.
//   2. On the first detection in a session, shows a polite, dismissible note
//      explaining that the ads keep the proxy mirrors alive and free.
//   3. After STRIKES_TO_GATE (3) page views or game plays with the blocker still
//      on, locks the PREMIUM engines — AnuraOS and every standalone companion —
//      until the visitor pauses it and refreshes. The games hub, and the
//      built-in engines (Scramjet, Ultraviolet, GUST), are never locked.
//
// WHAT IT IS CAREFUL NOT TO DO
//   • Lock anybody on a deployment that serves no ads. The server says whether
//     the gate applies (`supportGate` in /api/site-config): only while a network
//     is actually active, and only while the console switch is on.
//   • Treat misconfiguration as a blocker. A script refused by the CSP, or one
//     that 404s, still answers the follow-up HEAD request — only a request the
//     browser itself refuses to send (an extension, an ad-blocking DNS) counts.
//     A timeout is "unknown", never "blocked". Offline means no verdict at all.
//   • Contact an ad network from a proxy page. On /browser the check is the bait
//     element alone, plus — only when the stored verdict rests on network
//     evidence AND the bait now looks clear, i.e. the visitor says they paused —
//     a no-referrer, no-cookie HEAD to the loader URLs the hub pages saw fail.
//     No ad code is fetched for execution and nothing renders.
//
// NOT SECURITY. A determined visitor can edit this page. The gate is a fair-
// play request with a real reason behind it, not access control.
//
// Import with exactly this specifier ('./support-gate.js') everywhere — the
// lock state is shared with browser.js through this one module instance.
//
// The state machine at the top is pure and exported, so
// test/support-gate.test.mjs can drive it in Node without a DOM.
// ---------------------------------------------------------------------------

const STATE_KEY = 'zofhub.support.v1';
const NOTE_SEEN_KEY = 'zofhub.support.note';        // sessionStorage
export const STRIKES_TO_GATE = 3;
// A verdict older than this is stale: a visitor who has not been seen for a
// week is not locked out on the strength of what their browser did back then.
export const VERDICT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_PROBES = 3;
const PROBE_TIMEOUT_MS = 4000;
// How long real ad scripts get to load or fail before the verdict is taken.
const SETTLE_MS = 3000;
// Class names that generic element-hiding rules target. None of them is used by
// ZoFHub's own stylesheets, so our CSS can never hide the bait by itself.
const BAIT_CLASSES = 'ad-banner adsbox ad-placement pub_300x250 pub_728x90 text-ad textAd text_ad text-ads';

// ── Pure state ─────────────────────────────────────────────────────────────

export function emptyState() {
  return { v: 1, strikes: 0, blocked: false, signals: [], probes: [], gate: false, at: 0 };
}

/** Coerce anything read back from storage into a well-formed state. */
export function normalizeState(raw) {
  const s = emptyState();
  if (!raw || typeof raw !== 'object') return s;
  s.strikes = Number.isFinite(raw.strikes) && raw.strikes > 0 ? Math.min(Math.floor(raw.strikes), 99) : 0;
  s.blocked = raw.blocked === true;
  s.signals = Array.isArray(raw.signals) ? raw.signals.filter((x) => typeof x === 'string').slice(0, 8) : [];
  s.probes = Array.isArray(raw.probes)
    ? raw.probes.filter((x) => typeof x === 'string' && /^https:\/\//.test(x)).slice(0, MAX_PROBES) : [];
  s.gate = raw.gate === true;
  s.at = Number.isFinite(raw.at) && raw.at > 0 ? raw.at : 0;
  return s;
}

/**
 * The state after one page view's verdict.
 *   clear   → everything resets: pausing the blocker unlocks immediately
 *   blocked → one more strike (the caller guarantees one per page view)
 */
export function nextState(prev, verdict, { now, gate }) {
  const p = normalizeState(prev);
  if (!verdict || !verdict.blocked) return { ...emptyState(), gate: Boolean(gate), at: now };
  const probes = [...new Set([...(verdict.probes || []), ...p.probes])]
    .filter((x) => typeof x === 'string' && /^https:\/\//.test(x)).slice(0, MAX_PROBES);
  return {
    v: 1,
    strikes: Math.min((p.blocked ? p.strikes : 0) + 1, 99),
    blocked: true,
    signals: [...new Set(verdict.signals || [])],
    probes,
    gate: Boolean(gate),
    at: now,
  };
}

/** Are the premium engines locked for this state, right now? */
export function isLocked(state, now) {
  const s = normalizeState(state);
  return s.gate && s.blocked && s.strikes >= STRIKES_TO_GATE && now - s.at < VERDICT_TTL_MS;
}

// ── Storage ────────────────────────────────────────────────────────────────

function readState() {
  try { return normalizeState(JSON.parse(localStorage.getItem(STATE_KEY) || 'null')); }
  catch { return emptyState(); }
}
function writeState(s) {
  try { localStorage.setItem(STATE_KEY, JSON.stringify(s)); } catch { /* storage off: no memory, no lock */ }
}

const listeners = new Set();
/** Subscribe to lock changes. Returns an unsubscribe function. */
export function onGateChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function emit() {
  const locked = premiumLocked();
  for (const fn of listeners) { try { fn(locked); } catch { /* one bad listener must not stop the rest */ } }
}

/** Synchronous answer from the last stored verdict. */
export function premiumLocked() { return isLocked(readState(), Date.now()); }

// ── Evidence collection ────────────────────────────────────────────────────

let armed = false;
let armedAt = 0;
let bait = null;
const scriptOutcome = new Map();      // src -> 'loaded' | 'error'
const cspRefused = new Set();         // URLs the page's own CSP blocked
const noted = new Set();              // blocked resources reported by other modules

const AD_SCRIPT_HOSTS = '.zad, .zad-int-box, .zad-native, [data-zad-popunder]';
function isAdScript(el) {
  return el && el.tagName === 'SCRIPT' && el.src
    && (el.dataset?.proxyAd === '1' || Boolean(el.closest?.(AD_SCRIPT_HOSTS)));
}

function plantBait() {
  if (bait || !document.body) return;
  bait = document.createElement('div');
  bait.className = BAIT_CLASSES;
  bait.setAttribute('aria-hidden', 'true');
  bait.innerHTML = '&nbsp;';
  const st = bait.style;
  st.position = 'absolute'; st.left = '-10000px'; st.top = '-10000px';
  st.width = '1px'; st.height = '1px'; st.overflow = 'hidden'; st.pointerEvents = 'none';
  document.body.appendChild(bait);
}

function baitHidden() {
  if (!bait) return false;
  if (!bait.isConnected) return true;                 // removed by a blocker
  const cs = getComputedStyle(bait);
  if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return true;
  return bait.offsetHeight === 0 || bait.offsetParent === null;
}

/**
 * Start watching. Call BEFORE any ad script is injected: load and error events
 * are not replayed, so a script that fails before the listener exists is a
 * failure nobody saw. Capture phase on window, because neither event bubbles.
 */
export function armAdWatch() {
  if (armed || typeof window === 'undefined') return;
  armed = true;
  armedAt = Date.now();
  window.addEventListener('load', (e) => {
    if (isAdScript(e.target)) scriptOutcome.set(e.target.src, 'loaded');
  }, true);
  window.addEventListener('error', (e) => {
    if (isAdScript(e.target) && scriptOutcome.get(e.target.src) !== 'loaded') scriptOutcome.set(e.target.src, 'error');
  }, true);
  document.addEventListener('securitypolicyviolation', (e) => {
    if (e.blockedURI) cspRefused.add(e.blockedURI);
  });
  plantBait();
}

/** Another module (the pre-roll) confirmed that a resource was refused. */
export function noteBlockedResource(url) {
  if (typeof url !== 'string' || !/^https:\/\//.test(url)) return;
  noted.add(url);
  // Before the verdict, it simply joins the evidence. After a CLEAR verdict it
  // upgrades that verdict — but only while the gate applies at all.
  if (evaluated && gateOn && !viewBlocked) commit({ blocked: true, signals: ['network'], probes: [url] });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Can the browser send a request to `url` at all?
 *   true   it answered (any status — a 404 or a CSP refusal of the SCRIPT is
 *          still a reachable host, so it is not a blocker)
 *   false  the browser refused to send it: an extension, a blocking DNS
 *   null   no answer in time — unknown, never counted
 * HEAD, opaque, no cookies, no referrer: nothing executes and nothing renders.
 */
export async function reachable(url) {
  const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = setTimeout(() => ctrl?.abort(), PROBE_TIMEOUT_MS);
  try {
    await fetch(url, {
      method: 'HEAD', mode: 'no-cors', credentials: 'omit', cache: 'no-store',
      referrerPolicy: 'no-referrer', signal: ctrl?.signal,
    });
    return true;
  } catch (e) {
    return e?.name === 'AbortError' ? null : false;
  } finally {
    clearTimeout(timer);
  }
}

function hiddenAdContainers() {
  const wide = window.matchMedia?.('(min-width: 901px)')?.matches;
  let n = 0;
  for (const el of document.querySelectorAll('.zad-header-bar, .zad-side-wrap, .zad-native-slot[data-zad-filled]')) {
    if (el.classList.contains('zad-side-wrap') && !wide) continue;   // hidden by our own CSS below 901px
    if (el.closest('[hidden]')) continue;                            // a row we hid ourselves
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || el.getClientRects().length === 0) n++;
  }
  return n;
}

// ── Verdict ────────────────────────────────────────────────────────────────

let evaluated = false;
let viewBlocked = false;
let gateOn = false;
let adSurfaceView = false;

function commit(verdict) {
  const prev = readState();
  // One strike per page view: a second blocked verdict in the same view (the
  // pre-roll reporting late) refreshes the evidence without counting again.
  const next = viewBlocked && verdict.blocked
    ? { ...nextState(prev, verdict, { now: Date.now(), gate: gateOn }), strikes: prev.strikes }
    : nextState(prev, verdict, { now: Date.now(), gate: gateOn });
  writeState(next);
  const firstBlock = verdict.blocked && !viewBlocked;
  viewBlocked = viewBlocked || verdict.blocked;
  emit();
  if (firstBlock && adSurfaceView) showSupportNote();
}

/**
 * Take this page view's verdict.
 * @param {object|null} cfg          the /api/site-config payload
 * @param {object} o
 * @param {boolean} o.adSurface      true on hub/game pages (the ad stack ran)
 */
export async function evaluateSupport(cfg, { adSurface }) {
  if (evaluated || typeof window === 'undefined') return;
  evaluated = true;
  adSurfaceView = Boolean(adSurface);
  gateOn = Boolean(cfg && cfg.supportGate);
  if (!gateOn) {
    // No ads are running here, or the switch is off: nothing to support, so
    // nothing may be locked. Record that without touching the strike history.
    const s = readState();
    if (s.gate) { writeState({ ...s, gate: false }); emit(); }
    return;
  }
  if (navigator.onLine === false) return;             // no verdict while offline

  plantBait();
  // Element hiding is applied asynchronously by most blockers; look twice.
  await sleep(120);
  let cosmetic = baitHidden();
  const signals = [];
  const probes = [];

  if (adSurfaceView) {
    await sleep(Math.max(0, SETTLE_MS - (Date.now() - armedAt)));
    cosmetic = cosmetic || baitHidden();
    if (cosmetic) signals.push('cosmetic');
    if (hiddenAdContainers()) signals.push('container');
    const failed = [...scriptOutcome].filter(([u, st]) => st === 'error' && !cspRefused.has(u)).map(([u]) => u);
    for (const url of failed.slice(0, MAX_PROBES)) {
      if ((await reachable(url)) === false) probes.push(url);
    }
  } else {
    await sleep(1400);
    cosmetic = cosmetic || baitHidden();
    if (cosmetic) signals.push('cosmetic');
    // Only when the visitor may have paused: the stored verdict rests on
    // network evidence, and this page shows no cosmetic blocking.
    const prev = readState();
    if (!cosmetic && prev.blocked && prev.signals.includes('network') && prev.probes.length) {
      const results = [];
      for (const url of prev.probes) results.push(await reachable(url));
      if (results.some((r) => r === false)) probes.push(...prev.probes.filter((_, i) => results[i] === false));
      else if (results.every((r) => r === null)) return;   // inconclusive: leave the stored verdict alone
    }
  }
  for (const url of noted) probes.push(url);
  if (probes.length) signals.push('network');
  commit({ blocked: signals.length > 0, signals, probes });
}

// ── UI: shared pieces ──────────────────────────────────────────────────────
// Rendered in shadow roots under custom element names: page CSS cannot reach
// in, our CSS cannot leak out, and generic element-hiding rules — which match
// class and id names like "adblock-notice" — have nothing to match.

const UI_CSS = `
:host{all:initial}
*{box-sizing:border-box}
.card{font:14px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#f7f4ff;background:#1f1646;
  border:1px solid rgba(170,140,255,.34);border-radius:16px;box-shadow:0 18px 50px rgba(10,4,32,.62);
  padding:22px 22px 18px;max-width:440px;width:100%}
h2{margin:0 0 8px;font-size:18px;line-height:1.3}
p{margin:0 0 10px;color:#d8cef7}
.muted{color:#a99bd8;font-size:13px}
ol{margin:4px 0 12px;padding-left:20px;color:#d8cef7}
li{margin:3px 0}
.row{display:flex;gap:10px;flex-wrap:wrap;margin-top:14px}
button{appearance:none;border:0;border-radius:999px;padding:10px 18px;font-family:inherit;font-size:14px;
  font-weight:700;line-height:1;cursor:pointer}
.primary{background:#ffd426;color:#241a00}
.ghost{background:rgba(255,255,255,.08);color:#f7f4ff;border:1px solid rgba(170,140,255,.34)}
button:focus-visible{outline:3px solid #22d3ee;outline-offset:2px}
[hidden]{display:none!important}
`;

function pauseSteps() {
  const wrap = document.createElement('div');
  wrap.hidden = true;
  wrap.innerHTML = `
    <ol>
      <li>Click your ad-blocker's icon in the browser toolbar (uBlock Origin, AdBlock, AdGuard, Brave Shields…).</li>
      <li>Choose <b>Pause on this site</b> or <b>Don't run on pages on this domain</b> — or add this site to its allowlist.</li>
      <li>Refresh this page.</li>
    </ol>
    <p class="muted">Blocking ads with a DNS service or VPN instead? Allow this site there.</p>`;
  return wrap;
}

function pauseButtonPair(steps) {
  const pause = document.createElement('button');
  pause.type = 'button';
  pause.className = 'primary';
  pause.textContent = 'Pause Adblocker';
  pause.addEventListener('click', () => {
    if (steps.hidden) {
      steps.hidden = false;
      pause.textContent = 'I paused it — refresh';
      return;
    }
    location.reload();
  });
  return pause;
}

// ── UI: the one-per-session note ───────────────────────────────────────────

function showSupportNote() {
  try { if (sessionStorage.getItem(NOTE_SEEN_KEY)) return; sessionStorage.setItem(NOTE_SEEN_KEY, '1'); }
  catch { /* no session storage: show it, once for this page */ }
  if (document.querySelector('zofhub-note')) return;

  const locked = premiumLocked();
  const host = document.createElement('zofhub-note');
  const root = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = UI_CSS + `
.backdrop{position:fixed;inset:0;z-index:2147482500;display:grid;place-items:center;padding:16px;
  background:rgba(8,6,24,.62);backdrop-filter:blur(3px)}`;
  const backdrop = document.createElement('div');
  backdrop.className = 'backdrop';
  const card = document.createElement('div');
  card.className = 'card';
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-modal', 'true');
  card.setAttribute('aria-labelledby', 'zsg-title');

  const title = document.createElement('h2');
  title.id = 'zsg-title';
  title.textContent = 'Keep ZoFHub free?';
  const p1 = document.createElement('p');
  p1.textContent = 'It looks like an ad-blocker is on. A few ads are what keep the proxy mirrors alive and free — '
    + 'whitelisting this site, or pausing your blocker here, keeps them running for everyone.';
  const p2 = document.createElement('p');
  p2.className = 'muted';
  p2.textContent = locked
    ? 'The premium engines — AnuraOS and the standalone browsers — are paused while it stays on. The games stay free either way.'
    : `If it stays on, the premium engines — AnuraOS and the standalone browsers — pause after ${STRIKES_TO_GATE} pages. The games stay free either way.`;
  const steps = pauseSteps();
  const row = document.createElement('div');
  row.className = 'row';
  const later = document.createElement('button');
  later.type = 'button';
  later.className = 'ghost';
  later.textContent = 'Not now';
  row.append(pauseButtonPair(steps), later);
  card.append(title, p1, p2, steps, row);
  backdrop.appendChild(card);
  root.append(style, backdrop);

  const prevFocus = document.activeElement;
  const close = () => {
    document.removeEventListener('keydown', onKey, true);
    host.remove();
    try { prevFocus?.focus?.(); } catch { /* not focusable */ }
  };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  later.addEventListener('click', close);
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
  document.addEventListener('keydown', onKey, true);
  document.body.appendChild(host);
  try { row.firstChild.focus(); } catch { /* ignore */ }
}

// ── UI: the premium lock card ──────────────────────────────────────────────

/**
 * Cover `container` (the proxy stage) with the lock card for `label`.
 * Returns a function that removes it. Only one card exists at a time.
 *
 * @param {HTMLElement} container
 * @param {object} o
 * @param {string} o.label         the engine the visitor picked
 * @param {string} [o.backLabel]   the engine they will stay on
 * @param {() => void} [o.onBack]
 */
export function showPremiumLock(container, { label = 'This engine', backLabel = '', onBack } = {}) {
  hidePremiumLock();
  if (!container) return () => {};
  if (getComputedStyle(container).position === 'static') container.style.position = 'relative';

  const host = document.createElement('zofhub-lock');
  host.style.cssText = 'position:absolute;inset:0;z-index:40;display:block';
  const root = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = UI_CSS + `
.stage{position:absolute;inset:0;display:grid;place-items:center;padding:16px;overflow:auto;
  background:rgba(12,8,32,.86);backdrop-filter:blur(4px);border-radius:inherit}`;
  const stage = document.createElement('div');
  stage.className = 'stage';
  const card = document.createElement('div');
  card.className = 'card';
  card.setAttribute('role', 'alertdialog');
  card.setAttribute('aria-labelledby', 'zsl-title');

  const title = document.createElement('h2');
  title.id = 'zsl-title';
  title.textContent = `🔒 ${label} is a premium engine`;
  const p1 = document.createElement('p');
  p1.textContent = 'AnuraOS and the standalone browsers run on our heaviest servers, and ads are what pay for them. '
    + 'Your ad-blocker is on, so they are locked for now: whitelisting this site or pausing your blocker is '
    + 'required to unlock the premium high-speed proxy instances.';
  const p2 = document.createElement('p');
  p2.className = 'muted';
  p2.textContent = 'The games hub and the built-in engines — Scramjet, Ultraviolet and GUST — keep working either way.';
  const steps = pauseSteps();
  const row = document.createElement('div');
  row.className = 'row';
  const back = document.createElement('button');
  back.type = 'button';
  back.className = 'ghost';
  back.textContent = backLabel ? `Back to ${backLabel}` : 'Back';
  back.addEventListener('click', () => { hidePremiumLock(); onBack?.(); });
  row.append(pauseButtonPair(steps), back);
  card.append(title, p1, p2, steps, row);
  stage.appendChild(card);
  root.append(style, stage);
  container.appendChild(host);
  try { row.firstChild.focus(); } catch { /* ignore */ }
  return hidePremiumLock;
}

export function hidePremiumLock() {
  for (const el of document.querySelectorAll('zofhub-lock')) el.remove();
}

/**
 * Refuse navigation to the premium engines' own origins while locked — the
 * "open in a new tab" links and anything else on the page that points there.
 * Capture phase, so it runs before any other click handler.
 *
 * @param {() => string[]} originsFn   current premium origins (they arrive async)
 * @param {(origin: string) => void} onRefused   told which origin was refused
 */
export function guardPremiumLinks(originsFn, onRefused) {
  document.addEventListener('click', (e) => {
    if (!premiumLocked()) return;
    const a = e.target?.closest?.('a[href]');
    if (!a) return;
    let origin;
    try { origin = new URL(a.href, location.href).origin; } catch { return; }
    if (origin === location.origin || !originsFn().includes(origin)) return;
    e.preventDefault();
    e.stopPropagation();
    onRefused?.(origin);
  }, true);
}

export default {
  STRIKES_TO_GATE, VERDICT_TTL_MS, emptyState, normalizeState, nextState, isLocked,
  armAdWatch, evaluateSupport, noteBlockedResource, reachable, premiumLocked, onGateChange,
  showPremiumLock, hidePremiumLock, guardPremiumLinks,
};
