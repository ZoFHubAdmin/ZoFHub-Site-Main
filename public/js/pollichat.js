// ZoFHub · pollichat.js — the /ai chat page ("PolliChat").
//
// Two AI providers, both reachable directly from THIS browser — never through
// our server:
//   • PolliChat (default) — a GET to https://text.pollinations.ai/<prompt>,
//     read with response.text(). No sign-in, no key, shared free tier.
//     See public/js/pollinations.js.
//   • Puter.js — the visitor's OWN Puter account, via puter.ai.chat(). Their
//     prompt, their sign-in, their usage allowance. See public/js/puter.js.
// Picking one in the switcher decides which of those two this page calls; it
// never changes what the floating orb (public/js/ai-helper.js) does, which
// stays on PolliChat only.
//
// Every saved conversation — from this page AND from the floating orb — lives
// in ONE place: store.chats (public/js/storage.js), so the sidebar's History
// list is the visitor's whole local AI history, however it started. Nothing
// here is sent anywhere by being saved; it is read back only by this browser.

import { $, $$, el, renderMarkdownLite, escapeHtml } from './utils.js';
import { askWithContext, describeFailure } from './pollinations.js?v=20261016';
import { askPuterWithContext, describePuterFailure } from './puter.js?v=20261025';
import { SYSTEM_PROMPT } from './ai-prompt.js';
import { store } from './storage.js';

const SYSTEM = SYSTEM_PROMPT;   // see public/js/ai-prompt.js

// The welcome card, rebuilt by render() whenever the conversation is empty. It
// mirrors the static copy in pollichat.html so the first paint and the rendered
// version are identical. Declared up here so init() may call render() safely.
const WELCOME = `
  <div class="ai-welcome">
    <div class="ai-welcome-mark"></div>
    <h2>What can I help you figure out today?</h2>
    <p>Ask a question, explore an idea, or get help with something you're building. Free to use.</p>
    <div class="ai-suggest">
      <button class="ai-suggest-card" data-prompt="Explain how artificial intelligence works in simple terms."><b>🧠 Understand AI</b><span>Explain a complex topic simply</span></button>
      <button class="ai-suggest-card" data-prompt="Give me three practical website ideas I could build as a beginner, with a small first version for each."><b>💡 Brainstorm ideas</b><span>Find something worth building</span></button>
      <button class="ai-suggest-card" data-prompt="Help me debug a coding problem. Start by asking me for the code and the error message."><b>💻 Coding help</b><span>Work through a technical problem</span></button>
      <button class="ai-suggest-card" data-prompt="Teach me one surprising science fact and explain why it is true."><b>🔭 Learn something</b><span>Explore a new subject</span></button>
    </div>
  </div>`;

// ===========================================================================
// Providers: switching the one line that decides which client respond() calls.
// Each provider carries its own ask() and describe() so a failure from either
// is explained in that provider's own voice, the same way pollinations.js and
// puter.js each carry their own describeFailure.
// ===========================================================================
const PROVIDERS = {
  pollichat: { id: 'pollichat', label: 'PolliChat', ask: askWithContext, describe: describeFailure },
  puter: { id: 'puter', label: 'Puter.js', ask: askPuterWithContext, describe: describePuterFailure },
};
const PROVIDER_KEY = 'pollichat:provider:v1';
function loadPreferredProvider() {
  try {
    const v = localStorage.getItem(PROVIDER_KEY);
    return PROVIDERS[v] ? v : 'pollichat';
  } catch { return 'pollichat'; }
}
function savePreferredProvider(id) {
  try { localStorage.setItem(PROVIDER_KEY, id); } catch {}
}
function statusLineFor(providerId) {
  // Never "unlimited": the PolliChat tier is free but rate-limited, and Puter
  // runs against the visitor's own account — both lines say only what each can
  // actually promise.
  return providerId === 'puter' ? 'AI ready · Puter.js (your account)' : 'AI ready · free tier';
}

