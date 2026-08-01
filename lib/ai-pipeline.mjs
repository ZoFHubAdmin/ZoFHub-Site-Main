// lib/ai-pipeline.mjs — model priority, health tracking, and retry/backoff for
// the Pollinations text pipeline.
//
// WHAT THIS ADDS, AND WHAT IT DELIBERATELY DOES NOT REPLACE
// server.js already had the hard parts right: cache-first serving, per-IP rate
// limiting, a global concurrency gate, OpenAI-compatible POST with a GET
// fallback, cross-provider failover to AI Horde, and server-side key handling.
// This module fills the four gaps that were actually missing:
//
//   1. retries with exponential backoff (it made ONE attempt, then fell through)
//   2. per-model health tracking, so a model that just failed is skipped
//   3. a CONFIGURABLE model priority list (it was hardcoded to openai/openai-fast)
//   4. failure logging — the old code swallowed errors in silent `catch {}`
//
// ── MEASURED FACTS THAT SHAPED THIS (probed live, not assumed) ─────────────
// Requested primaries were checked against gen.pollinations.ai/v1/models (242
// models) and by issuing real completions:
//
//   vendouple/nemotron-3-ultra        NOT a valid id —
//   vendouple/nemotron-3-ultra:free   the real id; returned 200 in 846ms
//   MarcosFRG/glm-4.6v-flash          valid id, but 401 anonymous / 403 with our key
//
// The `:free` suffix is load-bearing. Using the id exactly as written in the
// spec would 401 on every request.
//
// More importantly: gen.pollinations.ai/v1/chat/completions is NOT usable with
// the credentials this deployment has. Anonymous access grants a very small
// allowance (one probe succeeded, subsequent ones returned 401), and our
// POLLINATIONS_PUBLIC_KEY (pk_…) returns 403 — recognised, but below the tier
// those models require. Counter-intuitively, sending the pk_ key as a Bearer
// token is WORSE than sending nothing: anonymous got 200 where the key got 403.
//
// Meanwhile text.pollinations.ai (what the site already used) returns 200 in
// ~770ms, with or without the token.
//
// So the endpoint order below is evidence-based rather than spec-literal: try
// the OpenAI-compatible endpoint first because it is the better API and will
// start working the moment a higher-tier key is set, but keep the endpoint that
// demonstrably works as the fallback. Swapping wholesale to gen.pollinations.ai
// would have replaced a working feature with a broken one.

const DEFAULT_PRIORITY = [
  // Requested primaries first, with the id CORRECTED to the one that exists.
  'vendouple/nemotron-3-ultra:free',
  'MarcosFRG/glm-4.6v-flash',
  // Then broadly-available models, so failover has somewhere to go.
  'openai-fast',
  'openai',
  'gemini-fast',
  'deepseek',
];

// Models the KEYLESS endpoint (text.pollinations.ai/openai) actually serves.
//
// This split is not tidiness, it is a bug fix found by end-to-end testing. The
// full priority list was tried against the keyless endpoint and the two
// requested primaries failed there — nemotron returned 404 (that endpoint has
// never heard of it) and glm returned 429 — burning the entire time budget
// before reaching openai-fast, which works. The request took 36s and fell
// through to AI Horde with an empty reply.
//
// The cause: text.pollinations.ai/models advertises exactly ONE model
// (openai-fast). The community-namespaced models live only on
// gen.pollinations.ai, which requires a key we do not have. Offering models an
// endpoint cannot serve is not failover, it is guaranteed latency.
const KEYLESS_MODELS = ['openai-fast', 'openai'];

/** The candidate list for the endpoint we will actually call.
 *  keyed=true  -> gen.pollinations.ai, full priority incl. the requested models
 *  keyed=false -> text.pollinations.ai, only what it serves */
export function candidateModels(keyed) {
  return keyed ? modelPriority() : [...KEYLESS_MODELS];
}

// Env-configurable, comma-separated. e.g.
//   AI_MODEL_PRIORITY="MarcosFRG/glm-4.6v-flash,openai-fast"
export function modelPriority() {
  const raw = (process.env.AI_MODEL_PRIORITY || '').trim();
  if (!raw) return [...DEFAULT_PRIORITY];
  const list = raw.split(',').map(s => s.trim()).filter(Boolean);
  return list.length ? list : [...DEFAULT_PRIORITY];
}

