// ZoFHub · puter.js — the Puter.js AI client (the site's SECOND AI provider).
// ---------------------------------------------------------------------------
// A sibling to pollinations.js. Where that one is a single browser-direct GET to
// text.pollinations.ai, this one talks to Puter's SDK, which runs entirely in
// the visitor's browser against THEIR OWN Puter account:
//
//     puter.ai.chat([{ role, content }, …], false, { normalize: true })
//
// The "user-pays" model means the prompt, the sign-in and the (free) usage
// allowance all belong to the visitor's Puter account. Our server is nowhere in
// the path, we ship no key, and we store no token — Puter's SDK keeps its own
// session. The SDK is loaded ONLY when a visitor actually chooses this provider
// (ensurePuter injects the tag on demand), so a visitor who never picks Puter
// never loads a byte of a third party's script.
//
// This module is the ONLY place that names the Puter SDK or calls puter.ai, the
// same way pollinations.js is the only place that names its endpoint — so the
// chat page and the orb can never drift from it. Failures are mapped onto the
// SAME typed `.code` vocabulary pollinations.js uses, and describePuterFailure
// falls through to the shared describeFailure for every code they have in
// common, so both providers speak with one voice.
// ---------------------------------------------------------------------------

import { describeFailure } from './pollinations.js?v=20261016';

// The official SDK. A <script> on js.puter.com, allow-listed in the site CSP's
// script-src. Versioned ("v2") by Puter, not by us.
export const PUTER_SDK = 'https://js.puter.com/v2/';

// Puter generations can run longer than a Pollinations GET (bigger models, a
// cold account, the first-call sign-in round trip), so the ceiling is higher —
// but it is still ONE bounded value, never a chain of them.
export const PUTER_TIMEOUT_MS = 90000;

// The default model is Puter's own choice; we pin nothing, so the provider can
// move the free default without a change here. normalize:true asks Puter to hand
// back a plain string even for vendors that otherwise answer in content blocks.
const CHAT_OPTIONS = { normalize: true };

let sdkPromise = null;

// ── The SDK must be constructed as if on a web page ────────────────────────
// Puter's SDK decides what it is running in at the instant it LOADS, and one of its tests is
// whether a global named `process` exists: if so it concludes it is in Node.js. In that mode it
// never restores a saved session, never shows a sign-in window or dialog, and sends every chat
// request without an account, which is answered "401 Unauthorized". Browser polyfills, ad
// scripts and extensions sometimes define `process`; on such a page the visitor presses Send
// and no sign-up screen ever appears. (Reproduced against the real SDK with a one-line
// `window.process = {}`.)
//
// The decision is made once, in the SDK's constructor, so it cannot be fixed afterwards by
// changing its `env` field (the session restore and the rest of the web setup are skipped for
// good), and loading the SDK a second time fails because it registers a custom element that
// cannot be registered twice. So the global is moved out of the way while the SDK loads and
// put back the moment it has, which is the only point at which the SDK looks.

/**
 * Hide `window.process` and return a function that puts it back. If another script assigns a
 * `process` while it is hidden, that value is what comes back. A global that cannot be
 * redefined is left alone (returns a no-op): the explicit sign-in still works on such a page,
 * it just is not remembered between visits.
 */
export function hideNodeGlobal() {
  const saved = Object.getOwnPropertyDescriptor(window, 'process');
  if (!saved || !saved.configurable) return () => {};
  let assigned = false;
  let late;
  try {
    Object.defineProperty(window, 'process', {
      configurable: true, enumerable: saved.enumerable,
      get: () => undefined,
      set: (v) => { assigned = true; late = v; },
    });
  } catch { return () => {}; }
  let back = false;
  return () => {
    if (back) return;
    back = true;
    try {
      if (assigned) Object.defineProperty(window, 'process', { value: late, writable: true, configurable: true, enumerable: true });
      else Object.defineProperty(window, 'process', saved);
    } catch { /* the page carries on without it rather than break */ }
  };
}

