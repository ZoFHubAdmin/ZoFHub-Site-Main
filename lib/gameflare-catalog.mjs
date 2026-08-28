// lib/gameflare-catalog.mjs — the validated boundary around the supplied
// GameFlare dataset (data/gameflare_verified_games.json).
// ---------------------------------------------------------------------------
// WHAT THIS FILE IS FOR
// The dataset is untrusted input. It arrives as 1.4 MB of third-party JSON
// carrying URLs that this site would put in an iframe and an <img>, which is
// exactly the shape of input that must be validated before use rather than
// after something goes wrong. Everything the UI is allowed to see passes
// through here first.
//
// THE ONE RULE THAT MATTERS
// A record is publicly exposable if and only if it lives in the top-level
// `games` array AND its iframe_compatibility.status is exactly
// "verified_working". Nothing else qualifies — not "not_testable", not any
// failed_* status, not a record that merely looks complete.
//
// As supplied, that yields ZERO public games:
//
//     games              0
//     failed_games       3   (blank_screen, network_dependency, legacy_technology)
//     not_testable_games 295
//     ─────────────────────
//     298 traceability records, 0 exposable
//
// 289 of the 295 not-testable entries are official-listing discovery candidates
// with `embed_url: null` — they were never iframe tested. The dataset says so
// itself in integration_readiness.ready_for_public_catalog = false. This module
// implements that verdict rather than working around it; the catalog renders an
// empty state, which is the honest result and not a bug to be fixed by relaxing
// the filter.
//
// URL ALLOWLISTS ARE PREFIX-EXACT AND NOT DERIVED
// The dataset's own global_embedding_policy forbids constructing an embed URL by
// transforming a canonical page URL. So this module never builds a URL: it takes
// the exact `embed_url` and `thumbnail_url` strings, checks them against fixed
// https:// prefixes, and rejects the whole record if either fails. There is no
// normalisation step and no fallback URL, because a fallback is how an
// unverified endpoint reaches an iframe.
//
// PURE BY DESIGN
// No I/O, no Express, no DOM. `parseCatalog` takes a string or an object and
// returns a result; the caller decides what to do with it. That is what makes
// the policy testable without a server, a browser or the network.
// ---------------------------------------------------------------------------

/** The only iframe_compatibility.status that may ever be shown to the public. */
export const ELIGIBLE_STATUS = 'verified_working';

/**
 * Prefix allowlists. Exact, absolute, https-only.
 *
 * These are prefixes rather than patterns on purpose: a regex over a URL is a
 * well-known source of bypasses (`https://www.gameflare.com.evil.test/embed/`
 * matches a careless `gameflare\.com.*embed` and is a different origin).
 * `String.startsWith` on a full scheme+host+path prefix cannot be fooled that
 * way, because the host is fully pinned before the first wildcard position.
 */
export const ALLOWED_EMBED_PREFIX = 'https://www.gameflare.com/embed/';
export const ALLOWED_CANONICAL_PREFIX = 'https://www.gameflare.com/online-game/';
export const ALLOWED_THUMBNAIL_PREFIX = 'https://data.gameflare.com/';

/** Sorts the catalog UI offers. `rank` is the dataset's own order and default. */
export const SORTS = ['rank', 'rating', 'plays', 'name'];

const isNonEmptyString = (v) => typeof v === 'string' && v.trim().length > 0;

/**
 * A slug that is safe to put in a route and to compare against.
 *
 * Route parameters reach this module as attacker-controlled strings, so the
 * lookup key is constrained to the shape the dataset actually uses rather than
 * being decoded and trusted. Anything else fails the lookup and renders the
 * first-party not-found state.
 */
export const isSafeSlug = (v) => typeof v === 'string' && /^[a-z0-9][a-z0-9-]{0,127}$/.test(v);

function checkUrl(value, prefix, field, errors) {
  if (!isNonEmptyString(value)) { errors.push(`${field}: missing`); return false; }
  if (!value.startsWith(prefix)) { errors.push(`${field}: not on the allowlist`); return false; }
  // startsWith already pins the scheme, but state the https requirement
  // explicitly so loosening a prefix later cannot silently permit http://.
  if (!value.startsWith('https://')) { errors.push(`${field}: not https`); return false; }
  return true;
}

/**
 * Validate ONE record and project it to the minimal shape the UI needs.
 *
 * The projection is deliberate. The dataset carries failure evidence, console
 * audits, legal notes and the test harness's own origin; none of that belongs in
 * a public payload, and the safest way to keep it out is to never copy it into
 * the object the UI receives rather than to remember to strip it later.
 *
 * @returns {{ok: true, game: object} | {ok: false, errors: string[], id: string|null}}
 */
