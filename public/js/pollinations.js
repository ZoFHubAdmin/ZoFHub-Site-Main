// ZoFHub · pollinations.js — 100% CLIENT-SIDE AI helper.
// ---------------------------------------------------------------------------
// EVERY AI request (text AND images) is made DIRECTLY from the visitor's own
// browser to Pollinations.ai, over THEIR internet connection, on THEIR IP.
// NOTHING is proxied through our server — there is deliberately no /api/ai/*
// fallback anymore. Why: routing AI through the server meant every visitor
// shared ONE server IP, which Pollinations rate-limited almost immediately →
// the endless "AI is busy, try later" message. Per-user browser-direct calls
// don't share a rate bucket, so it's effectively free + unlimited.
//
// Pollinations is free + keyless and sends Access-Control-Allow-Origin '*', and
// our CSP allows https: for connect-src (text) and img-src (images), so the
// browser is permitted to call it directly.
//
// Two browser-direct text routes, tried in order (NO server at any point):
//   1) POST https://text.pollinations.ai/openai  (streaming, token-by-token)
//   2) GET  https://text.pollinations.ai/<prompt> (the simple URL API — a plain
//      GET that returns the answer as text; very reliable, no streaming)
//   3) one more streaming attempt after a short warm-up pause
// Images are just an <img src> pointing straight at image.pollinations.ai.
// ---------------------------------------------------------------------------

const REFERRER    = (typeof location !== 'undefined' && location.hostname) || 'zofhub';

// LOCAL-DEV DETECTION. Pollinations' TEXT API now rejects browser fetches from
// http/localhost origins with 403 "Missing Turnstile token" (a Cloudflare
// anti-bot check you can't satisfy from a dev machine). Real https domains are
// allowed with no token. So when we're on localhost/http we route TEXT through
// this app's OWN /api/ai/text (a server-side call — no Origin, no Turnstile).
// In PRODUCTION (https) IS_LOCAL is false, browser-direct works, and the server
// is never touched — honouring "no AI through the server in prod". (Images use
// <img src> which sends no Origin, so they work everywhere and need no fallback.)
const IS_LOCAL = typeof location !== 'undefined' && (
  location.protocol !== 'https:' ||
  /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|::1)$/i.test(location.hostname || '')
);
const TEXT_POST   = 'https://text.pollinations.ai/openai';   // OpenAI-compatible, streams
const TEXT_GET    = 'https://text.pollinations.ai/';         // simple URL API: /<prompt>
const IMG_DIRECT  = 'https://image.pollinations.ai/prompt/';
const MODEL       = 'openai-fast';   // the ONLY anonymous model left = GPT-OSS 20B, a REASONING model
const REASONING   = 'low';           // reasoning_effort: 'low' cuts time-to-first-token from ~20s → ~1.5s
const SYSTEM      = 'You are ZoFHub AI, a friendly, concise assistant for students. Reply in clear markdown. Keep answers focused and reasonably brief unless asked for more detail.';

// Timeouts (ms). The one keyless model left (gpt-oss-20b) is a REASONING model:
// even with reasoning_effort=low it can pause before the first token, and its
// latency is variable BECAUSE Pollinations now rate-limits the anonymous tier
// HARD (HTTP 429) whenever requests arrive too fast or concurrently. So the
// rules are: generous windows + NEVER burst — every attempt is sequential and
// spaced with back-off (see pollTextStream / pollText). Firing rapid retries is
// what caused the "that reply didn't come through" every-time failure.
const CONNECT_MS    = 15000;   // no response headers by now → connection is dead
const FIRST_BYTE_MS = 25000;   // connected but no first token yet (reasoning warm-up / load)
const IDLE_MS       = 20000;   // stream stalled mid-answer
const GET_MS        = 45000;   // GET waits for the WHOLE answer at once, so it needs a big window
                               // (a long reply from the slow reasoning model can take 30-40s)

const clean = (s) => String(s || '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function timed(ms) {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), ms);
  return { signal: ctrl.signal, clear: () => clearTimeout(id) };
}

// Salvage a reply from a non-SSE body (some responses come back as plain JSON).
function salvage(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  try { const j = JSON.parse(s); return clean(j?.choices?.[0]?.message?.content || j?.choices?.[0]?.text || ''); } catch {}
  if (!s.startsWith('{') && !s.startsWith('data:')) return clean(s);
  return '';
}