/**
 * Resolve once `window.puter.ai.chat` is callable, injecting the SDK the first
 * time. Bounded: a script that never loads rejects as 'offline' rather than
 * leaving the caller hanging. Cached, so switching to Puter twice loads it once.
 */
export function ensurePuter({ timeoutMs = 15000 } = {}) {
  if (typeof window !== 'undefined' && window.puter?.ai?.chat) return Promise.resolve(window.puter);
  if (sdkPromise) return sdkPromise;

  sdkPromise = new Promise((resolve, reject) => {
    // Only when a tag is about to be injected: a page that already has the SDK has nothing to hide.
    const alreadyInjected = !!document.querySelector('script[data-puter-sdk]');
    const putProcessBack = alreadyInjected ? () => {} : hideNodeGlobal();
    const fail = (msg) => {
      putProcessBack();
      sdkPromise = null;                 // let a later attempt retry from scratch
      const e = new Error(msg);
      e.code = 'offline';
      reject(e);
    };
    let settled = false;
    const ready = () => {
      if (settled) return;
      settled = true; clearInterval(poll); clearTimeout(timer);
      putProcessBack();
      // Said once, because the cause is invisible otherwise: the SDK came up thinking it is not in a
      // web page, so it will not remember a sign-in between visits.
      if (!['web', 'app', 'gui'].includes(window.puter?.env)) {
        console.warn(`[puter] the SDK loaded believing its environment is "${window.puter?.env}" (something on this page defines \`process\` and could not be moved aside); sign-in will work for this visit but will not be remembered.`);
      }
      resolve(window.puter);
    };
    const timer = setTimeout(() => { if (!settled) { settled = true; clearInterval(poll); fail('the Puter SDK did not load'); } }, timeoutMs);
    // The script's own onload can fire before `puter.ai` is wired up, so poll for
    // the actual callable rather than trusting load order.
    const poll = setInterval(() => { if (window.puter?.ai?.chat) ready(); }, 120);

    let tag = document.querySelector('script[data-puter-sdk]');
    if (!tag) {
      tag = document.createElement('script');
      tag.src = PUTER_SDK;
      tag.async = true;
      tag.setAttribute('data-puter-sdk', '');
      tag.addEventListener('error', () => { if (!settled) { settled = true; clearInterval(poll); fail('the Puter SDK could not be loaded'); } });
      document.head.appendChild(tag);
    }
    if (window.puter?.ai?.chat) ready();   // already present (a second switch)
  });
  return sdkPromise;
}

// ── Signing in ─────────────────────────────────────────────────────────────
// Puter's SDK opens its own sign-in window the first time an API is called without a session.
// That window is opened from INSIDE the SDK, after our code has already waited for the SDK to
// download, so on a slow connection — or in a browser that is strict about pop-ups (Safari,
// phones, anything with a blocker) — it arrives after the browser has stopped treating the
// click as a user gesture, and is dropped without a word. The visitor was then told a window
// "should open" and had no way to open one.
//
// So signing in is an explicit step with its own button. It starts from a click or a keypress
// while the SDK is ALREADY loaded (the chat page preloads it the moment Puter is chosen), and
// if the browser still refuses the window we know at once — window.open returns nothing — and
// say so instead of waiting out the generation timeout.

const puterError = (code, message) => { const e = new Error(message); e.code = code; return e; };

/** True once the SDK has loaded far enough to sign a visitor in and to chat. */
export function puterReady() {
  return typeof window !== 'undefined'
    && typeof window.puter?.auth?.signIn === 'function'
    && typeof window.puter?.ai?.chat === 'function';
}

/** Start loading the SDK without asking it anything. Resolves true/false; never throws. */
export function preloadPuter() {
  return ensurePuter().then(() => true, () => false);
}

/** 'signed-in' | 'signed-out' | 'unknown' (SDK not loaded, or it does not say). */
export function puterSignInState() {
  try {
    const auth = window.puter?.auth;
    if (typeof auth?.isSignedIn !== 'function') return 'unknown';
    return auth.isSignedIn() ? 'signed-in' : 'signed-out';
  } catch { return 'unknown'; }
}

