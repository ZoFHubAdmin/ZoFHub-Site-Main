// ZoFHub · leaderboard.js
// ---------------------------------------------------------------------------
// Renders /api/scores. Read-only: submitting happens on a game page, where a
// play token exists to prove the game was actually opened.
//
// Three states have to be distinguishable, because they mean different things
// to whoever is looking:
//   · not installed  — the table is missing; an operator needs to run the SQL
//   · empty          — installed and working, nobody has posted a score yet
//   · error          — the request itself failed
// Collapsing those into one "no scores" message is how a broken deployment gets
// mistaken for a quiet one.
// ---------------------------------------------------------------------------

const $ = (s) => document.querySelector(s);
const statusEl = $('#lbStatus');
const cardEl = $('#lbCard');
const rowsEl = $('#lbRows');

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const nf = new Intl.NumberFormat();

function say(text) {
  statusEl.textContent = text;
  statusEl.hidden = false;
  cardEl.hidden = true;
}

/** A slug in ?game= narrows the board to one game. */
const params = new URLSearchParams(location.search);
const slug = (params.get('game') || '').trim().toLowerCase();

function medal(rank) {
  if (rank === 1) return '<span class="lb-medal lb-gold" aria-hidden="true">1</span>';
  if (rank === 2) return '<span class="lb-medal lb-silver" aria-hidden="true">2</span>';
  if (rank === 3) return '<span class="lb-medal lb-bronze" aria-hidden="true">3</span>';
  return `<span class="lb-plain">${rank}</span>`;
}

async function load() {
  let data;
  try {
    const url = '/api/scores?limit=50' + (slug ? '&slug=' + encodeURIComponent(slug) : '');
    const r = await fetch(url, { headers: { Accept: 'application/json' } });
    data = await r.json();
    if (!r.ok) throw new Error(data?.error || `HTTP ${r.status}`);
  } catch (e) {
    say('Could not load the leaderboard right now. Please try again shortly.');
    return;
  }

  if (data.available === false) {
    say('The leaderboard is not switched on yet. Once the scores table is installed, boards appear here automatically.');
    return;
  }

  if (data.game) {
    $('#lbTitle').textContent = data.game.title || data.game.slug;
    $('#lbSub').innerHTML = 'Top scores for this game · <a href="/leaderboard">all games</a>';
    document.title = `${data.game.title || data.game.slug} leaderboard · ZoFHub`;
  }

  const scores = Array.isArray(data.scores) ? data.scores : [];
  if (!scores.length) {
    say(slug
      ? 'No scores for this game yet — play it and be the first to post one.'
      : 'No scores posted yet. Play a game and submit a score to start the board.');
    return;
  }

  rowsEl.innerHTML = scores.map((s) => `
    <tr>
      <td class="lb-rank">${medal(s.rank)}</td>
      <td class="lb-player">${esc(s.player_name)}</td>
      <td class="lb-game">${s.slug ? `<a href="/play/${encodeURIComponent(s.slug)}">${esc(s.slug)}</a>` : '—'}</td>
      <td class="lb-num">${nf.format(s.score)}</td>
    </tr>`).join('');

  statusEl.hidden = true;
  cardEl.hidden = false;
}

load();