// ===========================================================================
// Conversation history: EVERY saved chat, from this page and the floating
// orb, lives in store.chats (public/js/storage.js). `current` is just the one
// being viewed; it is not a second source of truth — persist() always writes
// straight back into that shared list.
// ===========================================================================
let current = null;             // { id, title, messages, provider }
let composing = false;
// The in-flight request, so a new message (or a page navigation) can cancel the
// one it supersedes instead of racing it. Without this, two overlapping sends
// resolve in arrival order and the OLDER answer can overwrite the newer one.
let inFlight = null;

function blankChat() {
  return { id: null, title: 'New chat', messages: [], provider: loadPreferredProvider() };
}

// A visitor who used this page before the History sidebar existed has their
// one conversation under the old single-chat key. Folded into store.chats once,
// as a real history entry, rather than silently discarded.
function migrateLegacySingleChat() {
  const LEGACY_KEY = 'pollichat:messages:v1';
  try {
    const raw = localStorage.getItem(LEGACY_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw);
    const valid = Array.isArray(saved)
      ? saved.filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
      : [];
    if (valid.length) {
      const title = valid.find(m => m.role === 'user')?.content || 'Chat';
      store.chats.save({
        id: 'pc_' + Date.now().toString(36),
        title: String(title).replace(/\s+/g, ' ').trim().slice(0, 48) || 'Chat',
        messages: valid,
        provider: 'pollichat',
        source: 'pollichat',
        ts: Date.now(),
      });
    }
  } catch { /* nothing to migrate, or storage is unavailable either way */ }
  try { localStorage.removeItem(LEGACY_KEY); } catch {}
}

function loadInitialChat() {
  const list = store.chats.list();
  if (!list.length) return blankChat();
  const c = list[0];
  return {
    id: c.id,
    title: c.title || 'Chat',
    messages: Array.isArray(c.messages) ? c.messages.map(m => ({ role: m.role, content: m.content })) : [],
    provider: PROVIDERS[c.provider] ? c.provider : loadPreferredProvider(),
  };
}

(function init() {
  migrateLegacySingleChat();
  current = loadInitialChat();
  render();                         // shows the restored conversation, or the welcome
  renderHistory();
  renderProviderSwitch();
  bindComposer();
  bindProviderSwitch();
  bindSideToggle();
  bindSuggestCards($('#aiMessages'));
  $('#aiNew')?.addEventListener('click', newChat);
  $('#aiClearAll')?.addEventListener('click', clearAllChats);
  setStatus(statusLineFor(current.provider));
  // Abandoning the page mid-answer should stop the request, not leave it
  // running against a document that is going away.
  window.addEventListener('pagehide', () => inFlight?.abort());
})();

function newChat() {
  if (composing) inFlight?.abort();
  current = blankChat();
  render();
  renderHistory();
  renderProviderSwitch();
  $('#aiInput')?.focus();
}

function loadChat(id) {
  if (id === current.id) return;
  const c = store.chats.get(id);
  if (!c) return;
  if (composing) inFlight?.abort();
  current = {
    id: c.id,
    title: c.title || 'Chat',
    messages: Array.isArray(c.messages) ? c.messages.map(m => ({ role: m.role, content: m.content })) : [],
    provider: PROVIDERS[c.provider] ? c.provider : loadPreferredProvider(),
  };
  // Continuing a saved chat continues it with the provider IT was using, and
  // that becomes the visitor's active choice too — so the switcher in the
  // sidebar reflects what this conversation will actually do next.
  savePreferredProvider(current.provider);
  composing = false; setSendBusy(false);
  render();
  renderHistory();
  renderProviderSwitch();
}

function deleteChat(id) {
  store.chats.remove(id);
  if (current.id === id) {
    if (composing) inFlight?.abort();
    current = blankChat();
    render();
  }
  renderHistory();
}

function clearAllChats() {
  if (!store.chats.list().length) return;
  if (!window.confirm('Delete every saved AI conversation on this device? This cannot be undone.')) return;
  store.chats.clear();
  if (composing) inFlight?.abort();
  current = blankChat();
  render();
  renderHistory();
}

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

