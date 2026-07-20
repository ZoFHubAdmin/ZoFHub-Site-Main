// ZoFHub · connection-status.js — an HONEST connection indicator.
// ---------------------------------------------------------------------------
// This shows a "Connecting…" overlay ONLY while a REAL connection is actually
// being established, and it disappears the instant the real connection is ready.
// There is NO artificial delay and NO fake "minimum display time" — the overlay's
// lifetime is tied 1:1 to the actual network event. If the real connection fails
// or genuinely times out, it shows an honest error instead of pretending.
//
// USAGE — wire it to whatever real thing you're waiting on:
//
//   import { ConnectionStatus } from './connection-status.js';
//
//   // (a) waiting on an iframe to actually load a proxied page:
//   ConnectionStatus.begin('Connecting to proxy…');
//   ConnectionStatus.trackIframe(myIframe);      // hides on real 'load', errors on timeout
//
//   // (b) waiting on a real WebSocket (e.g. the Wisp tunnel):
//   ConnectionStatus.begin('Opening secure tunnel…');
//   ConnectionStatus.trackWebSocket(ws);         // hides on real 'open'
//
//   // (c) waiting on a real fetch/promise:
//   ConnectionStatus.begin('Reaching server…');
//   await ConnectionStatus.track(fetch(url));    // hides on resolve, errors on reject
//
// Manual control is also available: .set(text), .done(), .fail(message).
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 20000;  // a REAL ceiling: if nothing connects by now, it truly failed

let overlay, cardEl, labelEl, subEl, actionsEl, timer = null, onCancel = null;

function build() {
  if (overlay) return;
  overlay = document.createElement('div');
  overlay.className = 'cxs-overlay';
  overlay.setAttribute('role', 'status');
  overlay.setAttribute('aria-live', 'polite');
  overlay.innerHTML = `
    <div class="cxs-card">
      <div class="cxs-spinner" aria-hidden="true"></div>
      <p class="cxs-label"></p>
      <p class="cxs-sub"></p>
      <div class="cxs-actions"><button type="button" class="cxs-btn"></button></div>
    </div>`;
  cardEl    = overlay.querySelector('.cxs-card');
  labelEl   = overlay.querySelector('.cxs-label');
  subEl     = overlay.querySelector('.cxs-sub');
  actionsEl = overlay.querySelector('.cxs-actions');
  overlay.querySelector('.cxs-btn').addEventListener('click', () => {
    // Cancel button: honest — it stops waiting and closes. It does not "unlock"
    // anything or count as an action; it simply aborts the attempt.
    if (typeof onCancel === 'function') { try { onCancel(); } catch {} }
    hide();
  });
  document.body.appendChild(overlay);
}

function clearTimer() { if (timer) { clearTimeout(timer); timer = null; } }

function hide() {
  clearTimer();
  if (overlay) overlay.classList.remove('is-open');
}

const ConnectionStatus = {
  /** Show the overlay and start a REAL timeout. `label` describes what's genuinely happening. */
  begin(label = 'Connecting…', { timeout = DEFAULT_TIMEOUT_MS, cancel = null, cancelLabel = 'Cancel' } = {}) {
    build();
    onCancel = cancel;
    cardEl.classList.remove('is-error');
    labelEl.textContent = label;
    subEl.textContent = '';
    const btn = overlay.querySelector('.cxs-btn');
    btn.textContent = cancelLabel;
    actionsEl.style.display = cancel ? '' : 'none';
    overlay.classList.add('is-open');
    clearTimer();
    if (timeout > 0) timer = setTimeout(() => this.fail("This is taking longer than usual — the route may be down. Try a different one."), timeout);
    return this;
  },

  /** Update the sub-text to reflect a REAL sub-stage (only call this on actual progress). */
  set(sub) { if (subEl) subEl.textContent = sub || ''; return this; },

  /** The real connection succeeded — close immediately (no lingering). */
  done() { hide(); return this; },

  /** The real connection failed — show an honest error and let the user retry/close. */
  fail(message = "Couldn't reach the server.") {
    build();
    clearTimer();
    cardEl.classList.add('is-error');
    labelEl.textContent = 'Connection failed';
    subEl.textContent = message;
    const btn = overlay.querySelector('.cxs-btn');
    btn.textContent = 'Close';
    actionsEl.style.display = '';
    overlay.classList.add('is-open');
    return this;
  },

  /** Hide on the iframe's REAL load event; error on real timeout. */
  trackIframe(iframe, { timeout = DEFAULT_TIMEOUT_MS } = {}) {
    if (!iframe) return this;
    const onLoad = () => { cleanup(); this.done(); };
    const onError = () => { cleanup(); this.fail('That page could not be loaded through this route.'); };
    const cleanup = () => { iframe.removeEventListener('load', onLoad); iframe.removeEventListener('error', onError); };
    iframe.addEventListener('load', onLoad, { once: true });
    iframe.addEventListener('error', onError, { once: true });
    if (timeout > 0) { clearTimer(); timer = setTimeout(() => { cleanup(); this.fail('The route timed out. Try a different one.'); }, timeout); }
    return this;
  },

  /** Hide on the WebSocket's REAL open event; error on close-before-open. */
  trackWebSocket(ws) {
    if (!ws) return this;
    ws.addEventListener('open', () => this.done(), { once: true });
    ws.addEventListener('error', () => this.fail('The secure tunnel could not open.'), { once: true });
    return this;
  },

  /** Hide when a REAL promise resolves; error when it rejects. Returns the promise. */
  track(promise) {
    Promise.resolve(promise).then(() => this.done(), () => this.fail()).catch(() => {});
    return promise;
  },
};

export { ConnectionStatus };
