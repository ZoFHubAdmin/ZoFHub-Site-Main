// ZoFHub · pollinations.js — CLIENT-SIDE AI helper (browser-direct).
// ---------------------------------------------------------------------------
// EVERY AI request (text AND images) is made DIRECTLY from the visitor's own
// browser to Pollinations, over THEIR connection, on THEIR IP. The prompt the
// user types is sent to a Pollinations WEB URL and the response comes back on
// their end — NOT processed on our server.
//
// WHY A KEY IS NOW REQUIRED (changed 2026-07-05): Pollinations retired keyless
// browser access. An anonymous browser fetch from an http/localhost origin is
// rejected with a Cloudflare Turnstile 403 ("Missing Turnstile token") that a
// dev machine can't satisfy. The fix is a **publishable `pk_` key** — free from
// https://enter.pollinations.ai, explicitly "safe to ship in browsers" — which
// authenticates the request so it works browser-direct from ANY origin
// (localhost INCLUDED) with no server and no Turnstile. This is exactly how
// Pollinations' own web app calls its API (gen.pollinations.ai + a pk_ key).
//
// Text routes when a key is present (all browser-direct to gen.pollinations.ai):
//   1) GET  gen.pollinations.ai/text/<prompt>?key=pk_…   (the simple URL API —
//      free, whole answer at once; this is the "web URL" method)
//   2) POST gen.pollinations.ai/v1/chat/completions       (OpenAI, streaming)
// Without a key: anonymous text.pollinations.ai still works on an https domain;
// on localhost it Turnstile-fails, so we fall back to this app's own /api/ai/text
// (dev only). Images use <img src> (no Origin header) so they work everywhere.
// ---------------------------------------------------------------------------

const REFERRER = (typeof location !== 'undefined' && location.hostname) || 'zofhub';

const IS_LOCAL = typeof location !== 'undefined' && (
  location.protocol !== 'https:' ||
  /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|::1)$/i.test(location.hostname || '')
);

// Keyed (modern) endpoints — the ones Pollinations' own frontend uses.
const GEN_TEXT = 'https://gen.pollinations.ai/text/';               // GET /text/<prompt>?key=pk_
const GEN_CHAT = 'https://gen.pollinations.ai/v1/chat/completions'; // POST (OpenAI-compatible), streams
// Legacy anonymous endpoints — only used when NO key is configured.
const TEXT_POST = 'https://text.pollinations.ai/openai';
const TEXT_GET  = 'https://text.pollinations.ai/';
const IMG_DIRECT = 'https://image.pollinations.ai/prompt/';

const MODEL     = 'openai-fast'; // GPT-OSS 20B reasoning model (free tier)
const REASONING = 'low';         // reasoning_effort:'low' → fast first token (~1.5s vs ~20s)
const SYSTEM    = 'You are ZoFHub AI, a friendly, concise assistant for students. Reply in clear markdown. Keep answers focused and reasonably brief unless asked for more detail.';

const CONNECT_MS    = 15000;
const FIRST_BYTE_MS = 25000;
const IDLE_MS       = 20000;
const GET_MS        = 45000;

const clean = (s) => String(s || '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function timed(ms) {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), ms);
  return { signal: ctrl.signal, clear: () => clearTimeout(id) };
}

// ── Publishable API key resolution ──────────────────────────────────────────
// Order: window.POLLINATIONS_KEY → localStorage('zofhub_pollinations_key') →
// GET /api/ai/key (served from the POLLINATIONS_PUBLIC_KEY env var). The result
// is cached. A `pk_` key is publishable (safe in the browser); the AI request
// still goes browser-direct — only this small credential comes from config.
let _keyPromise = null;
async function getKey() {
  try {
    if (typeof window !== 'undefined' && window.POLLINATIONS_KEY) return String(window.POLLINATIONS_KEY);
    if (typeof localStorage !== 'undefined') { const k = localStorage.getItem('zofhub_pollinations_key'); if (k) return k; }
  } catch { /* storage blocked → fall through to server config */ }
  if (!_keyPromise) {
    _keyPromise = fetch('/api/ai/key')
      .then(r => (r.ok ? r.json() : {}))
      .then(d => (d && d.key) || '')
      .catch(() => '');
  }
  return _keyPromise;
}
// Let the app / user set a key at runtime without editing files.
export function setPollinationsKey(key) {
  try { localStorage.setItem('zofhub_pollinations_key', String(key || '')); } catch {}
  _keyPromise = null;
}

function salvage(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  try { const j = JSON.parse(s); return clean(j?.choices?.[0]?.message?.content || j?.choices?.[0]?.text || ''); } catch {}
  if (!s.startsWith('{') && !s.startsWith('data:')) return clean(s);
  return '';
}

