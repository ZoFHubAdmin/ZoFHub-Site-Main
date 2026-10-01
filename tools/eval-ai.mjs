#!/usr/bin/env node
// tools/eval-ai.mjs — run the AI evaluation set and decide whether to promote.
// ---------------------------------------------------------------------------
//   node tools/eval-ai.mjs --provider pollinations
//   node tools/eval-ai.mjs --provider huggingface --model meta-llama/Llama-3.1-8B-Instruct
//   node tools/eval-ai.mjs --provider pollinations --set-baseline
//
// WHY THIS EXISTS. Without it, "the new model seems better" is the whole
// promotion process. This produces a comparable number against a stored
// baseline and EXITS NON-ZERO when a change should not ship, so the decision
// can be a gate rather than an opinion.
//
// The Hugging Face path needs a token, and it is read from HF_TOKEN in the
// ENVIRONMENT — never from a file in the repo and never from a user's browser
// storage. This is an operator tool; user tokens belong to users.
//
// Baselines live in data/ai-eval-baseline.json, one per provider+model, so
// swapping models does not silently compare apples to oranges.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scoreCase, summarise, comparison } from '../lib/ai-eval.mjs';
import { resolveHfModel } from '../public/js/hf-models.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SET_PATH = join(ROOT, 'data', 'ai-eval-set.json');
const BASELINE_PATH = join(ROOT, 'data', 'ai-eval-baseline.json');

const args = process.argv.slice(2);
const flag = (name, dflt = null) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : dflt;
};
const has = (name) => args.includes(`--${name}`);

const PROVIDER = flag('provider', 'pollinations');
const MODEL = flag('model', '');
const SET_BASELINE = has('set-baseline');
const TIMEOUT_MS = Number(flag('timeout', '60000'));

// ── System prompt ──────────────────────────────────────────────────────────
// The eval must run under the SAME instructions production uses, or it measures
// a model the users never meet. Read from the real file rather than restated.
function systemPrompt() {
  try {
    const src = readFileSync(join(ROOT, 'public', 'js', 'ai-prompt.js'), 'utf8');
    const m = /export const SYSTEM_PROMPT\s*=\s*([`'"])([\s\S]*?)\1\s*;/.exec(src);
    if (m) return m[2];
  } catch { /* fall through */ }
  return 'You are a helpful assistant. Be accurate and concise. Never invent facts.';
}

// ── Providers ──────────────────────────────────────────────────────────────
async function askPollinations(messages) {
  const r = await fetch('https://text.pollinations.ai/openai', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'openai-fast', messages, reasoning_effort: 'low' }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();
  return j?.choices?.[0]?.message?.content || '';
}

async function askHuggingFace(messages, model) {
  const token = (process.env.HF_TOKEN || '').trim();
  if (!token) throw new Error('HF_TOKEN is not set in the environment');
  const { chatCompletion } = await import('@huggingface/inference');
  const r = await chatCompletion({
    accessToken: token,
    model: resolveHfModel(model),
    messages,
    max_tokens: 400,
    temperature: 0.7,
  }, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  return r?.choices?.[0]?.message?.content || '';
}

const ask = (messages) => (PROVIDER === 'huggingface'
  ? askHuggingFace(messages, MODEL)
  : askPollinations(messages));

// ── Run ────────────────────────────────────────────────────────────────────
const suite = JSON.parse(readFileSync(SET_PATH, 'utf8'));
const sys = systemPrompt();
const runKey = PROVIDER === 'huggingface' ? `huggingface:${resolveHfModel(MODEL)}` : 'pollinations:openai-fast';

console.log(`eval set ${suite.version} · ${suite.cases.length} cases · ${runKey}\n`);

const results = [];
for (const c of suite.cases) {
  const t0 = Date.now();
  let answer = '', error = null;
  try {
    answer = await ask([{ role: 'system', content: sys }, { role: 'user', content: c.prompt }]);
  } catch (e) {
    error = String(e?.message || e).slice(0, 80);
  }
  const ms = Date.now() - t0;
  // A PROVIDER failure is not a model failure. It is recorded as an error so it
  // cannot be mistaken for the model getting the answer wrong — that confusion
  // is precisely what would make an outage look like a quality regression and
  // block a perfectly good promotion.
  const scored = error ? { pass: false, detail: `provider error: ${error}` } : scoreCase(c.check, answer);
  results.push({
    id: c.id, category: c.category, pass: scored.pass, detail: scored.detail,
    ms, chars: answer.length, error,
  });
  const mark = error ? 'ERR ' : scored.pass ? 'pass' : 'FAIL';
  console.log(`  ${mark}  ${c.id.padEnd(22)} ${String(ms).padStart(6)}ms  ${scored.detail}`);
}

const summary = summarise(results);
console.log(`\npass ${summary.passed}/${summary.total}` +
  `  (${(summary.passRate * 100).toFixed(0)}%)  p50 ${summary.p50Ms}ms  p95 ${summary.p95Ms}ms  mean ${summary.meanChars} chars`);
for (const [cat, v] of Object.entries(summary.byCategory)) {
  console.log(`   ${cat.padEnd(22)} ${v.pass}/${v.total}`);
}

const providerErrors = results.filter((r) => r.error).length;
if (providerErrors) {
  console.log(`\n${providerErrors} case(s) failed because the PROVIDER errored, not the model.`);
}

// ── Baseline + promotion ───────────────────────────────────────────────────
let store = {};
if (existsSync(BASELINE_PATH)) {
  try { store = JSON.parse(readFileSync(BASELINE_PATH, 'utf8')); } catch { store = {}; }
}
const baseline = store[runKey] || null;

if (SET_BASELINE) {
  // Refuse to enshrine a run that was mostly the network failing — a baseline
  // recorded during an outage makes every later run look like an improvement.
  if (providerErrors > results.length / 4) {
    console.error(`\nREFUSING to set a baseline: ${providerErrors}/${results.length} cases hit provider errors.`);
    process.exit(1);
  }
  store[runKey] = { setVersion: suite.version, at: new Date().toISOString(), results, summary };
  mkdirSync(dirname(BASELINE_PATH), { recursive: true });
  writeFileSync(BASELINE_PATH, JSON.stringify(store, null, 2) + '\n');
  console.log(`\nbaseline for ${runKey} written to data/ai-eval-baseline.json`);
  process.exit(0);
}

const verdict = comparison(results, baseline);
console.log(`\n${verdict.promote ? 'PROMOTE' : 'DO NOT PROMOTE'} — ${verdict.reason}`);
if (verdict.regressions?.length) {
  console.log(`  regressed: ${verdict.regressions.map((r) => `${r.id} (${r.category})`).join(', ')}`);
}
if (verdict.improvements?.length) {
  console.log(`  improved:  ${verdict.improvements.map((r) => r.id).join(', ')}`);
}
if (!baseline) console.log('  (run again with --set-baseline to record this as the baseline)');

// Non-zero on a blocked promotion so this can be a CI gate rather than a report
// somebody reads. A missing baseline is informational, not a failure.
process.exit(verdict.promote || !baseline ? 0 : 1);
