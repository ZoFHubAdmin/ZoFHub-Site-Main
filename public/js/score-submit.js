// ZoFHub · score-submit.js
// ---------------------------------------------------------------------------
// The only way a score gets onto the leaderboard.
//
// A play token is requested as soon as the game page opens, NOT when the player
// clicks submit. That is the whole point: the gap between the two is how the
// server can tell a finished run from a script that posted a number the instant
// it loaded the page. The token works once and is bound to this game.
//
// Nothing here decides whether a score is legitimate — the server does that, and
// it may quarantine the submission. The UI reports back exactly what the server
// said rather than assuming success, because a score shown as posted when it is
// actually held for review is a lie the player would repeat to their friends.
// ---------------------------------------------------------------------------

import { getPlayerName } from './identity.js';

const game = window.ZOFHUB_GAME || {};
const slug = String(game.slug || '').trim().toLowerCase();
if (slug) init();

let token = null;

function init() {
  // Ask for the token immediately; a failure is silent and simply means the
  // button will not appear (the leaderboard may not be installed).
  fetch('/api/scores/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ slug }),
  })
    .then((r) => (r.ok ? r.json() : null))
    .then((d) => { if (d && d.ok && d.token) { token = d.token; mountButton(); } })
    .catch(() => { /* no leaderboard here → no control, no broken button */ });
}

function injectStyles() {
  if (document.getElementById('score-css')) return;
  const s = document.createElement('style');
  s.id = 'score-css';
  s.textContent = `
  .sc-back{position:fixed;inset:0;z-index:300;display:grid;place-items:center;
    background:rgba(0,0,0,.62);backdrop-filter:blur(4px)}
  .sc-back[hidden]{display:none}
  .sc-card{width:min(380px,calc(100% - 28px));background:var(--surface,#241a55);
    border:1px solid var(--line-2,rgba(170,140,255,.28));border-radius:16px;padding:22px;
    color:var(--text,#f7f4ff);font-family:Inter,system-ui,sans-serif}
  .sc-card h2{margin:0 0 4px;font-size:17px}
  .sc-card p.sc-sub{margin:0 0 16px;font-size:12.5px;color:var(--text-dim,#c3b6ee);line-height:1.6}
  .sc-card label{display:block;font-size:11px;font-weight:800;letter-spacing:.07em;
    text-transform:uppercase;color:var(--text-dim,#c3b6ee);margin:12px 0 5px}
  .sc-card input{width:100%;box-sizing:border-box;padding:10px 12px;border-radius:9px;
    background:rgba(0,0,0,.28);border:1px solid var(--line-2,rgba(170,140,255,.28));
    color:inherit;font:14px inherit}
  .sc-card input:focus{outline:2px solid #ffd426;outline-offset:1px}
  .sc-row{display:flex;gap:9px;margin-top:18px}
  .sc-row button{flex:1;padding:11px;border-radius:9px;border:0;font:800 13px inherit;cursor:pointer}
  .sc-go{background:#ffd426;color:#221a00}
  .sc-go[disabled]{opacity:.6;cursor:default}
  .sc-x{background:rgba(255,255,255,.09);color:inherit;border:1px solid var(--line-2,rgba(170,140,255,.28))!important}
  .sc-msg{margin:14px 0 0;font-size:12.5px;line-height:1.6;padding:10px 12px;border-radius:9px}
  .sc-msg.ok{background:rgba(46,226,122,.14);color:#8ff0b8}
  .sc-msg.warn{background:rgba(255,176,32,.14);color:#ffd08a}
  .sc-msg.bad{background:rgba(255,93,117,.14);color:#ffa8b6}`;
  document.head.appendChild(s);
}

function mountButton() {
  const host = document.querySelector('.play-actions');
  if (!host || host.querySelector('#postScoreBtn')) return;
  const b = document.createElement('button');
  b.type = 'button';
  b.id = 'postScoreBtn';
  b.className = 'play-notice-btn';
  b.textContent = 'Post score';
  b.setAttribute('aria-haspopup', 'dialog');
  b.addEventListener('click', open);
  host.appendChild(b);
}

let backEl = null, lastFocus = null;

function open() {
  injectStyles();
  lastFocus = document.activeElement;
  if (!backEl) build();
  backEl.hidden = false;
  backEl.querySelector('#scScore').value = '';
  backEl.querySelector('#scMsg').hidden = true;
  backEl.querySelector('#scScore').focus();
  document.addEventListener('keydown', onKey);
}

function close() {
  if (backEl) backEl.hidden = true;
  document.removeEventListener('keydown', onKey);
  if (lastFocus && lastFocus.isConnected) lastFocus.focus();
}

function onKey(e) {
  if (e.key === 'Escape') { e.preventDefault(); close(); }
}

function build() {
  backEl = document.createElement('div');
  backEl.className = 'sc-back';
  backEl.hidden = true;
  backEl.innerHTML = `
    <div class="sc-card" role="dialog" aria-modal="true" aria-labelledby="scTitle">
      <h2 id="scTitle">Post your score</h2>
      <p class="sc-sub">Scores are reported by players, not read from the game.
        Unusually high scores are held for review before they appear.</p>
      <label for="scName">Name</label>
      <input id="scName" type="text" maxlength="40" autocomplete="nickname" spellcheck="false" />
      <label for="scScore">Score</label>
      <input id="scScore" type="text" inputmode="numeric" pattern="[0-9]*" placeholder="e.g. 12500" />
      <p id="scMsg" class="sc-msg" role="status" aria-live="polite" hidden></p>
      <div class="sc-row">
        <button type="button" class="sc-x" id="scCancel">Cancel</button>
        <button type="button" class="sc-go" id="scGo">Submit</button>
      </div>
    </div>`;
  document.body.appendChild(backEl);
  backEl.addEventListener('click', (e) => { if (e.target === backEl) close(); });
  backEl.querySelector('#scCancel').addEventListener('click', close);
  backEl.querySelector('#scGo').addEventListener('click', submit);

  try { backEl.querySelector('#scName').value = getPlayerName() || ''; } catch { /* optional */ }
}

function msg(text, kind) {
  const m = backEl.querySelector('#scMsg');
  m.textContent = text;
  m.className = 'sc-msg ' + kind;
  m.hidden = false;
}

async function submit() {
  const go = backEl.querySelector('#scGo');
  const raw = backEl.querySelector('#scScore').value.trim();
  if (!/^\d{1,15}$/.test(raw)) { msg('Enter your score as a whole number.', 'bad'); return; }
  if (!token) { msg('This game session has expired — reload the page and try again.', 'bad'); return; }

  go.disabled = true;
  go.textContent = 'Submitting…';
  try {
    const r = await fetch('/api/scores', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        slug, token, score: raw,
        player_name: backEl.querySelector('#scName').value,
      }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { msg(d.error || 'Could not submit that score.', 'bad'); return; }

    // The token is single-use: once spent it cannot be reused, so the control
    // must not pretend another submission is possible.
    token = null;
    if (d.recorded === false) {
      msg(d.message || 'You already have a higher score for this game.', 'warn');
    } else if (d.pending) {
      msg(d.message || 'Held for review.', 'warn');
    } else {
      msg('Score saved. See it on the leaderboard.', 'ok');
    }
    const btn = document.querySelector('#postScoreBtn');
    if (btn) btn.disabled = true;
  } catch {
    msg('Network problem — try again in a moment.', 'bad');
  } finally {
    go.disabled = false;
    go.textContent = 'Submit';
  }
}
