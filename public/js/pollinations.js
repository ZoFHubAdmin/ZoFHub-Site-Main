import { SYSTEM_PROMPT } from './ai-prompt.js';
// ZoFHub · pollinations.js — THE ONE AI CLIENT. Text only, keyless, free tier.
// ---------------------------------------------------------------------------
// Every AI entry point on the site goes through this module: the /ai page
// (public/js/ai.js) and the floating assistant (public/js/ai-helper.js). There
// is deliberately no second implementation — the Hugging Face and Puter.js
// providers, and AI image generation, were all removed.
//
// The prompt the user types is sent to a Pollinations WEB URL directly from the
// visitor's browser, and the answer comes back on their end. NO API key, NO
// login, NO pollen — using the endpoint that is still free & keyless:
//   • Text:  GET/POST  https://text.pollinations.ai/…
//
// The CURRENT documented API (gen.pollinations.ai/v1/chat/completions) requires
// `Authorization: Bearer sk_…`, and an sk_ key is a server secret that must
// never reach a browser bundle — so it is deliberately not used. The full
// evidence, including what was probed and when, is in the note by
// freeTextModels() at the bottom of this file.
//
// One caveat we can't change: Pollinations' TEXT endpoint blocks BROWSER fetches
// from http/localhost origins with a Cloudflare "Turnstile" 403 (it keys on the
// Origin header). On a real https domain the keyless text URL works fine; on
// localhost during development it doesn't, so there we fall back to this app's
// own /api/ai/text (DEV ONLY — IS_LOCAL is false on https, and the server route
// answers 403 in production, so a visitor's prompt is never relayed through us).
// If every network route fails, ai.js finishes with an on-device model, so the
// chat is never fully dead.
// ---------------------------------------------------------------------------

const REFERRER = (typeof location !== 'undefined' && location.hostname) || 'zofhub';

// Turnstile blocks browser TEXT fetches from http/localhost — detect that so we
// can use the dev server hop there. Real https prod → keyless browser-direct.
// Exported so ai.js gates its image fallback on exactly the same condition —
// two copies of this rule would eventually disagree, and the one that drifts
// would silently start sending AI traffic through our server.
export const IS_LOCAL = typeof location !== 'undefined' && (
  location.protocol !== 'https:' ||
  /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|::1)$/i.test(location.hostname || '')
);

const TEXT_POST = 'https://text.pollinations.ai/openai'; // OpenAI-compatible, streams
const TEXT_GET  = 'https://text.pollinations.ai/';       // simple URL API: /<prompt>

// The default, and the fallback when model discovery is unavailable. Verified
// `tier:"anonymous"` on the live /models endpoint — see the note by
// freeTextModels() below for why that field is what the free-only policy rests on.
const MODEL     = 'openai-fast'; // keyless text model (GPT-OSS 20B reasoning)
const REASONING = 'low';         // reasoning_effort:'low' → fast first token
// Shared with ai.js and server.js — see public/js/ai-prompt.js. The three copies
// that used to live here each said only "friendly, concise assistant" and never
// forbade inventing facts, which is what produced the fabricated game histories.
const SYSTEM    = SYSTEM_PROMPT;

// ── THESE NUMBERS WERE MEASURED, NOT CHOSEN ───────────────────────────────
// FIRST_BYTE_MS was 25000, and that was the bug behind "sometimes the AI just
// doesn't answer". Twelve sequential completions against the real endpoint from
// a production origin produced a time-to-first-CONTENT-token of 16.0s, 26.3s,
// 27.2s and 27.3s — a median of ~26.6s, sitting just ABOVE the old 25s budget.
// The client was aborting working requests roughly a second before the model
// spoke, then falling through to the slow GET route, so the user waited ~32s
// for an answer the fast path already had.
//
// 45s is chosen to clear the observed p95 (27.3s) with real headroom for a
// slower network, while staying under GET_MS so a hung stream still leaves time
// for the fallback to run inside one send. Raising it does NOT make failures
// slower in practice: a genuinely dead request fails on CONNECT or on the idle
// timer, both of which are unchanged.
const CONNECT_MS = 15000, FIRST_BYTE_MS = 45000, IDLE_MS = 20000, GET_MS = 45000;

const clean = (s) => String(s || '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function timed(ms) {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), ms);
  return { signal: ctrl.signal, clear: () => clearTimeout(id) };
}

// How many seconds to wait after a 429, from the upstream Retry-After header when
// present (0 = not given, so the caller uses its own sensible default).
function retryAfterOf(r) {
  const ra = parseInt(r?.headers?.get?.('retry-after'), 10);
  return Number.isFinite(ra) && ra > 0 ? ra : 0;
}

