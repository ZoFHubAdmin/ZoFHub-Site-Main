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
const TEXT_POST   = 'https://text.pollinations.ai/openai';   // OpenAI-compatible, streams
const TEXT_GET    = 'https://text.pollinations.ai/';         // simple URL API: /<prompt>
const IMG_DIRECT  = 'https://image.pollinations.ai/prompt/';
const MODEL       = 'openai-fast';   // the keyless model that actually works free; others 429
const SYSTEM      = 'You are ZoFHub AI, a friendly, concise assistant for students. Reply in clear markdown.';

// Timeouts (ms). Pollinations' streaming POST is flaky (often stalls with no
// first token), so we give it only a SHORT window before failing over to the
// rock-solid GET URL route — which we then retry a few times, because individual
// Pollinations requests randomly time out but a retry almost always lands.
const CONNECT_MS    = 5000;    // no response headers by now → give up on streaming
const FIRST_BYTE_MS = 7000;    // connected but no first token → fail over to GET
const IDLE_MS       = 15000;   // stream stalled mid-answer
const GET_MS        = 20000;   // the simple GET URL route (whole answer at once)

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
async function textDirectStream(messages, { onToken } = {}) {
  const ctrl = new AbortController();
  let timer = setTimeout(() => ctrl.abort(), CONNECT_MS);
  const arm = (ms) => { clearTimeout(timer); timer = setTimeout(() => ctrl.abort(), ms); };
  let full = '', raw = '';
  try {
    const r = await fetch(TEXT_POST, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: MODEL, messages, referrer: REFERRER, private: true, stream: true }),
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
          const delta = j?.choices?.[0]?.delta?.content ?? j?.choices?.[0]?.text ?? '';
          if (delta) { full += delta; onToken?.(clean(full)); }
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
async function textDirectGet(messages, { onToken } = {}) {
  const url = TEXT_GET + encodeURIComponent(flatten(messages))
    + `?model=${encodeURIComponent(MODEL)}&referrer=${encodeURIComponent(REFERRER)}&private=true`;
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
async function textDirect(messages, ms = 15000) {
  const t = timed(ms);
  try {
    const r = await fetch(TEXT_POST, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: MODEL, messages, referrer: REFERRER, private: true }),
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

// PUBLIC — streaming chat. onToken(partial) renders live; onStatus(label) for UI.
// All BROWSER-DIRECT, ZERO server. Strategy: one quick streaming attempt for the
// nice live-typing UX, then the reliable GET URL API retried several times
// (Pollinations randomly times out individual requests, so retries land it).
export async function pollTextStream(messages, { onToken, onStatus } = {}) {
  // 1) Quick streaming attempt (short timeouts) — lovely UX when it works.
  try {
    onStatus?.('Thinking…');
    const text = await textDirectStream(messages, { onToken });
    if (text) return { text, route: 'direct-stream' };
  } catch (e) { console.warn('[ai] stream attempt failed:', e?.message || e); }

  // 2) The simple GET URL API — the reliable workhorse. Retry a few times.
  for (let i = 0; i < 4; i++) {
    try {
      onStatus?.(i ? 'Reconnecting…' : 'Almost there…');
      const text = await textDirectGet(messages, { onToken });
      if (text) return { text, route: 'direct-get' };
    } catch (e) {
      console.warn(`[ai] GET attempt ${i + 1} failed:`, e?.message || e);
      await sleep(800);
    }
  }
  throw new Error('all-ai-routes-failed');
}

// PUBLIC — non-streaming chat (helper orb). Reliable GET URL retried, then POST.
export async function pollText(messages, { onStatus } = {}) {
  for (let i = 0; i < 4; i++) {
    try {
      onStatus?.(i ? 'Reconnecting…' : 'Thinking…');
      return { text: await textDirectGet(messages), route: 'direct-get' };
    } catch (e) {
      console.warn(`[ai] GET attempt ${i + 1} failed:`, e?.message || e);
      await sleep(800);
    }
  }
  try { return { text: await textDirect(messages), route: 'direct-post' }; }
  catch (e) { console.warn('[ai] POST failed:', e?.message || e); }
  throw new Error('all-ai-routes-failed');
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
