// ZoFHub · puter-ai.js — Puter.js as an OPT-IN, user-chosen AI provider.
// ---------------------------------------------------------------------------
// WHY IT LOOKS LIKE hf-inference.js. The AI page already treats providers as
// interchangeable adapters: each exposes a synchronous availability check and a
// streaming chat call with the SAME contract (messages in, {text, model,
// provider} out, onToken for live rendering), and each runs BROWSER-DIRECT —
// the request leaves the visitor's own machine and never touches a ZoFHub
// endpoint. Puter is one more of those. Nothing here reaches server.js, so the
// production AI guard (aiServerAllowed) is untouched by design.
//
// ── HONEST ABOUT COST. This is the important part. ──────────────────────────
// Puter.js works without the SITE holding an API key because it bills the
// END USER through their own Puter account ("User Pays"). So this provider is
// strictly OPT-IN, and it is NEVER labelled a flat "free": the first message
// opens Puter's own sign-in, and some models spend the user's Puter credits.
// We therefore:
//   • default to NO explicit model, letting Puter choose its own default
//     (its free/low-cost tier) rather than asserting a specific model is free;
//   • show whatever cost metadata puter.ai.listModels() reports, and label the
//     rest "cost varies" instead of guessing;
//   • force nothing: the provider choice defaults to 'auto', and Puter is used
//     only when the visitor picks it in AI settings.
// This mirrors the project's own rule (docs: FREE-FIRST / NO-SURPRISE-CHARGES):
// a model is called free only when its metadata says so.

export const PUTER_SDK_URL = 'https://js.puter.com/v2/';

const PROVIDER_KEY = 'zofhub:ai:provider:v1';   // 'auto' | 'pollinations' | 'puter' | 'huggingface'
const MODEL_KEY    = 'zofhub:ai:puter-model:v1';
export const PROVIDERS = Object.freeze(['auto', 'pollinations', 'puter', 'huggingface']);

// ── Stored, per-browser choice (wrapped: storage throws in private mode) ─────
// Single source of truth for "which provider did the visitor pick", imported by
// both ai.js (to route) and ai-provider.js (the picker UI).
export function getProvider() {
  try { const v = localStorage.getItem(PROVIDER_KEY); return PROVIDERS.includes(v) ? v : 'auto'; }
  catch { return 'auto'; }
}
export function setProvider(id) {
  const v = PROVIDERS.includes(id) ? id : 'auto';
  try { localStorage.setItem(PROVIDER_KEY, v); return true; } catch { return false; }
}

/** The chosen Puter model id, or '' meaning "let Puter use its own default". */
export function getPuterModel() {
  try { return localStorage.getItem(MODEL_KEY) || ''; } catch { return ''; }
}
export function setPuterModel(id) {
  try {
    const v = String(id || '').trim();
    if (!v) localStorage.removeItem(MODEL_KEY); else localStorage.setItem(MODEL_KEY, v);
    return true;
  } catch { return false; }
}

/** Is Puter the provider the visitor actively chose? Cheap, synchronous, no network. */
export function puterAvailable() {
  return getProvider() === 'puter';
}

// ── Pure helpers (unit-tested; no DOM, no window) ───────────────────────────

// Puter's streaming yields chunks shaped `{ text }`; some underlying providers
// instead surface `{ message: { content } }` or an OpenAI-style delta. Non-
// streaming returns an object whose text is on `.message.content` (or is just a
// string). One extractor handles every shape so a provider change upstream
// can't silently empty the reply.
export function extractChunkText(chunk) {
  if (chunk == null) return '';
  if (typeof chunk === 'string') return chunk;
  if (typeof chunk.text === 'string') return chunk.text;
  const delta = chunk?.choices?.[0]?.delta?.content;
  if (typeof delta === 'string') return delta;
  const msg = chunk?.message?.content;
  if (typeof msg === 'string') return msg;
  if (Array.isArray(msg)) return msg.map((p) => (typeof p?.text === 'string' ? p.text : '')).join('');
  return '';
}

// A model is called "Free" ONLY when its own metadata says so; anything else is
// "Credits" (a known cost) or "Cost varies" (unknown). Never a bare "Free".
export function costLabel(model) {
  if (!model || typeof model !== 'object') return 'Cost varies';
  if (model.free === true || /(^|[^a-z])free([^a-z]|$)/i.test(String(model.cost || model.pricing || ''))) return 'Free';
  if (model.cost != null || model.pricing != null) return 'Credits';
  return 'Cost varies';
}

// Free-first: prefer a model whose metadata marks it free; otherwise '' so the
// caller falls back to Puter's own default rather than forcing a paid model.
export function freeFirstModel(models) {
  if (!Array.isArray(models)) return '';
  const free = models.find((m) => costLabel(m) === 'Free');
  return free ? String(free.id || '') : '';
}

