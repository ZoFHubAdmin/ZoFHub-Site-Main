// ZoFHub · community.js — recommendations feed + submit.
import { $, el, fetchJson, escapeHtml, toast, trapFocus, formatRelative } from './utils.js';
import { getPlayerName } from './identity.js';
// The genre list, the "Other needs an explanation" rule and the review
// disclosure all come from ONE module that the server validates against too —
// see public/js/recommendation-taxonomy.js. Rendering the menu from the same
// file the server checks is what stops the two drifting apart.
import {
  GENRES, OTHER_ID, MAX_GENRES, validateGenreSelection, DISCLOSURE, labelFor,
} from './recommendation-taxonomy.js';

const recList  = $('#recList');
const recEmpty = $('#recEmpty');

init();

async function init() {
  bindRecModal();
  await loadRecommendations();
}

// ---------------------------------------------------------------------------
// Recommendations feed
// ---------------------------------------------------------------------------
function prettySlug(s) {
  return String(s || '').replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

async function loadRecommendations() {
  try {
    const data = await fetchJson('/api/recommendations?limit=500');
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

// A recommendation is a SUGGESTION, not a playable catalog tile — an admin
// decides whether it is actually added to the site. So the card shows every
// detail the submitter provided (so it can be evaluated), the embed link in
// full, and how long ago it was posted — and it has no Play button.
function recCard(r) {
  const card = el('div', { class: 'rec-card' });
  const safeTitle = escapeHtml(r.title || 'Game');
  // Prefer the full genre list; fall back to the legacy single column for rows
  // written before db/18_recommendation_taxonomy.sql. labelFor() turns stored ids
  // into the words a reader expects ("rpg" → "Role-playing / RPG").
  const genreIds = Array.isArray(r.genres) && r.genres.length ? r.genres : [r.category || 'arcade'];
  const cat = escapeHtml(genreIds.map(labelFor).join(' · '));
  const author = escapeHtml(r.author || 'Anonymous');
  const posted = r.created_at ? Date.parse(r.created_at) : NaN;
  const when = Number.isFinite(posted) ? escapeHtml(formatRelative(posted)) : '';
  const note    = r.note       ? `<p class="rec-note">${escapeHtml(r.note)}</p>` : '';
  const other   = r.other_text ? fieldRow('Kind of game', r.other_text) : '';
  const extra   = r.extra      ? fieldRow('Notes', r.extra) : '';
  const embed   = linkRow('Embed link', r.embed_url);
  const official = r.official_url ? linkRow('Official page', r.official_url) : '';
  card.innerHTML = `
    <div class="rec-card-top">
      <span class="rec-cat">${cat}</span>
      ${when ? `<span class="rec-time">${when}</span>` : ''}
    </div>
    <h3 class="rec-title">${safeTitle}</h3>
    ${note}
    <dl class="rec-details">
      ${embed}
      ${official}
      ${other}
      ${extra}
    </dl>
    <div class="rec-card-foot">
      <span class="rec-author">by ${author}</span>
    </div>`;
  return card;
}

// A labelled plain-text detail row.
function fieldRow(label, value) {
  return `<dt>${escapeHtml(label)}</dt><dd>${escapeHtml(String(value))}</dd>`;
}

// A labelled link row. Only genuine http(s) URLs become a clickable link;
// anything else (javascript:, data:, a bare host) is shown as inert text so a
// submitted value can never turn into an executable href. The value is always
// escaped, in both attribute and text position.
function linkRow(label, url) {
  const u = String(url || '').trim();
  if (!u) return '';
  const safe = escapeHtml(u);
  const body = /^https?:\/\//i.test(u)
    ? `<a class="rec-link" href="${safe}" target="_blank" rel="noopener noreferrer nofollow">${safe}</a>`
    : `<span class="rec-link">${safe}</span>`;
  return `<dt>${escapeHtml(label)}</dt><dd>${body}</dd>`;
}


// ---------------------------------------------------------------------------
// Recommend modal
// ---------------------------------------------------------------------------
/**
 * Build the genre checkboxes from the shared list.
 *
 * Checkboxes rather than a <select>: a game can genuinely be a puzzle AND a
 * platformer, and the single-choice menu this replaces forced a false pick. The
 * cap is enforced here for immediate feedback and again on the server, because
 * a disabled checkbox is not an access control.
 */
function renderGenres() {
  const host = $('#recGenres');
  if (!host || host.dataset.built) return;
  host.dataset.built = '1';

  for (const g of GENRES) {
    const label = el('label', { class: 'rec-genre' });
    const box = el('input', { type: 'checkbox', name: 'genres', value: g.id });
    label.append(box, el('span', {}, g.label));
    host.appendChild(label);
  }

  const otherWrap = $('#recOtherWrap');
  const otherText = $('#recOtherText');
  const sync = () => {
    const boxes = [...host.querySelectorAll('input[name="genres"]')];
    const chosen = boxes.filter((b) => b.checked);
    // At the cap, the UNCHOSEN boxes are disabled so the limit is visible
    // rather than discovered by having a submission refused.
    for (const b of boxes) b.disabled = !b.checked && chosen.length >= MAX_GENRES;
    const wantsOther = chosen.some((b) => b.value === OTHER_ID);
    if (otherWrap) otherWrap.hidden = !wantsOther;
    if (otherText) {
      otherText.required = wantsOther;
      if (!wantsOther) otherText.value = '';   // never leave a stray note attached
    }
  };
  host.addEventListener('change', sync);
  sync();

  // One constant, rendered in both places it is promised.
  const disc = $('#recDisclosure');
  if (disc) disc.textContent = DISCLOSURE;
}

function bindRecModal() {
  const modal = $('#recModal');
  let releaseFocus = null;
  renderGenres();
  const open  = () => {
    modal.hidden = false;
    // Default the author to this device's persistent player name (no "Anonymous").
    const authorEl = $('#recForm')?.querySelector('input[name="author"]');
    if (authorEl && !authorEl.value.trim()) authorEl.value = getPlayerName();
    releaseFocus = trapFocus(modal, { initial: 'input[name="title"]' });
  };
  const close = () => {
    modal.hidden = true;
    $('#recMsg').textContent = '';
    releaseFocus?.(); releaseFocus = null;
  };
  $('#openRecBtn')?.addEventListener('click', open);
  $('#recClose')?.addEventListener('click', close);
  $('#recCancel')?.addEventListener('click', close);
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
  // The play modal had Escape-to-close and this one didn't, so the two dialogs
  // on the same page behaved differently for no reason.
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !modal.hidden) close(); });

  $('#recForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.currentTarget;
    const msg = $('#recMsg');
    const btn = $('#recSubmit');

    // Validated with the SAME function the server uses, so the message a
    // submitter sees here is the message they would have got from the server —
    // just without the round trip.
    const genres = [...f.querySelectorAll('input[name="genres"]:checked')].map((b) => b.value);
    const check = validateGenreSelection({ genres, otherText: $('#recOtherText')?.value });
    if (!check.ok) {
      msg.className = 'modal-msg err'; msg.textContent = check.error;
      return;
    }

    const body = {
      title: f.title.value, embed_url: f.embed_url.value,
      genres: check.genres, other_text: check.otherText,
      official_url: f.official_url?.value || '',
      note: f.note.value, extra: f.extra?.value || '', author: f.author.value,
    };
    btn.disabled = true; msg.className = 'modal-msg'; msg.textContent = 'Posting…';
    try {
      const r = await fetch('/api/recommendations', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
      });
      const j = await r.json();
      if (!j.ok) { msg.className = 'modal-msg err'; msg.textContent = friendlyError(j.error); return; }
      // "Posted" alone reads as "it is being added". It is not: say so at the
      // exact moment somebody is most likely to assume otherwise.
      msg.className = 'modal-msg ok';
      msg.textContent = 'Thanks — your request was received and is waiting for review. '
        + 'Not every requested game can be added.';
      f.reset();
      // f.reset() unchecks the boxes but does not fire a change event, so the
      // cap-disabling and the Other box would stay as they were.
      $('#recGenres')?.dispatchEvent(new Event('change'));
      toast('Recommendation posted', 'ok');
      await loadRecommendations();
      setTimeout(close, 900);   // close() also releases the focus trap
    } catch {
      msg.className = 'modal-msg err'; msg.textContent = 'Network error — try again.';
    } finally {
      btn.disabled = false;
    }
  });
}
