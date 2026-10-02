// ZoFHub · ai-provider.js — the "which AI provider" picker on the AI page.
// ---------------------------------------------------------------------------
// Small and honest, like ai-settings.js. Its only job is to let the visitor
// CHOOSE a provider — and nothing is forced: the default is 'auto' (free), and
// the choice is read back by ai.js at send time. The picker never generates
// anything itself; it only records a preference in this browser.
//
// The Puter branch is deliberately explicit about cost, because Puter bills the
// visitor's own account: the per-model label comes from puter.ai.listModels()
// and is never flattened to a bare "free".

import { $ } from './utils.js';
import {
  getProvider, setProvider, getPuterModel, setPuterModel,
  puterListModels, costLabel,
} from './puter-ai.js';

const NOTE = {
  auto:        'Picks the best free option automatically. Nothing is sent to a paid service.',
  pollinations:'Free and keyless. Requests go from your browser straight to Pollinations — never through our servers.',
  puter:       'Runs on your own Puter account — you sign in on your first message. Some models spend your Puter credits (shown per model). Your chats go to Puter, not ZoFHub.',
  huggingface: 'Uses the free token you save below. Requests go straight to Hugging Face — never through our servers.',
};

const sel = $('#aiProvider');
const note = $('#aiProviderNote');
const puterWrap = $('#aiPuter');
const puterModelSel = $('#aiPuterModel');

if (sel) init();

function describe(p) { if (note) note.textContent = NOTE[p] || ''; }

function togglePuter(p) {
  if (!puterWrap) return;
  const on = p === 'puter';
  puterWrap.hidden = !on;
  if (on && !puterModelSel?.dataset.loaded) loadPuterModels();
}

// Live model list, populated the first time Puter is chosen. Failure is fine —
// the default "" option (Puter's own free tier) always works.
async function loadPuterModels() {
  if (!puterModelSel) return;
  puterModelSel.dataset.loaded = '1';
  let models = [];
  try { models = await puterListModels(); } catch { /* blocked/offline — default option stands */ }
  if (!models.length) return;
  const saved = getPuterModel();
  for (const m of models) {
    const opt = document.createElement('option');
    opt.value = m.id;
    opt.textContent = `${m.label} · ${costLabel(m)}`;
    puterModelSel.appendChild(opt);
  }
  if (saved && models.some((m) => m.id === saved)) puterModelSel.value = saved;
}

function init() {
  const current = getProvider();
  sel.value = current;
  describe(current);
  togglePuter(current);

  sel.addEventListener('change', () => {
    const p = sel.value;
    setProvider(p);
    describe(p);
    togglePuter(p);
  });

  puterModelSel?.addEventListener('change', () => setPuterModel(puterModelSel.value));
}
