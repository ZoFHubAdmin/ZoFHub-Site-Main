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
//
// /image <description> makes a picture instead of a reply. It is Pollinations
// only, whichever text provider is selected, and it is one <img> pointed at
// https://image.pollinations.ai/<prompt> — the picture goes from the provider to
// this browser and never through our server. See public/js/pollinations-image.js.
//
// Two waits, both from public/js/ai-cooldown.js and both kept across reloads:
// 18 s after every text message, 50 s after every picture request. They are
// independent — a picture does not make you wait to ask a question.

import { $, $$, el, renderMarkdownLite, escapeHtml } from './utils.js';
import { askWithContext, describeFailure } from './pollinations.js?v=20261016';
import {
  askPuterWithContext, describePuterFailure, puterReady, preloadPuter, puterSignInState,
  puterUsername, startPuterSignIn, signOutOfPuter,
} from './puter.js?v=20261104';
import {
  parseImageCommand, buildImageUrl, loadImage, diagnoseImageFailure, describeImageFailure, IMAGE_USAGE,
} from './pollinations-image.js?v=20261104';
import { cooldowns, formatWait, TEXT_COOLDOWN_MS, IMAGE_COOLDOWN_MS } from './ai-cooldown.js?v=20261104';
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
      <button class="ai-suggest-card ai-suggest-card--wide" data-prompt="/image a neon fox running through a snowy forest at night"><b>🎨 Make a picture</b><span>Type /image and describe what you want to see</span></button>
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
// Puter account panel (declared up here because init() reaches it before the code that uses it).
const PUTER_BLOCKED_NOTE = 'Your browser blocked the sign-in window. Click “Continue” in the Puter dialog to open it.';
let puterLoad = 'idle';         // 'idle' | 'loading' | 'ready' | 'failed' — the SDK download, not the sign-in
let puterPanelSeq = 0;          // drops a stale async paint when two refreshes overlap
// The in-flight request, so a new message (or a page navigation) can cancel the
// one it supersedes instead of racing it. Without this, two overlapping sends
// resolve in arrival order and the OLDER answer can overwrite the newer one.
let inFlight = null;
// The picture being made, if any. Separate from `composing`/`inFlight`: a text
// answer and a picture are different requests to different endpoints.
let imageBusy = false;
let imageInFlight = null;

// Composer / countdown state. Declared here, ABOVE init(), because init() runs
// at module load and calls refreshComposer(): a `const` or `let` further down the
// file would still be in its temporal dead zone at that point and throw.
const HINT_DEFAULT = 'Enter to send · Shift+Enter for newline · /image and a description makes a picture';
const cooldownWatchers = new Set();          // retry buttons that count down on their own
const lastCooling = { text: false, image: false };
const imageCards = new WeakMap();            // assistant picture message -> its DOM card
let tickTimer = null;
let hintOverride = '';
let hintTimer = null;

function blankChat() {
  return { id: null, title: 'New chat', messages: [], provider: loadPreferredProvider() };
}

// A saved message comes back as plain data. Only the fields this page itself
// writes survive the round trip, so a hand-edited localStorage entry cannot put
// a class name, a URL or an image source into the page.
function restoreMessages(list) {
  return (Array.isArray(list) ? list : [])
    .filter((m) => m && typeof m.content === 'string')
    .map((m) => {
      const out = { role: m.role === 'user' ? 'user' : 'assistant', content: m.content };
      if (m.kind === 'image') {
        out.kind = 'image';
        if (out.role === 'assistant') out.imageState = 'done';
      }
      return out;
    });
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
    messages: restoreMessages(c.messages),
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
  bindPuterPanel();
  bindSideToggle();
  bindSuggestCards($('#aiMessages'));
  $('#aiNew')?.addEventListener('click', newChat);
  $('#aiClearAll')?.addEventListener('click', clearAllChats);
  setStatus(statusLineFor(current.provider));
  // A wait that was still running when the page was left is still running now,
  // so a reload does not hand back a free request.
  refreshComposer();
  // Abandoning the page mid-answer should stop the request, not leave it
  // running against a document that is going away. The request already left this
  // machine, so its wait is recorded before the page goes.
  window.addEventListener('pagehide', () => {
    if (composing) cooldowns.start('text', TEXT_COOLDOWN_MS);
    inFlight?.abort();
    imageInFlight?.abort();
  });
})();