// Flatten a messages[] array into a single prompt string for the GET URL route
// (which takes the prompt in the path). Keeps the system instruction + the last
// few turns, capped so the encoded URL stays well within limits.
function flatten(messages) {
  const sys = messages.find(m => m.role === 'system')?.content || SYSTEM;
  const convo = messages.filter(m => m.role !== 'system')
    .map(m => (m.role === 'assistant' ? 'Assistant: ' : 'User: ') + String(m.content || ''))
    .join('\n');
  return (sys + '\n\n' + convo + '\nAssistant:').slice(-1500);
}

// ── Route 1 (streaming): direct browser → Pollinations, token by token ───────
async function textDirectStream(messages, { onToken, onStatus } = {}) {
  const ctrl = new AbortController();
  let timer = setTimeout(() => ctrl.abort(), CONNECT_MS);
  const arm = (ms) => { clearTimeout(timer); timer = setTimeout(() => ctrl.abort(), ms); };
  let full = '', raw = '';
  try {
    const r = await fetch(TEXT_POST, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: MODEL, messages, referrer: REFERRER, private: true, stream: true, reasoning_effort: REASONING }),
      signal: ctrl.signal,
    });
    if (!r.ok) { const e = new Error('http ' + r.status); e.status = r.status; throw e; }
    if (!r.body || !r.body.getReader) throw new Error('no-stream');
    arm(FIRST_BYTE_MS);

    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
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
        if (!t || t.startsWith(':')) continue;
        if (!t.startsWith('data:')) continue;
        const pl = t.slice(5).trim();
        if (pl === '[DONE]') continue;
        try {
          const j = JSON.parse(pl);
          const choice = j?.choices?.[0] || {};
          const delta = choice.delta?.content ?? choice.text ?? '';
          if (delta) { full += delta; onToken?.(clean(full)); }
          // gpt-oss-20b streams chain-of-thought `reasoning` tokens BEFORE the
          // answer — we don't show them, but their arrival means it's working,
          // so keep the "Thinking…" status alive until real content starts.
          else if (!full && choice.delta?.reasoning) onStatus?.('Thinking…');
        } catch { /* JSON split across chunks — completes on the next read */ }
      }
    }
    full = clean(full);
    if (full) return full;
    const fromRaw = salvage(raw);
    if (fromRaw) { onToken?.(fromRaw); return fromRaw; }
    throw new Error('empty');
  } finally { clearTimeout(timer); }
}

// ── Route 2 (simple URL API): direct browser → GET text.pollinations.ai/<prompt>
// Returns the whole answer as plain text. No streaming, but very reliable.
async function textDirectGet(messages, { onToken, onStatus } = {}) {
  onStatus?.('Thinking…');
  const url = TEXT_GET + encodeURIComponent(flatten(messages))
    + `?model=${encodeURIComponent(MODEL)}&reasoning_effort=${REASONING}&referrer=${encodeURIComponent(REFERRER)}&private=true`;
  const t = timed(GET_MS);
  try {
    const r = await fetch(url, { signal: t.signal });
    if (!r.ok) { const e = new Error('http ' + r.status); e.status = r.status; throw e; }
    const ct = r.headers.get('content-type') || '';
    let txt = ct.includes('application/json')
      ? (await r.json())?.choices?.[0]?.message?.content || ''
      : await r.text();
    txt = clean(salvage(txt) || txt);
    if (!txt) throw new Error('empty');
    onToken?.(txt);   // not streamed → render once
    return txt;
  } finally { t.clear(); }
}

// Non-streaming direct POST (used by the small helper orb).
async function textDirect(messages, ms = GET_MS) {
  const t = timed(ms);
  try {
    const r = await fetch(TEXT_POST, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: MODEL, messages, referrer: REFERRER, private: true, reasoning_effort: REASONING }),
      signal: t.signal,
    });
    if (!r.ok) { const e = new Error('http ' + r.status); e.status = r.status; throw e; }
    const ct = r.headers.get('content-type') || '';
    let txt = ct.includes('application/json')
      ? (await r.json())?.choices?.[0]?.message?.content || ''
      : await r.text();
    txt = clean(txt);
    if (!txt) throw new Error('empty');
    return txt;
  } finally { t.clear(); }
}

// LOCAL-DEV ONLY — text through this app's own server (server-side Pollinations
// call, so no Origin/Turnstile block). Never used in production (IS_LOCAL=false
// on https). Returns the whole reply at once (the server route isn't streaming).
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
    onToken?.(txt);   // not streamed → render once
    return txt;
  } finally { t.clear(); }
}

// Back-off before the NEXT attempt. The anon endpoint returns 429 on bursts, so
// a rate-limited try waits noticeably longer to let the window clear; otherwise a
// short spacer keeps us from ever hammering it. Never fire attempts concurrently.
const backoff = (err) => sleep(err?.status === 429 ? 3500 : 1500);

