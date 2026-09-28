// ============================================================================
// catalog-sanitize.mjs — one choke point for catalog fields that reach HTML.
//
// WHY. The catalog is not authored here. It is merged from bundled JSON files,
// from Supabase rows the grow job fills from third-party feeds, and from
// catalog-overrides.json. Every one of those is untrusted input, and several
// browser renderers interpolate catalog fields into innerHTML. Most escape
// correctly; two did not (a related-games tile wrote `src="${g.thumbnail}"`
// raw, and the category nav wrote the category LABEL raw). A single feed row
// with a quote in its thumbnail URL, or markup in its category label, was
// therefore stored XSS on every page that rendered it.
//
// Fixing each renderer is necessary and was done. This is the second layer:
// the fields are normalised ONCE, where every catalog source converges
// (setCatalog in server.js), so a renderer written next year that forgets to
// escape still receives values that cannot break out of an attribute.
//
// WHAT CHANGES, precisely:
//   title          control/bidi characters removed, whitespace collapsed,
//                  capped at 200 chars. Characters like < and " are KEPT —
//                  they are legitimate in a title and every renderer escapes
//                  text content; this only removes what escaping cannot fix.
//   category_label plain text only: < > " ' ` removed, capped at 60.
//   thumbnail(_url) must be an http(s) URL or a same-origin path. Re-serialised
//                  through the WHATWG URL parser, which percent-encodes the
//                  characters that break attributes (" < > space); ' and `
//                  are encoded too. javascript:, data:, protocol-relative and
//                  anything unparseable become ''.
//   embed_url      must parse as http(s); otherwise the entry is DROPPED —
//                  a game whose frame source is not a web URL is not a game.
//   slug           must match the slug grammar every route validates with;
//                  otherwise the entry is DROPPED, because a slug is spliced
//                  into /play/<slug> URLs and a '../' in one navigates away.
//
// NOT touched: the GameFlare dataset. Its rules require each record's exact
// thumbnail_url and embed_url, never normalised, and it is a separate catalog
// with its own strict validator (lib/gameflare-catalog.mjs).
// ============================================================================

export const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,119}$/;

// Control characters, zero-width and bidi-override code points, line
// separators. A code-point test rather than a regex full of escapes, so the
// ranges stay readable and no editor can turn an escape into the character.
function isInvisible(c) {
  return c < 0x20 || (c >= 0x7f && c <= 0x9f)
    || (c >= 0x200b && c <= 0x200f) || (c >= 0x202a && c <= 0x202e)
    || c === 0x2028 || c === 0x2029 || (c >= 0x2066 && c <= 0x2069) || c === 0xfeff;
}

export function cleanText(v, max) {
  if (v === null || v === undefined) return '';
  const visible = Array.from(String(v)).filter((ch) => !isInvisible(ch.codePointAt(0))).join('');
  return visible.replace(/\s+/g, ' ').trim().slice(0, max);
}

/** A same-origin path, or an absolute http(s) URL, made attribute-safe. '' when neither. */
export function safeImageUrl(v) {
  if (typeof v !== 'string') return '';
  const s = v.trim();
  if (!s) return '';
  if (s.startsWith('/') && !s.startsWith('//')) {
    // Same-origin path: allow only URL-safe characters (including an already
    // percent-encoded query such as /thumb?u=https%3A%2F%2F…).
    return /^\/[A-Za-z0-9._~!$&()*+,;=:@%/?\-]*$/.test(s) ? s : '';
  }
  let u;
  try { u = new URL(s); } catch { return ''; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return '';
  if (u.username || u.password) return '';
  return u.href.replace(/'/g, '%27').replace(/`/g, '%60');
}

function isWebUrl(v) {
  try {
    const u = new URL(String(v));
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch { return false; }
}

/**
 * Normalise one catalog entry in place. Returns the entry, or null when it
 * must be dropped (bad slug, or no usable embed URL).
 */
export function sanitizeCatalogEntry(g) {
  if (!g || typeof g !== 'object') return null;
  if (typeof g.slug !== 'string' || !SLUG_RE.test(g.slug)) return null;
  const embed = g.embed_url ?? g.game_url;
  if (embed !== undefined && embed !== null && embed !== '' && !isWebUrl(embed)) return null;

  g.title = cleanText(g.title, 200) || g.slug;
  if (g.category_label !== undefined && g.category_label !== null) {
    g.category_label = cleanText(g.category_label, 60).replace(/[<>"'`]/g, '') || undefined;
  }
  if (g.thumbnail !== undefined) g.thumbnail = safeImageUrl(g.thumbnail);
  if (g.thumbnail_url !== undefined) g.thumbnail_url = safeImageUrl(g.thumbnail_url);
  return g;
}
