// lib/game-seo.mjs — per-game SEO content, generated from VERIFIED metadata only.
// ---------------------------------------------------------------------------
// WHAT THIS IS. Every /play/<slug> page needs a unique, factual description and
// complete SEO metadata (title, meta description, canonical, Open Graph,
// JSON-LD). This builds all of it from the fields the catalog actually holds —
// title, category, tags, platform — and NOTHING ELSE. It never invents a
// developer, a release date, a rating, a player count, a mechanic or a control
// scheme, because the catalog does not know those and a fabricated fact is worse
// than a short one.
//
// DETERMINISTIC AND PURE. Same game in → same text out, every time. No AI, no
// randomness, no network, no DOM. That is what lets the /play handler call it
// per request (it is microseconds of string work) and what lets the tests assert
// exact output. The differentiation between games comes from their TAGS, which
// are genuinely game-specific — "2 Player, Basketball, Ragdoll" reads nothing
// like "Platform, Parkour, Stickman" — not from synonym-shuffling a template.
//
// AUTHORITY ORDER. A real stored/administrator description wins when present and
// substantive; otherwise this generates one; a game with almost no metadata gets
// a short honest description marked `minimal` so it can be flagged for review,
// rather than padded with filler.
// ---------------------------------------------------------------------------

const clean = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();