// Stop the answer being written. Its 18 s wait starts now, exactly as if the answer
// had finished: the request left this machine either way.
function abortText() {
  if (!composing) return;
  inFlight?.abort();
  composing = false;
  cooldowns.start('text', TEXT_COOLDOWN_MS);
  refreshComposer();
}

// Stop the picture being made. Its 50 s wait began when it was sent and is not
// touched here — stopping waiting for a picture does not un-send the request.
function abortImage() {
  if (!imageInFlight && !imageBusy) return;
  imageInFlight?.abort();
  imageInFlight = null;
  imageBusy = false;
  refreshComposer();
}

function newChat() {
  abortText();
  abortImage();
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
  abortText();
  abortImage();
  current = {
    id: c.id,
    title: c.title || 'Chat',
    messages: restoreMessages(c.messages),
    provider: PROVIDERS[c.provider] ? c.provider : loadPreferredProvider(),
  };
  // Continuing a saved chat continues it with the provider IT was using, and
  // that becomes the visitor's active choice too — so the switcher in the
  // sidebar reflects what this conversation will actually do next.
  savePreferredProvider(current.provider);
  render();
  renderHistory();
  renderProviderSwitch();
  refreshComposer();
}

function deleteChat(id) {
  store.chats.remove(id);
  if (current.id === id) {
    abortText();
    abortImage();
    current = blankChat();
    render();
  }
  renderHistory();
}

function clearAllChats() {
  if (!store.chats.list().length) return;
  if (!window.confirm('Delete every saved AI conversation on this device? This cannot be undone.')) return;
  store.chats.clear();
  abortText();
  abortImage();
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
    const i = $('#aiInput'); if (i) { i.value = p; i.focus(); autoSize(i); refreshComposer(); }
  }));
}

