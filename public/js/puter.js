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

/**
 * Resolve once `window.puter.ai.chat` is callable, injecting the SDK the first
 * time. Bounded: a script that never loads rejects as 'offline' rather than
 * leaving the caller hanging. Cached, so switching to Puter twice loads it once.
 */
export function ensurePuter({ timeoutMs = 15000 } = {}) {
  if (typeof window !== 'undefined' && window.puter?.ai?.chat) return Promise.resolve(window.puter);
  if (sdkPromise) return sdkPromise;

  sdkPromise = new Promise((resolve, reject) => {
    const fail = (msg) => {
      sdkPromise = null;                 // let a later attempt retry from scratch
      const e = new Error(msg);
      e.code = 'offline';
      reject(e);
    };
    let settled = false;
    const ready = () => {
      if (settled) return;
      settled = true; clearInterval(poll); clearTimeout(timer);
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
  const puter = await ensurePuter();

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
      return 'Puter needs you to sign in to its free account to use this AI. A sign-in '
        + 'window should open — allow it to continue. Or switch to PolliChat, which needs '
        + 'no sign-in, or open the Browser to use ChatGPT, Claude or another AI.';
    case 'usage':
      return 'Your Puter account has reached its free AI usage limit for now. Try again '
        + 'later, switch to PolliChat, or open the Browser to use another AI.';
    default:
      return describeFailure(error);
  }
}
