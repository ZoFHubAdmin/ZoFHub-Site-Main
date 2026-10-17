import { SYSTEM_PROMPT } from './ai-prompt.js';
// ZoFHub · pollinations.js — THE ONE AI CLIENT.
// ---------------------------------------------------------------------------
// ONE request, made by the visitor's browser, to ONE fixed URL:
//
//     GET https://text.pollinations.ai/<url-encoded prompt>
//
// The body of that response IS the answer, as plain text. There is no API key,
// no login, no model negotiation, no streaming protocol, no provider choice and
// no server of ours anywhere in the path.
//
// ── WHY IT LOOKS LIKE THIS NOW ─────────────────────────────────────────────
// The previous version of this module tried THREE routes in sequence and made
// TWO extra round-trips before the first one could even start:
//
//   1. `await getPublishableKey()`  → a same-origin GET of our own
//      now-deleted AI key route                              ← OUR SERVER
//   2. `await freeModelName()`      → fetch('…/models')
//   3. attempt 1: POST /openai with `Content-Type: application/json`, which is
//      not a CORS-safelisted content type, so the browser first had to send a
//      preflight OPTIONS and wait for it.
//   4. attempt 2: the GET URL route — the one that actually works.
//   5. on localhost, attempt 0 was POST /api/ai/text — our own server relaying
//      the prompt to Pollinations.
//
// Route 5 existed because of a stated premise: that Pollinations' text endpoint
// fronts a Cloudflare Turnstile check keyed on Origin and rejects browser
// fetches from http/localhost. THAT PREMISE IS CORRECT, and it turns on the
// SPELLING of the host, which is easy to measure wrongly:
//
//     Origin: http://localhost:8080   -> 403 {"error":"Missing Turnstile token"}
//     Origin: http://127.0.0.1:8080   -> 200
//     Origin: https://<deployed site>  -> 200
//     (no Origin header at all)       -> 200
//
// So `localhost` is refused and `127.0.0.1` — the same server — is not. A first
// pass here claimed the premise "did not reproduce"; it had only been tested
// from 127.0.0.1, which is one of the allowed spellings.
//
// It still does not justify route 5. A server relay is what this architecture
// exists to remove, the condition is local-development-only (a deployed https
// origin is fine), and the trace showed route 5 HANGING anyway: POST
// /api/ai/text never answered inside 120s, and because it was attempt zero the
// request that works in under a second was never reached. The 403 is instead
// DETECTED and named — see the note in askAI() and describeFailure().
// Full detail: docs/features/AI-ARCHITECTURE.md section 1.
//
// Every one of those is a way for the request to fail or stall before reaching
// the endpoint, and the budgets made a stall expensive: CONNECT_MS 15s +
// FIRST_BYTE_MS 45s on the POST, then a 45s GET, plus backoff between them. A
// single message could therefore sit for well over a minute and still end up on
// route 4 — which is what "the AI doesn't answer" looked like from a chair.
//
// So routes 1, 2, 3 and 5 are gone. What is left is route 4, alone, with no
// preflight (a GET with no custom headers is a simple cross-origin request) and
// no same-origin hop to go wrong.
//
// ── THE ONE THING THIS DEPENDS ON ──────────────────────────────────────────
// A cross-origin `fetch` can only READ a response the other origin permits.
// Verified against the live endpoint on 2026-10-15 with a browser-shaped
// request carrying a production `Origin` header (an https site, not localhost):
//
//     HTTP/1.1 200 OK
//     Content-Type: text/plain; charset=utf-8
//     Access-Control-Allow-Origin: *          ← this is the part that matters
//     Access-Control-Allow-Methods: GET, POST, OPTIONS
//
// `Access-Control-Allow-Origin: *` is what makes the body readable from a page.
// Without it the browser would hand us an opaque response and no amount of
// client code would help — `mode: 'no-cors'` is deliberately NOT used, because
// an opaque response cannot be read and would only hide the failure.
// ---------------------------------------------------------------------------

/**
 * The fixed destination. A prompt is appended to this and nothing else is.
 *
 * Kept as a module constant and re-checked in buildPromptUrl() so that no
 * prompt, however hostile, can move the request to another host: `new URL()`
 * resolves the result and the origin is compared before the URL is returned.
 */
