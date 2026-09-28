// lib/cms-rules.mjs — the content rules of the game CMS, as pure functions.
// ---------------------------------------------------------------------------
// Two things live here and nothing else:
//
//   1. THE LIFECYCLE. A game is not public because a row exists. It moves
//
//          draft ─submit→ pending_review ─approve→ approved ─publish→ published
//            ↑               │ reject                               │ unpublish
//            └──reopen── rejected                              unpublished
//                                                                    │ archive
//                                                                archived ─restore→ unpublished
//
//      and each arrow names the permission it needs. The database mirrors the
//      state set as a CHECK constraint; this file decides which arrows exist.
//
//   2. FIELD VALIDATION. Everything an admin can type is checked here, server
//      side, before it reaches the database. HTML is REJECTED rather than
//      stripped: silently rewriting what somebody typed hides the attempt, and
//      the fields are plain text everywhere they are shown anyway.
//
// No I/O. lib/cms-service.mjs calls these and does the storage.
// ---------------------------------------------------------------------------

import { checkUrlSafety } from './game-discovery.mjs';

export const STATUSES = Object.freeze(['draft', 'pending_review', 'approved', 'published', 'unpublished', 'archived', 'rejected']);

/** action → { from, to, perm }. The only moves a game can make. */
export const TRANSITIONS = Object.freeze({
  submit:    { from: ['draft', 'rejected'],                                    to: 'pending_review', perm: 'games.update' },
  withdraw:  { from: ['pending_review'],                                       to: 'draft',          perm: 'games.update' },
  approve:   { from: ['pending_review'],                                       to: 'approved',       perm: 'games.review' },
  reject:    { from: ['pending_review'],                                       to: 'rejected',       perm: 'games.review', needsNote: true },
  publish:   { from: ['approved', 'unpublished'],                              to: 'published',      perm: 'games.publish' },
  unpublish: { from: ['published'],                                            to: 'unpublished',    perm: 'games.publish' },
  reopen:    { from: ['approved', 'unpublished'],                              to: 'draft',          perm: 'games.update' },
  archive:   { from: ['draft', 'rejected', 'approved', 'published', 'unpublished'], to: 'archived',   perm: 'games.archive' },
  restore:   { from: ['archived'],                                             to: 'unpublished',    perm: 'games.archive' },
});
export const ACTIONS = Object.freeze(Object.keys(TRANSITIONS));

/** A game is visible to visitors only in this state (and only while it loads). */
export const PUBLIC_STATUS = 'published';

/**
 * Fields whose change on a game that has already passed review sends it BACK to
 * review, unless the editor could have published it themselves. Without this a
 * content manager could take an approved game and point it somewhere else.
 */
export const MATERIAL_FIELDS = Object.freeze(['game_url', 'provider_id', 'thumbnail_url']);
export const REVIEWED_STATUSES = Object.freeze(['approved', 'published', 'unpublished']);

/** Fields recorded before/after in the audit trail when they change. */
export const AUDITED_FIELDS = Object.freeze([
  'slug', 'title', 'game_url', 'thumbnail_url', 'provider_id', 'category', 'status',
  'featured', 'sort_order', 'description', 'short_description', 'publisher', 'developer',
  'embed_width', 'embed_height', 'review_note',
]);

export const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,119}$/;
export const NEW_CATEGORY_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const TAG_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** Is `action` a legal move from `status`? */
export function transitionFor(action, status) {
  const t = TRANSITIONS[action];
  if (!t) return { ok: false, reason: 'unknown action' };
  if (!t.from.includes(status)) return { ok: false, reason: `cannot ${action} a game that is ${status.replace('_', ' ')}` };
  return { ok: true, to: t.to, perm: t.perm, needsNote: !!t.needsNote };
}

export function slugify(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/, '');
}

const HTML_RE = /<\s*[a-z!/?]|&#|javascript:|data:text\/html/i;
// Code points that corrupt display or reorder text: C0 controls (except tab and
// newline), DEL, the Unicode line/paragraph separators, and the bidi overrides
// used to make a filename or title read differently from what it is. Checked
// by code point rather than a regex literal so no editor can turn an escape
// into the raw separator it names.
function hasControl(v) {
  for (const ch of v) {
    const c = ch.codePointAt(0);
    if ((c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) || c === 0x7f
        || c === 0x2028 || c === 0x2029 || (c >= 0x202a && c <= 0x202e)
        || (c >= 0x2066 && c <= 0x2069)) return true;
  }
  return false;
}