export function validateRecord(rec) {
  const errors = [];
  if (!rec || typeof rec !== 'object' || Array.isArray(rec)) {
    return { ok: false, errors: ['record: not an object'], id: null };
  }

  if (!isNonEmptyString(rec.id)) errors.push('id: missing');
  if (!isNonEmptyString(rec.name)) errors.push('name: missing');
  if (!isSafeSlug(rec.slug)) errors.push('slug: missing or unsafe');

  checkUrl(rec.gameflare_url, ALLOWED_CANONICAL_PREFIX, 'gameflare_url', errors);
  checkUrl(rec.embed_url, ALLOWED_EMBED_PREFIX, 'embed_url', errors);
  checkUrl(rec.thumbnail_url, ALLOWED_THUMBNAIL_PREFIX, 'thumbnail_url', errors);

  const status = rec.iframe_compatibility?.status;
  if (!isNonEmptyString(status)) errors.push('iframe_compatibility.status: missing');

  if (errors.length) return { ok: false, errors, id: isNonEmptyString(rec.id) ? rec.id : null };

  const m = rec.metadata && typeof rec.metadata === 'object' ? rec.metadata : {};
  const categories = Array.isArray(m.categories) ? m.categories.filter(isNonEmptyString) : [];

  return {
    ok: true,
    game: {
      id: rec.id,
      slug: rec.slug,
      name: rec.name,
      rank: Number.isFinite(rec.rank) ? rec.rank : Number.MAX_SAFE_INTEGER,
      embedUrl: rec.embed_url,
      canonicalUrl: rec.gameflare_url,
      thumbnailUrl: rec.thumbnail_url,
      status,
      categories,
      // `developer` is surfaced only when it exists; the dataset sets it to null
      // on every record it did not independently confirm.
      developer: isNonEmptyString(m.developer) ? m.developer : null,
      ratingPercent: Number.isFinite(m.rating_percent) ? m.rating_percent : null,
      // Two different things: an exact number to sort by, and an abbreviated
      // string ("458.5k") to display. The dataset supplies the second far more
      // often than the first, and "458.5k" must never be parsed back into a
      // number — that would invent precision the source explicitly withheld.
      playCount: Number.isFinite(m.play_count) ? m.play_count : null,
      playCountDisplay: isNonEmptyString(m.play_count_display) ? m.play_count_display : null,
    },
  };
}

/**
 * Parse and validate the whole dataset.
 *
 * Never throws. A malformed file is a data condition the site has to survive,
 * not an exception the request handler should discover.
 *
 * @param {string|object} input raw JSON text, or an already-parsed object
 * @returns {{ok: boolean, error: string|null, dataset: object|null, games: object[],
 *            counts: object, rejected: Array<{id: string|null, errors: string[]}>}}
 */
export function parseCatalog(input) {
  const empty = {
    ok: false, error: null, dataset: null, games: [],
    counts: { records: 0, eligible: 0, excludedByStatus: 0, rejectedInvalid: 0, duplicates: 0 },
    rejected: [],
  };

  let doc = input;
  if (typeof input === 'string') {
    try { doc = JSON.parse(input); }
    catch (e) { return { ...empty, error: `invalid JSON: ${e.message}` }; }
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    return { ...empty, error: 'top level is not an object' };
  }

  const arr = (v) => (Array.isArray(v) ? v : null);
  const games = arr(doc.games);
  const failed = arr(doc.failed_games);
  const notTestable = arr(doc.not_testable_games);
  if (!games || !failed || !notTestable) {
    return { ...empty, error: 'missing games / failed_games / not_testable_games arrays' };
  }

  const counts = {
    records: games.length + failed.length + notTestable.length,
    eligible: 0,
    // Everything outside `games` is excluded by policy before validation even
    // runs. It is counted, never parsed into an exposable object.
    excludedByStatus: failed.length + notTestable.length,
    rejectedInvalid: 0,
    duplicates: 0,
  };

  const out = [];
  const rejected = [];
  const seenId = new Set();
  const seenSlug = new Set();

  for (const rec of games) {
    const res = validateRecord(rec);
    if (!res.ok) { counts.rejectedInvalid++; rejected.push({ id: res.id, errors: res.errors }); continue; }

    // A record can be perfectly well-formed and still not exposable.
    if (res.game.status !== ELIGIBLE_STATUS) { counts.excludedByStatus++; continue; }

    // First occurrence wins. A duplicate id or slug would make the player route
    // ambiguous, and "whichever one the loop happened to reach last" is not a
    // resolution rule anyone should depend on.
    if (seenId.has(res.game.id) || seenSlug.has(res.game.slug)) { counts.duplicates++; continue; }
    seenId.add(res.game.id);
    seenSlug.add(res.game.slug);
    out.push(res.game);
  }

  out.sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name));
  counts.eligible = out.length;

  const d = doc.dataset && typeof doc.dataset === 'object' ? doc.dataset : {};
  return {
    ok: true,
    error: null,
    dataset: {
      name: isNonEmptyString(d.name) ? d.name : 'GameFlare catalog',
      source: isNonEmptyString(d.source) ? d.source : 'GameFlare.com',
      generatedAt: isNonEmptyString(d.generated_at) ? d.generated_at : null,
    },
    games: out,
    counts,
    rejected,
  };
}