export const ENDPOINT = 'https://text.pollinations.ai/';
const ENDPOINT_ORIGIN = 'https://text.pollinations.ai';

// How long one request may take before it is abandoned. A single bound, not a
// chain of them: there is only one request now, so a failure is a failure in
// ~60s instead of after a sequence of nested budgets.
//
// 60s is a CEILING, not a measurement. Generation on the free tier is routinely
// tens of seconds, and the GET route returns the whole answer at once rather
// than streaming a first token, so a budget that merely covered a typical reply
// would abort working requests — which is the specific bug this module used to
// have.
export const TIMEOUT_MS = 60000;

// The longest URL we will build, in characters. Browsers tolerate far more, but
// intermediaries do not: 8KB is a common server and CDN limit for a whole
// request line. 6000 leaves room for that limit and for the endpoint prefix.
const MAX_URL_CHARS = 6000;

// How much conversation to carry. The prompt travels in the URL, so context is
// a budget rather than a free parameter — see composePrompt().
const MAX_HISTORY_TURNS = 8;
const MAX_MESSAGE_CHARS = 4000;

/** Reasoning models occasionally leak a <think> block into the body — drop it. */
const stripThinking = (s) =>
  String(s || '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();

/**
 * Cut `text` down until its percent-encoded form fits the URL budget.
 *
 * Slicing is done over CODE POINTS, not UTF-16 units. `String.prototype.slice`
 * can cut an emoji in half and leave a lone surrogate, and encodeURIComponent
 * throws URIError on a lone surrogate — so a naive trim turns a long prompt
 * containing an emoji into a crash instead of a short prompt.
 */
export function fitToUrlBudget(text, budget = MAX_URL_CHARS - ENDPOINT.length) {
  const chars = Array.from(String(text ?? ''));
  if (!chars.length) return '';
  let lo = 0, hi = chars.length;
  // The encoded length grows monotonically with the number of code points kept,
  // so the largest prefix that fits is a binary search rather than a loop that
  // shaves a percentage at a time.
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (encodeURIComponent(chars.slice(0, mid).join('')).length <= budget) lo = mid;
    else hi = mid - 1;
  }
  return chars.slice(0, lo).join('');
}

/**
 * The exact URL this module requests, for a given prompt.
 *
 * Exported because it is the one piece of this file worth asserting on in a
 * test: that the prompt lands after the final slash, encoded exactly once, and
 * that nothing a user can type changes the destination.
 */
export function buildPromptUrl(prompt) {
  const text = fitToUrlBudget(String(prompt ?? '').trim());
  if (!text) {
    const e = new Error('empty-prompt');
    e.code = 'empty-prompt';
    throw e;
  }
  // encodeURIComponent, once. It escapes '/', '?', '#' and '&', so the prompt
  // cannot add a path segment, a query string or a fragment; and it leaves the
  // unreserved set (A-Z a-z 0-9 - _ . ! ~ * ' ( )) alone, which is legal in a
  // path segment and keeps ordinary prose readable in a network log.
  const url = ENDPOINT + encodeURIComponent(text);
  // Belt and braces: resolve what we built and refuse it if the origin moved.
  // encodeURIComponent already makes this unreachable; the check is here so it
  // STAYS unreachable if someone later "simplifies" the encoding away.
  if (new URL(url).origin !== ENDPOINT_ORIGIN) {
    throw new Error('refusing to send a prompt to an unexpected origin');
  }
  return url;
}

/**
 * Flatten a chat into the single string that goes in the URL.
 *
 * The URL API takes one prompt, not a messages array, so the system prompt and
 * the recent turns are folded into it. Roles are spelled out as "User:" /
 * "Assistant:" because that is the only way a flat prompt can express them.
 */
export function composePrompt(messages) {
  const list = Array.isArray(messages) ? messages : [];
  const system = list.find((m) => m && m.role === 'system')?.content || SYSTEM_PROMPT;
  const turns = list
    .filter((m) => m && m.role !== 'system' && m.content)
    .slice(-MAX_HISTORY_TURNS)
    .map((m) => `${m.role === 'assistant' ? 'Assistant' : 'User'}: ${String(m.content).slice(0, MAX_MESSAGE_CHARS)}`);
  // Trailing "Assistant:" so the model continues the transcript rather than
  // commenting on it.
  return [system, '', ...turns, 'Assistant:'].join('\n');
}