// ===========================================================================
// Provider switcher
// ===========================================================================
function renderProviderSwitch() {
  $$('.ai-provider-btn').forEach(b => b.classList.toggle('active', b.dataset.provider === current.provider));
  syncPuterPanel();
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
// Puter account panel
// ===========================================================================
// Puter.js runs on the visitor's OWN Puter account, so there is a sign-in step that PolliChat does
// not have. The SDK would open the sign-in window by itself on the first request, but it does so
// after downloading, which can be too late for the browser to treat as a click — and then nothing
// appears. This panel is the dependable way in: it shows whether the visitor is signed in, and its
// button's own click opens the sign-in window directly. See /js/puter.js.

/** Load the SDK (only ever for a visitor who has chosen Puter) and paint the panel. */
function syncPuterPanel() {
  if (current?.provider !== 'puter') { paintPuterPanel(); return; }
  if (puterReady()) { puterLoad = 'ready'; paintPuterPanel(); return; }
  if (puterLoad === 'loading') return;
  puterLoad = 'loading';
  paintPuterPanel();
  preloadPuter().then((ok) => { puterLoad = ok ? 'ready' : 'failed'; paintPuterPanel(); });
}

async function paintPuterPanel(errorText) {
  const box = $('#aiPuterAuth'), line = $('#aiPuterAuthLine'), btn = $('#aiPuterAuthBtn');
  if (!box || !line || !btn) return;
  const on = current?.provider === 'puter';
  box.hidden = !on;
  if (!on) return;
  const seq = ++puterPanelSeq;
  const set = (text, label, act, disabled = false) => {
    if (seq !== puterPanelSeq) return;            // a newer paint superseded this one
    line.textContent = errorText || text;
    btn.textContent = label; btn.dataset.act = act; btn.disabled = disabled;
  };
  if (!puterReady()) {
    if (puterLoad === 'failed') set('Puter could not be reached. Check your connection — some networks block js.puter.com.', 'Try again', 'retry');
    else set('Connecting to Puter…', 'Sign in to Puter', 'wait', true);
    return;
  }
  if (puterSignInState() === 'signed-in') {
    set('Signed in to Puter.', 'Sign out', 'signout');
    const name = await puterUsername();
    if (name) set(`Signed in to Puter as ${name}.`, 'Sign out', 'signout');
  } else {
    set('Not signed in. Puter is free: sign in, or create an account, in the small window that opens.', 'Sign in to Puter', 'signin');
  }
}

function bindPuterPanel() {
  const btn = $('#aiPuterAuthBtn');
  btn?.addEventListener('click', () => {
    const act = btn.dataset.act;
    if (act === 'retry') { puterLoad = 'idle'; syncPuterPanel(); return; }
    if (act === 'signout') { signOutOfPuter().then(() => paintPuterPanel()); return; }
    if (act !== 'signin') return;
    // startPuterSignIn() is the FIRST thing this click does, so the browser sees the window as
    // opened by the click.
    const attempt = startPuterSignIn({ onBlocked: () => { $('#aiPuterAuthLine').textContent = PUTER_BLOCKED_NOTE; } });
    btn.disabled = true;
    $('#aiPuterAuthLine').textContent = 'Waiting for you to sign in in the Puter window…';
    attempt.then(() => paintPuterPanel(), (e) => paintPuterPanel(describePuterFailure(e)));
  });
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
  // Picture requests and their results are not conversation: the text model is
  // never shown them, so an image prompt is never sent to it as chat history.
  const history = current.messages
    .filter(m => !m.streaming && m.content && m.kind !== 'image')
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
  // A picture that is still being made, or that failed, is not part of the saved
  // conversation. Only the prompt of a finished one is stored — never a URL.
  const keep = current.messages
    .filter(m => !m.streaming && m.content && m.imageState !== 'loading' && m.imageState !== 'error')
    .slice(-40);
  store.chats.save({
    id: current.id, title: current.title, messages: keep,
    provider: current.provider, source: 'pollichat', ts: Date.now(),
  });
  renderHistory();
}

async function respond() {
  composing = true;
  refreshComposer();

  const provider = PROVIDERS[current.provider] || PROVIDERS.pollichat;
  // Text turns only: a /image request is not a question for the text model.
  const textTurns = current.messages.filter(m => m.role === 'user' && m.kind !== 'image');
  const userMsg = (textTurns.slice(-1)[0]?.content || '').trim();

  const reply = { role: 'assistant', content: '', streaming: true };
  current.messages.push(reply);
  render();

  const messages = buildContext();

  // Instant answer from THIS DEVICE's cache, for a standalone first turn only
  // (follow-ups depend on context, so they are never cache-served).
  const userTurns = textTurns.length;
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
      dropReply(reply);
      render();
      // Normally a newer respond() did the aborting and now owns `composing`,
      // the Send button and the next finishTurn(). If NOTHING replaced us —
      // inFlight is still our controller, which is what pagehide does — then
      // nobody is going to release the composer, so do it here rather than
      // leave Send disabled for good. The request did leave this machine, so
      // the wait still applies.
      if (inFlight === controller) {
        composing = false;
        cooldowns.start('text', TEXT_COOLDOWN_MS);
        refreshComposer();
      }
      return;
    }
    console.warn('[ai]', provider.id, 'request failed:', e?.code || '', e?.message || e);

    // Drop the empty reply bubble so the notice stands alone.
    dropReply(reply);
    render();

    // A genuine rate limit gets its own calm notice with a live countdown,
    // because it is temporary and the user only needs to know how long.
    if (e?.rateLimited) {
      showRateLimit(e.retryAfter || 15);
      finishTurn();
      return;
    }
    // A problem signing in to Puter is not a request: nothing left this machine, so it costs no
    // wait, and the card offers the sign-in itself rather than a retry that would only fail the
    // same way.
    const signIn = signInProblem(provider, e);
    showError(provider.describe(e), signIn);
    if (signIn) finishTurnWithoutWait(); else finishTurn();
  } finally {
    if (inFlight === controller) inFlight = null;
  }
}

/** The sign-in button for an error card, when the failure is about being signed in to Puter. */
function signInProblem(provider, e) {
  if (provider.id !== 'puter' || !puterReady()) return null;
  if (!['auth', 'popup-blocked', 'auth-cancelled'].includes(e?.code)) return null;
  return { label: 'Sign in to Puter', start: startPuterSignIn, describe: describePuterFailure };
}

// Remove a text reply's placeholder wherever it now sits. It used to be enough to
// pop the LAST message, because nothing could be sent while an answer was being
// written; a /image request can now be appended after it, and a placeholder left
// behind would show typing dots for good.
function dropReply(reply) {
  const i = current.messages.indexOf(reply);
  if (i !== -1) current.messages.splice(i, 1);
}

// What a failure says lives in pollinations.js / puter.js (describeFailure /
// describePuterFailure), so this page cannot describe the same error
// differently from the provider's own client.

