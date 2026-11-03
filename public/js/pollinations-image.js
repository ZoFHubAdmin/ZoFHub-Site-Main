// ZoFHub · pollinations-image.js — the /image command's client. Browser only.
// ---------------------------------------------------------------------------
// ONE image, requested by the visitor's browser, from ONE fixed URL:
//
//     https://image.pollinations.ai/<url-encoded prompt>
//
// The prompt goes after the final slash and nothing else is appended — exactly
// the shape text.pollinations.ai uses (see pollinations.js). No query string, no
// key, no model negotiation, no server of ours anywhere in the path. The picture
// is shown by a native <img> whose src is that URL, so the bytes travel from the
// provider straight to this browser and never through Express.
//
// VERIFIED AGAINST THE LIVE SERVICE, 2026-11-02 (not assumed):
//   GET https://image.pollinations.ai/a%20red%20apple          -> 200 image/jpeg
//   GET https://image.pollinations.ai/prompt/a%20red%20apple   -> 200 image/jpeg
// so the documented `/prompt/` segment is optional and the bare form works.
// Both success and failure responses carry `Access-Control-Allow-Origin: *`, and
// failures expose `Retry-After`, which is what makes diagnoseImageFailure() able
// to read WHY a picture did not arrive (see below).
//
// THE FREE-TIER LIMIT IS REAL, AND IT IS THE REASON FOR THE 45 s COOLDOWN.
//   HTTP 402  {"error":{"code":"FREE_LIMIT","message":"Free limit reached:
//             1 image every 45 seconds per IP. Retry after 41s, ..."}}
//   Retry-After: 41        Cache-Control: no-store
// The window starts when a request arrives, so ai-cooldown.js starts its 45 s
// wait when the request is SENT. It is per IP, not per visitor: on a shared
// school network another student's picture can use this one's allowance, which
// is why a failed load is diagnosed rather than reported as a bare "error".
//
// WHAT AN <img> CANNOT TELL YOU. A failed <img> fires one `error` event with no
// status, no headers and no body — a rate limit, an outage and a blocked network
// all look identical. So when a load fails, ONE extra GET to the same URL reads
// the status, Retry-After and JSON body (CORS permits it). If that GET happens
// to succeed, the bytes it downloaded are returned and shown rather than thrown
// away, because a generation already spent part of the visitor's allowance.
//
// WHAT THIS FILE NEVER DOES: relay through our server, hold a key, add a query
// string, or log a prompt. Whatever the provider does with the prompt is the
// provider's own business; the privacy policy says so in plain words.
// ---------------------------------------------------------------------------

import { fitToUrlBudget } from './pollinations.js?v=20261016';
import { IMAGE_COOLDOWN_MS } from './ai-cooldown.js?v=20261102';

/** The fixed destination. A prompt is appended to this and nothing else is. */
export const IMAGE_ENDPOINT = 'https://image.pollinations.ai/';
export const IMAGE_ORIGIN = 'https://image.pollinations.ai';

// How long a picture may take before it is abandoned. Free-tier generation is
// usually 5-30 s; this is a ceiling for a stall, not an expected duration.
export const IMAGE_TIMEOUT_MS = 90_000;
const DIAGNOSE_TIMEOUT_MS = 15_000;

// An image prompt is a short description, not an essay. Clipped by code points so
// an emoji is never cut in half (a lone surrogate makes encodeURIComponent throw).
export const MAX_IMAGE_PROMPT_CHARS = 600;
// Budget for the whole URL, endpoint included.
const MAX_IMAGE_URL_CHARS = 2000;

export const IMAGE_USAGE = 'Describe the picture after /image — for example: /image a red fox in a snowy forest';

const windowSeconds = () => Math.round(IMAGE_COOLDOWN_MS / 1000);

function coded(code, message, extra) {
  const e = new Error(message || code);
  e.code = code;
  return extra ? Object.assign(e, extra) : e;
}

/** Collapse whitespace and clip to the prompt budget. */
export function normalizeImagePrompt(text) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  return Array.from(flat).slice(0, MAX_IMAGE_PROMPT_CHARS).join('');
}

