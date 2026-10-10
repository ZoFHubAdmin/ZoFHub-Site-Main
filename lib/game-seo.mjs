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

// ── Honest, GENRE-LEVEL play guidance ───────────────────────────────────────
// The catalog stores no per-game controls, and this NEVER invents them. Every
// line below is the CONVENTION for games of a kind ("most … like this"), which
// is true and orients a new player, not a fabricated key map for one title. A
// specific game may differ, and the copy says so out loud.
const PLAY = {
  racing: { controls: `the arrow keys or WASD — up to accelerate, down to brake or reverse, left and right to steer`, objective: `cross the finish line first, or beat the clock` },
  'sports-racing': { controls: `the arrow keys or WASD to drive — up to go, down to brake, left and right to steer`, objective: `finish ahead of your rivals` },
  puzzle: { controls: `the mouse — click or drag pieces into place (tap and swipe on a touchscreen)`, objective: `clear each level by solving the puzzle in front of you` },
  'puzzle-logic': { controls: `the mouse to click and drag, or the arrow keys on grid-based levels`, objective: `work out the solution and clear every stage` },
  'match-3': { controls: `the mouse — click or swap two pieces to line up three or more of a kind`, objective: `match pieces to clear the board and hit the target score` },
  'bubble-shooter': { controls: `the mouse to aim and click to fire a bubble`, objective: `match three or more of a colour to clear the board` },
  'brain-games': { controls: `the mouse to pick your answer, or the keyboard when numbers are needed`, objective: `think fast and solve each challenge` },
  action: { controls: `the arrow keys or WASD to move and the mouse or spacebar to act`, objective: `fight through each stage and stay alive` },
  shooting: { controls: `the mouse to aim and left-click to shoot, with WASD to move`, objective: `take down the targets and survive as long as you can` },
  sports: { controls: `one or two action keys — many physics-style sports games use a single button or tap to jump, kick or shoot`, objective: `outscore your opponent` },
  girls: { controls: `the mouse — click items to try them on and build your look (tap on a touchscreen)`, objective: `style your character and finish each look` },
  skill: { controls: `the mouse, or a single well-timed tap or key`, objective: `time your moves and get as far as you can` },
  adventure: { controls: `the arrow keys or WASD to explore, with the mouse or spacebar to interact`, objective: `explore each area and reach the goal` },
  strategy: { controls: `the mouse to select and give orders`, objective: `out-think your opponent and complete each objective` },
  'io-games': { controls: `the mouse to move and click for your main action`, objective: `grow bigger and outlast everyone else in the arena` },
  io: { controls: `the mouse to move and click for your main action`, objective: `grow bigger and outlast everyone else` },
  multiplayer: { controls: `the mouse to move and click to act`, objective: `outplay the other players in the match` },
  card: { controls: `the mouse — click or drag cards to play them`, objective: `play your cards well and win the round` },
  board: { controls: `the mouse to make each move`, objective: `beat your opponent on the board` },
  simulator: { controls: `the mouse and keyboard to build and manage`, objective: `grow and run your world the way you want` },
  clicker: { controls: `the mouse — click (or tap) over and over, then spend what you earn on upgrades`, objective: `grow your numbers and unlock every upgrade` },
  platform: { controls: `the arrow keys or A and D to move and the up arrow, W or the spacebar to jump`, objective: `reach the end of each level, grabbing what you can and dodging hazards` },
  casual: { controls: `the mouse, or a single key or tap`, objective: `keep a run going and beat your best` },
  arcade: { controls: `the arrow keys or WASD to move and the spacebar or mouse for the main action`, objective: `score as high as you can before your run ends` },
};
const PLAY_DEFAULT = { controls: `the arrow keys or WASD to move and the mouse for everything else`, objective: `complete the challenge the game sets you` };

// What makes a game of this kind fun — a genre truth, not a per-title claim.
const APPEAL = {
  racing: `fast restarts and the constant pull to shave a little more off your best time`,
  'sports-racing': `quick races and the push to edge out a rival on the final corner`,
  puzzle: `the small "aha" moments as each level clicks into place`,
  'puzzle-logic': `the satisfying click of a tricky level finally working out`,
  'match-3': `the chain reactions and the pull of just one more move`,
  'bubble-shooter': `lining up a shot that clears half the board at once`,
  'brain-games': `a quick mental workout and the push to beat your own best`,
  action: `fast reactions and the drive to survive one wave longer`,
  shooting: `sharp aim and the tension of staying alive under pressure`,
  sports: `the back-and-forth and the scrappy last-second winners`,
  girls: `mixing and matching until a look finally comes together`,
  skill: `that one-more-try pull after a near miss`,
  adventure: `the pull to see what is around the next corner`,
  strategy: `outwitting an opponent one careful move at a time`,
  'io-games': `growing bigger while everyone else is trying to catch you out`,
  io: `growing bigger while everyone else is trying to catch you out`,
  clicker: `watching a small number snowball into a huge one`,
  platform: `tight jumps and the one-more-try pull after a near miss`,
};
const APPEAL_DEFAULT = `it is easy to pick up, quick to restart, and hard to put down once a run is going`;