// Normalise whatever puter.ai.listModels() returns into [{id, label, cost}].
// Its exact shape is not a contract, so this is defensive: accept an array of
// strings or of objects, and an object keyed by id.
export function normalizeModels(raw) {
  const out = [];
  const push = (id, meta) => {
    const s = String(id || '').trim();
    if (!s || out.some((m) => m.id === s)) return;
    const m = meta && typeof meta === 'object' ? meta : {};
    out.push({ id: s, label: String(m.name || m.label || s), free: m.free === true,
      cost: m.cost ?? m.pricing ?? null, provider: m.provider || m.publisher || '' });
  };
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (typeof item === 'string') push(item);
      else if (item && typeof item === 'object') push(item.id || item.model || item.name, item);
    }
  } else if (raw && typeof raw === 'object') {
    for (const [k, v] of Object.entries(raw)) push(k, v);
  }
  return out.slice(0, 200);
}

// Keep only the roles chat backends accept, coerce content to a bounded string.
export function toPuterMessages(messages) {
  if (!Array.isArray(messages)) return [];
  return messages
    .filter((m) => m && typeof m.content === 'string' && m.content.trim())
    .map((m) => ({
      role: ['system', 'user', 'assistant'].includes(m.role) ? m.role : 'user',
      content: String(m.content).slice(0, 8000),
    }))
    .slice(-16);
}

// ── Live SDK (impure; feature-detected and always fallible) ─────────────────

let sdkPromise = null;
/** Inject the Puter SDK once, on first real use — the AI page shouldn't pay for it otherwise. */
function loadPuter() {
  if (typeof window !== 'undefined' && window.puter?.ai) return Promise.resolve(window.puter);
  if (sdkPromise) return sdkPromise;
  sdkPromise = new Promise((resolve, reject) => {
    if (typeof document === 'undefined') { reject(new Error('no-dom')); return; }
    const done = () => (window.puter?.ai ? resolve(window.puter) : reject(new Error('puter-sdk-no-ai')));
    const existing = document.querySelector(`script[src="${PUTER_SDK_URL}"]`);
    if (existing) { existing.addEventListener('load', done, { once: true }); existing.addEventListener('error', () => reject(new Error('puter-sdk-blocked')), { once: true }); if (window.puter) done(); return; }
    const s = document.createElement('script');
    s.src = PUTER_SDK_URL; s.async = true;
    s.onload = done;
    s.onerror = () => { sdkPromise = null; reject(new Error('puter-sdk-blocked')); };
    document.head.appendChild(s);
  });
  return sdkPromise;
}

/** Best-effort live model list for the picker; [] if the SDK is blocked or the call fails. */
export async function puterListModels() {
  try {
    const puter = await loadPuter();
    const raw = await puter.ai.listModels();
    return normalizeModels(raw);
  } catch { return []; }
}

/**
 * Stream a chat completion from Puter — same contract as hfChatStream.
 * Resolves { text, model, provider:'puter' }; calls onToken(fullSoFar) live.
 * An empty reply is treated as a FAILURE (as the HF adapter does), so ai.js
 * falls through to the next provider instead of showing a blank bubble.
 */
export async function puterChatStream(messages, { onToken, onStatus, signal, model } = {}) {
  onStatus?.('Connecting to Puter…');
  const puter = await loadPuter();
  const chosen = (model || getPuterModel() || '').trim();
  const opts = { stream: true };
  if (chosen) opts.model = chosen;          // no model → Puter uses its own (free/default) choice

  onStatus?.('Thinking…');
  let full = '';
  const resp = await puter.ai.chat(toPuterMessages(messages), opts);
  // Streaming responses are async-iterable; a non-streaming object is not.
  if (resp && typeof resp[Symbol.asyncIterator] === 'function') {
    for await (const part of resp) {
      if (signal?.aborted) throw new Error('aborted');
      const t = extractChunkText(part);
      if (t) { full += t; onToken?.(full); }
    }
  } else {
    full = extractChunkText(resp);
    if (full) onToken?.(full);
  }
  full = full.trim();
  if (!full) throw new Error('puter-empty');
  return { text: full, model: chosen || 'puter-default', provider: 'puter' };
}

/**
 * Text-to-image via Puter. Returns a usable image src (Puter resolves an
 * <img> element; we hand back its .src so ai.js can preload it like any other).
 * testMode avoids spending the user's credits while trying it out.
 */
export async function puterImageSrc(prompt, { testMode = false } = {}) {
  const puter = await loadPuter();
  const img = await puter.ai.txt2img(String(prompt || '').slice(0, 1000), testMode === true);
  const src = typeof img === 'string' ? img : (img && img.src) || '';
  if (!src) throw new Error('puter-image-empty');
  return src;
}

export default {
  PUTER_SDK_URL, PROVIDERS, getProvider, setProvider, getPuterModel, setPuterModel,
  puterAvailable, puterListModels, puterChatStream, puterImageSrc,
  extractChunkText, costLabel, freeFirstModel, normalizeModels, toPuterMessages,
};
