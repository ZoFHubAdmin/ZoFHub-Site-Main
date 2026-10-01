// lib/hf-models.mjs — the Hugging Face model catalogue and routing policy.
// ---------------------------------------------------------------------------
// WHY THIS EXISTS. ZoFHub's AI had exactly one text provider (Pollinations),
// and measurement showed why that hurts: the streaming path returned an empty
// stream on 6 of 12 attempts, and the surviving fallback answered with a median
// of 32.5s. One provider means one bad afternoon is a dead feature.
//
// Hugging Face Inference Providers give a genuinely independent second path —
// different companies, different hardware, different failure modes. This file
// is the part of that which is policy rather than plumbing: WHICH models, in
// WHICH order, and what the caller is allowed to ask for.
//
// ── EVERY ENTRY WAS VERIFIED AGAINST THE LIVE HUB ─────────────────────────
// Each id below was checked with
//   GET https://huggingface.co/api/models/<id>?expand[]=inferenceProviderMapping
// and kept only if a provider reported status "live". That check is why
// HuggingFaceTB/SmolLM3-3B is NOT here despite being an obvious candidate: the
// model exists and looks fine, but no provider serves it, so offering it would
// mean shipping a menu entry that fails at request time. It remains a perfectly
// good LOCAL model (see public/js/ai.js) — a different execution path entirely.
//
// ── THE TOKEN NEVER TOUCHES THIS SERVER ───────────────────────────────────
// Hugging Face Inference requires an `hf_…` token; there is no anonymous tier
// (verified: a tokenless call fails with InferenceClientRoutingError). So the
// token is the USER'S OWN, entered in the AI settings, stored in their browser,
// and sent from their browser straight to Hugging Face. ZoFHub never receives
// it, never stores it, and never proxies the request — which also means the
// quota consumed is theirs, matching how the Pollinations path already works.
// This module therefore describes models; it never handles credentials.

/**
 * @typedef {object} HfModel
 * @property {string}   id         Hub id, exactly as the API expects it.
 * @property {string}   label      What a person sees.
 * @property {string[]} providers  Providers observed live at verification time.
 * @property {number}   params     Billions of parameters, for the size hint.
 * @property {string}   good_for   One honest sentence.
 * @property {boolean} [heavy]     Slower/pricier; not a default.
 */

/** @type {HfModel[]} */
export const HF_TEXT_MODELS = [
  {
    id: 'meta-llama/Llama-3.1-8B-Instruct',
    label: 'Llama 3.1 8B',
    providers: ['novita', 'nscale', 'featherless-ai', 'deepinfra'],
    params: 8,
    good_for: 'The default. Four independent providers, so a single one going down is survivable.',
  },
  {
    id: 'meta-llama/Llama-3.3-70B-Instruct',
    label: 'Llama 3.3 70B',
    providers: ['novita', 'together', 'featherless-ai', 'scaleway', 'ovhcloud'],
    params: 70,
    good_for: 'Best answer quality here, and the widest provider spread.',
    heavy: true,
  },
  {
    id: 'Qwen/Qwen2.5-Coder-32B-Instruct',
    label: 'Qwen2.5 Coder 32B',
    providers: ['nscale', 'featherless-ai'],
    params: 32,
    good_for: 'Code questions.',
    heavy: true,
  },
  {
    id: 'Qwen/Qwen2.5-7B-Instruct',
    label: 'Qwen2.5 7B',
    providers: ['featherless-ai'],
    params: 7,
    good_for: 'A small, quick general model.',
  },
  {
    id: 'google/gemma-2-2b-it',
    label: 'Gemma 2 2B',
    providers: ['featherless-ai'],
    params: 2,
    good_for: 'Lowest latency, simplest questions.',
  },
];

/** The id used when the caller expresses no preference. */
export const HF_DEFAULT_MODEL = 'meta-llama/Llama-3.1-8B-Instruct';

/**
 * Is this a model this deployment is willing to call?
 *
 * An ALLOW-LIST, not a format check. The model id travels from the browser, and
 * an arbitrary id would let a visitor point our documented AI feature at any
 * repository on the Hub — including one that bills their token unexpectedly, or
 * a `-uncensored` fork whose output would still appear inside ZoFHub's UI and
 * under ZoFHub's system prompt. Refusing an unknown id costs a menu entry;
 * accepting one costs editorial control over what the product says.
 */
export function isAllowedHfModel(id) {
  return HF_TEXT_MODELS.some((m) => m.id === id);
}

/** The model to use, given what the caller asked for. Never throws. */
export function resolveHfModel(requested) {
  const id = String(requested || '').trim();
  return isAllowedHfModel(id) ? id : HF_DEFAULT_MODEL;
}

/**
 * Order to try models in, for one request.
 *
 * Provider COUNT leads, not parameter count. When the goal is "the user gets an
 * answer at all", a model four companies serve is worth more than a larger one
 * behind a single provider — the single-provider model reproduces exactly the
 * fragility this whole integration exists to fix. The explicitly requested
 * model still goes first, because a deliberate choice outranks our heuristic.
 */
export function hfFailoverOrder(requested) {
  const first = resolveHfModel(requested);
  const rest = HF_TEXT_MODELS
    .filter((m) => m.id !== first && !m.heavy)
    .sort((a, b) => b.providers.length - a.providers.length)
    .map((m) => m.id);
  return [first, ...rest];
}

/**
 * The public shape of the catalogue, for GET /api/ai/providers.
 *
 * Deliberately excludes nothing sensitive because there is nothing sensitive to
 * exclude: no keys, no endpoints, no account identifiers. It is a menu.
 */
export function hfCatalogue() {
  return {
    provider: 'huggingface',
    // Stated so the UI can explain the requirement rather than silently failing:
    // Hugging Face has no anonymous inference tier.
    requiresUserToken: true,
    tokenStoredClientSideOnly: true,
    defaultModel: HF_DEFAULT_MODEL,
    models: HF_TEXT_MODELS.map(({ id, label, params, good_for, providers, heavy }) => ({
      id, label, params, good_for, providers: providers.length, heavy: !!heavy,
    })),
  };
}

/**
 * Does this look like a Hugging Face user access token?
 *
 * Shape only, checked in the BROWSER before a request is attempted, so an
 * obvious typo becomes an instant message instead of a failed round trip. It is
 * not a security control — the only thing that can truly validate a token is
 * Hugging Face — and this function must never be used as one.
 */
export function looksLikeHfToken(token) {
  const t = String(token || '').trim();
  return /^hf_[A-Za-z0-9]{16,}$/.test(t);
}

export default {
  HF_TEXT_MODELS, HF_DEFAULT_MODEL, isAllowedHfModel, resolveHfModel,
  hfFailoverOrder, hfCatalogue, looksLikeHfToken,
};