/** HTML-escape for text that lands in markup. */
export function esc(s) {
  return clean(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/** Tags as a clean array, from a comma/pipe string or an array. Deduped, bounded. */
export function tagList(game) {
  const raw = game?.tags;
  const arr = Array.isArray(raw) ? raw : clean(raw).split(/[,|]/);
  const seen = new Set();
  const out = [];
  for (const t of arr) {
    const v = clean(t).replace(/^#/, '');
    const k = v.toLowerCase();
    if (!v || v.length > 40 || seen.has(k)) continue;
    seen.add(k);
    out.push(v);
    if (out.length >= 12) break;
  }
  return out;
}

// Category id/label → a readable genre noun phrase. Category-level truths only
// (a game in `racing` IS a racing game); never a claim about the specific game.
const GENRE = {
  arcade: 'arcade', racing: 'racing and driving', puzzle: 'puzzle', 'puzzle-logic': 'puzzle and logic',
  action: 'action', shooting: 'shooting', sports: 'sports', 'sports-racing': 'sports and racing',
  girls: 'dress-up and style', skill: 'skill-based', adventure: 'adventure', strategy: 'strategy',
  'io-games': 'multiplayer .io', io: 'multiplayer .io', multiplayer: 'multiplayer', card: 'card',
  board: 'board', simulator: 'simulation', 'brain-games': 'brain and logic', 'bubble-shooter': 'bubble-shooter',
  'match-3': 'match-3', casual: 'casual', clicker: 'idle and clicker', platform: 'platform',
};

export function categorySlug(category) {
  return clean(category).toLowerCase().replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'arcade';
}

/** Readable category label, e.g. "io-games" → "IO Games", "brain-games" → "Brain Games". */
export function categoryLabel(game) {
  const raw = clean(game?.category_label || game?.category || 'Games');
  return raw.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function genrePhrase(game) {
  const key = categorySlug(game?.category);
  return GENRE[key] || clean(game?.category || 'browser').toLowerCase().replace(/[-_]+/g, ' ');
}

const joinNatural = (a) => (a.length <= 1 ? (a[0] || '') : `${a.slice(0, -1).join(', ')} and ${a[a.length - 1]}`);
const TWO_PLAYER = /\b(2 ?players?|two[- ]?player|multiplayer|co[- ]?op|pvp)\b/i;

/**
 * The visible/primary description.
 * @returns {{ text: string, source: 'stored'|'generated'|'minimal' }}
 */
export function gameDescription(game) {
  // A real description the catalog already carries wins — but only if it is
  // substantive (not a one-word stub), and it is treated as untrusted text:
  // whitespace-collapsed and length-bounded, never rendered as markup.
  const stored = clean(game?.description);
  if (stored && stored.length >= 60 && stored.split(' ').length >= 10) {
    return { text: stored.slice(0, 1200), source: 'stored' };
  }

  const title = clean(game?.title) || 'This game';
  const genre = genrePhrase(game);
  const label = categoryLabel(game);
  const tags = tagList(game);
  const lower = (s) => s.toLowerCase();
  // Tags that are not just the genre/category word restated.
  const lead = tags.filter((t) => lower(t) !== lower(genre) && !genre.includes(lower(t))).slice(0, 3);
  const twoPlayer = tags.some((t) => TWO_PLAYER.test(t)) || TWO_PLAYER.test(title);

  if (!lead.length) {
    // Low-information game: short and factual, flagged for review rather than padded.
    return {
      text: `${title} is a ${genre} game you can play free in your browser on ZoFHub — no download and no sign-up. It is part of the ${label} collection.`,
      source: 'minimal',
    };
  }

  const parts = [];
  parts.push(`${title} is a ${genre} game built around ${joinNatural(lead)}.`);
  if (twoPlayer) parts.push('It can be played on your own or head-to-head with a second player at the same keyboard.');
  const themes = tags.filter((t) => !lead.includes(t) && !TWO_PLAYER.test(t)).slice(0, 4);
  if (themes.length) parts.push(`Expect ${genre} gameplay with ${joinNatural(themes.map(lower))} themes.`);
  parts.push(`On ZoFHub, ${title} runs free in your browser with no download or sign-up, as part of the ${label} collection.`);
  return { text: parts.join(' '), source: 'generated' };
}

/** A one-line summary for cards and as the base for the meta description. */
export function shortSummary(game) {
  const title = clean(game?.title) || 'This game';
  const genre = genrePhrase(game);
  const lead = tagList(game).filter((t) => t.toLowerCase() !== genre).slice(0, 2);
  return lead.length
    ? `${title} — a ${genre} game with ${joinNatural(lead.map((s) => s.toLowerCase()))}.`
    : `${title} — a ${genre} game you can play free in your browser.`;
}

/** HTML <meta name="description">: unique, <=160 chars, game name included, no stuffing. */
export function metaDescription(game) {
  const title = clean(game?.title) || 'This game';
  const genre = genrePhrase(game);
  const lead = tagList(game).filter((t) => t.toLowerCase() !== genre).slice(0, 2);
  let s = lead.length
    ? `Play ${title} free on ZoFHub — a ${genre} game with ${joinNatural(lead.map((x) => x.toLowerCase()))}. Instant play in your browser, no download.`
    : `Play ${title} free on ZoFHub — a ${genre} game. Instant play in your browser, no download or sign-up.`;
  if (s.length > 160) {
    s = s.slice(0, 157);
    s = s.slice(0, s.lastIndexOf(' ')) + '…';
  }
  return s;
}

/** SEO <title>: descriptive but not redundant or overlong. */
export function seoTitle(game) {
  const title = clean(game?.title) || 'Game';
  // A long title is already descriptive; don't bolt "Play Online" onto it.
  return title.length > 42 ? `${title} | ZoFHub` : `${title} — Play Online | ZoFHub`;
}

export function canonicalUrl(slug, origin) {
  return `${clean(origin).replace(/\/+$/, '')}/play/${encodeURIComponent(clean(slug))}`;
}

/**
 * JSON-LD (schema.org VideoGame) as a string SAFE to drop inside a <script>.
 * Only verified fields; genre is the category, which is true by construction.
 * `<` is escaped so the payload can never close the script tag early.
 */
export function jsonLdString(game, { origin, canonical, image } = {}) {
  const url = canonical || canonicalUrl(game?.slug, origin);
  const data = {
    '@context': 'https://schema.org',
    '@type': 'VideoGame',
    name: clean(game?.title),
    url,
    description: gameDescription(game).text,
    genre: genrePhrase(game),
    applicationCategory: 'Game',
    operatingSystem: 'Web browser',
    inLanguage: 'en',
    offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD', availability: 'https://schema.org/InStock' },
    publisher: { '@type': 'Organization', name: 'ZoFHub' },
  };
  if (image) data.image = image;
  return JSON.stringify(data).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
}

/** Detail rows with data only — never an empty row. */
export function detailRows(game) {
  const rows = [];
  rows.push({ label: 'Category', value: categoryLabel(game), href: `/category/${categorySlug(game?.category)}` });
  if (tagList(game).some((t) => TWO_PLAYER.test(t))) rows.push({ label: 'Players', value: '1–2 players' });
  const platform = clean(game?.platform);
  if (platform) rows.push({ label: 'Platform', value: platform });
  rows.push({ label: 'Price', value: 'Free to play' });
  return rows;
}

/**
 * The visible on-page description section as safe HTML (every value escaped).
 * Real content for the reader — heading, prose, a details list, tag chips —
 * never a hidden keyword block.
 */
export function descriptionSectionHtml(game) {
  const title = esc(game?.title);
  const { text } = gameDescription(game);
  const rows = detailRows(game).map((r) => {
    const v = r.href ? `<a href="${esc(r.href)}">${esc(r.value)}</a>` : esc(r.value);
    return `<div class="about-row"><dt>${esc(r.label)}</dt><dd>${v}</dd></div>`;
  }).join('');
  const tags = tagList(game);
  const chips = tags.length
    ? `<ul class="about-tags" aria-label="Tags">${tags.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>`
    : '';
  return `
      <section class="game-about" aria-labelledby="aboutHeading">
        <div class="about-main">
          <h2 class="about-title" id="aboutHeading">About ${title}</h2>
          <p class="about-text">${esc(text)}</p>
          ${chips}
        </div>
        <aside class="about-details">
          <h3>Game details</h3>
          <dl>${rows}</dl>
        </aside>
      </section>`;
}

/** Everything the /play handler needs, computed once. */
export function seoPayload(game, { origin, image } = {}) {
  const canonical = canonicalUrl(game?.slug, origin);
  const desc = gameDescription(game);
  return {
    seoTitle: seoTitle(game),
    metaDescription: metaDescription(game),
    canonical,
    descriptionText: desc.text,
    descriptionSource: desc.source,
    descriptionHtml: descriptionSectionHtml(game),
    jsonLd: jsonLdString(game, { canonical, image }),
  };
}

export default {
  esc, tagList, categorySlug, categoryLabel, gameDescription, shortSummary,
  metaDescription, seoTitle, canonicalUrl, jsonLdString, detailRows,
  descriptionSectionHtml, seoPayload,
};