/** Seconds the endpoint asked us to wait, or 0 when it did not say. */
function retryAfterOf(response) {
  const raw = parseInt(response?.headers?.get?.('retry-after'), 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 0;
}

/**
 * Read the answer out of a response.
 *
 * The documented behaviour of this endpoint is `text/plain`, and that is what
 * it returned when probed, so `response.text()` is the primary path and plain
 * text is NEVER run through JSON.parse. The JSON branch exists only because the
 * same endpoint answers in OpenAI's envelope when it feels like it (a cached
 * entry, an error object); it is entered on the content type, not on a guess.
 */
async function readAnswer(response) {
  const body = await response.text();
  const contentType = (response.headers.get('content-type') || '').toLowerCase();
  if (contentType.includes('application/json')) {
    try {
      const parsed = JSON.parse(body);
      const fromEnvelope =
        parsed?.choices?.[0]?.message?.content ??
        parsed?.choices?.[0]?.text ??
        null;
      if (typeof fromEnvelope === 'string' && fromEnvelope.trim()) {
        return stripThinking(fromEnvelope);
      }
      // JSON that is not a completion is an error object, not an answer. Saying
      // so beats rendering "[object Object]" as the assistant's reply.
      const message = parsed?.error?.message || parsed?.error || parsed?.message;
      const e = new Error(typeof message === 'string' && message ? message : 'unexpected-response');
      e.code = 'unexpected-response';
      throw e;
    } catch (err) {
      if (err?.code === 'unexpected-response') throw err;
      // Content-Type lied about being JSON — fall through and use the text.
    }
  }
  return stripThinking(body);
}

/**
 * Ask Pollinations, directly from this browser, and return the text.
 *
 * @param {string} prompt            the text to put after the final slash
 * @param {object} [opts]
 * @param {AbortSignal} [opts.signal] caller's cancellation (navigating away, a
 *                                    newer message superseding this one)
 * @param {(s: string) => void} [opts.onStatus] progress for the UI
 * @param {number} [opts.timeoutMs]  override the request budget. Exists so the
 *                                   timeout path is testable in milliseconds
 *                                   instead of by waiting a minute; no caller
 *                                   in the app passes it.
 * @returns {Promise<string>} the generated text
 *
 * Throws an Error carrying, where applicable:
 *   .code        'empty-prompt' | 'empty-answer' | 'unexpected-response' |
 *                'timeout' | 'cancelled' | 'offline' | 'http'
 *   .status      the HTTP status, for an http failure
 *   .rateLimited true on 429
 *   .retryAfter  seconds to wait, when the endpoint said or 429 implies it
 */
export async function askAI(prompt, { signal, onStatus, timeoutMs = TIMEOUT_MS } = {}) {
  const url = buildPromptUrl(prompt);
  onStatus?.('Thinking…');

  // Our timeout and the caller's cancellation both have to be able to abort the
  // same fetch, so they are combined into one controller. (AbortSignal.any()
  // would do this natively but is too new to rely on in every browser we serve.)
  const controller = new AbortController();
  const onCallerAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) onCallerAbort();
    else signal.addEventListener('abort', onCallerAbort, { once: true });
  }
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);

  try {
    // Already cancelled before we started: there is nothing to ask for, and a
    // real fetch would only reject on the same signal a moment later.
    if (controller.signal.aborted) {
      const e = new Error('cancelled');
      e.code = 'cancelled';
      throw e;
    }
    let response;
    try {
      // A plain GET with no custom headers: a "simple" cross-origin request, so
      // the browser sends it straight out with no preflight to wait on.
      response = await fetch(url, {
        method: 'GET',
        // 'cors' is explicit on purpose. It is the default, but the one thing
        // that must never be set here is 'no-cors', which would make the body
        // unreadable and turn a visible failure into a silent blank reply.
        mode: 'cors',
        credentials: 'omit',
        redirect: 'follow',
        cache: 'no-store',
        signal: controller.signal,
      });
    } catch (err) {
      if (timedOut) {
        const e = new Error(`the AI took longer than ${Math.round(timeoutMs / 1000)}s to answer`);
        e.code = 'timeout';
        throw e;
      }
      if (controller.signal.aborted) {
        const e = new Error('cancelled');
        e.code = 'cancelled';
        throw e;
      }
      // fetch rejects on DNS failure, no route, TLS failure, a blocked request
      // and anything else that stopped it leaving the machine. From here they
      // are indistinguishable, and the honest message is the general one.
      const e = new Error('could not reach the AI service');
      e.code = 'offline';
      e.cause = err;
      throw e;
    }

    if (!response.ok) {
      // Read the body on a failure: this endpoint explains itself there, and the
      // explanation is the difference between an actionable message and "403".
      const detail = await response.text().catch(() => '');
      const e = new Error(`the AI service answered ${response.status}`);
      e.code = 'http';
      e.status = response.status;
      e.detail = detail.slice(0, 200);
      if (response.status === 429) {
        e.rateLimited = true;
        // The free tier documents roughly one request per 15s, so 15 is the
        // honest default when no Retry-After header came back.
        e.retryAfter = retryAfterOf(response) || 15;
      }
      // ORIGIN GATING. The endpoint fronts a Cloudflare Turnstile check keyed on
      // the Origin header and refuses `http://localhost:*` with
      // `403 {"error":"Missing Turnstile token"}`. MEASURED, same prompt, same
      // second:
      //
      //     Origin: http://localhost:8080   -> 403 Missing Turnstile token
      //     Origin: http://127.0.0.1:8080   -> 200
      //     Origin: https://<deployed site>  -> 200
      //     (no Origin header at all)       -> 200
      //
      // So this is a LOCAL-DEVELOPMENT condition only, and it turns on the
      // spelling of the host rather than on anything about the request. There
      // is no client-side workaround: a browser always sends Origin on a
      // cross-origin request, and `no-cors` would make the answer unreadable.
      // Proxying it through our server is what this architecture exists to
      // avoid. So the honest fix is to NAME it, which describeFailure() does.
      if (response.status === 403 && /turnstile/i.test(detail)) {
        e.code = 'origin-blocked';
      }
      throw e;
    }

    // The body read can be interrupted too — the endpoint sends headers first
    // and can then stall mid-answer. Without this, a timeout at that moment
    // escaped as a bare AbortError with no `.code`, and the UI fell back to the
    // generic "that didn't come through" instead of saying it timed out. Every
    // failure out of this function carries a `.code`.
    let text;
    try {
      text = await readAnswer(response);
    } catch (err) {
      // `typeof === 'string'`, not just truthy: a DOMException carries a
      // NUMERIC .code (AbortError is 20), so a truthy test rethrew the raw
      // abort as "already classified" and the timeout below never ran.
      if (typeof err?.code === 'string') throw err;    // already classified
      if (timedOut) {
        const e = new Error(`the AI took longer than ${Math.round(timeoutMs / 1000)}s to answer`);
        e.code = 'timeout';
        throw e;
      }
      if (controller.signal.aborted) {
        const e = new Error('cancelled');
        e.code = 'cancelled';
        throw e;
      }
      const e = new Error('the AI answer could not be read');
      e.code = 'unexpected-response';
      e.cause = err;
      throw e;
    }
    if (!text) {
      const e = new Error('the AI returned an empty answer');
      e.code = 'empty-answer';
      throw e;
    }
    return text;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onCallerAbort);
  }
}