// `/image` then whitespace (or the end). `/imagine` and `/images` are NOT this
// command, and neither is a message that merely mentions it mid-sentence.
const IMAGE_COMMAND = /^\/image(?:\s+([\s\S]*))?$/i;

/**
 * Is this message an image request?
 * @returns {null | { prompt: string }}  null for ordinary text; `prompt` is ''
 *   when the command was typed with nothing after it (the caller shows usage).
 */
export function parseImageCommand(text) {
  const m = IMAGE_COMMAND.exec(String(text ?? '').trim());
  if (!m) return null;
  return { prompt: normalizeImagePrompt(m[1] ?? '') };
}

/**
 * The exact URL this module requests, for a given prompt.
 *
 * Exported because it is the piece worth asserting on in a test: the prompt lands
 * after the final slash, is encoded exactly once, and nothing a visitor can type
 * moves the request to another host, path or query.
 */
export function buildImageUrl(prompt) {
  const text = fitToUrlBudget(normalizeImagePrompt(prompt), MAX_IMAGE_URL_CHARS - IMAGE_ENDPOINT.length);
  if (!text) throw coded('empty-prompt', 'empty image prompt');
  const url = IMAGE_ENDPOINT + encodeURIComponent(text);
  const parsed = new URL(url);
  // Belt and braces. encodeURIComponent already makes the host and query
  // unreachable; this keeps them unreachable if the encoding is ever "simplified".
  // The pathname comparison also catches a prompt made only of dots: `..` is not
  // escaped by encodeURIComponent, and the URL parser would resolve it to the
  // site root, which is a landing page and not a picture.
  if (parsed.origin !== IMAGE_ORIGIN || parsed.search || parsed.hash
      || parsed.pathname !== '/' + encodeURIComponent(text)) {
    throw coded('empty-prompt', 'that prompt cannot be used as an image description');
  }
  return url;
}

/**
 * Load `url` into an <img> and resolve with that element once it has decoded.
 *
 * The resolved element is the one the caller should put on the page: handing back
 * the very element that finished loading means the visible picture never depends
 * on a second request or on the HTTP cache still holding the first one.
 *
 * Rejects with `.code`: 'cancelled' | 'timeout' | 'image-failed'.
 */
export function loadImage(url, { signal, timeoutMs = IMAGE_TIMEOUT_MS, createImage = () => new Image() } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(coded('cancelled', 'cancelled')); return; }
    const img = createImage();
    img.decoding = 'async';
    // Our page address is nobody's business but ours.
    img.referrerPolicy = 'no-referrer';

    let settled = false;
    let timer = null;
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      img.onload = img.onerror = null;
      signal?.removeEventListener('abort', onAbort);
      fn(arg);
    };
    // Dropping the src is what tells the browser to stop fetching a request that
    // is still in flight; it must only be done when we are giving up.
    const giveUp = () => { try { img.removeAttribute('src'); } catch { /* detached */ } };
    function onAbort() { giveUp(); finish(reject, coded('cancelled', 'cancelled')); }

    timer = setTimeout(() => {
      giveUp();
      finish(reject, coded('timeout', `the image took longer than ${Math.round(timeoutMs / 1000)}s to generate`));
    }, timeoutMs);
    img.onload = () => (img.naturalWidth > 0
      ? finish(resolve, img)
      : finish(reject, coded('image-failed', 'the image was empty')));
    img.onerror = () => finish(reject, coded('image-failed', 'the image did not load'));
    signal?.addEventListener('abort', onAbort, { once: true });
    img.src = url;
  });
}

/** Seconds a rate-limited response asks us to wait: header first, then the body. */
function retryAfterOf(res, parsed) {
  const header = parseInt(res?.headers?.get?.('retry-after'), 10);
  if (Number.isFinite(header) && header > 0) return Math.min(header, 120);
  const fromBody = /retry after (\d+)\s*s/i.exec(String(parsed?.error?.message || ''));
  if (fromBody) return Math.min(parseInt(fromBody[1], 10) || windowSeconds(), 120);
  return windowSeconds();
}