const appealFor = (game) => APPEAL[categorySlug(game?.category)] || APPEAL_DEFAULT;

// When the category is a GENERIC bucket, the tags often reveal the real genre —
// a "skill" game tagged Platform/Parkour plays nothing like a "skill" game
// tagged Puzzle. These map a tag signal to a better PLAY key; a specific
// category (racing, puzzle, sports…) already wins and is never overridden.
const TAG_GENRE = [
  [/plat|parkour|runner|jump|stickman/i, 'platform'],
  [/\brac|driv|drift|\bcar\b|\bbike\b|moto|wheel/i, 'racing'],
  [/shoot|sniper|\bgun\b|\bfps\b|zombie/i, 'shooting'],
  [/clicker|\bidle\b/i, 'clicker'],
  [/bubble/i, 'bubble-shooter'],
  [/match.?3/i, 'match-3'],
  [/\bio\b|\.io/i, 'io-games'],
  [/\bcard\b|solitaire|poker/i, 'card'],
  [/dress|makeup|fashion|\bstyle\b|salon/i, 'girls'],
  [/puzzle|logic|sudoku/i, 'puzzle'],
  [/tower|defen[cs]e|strateg/i, 'strategy'],
];
const GENERIC_CATEGORIES = new Set(['arcade', 'skill', 'casual', 'action', 'adventure', 'other', '']);

function playKey(game) {
  const cat = categorySlug(game?.category);
  if (!GENERIC_CATEGORIES.has(cat) && PLAY[cat]) return cat;   // a specific genre wins
  const tags = tagList(game).join(' ');
  for (const [re, key] of TAG_GENRE) if (re.test(tags)) return key;
  return PLAY[cat] ? cat : 'arcade';
}

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
 * Genre-level "how to play": the controls and goal a new player can expect from
 * a game OF THIS KIND, plus the shared-keyboard note two-player games almost
 * always use. Honest by construction — it describes the convention, not a key
 * map this server does not have, and the rendered copy hedges in plain words.
 * @returns {{ controls: string, objective: string, twoPlayer: boolean }}
 */
export function howToPlay(game) {
  const base = PLAY[playKey(game)] || PLAY_DEFAULT;
  const twoPlayer = tagList(game).some((t) => TWO_PLAYER.test(t)) || TWO_PLAYER.test(clean(game?.title));
  return { controls: base.controls, objective: base.objective, twoPlayer };
}

/** The visible, styled "How to play" block as safe HTML (every value escaped). */
export function howToPlayHtml(game) {
  const title = esc(game?.title);
  const genre = esc(genrePhrase(game));
  const { controls, objective, twoPlayer } = howToPlay(game);
  const twoLine = twoPlayer
    ? `<li><strong>Two players:</strong> games like this usually share one keyboard — one player on <kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd>, the other on the <kbd>arrow keys</kbd>; the game's own screen shows which side is which.</li>`
    : '';
  return `
      <section class="game-howto" aria-labelledby="howtoHeading">
        <h2 class="howto-title" id="howtoHeading">How to play ${title}</h2>
        <p class="howto-lead">New to it? Controls vary from game to game, but ${genre} games like this one usually work like this:</p>
        <ul class="howto-list">
          <li><strong>Controls:</strong> ${esc(controls)}.</li>
          <li><strong>Goal:</strong> ${esc(objective)}.</li>
          ${twoLine}
          <li><strong>Start playing:</strong> click inside the game window to focus it, then dive in — nothing to install, nothing to sign up for.</li>
        </ul>
      </section>`;
}

/**
 * The visible on-page content as safe HTML (every value escaped): an "About"
 * block (prose + why-it's-fun + tag chips + a details list) followed by a
 * genre-grounded "How to play" block. Real content for the reader — never a
 * hidden keyword dump.
 */
export function descriptionSectionHtml(game) {
  const title = esc(game?.title);
  const { text } = gameDescription(game);
  const appeal = esc(appealFor(game));
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
          <p class="about-text about-appeal">Part of the appeal is ${appeal}.</p>
          ${chips}
        </div>
        <aside class="about-details">
          <h3>Game details</h3>
          <dl>${rows}</dl>
        </aside>
      </section>${howToPlayHtml(game)}`;
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
    descriptionHtml: descriptionSectionHtml(game),   // About + How-to-play, one block
    howToPlay: howToPlay(game),                       // structured, for any other consumer
    jsonLd: jsonLdString(game, { canonical, image }),
  };
}

export default {
  esc, tagList, categorySlug, categoryLabel, gameDescription, shortSummary,
  metaDescription, seoTitle, canonicalUrl, jsonLdString, detailRows,
  howToPlay, howToPlayHtml, descriptionSectionHtml, seoPayload,
};