/**
 * What to tell a person, given a failure from askAI().
 *
 * Lives here, beside the code that assigns the `.code` values, because both
 * entry points need it and two copies drifted immediately: the floating
 * assistant used to answer a 503 with "ask once more and it will", which is
 * advice, and wrong. Each message names what happened and implies whether
 * retrying is worth it.
 */
export function describeFailure(error) {
  switch (error?.code) {
    case 'origin-blocked': {
      // Only reachable in local development (see the note in askAI). The message
      // names the exact fix rather than describing the mechanism, because the
      // one action that works is changing the address in the address bar.
      const port = (typeof location !== 'undefined' && location.port) ? `:${location.port}` : '';
      const onLocalhost = typeof location !== 'undefined'
        && /^(localhost|\[::1\])$/i.test(location.hostname || '');
      return onLocalhost
        ? `The AI provider does not accept requests from "localhost". Open the site at `
          + `http://127.0.0.1${port} instead — the same server, a spelling the provider allows. `
          + `This affects local development only; a deployed https site works.`
        : 'The AI provider refused the origin this page is served from. The AI works on '
          + 'the deployed https site, or via http://127.0.0.1 in local development.';
    }
    case 'timeout':
      return 'The AI did not answer in time. The free tier can be slow when it is busy — try again.';
    case 'offline':
      return 'Could not reach the AI service. Check your connection and try again.';
    case 'empty-answer':
      return 'The AI sent back an empty answer. Try rephrasing your message.';
    case 'unexpected-response':
      return 'The AI service returned something unexpected. Try again in a moment.';
    case 'empty-prompt':
      return 'Type a message first.';
    case 'http':
      if (error.status === 429) {
        return 'The free AI is rate-limited right now. Wait a few seconds and try again.';
      }
      // 404 needs its own wording, from a MEASURED surprise: two requests sent
      // back to back (the /ai page, then the floating assistant) got 200 and
      // then 404 — and the identical second request returned 200 when spaced
      // out. So this endpoint can express throttling as a 404, not only a 429.
      //
      // The message therefore advises waiting, which is what actually works,
      // without ASSERTING a rate limit: a real 404 (the endpoint moving) is
      // indistinguishable from here, and `rateLimited` is deliberately not set,
      // so this never starts a countdown on a guess.
      if (error.status === 404) {
        return 'The AI service did not accept that request. This usually means too many '
          + 'requests in a short time — wait a few seconds and try again.';
      }
      return error.status >= 500
        ? `The AI service is having trouble (error ${error.status}). Try again in a moment.`
        : `The AI service refused the request (error ${error.status}).`;
    default:
      return 'That reply did not come through. Try sending it again.';
  }
}

