// public/js/recommendation-taxonomy.js — the genres a visitor may tag a game
// recommendation with, and the rules about that choice.
// ---------------------------------------------------------------------------
// WHY THIS IS ONE SHARED FILE. The old list was ten <option> elements written
// directly into public/community.html, and the server independently accepted any
// 40-character string as a category. Two consequences:
//
//   · the menu and the validation could not agree, because neither knew about
//     the other — the server would happily store "Platfromer";
//   · adding a genre meant editing markup, which is why it had not been done.
//
// So the list lives here, ONCE, and is imported by both the browser (to render
// the form) and the server (to validate what comes back). This is the same
// arrangement public/js/ai-prompt.js already uses for the AI system prompt, and
// for the same reason: an allow-list that is only enforced on one side is a
// suggestion.
//
// IT IS DATA, NOT MARKUP. Each entry is { id, label }. The id is what is stored
// and compared; the label is what a person reads. Renaming a label is therefore
// safe, while changing an id is a migration — which is the right way round.
// ---------------------------------------------------------------------------

/**
 * The genres, in the order the form shows them.
 *
 * Ordered roughly by how often people actually reach for them rather than
 * alphabetically, with `other` deliberately LAST because it is the escape hatch
 * and should be read as such.
 */
export const GENRES = Object.freeze([
  { id: 'action',      label: 'Action' },
  { id: 'adventure',   label: 'Adventure' },
  { id: 'arcade',      label: 'Arcade' },
  { id: 'platformer',  label: 'Platformer' },
  { id: 'puzzle',      label: 'Puzzle' },
  { id: 'racing',      label: 'Racing' },
  { id: 'sports',      label: 'Sports' },
  { id: 'strategy',    label: 'Strategy' },
  { id: 'simulation',  label: 'Simulation' },
  { id: 'rpg',         label: 'Role-playing / RPG' },
  { id: 'shooter',     label: 'Shooter' },
  { id: 'fighting',    label: 'Fighting' },
  { id: 'survival',    label: 'Survival' },
  { id: 'horror',      label: 'Horror' },
  { id: 'multiplayer', label: 'Multiplayer' },
  { id: 'casual',      label: 'Casual' },
  { id: 'idle',        label: 'Idle / Clicker' },
  { id: 'rhythm',      label: 'Rhythm / Music' },
  { id: 'card',        label: 'Card / Board' },
  { id: 'educational', label: 'Educational' },
  { id: 'creative',    label: 'Creative / Sandbox' },
  { id: 'retro',       label: 'Retro / Classic' },
  { id: 'io',          label: 'MMO / IO' },
  { id: 'other',       label: 'Other' },
]);

export const GENRE_IDS = Object.freeze(GENRES.map((g) => g.id));

/** The one genre that is not self-explanatory, so it has to be explained. */
export const OTHER_ID = 'other';

/** How many genres one recommendation may carry. */
export const MAX_GENRES = 3;
export const OTHER_TEXT_MAX = 120;

export const isGenre = (id) => GENRE_IDS.includes(id);
export const labelFor = (id) => (GENRES.find((g) => g.id === id) || {}).label || id;

/**
 * Coerce whatever arrived into a clean, bounded list of known genre ids.
 *
 * Accepts an array or a comma-separated string, because a form can submit
 * either and a stored row may predate the array column. Unknown ids are
 * DROPPED rather than rejected: a submission naming two real genres and one
 * typo is a usable submission, and refusing the whole thing would lose a
 * contribution over a spelling.
 */
export function normalizeGenres(raw) {
  const list = Array.isArray(raw) ? raw : String(raw ?? '').split(',');
  const out = [];
  for (const item of list) {
    const id = String(item ?? '').trim().toLowerCase();
    if (isGenre(id) && !out.includes(id)) out.push(id);
    if (out.length >= MAX_GENRES) break;
  }
  return out;
}

/**
 * Validate a genre selection, including the rule that `other` must say what it
 * means.
 *
 * Returns the cleaned selection or a message aimed at the person who typed it.
 * `otherText` is only kept when `other` was actually chosen — otherwise a
 * submitter who ticked Other, typed an explanation and then unticked it would
 * leave a stray note attached to unrelated genres.
 *
 * @returns {{ok: true, genres: string[], otherText: string} | {ok: false, error: string}}
 */
export function validateGenreSelection({ genres, otherText } = {}) {
  const chosen = normalizeGenres(genres);
  if (!chosen.length) {
    return { ok: false, error: `Choose at least one category (up to ${MAX_GENRES}).` };
  }
  if (!chosen.includes(OTHER_ID)) {
    return { ok: true, genres: chosen, otherText: '' };
  }
  // "Other" with no explanation is the one combination that carries no
  // information at all, so it is the one thing refused outright.
  const text = cleanText(otherText, OTHER_TEXT_MAX);
  if (text.length < 3) {
    return { ok: false, error: 'You chose "Other" — please say which kind of game it is.' };
  }
  return { ok: true, genres: chosen, otherText: text };
}

/**
 * Strip a free-text field down to inert, single-line text.
 *
 * Exported because the server validates the same field and must apply the
 * identical rule — two implementations of "what counts as safe text" is how one
 * of them ends up more generous than the other. Control characters, the
 * zero-width and bidi ranges and the line separators are removed because this
 * string is rendered in a list beside other people's submissions, and angle
 * brackets go because nothing here is ever markup.
 */
export function cleanText(value, max = OTHER_TEXT_MAX) {
  if (typeof value !== 'string') return '';
  const kept = Array.from(value).filter((ch) => {
    const c = ch.codePointAt(0);
    if (c < 0x20 || c === 0x7f) return false;         // control characters
    if (c >= 0x200b && c <= 0x200f) return false;     // zero-width + bidi marks
    if (c >= 0x202a && c <= 0x202e) return false;     // bidi overrides
    if (c === 0x2028 || c === 0x2029) return false;   // line/paragraph separators
    if (ch === '<' || ch === '>') return false;       // never markup
    return true;
  }).join('');
  return kept.replace(/\s+/g, ' ').trim().slice(0, max);
}

/**
 * What the site promises about a request, in one place.
 *
 * Shown next to the submit button AND in the confirmation, because the moment a
 * submission succeeds is exactly when somebody is most likely to believe their
 * game is now being added. One constant means the two cannot drift into saying
 * different things.
 */
export const DISCLOSURE = 'Game requests are suggestions, not guarantees. '
  + 'ZoFHub cannot add every requested game. Requests are reviewed based on licensing and permissions, '
  + 'safety, technical compatibility, quality, performance, maintenance requirements, and catalog capacity. '
  + 'The catalog is intentionally limited, and only authorized administrators can approve additions.';

export default {
  GENRES, GENRE_IDS, OTHER_ID, MAX_GENRES, OTHER_TEXT_MAX,
  isGenre, labelFor, normalizeGenres, validateGenreSelection, cleanText, DISCLOSURE,
};