// ── Error notice, with a Retry that re-sends the same message ──────────────
// Transient UI: not stored in chat history, and only ever one at a time.
function showError(message, signIn) {
  const wrap = $('#aiMessages'); if (!wrap) return;
  wrap.querySelector('.ai-notice-row')?.remove();

  const row = el('div', { class: 'msg assistant ai-notice-row' });
  const bubble = el('div', { class: 'ai-notice' });
  const icon = el('span', { class: 'ai-notice-icon', 'aria-hidden': 'true' });
  icon.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 8v4M12 16h.01"/></svg>';
  const text = el('div', { class: 'ai-notice-text' });
  text.textContent = message;                    // textContent: never markup
  bubble.appendChild(icon);
  bubble.appendChild(text);

  if (signIn) {
    // Not a retry: a retry would fail the same way. This button's own click opens the sign-in
    // window (start() is the first thing it does), then sends the same message again.
    const go = el('button', { class: 'ai-rl-btn ai-rl-primary', type: 'button' });
    go.textContent = signIn.label;
    go.addEventListener('click', () => {
      const attempt = signIn.start({ onBlocked: () => { text.textContent = PUTER_BLOCKED_NOTE; } });
      go.disabled = true;
      text.textContent = 'Waiting for you to sign in in the Puter window…';
      attempt.then(
        () => { row.remove(); paintPuterPanel(); respond(); },
        (err) => { text.textContent = signIn.describe(err); go.disabled = false; paintPuterPanel(); });
    });
    bubble.appendChild(go);
  } else {
    const retry = el('button', { class: 'ai-rl-btn', type: 'button' });
    retry.addEventListener('click', () => {
      // A retry is another request, so it waits out the same 18 s as a new message.
      if (retry.disabled || composing || cooldowns.remainingSec('text') > 0) return;
      row.remove();
      respond();
    });
    watchCooldown({ kind: 'text', btn: retry, ready: 'Try again', wait: (s) => `Try again in ${formatWait(s)}` });
    bubble.appendChild(retry);
  }
  const body = el('div', { class: 'msg-body' });
  body.appendChild(bubble);
  const av = el('div', { class: 'msg-av' });
  av.textContent = 'AI';
  row.appendChild(av);
  row.appendChild(body);
  wrap.appendChild(row);
  wrap.scrollTop = wrap.scrollHeight;
  setStatus(signIn ? 'Sign in to Puter to continue' : 'Tap Try again to retry');
}

// ── Styled "you hit the rate limit" notice ─────────────────────────────────
// Shown ONLY on a genuine 429. A calm amber card (not a red error) with a live
// countdown and a Retry button that arms when the window clears. Locks the
// composer for the countdown so an instant resend can't immediately re-trip it.
function showRateLimit(seconds) {
  const wrap = $('#aiMessages'); if (!wrap) return;
  wrap.querySelector('.ai-ratelimit-row')?.remove();   // only ever one at a time
  const total = Math.max(5, Math.min(120, Math.round(seconds) || 15));

  // The provider asked for this long. The text wait only ever lengthens, so it
  // covers whichever is longer — this or the usual 18 s — and the composer stays
  // locked for exactly as long as the card says.
  cooldowns.start('text', total * 1000);

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
  retryBtn.addEventListener('click', () => {
    if (retryBtn.disabled || composing || cooldowns.remainingSec('text') > 0) return;
    row.remove();
    respond();
  });
  watchCooldown({ kind: 'text', btn: retryBtn, countEl, ready: 'Retry now', wait: (s) => `Retry in ${formatWait(s)}` });
  refreshComposer();
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
  // A picture is a DOM card, not markup: it keeps its <img> across re-renders so
  // an unrelated message arriving mid-generation cannot restart (and double-count)
  // the request. The user's own "/image ..." line below is ordinary escaped text.
  if (m.kind === 'image' && m.role === 'assistant') {
    row.appendChild(el('div', { class: 'msg-av' }, 'AI'));
    row.appendChild(el('div', { class: 'msg-body' }, imageCardFor(m)));
    return row;
  }
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
  input.addEventListener('input', () => { autoSize(input); refreshComposer(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); }
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    const command = parseImageCommand(text);
    const kind = command ? 'image' : 'text';
    const gate = gateFor(kind);
    // One text answer, and one picture, at a time.
    if (gate.why === 'busy') return;
    // Still inside the wait: nothing is sent and what was typed is kept, so it
    // can go the moment the countdown ends.
    if (gate.why === 'cooldown') { nudge(kind, gate.sec); return; }
    // "/image" with nothing after it asks for nothing: say how to use it, and
    // spend no wait on it.
    if (command && !command.prompt) { flashHint(IMAGE_USAGE); return; }
    if (command) await sendImage(text, command.prompt);
    else await sendText(text);
  });
}

