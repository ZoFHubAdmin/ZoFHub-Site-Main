// ZoFHub · pollinations.js — shared CLIENT-SIDE AI helper.
// ---------------------------------------------------------------------------
// Calls Pollinations.ai DIRECTLY from the user's browser, so every AI request
// goes out on THAT visitor's IP — none of the text/image load ever touches our
// server. Pollinations is free + keyless and returns Access-Control-Allow-Origin
// '*', and our CSP allows https:, so the browser is permitted to call it.
//
// SPEED (why it used to feel slow / "loading model"):
//   • We now STREAM the reply token-by-token, so the first words appear in ~1-2s
//     instead of the user staring at "Thinking…" until the whole answer is done.
//   • We use a FAST model ('openai-fast') which is far quicker to first token and
//     doesn't cold-start the way the heavier 'openai' model can.
//   • We FAIL FAST: if no first token arrives in a few seconds (model cold /
//     network blocked), we abort and fall back instead of hanging for 30s.
//
// Reliability: direct stream → same-origin server shield (/api/ai/text) → caller
// decides. The server is ONLY a fallback, never the primary path.
// ---------------------------------------------------------------------------

const REFERRER    = (typeof location !== 'undefined' && location.hostname) || 'zofhub';
const TEXT_DIRECT = 'https://text.pollinations.ai/openai';
const IMG_DIRECT  = 'https://image.pollinations.ai/prompt/';
const MODEL       = 'openai-fast';   // quick to first token; avoids cold-start stalls
const SYSTEM      = 'You are ZoFHub AI, a friendly, concise assistant for students. Reply in clear markdown.';

// Two-stage timeouts (ms). A BLOCKED network fails at connection time (no
// response headers), so we bail fast there; but once connected, the model can be
// slow to its first token (openai-fast is usually ~2-3s but can spike), so we
// wait longer rather than throwing away a reply that's about to arrive.
const CONNECT_MS    = 8000;   // no response headers by now → blocked → fall back fast
const FIRST_BYTE_MS = 20000;  // connected, but model slow to first token → keep waiting
const IDLE_MS       = 15000;  // abort if the stream stalls mid-answer
const SHIELD_MS     = 20000;  // server-shield (non-streaming) overall timeout

const clean = (s) => String(s || '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function timed(ms) {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), ms);
  return { signal: ctrl.signal, clear: () => clearTimeout(id) };
}

// Salvage a reply from a non-SSE body (some responses come back as plain JSON
// or text even when we asked to stream).
function salvage(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  try { const j = JSON.parse(s); return clean(j?.choices?.[0]?.message?.content || j?.choices?.[0]?.text || ''); } catch {}
  if (!s.startsWith('{') && !s.startsWith('data:')) return clean(s);
  return '';
}

// ── Route 1 (streaming): direct browser → Pollinations, token by token ───────
// onToken(partialText) is called with the growing reply so the UI can render
// live. Resolves with the full text; throws (with .status) so callers fall back.
async function textDirectStream(messages, { onToken } = {}) {
  const ctrl = new AbortController();
  let timer = setTimeout(() => ctrl.abort(), CONNECT_MS);  // stage 1: connection
  const arm = (ms) => { clearTimeout(timer); timer = setTimeout(() => ctrl.abort(), ms); };
  let full = '', raw = '';
  try {
    const r = await fetch(TEXT_DIRECT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // private:true keeps prompts out of Pollinations' public feed.
      body: JSON.stringify({ model: MODEL, messages, referrer: REFERRER, private: true, stream: true }),
      signal: ctrl.signal,
    });
    if (!r.ok) { const e = new Error('http ' + r.status); e.status = r.status; throw e; }
    if (!r.body || !r.body.getReader) throw new Error('no-stream');
    arm(FIRST_BYTE_MS); // stage 2: connected — allow the model time for token #1

    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      arm(IDLE_MS); // got data → switch from first-byte to idle timeout
      const chunk = dec.decode(value, { stream: true });
      raw += chunk; buf += chunk;
      const lines = buf.split('\n');
      buf = lines.pop();                    // keep the trailing partial line
      for (const line of lines) {
        const t = line.trim();
        if (!t || t.startsWith(':')) continue;       // keepalive/comment
        if (!t.startsWith('data:')) continue;
        const p = t.slice(5).trim();
        if (p === '[DONE]') continue;
        try {
          const j = JSON.parse(p);
          const delta = j?.choices?.[0]?.delta?.content ?? j?.choices?.[0]?.text ?? '';
          if (delta) { full += delta; onToken?.(clean(full)); }
        } catch { /* JSON split across chunks — completes on the next read */ }
      }
    }
    full = clean(full);
    if (full) return full;
    const fromRaw = salvage(raw);           // wasn't really SSE → salvage it
    if (fromRaw) { onToken?.(fromRaw); return fromRaw; }
    throw new Error('empty');
  } finally { clearTimeout(timer); }
}

