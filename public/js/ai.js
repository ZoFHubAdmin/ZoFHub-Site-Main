// ZoFHub · ai.js — the /ai chat page.
//
// Every answer on this page comes from ONE place: a GET to
// https://text.pollinations.ai/<prompt>, made by this browser, read with
// response.text(). See public/js/pollinations.js for the request itself and for
// the evidence that its response is readable cross-origin.
//
// ── WHAT THIS PAGE USED TO DO, AND NO LONGER DOES ──────────────────────────
// · FOUR competing providers — Pollinations text, Pollinations image generation,
//   Hugging Face (the visitor's own token) and Puter.js (the visitor's own
//   account, billed to their credits) — behind a picker that asked visitors to
//   choose between failure modes they had no way to compare. One provider now.
// · AI IMAGE GENERATION, end to end: the /image /img /draw commands, the
//   rendering branch, the image models and the server route. Not a feature of
//   this site. (Ordinary site images are untouched; they were never this.)
// · AN ON-DEVICE MODEL. A Transformers.js + SmolLM2-360M fallback downloaded
//   hundreds of megabytes to answer, in a markedly worse voice, the question
//   the user had just asked the real model — and it ran whenever the network
//   call failed for ANY reason, so an outage looked like the AI had quietly got
//   much worse rather than like an outage. A clear, retryable error is the
//   honest outcome, so that is what happens now.
// · A SERVER HOP on localhost (POST /api/ai/text). That route no longer exists.

import { $, $$, el, renderMarkdownLite, escapeHtml } from './utils.js';
import { store } from './storage.js';
import { askWithContext, describeFailure } from './pollinations.js?v=20261016';
import { SYSTEM_PROMPT } from './ai-prompt.js';

const SYSTEM = SYSTEM_PROMPT;   // see public/js/ai-prompt.js

let current = null;
let composing = false;
// The in-flight request, so a new message (or a page navigation) can cancel the
// one it supersedes instead of racing it. Without this, two overlapping sends
// resolve in arrival order and the OLDER answer can overwrite the newer one.
let inFlight = null;

(function init() {
  loadHistory();
  $('#aiNew')?.addEventListener('click', newChat);
  $('#aiClearAll')?.addEventListener('click', clearAllChats);
  bindComposer();
  bindSuggestCards($('#aiMessages'));
  setStatus('AI ready · free tier');
  // Abandoning the page mid-answer should stop the request, not leave it
  // running against a document that is going away.
  window.addEventListener('pagehide', () => inFlight?.abort());
})();

function setStatus(text) {
  const s = $('#aiEngineStatus');
  if (s) s.textContent = text;
}

function bindSuggestCards(scope) {
  $$('.ai-suggest-card', scope || document).forEach(c => c.addEventListener('click', () => {
    const p = c.dataset.prompt || c.textContent;
    const i = $('#aiInput'); if (i) { i.value = p; i.focus(); autoSize(i); }
  }));
}

// Bounded chat context: our system prompt + the last 8 real turns. The prompt
// travels in a URL, so this is a budget — pollinations.js trims again to fit.
function buildContext() {
  const history = current.messages
    .filter(m => !m.streaming && m.content)
    .slice(-8)
    .map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content).slice(0, 4000) }));
  return [{ role: 'system', content: SYSTEM }, ...history];
}

// ---- Client-side answer cache (localStorage) --------------------------------
// Before asking, check whether we have already answered this exact standalone
// question on THIS device. Hit → instant, zero network. Bounded so it cannot
// grow forever. Stays entirely on-device, like the rest of this page's state.
const AI_CACHE_KEY = 'zofhub:ai:cache:v1';
const AI_CACHE_MAX = 200;
const normQ = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
function aiCacheGet(q) {
  if (!q || q.length < 12) return null;                 // skip short/contextual messages
  try { return (JSON.parse(localStorage.getItem(AI_CACHE_KEY) || '{}'))[normQ(q)] || null; }
  catch { return null; }
}
function aiCacheSet(q, answer) {
  if (!q || q.length < 12 || !answer) return;
  try {
    const m = JSON.parse(localStorage.getItem(AI_CACHE_KEY) || '{}');
    m[normQ(q)] = answer;
    const keys = Object.keys(m);
    if (keys.length > AI_CACHE_MAX) delete m[keys[0]];  // evict oldest to stay bounded
    localStorage.setItem(AI_CACHE_KEY, JSON.stringify(m));
  } catch { /* storage full/blocked → just skip caching */ }
}