// ── Optional publishable Pollinations key (pk_) ─────────────────────────────
// Lifts the anonymous per-IP rate limit when POLLINATIONS_PUBLIC_KEY is set in
// .env (served, tokenised, by /api/ai/key — a pk_ key is designed to be public).
// Fetched ONCE, cached, bounded; stays '' (fully keyless) if unset/unreachable,
// so the free path is never broken. Passed as `token` (body/query) — not an
// Authorization header — to avoid a CORS preflight on the cross-origin call.
let _keyPromise = null;
function getPublishableKey() {
  if (_keyPromise) return _keyPromise;
  _keyPromise = (async () => {
    try {
      const t = timed(2500);
      const r = await fetch('/api/ai/key', { signal: t.signal }).finally(() => t.clear());
      if (!r.ok) return '';
      const d = await r.json();
      return (d && typeof d.key === 'string' && d.key.startsWith('pk_')) ? d.key : '';
    } catch { return ''; }
  })();
  return _keyPromise;
}
// Warm the cache at load so the first message never waits on this round-trip.
getPublishableKey();

function salvage(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  try { const j = JSON.parse(s); return clean(j?.choices?.[0]?.message?.content || j?.choices?.[0]?.text || ''); } catch {}
  if (!s.startsWith('{') && !s.startsWith('data:')) return clean(s);
  return '';
}

// Flatten messages[] into one prompt string for the GET URL route (prompt in path).
function flatten(messages) {
  const sys = messages.find(m => m.role === 'system')?.content || SYSTEM;
  const convo = messages.filter(m => m.role !== 'system')
    .map(m => (m.role === 'assistant' ? 'Assistant: ' : 'User: ') + String(m.content || ''))
    .join('\n');
  return (sys + '\n\n' + convo + '\nAssistant:').slice(-1500);
}

// Shared SSE reader for the streaming POST; arm(ms) re-arms idle-abort per chunk.
async function consumeSSE(r, arm, { onToken, onStatus } = {}) {
  if (!r.body || !r.body.getReader) throw new Error('no-stream');
  arm(FIRST_BYTE_MS);
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let full = '', raw = '', buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    arm(IDLE_MS);
    const chunk = dec.decode(value, { stream: true });
    raw += chunk; buf += chunk;
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      const t = line.trim();
      if (!t || t.startsWith(':') || !t.startsWith('data:')) continue;
      const pl = t.slice(5).trim();
      if (pl === '[DONE]') continue;
      try {
        const j = JSON.parse(pl);
        const choice = j?.choices?.[0] || {};
        const delta = choice.delta?.content ?? choice.text ?? '';
        if (delta) { full += delta; onToken?.(clean(full)); }
        else if (!full && choice.delta?.reasoning) onStatus?.('Thinking…');
      } catch { /* JSON split across chunks — finishes next read */ }
    }
  }
  full = clean(full);
  if (full) return full;
  const fromRaw = salvage(raw);
  if (fromRaw) { onToken?.(fromRaw); return fromRaw; }
  throw new Error('empty');
}

// Streaming: browser → text.pollinations.ai/openai (keyless), token by token.
async function textDirectStream(messages, { onToken, onStatus } = {}) {
  const key = await getPublishableKey();
  const model = await freeModelName();          // free-only, discovered
  const postUrl = TEXT_POST + (key ? `?token=${encodeURIComponent(key)}&referrer=${encodeURIComponent(REFERRER)}` : '');
  const ctrl = new AbortController();
  let timer = setTimeout(() => ctrl.abort(), CONNECT_MS);
  const arm = (ms) => { clearTimeout(timer); timer = setTimeout(() => ctrl.abort(), ms); };
  try {
    const r = await fetch(postUrl, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages, referrer: REFERRER, private: true, stream: true, reasoning_effort: REASONING, ...(key ? { token: key } : {}) }),
      signal: ctrl.signal,
    });
    if (!r.ok) { const e = new Error('http ' + r.status); e.status = r.status; if (r.status === 429) e.retryAfter = retryAfterOf(r); throw e; }
    return await consumeSSE(r, arm, { onToken, onStatus });
  } finally { clearTimeout(timer); }
}