function autoSize(input) {
  input.style.height = 'auto';
  input.style.height = Math.min(180, input.scrollHeight) + 'px';
}

async function sendText(text) {
  const input = $('#aiInput');
  // A new message invalidates any error notice still on screen.
  $('#aiMessages')?.querySelector('.ai-notice-row')?.remove();
  ensureChatStarted(text);
  current.messages.push({ role: 'user', content: text });
  persist();
  if (input) { input.value = ''; autoSize(input); }
  render();
  await respond();
}

// The answer is in (or the attempt failed or was cancelled): the 18 s wait for the
// next message starts now.
function finishTurn() {
  composing = false;
  cooldowns.start('text', TEXT_COOLDOWN_MS);
  refreshComposer();
}

// A sign-in problem is not a request: nothing was sent, so there is no wait to serve.
function finishTurnWithoutWait() {
  composing = false;
  refreshComposer();
}

// ===========================================================================
// /image — a picture from Pollinations, requested by this browser.
// ===========================================================================
async function sendImage(rawText, prompt) {
  if (imageBusy) return;             // the composer already refuses; this keeps a stray call harmless
  const input = $('#aiInput');
  $('#aiMessages')?.querySelector('.ai-notice-row')?.remove();
  dropFailedPictures();
  ensureChatStarted(rawText);
  const ask = { role: 'user', content: rawText, kind: 'image' };
  const reply = { role: 'assistant', content: prompt, kind: 'image', imageState: 'loading' };
  current.messages.push(ask, reply);
  persist();                 // keeps the request; the reply joins it once the picture has loaded
  if (input) { input.value = ''; autoSize(input); }
  render();
  await makePicture(reply);
}

// A failed picture stays on screen with its own Try again, but a NEW request
// replaces it rather than stacking error tiles up the page.
function dropFailedPictures() {
  current.messages = current.messages.filter((m) => !(m.kind === 'image' && m.imageState === 'error'));
}

async function makePicture(reply) {
  if (imageBusy) return;
  const card = imageCardFor(reply);
  // Still the picture on screen? False once the visitor has moved to another chat.
  const alive = () => current.messages.includes(reply);

  let url;
  try {
    url = buildImageUrl(reply.content);
  } catch (e) {
    // Nothing left this machine, so nothing is spent: no wait is started.
    failPicture(card, reply, e);
    return;
  }

  imageBusy = true;
  reply.imageState = 'loading';
  paintImageCard(card, reply);
  // The request is about to leave. The provider's own 45 s window starts when it
  // arrives, so ours starts now rather than when the picture finishes.
  cooldowns.start('image', IMAGE_COOLDOWN_MS);
  setStatus('Making your picture…');
  refreshComposer();
  const controller = new AbortController();
  imageInFlight = controller;

  try {
    const img = await loadImage(url, { signal: controller.signal });
    if (alive()) showPicture(card, reply, img, url);
  } catch (e) {
    if (e?.code === 'cancelled' || !alive()) return;
    let failure = e;
    if (e?.code === 'image-failed' || e?.code === 'timeout') {
      // A failed <img> says nothing about WHY — a rate limit, an outage and a
      // blocked network look the same. Ask once. If that request works, the
      // bytes it fetched are the picture.
      const found = await diagnoseImageFailure(url, { signal: controller.signal });
      if (!alive()) return;
      if (found.ok) {
        try {
          const img = await loadImage(URL.createObjectURL(found.blob), { signal: controller.signal });
          if (alive()) showPicture(card, reply, img, url);
          return;
        } catch { /* fall through to the failure below */ }
      } else if (found.error.code !== 'cancelled') {
        failure = found.error;
      }
    }
    if (failure.code === 'rate-limited') {
      // Honour what the service said, on top of our own 50 s (it only lengthens).
      cooldowns.start('image', ((Number(failure.retryAfter) || 0) + 1) * 1000);
    }
    console.warn('[ai] picture failed:', failure.code || '', failure.message || failure);
    if (alive()) failPicture(card, reply, failure);
  } finally {
    if (imageInFlight === controller) {
      imageInFlight = null;
      imageBusy = false;
    }
    setStatus(statusLineFor(current.provider));
    refreshComposer();
  }
}