/**
 * Every record that is STRUCTURALLY valid, regardless of verification status.
 *
 * This is the candidate pool the verification pipeline draws from, and it is
 * deliberately a separate function from parseCatalog: the public catalog must
 * never be one boolean away from exposing an unverified game. A caller that
 * wants candidates has to ask for candidates by name.
 *
 * Records still pass the full URL allowlist, so a candidate with a null or
 * off-host embed_url is excluded here too — there is nothing to verify. In the
 * supplied dataset that removes the 289 discovery entries and leaves 9.
 *
 * `embedOverlay` supplies embed URLs recovered from GameFlare's own published
 * embed code (tools/gameflare-embed-discovery.mjs). It is applied as an OVERLAY
 * rather than written back into the dataset file, for two reasons: the supplied
 * JSON stays byte-for-byte auditable as third-party input, and a recovered URL
 * keeps a separate provenance record instead of becoming indistinguishable from
 * one the vendor shipped. The overlay only ever FILLS a missing value — a record
 * that already carries an embed URL is left exactly as supplied.
 *
 * @param {string|object} input
 * @param {{embedOverlay?: Map<string,string>|object}} [options]
 * @returns {{candidates: object[], counts: object}}
 */
export function parseCandidates(input, options = {}) {
  const empty = { candidates: [], counts: { considered: 0, usable: 0, unusable: 0, fromOverlay: 0 } };
  let doc = input;
  if (typeof input === 'string') {
    try { doc = JSON.parse(input); } catch { return empty; }
  }
  if (!doc || typeof doc !== 'object') return empty;

  const ov = options.embedOverlay instanceof Map
    ? options.embedOverlay
    : new Map(Object.entries(options.embedOverlay || {}));

  const pools = [doc.games, doc.failed_games, doc.not_testable_games].filter(Array.isArray);
  const seen = new Set();
  const out = [];
  let considered = 0, fromOverlay = 0;

  for (const pool of pools) {
    for (const rec of pool) {
      considered++;
      let candidate = rec;
      const supplied = typeof rec?.embed_url === 'string' && rec.embed_url.trim();
      if (!supplied && rec?.slug && ov.has(rec.slug)) {
        // A shallow copy — never a mutation of the caller's parsed dataset.
        candidate = { ...rec, embed_url: ov.get(rec.slug) };
      }
      const res = validateRecord(candidate);
      if (!res.ok) continue;
      if (seen.has(res.game.id) || seen.has(res.game.slug)) continue;
      seen.add(res.game.id); seen.add(res.game.slug);
      if (!supplied) { res.game.embedUrlSource = 'recovered'; fromOverlay++; }
      else res.game.embedUrlSource = 'supplied';
      out.push(res.game);
    }
  }
  out.sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name));
  return {
    candidates: out,
    counts: { considered, usable: out.length, unusable: considered - out.length, fromOverlay },
  };
}

/** Every distinct category across the eligible games, alphabetical. */
export function categoriesOf(games) {
  const s = new Set();
  for (const g of games) for (const c of g.categories) s.add(c);
  return [...s].sort((a, b) => a.localeCompare(b));
}

/**
 * Search / filter / sort. Returns a NEW array; the caller's list is never
 * mutated, because the parsed catalog is shared across every request.
 */
export function filterGames(games, { q = '', category = '', developer = '', sort = 'rank' } = {}) {
  const needle = String(q || '').trim().toLowerCase();
  let out = games;

  if (needle) out = out.filter(g => g.name.toLowerCase().includes(needle));
  if (category) out = out.filter(g => g.categories.includes(category));
  if (developer) out = out.filter(g => g.developer === developer);

  const by = SORTS.includes(sort) ? sort : 'rank';
  out = out.slice();
  if (by === 'rank') out.sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name));
  else if (by === 'name') out.sort((a, b) => a.name.localeCompare(b.name));
  else if (by === 'rating') {
    // Games with no rating sort last rather than being treated as 0 — absent is
    // not the same as bad, and ranking an unrated game below a 1% one is a lie.
    out.sort((a, b) => (b.ratingPercent ?? -1) - (a.ratingPercent ?? -1) || a.rank - b.rank);
  } else if (by === 'plays') {
    // Only the exact numeric play count sorts. play_count_display ("458.5k") is
    // for the eye, never for a comparator.
    out.sort((a, b) => (b.playCount ?? -1) - (a.playCount ?? -1) || a.rank - b.rank);
  }
  return out;
}

/** Look up one eligible game. Returns null for anything unsafe or unknown. */
export function findBySlug(games, slug) {
  if (!isSafeSlug(slug)) return null;
  return games.find(g => g.slug === slug) || null;
}