/** Plain-text field check. Returns [value, error]. */
function text(raw, { name, max, required = false, multiline = false }) {
  if (raw === undefined) return [undefined, required ? `${name} is required` : null];
  if (raw === null || raw === '') return [null, required ? `${name} is required` : null];
  if (typeof raw !== 'string') return [undefined, `${name} must be text`];
  const v = multiline ? raw.replace(/\r\n?/g, '\n').trim() : raw.trim();
  if (!v) return [null, required ? `${name} is required` : null];
  if (v.length > max) return [undefined, `${name} is longer than ${max} characters`];
  if (HTML_RE.test(v)) return [undefined, `${name} must be plain text — HTML and script URLs are not allowed`];
  if (!multiline && /\n/.test(v)) return [undefined, `${name} must be one line`];
  if (hasControl(v)) return [undefined, `${name} contains control or direction-override characters`];
  return [v, null];
}

/**
 * A URL a visitor's browser will load. https only, no credentials, no internal
 * or IP-literal host, bounded length. Provider-origin rules are applied by the
 * caller, which knows the provider.
 */
export function checkPublicUrl(raw, name) {
  if (typeof raw !== 'string' || !raw.trim()) return [undefined, `${name} is required`];
  const v = raw.trim();
  if (v.length > 2048) return [undefined, `${name} is too long`];
  const safe = checkUrlSafety(v);
  if (!safe.ok) return [undefined, `${name} is not allowed (${safe.reason.replace(/_/g, ' ')})`];
  let u;
  try { u = new URL(v); } catch { return [undefined, `${name} is not a valid URL`]; }
  if (u.port && u.port !== '443') return [undefined, `${name} must use the standard https port`];
  if (/^\d+(\.\d+){3}$/.test(u.hostname) || u.hostname.startsWith('[')) return [undefined, `${name} must use a hostname, not an IP address`];
  if (/(^|\.)(lan|home\.arpa|test|invalid)$/i.test(u.hostname)) return [undefined, `${name} points at a non-public name`];
  return [u.toString(), null];
}

/** Same-origin thumbnails this site serves itself. */
export const LOCAL_THUMB_RE = /^\/thumbs\/[A-Za-z0-9][A-Za-z0-9._-]{0,120}\.(png|jpe?g|webp|gif)$/;