// The simple "web URL" method: GET text.pollinations.ai/<prompt> (keyless).
async function textDirectGet(messages, { onToken, onStatus } = {}) {
  onStatus?.('Thinking…');
  const key = await getPublishableKey();
  const model = await freeModelName();          // free-only, discovered
  // encodeURIComponent on the prompt: the user's text is a PATH SEGMENT here, so
  // spaces, punctuation, '#', '?' and non-ASCII must all be escaped or the URL
  // silently means something else.
  const url = TEXT_GET + encodeURIComponent(flatten(messages))
    + `?model=${encodeURIComponent(model)}&reasoning_effort=${REASONING}&referrer=${encodeURIComponent(REFERRER)}&private=true`
    + (key ? `&token=${encodeURIComponent(key)}` : '');
  const t = timed(GET_MS);
  try {
    const r = await fetch(url, { signal: t.signal });
    if (!r.ok) { const e = new Error('http ' + r.status); e.status = r.status; if (r.status === 429) e.retryAfter = retryAfterOf(r); throw e; }
    const ct = r.headers.get('content-type') || '';
    let txt = ct.includes('application/json') ? (await r.json())?.choices?.[0]?.message?.content || '' : await r.text();
    txt = clean(salvage(txt) || txt);
    if (!txt) throw new Error('empty');
    onToken?.(txt);
    return txt;
  } finally { t.clear(); }
}

// LOCAL-DEV ONLY — our own server (no Origin, so no Turnstile). Never used in
// production (IS_LOCAL is false on https), so no AI ever runs on the server there.
async function textViaServer(messages, { onToken, onStatus } = {}) {
  onStatus?.('Thinking… (local dev)');
  const t = timed(GET_MS);
  try {
    const r = await fetch('/api/ai/text', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages }), signal: t.signal,
    });
    if (!r.ok) { const e = new Error('http ' + r.status); e.status = r.status; if (r.status === 429) e.retryAfter = retryAfterOf(r); throw e; }
    const data = await r.json().catch(() => ({}));
    const txt = clean(data?.reply || '');
    if (!txt) throw new Error(data?.error || 'empty');
    onToken?.(txt);
    return txt;
  } finally { t.clear(); }
}

const backoff = (err) => sleep(err?.status === 429 ? 3500 : 1500);

async function runAttempts(attempts, onStatus) {
  let lastErr, sawRateLimit = false, retryAfter = 0;
  for (let i = 0; i < attempts.length; i++) {
    try {
      onStatus?.(i === 0 ? 'Thinking…' : 'Still working…');
      const text = await attempts[i].run();
      if (text) return { text, route: attempts[i].route };
    } catch (e) {
      lastErr = e;
      if (e?.status === 429) { sawRateLimit = true; retryAfter = Math.max(retryAfter, e.retryAfter || 0); }
      console.warn(`[ai] attempt ${i + 1} (${attempts[i].route}) failed:`, e?.status || '', e?.message || e);
      if (i < attempts.length - 1) await backoff(e);
    }
  }
  // Surface a TYPED failure so callers can tell a genuine rate-limit (429) apart
  // from offline / other breakage and react differently (styled limit notice vs.
  // the on-device fallback). retryAfter falls back to ~15s (the documented keyless
  // ~1 req/15s window) when the upstream didn't send a Retry-After header.
  const err = new Error(sawRateLimit ? 'rate-limited' : ('all-ai-routes-failed: ' + (lastErr?.message || 'unknown')));
  err.rateLimited = sawRateLimit;
  err.retryAfter = retryAfter || (sawRateLimit ? 15 : 0);
  err.status = lastErr?.status;
  throw err;
}

// Keyless browser-direct to text.pollinations.ai. Streaming first (best for long
// answers), then the simple GET URL. On localhost, Turnstile blocks those, so try
// the dev server first. In production it's pure browser-direct — no server.
function buildAttempts(messages, cbs) {
  const attempts = [];
  if (IS_LOCAL) attempts.push({ route: 'server-dev', run: () => textViaServer(messages, cbs) });
  attempts.push(
    { route: 'direct-stream', run: () => textDirectStream(messages, cbs) },
    { route: 'direct-get',    run: () => textDirectGet(messages, cbs) },
  );
  return attempts;
}

export async function pollTextStream(messages, { onToken, onStatus } = {}) {
  return runAttempts(buildAttempts(messages, { onToken, onStatus }), onStatus);
}
export async function pollText(messages, { onStatus } = {}) {
  const { text } = await runAttempts(buildAttempts(messages, { onStatus }), onStatus);
  return { text, route: 'direct' };
}
export async function pollTextPrompt(prompt, opts) {
  return pollText([{ role: 'system', content: SYSTEM }, { role: 'user', content: String(prompt).slice(0, 4000) }], opts);
}
export async function pollTextPromptStream(prompt, opts) {
  return pollTextStream([{ role: 'system', content: SYSTEM }, { role: 'user', content: String(prompt).slice(0, 4000) }], opts);
}

