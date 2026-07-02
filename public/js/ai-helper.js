// ZoFHub · ai-helper.js
// Floating AI assistant orb — appears on every page EXCEPT the /ai page
// (which is itself the full AI chat). On a game page it gives tips/tricks
// for that specific game using the game's metadata (title + category);
// elsewhere it's a general helper. Powered by /api/ai/text (Pollinations
// with an AI Horde fallback).

import { renderMarkdownLite, escapeHtml } from './utils.js';
import { store } from './storage.js';
import { pollTextPromptStream } from './pollinations.js?v=20260709';

(function initAIHelper() {
  // The /ai page is the full assistant — don't double up there.
  if (document.body.classList.contains('page-ai')) return;
  if (document.getElementById('aiOrb')) return;

  const game = window.ZOFHUB_GAME || null;
  const onGamePage = !!(game && game.slug);

  // ── Orb (animated circle, bottom-right) ──────────────────────────────────
  const orb = document.createElement('button');
  orb.id = 'aiOrb';
  orb.className = 'ai-orb';
  orb.type = 'button';
  orb.setAttribute('aria-label', onGamePage ? 'AI game tips' : 'Ask ZoFHub AI');
  orb.innerHTML = `
    <span class="ai-orb-ring" aria-hidden="true"></span>
    <span class="ai-orb-ring ai-orb-ring-2" aria-hidden="true"></span>
    <svg class="ai-orb-icon" viewBox="0 0 24 24" width="26" height="26" fill="currentColor" aria-hidden="true">
      <path d="M12 2.4l1.8 4.8 4.8 1.8-4.8 1.8L12 15.6l-1.8-4.8L5.4 9l4.8-1.8z"/>
      <path d="M18.3 13.4l.85 2.25 2.25.85-2.25.85-.85 2.25-.85-2.25-2.25-.85 2.25-.85z"/>
    </svg>`;
  document.body.appendChild(orb);

  // ── Panel ────────────────────────────────────────────────────────────────
  const panel = document.createElement('div');
  panel.id = 'aiOrbPanel';
  panel.className = 'ai-orb-panel';
  panel.hidden = true;
  panel.innerHTML = `
    <div class="ai-orb-head">
      <span class="ai-orb-spark" aria-hidden="true"></span>
      <span class="ai-orb-title">${onGamePage ? 'Game Tips AI' : 'ZoFHub AI Helper'}</span>
      <button class="ai-orb-min" type="button" aria-label="Hide assistant" title="Hide assistant">&minus;</button>
      <button class="ai-orb-close" type="button" aria-label="Close">&times;</button>
    </div>
    <div class="ai-orb-body" id="aiOrbBody">
      <div class="ai-orb-msg ai">${onGamePage
        ? `Hey! Want tips for <b>${escapeHtml(game.title || 'this game')}</b>? Tap the button below or ask me anything.`
        : `Hey! Ask me for game tips, recommendations, or anything else.`}</div>
    </div>
    ${onGamePage ? `<button class="ai-orb-quick" id="aiOrbQuick" type="button">💡 Help me with this game</button>` : ''}
    <form class="ai-orb-form" id="aiOrbForm">
      <input id="aiOrbInput" type="text" placeholder="${onGamePage ? 'Ask about this game…' : 'Ask ZoFHub AI…'}" autocomplete="off" maxlength="500" />
      <button type="submit" class="ai-orb-send" aria-label="Send">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2L11 13"/><path d="M22 2l-7 20-4-9-9-4z"/></svg>
      </button>
    </form>`;
  document.body.appendChild(panel);

  const body  = panel.querySelector('#aiOrbBody');
  const form  = panel.querySelector('#aiOrbForm');
  const input = panel.querySelector('#aiOrbInput');
  const sendBtn = form.querySelector('.ai-orb-send');
  let busy = false;

  // Persist orb conversations into the shared AI history so they show up (and
  // are deletable) on the /ai page. Fully guarded — a storage hiccup or full
  // quota can never break the chat.
  let convo = null;
  function recordTurn(userText, aiText) {
    try {
      if (!convo) {
        const base = onGamePage ? `Tips: ${game.title || 'this game'}` : (userText || 'Chat');
        convo = { id: 'orb_' + Date.now().toString(36), title: String(base).slice(0, 60), messages: [], source: 'orb', ts: Date.now() };
      }
      convo.messages.push({ role: 'user', content: String(userText || '') });
      convo.messages.push({ role: 'assistant', content: String(aiText || '') });
      store.chats.save(convo);
    } catch {}
  }

  // ── Throttle: lock the send/quick buttons for 4s after every prompt so a
  // user can't rapid-fire requests at the shared (keyless) AI endpoint. ──────
  let cooling = false;
  let cooldownTimer = null;
  function lockButtons(on) {
    [sendBtn, panel.querySelector('#aiOrbQuick')].filter(Boolean).forEach(el => {
      el.disabled = on; el.classList.toggle('is-cooldown', on);
    });
  }
  function startCooldown() {
    cooling = true; lockButtons(true);
    clearTimeout(cooldownTimer);
    cooldownTimer = setTimeout(() => { cooling = false; lockButtons(false); }, 4000);
  }

  const open  = () => { panel.hidden = false; orb.classList.add('active'); orb.classList.remove('nudge'); setTimeout(() => input?.focus(), 60); };
  const close = () => { panel.hidden = true; orb.classList.remove('active'); };
  orb.addEventListener('click', () => (panel.hidden ? open() : close()));
  panel.querySelector('.ai-orb-close').addEventListener('click', close);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !panel.hidden) close(); });

  // ── Dismiss / restore the whole assistant (persisted) ─────────────────────
  // The orb is no longer permanently pinned: users can hide it entirely and
  // bring it back anytime from a small corner chip. Choice persists across pages.
  const STORE = 'zofhub_ai_hidden';
  const restore = document.createElement('button');
  restore.id = 'aiRestore';
  restore.className = 'ai-restore';
  restore.type = 'button';
  restore.hidden = true;
  restore.setAttribute('aria-label', 'Show AI assistant');
  restore.innerHTML = `<span class="ai-restore-dot" aria-hidden="true"></span>AI`;
  document.body.appendChild(restore);

  const hideAssistant = () => { close(); orb.hidden = true; restore.hidden = false; try { localStorage.setItem(STORE, '1'); } catch {} };
  const showAssistant = (openPanel) => { orb.hidden = false; restore.hidden = true; try { localStorage.removeItem(STORE); } catch {} if (openPanel) open(); };

  panel.querySelector('.ai-orb-min').addEventListener('click', hideAssistant);
  restore.addEventListener('click', () => showAssistant(true));

  try { if (localStorage.getItem(STORE) === '1') { orb.hidden = true; restore.hidden = false; } } catch {}

  function addMsg(role, html) {
    const div = document.createElement('div');
    div.className = `ai-orb-msg ${role}`;
    div.innerHTML = html;
    body.appendChild(div);
    body.scrollTop = body.scrollHeight;
    return div;
  }

  // Metadata-driven prompt: the game's title + category ARE the metadata we
  // send, so the AI gives tips specific to THIS game.
  function gamePrompt(userQ) {
    const title = game?.title || 'this game';
    const cat = (document.querySelector('.play-cat')?.textContent || game?.category || '').trim();
    const meta = `I'm playing the online browser game "${title}"${cat ? ` (a ${cat} game)` : ''} on ZoFHub.`;
    const ask = (userQ && userQ.trim())
      ? userQ.trim()
      : 'In a few sentences, explain what this game is about, then give me clear, specific tips and tricks to play well and get a high score.';
    return `${meta} ${ask} Keep it concise and practical.`;
  }

  // Per-game AI metadata: a tailored set of "questions the AI should answer",
  // DERIVED from each game's own title + category. This gives every one of the
  // 12K+ games (and any future ones) help questions with zero stored data and
  // no bulk operation — so nothing can choke on catalog size.
  function buildGameMeta() {
    const title = (game?.title || document.querySelector('.play-title')?.textContent || 'this game').trim();
    const cat = (document.querySelector('.play-cat')?.textContent || game?.category || '').trim().toLowerCase();
    const base = [
      `What is the goal of ${title}?`,
      `What are the controls for ${title}?`,
      `Give me beginner tips for ${title}.`,
      `How do I get a high score in ${title}?`,
    ];
    const byCat = {
      racing:    [`Fastest way to win races in ${title}?`, `How do I take corners well in ${title}?`],
      driving:   [`How do I control the vehicle in ${title}?`],
      shooting:  [`How do I aim and survive longer in ${title}?`],
      action:    [`How do I beat tough enemies in ${title}?`],
      puzzle:    [`How do I solve the harder levels in ${title}?`],
      strategy:  [`What's a winning strategy for ${title}?`],
      defense:   [`Best tower placement / build order in ${title}?`],
      sports:    [`Controls and tactics for ${title}?`],
      io:        [`How do I beat other players and grow fast in ${title}?`],
      clicker:   [`What are the most efficient upgrades in ${title}?`],
      idle:      [`What should I prioritize first in ${title}?`],
      arcade:    [`How do I last longer and score higher in ${title}?`],
      adventure: [`How do I progress / where do I go next in ${title}?`],
      card:      [`What's a solid strategy for ${title}?`],
    };
    let extra = [];
    for (const key in byCat) { if (cat.includes(key)) { extra = byCat[key]; break; } }
    const out = [], seen = new Set();
    for (const q of [...extra, ...base]) { if (!seen.has(q)) { seen.add(q); out.push(q); } if (out.length >= 5) break; }
    return { title, category: cat, questions: out };
  }

  // Ask the AI. pollTextPromptStream calls Pollinations DIRECTLY from this device
  // first (offloads our server) and STREAMS the answer token-by-token so it shows
  // up live; it falls back to the same-origin shield and retries 429s internally.
  async function ask(prompt, displayText) {
    if (busy) return;
    busy = true;
    addMsg('user', escapeHtml(displayText || prompt));
    const thinking = addMsg('ai', '<span class="ai-orb-dots"><span></span><span></span><span></span></span>');
    try {
      const { text } = await pollTextPromptStream(prompt, {
        onToken: (partial) => { thinking.innerHTML = renderMarkdownLite(partial); body.scrollTop = body.scrollHeight; },
      });
      recordTurn(displayText || prompt, text);
    } catch (e) {
      console.warn('[ai-orb] failed:', e?.message || e);
      thinking.innerHTML = '<em>The AI is busy right now — please try again in a moment.</em>';
    } finally {
      busy = false;
      body.scrollTop = body.scrollHeight;
    }
  }

  panel.querySelector('#aiOrbQuick')?.addEventListener('click', () => {
    if (cooling || busy) return;
    startCooldown();
    ask(gamePrompt(), 'Help me with this game');
  });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (cooling || busy) return;
    const q = input.value.trim();
    if (!q) return;
    input.value = '';
    startCooldown();
    ask(onGamePage ? gamePrompt(q) : q, q);
  });

  // On a game page, show the derived per-game questions as tappable chips, and
  // let the top-of-page "AI Help" button open the assistant with them.
  if (onGamePage) {
    const meta = buildGameMeta();
    const sug = document.createElement('div');
    sug.className = 'ai-orb-suggest';
    sug.setAttribute('aria-label', 'Suggested questions');
    sug.innerHTML = meta.questions.map(q => `<button class="ai-orb-chip" type="button">${escapeHtml(q)}</button>`).join('');
    body.appendChild(sug);
    sug.querySelectorAll('.ai-orb-chip').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (cooling || busy) return;
        const q = btn.textContent;
        startCooldown();
        ask(gamePrompt(q), q);
      });
    });
    document.getElementById('aiHelpBtn')?.addEventListener('click', () => {
      if (orb.hidden) showAssistant(false);
      open();
    });
  }

  // Gentle one-time nudge so users notice the orb (only on game pages).
  if (onGamePage) setTimeout(() => orb.classList.add('nudge'), 2500);
})();