/** The signed-in account's username, or '' when there is none or it cannot be read. */
export async function puterUsername() {
  try {
    const u = await window.puter?.auth?.getUser?.();
    return String(u?.username || '').replace(/[^\w.@ -]/g, '').slice(0, 64);
  } catch { return ''; }
}

/** Sign out of Puter on this site. Resolves true/false; never throws. */
export async function signOutOfPuter() {
  try { await window.puter?.auth?.signOut?.(); return true; } catch { return false; }
}

/** Is the SDK's own "Continue" dialog on screen? (Its recovery when the browser refuses the window.) */
function sdkDialogOpen() {
  try {
    const host = document.querySelector('puter-dialog');
    if (!host) return false;
    const inner = host.shadowRoot?.querySelector('dialog');
    return inner ? inner.open : true;
  } catch { return false; }
}

/** Resolve true as soon as the SDK's dialog is showing, or false after `ms`. */
function waitForSdkDialog(ms) {
  if (typeof document === 'undefined') return Promise.resolve(false);
  return new Promise((resolve) => {
    const started = Date.now();
    const look = () => {
      if (sdkDialogOpen()) return resolve(true);
      if (Date.now() - started >= ms) return resolve(false);
      setTimeout(look, 100);
    };
    look();
  });
}

/** What went wrong inside the SDK's own sign-in, in our typed vocabulary. */
function signInFailure(err) {
  const s = String(err?.error?.code || err?.code || err?.message || err?.error || err || '').toLowerCase();
  if (/cancel|clos|dismiss|abort/.test(s)) return puterError('auth-cancelled', 'the Puter sign-in window was closed');
  if (/network|offline|fetch/.test(s)) return puterError('offline', 'could not reach Puter to sign in');
  return puterError('auth', 'could not sign in to Puter');
}

let signingIn = null;
let signingInSince = 0;
// A double-click joins the sign-in that is already open. A click after that starts a fresh one: if
// the SDK never reports that its window closed, joining forever would hand every later click the
// same dead promise and leave the visitor unable to sign in until they reload.
const SIGN_IN_JOIN_MS = 2000;
// No sign-in is waited on for ever.
const SIGN_IN_CEILING_MS = 3 * 60 * 1000;

/**
 * Open Puter's sign-in window and wait for the visitor to finish in it. Call it straight from a
 * click or keypress handler, with nothing awaited first, or the browser may refuse the window.
 * A second call within two seconds joins the first (a double-click); a later one starts again.
 *
 * Rejects with an Error carrying `.code`:
 *   'popup-blocked'  the browser refused to open the window (allow pop-ups, then try again)
 *   'auth-cancelled' the window was closed before sign-in finished
 *   'offline'        the SDK is not loaded, or Puter could not be reached
 *   'auth'           anything else
 */