// ── AI IMAGE GENERATION WAS REMOVED ────────────────────────────────────────
// pollImageUrl() and pollImageShieldUrl() used to build image.pollinations.ai
// URLs for an <img src>. AI image generation is no longer a product feature, so
// they are gone along with the /image command, the server's /api/ai/image route
// and the image-model discovery. Ordinary site images are unaffected: they were
// never generated.

// ── FREE-ONLY MODEL DISCOVERY ──────────────────────────────────────────────
// VERIFIED AGAINST THE LIVE API (2026-10-15), because the documentation and the
// deployed service disagree and the difference decides whether this feature can
// exist at all:
//
//   · The CURRENT documented API is POST https://gen.pollinations.ai/v1/chat/
//     completions with `Authorization: Bearer <sk_…>`. Its own docs say "All
//     generation requests require an API key". An sk_ key is a SERVER secret and
//     may never be shipped in a browser bundle, so this endpoint is deliberately
//     NOT used — there is no way to call it from a page without either leaking a
//     secret or proxying every prompt through our server.
//   · Legacy `pk_` publishable keys still exist but the docs say "Do not mint
//     new ones", and they are capped at 1 pollen per IP per hour.
//   · The ANONYMOUS tier on text.pollinations.ai is still live and keyless. All
//     three of these returned 200 from a browser-like request with a production
//     Origin header: GET /<prompt>, POST /openai, and GET /models.
//
// So: the anonymous tier is the only genuinely free, browser-direct, no-secret
// option, and it is what this module uses.
//
// /models returns a `tier` field per model — currently a single entry,
// `{"name":"openai-fast", "tier":"anonymous", …}`. That field is the evidence
// the free-only policy needs, so eligibility is DISCOVERED rather than assumed:
// a model counts as free only when its tier is explicitly one of FREE_TIERS and
// it actually outputs text. An unknown tier stays DISABLED — "we could not
// establish that this is free" must never render as "Free".
const MODELS_URL = 'https://text.pollinations.ai/models';
const FREE_TIERS = new Set(['anonymous']);
const MODELS_TTL_MS = 30 * 60 * 1000;

/** Is this /models entry a model we may use on the free tier? */
export function isFreeTextModel(m) {
  if (!m || typeof m !== 'object') return false;
  if (typeof m.name !== 'string' || !m.name) return false;
  // An explicitly known-free tier, and nothing else. A missing or unrecognised
  // tier is "unknown cost", which is not the same as free.
  if (!FREE_TIERS.has(String(m.tier || '').toLowerCase())) return false;
  // Text in, text out. `output_modalities` is authoritative when present.
  const out = Array.isArray(m.output_modalities) ? m.output_modalities.map(String) : null;
  if (out && !out.includes('text')) return false;
  const inp = Array.isArray(m.input_modalities) ? m.input_modalities.map(String) : null;
  if (inp && !inp.includes('text')) return false;
  return true;
}

let _modelsPromise = null;
/**
 * The free text models the provider currently offers, newest answer cached.
 *
 * Never throws and never blocks a send: on any failure it resolves to [] and the
 * caller falls back to MODEL. Model discovery is a refinement, not a dependency
 * — an outage of /models must not take the chat down with it.
 */
export function freeTextModels() {
  if (_modelsPromise) return _modelsPromise;
  _modelsPromise = (async () => {
    try {
      const t = timed(6000);
      const r = await fetch(MODELS_URL, { signal: t.signal }).finally(() => t.clear());
      if (!r.ok) return [];
      const list = await r.json();
      if (!Array.isArray(list)) return [];
      return list.filter(isFreeTextModel).map((m) => ({
        name: m.name,
        description: typeof m.description === 'string' ? m.description : '',
        tier: String(m.tier).toLowerCase(),
        reasoning: m.reasoning === true,
      }));
    } catch { return []; }
  })();
  // Let a later send re-discover rather than trusting one answer forever.
  setTimeout(() => { _modelsPromise = null; }, MODELS_TTL_MS);
  return _modelsPromise;
}

/**
 * The model to send, chosen from the discovered free set.
 *
 * MODEL ('openai-fast') is the default and is itself verified `tier:"anonymous"`.
 * It is used when discovery returns nothing (offline, /models down) OR when the
 * discovered set still contains it. If discovery succeeds and the default is NOT
 * in the free set any more, the first discovered free model is used instead —
 * which is how this survives the provider retiring a model without a deploy.
 */
export async function freeModelName() {
  const free = await freeTextModels();
  if (!free.length) return MODEL;
  if (free.some((m) => m.name === MODEL)) return MODEL;
  return free[0].name;
}