// Flatten messages[] into a single prompt for the GET URL route (prompt in path).
function flatten(messages) {
  const sys = messages.find(m => m.role === 'system')?.content || SYSTEM;
  const convo = messages.filter(m => m.role !== 'system')
    .map(m => (m.role === 'assistant' ? 'Assistant: ' : 'User: ') + String(m.content || ''))
    .join('\n');
  return (sys + '\n\n' + convo + '\nAssistant:').slice(-1500);
}

// Shared SSE consumer for the streaming POST routes. `arm(ms)` re-arms the
// idle-abort on every chunk so a long answer never times out mid-stream.
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
        // Reasoning models stream chain-of-thought BEFORE the answer — don't show
        // it, but keep "Thinking…" alive until real content starts.
        else if (!full && choice.delta?.reasoning) onStatus?.('Thinking…');
      } catch { /* JSON split across chunks — completes next read */ }
    }
  }
  full = clean(full);
  if (full) return full;
  const fromRaw = salvage(raw);
  if (fromRaw) { onToken?.(fromRaw); return fromRaw; }
  throw new Error('empty');
}

// ── KEYED routes (gen.pollinations.ai + pk_ key) — browser-direct EVERYWHERE ──

// The "web URL" method: GET gen.pollinations.ai/text/<prompt>?key=pk_… — free,
// whole answer at once, works from localhost and prod alike.
async function textKeyedGet(messages, key, { onToken, onStatus } = {}) {
  onStatus?.('Thinking…');
  const url = GEN_TEXT + encodeURIComponent(flatten(messages))
    + `?model=${encodeURIComponent(MODEL)}&reasoning_effort=${REASONING}&key=${encodeURIComponent(key)}`;
  const t = timed(GET_MS);
  try {
    const r = await fetch(url, { signal: t.signal });
    if (!r.ok) { const e = new Error('http ' + r.status); e.status = r.status; throw e; }
    const ct = r.headers.get('content-type') || '';
    let txt = ct.includes('application/json') ? (await r.json())?.choices?.[0]?.message?.content || '' : await r.text();
    txt = clean(salvage(txt) || txt);
    if (!txt) throw new Error('empty');
    onToken?.(txt);
    return txt;
  } finally { t.clear(); }
}

// Streaming, OpenAI-compatible: POST gen.pollinations.ai/v1/chat/completions with
// Authorization: Bearer pk_… — token-by-token UX for longer answers.
async function textKeyedStream(messages, key, { onToken, onStatus } = {}) {
  const ctrl = new AbortController();
  let timer = setTimeout(() => ctrl.abort(), CONNECT_MS);
  const arm = (ms) => { clearTimeout(timer); timer = setTimeout(() => ctrl.abort(), ms); };
  try {
    const r = await fetch(GEN_CHAT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
      body: JSON.stringify({ model: MODEL, messages, stream: true, reasoning_effort: REASONING }),
      signal: ctrl.signal,
    });
    if (!r.ok) { const e = new Error('http ' + r.status); e.status = r.status; throw e; }
    return await consumeSSE(r, arm, { onToken, onStatus });
  } finally { clearTimeout(timer); }
}

// ── ANONYMOUS routes (legacy text.pollinations.ai) — only when NO key set ────
// Work on real https domains; Turnstile-blocked on localhost.
async function textDirectStream(messages, { onToken, onStatus } = {}) {
  const ctrl = new AbortController();
  let timer = setTimeout(() => ctrl.abort(), CONNECT_MS);
  const arm = (ms) => { clearTimeout(timer); timer = setTimeout(() => ctrl.abort(), ms); };
  try {
    const r = await fetch(TEXT_POST, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: MODEL, messages, referrer: REFERRER, private: true, stream: true, reasoning_effort: REASONING }),
      signal: ctrl.signal,
    });
    if (!r.ok) { const e = new Error('http ' + r.status); e.status = r.status; throw e; }
    return await consumeSSE(r, arm, { onToken, onStatus });
  } finally { clearTimeout(timer); }
}
async function textDirectGet(messages, { onToken, onStatus } = {}) {
  onStatus?.('Thinking…');
  const url = TEXT_GET + encodeURIComponent(flatten(messages))
    + `?model=${encodeURIComponent(MODEL)}&reasoning_effort=${REASONING}&referrer=${encodeURIComponent(REFERRER)}&private=true`;
  const t = timed(GET_MS);
  try {
    const r = await fetch(url, { signal: t.signal });
    if (!r.ok) { const e = new Error('http ' + r.status); e.status = r.status; throw e; }
    const ct = r.headers.get('content-type') || '';
    let txt = ct.includes('application/json') ? (await r.json())?.choices?.[0]?.message?.content || '' : await r.text();
    txt = clean(salvage(txt) || txt);
    if (!txt) throw new Error('empty');
    onToken?.(txt);
    return txt;
  } finally { t.clear(); }
}