export function startPuterSignIn({ onBlocked } = {}) {
  if (signingIn && Date.now() - signingInSince < SIGN_IN_JOIN_MS) return signingIn;
  if (!puterReady()) return Promise.reject(puterError('offline', 'the Puter SDK is not loaded yet'));

  // Watch window.open for the length of the call so a refused window is noticed immediately. The
  // wrapper changes nothing: it forwards the arguments and `this` and returns what open returned.
  const realOpen = window.open;
  let blocked = false;
  const watcher = function (...args) {
    const w = realOpen.apply(this, args);
    if (!w) blocked = true;
    return w;
  };
  window.open = watcher;
  const restore = () => { if (window.open === watcher) window.open = realOpen; };

  const popupBlocked = () => puterError('popup-blocked', 'the browser blocked the Puter sign-in window');
  const attempt = new Promise((resolve, reject) => {
    let sdkDialogShown = false;
    // Refused by the browser AND no dialog from the SDK: that is a dead end we must report.
    // Refused but the SDK is showing its own dialog: that is the SDK's recovery, so any failure
    // after it is the visitor choosing Cancel, not a blocked window.
    const failure = (err) => (blocked && !sdkDialogShown ? popupBlocked() : signInFailure(err));
    // The SDK opens its window straight away or not at all. After a short grace, stop watching.
    const grace = setTimeout(() => {
      restore();
      if (!blocked) return;
      // The browser refused the window. Puter's SDK has its own recovery for that — a dialog with a
      // Continue button, whose click is a real gesture and opens the window. If it shows one, leave
      // it to run (and tell the visitor what to click); if it does not, say so ourselves rather
      // than leave the visitor waiting for a window that cannot appear.
      waitForSdkDialog(1500).then((shown) => {
        if (shown) { sdkDialogShown = true; onBlocked?.(); }
        else settle(reject, popupBlocked());
      });
    }, 900);
    const ceiling = setTimeout(() => settle(reject, puterError('auth-cancelled', 'the Puter sign-in took too long')), SIGN_IN_CEILING_MS);
    const settle = (fn, value) => { clearTimeout(grace); clearTimeout(ceiling); restore(); fn(value); };
    try {
      Promise.resolve(window.puter.auth.signIn()).then(
        () => settle(resolve, true),
        (err) => settle(reject, failure(err)));
    } catch (err) {
      settle(reject, failure(err));
    }
  });
  signingIn = attempt;
  signingInSince = Date.now();
  const clear = () => { if (signingIn === attempt) signingIn = null; };
  attempt.then(clear, clear);
  return attempt;
}

/** Race `promise` against the caller's cancellation. */
function abortable(promise, signal) {
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const cancel = () => reject(puterError('cancelled', 'cancelled'));
    if (signal.aborted) return cancel();
    signal.addEventListener('abort', cancel, { once: true });
    promise.then(
      (v) => { signal.removeEventListener('abort', cancel); resolve(v); },
      (e) => { signal.removeEventListener('abort', cancel); reject(e); });
  });
}

/** Pull plain text out of whatever shape Puter returns. */
function extractText(r) {
  if (r == null) return '';
  if (typeof r === 'string') return r.trim();
  const msg = r.message ?? r;
  let c = msg?.content;
  if (c == null) c = (typeof r.text === 'string') ? r.text : undefined;
  if (Array.isArray(c)) {
    c = c.map((part) => typeof part === 'string' ? part : (part?.text ?? part?.content ?? '')).join('');
  }
  if (typeof c !== 'string') {
    // Last resort: a ChatResponse may stringify to its own text.
    const s = (typeof r.toString === 'function') ? r.toString() : '';
    c = (s && s !== '[object Object]') ? s : '';
  }
  return c.trim();
}

/** Classify a thrown Puter error into the shared typed-error vocabulary. */
function classify(err) {
  const raw = err?.message || err?.error?.message || err?.error || err;
  const s = String(raw || '').toLowerCase();
  const e = new Error(typeof raw === 'string' && raw ? raw : 'the Puter AI could not answer');
  e.detail = String(raw || '').slice(0, 200);
  if (/\b(limit|quota|insufficient|credit|usage|balance)\b/.test(s)) e.code = 'usage';
  else if (/auth[_ ]?(cancel|clos)/.test(String(err?.error?.code || err?.code || '').toLowerCase())) e.code = 'auth-cancelled';
  else if (/\b(sign|signin|auth|login|log ?in|permission|denied|unauthor|account|token)\b/.test(s)) e.code = 'auth';
  else if (/\b(network|offline|failed to fetch|fetch failed|connection)\b/.test(s)) e.code = 'offline';
  else e.code = 'unexpected-response';
  e.cause = err;
  return e;
}

/**
 * Ask Puter with conversation context — the mirror of askWithContext().
 *
 * @param {Array<{role:string,content:string}>} messages  system + recent turns
 * @param {object}       [opts]
 * @param {AbortSignal}  [opts.signal]    caller's cancellation
 * @param {(s:string)=>void} [opts.onStatus] progress for the UI
 * @param {number}       [opts.timeoutMs] override the request budget (tests)
 * @returns {Promise<{text:string}>}
 *
 * Throws an Error carrying `.code`, reusing pollinations.js's set
 * ('cancelled' | 'timeout' | 'offline' | 'empty-answer' | 'unexpected-response')
 * plus two Puter-only codes: 'auth' (not signed in) and 'usage' (free allowance
 * spent). describePuterFailure() turns any of them into a message.
 */