async function respond() {
  composing = true;
  setSendBusy(true);

  const userMsg = (current.messages.filter(m => m.role === 'user').slice(-1)[0]?.content || '').trim();

  const reply = { role: 'assistant', content: '', streaming: true };
  current.messages.push(reply);
  render();

  const messages = buildContext();

  // Instant answer from THIS DEVICE's cache, for a standalone first turn only
  // (follow-ups depend on context, so they are never cache-served).
  const userTurns = current.messages.filter(m => m.role === 'user').length;
  const cachedAnswer = userTurns <= 1 ? aiCacheGet(userMsg) : null;
  if (cachedAnswer) {
    setStatus('Answered instantly from this device');
    return done(reply, cachedAnswer);
  }

  // Supersede any request still running, then make this one cancellable.
  inFlight?.abort();
  const controller = new AbortController();
  inFlight = controller;

  try {
    const { text } = await askWithContext(messages, {
      signal: controller.signal,
      onStatus: setStatus,
    });
    if (userTurns <= 1) aiCacheSet(userMsg, text);       // remember standalone Q→A
    return done(reply, text);
  } catch (e) {
    // A cancelled request was replaced by a newer one (or the page is leaving).
    // Its bubble is removed and nothing is reported — the newer send owns the UI.
    if (e?.code === 'cancelled') {
      if (current.messages[current.messages.length - 1] === reply) current.messages.pop();
      render();
      // Normally a newer respond() did the aborting and now owns `composing`,
      // the Send button and the next finishTurn(). If NOTHING replaced us —
      // inFlight is still our controller, which is what pagehide does — then
      // nobody is going to release the composer, so do it here rather than
      // leave Send disabled for good.
      if (inFlight === controller) { composing = false; setSendBusy(false); }
      return;
    }
    console.warn('[ai] request failed:', e?.code || '', e?.message || e);

    // Drop the empty streaming bubble so the notice stands alone.
    if (current.messages[current.messages.length - 1] === reply) current.messages.pop();
    render();

    // A genuine rate limit gets its own calm notice with a live countdown,
    // because it is temporary and the user only needs to know how long.
    if (e?.rateLimited) {
      showRateLimit(e.retryAfter || 15);
      finishTurn();
      return;
    }
    showError(describeFailure(e));
    finishTurn();
  } finally {
    if (inFlight === controller) inFlight = null;
  }
}

// What a failure says lives in pollinations.js (describeFailure), so this page
// and the floating assistant cannot describe the same error differently.

// ── Error notice, with a Retry that re-sends the same message ──────────────
// Transient UI: not stored in chat history, and only ever one at a time.
function showError(message) {
  const wrap = $('#aiMessages'); if (!wrap) return;
  wrap.querySelector('.ai-notice-row')?.remove();

  const row = el('div', { class: 'msg assistant ai-notice-row' });
  const bubble = el('div', { class: 'ai-notice' });
  const icon = el('span', { class: 'ai-notice-icon', 'aria-hidden': 'true' });
  icon.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 8v4M12 16h.01"/></svg>';
  const text = el('div', { class: 'ai-notice-text' });
  text.textContent = message;                    // textContent: never markup
  const retry = el('button', { class: 'ai-rl-btn ready', type: 'button' });
  retry.textContent = 'Try again';
  retry.addEventListener('click', () => { row.remove(); respond(); });

  bubble.appendChild(icon);
  bubble.appendChild(text);
  bubble.appendChild(retry);
  const body = el('div', { class: 'msg-body' });
  body.appendChild(bubble);
  const av = el('div', { class: 'msg-av' });
  av.textContent = 'AI';
  row.appendChild(av);
  row.appendChild(body);
  wrap.appendChild(row);
  wrap.scrollTop = wrap.scrollHeight;
  setStatus('Tap Try again to retry');
}