/**
 * Ask with conversation context — the entry point the chat UIs use.
 *
 * @returns {Promise<{ text: string }>}
 */
export async function askWithContext(messages, opts) {
  const text = await askAI(composePrompt(messages), opts);
  return { text };
}

/**
 * Ask a single standalone question, with the site's system prompt applied.
 *
 * @returns {Promise<{ text: string }>}
 */
export async function askPrompt(prompt, opts) {
  return askWithContext(
    [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: String(prompt ?? '') }],
    opts,
  );
}

// ── WHAT IS DELIBERATELY NOT HERE ──────────────────────────────────────────
// · No AI IMAGE GENERATION. It is not a feature of this site. There is no
//   image.pollinations.ai URL builder, no /image command, no server route and
//   no image model lookup. (Ordinary site images — thumbnails, the preroll,
//   every other <img> — were never this and are untouched.)
// · No API KEY of any kind. The anonymous tier needs none. The current
//   documented API (gen.pollinations.ai) requires `Authorization: Bearer sk_…`,
//   and an sk_ key is a SERVER secret that may never be shipped to a browser,
//   so that endpoint cannot be used from a page at all without either leaking
//   the secret or proxying every prompt through our server. Both are refused.
//   The legacy publishable `pk_` key is also gone: it bought a higher rate limit
//   at the cost of a same-origin round-trip to our own server on the AI path
//   before any prompt could be sent, and the
//   docs say not to mint new ones.
// · No SERVER FALLBACK. /api/ai/text and /api/ai/echo have been removed from
//   server.js. There is no same-origin route left that would take a prompt.
// · No LOCAL INFERENCE ENGINE. The Transformers.js + SmolLM2 fallback is gone:
//   it downloaded a few hundred megabytes to answer, in a visibly worse voice,
//   a question the user had asked the real model. A clear error beats a bad
//   answer presented as a good one.
// · No OTHER PROVIDER. Hugging Face and Puter.js are gone, with their settings
//   UI and their stored tokens.
