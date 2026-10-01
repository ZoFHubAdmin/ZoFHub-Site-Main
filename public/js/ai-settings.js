// ZoFHub · ai-settings.js — the Hugging Face token panel on the AI page.
// ---------------------------------------------------------------------------
// Small on purpose. Its only job is to let somebody add an optional second AI
// provider and to be HONEST about where their token goes, because "paste a
// token here" is a request that deserves an answer to "and then what?".
//
// The answer, enforced by the code rather than the copy: the token is written
// to this browser's localStorage and read by public/js/hf-inference.js, which
// calls Hugging Face directly. It is never sent to a ZoFHub endpoint — there is
// no endpoint that accepts it — and the model list is fetched from our own
// /api/ai/providers so the menu can never offer something the allow-list in
// lib/hf-models.mjs would reject.

import { $ } from './utils.js';
import {
  getHfToken, setHfToken, clearHfToken, getHfModel, setHfModel,
} from './hf-inference.js';
import { looksLikeHfToken, HF_TEXT_MODELS, HF_DEFAULT_MODEL } from './hf-models.js';

const tokenInput = $('#aiHfToken');
const modelSelect = $('#aiHfModel');
const stateEl = $('#aiHfState');
const saveBtn = $('#aiHfSave');
const clearBtn = $('#aiHfClear');

if (tokenInput && modelSelect && stateEl) {
  init();
}

function setState(text, kind = '') {
  if (!stateEl) return;
  stateEl.textContent = text;
  stateEl.dataset.kind = kind;
}

/** Never render the token back into the DOM — show that one exists, not what it is. */
function describeStored() {
  const t = getHfToken();
  if (!t) return setState('Not set — using the default AI.', '');
  if (!looksLikeHfToken(t)) return setState('Saved token looks malformed — the default AI is being used.', 'warn');
  setState(`Active — Hugging Face is being used first (…${t.slice(-4)}).`, 'ok');
}

async function buildModelList() {
  // Prefer the server's catalogue so the menu follows whatever the deployment
  // actually allows; fall back to the shared module if the request fails, since
  // an offline settings panel should still work.
  let models = HF_TEXT_MODELS.map((m) => ({ id: m.id, label: m.label, params: m.params, providers: m.providers.length }));
  try {
    const r = await fetch('/api/ai/providers', { signal: AbortSignal.timeout(6000) });
    if (r.ok) {
      const j = await r.json();
      if (Array.isArray(j?.huggingface?.models) && j.huggingface.models.length) models = j.huggingface.models;
    }
  } catch { /* offline or blocked — the built-in list is fine */ }

  modelSelect.innerHTML = '';
  for (const m of models) {
    const opt = document.createElement('option');
    opt.value = m.id;
    // Provider count is the number that actually predicts reliability here, so
    // it is shown rather than hidden behind a tooltip.
    opt.textContent = `${m.label} · ${m.params}B · ${m.providers} provider${m.providers === 1 ? '' : 's'}`;
    modelSelect.appendChild(opt);
  }
  const saved = getHfModel();
  modelSelect.value = models.some((m) => m.id === saved) ? saved : HF_DEFAULT_MODEL;
}

function init() {
  tokenInput.value = '';                 // never prefill a secret
  tokenInput.placeholder = getHfToken() ? '•••••••• (saved)' : 'hf_…';
  describeStored();
  buildModelList();

  saveBtn?.addEventListener('click', () => {
    const raw = tokenInput.value.trim();
    // An empty box with a token already saved means "keep it, change the model".
    if (!raw && getHfToken()) {
      setHfModel(modelSelect.value);
      setState('Model updated.', 'ok');
      return;
    }
    if (!looksLikeHfToken(raw)) {
      setState('That does not look like a Hugging Face token (they start with hf_).', 'warn');
      return;
    }
    if (!setHfToken(raw) || !setHfModel(modelSelect.value)) {
      // Private mode and blocked storage are common on shared school machines.
      setState('This browser refused to store it (private mode?). The default AI still works.', 'warn');
      return;
    }
    tokenInput.value = '';
    tokenInput.placeholder = '•••••••• (saved)';
    describeStored();
  });

  clearBtn?.addEventListener('click', () => {
    clearHfToken();
    tokenInput.value = '';
    tokenInput.placeholder = 'hf_…';
    setState('Removed from this browser.', '');
  });

  modelSelect.addEventListener('change', () => {
    if (getHfToken()) { setHfModel(modelSelect.value); setState('Model updated.', 'ok'); }
  });
}
