// ZoFHub · leaderboard.js — dedicated global leaderboard page.
// Reads the same player-reported scores as the community sidebar (/api/scores),
// then de-duplicates to each player's BEST score per game so the board stays
// clean even if someone submits several times. Pure client-side filter on top.
import { $, el, fetchJson, escapeHtml, formatRelative } from './utils.js';
import { getPlayerName } from './identity.js';

const board = $('#lbBoard');
const stateEl = $('#lbState');
const meta = $('#lbMeta');
const search = $('#lbSearch');
const me = getPlayerName();
const youEl = $('#lbYou');
if (youEl) youEl.innerHTML = `You are <b>${escapeHtml(me)}</b>`;

let rows = [];   // cleaned, sorted score rows

const prettySlug = (s) =>
  String(s || '').replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase()).trim() || 'Game';

init();

async function init() {
  search?.addEventListener('input', render);
  try {
    // Pull a generous slice, then collapse to best-per-(player+game).
    const data = await fetchJson('/api/scores?limit=200');
    const raw = data.scores || [];
    if (data.setup) console.info('[leaderboard] backend not ready:', data.setup);
    rows = dedupeBest(raw);
    render();
  } catch (e) {
    showState('Couldn’t load the leaderboard — please check back in a moment.');
  }
}

// Keep only the highest score per (player_name + slug).
function dedupeBest(raw) {
  const best = new Map();
  for (const s of raw) {
    const key = `${(s.player_name || 'Player').toLowerCase()}::${s.slug}`;
    const prev = best.get(key);
    if (!prev || Number(s.score) > Number(prev.score)) best.set(key, s);
  }
  return [...best.values()].sort((a, b) => Number(b.score) - Number(a.score));
}

function render() {
  const q = (search?.value || '').trim().toLowerCase();
  const list = q
    ? rows.filter(s =>
        (s.player_name || '').toLowerCase().includes(q) ||
        prettySlug(s.slug).toLowerCase().includes(q))
    : rows;

  board.innerHTML = '';
  if (!rows.length) { showState('No scores yet — be the first! Open a game, hit Leaderboard, and submit your run.', true); return; }
  if (!list.length) { showState(`No results for “${escapeHtml(q)}”.`); return; }

  meta.textContent = `${rows.length.toLocaleString()} ${rows.length === 1 ? 'entry' : 'entries'}`;

  list.forEach((s, i) => {
    const rank = i + 1;
    const isMe = (s.player_name || 'Player') === me;
    const li = el('li', { class: `lb-entry${rank <= 3 ? ' lb-podium lb-rank-' + rank : ''}${isMe ? ' lb-you-row' : ''}` });
    const medal = rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : rank;
    li.innerHTML = `
      <span class="lb-pos">${medal}</span>
      <div class="lb-who">
        <span class="lb-player">${isMe ? '<span class="lb-you-tag">YOU</span> ' : ''}<span class="lb-pname"></span></span>
        <a class="lb-game" href="/play/${encodeURIComponent(s.slug)}"></a>
      </div>
      <span class="lb-score">${Number(s.score).toLocaleString()}</span>
      <span class="lb-when">${s.created_at ? formatRelative(new Date(s.created_at).getTime()) : ''}</span>`;
    li.querySelector('.lb-pname').textContent = s.player_name || 'Player';
    li.querySelector('.lb-game').textContent = prettySlug(s.slug);
    board.appendChild(li);
  });
}

function showState(msg, isEmpty = false) {
  meta.textContent = '';
  board.innerHTML = '';
  const li = el('li', { class: `lb-state${isEmpty ? ' lb-state-empty' : ''}` }, msg);
  if (isEmpty) {
    const a = el('a', { class: 'btn-primary btn-sm', href: '/' }, 'Browse games');
    li.appendChild(document.createElement('br'));
    li.appendChild(a);
  }
  board.appendChild(li);
}
