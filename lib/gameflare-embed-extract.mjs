// lib/gameflare-embed-extract.mjs — classify what a GameFlare game page says
// about its own embed URL.
// ---------------------------------------------------------------------------
// WHY THIS IS A SEPARATE, PURE MODULE
// The dataset ships 289 records with `embed_url: null`, and its own policy says
// the reason is that a pattern-derived endpoint is not evidence. So the only
// legitimate way to fill that field is to read the URL GameFlare itself
// publishes on the game page. That is a network operation; the DECISION about
// what was read is not, and keeping the decision here means it can be tested
// against captured page shapes without a browser or a live site.
//
// THE AUTHORITATIVE SOURCE, IN ORDER
//   1. The "Embed code" widget — a <textarea> holding GameFlare's own
//      `<iframe src="…">` snippet. This is the publisher telling you, in its own
//      markup, which URL it intends third parties to embed.
//   2. `#iframe-in-game` — the player iframe the page itself renders.
// Both are read. (1) decides; (2) is a cross-check, and a disagreement between
// them is reported rather than silently resolved, because "the page shows one
// URL and offers another" is a fact a human should see.
//
// WHAT IS NEVER DONE
// No URL is constructed. `https://www.gameflare.com/embed/${slug}/` is never
// assembled from a slug, not even when the pattern is obvious and would produce
// a string identical to the one on the page. A guess that happens to be right is
// still a guess, and it carries no evidence that the endpoint exists.
//
// SOFT 404s ARE REAL HERE
// GameFlare serves a missing game as HTTP 200 with an "ERROR 404 / PAGE DOES NOT
// EXIST" body. Treating HTTP status as existence would classify a dead slug as
// "reachable but offers no embed", which is a different and less actionable
// answer than "this game is not on GameFlare any more".
// ---------------------------------------------------------------------------

import { ALLOWED_EMBED_PREFIX } from './gameflare-catalog.mjs';

/**
 * Phase-1 statuses. A record moves from `missing_embed_url` to exactly one of
 * the other three; nothing here ever produces a verification verdict, because
 * having an embed URL says nothing about whether the game runs.
 */
export const EMBED_STATUS = {
  MISSING: 'missing_embed_url',
  FOUND: 'embed_url_found',
  INVALID: 'embed_url_invalid',
  UNAVAILABLE: 'embed_url_unavailable',
};

/**
 * Why a page produced the status it did. Carried alongside the status because
 * "unavailable" covers three genuinely different situations — the game is gone,
 * the page exists but publishes no embed snippet, and the page could not be
 * read at all — and collapsing them would lose the only detail that says which
 * ones are worth retrying.
 */
export const EMBED_REASON = {
  OK: 'embed_code_published',
  NO_EMBED_CODE: 'page_publishes_no_embed_code',
  PAGE_NOT_FOUND: 'game_page_not_found',
  UNREACHABLE: 'page_unreachable',
  CHALLENGED: 'bot_challenge_not_cleared',
  OFF_ALLOWLIST: 'embed_url_off_allowlist',
  DISAGREEMENT: 'embed_code_and_player_iframe_disagree',
};

/** GameFlare's soft-404 body. Matched on the page text, not the HTTP status. */
const NOT_FOUND_RE = /\bERROR\s*404\b|\bPAGE DOES NOT EXIST\b/i;

/** A Cloudflare interstitial, which is not a game page and must not be parsed. */
const CHALLENGE_RE = /just a moment|attention required|checking your browser/i;

/**
 * Pull every `src` out of an embed snippet.
 *
 * Deliberately a narrow attribute match rather than HTML parsing: the input is
 * a short publisher-authored snippet, and anything that does not look exactly
 * like `<iframe … src="…">` should fail to match rather than be recovered by a
 * lenient parser. Handles single and double quotes because both appear in
 * hand-maintained snippets.
 */
export function srcsFromEmbedCode(code) {
  if (typeof code !== 'string' || !code) return [];
  const out = [];
  const re = /<iframe\b[^>]*?\ssrc\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
  for (const m of code.matchAll(re)) {
    const v = (m[1] ?? m[2] ?? '').trim();
    if (v) out.push(v);
  }
  return [...new Set(out)];
}