// ── Health tracking ────────────────────────────────────────────────────────
// A model that just failed is skipped for a cooldown window rather than retried
// on every request. Failures escalate the cooldown so a hard-down model backs
// off toward the cap instead of being probed continuously under load.
// 15s, not 60s, and only after a SECOND consecutive failure — see markFailure.
// Pollinations is a free shared service that blips constantly: within one test
// run openai-fast returned 402 and openai returned 502, and both returned 200
// again moments later. A design that sidelines a model for a minute on one blip
// spends most of its time avoiding models that work.
const HEALTH_BASE_COOLDOWN_MS = Number(process.env.AI_HEALTH_COOLDOWN_MS) || 15_000;
const SIDELINE_AFTER = Number(process.env.AI_SIDELINE_AFTER) || 2;
const HEALTH_MAX_COOLDOWN_MS = 15 * 60_000;
const health = new Map(); // model -> { failures, until, lastError }

export function isHealthy(model) {
  const h = health.get(model);
  return !h || Date.now() >= h.until;
}

export function markFailure(model, err) {
  const h = health.get(model) || { failures: 0, until: 0, lastError: null };
  h.failures += 1;
  h.lastError = String(err && err.message || err || 'unknown');
  // One failure is a blip; two in a row is a pattern. Record the first without
  // sidelining, so a momentary 502 does not cost us a working model.
  if (h.failures < SIDELINE_AFTER) {
    health.set(model, h);
    console.warn(`[ai] model "${model}" failed once (not sidelined): ${h.lastError}`);
    return;
  }
  // 15s, 30s, 60s, 120s, capped — escalating backoff for a genuinely down model.
  const cooldown = Math.min(HEALTH_MAX_COOLDOWN_MS,
    HEALTH_BASE_COOLDOWN_MS * Math.pow(2, Math.min(h.failures - SIDELINE_AFTER, 6)));
  h.until = Date.now() + cooldown;
  health.set(model, h);
  // Logged, not swallowed. A provider degrading silently is the failure mode
  // that makes "the AI is broken" impossible to diagnose from the outside.
  console.warn(`[ai] model "${model}" unhealthy (${h.failures}x, cooling ${Math.round(cooldown / 1000)}s): ${h.lastError}`);
}

export function markSuccess(model) {
  if (health.has(model)) {
    console.log(`[ai] model "${model}" recovered`);
    health.delete(model);
  }
}

/** Priority list filtered to models not currently cooling down. Never empty:
 *  if everything is unhealthy we return the full list, because refusing to try
 *  is strictly worse than trying something that might have recovered. */
export function healthyModels(candidates = modelPriority()) {
  const ok = candidates.filter(isHealthy);
  return ok.length ? ok : [...candidates];
}

/** Snapshot for observability (/api/ai/health). */
export function healthSnapshot() {
  const now = Date.now();
  return modelPriority().map(m => {
    const h = health.get(m);
    return {
      model: m,
      healthy: !h || now >= h.until,
      failures: h ? h.failures : 0,
      cooldownRemainingMs: h ? Math.max(0, h.until - now) : 0,
      lastError: h ? h.lastError : null,
    };
  });
}

// ── Retry with exponential backoff + jitter ────────────────────────────────
// Jitter matters: without it, every request that fails at the same moment
// retries at the same moment, and a struggling upstream gets a synchronised
// thundering herd instead of a spread-out load.
export async function withRetry(fn, {
  attempts = Number(process.env.AI_RETRY_ATTEMPTS) || 3,
  baseMs = Number(process.env.AI_RETRY_BASE_MS) || 400,
  maxMs = 4000,
  onRetry = null,
} = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn(i);
    } catch (e) {
      lastErr = e;
      // Do not burn retries on errors that will never succeed on repeat.
      if (!isTransient(e) || i === attempts - 1) break;
      const backoff = Math.min(maxMs, baseMs * Math.pow(2, i));
      const jitter = Math.random() * backoff * 0.3;
      if (onRetry) onRetry(i + 1, e);
      await sleep(backoff + jitter);
    }
  }
  throw lastErr;
}

/** 4xx (except 408/429) means the request itself is wrong — retrying an
 *  unauthorised or unknown-model call just wastes the user's time. */
export function isTransient(err) {
  const msg = String(err && err.message || err || '');
  const m = msg.match(/\b(\d{3})\b/);
  if (m) {
    const code = Number(m[1]);
    // 402 is included deliberately. On Pollinations it signals momentary
    // capacity/quota pressure rather than a permanent billing failure — the
    // same model returned 402 and then 200 seconds later in testing. Treating
    // it as fatal made the pipeline give up on a working model.
    if (code === 402 || code === 408 || code === 429) return true;
    if (code >= 400 && code < 500) return false;
    return code >= 500;
  }
  // Network-level faults are transient by nature.
  return /timeout|abort|ECONNRESET|ENOTFOUND|EAI_AGAIN|fetch failed|socket/i.test(msg);
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export default {
  modelPriority, candidateModels, healthyModels, isHealthy, markFailure,
  markSuccess, healthSnapshot, withRetry, isTransient,
};