// ===========================================================================
// Provider switcher
// ===========================================================================
function renderProviderSwitch() {
  $$('.ai-provider-btn').forEach(b => b.classList.toggle('active', b.dataset.provider === current.provider));
}
function bindProviderSwitch() {
  $$('.ai-provider-btn').forEach(b => b.addEventListener('click', () => {
    const id = b.dataset.provider;
    if (!PROVIDERS[id] || id === current.provider) return;
    current.provider = id;
    savePreferredProvider(id);
    if (current.id) persist();      // an existing chat remembers which provider it continues on
    renderProviderSwitch();
    setStatus(statusLineFor(id));
  }));
}

// ===========================================================================
// Sidebar toggle (mobile) — the sidebar is always visible on a wide screen;
// below that it is a drawer, opened from the topbar button.
// ===========================================================================
function bindSideToggle() {
  const toggle = $('#aiSideToggle');
  const side = $('#aiSide');
  if (!toggle || !side) return;
  const backdrop = el('div', { class: 'ai-side-backdrop' });
  document.body.appendChild(backdrop);
  const openSide = () => { side.classList.add('is-open'); backdrop.classList.add('is-open'); toggle.setAttribute('aria-expanded', 'true'); };
  const closeSide = () => { side.classList.remove('is-open'); backdrop.classList.remove('is-open'); toggle.setAttribute('aria-expanded', 'false'); };
  toggle.addEventListener('click', () => (side.classList.contains('is-open') ? closeSide() : openSide()));
  backdrop.addEventListener('click', closeSide);
  // Picking a chat or starting a new one on mobile should close the drawer
  // behind it, not leave it covering the answer that is about to render.
  side.addEventListener('click', (e) => {
    if (e.target.closest('.ai-history-item') || e.target.closest('#aiNew')) closeSide();
  });
}

// ===========================================================================
// History sidebar — every saved chat, most-recent first (store.chats already
// orders that way: save() unshifts).
// ===========================================================================
function renderHistory() {
  const wrap = $('#aiHistoryList'); if (!wrap) return;
  const list = store.chats.list();
  wrap.innerHTML = '';
  if (!list.length) {
    wrap.appendChild(el('p', { class: 'ai-history-empty' }, 'No saved chats yet.'));
    return;
  }
  for (const c of list) {
    const del = el('button', {
      class: 'ai-history-del', type: 'button',
      'aria-label': `Delete "${c.title || 'chat'}"`,
      onclick: (e) => { e.stopPropagation(); deleteChat(c.id); },
    }, '×');
    const item = el('div', {
      class: `ai-history-item${c.id === current.id ? ' active' : ''}`,
      role: 'button', tabindex: '0',
      onclick: () => loadChat(c.id),
      onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); loadChat(c.id); } },
    }, [el('span', { class: 'ai-history-title' }, c.title || 'Chat'), del]);
    wrap.appendChild(item);
  }
}

// Bounded chat context: our system prompt + the last 8 real turns. The prompt
// travels in a URL for PolliChat (a budget) and in an array for Puter (a
// request body), so both apply the SAME bound rather than one trimming harder.
function buildContext() {
  const history = current.messages
    .filter(m => !m.streaming && m.content)
    .slice(-8)
    .map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content).slice(0, 4000) }));
  return [{ role: 'system', content: SYSTEM }, ...history];
}

// ---- Client-side answer cache (localStorage) --------------------------------
// Before asking, check whether we have already answered this exact standalone
// question on THIS device, with THIS provider. Hit → instant, zero network.
// Keyed per-provider: the two providers answer in different voices, so a
// PolliChat answer must never be shown as if Puter had just produced it.
// Bounded so it cannot grow forever. Stays entirely on-device, like the rest
// of this page's state.
const AI_CACHE_KEY = 'zofhub:ai:cache:v1';
const AI_CACHE_MAX = 200;
const normQ = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
const cacheKey = (providerId, q) => `${providerId}::${normQ(q)}`;
function aiCacheGet(providerId, q) {
  if (!q || q.length < 12) return null;                 // skip short/contextual messages
  try { return (JSON.parse(localStorage.getItem(AI_CACHE_KEY) || '{}'))[cacheKey(providerId, q)] || null; }
  catch { return null; }
}
function aiCacheSet(providerId, q, answer) {
  if (!q || q.length < 12 || !answer) return;
  try {
    const m = JSON.parse(localStorage.getItem(AI_CACHE_KEY) || '{}');
    m[cacheKey(providerId, q)] = answer;
    const keys = Object.keys(m);
    if (keys.length > AI_CACHE_MAX) delete m[keys[0]];  // evict oldest to stay bounded
    localStorage.setItem(AI_CACHE_KEY, JSON.stringify(m));
  } catch { /* storage full/blocked → just skip caching */ }
}

