// ZoFHub · community.js — recommendations feed + submit + global leaderboard.
import { $, el, fetchJson, escapeHtml, toast } from './utils.js';
import { getPlayerName } from './identity.js';

const recList  = $('#recList');
const recEmpty = $('#recEmpty');
const lbList   = $('#lbList');
const lbEmpty  = $('#lbEmpty');

init();

async function init() {
  bindRecModal();
  bindPlayModal();
  await Promise.all([loadRecommendations(), loadLeaderboard()]);
}

// ---------------------------------------------------------------------------
// Recommendations feed
// ---------------------------------------------------------------------------
function prettySlug(s) {
  return String(s || '').replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

async function loadRecommendations() {
  try {
    const data = await fetchJson('/api/recommendations?limit=60');
    const recs = data.recommendations || [];
    recList.innerHTML = '';
    // `setup` is a DEVELOPER hint (DB tables not created yet). Never surface it to
    // visitors — log it for devs and show a polished empty state instead.
    if (data.setup) console.info('[community] recommendations backend not ready:', data.setup);
    if (!recs.length) {
      recList.appendChild(emptyState({
        icon: 'heart',
        title: 'No community picks yet',
        sub: 'Be the first to share a game the community will love.',
        actionLabel: 'Recommend a game',
        onAction: () => $('#openRecBtn')?.click(),
      }));
      return;
    }
    for (const r of recs) recList.appendChild(recCard(r));
  } catch (e) {
    recList.innerHTML = '';
    recList.appendChild(emptyState({ icon: 'warn', title: 'Couldn’t load community picks', sub: 'Please check back in a moment.' }));
  }
}

// ---------------------------------------------------------------------------
// Premium empty / error states (shared by both columns)
// ---------------------------------------------------------------------------
const EMPTY_ICONS = {
  heart:  '<path d="M12 21s-7-4.6-7-11a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 6.4-7 11-7 11z"/>',
  trophy: '<path d="M8 21h8M12 17v4M7 4h10v4a5 5 0 0 1-10 0V4zM5 6H3v2a3 3 0 0 0 3 3M19 6h2v2a3 3 0 0 1-3 3"/>',
  warn:   '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0zM12 9v4M12 17h.01"/>',
};
function emptyState({ icon = 'heart', title, sub, actionLabel, onAction }) {
  const box = el('div', { class: 'community-empty-rich' });
  box.innerHTML = `
    <span class="empty-ic"><svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${EMPTY_ICONS[icon] || EMPTY_ICONS.heart}</svg></span>
    <p class="empty-title">${escapeHtml(title)}</p>
    ${sub ? `<p class="empty-sub">${escapeHtml(sub)}</p>` : ''}`;
  if (actionLabel) {
    const b = el('button', { class: 'btn-primary btn-sm' }, actionLabel);
    if (onAction) b.addEventListener('click', onAction);
    box.appendChild(b);
  }
  return box;
}
function emptyLi(opts) { const li = el('li'); li.appendChild(emptyState(opts)); return li; }

// Map developer-facing backend errors to friendly copy (keeps the real hint in
// the console). Used for the "Recommend a game" submit flow.
function friendlyError(err) {
  const raw = String(err || '');
  if (/db\/community\.sql|not configured|does not exist|42P01/i.test(raw)) {
    console.info('[community] backend setup needed:', raw);
    return 'Community posting is warming up — please try again soon.';
  }
  return raw || 'Could not post your recommendation.';
}

function recCard(r) {
  const card = el('div', { class: 'rec-card' });
  const safeTitle = escapeHtml(r.title || 'Game');
  const cat = escapeHtml(r.category || 'arcade');
  const author = escapeHtml(r.author || 'Anonymous');
  const note = r.note ? `<p class="rec-note">${escapeHtml(r.note)}</p>` : '';
  card.innerHTML = `
    <div class="rec-card-top">
      <span class="rec-cat">${cat}</span>
      <span class="rec-views">${(r.views || 0)} ▷</span>
    </div>
    <h3 class="rec-title">${safeTitle}</h3>
    ${note}
    <div class="rec-card-foot">
      <span class="rec-author">by ${author}</span>
      <button class="btn-primary btn-sm rec-play">Play ▶</button>
    </div>`;
  card.querySelector('.rec-play').addEventListener('click', () => openPlay(r));
  return card;
}

// ---------------------------------------------------------------------------
// Leaderboard
// ---------------------------------------------------------------------------
async function loadLeaderboard() {
  try {
    const data = await fetchJson('/api/scores?limit=20');
    const scores = data.scores || [];
    lbList.innerHTML = '';
    if (data.setup) console.info('[community] leaderboard backend not ready:', data.setup);
    if (!scores.length) {
      lbList.appendChild(emptyLi({ icon: 'trophy', title: 'No scores yet', sub: 'Play a game and set the first record.' }));
      return;
    }
    scores.forEach((s, i) => {
      const li = el('li', { class: `lb-row${i < 3 ? ' lb-top' : ''}` });
      li.innerHTML = `
        <span class="lb-rank">${i + 1}</span>
        <span class="lb-name">${escapeHtml(s.player_name || 'Player')}</span>
        <a class="lb-game" href="/play/${encodeURIComponent(s.slug)}">${escapeHtml(prettySlug(s.slug))}</a>
        <span class="lb-score">${Number(s.score).toLocaleString()}</span>`;
      lbList.appendChild(li);
    });
  } catch (e) {
    lbList.innerHTML = '';
    lbList.appendChild(emptyLi({ icon: 'warn', title: 'Couldn’t load the leaderboard', sub: 'Please check back in a moment.' }));
  }
}

// ---------------------------------------------------------------------------
// Recommend modal
// ---------------------------------------------------------------------------
function bindRecModal() {
  const modal = $('#recModal');
  const open  = () => {
    modal.hidden = false;
    // Default the author to this device's persistent player name (no "Anonymous").
    const authorEl = $('#recForm')?.querySelector('input[name="author"]');
    if (authorEl && !authorEl.value.trim()) authorEl.value = getPlayerName();
    $('#recForm')?.querySelector('input[name="title"]')?.focus();
  };
  const close = () => { modal.hidden = true; $('#recMsg').textContent = ''; };
  $('#openRecBtn')?.addEventListener('click', open);
  $('#recClose')?.addEventListener('click', close);
  $('#recCancel')?.addEventListener('click', close);
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });

  $('#recForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.currentTarget;
    const body = {
      title: f.title.value, embed_url: f.embed_url.value,
      category: f.category.value, note: f.note.value, author: f.author.value,
    };
    const msg = $('#recMsg');
    const btn = $('#recSubmit');
    btn.disabled = true; msg.className = 'modal-msg'; msg.textContent = 'Posting…';
    try {
      const r = await fetch('/api/recommendations', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
      });
      const j = await r.json();
      if (!j.ok) { msg.className = 'modal-msg err'; msg.textContent = friendlyError(j.error); return; }
      msg.className = 'modal-msg ok'; msg.textContent = 'Posted! Thanks for sharing.';
      f.reset();
      toast('Recommendation posted', 'ok');
      await loadRecommendations();
      setTimeout(() => { modal.hidden = true; msg.textContent = ''; }, 900);
    } catch {
      msg.className = 'modal-msg err'; msg.textContent = 'Network error — try again.';
    } finally {
      btn.disabled = false;
    }
  });
}

