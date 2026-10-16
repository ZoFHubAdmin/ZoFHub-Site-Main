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
//
// WHAT THE FIELD SAYS IS ALSO THE SERVER'S DECISION. The form used to hardcode a
// label of "Score" and a whole-numbers-only pattern, for every game. So a golf
// game measured in metres and a time trial measured in seconds both asked for
// "Score" and refused a decimal point, and the player had to guess what number
// was wanted. The label, unit, precision, bounds and keypad now come from
// GET /api/scores/profile, and the client validates against what it was told
// rather than against a rule of its own.
//
// A game whose metric nobody has confirmed gets the neutral "Score" field back —
// the server decides that too (lib/scoring-profiles.mjs formFieldFor), so a
// derived guess is never presented to a player as fact.
// ---------------------------------------------------------------------------

import { getPlayerName } from './identity.js';

const game = window.ZOFHUB_GAME || {};
const slug = String(game.slug || '').trim().toLowerCase();
if (slug) init();

let token = null;

// What this game's submission field should look like. Null until the profile
// arrives; FIELD_FALLBACK stands in if that request fails, so a profile outage
// degrades to the old neutral field instead of a dead dialog.
let field = null;
const FIELD_FALLBACK = {
  metricId: 'points', label: 'Score', unit: null, valueType: 'integer',
  precision: 0, min: 0, max: 1000000000, inputMode: 'numeric', step: '1',
  placeholder: 'e.g. 12500', help: '', generic: true,
};

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

  // The profile is fetched in parallel rather than awaited: the button should
  // appear as soon as the token does, and the dialog applies the field when it
  // opens (by which time this has almost always landed).
  fetch('/api/scores/profile?slug=' + encodeURIComponent(slug))
    .then((r) => (r.ok ? r.json() : null))
    .then((d) => { if (d && d.ok && d.field) field = d.field; })
    .catch(() => { /* FIELD_FALLBACK covers it */ });
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
  .sc-help{margin:7px 0 0!important;font-size:11.5px;opacity:.85}
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
  applyField();
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
      <label for="scScore" id="scScoreLabel">Score</label>
      <input id="scScore" type="text" inputmode="numeric" placeholder="e.g. 12500" />
      <p id="scHelp" class="sc-sub sc-help" hidden></p>
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

/**
 * Point the input at this game's metric.
 *
 * inputMode matters more than it looks: a decimal metric given
 * inputMode="numeric" shows a phone keypad with NO decimal point, so the player
 * physically cannot type 42.80. The server sends the right one per metric.
 */
function applyField() {
  const f = field || FIELD_FALLBACK;
  const label = backEl.querySelector('#scScoreLabel');
  const input = backEl.querySelector('#scScore');
  const help = backEl.querySelector('#scHelp');
  if (label) { label.textContent = f.label; }
  if (input) {
    input.placeholder = f.placeholder || '';
    input.inputMode = f.inputMode || 'numeric';
    input.setAttribute('aria-describedby', 'scHelp');
  }
  if (help) {
    help.textContent = f.help || '';
    help.hidden = !f.help;
  }
}

/** Validate against the profile we were given, not a rule of our own. */
function checkValue(raw) {
  const f = field || FIELD_FALLBACK;
  const pattern = f.valueType === 'integer' ? /^\d{1,15}$/ : /^\d{1,15}(\.\d{1,3})?$/;
  const name = String(f.label || 'score').toLowerCase();
  if (!pattern.test(raw)) {
    return f.valueType === 'integer'
      ? `Enter ${name} as a whole number.`
      : `Enter ${name} as a number (up to ${f.precision} decimal place${f.precision === 1 ? '' : 's'}).`;
  }
  const decimals = (raw.split('.')[1] || '').length;
  if (decimals > f.precision) {
    return `${f.label} allows at most ${f.precision} decimal place${f.precision === 1 ? '' : 's'}.`;
  }
  const n = Number(raw);
  if (!Number.isFinite(n)) return 'Enter a number.';
  if (n < f.min) return `${f.label} cannot be below ${f.min}.`;
  if (n > f.max) return `${f.label} cannot be above ${f.max}.`;
  return null;   // the server checks all of this again; this is just fast feedback
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
  const problem = checkValue(raw);
  if (problem) { msg(problem, 'bad'); return; }
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
