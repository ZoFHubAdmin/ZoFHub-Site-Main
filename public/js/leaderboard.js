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
//
// THE NUMBER COLUMN IS NOT ALWAYS "SCORE". Each game carries a scoring profile
// (lib/scoring-profiles.mjs), so this board labels its value column with that
// game's metric and unit — "Distance (meters)", "Best time (seconds)", "Wins" —
// and states which direction wins. That last part is load-bearing: on a time
// trial the board is ordered LOWEST FIRST, and a reader who was not told would
// reasonably conclude it was sorted backwards.
//
// The server does the ordering. It also restricts the ALL-GAMES board to plain
// point totals, because metres, seconds and wins are not interchangeable
// numbers; the note it sends with that board is rendered as-is.
// ---------------------------------------------------------------------------

const $ = (s) => document.querySelector(s);
const statusEl = $('#lbStatus');
const cardEl = $('#lbCard');
const rowsEl = $('#lbRows');

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// A decimal metric must keep its decimals: Intl's default drops them, so 42.80
// seconds would render as "42.8" and 128.50 metres as "128.5". Built per board
// from the metric the server reports.
function formatterFor(metric) {
  const decimals = metric && metric.unit === 's' ? 2 : (metric && /time|distance|accuracy/.test(metric.id || '') ? 1 : 0);
  return new Intl.NumberFormat(undefined, { minimumFractionDigits: 0, maximumFractionDigits: decimals });
}

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

  // Label the value column with this board's metric, and say which way it
  // sorts. Both come from the server; the page never guesses.
  const metric = data.metric || { id: 'points', label: 'Score', explanation: '' };
  const valueHead = document.querySelector('#lbValueHead');
  if (valueHead) valueHead.textContent = metric.label || 'Score';
  const noteEl = document.querySelector('#lbMetricNote');
  if (noteEl) {
    const parts = [metric.explanation, data.note].filter(Boolean);
    noteEl.textContent = parts.join(' ');
    noteEl.hidden = !parts.length;
  }
  const fmt = formatterFor(metric);

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
      <td class="lb-num">${esc(fmt.format(Number(s.score) || 0))}</td>
    </tr>`).join('');

  statusEl.hidden = true;
  cardEl.hidden = false;
}

load();