// ── Styled "you hit the rate limit" notice ─────────────────────────────────
// Shown ONLY on a genuine 429. A calm amber card (not a red error) with a live
// countdown and a Retry button that arms when the window clears. Locks the
// composer for the countdown so an instant resend can't immediately re-trip it.
function showRateLimit(seconds) {
  const wrap = $('#aiMessages'); if (!wrap) return;
  wrap.querySelector('.ai-ratelimit-row')?.remove();   // only ever one at a time
  const total = Math.max(5, Math.min(120, Math.round(seconds) || 15));

  aiCooling = true; setSendBusy(true);

  const row = el('div', { class: 'msg assistant ai-ratelimit-row' });
  row.innerHTML = `
    <div class="msg-av">AI</div>
    <div class="msg-body">
      <div class="ai-ratelimit" role="status" aria-live="polite">
        <span class="ai-rl-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2h12M6 22h12M6 2v5a6 6 0 0 0 6 6 6 6 0 0 0 6-6V2M6 22v-5a6 6 0 0 1 6-6 6 6 0 0 1 6 6v5"/></svg>
        </span>
        <div class="ai-rl-text">
          <b>You've reached the AI's rate limit</b>
          <span>The free AI is shared and only allows a few messages in a short window. It'll be ready again in <b class="ai-rl-count">${total}s</b>.</span>
        </div>
        <div class="ai-rl-actions">
          <button class="ai-rl-btn ai-rl-retry" type="button" disabled>Retry in ${total}s</button>
        </div>
      </div>
    </div>`;
  wrap.appendChild(row);
  wrap.scrollTop = wrap.scrollHeight;

  const countEl = row.querySelector('.ai-rl-count');
  const retryBtn = row.querySelector('.ai-rl-retry');
  let left = total;
  const arm = () => {
    if (countEl) countEl.textContent = 'now';
    retryBtn.disabled = false;
    retryBtn.textContent = 'Retry now';
    retryBtn.classList.add('ready');
    aiCooling = false; setSendBusy(composing);
  };
  const tick = setInterval(() => {
    left -= 1;
    if (left <= 0) { clearInterval(tick); arm(); }
    else { if (countEl) countEl.textContent = left + 's'; retryBtn.textContent = `Retry in ${left}s`; }
  }, 1000);

  retryBtn.addEventListener('click', () => {
    if (retryBtn.disabled) return;
    clearInterval(tick);
    row.remove();
    respond();
  });
}

function done(reply, txt) {
  reply.content = txt; reply.streaming = false; render();
  // "free & unlimited" used to be claimed here. It was not true: the anonymous
  // tier is free but rate-limited, so the status line says what it can promise.
  setStatus('AI ready · free tier');
  finishTurn();
}

// ===========================================================================
// Chat state, history, rendering, composer
// ===========================================================================
function newChat() {
  current = { id: `c_${Date.now().toString(36)}`, title: 'New chat', messages: [] };
  render();
  loadHistory();
  $('#aiInput')?.focus();
}

function loadHistory() {
  const wrap = $('#aiHistory'); if (!wrap) return;
  wrap.innerHTML = '';
  const chats = store.chats.list();
  const clearBtn = $('#aiClearAll');
  if (clearBtn) clearBtn.hidden = chats.length === 0;
  for (const c of chats) {
    const item = el('div', { class: `ai-history-item${current?.id === c.id ? ' active' : ''}`, title: c.title });
    const label = el('span', { class: 'ai-history-title' });
    label.textContent = c.title || 'Untitled';
    const del = el('button', { class: 'ai-history-del', type: 'button', title: 'Delete chat', 'aria-label': 'Delete chat' });
    del.innerHTML = '&times;';
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      store.chats.remove(c.id);
      if (current && current.id === c.id) { current = null; render(); }
      loadHistory();
    });
    item.appendChild(label);
    item.appendChild(del);
    item.addEventListener('click', () => { current = c; render(); loadHistory(); });
    wrap.appendChild(item);
  }
}