/**
 * A picture did not load. Find out why.
 *
 * One GET to the same URL, read through CORS. Resolves — it never throws:
 *   { ok: true,  blob }    the request worked this time; show these bytes
 *   { ok: false, error }   error.code is one of
 *       'rate-limited' (+ .retryAfter seconds)  402/429 or FREE_LIMIT
 *       'offline'      the request never got an answer (blocked or no network)
 *       'http'         any other status (+ .status)
 *       'unexpected-response'  a 200 that is not a picture
 *       'image-failed' the answer was a picture but could not be read
 *       'timeout' | 'cancelled'
 */
export async function diagnoseImageFailure(url, { signal, timeoutMs = DIAGNOSE_TIMEOUT_MS, fetchImpl = globalThis.fetch } = {}) {
  const controller = new AbortController();
  const onCallerAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', onCallerAbort, { once: true });
  }
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);

  const interrupted = (err) => {
    if (timedOut) return coded('timeout', 'the image service did not answer in time');
    if (controller.signal.aborted) return coded('cancelled', 'cancelled');
    return err;
  };

  try {
    let res;
    try {
      res = await fetchImpl(url, {
        method: 'GET', mode: 'cors', credentials: 'omit', redirect: 'follow',
        referrerPolicy: 'no-referrer', signal: controller.signal,
      });
    } catch (err) {
      return { ok: false, error: interrupted(coded('offline', 'could not reach the image service', { cause: err })) };
    }

    // A transport that hands back something that is not a Response is a broken
    // answer, not a crash: this function's contract is that it never throws.
    if (!res || !res.headers || typeof res.headers.get !== 'function') {
      return { ok: false, error: coded('unexpected-response', 'the image service returned something unreadable') };
    }
    const type = (res.headers.get('content-type') || '').toLowerCase();
    if (res.ok && type.startsWith('image/')) {
      try {
        const blob = await res.blob();
        if (blob.size > 0) return { ok: true, blob };
        return { ok: false, error: coded('image-failed', 'the image was empty') };
      } catch (err) {
        return { ok: false, error: interrupted(coded('image-failed', 'the image could not be read', { cause: err })) };
      }
    }

    let text = '';
    try { text = await res.text(); } catch { /* an unreadable body does not change the status */ }
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { /* not JSON */ }

    if (res.status === 402 || res.status === 429 || parsed?.error?.code === 'FREE_LIMIT') {
      return { ok: false, error: coded('rate-limited', 'image rate limit reached', {
        status: res.status, rateLimited: true, retryAfter: retryAfterOf(res, parsed),
      }) };
    }
    if (res.ok) return { ok: false, error: coded('unexpected-response', 'the image service returned something that is not a picture') };
    return { ok: false, error: coded('http', `the image service answered ${res.status}`, {
      status: res.status, detail: text.slice(0, 200),
    }) };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onCallerAbort);
  }
}

/**
 * What to tell a person, given a failure from loadImage() or diagnoseImageFailure().
 * Each message says what happened and whether trying again is worth it.
 */
export function describeImageFailure(error) {
  switch (error?.code) {
    case 'empty-prompt':
      return IMAGE_USAGE;
    case 'rate-limited': {
      const s = Number(error.retryAfter) > 0 ? Math.round(error.retryAfter) : 0;
      return `The free image service makes one picture every ${windowSeconds()} seconds for each network`
        + (s ? `, and it asked us to wait about ${s} more seconds.` : '.')
        + ' If other people on your network are using it, you may need to wait a little longer.';
    }
    case 'timeout':
      return 'The picture took too long to generate. The free service can be slow when it is busy — try again.';
    case 'offline':
      return 'Could not reach the image service. Check your connection — some networks block it — and try again.';
    case 'unexpected-response':
    case 'image-failed':
      return 'The image service did not send back a usable picture. Try again in a moment.';
    case 'http':
      return error.status >= 500
        ? `The image service is having trouble (error ${error.status}). Try again in a moment.`
        : `The image service refused the request (error ${error.status}).`;
    default:
      return 'That picture did not come through. Try again.';
  }
}