function showPicture(card, reply, img, openHref) {
  reply.imageState = 'done';
  delete reply.error;
  img.className = 'ai-image';
  img.alt = reply.content;                       // the prompt, as text
  paintImageCard(card, reply, { img, openHref });
  persist();
  const wrap = $('#aiMessages'); if (wrap) wrap.scrollTop = wrap.scrollHeight;
}

function failPicture(card, reply, error) {
  reply.imageState = 'error';
  reply.error = describeImageFailure(error);
  paintImageCard(card, reply);
  const wrap = $('#aiMessages'); if (wrap) wrap.scrollTop = wrap.scrollHeight;
}

function imageCardFor(m) {
  let card = imageCards.get(m);
  if (!card) {
    card = el('div', { class: 'ai-image-wrap' });
    imageCards.set(m, card);
    paintImageCard(card, m);
  }
  return card;
}

// One card, three states. Everything the visitor or the provider supplied goes in
// through textContent or an attribute, never as markup.
function paintImageCard(card, m, extra = {}) {
  card.textContent = '';
  card.dataset.state = m.imageState || 'done';

  if (m.imageState === 'loading') {
    card.append(
      el('div', { class: 'ai-image ai-image-loading', role: 'status' }, [
        el('span', { class: 'ai-spin', 'aria-hidden': 'true' }),
        el('span', { class: 'ai-image-loadtxt' }, 'Making your picture… this can take up to a minute'),
      ]),
      pictureCaption(m),
    );
    return;
  }

  if (m.imageState === 'error') {
    const retry = el('button', { class: 'ai-rl-btn', type: 'button' });
    retry.addEventListener('click', () => {
      if (retry.disabled || imageBusy || cooldowns.remainingSec('image') > 0) return;
      makePicture(m);
    });
    watchCooldown({ kind: 'image', btn: retry, ready: 'Try again', wait: (s) => `Try again in ${formatWait(s)}` });
    card.append(
      el('div', { class: 'ai-image-err', role: 'alert' }, [
        el('div', {}, m.error || 'That picture did not come through.'),
        el('div', { style: { marginTop: '10px' } }, retry),
      ]),
      pictureCaption(m),
    );
    return;
  }

  // Finished. A just-made picture arrives as an <img> that has already decoded;
  // one restored from history is built here and loads when it scrolls into view.
  let img = extra.img;
  let href = extra.openHref;
  if (!img) {
    try {
      href = buildImageUrl(m.content);
      img = el('img', {
        class: 'ai-image', alt: m.content, loading: 'lazy', decoding: 'async',
        referrerpolicy: 'no-referrer', src: href,
      });
      img.addEventListener('error', () => {
        m.imageState = 'error';
        m.error = 'This picture could not be loaded right now.';
        paintImageCard(card, m);
      }, { once: true });
    } catch (e) {
      m.imageState = 'error';
      m.error = describeImageFailure(e);
      paintImageCard(card, m);
      return;
    }
  }
  card.append(img, pictureCaption(m, href, true));
}

// The prompt and, once there is a picture, who made it and a way to open it full
// size. The prompt is a text node; the link is only ever the URL that
// buildImageUrl() produced.
function pictureCaption(m, href, made = false) {
  const cap = el('div', { class: 'ai-image-cap' });
  cap.append(document.createTextNode(m.content));
  if (made) cap.append(document.createTextNode(' · Made by Pollinations'));
  if (href) {
    cap.append(document.createTextNode(' · '));
    cap.append(el('a', { href, target: '_blank', rel: 'noopener noreferrer' }, 'Open full size'));
  }
  return cap;
}

// ===========================================================================
// The composer: what Send can do right now, and the countdowns that explain it.
// ===========================================================================
function inputKind() {
  const input = $('#aiInput');
  return parseImageCommand(input?.value || '') ? 'image' : 'text';
}