function ensureChatStarted(firstUserText) {
  if (current.id) return;
  current.id = 'pc_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  current.title = String(firstUserText || 'New chat').replace(/\s+/g, ' ').trim().slice(0, 48) || 'New chat';
}

function persist() {
  if (!current.id) return;        // nothing to save until the first message creates it
  const keep = current.messages.filter(m => !m.streaming && m.content).slice(-40);
  store.chats.save({
    id: current.id, title: current.title, messages: keep,
    provider: current.provider, source: 'pollichat', ts: Date.now(),
  });
  renderHistory();
}

async function respond() {
  composing = true;
  setSendBusy(true);

  const provider = PROVIDERS[current.provider] || PROVIDERS.pollichat;
  const userMsg = (current.messages.filter(m => m.role === 'user').slice(-1)[0]?.content || '').trim();

  const reply = { role: 'assistant', content: '', streaming: true };
  current.messages.push(reply);
  render();

  const messages = buildContext();

  // Instant answer from THIS DEVICE's cache, for a standalone first turn only
  // (follow-ups depend on context, so they are never cache-served).
  const userTurns = current.messages.filter(m => m.role === 'user').length;
  const cachedAnswer = userTurns <= 1 ? aiCacheGet(provider.id, userMsg) : null;
  if (cachedAnswer) {
    setStatus('Answered instantly from this device');
    return done(reply, cachedAnswer);
  }

  // Supersede any request still running, then make this one cancellable.
  inFlight?.abort();
  const controller = new AbortController();
  inFlight = controller;

  try {
    const { text } = await provider.ask(messages, {
      signal: controller.signal,
      onStatus: setStatus,
    });
    if (userTurns <= 1) aiCacheSet(provider.id, userMsg, text);  // remember standalone Q→A
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
    console.warn('[ai]', provider.id, 'request failed:', e?.code || '', e?.message || e);

    // Drop the empty reply bubble so the notice stands alone.
    if (current.messages[current.messages.length - 1] === reply) current.messages.pop();
    render();

    // A genuine rate limit gets its own calm notice with a live countdown,
    // because it is temporary and the user only needs to know how long.
    if (e?.rateLimited) {
      showRateLimit(e.retryAfter || 15);
      finishTurn();
      return;
    }
    showError(provider.describe(e));
    finishTurn();
  } finally {
    if (inFlight === controller) inFlight = null;
  }
}

// What a failure says lives in pollinations.js / puter.js (describeFailure /
// describePuterFailure), so this page cannot describe the same error
// differently from the provider's own client.

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
  persist();
  setStatus(statusLineFor(current.provider));
  finishTurn();
}

// ===========================================================================
// Rendering + composer
// ===========================================================================
function render() {
  const wrap = $('#aiMessages'); if (!wrap) return;
  if (!current.messages.length) {
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
    // inserted as raw HTML; user text is escaped outright.
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
    // A new message invalidates any error notice still on screen.
    $('#aiMessages')?.querySelector('.ai-notice-row')?.remove();
    ensureChatStarted(text);
    current.messages.push({ role: 'user', content: text });
    persist();
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
// the chosen provider on their OWN connection, so this only guards against
// accidental double-sends tripping that visitor's own per-IP limit.
function startSendCooldown() {
  aiCooling = true;
  setSendBusy(true);
  clearTimeout(aiCooldownTimer);
  aiCooldownTimer = setTimeout(() => { aiCooling = false; setSendBusy(composing); }, 2500);
}