// ── Route 2 (non-streaming): same-origin server shield (fallback only) ───────
async function textShield(messages, ms = SHIELD_MS) {
  const t = timed(ms);
  try {
    const r = await fetch('/api/ai/text', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages }), signal: t.signal,
    });
    const j = await r.json().catch(() => ({}));
    if (r.ok && j.reply) return clean(j.reply);
    const e = new Error(j.error || ('http ' + r.status)); e.status = r.status; throw e;
  } finally { t.clear(); }
}

// Non-streaming direct call (used by the small helper orb).
async function textDirect(messages, ms = 15000) {
  const t = timed(ms);
  try {
    const r = await fetch(TEXT_DIRECT, {
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
// Tries direct streaming (offloads our server), then the server shield.
// Returns { text, route }. Throws only if BOTH routes fail.
export async function pollTextStream(messages, { onToken, onStatus } = {}) {
  for (let attempt = 0; attempt <= 1; attempt++) {
    try {
      onStatus?.(attempt ? 'Busy — retrying…' : 'Thinking…');
      const text = await textDirectStream(messages, { onToken });
      return { text, route: 'direct' };
    } catch (e) {
      if (e?.status === 429 && attempt < 1) { onStatus?.('Cooling down a moment…'); await sleep(1500); continue; }
      console.warn('[ai] direct stream failed:', e?.message || e);
      break;
    }
  }
  try {
    onStatus?.('Reconnecting…');
    const text = await textShield(messages);
    onToken?.(text);                        // shield isn't streamed → render once
    return { text, route: 'server' };
  } catch (e) {
    console.warn('[ai] server shield failed:', e?.message || e);
  }
  throw new Error('all-ai-routes-failed');
}

// PUBLIC — non-streaming chat (used by the helper orb). Direct then shield.
export async function pollText(messages, { onStatus } = {}) {
  for (const [route, fn] of [['direct', textDirect], ['server', textShield]]) {
    for (let attempt = 0; attempt <= 1; attempt++) {
      try {
        onStatus?.(attempt ? 'Busy — retrying…' : 'Thinking…');
        return { text: await fn(messages), route };
      } catch (e) {
        if (e?.status === 429 && attempt < 1) { onStatus?.('Cooling down a moment…'); await sleep(1500); continue; }
        console.warn(`[ai] ${route} route failed:`, e?.message || e);
        break;
      }
    }
  }
  throw new Error('all-ai-routes-failed');
}

// Convenience for a single prompt (used by the helper orb).
export async function pollTextPrompt(prompt, opts) {
  return pollText([
    { role: 'system', content: SYSTEM },
    { role: 'user', content: String(prompt).slice(0, 4000) },
  ], opts);
}

// Streaming single-prompt convenience (helper orb) — same as pollTextPrompt but
// streams tokens via opts.onToken so the orb answer appears as it's generated.
export async function pollTextPromptStream(prompt, opts) {
  return pollTextStream([
    { role: 'system', content: SYSTEM },
    { role: 'user', content: String(prompt).slice(0, 4000) },
  ], opts);
}

// ── Images — the browser loads them DIRECTLY from Pollinations (no bytes
// through our server). pollImageShieldUrl is the same-origin fallback, used
// automatically by an <img onerror> handler if the direct host is blocked. ───
export function pollImageUrl(prompt, seed = Math.floor(Math.random() * 1e6), { w = 1024, h = 1024 } = {}) {
  return `${IMG_DIRECT}${encodeURIComponent(prompt)}?width=${w}&height=${h}&nologo=true&seed=${seed}&referrer=${encodeURIComponent(REFERRER)}`;
}
export function pollImageShieldUrl(prompt, seed = 0) {
  return `/api/ai/image?prompt=${encodeURIComponent(prompt)}&seed=${seed}`;
}