function clearAllChats() {
  if (!store.chats.list().length) return;
  const ok = (typeof confirm === 'function') ? confirm('Delete all chats? This cannot be undone.') : true;
  if (!ok) return;
  store.chats.clear();
  current = null;
  render();
  loadHistory();
}

const WELCOME = `
  <div class="ai-welcome">
    <div class="ai-welcome-mark"></div>
    <h2>ZoFHub AI</h2>
    <p>Ask anything — homework help, brainstorming, writing, code. Free to use.</p>
    <div class="ai-suggest">
      <button class="ai-suggest-card" data-prompt="Explain photosynthesis like I'm 10."><b>Explain</b><span>Photosynthesis, but simple</span></button>
      <button class="ai-suggest-card" data-prompt="Give me 5 fun game ideas to try on ZoFHub."><b>Ideas</b><span>What should I play?</span></button>
      <button class="ai-suggest-card" data-prompt="Write a JavaScript function that shuffles an array."><b>Code</b><span>Write some code</span></button>
    </div>
  </div>`;

function render() {
  const wrap = $('#aiMessages'); if (!wrap) return;
  if (!current || !current.messages.length) {
    wrap.innerHTML = WELCOME;
    bindSuggestCards(wrap);
    return;
  }
  wrap.innerHTML = '';
  current.messages.forEach(m => wrap.appendChild(messageRow(m)));
  wrap.scrollTop = wrap.scrollHeight;
}

function messageRow(m) {
  const row = el('div', { class: `msg ${m.role}` });
  let body;
  if (m.streaming) {
    body = '<span class="typing-dots"><span></span><span></span><span></span></span>';
  } else {
    // The model's output goes through renderMarkdownLite, which escapes HTML
    // before it applies its own small set of inline rules. A reply is never
    // inserted as raw HTML.
    body = m.role === 'assistant' ? renderMarkdownLite(m.content) : escapeHtml(m.content);
  }
  row.innerHTML = `<div class="msg-av">${m.role === 'user' ? 'You' : 'AI'}</div><div class="msg-body">${body}</div>`;
  return row;
}

function bindComposer() {
  const form = $('#aiForm'); const input = $('#aiInput');
  if (!form || !input) return;
  input.addEventListener('input', () => autoSize(input));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); }
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text || composing || aiCooling) return;
    if (!current) newChat();
    // A new message invalidates any error notice still on screen.
    $('#aiMessages')?.querySelector('.ai-notice-row')?.remove();
    current.messages.push({ role: 'user', content: text });
    if (current.title === 'New chat') current.title = text.slice(0, 40);
    input.value = ''; autoSize(input);
    render();
    startSendCooldown();
    await respond();
  });
}

function autoSize(input) {
  input.style.height = 'auto';
  input.style.height = Math.min(180, input.scrollHeight) + 'px';
}

function finishTurn() {
  composing = false;
  setSendBusy(false);
  store.chats.save(current);
  loadHistory();
}

let aiCooling = false;
let aiCooldownTimer = null;
function setSendBusy(busy) {
  const b = $('#aiSend'); if (!b) return;
  const lock = busy || aiCooling;
  b.disabled = lock; b.style.opacity = lock ? .5 : 1;
  b.classList.toggle('is-cooldown', aiCooling);
}
// Light throttle: lock Send for 2.5s after each prompt. Each visitor calls
// Pollinations on their OWN connection, so this only guards against accidental
// double-sends tripping that visitor's own per-IP limit.
function startSendCooldown() {
  aiCooling = true;
  setSendBusy(true);
  clearTimeout(aiCooldownTimer);
  aiCooldownTimer = setTimeout(() => { aiCooling = false; setSendBusy(composing); }, 2500);
}