/**
 * Decide what one captured game page says about its embed URL.
 *
 * @param {object} page captured, already-rendered page facts
 * @param {string}   page.title
 * @param {string}   page.bodyText      visible text, for soft-404 detection
 * @param {string[]} page.textareas     every textarea value on the page
 * @param {string|null} page.inGameSrc  `#iframe-in-game`'s src, if present
 * @param {string|null} page.error      transport/navigation error, if any
 * @returns {{status: string, reason: string, embedUrl: string|null,
 *            evidence: {embedCodeSrcs: string[], playerIframeSrc: string|null}}}
 */
export function classifyPage(page) {
  const p = page && typeof page === 'object' ? page : {};
  const evidence = { embedCodeSrcs: [], playerIframeSrc: null };
  const fail = (reason) => ({ status: EMBED_STATUS.UNAVAILABLE, reason, embedUrl: null, evidence });

  if (p.error) return fail(EMBED_REASON.UNREACHABLE);

  const title = typeof p.title === 'string' ? p.title : '';
  const body = typeof p.bodyText === 'string' ? p.bodyText : '';
  if (CHALLENGE_RE.test(title)) return fail(EMBED_REASON.CHALLENGED);

  // Order matters: a 404 body still renders the site's normal chrome, including
  // a sidebar of other games. Checking for the embed widget first on such a page
  // would be checking a page that is not about this game at all.
  if (NOT_FOUND_RE.test(body)) return fail(EMBED_REASON.PAGE_NOT_FOUND);

  const textareas = Array.isArray(p.textareas) ? p.textareas.filter(t => typeof t === 'string') : [];
  const codeSrcs = [...new Set(textareas.flatMap(srcsFromEmbedCode))];
  const playerSrc = typeof p.inGameSrc === 'string' && p.inGameSrc.trim() ? p.inGameSrc.trim() : null;
  evidence.embedCodeSrcs = codeSrcs;
  evidence.playerIframeSrc = playerSrc;

  if (!codeSrcs.length) return fail(EMBED_REASON.NO_EMBED_CODE);

  // More than one distinct URL in the snippet means the page is not making a
  // single unambiguous statement. Picking one would be the caller inventing the
  // answer the page declined to give.
  if (codeSrcs.length > 1) {
    return { status: EMBED_STATUS.INVALID, reason: EMBED_REASON.DISAGREEMENT, embedUrl: null, evidence };
  }

  const url = codeSrcs[0];
  if (!url.startsWith(ALLOWED_EMBED_PREFIX)) {
    return { status: EMBED_STATUS.INVALID, reason: EMBED_REASON.OFF_ALLOWLIST, embedUrl: null, evidence };
  }

  // The cross-check. A page that renders one URL and hands out another is not
  // something to resolve by preference — it is reported and left for a human.
  if (playerSrc && playerSrc !== url) {
    return { status: EMBED_STATUS.INVALID, reason: EMBED_REASON.DISAGREEMENT, embedUrl: null, evidence };
  }

  return { status: EMBED_STATUS.FOUND, reason: EMBED_REASON.OK, embedUrl: url, evidence };
}

/**
 * Roll a set of per-page results into the counts Phase 1 asks for.
 *
 * `duplicates` counts embed URLs claimed by more than one slug. That would mean
 * two catalog entries pointing at one game, which the verifier would then test
 * twice and the catalog would list twice.
 */
export function summarise(results) {
  const rows = Array.isArray(results) ? results : [];
  const byStatus = {};
  const urlOwners = new Map();

  for (const r of rows) {
    byStatus[r.status] = (byStatus[r.status] || 0) + 1;
    if (r.status === EMBED_STATUS.FOUND && r.embedUrl) {
      if (!urlOwners.has(r.embedUrl)) urlOwners.set(r.embedUrl, []);
      urlOwners.get(r.embedUrl).push(r.slug);
    }
  }

  const duplicates = [...urlOwners.entries()]
    .filter(([, slugs]) => slugs.length > 1)
    .map(([url, slugs]) => ({ embedUrl: url, slugs }));

  return {
    total: rows.length,
    found: byStatus[EMBED_STATUS.FOUND] || 0,
    invalid: byStatus[EMBED_STATUS.INVALID] || 0,
    unavailable: byStatus[EMBED_STATUS.UNAVAILABLE] || 0,
    stillMissing: byStatus[EMBED_STATUS.MISSING] || 0,
    distinctEmbedUrls: urlOwners.size,
    duplicates,
    byReason: rows.reduce((a, r) => { a[r.reason] = (a[r.reason] || 0) + 1; return a; }, {}),
  };
}