export function checkThumbnail(raw) {
  if (raw === null || raw === '' || raw === undefined) return [raw === undefined ? undefined : null, null];
  if (typeof raw !== 'string') return [undefined, 'thumbnail_url must be text'];
  const v = raw.trim();
  if (LOCAL_THUMB_RE.test(v)) return [v, null];
  if (v.startsWith('/')) return [undefined, 'a local thumbnail must be /thumbs/<name>.png|jpg|webp|gif'];
  const [u, err] = checkPublicUrl(v, 'thumbnail_url');
  if (err) return [undefined, err];
  // SVG can carry script. An <img> will not run it, but a thumbnail URL is also
  // opened directly and proxied through /thumb, so it is refused outright.
  if (/\.svgz?($|[?#])/i.test(new URL(u).pathname)) return [undefined, 'SVG thumbnails are not allowed'];
  return [u, null];
}

/**
 * Validate a game record from the console.
 *
 * `partial` = an edit: absent fields are left alone. Returns
 * { ok, value, errors } where `value` holds only the fields that were supplied
 * and valid. Provider-origin and category-existence checks need data, so they
 * are the service's job; everything knowable from the input alone is here.
 */
export function validateGameInput(input, { partial = false } = {}) {
  const errors = [];
  const v = {};
  const src = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const put = (k, [val, err]) => { if (err) errors.push(err); else if (val !== undefined) v[k] = val; };
  const has = (k) => Object.prototype.hasOwnProperty.call(src, k);

  put('title', text(src.title, { name: 'title', max: 120, required: !partial }));
  if (has('slug') || !partial) {
    const raw = has('slug') && src.slug ? String(src.slug) : slugify(src.title);
    if (!SLUG_RE.test(raw)) errors.push('slug must be lowercase letters, digits and hyphens (max 120)');
    else v.slug = raw;
  }
  put('description', text(src.description, { name: 'description', max: 4000, multiline: true }));
  put('short_description', text(src.short_description, { name: 'short_description', max: 280 }));
  put('publisher', text(src.publisher, { name: 'publisher', max: 120 }));
  put('developer', text(src.developer, { name: 'developer', max: 120 }));
  put('review_note', text(src.review_note, { name: 'review_note', max: 1000, multiline: true }));

  if (has('game_url') || !partial) put('game_url', checkPublicUrl(src.game_url, 'game_url'));
  if (has('thumbnail_url')) put('thumbnail_url', checkThumbnail(src.thumbnail_url));

  if (has('provider_id') || !partial) {
    if (typeof src.provider_id !== 'string' || !/^[a-z0-9][a-z0-9-]{1,39}$/.test(src.provider_id)) errors.push('provider_id is required');
    else v.provider_id = src.provider_id;
  }
  if (has('category') || !partial) {
    const c = typeof src.category === 'string' ? src.category.trim().toLowerCase() : '';
    if (!c || c.length > 40 || /[\r\n\t<>]/.test(c)) errors.push('category is required');
    else v.category = c;
  }
  if (has('featured')) {
    if (typeof src.featured !== 'boolean') errors.push('featured must be true or false');
    else v.featured = src.featured;
  }
  if (has('sort_order')) {
    const n = src.sort_order;
    if (!Number.isInteger(n) || n < -100000 || n > 100000) errors.push('sort_order must be a whole number between -100000 and 100000');
    else v.sort_order = n;
  }
  for (const k of ['embed_width', 'embed_height']) {
    if (!has(k)) continue;
    const n = src[k];
    if (n === null) { v[k] = null; continue; }
    if (!Number.isInteger(n) || n < 100 || n > 4096) errors.push(`${k} must be between 100 and 4096`);
    else v[k] = n;
  }
  if (has('tags')) {
    if (!Array.isArray(src.tags) || src.tags.length > 30) errors.push('tags must be a list of at most 30');
    else {
      const out = [];
      for (const t of src.tags) {
        const s = typeof t === 'string' ? slugify(t).slice(0, 40) : '';
        if (!TAG_RE.test(s)) { errors.push(`tag "${String(t).slice(0, 40)}" is not valid`); continue; }
        if (!out.includes(s)) out.push(s);
      }
      v.tags = out;
    }
  }
  // Anything else the client sent is ignored, never written: status, ids,
  // created_by and timestamps are set by the server alone.
  return { ok: errors.length === 0, value: v, errors };
}

export function validateCategoryInput(input, { partial = false } = {}) {
  const errors = [];
  const v = {};
  const src = input && typeof input === 'object' ? input : {};
  const has = (k) => Object.prototype.hasOwnProperty.call(src, k);
  if (!partial) {
    if (typeof src.slug !== 'string' || !NEW_CATEGORY_RE.test(src.slug)) errors.push('slug must be lowercase letters, digits and hyphens (max 40)');
    else v.slug = src.slug;
  }
  const [label, le] = text(src.label, { name: 'label', max: 60, required: !partial });
  if (le) errors.push(le); else if (label !== undefined) v.label = label;
  const [desc, de] = text(src.description, { name: 'description', max: 500, multiline: true });
  if (de) errors.push(de); else if (desc !== undefined) v.description = desc;
  if (has('parent_slug')) {
    if (src.parent_slug === null || src.parent_slug === '') v.parent_slug = null;
    else if (typeof src.parent_slug !== 'string' || src.parent_slug.length > 40) errors.push('parent_slug is not valid');
    else v.parent_slug = src.parent_slug;
  }
  if (has('sort_order')) {
    if (!Number.isInteger(src.sort_order) || Math.abs(src.sort_order) > 100000) errors.push('sort_order must be a whole number');
    else v.sort_order = src.sort_order;
  }
  if (has('visible')) {
    if (typeof src.visible !== 'boolean') errors.push('visible must be true or false');
    else v.visible = src.visible;
  }
  return { ok: errors.length === 0, value: v, errors };
}

export default {
  STATUSES, TRANSITIONS, ACTIONS, PUBLIC_STATUS, MATERIAL_FIELDS, REVIEWED_STATUSES, AUDITED_FIELDS,
  transitionFor, slugify, validateGameInput, validateCategoryInput, checkPublicUrl, checkThumbnail,
};