// PUBLIC — chat. onToken(partial) renders live; onStatus(label) for UI.
// All BROWSER-DIRECT to text.pollinations.ai, ZERO server. Order matters for the
// one slow keyless model (gpt-oss-20b) we're stuck with:
//   1) STREAMING POST — best for a slow reasoning model: the first words appear
//      in a few seconds and the rest streams in, so a LONG answer never "times
//      out" (we only give up if tokens stop flowing) and the user always sees
//      progress instead of a frozen box.
//   2) GET URL API — `GET text.pollinations.ai/<prompt>` — the simple "URL
//      version": a plain cross-origin GET (no CORS preflight). Rock-solid for
//      short answers; it waits for the whole reply so it has a big timeout.
// Attempts are SEQUENTIAL + SPACED with back-off (never concurrent) because the
// anon tier 429s on bursts — that self-inflicted burst was the old every-time bug.
export async function pollTextStream(messages, { onToken, onStatus } = {}) {
  const browser = [
    { route: 'direct-stream', run: () => textDirectStream(messages, { onToken, onStatus }) },
    { route: 'direct-get',    run: () => textDirectGet(messages, { onToken, onStatus }) },
    { route: 'direct-stream', run: () => textDirectStream(messages, { onToken, onStatus }) },
  ];
  // On localhost/http the browser-direct routes are Turnstile-blocked (403), so
  // try the server first; browser-direct stays as a harmless last-ditch. In prod
  // (https) it's browser-direct only — the server route is never reached.
  const attempts = IS_LOCAL
    ? [{ route: 'server-dev', run: () => textViaServer(messages, { onToken, onStatus }) }, ...browser]
    : browser;
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
  throw new Error('all-ai-routes-failed: ' + (lastErr?.message || 'unknown'));
}

// PUBLIC — non-streaming chat (helper orb). Same slow-and-steady, no-burst policy.
export async function pollText(messages, { onStatus } = {}) {
  const browser = [
    () => textDirect(messages),
    () => textDirectGet(messages),
    () => textDirect(messages),
  ];
  // Local dev → server first (browser-direct is Turnstile-blocked on localhost).
  const attempts = IS_LOCAL
    ? [() => textViaServer(messages, { onStatus }), ...browser]
    : browser;
  let lastErr;
  for (let i = 0; i < attempts.length; i++) {
    try {
      onStatus?.(i ? 'Still working…' : 'Thinking…');
      const text = await attempts[i]();
      if (text) return { text, route: 'direct' };
    } catch (e) {
      lastErr = e;
      console.warn(`[ai] orb attempt ${i + 1} failed:`, e?.status || '', e?.message || e);
      if (i < attempts.length - 1) await backoff(e);
    }
  }
  throw new Error('all-ai-routes-failed: ' + (lastErr?.message || 'unknown'));
}

// Convenience for a single prompt (used by the helper orb).
export async function pollTextPrompt(prompt, opts) {
  return pollText([
    { role: 'system', content: SYSTEM },
    { role: 'user', content: String(prompt).slice(0, 4000) },
  ], opts);
}

// Streaming single-prompt convenience (helper orb).
export async function pollTextPromptStream(prompt, opts) {
  return pollTextStream([
    { role: 'system', content: SYSTEM },
    { role: 'user', content: String(prompt).slice(0, 4000) },
  ], opts);
}

// ── Images — the browser loads them DIRECTLY from Pollinations (no bytes ever
// touch our server). Both URLs below point straight at image.pollinations.ai.
// pollImageUrl is the full-quality request; pollImageShieldUrl (kept for the
// <img onerror> fallback in ai.js) is a lighter DIRECT retry — smaller + no
// model pin — which succeeds more often when the first request is throttled. ──
export function pollImageUrl(prompt, seed = Math.floor(Math.random() * 1e6), { w = 1024, h = 1024 } = {}) {
  return `${IMG_DIRECT}${encodeURIComponent(prompt)}?width=${w}&height=${h}&nologo=true&seed=${seed}&referrer=${encodeURIComponent(REFERRER)}`;
}
export function pollImageShieldUrl(prompt, seed = 0) {
  // NOT a server route — a second browser-direct attempt with lighter params.
  const s = seed || Math.floor(Math.random() * 1e6) + 1;
  return `${IMG_DIRECT}${encodeURIComponent(prompt)}?nologo=true&seed=${s}&referrer=${encodeURIComponent(REFERRER)}`;
}
