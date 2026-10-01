// ZoFHub · hf-inference.js — Hugging Face as a second, independent AI provider.
// ---------------------------------------------------------------------------
// WHY THERE IS A SECOND PROVIDER AT ALL. The AI had one text backend. Measured
// over twelve sequential attempts against the real endpoint from a production
// origin, the streaming path produced an empty stream 6 times out of 12, and
// the surviving fallback answered with a median of 32.5 seconds. "Sometimes the
// AI doesn't respond" was not a mystery, it was a single point of failure with
// a slow understudy.
//
// Hugging Face Inference Providers route one request across several independent
// companies (novita, nscale, featherless-ai, deepinfra, …). That is real
// redundancy — different hardware, different outages — rather than a second URL
// on the same infrastructure.
//
// ── THE TOKEN IS THE USER'S, AND IT STAYS ON THEIR MACHINE ────────────────
// Hugging Face has no anonymous inference tier; this was verified rather than
// assumed (a tokenless call fails with InferenceClientRoutingError). So this
// provider is OPT-IN: the visitor pastes their own free token, it is kept in
// their own browser, and the request goes from their browser straight to
// Hugging Face. ZoFHub's server never sees the token, never stores it, and
// never relays the request. That also means the quota spent is theirs, which is
// the same arrangement the Pollinations path already uses — the AI is
// "unlimited" precisely because it is not funnelled through one shared IP.
//
// If no token is set this module reports itself unavailable and the existing
// provider chain is untouched. Nothing here can make the AI worse than it was.

import { HF_DEFAULT_MODEL, hfFailoverOrder, looksLikeHfToken } from './hf-models.js';

// Served from our own origin (see the /hf/ mount in server.js), NOT a CDN. A
// blocked cdn.jsdelivr.net is a realistic condition for this audience, and it
// must not be able to take the AI down.
const HF_MODULE = '/hf/index.js';

const TOKEN_KEY = 'zofhub:ai:hf-token:v1';
const MODEL_KEY = 'zofhub:ai:hf-model:v1';

let modulePromise = null;

/** Lazy, and only when actually used — this is ~1MB the AI page should not pay for up front. */
function loadHf() {
  if (!modulePromise) {
    modulePromise = import(HF_MODULE).catch((e) => {
      modulePromise = null;                 // let a later attempt retry
      throw new Error(`Hugging Face client unavailable: ${e?.message || e}`);
    });
  }
  return modulePromise;
}

// ── Token storage (browser-only, and deletable) ────────────────────────────
// Wrapped because storage throws in private mode and in a blocked-cookie state,
// and an AI page that crashes on a settings read is worse than one with no
// second provider.
export function getHfToken() {
  try { return localStorage.getItem(TOKEN_KEY) || ''; } catch { return ''; }
}
export function setHfToken(token) {
  const t = String(token || '').trim();
  try {
    if (!t) localStorage.removeItem(TOKEN_KEY);
    else localStorage.setItem(TOKEN_KEY, t);
    return true;
  } catch { return false; }
}
/** Deleting the token must actually delete it — this is the user's opt-out. */
export function clearHfToken() { return setHfToken(''); }

export function getHfModel() {
  try { return localStorage.getItem(MODEL_KEY) || HF_DEFAULT_MODEL; } catch { return HF_DEFAULT_MODEL; }
}
export function setHfModel(id) {
  try { localStorage.setItem(MODEL_KEY, String(id || HF_DEFAULT_MODEL)); return true; } catch { return false; }
}

/** Is this provider usable right now? Cheap, synchronous, no network. */
export function hfAvailable() {
  return looksLikeHfToken(getHfToken());
}

/**
 * Stream a chat completion from Hugging Face.
 *
 * Resolves with the full text. Calls onToken(partialText) as it arrives, with
 * the SAME contract as the Pollinations path so ai.js can treat the two
 * interchangeably rather than branching on provider.
 *
 * Tries each model in the failover order. A model that is rate limited or whose
 * provider is down moves to the next; an AUTH failure stops immediately,
 * because retrying a bad token against five models just burns thirty seconds to
 * reach the same answer.
 */
export async function hfChatStream(messages, { onToken, onStatus, signal, model } = {}) {
  const token = getHfToken();
  if (!looksLikeHfToken(token)) throw new Error('no-hf-token');

  const { InferenceClient } = await loadHf();
  const client = new InferenceClient(token);
  const order = hfFailoverOrder(model || getHfModel());

  let lastErr = null;
  for (const id of order) {
    if (signal?.aborted) throw new Error('aborted');
    try {
      onStatus?.('Thinking…');
      let full = '';
      const stream = client.chatCompletionStream(
        {
          model: id,
          messages,
          max_tokens: 800,
          temperature: 0.7,
        },
        { signal },
      );
      for await (const chunk of stream) {
        const delta = chunk?.choices?.[0]?.delta?.content;
        if (delta) { full += delta; onToken?.(full); }
      }
      full = full.trim();
      // An empty stream is a FAILURE, not an answer. This is the exact shape of
      // the Pollinations bug this provider exists to cover for, so it must not
      // be reproduced here by returning '' and calling it success.
      if (!full) { lastErr = new Error(`empty stream from ${id}`); continue; }
      return { text: full, model: id, provider: 'huggingface' };
    } catch (e) {
      lastErr = e;
      const msg = String(e?.message || e);
      if (signal?.aborted || /abort/i.test(msg)) throw new Error('aborted');
      // 401/403 is the token, not the model. Every other model will say the same.
      if (/\b401\b|\b403\b|unauthorized|forbidden|invalid.*token/i.test(msg)) {
        const err = new Error('hf-auth');
        err.cause = e;
        throw err;
      }
      // Anything else (429, 503, provider error, timeout) — try the next model.
    }
  }
  throw lastErr || new Error('hf-exhausted');
}

export default { hfAvailable, hfChatStream, getHfToken, setHfToken, clearHfToken, getHfModel, setHfModel };