// Why `kind` cannot be sent at this moment, if it cannot.
//   { why: 'busy' }                  one is already being made
//   { why: 'cooldown', sec }         the wait after the last one is still running
//   { why: null }                    free to send
function gateFor(kind) {
  if (kind === 'image' ? imageBusy : composing) return { why: 'busy', sec: 0 };
  const sec = cooldowns.remainingSec(kind);
  return sec > 0 ? { why: 'cooldown', sec } : { why: null, sec: 0 };
}

function hintFor(kind, gate) {
  if (hintOverride) return hintOverride;
  if (gate.why === 'cooldown') {
    return kind === 'image'
      ? `Next picture in ${formatWait(gate.sec)}`
      : `Next message in ${formatWait(gate.sec)}`;
  }
  if (gate.why === 'busy') return kind === 'image' ? 'Making your picture…' : 'Waiting for the answer…';
  if (kind === 'image') return `Picture mode · by Pollinations · one per ${Math.round(IMAGE_COOLDOWN_MS / 1000)} seconds`;
  return HINT_DEFAULT;
}

function announce(message) {
  const live = $('#aiLive');
  if (!live) return;
  // Clearing first makes a repeated message announce again.
  live.textContent = '';
  setTimeout(() => { live.textContent = message; }, 30);
}

// Re-evaluate Send and the hint line. Cheap enough to call on every keystroke
// and every tick; it only touches the DOM, never the network.
function refreshComposer() {
  const send = $('#aiSend');
  const hint = $('#aiHint');
  if (send) {
    const kind = inputKind();
    const gate = gateFor(kind);
    const locked = gate.why !== null;
    send.disabled = locked;
    send.classList.toggle('is-cooldown', gate.why === 'cooldown');
    if (hint) {
      hint.textContent = hintFor(kind, gate);
      hint.classList.toggle('is-wait', gate.why === 'cooldown' && !hintOverride);
    }
  }
  // Say so, once, when a wait ends — a countdown that only a screen is watching
  // would otherwise never be heard.
  for (const k of ['text', 'image']) {
    const cooling = cooldowns.remainingSec(k) > 0;
    if (lastCooling[k] && !cooling) {
      announce(k === 'image' ? 'You can ask for another picture now.' : 'You can send your next message now.');
    }
    lastCooling[k] = cooling;
  }
  if (needsTicker()) ensureTicker();
}

// A line in the hint slot that wins over the usual one for a few seconds.
function flashHint(message, ms = 5000) {
  hintOverride = message;
  clearTimeout(hintTimer);
  hintTimer = setTimeout(() => { hintOverride = ''; refreshComposer(); }, ms);
  announce(message);
  refreshComposer();
}

// A send was refused because of a wait: pulse the hint so it is clear why nothing
// happened, and say so for anyone not looking at it.
function nudge(kind, sec) {
  const hint = $('#aiHint');
  if (hint) {
    hint.classList.remove('is-nudge');
    void hint.offsetWidth;                       // restart the animation
    hint.classList.add('is-nudge');
  }
  announce(kind === 'image'
    ? `Please wait ${formatWait(sec)} before asking for another picture.`
    : `Please wait ${formatWait(sec)} before sending another message.`);
}

// Buttons that count a wait down on their own: Try again, Retry now.
//   ui = { kind, btn, countEl?, ready, wait(seconds) }
function watchCooldown(ui) {
  cooldownWatchers.add(ui);
  paintWatcher(ui);
  ensureTicker();
}

function paintWatcher(ui) {
  const s = cooldowns.remainingSec(ui.kind);
  ui.btn.disabled = s > 0;
  ui.btn.classList.toggle('ready', s === 0);
  ui.btn.textContent = s > 0 ? ui.wait(s) : ui.ready;
  if (ui.countEl) ui.countEl.textContent = s > 0 ? formatWait(s) : 'now';
  return s;
}

function needsTicker() {
  return cooldownWatchers.size > 0
    || cooldowns.remainingSec('text') > 0
    || cooldowns.remainingSec('image') > 0;
}

function ensureTicker() {
  if (!tickTimer) tickTimer = setInterval(tick, 1000);
}

function tick() {
  for (const ui of [...cooldownWatchers]) {
    // Gone from the page (its row was removed or the chat changed): forget it.
    // Finished counting: it is a plain, enabled button now.
    if (!ui.btn.isConnected || paintWatcher(ui) === 0) cooldownWatchers.delete(ui);
  }
  refreshComposer();
  if (!needsTicker()) { clearInterval(tickTimer); tickTimer = null; }
}