// ---------------------------------------------------------------------------
// Play modal (sandboxed iframe — embed_url is already trusted-host validated
// server-side, and we additionally sandbox the frame here)
// ---------------------------------------------------------------------------
function bindPlayModal() {
  const modal = $('#playModal');
  const close = () => { modal.hidden = true; $('#playModalFrame').innerHTML = ''; };
  $('#playClose')?.addEventListener('click', close);
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !modal.hidden) close(); });
}

function openPlay(r) {
  const modal = $('#playModal');
  $('#playModalTitle').textContent = r.title || 'Game';
  const frame = $('#playModalFrame');
  frame.innerHTML = '';
  const iframe = el('iframe', {
    src: r.embed_url,
    title: r.title || 'Game',
    allow: 'autoplay; fullscreen; gamepad; clipboard-write; encrypted-media',
    sandbox: 'allow-scripts allow-same-origin allow-popups allow-forms allow-pointer-lock allow-orientation-lock',
    referrerpolicy: 'strict-origin-when-cross-origin',
  });
  iframe.setAttribute('allowfullscreen', '');
  frame.appendChild(iframe);
  modal.hidden = false;
  // Bump the view counter (powers the cleanup of unseen recs).
  if (r.id) fetch(`/api/recommendations/${r.id}/seen`, { method: 'POST' }).catch(() => {});
}