// LOCAL-DEV last resort — our own server (server-side call, no Origin/Turnstile).
// Only reached on localhost when no key is configured; never in production.
async function textViaServer(messages, { onToken, onStatus } = {}) {
  onStatus?.('Thinking… (local dev · via server)');
  const t = timed(GET_MS);
  try {
    const r = await fetch('/api/ai/text', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages }), signal: t.signal,
    });
    if (!r.ok) { const e = new Error('http ' + r.status); e.status = r.status; throw e; }
    const data = await r.json().catch(() => ({}));
    const txt = clean(data?.reply || '');
    if (!txt) throw new Error(data?.error || 'empty');
    onToken?.(txt);
    return txt;
  } finally { t.clear(); }
}

// Back-off before the next attempt; longer on a 429 (rate limit). Never concurrent.
const backoff = (err) => sleep(err?.status === 429 ? 3500 : 1500);

// Run a list of {route, run} attempts sequentially with back-off; return first success.
async function runAttempts(attempts, onStatus) {
  let lastErr;
  for (let i = 0; i < attempts.length; i++) {
    try {
      onStatus?.(i === 0 ? 'Thinking…' : 'Still working…');
      const text = await attempts[i].run();
      if (text) return { text, route: attempts[i].route };
    } catch (e) {
      lastErr = e;
      console.warn(`[ai] attempt ${i + 1} (${attempts[i].route}) failed:`, e?.status || '', e?.message || e);
      if (i < attempts.length - 1) await backoff(e);
    }
  }
  const err = new Error('all-ai-routes-failed: ' + (lastErr?.message || 'unknown'));
  err.noKey = !!(lastErr && lastErr.noKey);
  throw err;
}

// Build the ordered attempt list for the current environment.
function buildAttempts(messages, key, cbs) {
  const attempts = [];
  if (key) {
    // BEST PATH — pk_ key → gen.pollinations.ai browser-direct, works EVERYWHERE
    // (localhost + prod), no server, no Turnstile. Streaming FIRST: the reasoning
    // model can take ~40s for a long reply and a non-streaming GET would time out
    // waiting for the whole thing — streaming shows the first words in a few
    // seconds and never times out mid-answer. The simple GET "web URL" is next.
    // Both send the prompt to a Pollinations URL, answered on the user's device.
    attempts.push(
      { route: 'keyed-stream', run: () => textKeyedStream(messages, key, cbs) },
      { route: 'keyed-get',    run: () => textKeyedGet(messages, key, cbs) },
    );
  }
  // Safety net (and the ONLY path with no key): on localhost, anonymous browser
  // routes are Turnstile-blocked, so use our own server; anonymous also works on
  // an https domain. This guarantees a reply even if a key is depleted (402).
  if (IS_LOCAL) attempts.push({ route: 'server-dev', run: () => textViaServer(messages, cbs) });
  attempts.push(
    { route: 'direct-stream', run: () => textDirectStream(messages, cbs) },
    { route: 'direct-get',    run: () => textDirectGet(messages, cbs) },
  );
  return attempts;
}

// PUBLIC — streaming chat. onToken(partial) renders live; onStatus(label) for UI.
export async function pollTextStream(messages, { onToken, onStatus } = {}) {
  const key = await getKey();
  return runAttempts(buildAttempts(messages, key, { onToken, onStatus }), onStatus);
}

// PUBLIC — chat used by the helper orb (same routing).
export async function pollText(messages, { onStatus } = {}) {
  const key = await getKey();
  const { text } = await runAttempts(buildAttempts(messages, key, { onStatus }), onStatus);
  return { text, route: 'direct' };
}

export async function pollTextPrompt(prompt, opts) {
  return pollText([
    { role: 'system', content: SYSTEM },
    { role: 'user', content: String(prompt).slice(0, 4000) },
  ], opts);
}
export async function pollTextPromptStream(prompt, opts) {
  return pollTextStream([
    { role: 'system', content: SYSTEM },
    { role: 'user', content: String(prompt).slice(0, 4000) },
  ], opts);
}

// ── Images — loaded via <img src> straight from Pollinations (no Origin header,
// so they work on localhost and prod with no key and no Turnstile). ──────────
export function pollImageUrl(prompt, seed = Math.floor(Math.random() * 1e6), { w = 1024, h = 1024 } = {}) {
  return `${IMG_DIRECT}${encodeURIComponent(prompt)}?width=${w}&height=${h}&nologo=true&seed=${seed}&referrer=${encodeURIComponent(REFERRER)}`;
}
export function pollImageShieldUrl(prompt, seed = 0) {
  const s = seed || Math.floor(Math.random() * 1e6) + 1;
  return `${IMG_DIRECT}${encodeURIComponent(prompt)}?nologo=true&seed=${s}&referrer=${encodeURIComponent(REFERRER)}`;
}