export async function askPuterWithContext(messages, { signal, onStatus, timeoutMs = PUTER_TIMEOUT_MS } = {}) {
  if (signal?.aborted) { const e = new Error('cancelled'); e.code = 'cancelled'; throw e; }

  onStatus?.('Connecting to Puter…');
  // Already loaded (the chat page preloads it when Puter is chosen)? Then await NOTHING before the
  // sign-in below: this call is still inside the keypress that sent the message, which is what
  // lets the browser open the Puter window.
  const puter = puterReady() ? window.puter : await ensurePuter();

  // Sign in as an explicit step, before the generation timer starts, so waiting for a person to
  // type a password never counts against the answer's time budget.
  if (puterSignInState() === 'signed-out') {
    onStatus?.('Waiting for you to sign in to Puter…');
    await abortable(startPuterSignIn({
      onBlocked: () => onStatus?.('Your browser blocked the sign-in window. Click “Continue” in the Puter dialog to open it.'),
    }), signal);
    if (puterSignInState() === 'signed-out') throw puterError('auth', 'not signed in to Puter');
  }

  // Combine the caller's cancellation with our own timeout into one signal, the
  // same shape pollinations.js uses, so cancellation and timeouts behave the same
  // on both providers.
  const controller = new AbortController();
  const onCallerAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) onCallerAbort();
    else signal.addEventListener('abort', onCallerAbort, { once: true });
  }
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);

  try {
    onStatus?.('Thinking…');
    // Array form: the 2nd positional arg is `testMode`, so options MUST be 3rd.
    // Passing options as the 2nd arg would be read as testMode and silently
    // ignore normalize/signal.
    const response = await puter.ai.chat(messages, false, { ...CHAT_OPTIONS, signal: controller.signal });

    const text = extractText(response);
    if (!text) { const e = new Error('the AI returned an empty answer'); e.code = 'empty-answer'; throw e; }
    return { text };
  } catch (err) {
    if (err?.code === 'empty-answer') throw err;
    if (timedOut) { const e = new Error(`the AI took longer than ${Math.round(timeoutMs / 1000)}s to answer`); e.code = 'timeout'; throw e; }
    if (controller.signal.aborted) { const e = new Error('cancelled'); e.code = 'cancelled'; throw e; }
    // An abort surfaced as a DOMException (numeric code) rather than our flags.
    if (err?.name === 'AbortError') { const e = new Error('cancelled'); e.code = 'cancelled'; throw e; }
    throw classify(err);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onCallerAbort);
  }
}

/**
 * What to tell a person, given a failure from askPuterWithContext().
 *
 * The two Puter-only codes get their own wording (they name an action the user
 * can take on THIS provider); everything else reuses the shared describeFailure
 * so a timeout or an offline reads identically on both providers.
 */
export function describePuterFailure(error) {
  switch (error?.code) {
    case 'auth':
      return 'Sign in to Puter first. Press “Sign in to Puter”: it opens a small Puter '
        + 'window where you can use an existing account or create a free one. Or switch '
        + 'to PolliChat, which needs no sign-in.';
    case 'popup-blocked':
      return 'Your browser blocked the Puter sign-in window. Allow pop-ups for this site '
        + '(look for the blocked-window icon in the address bar), then press “Sign in to '
        + 'Puter”. Or switch to PolliChat, which needs no sign-in.';
    case 'auth-cancelled':
      return 'The Puter sign-in window was closed before you finished. Press “Sign in to '
        + 'Puter” to try again, or switch to PolliChat, which needs no sign-in.';
    case 'usage':
      return 'Your Puter account has reached its free AI usage limit for now. Try again '
        + 'later, or switch to PolliChat.';
    default:
      return describeFailure(error);
  }
}
