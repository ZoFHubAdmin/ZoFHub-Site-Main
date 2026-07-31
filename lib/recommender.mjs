// lib/recommender.mjs — the serving half of ZoFHub's recommender.
//
// Split of responsibilities:
//   tools/build-recommendations.py  → offline, heavy, once   → game-similarity.json
//   THIS FILE                       → online, light, per-req → ranked slugs
//
// The index is a plain { slug: [[neighbour, score], …] } lookup, so producing a
// personalised row is a handful of dictionary reads — no matrix maths in the
// request path.
//
// ── DESIGN RULE: THIS MODULE IS STATELESS ──────────────────────────────────
// It never stores anything per user. The caller passes in the history it got
// from the client, and gets back a ranking. That is a deliberate constraint,
// not laziness:
//   • server.js already holds four things in process memory (SCORE_SESSIONS,
//     the rate-limit buckets, presence, play counts) that each break when a
//     second instance appears. Adding a fifth would deepen a known problem.
//   • A user's play history already lives in their browser (store.history), so
//     copying it server-side would mean holding personal data we do not need.
//   • Stateless means any instance can answer any request — this scales
//     horizontally for free, today.
//
// ── WHY NOT COLLABORATIVE FILTERING ────────────────────────────────────────
// "People who played X also played Y" needs co-play data. At the time of
// writing 71 games out of ~12.7k had any play count at all (0.6%), and the
// server keeps no per-user play SEQUENCES to derive co-play from. Building it
// on that would produce confident nonsense. Content similarity works for every
// game from day one, including a game added an hour ago with zero plays.
// Live play counts are still used here — as a POPULARITY PRIOR for tie-breaks
// and exploration (see POP_PRIOR), which is what the data can honestly support.

import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Tunables ───────────────────────────────────────────────────────────────
// How fast older plays stop mattering. 0.85^i: the most recent game counts 1.0,
// the 5th-most-recent 0.52, the 10th 0.20, the 20th 0.04.
//
// The row this replaces used Math.max(1, 12 - i), which is FLAT after the 12th
// entry — and history holds 80. So 68 stale plays could collectively outvote
// the 12 that actually reflect what you are into right now. Exponential decay
// has no such cliff.
const RECENCY_DECAY = 0.85;

// A favourite is an explicit "I like this", which is stronger evidence than one
// play (a play can just be a misclick), so it seeds the profile a bit harder.
const FAVORITE_WEIGHT = 1.25;

// MMR (Maximal Marginal Relevance) — the standard fix for a recommendation list
// that is technically correct and useless: 12 near-identical racing games.
// final = LAMBDA·relevance − (1−LAMBDA)·(similarity to what we already picked).
// Lower LAMBDA = more variety. 0.72 keeps relevance in charge while still
// forcing genre movement.
const MMR_LAMBDA = 0.72;

// Exploration. Every Nth slot ignores the taste profile and offers something
// from outside it.
//
// This is not a nice-to-have. The main feed ranks by
// POP_WEIGHT(3.0)·popNorm + random(0..1), and popNorm passes 0.34 at roughly
// ten plays — past which a game outranks EVERY zero-play game no matter what
// the random term does. Combined with a recommender that only ever shows you
// more of what you already clicked, the same few hundred games would circulate
// forever and the other ~12,000 would be unreachable. One in six is enough to
// keep the long tail alive without making the row feel random.
const EXPLORE_EVERY = 6;

// Weight of the live play count when ordering exploration picks and breaking
// ties. Deliberately small: popularity should decide between two equally
// relevant games, never override relevance.
const POP_PRIOR = 0.25;

// Cap on how much of one category a row may be, as a fraction. Stops a
// "for you" row turning into a single-genre wall even when MMR would allow it.
const MAX_CATEGORY_SHARE = 0.4;

let SIM = new Map();          // slug -> [[neighbourSlug, score], …]
let loaded = false;

/**
 * Load data/game-similarity.json. Safe to call more than once.
 * Missing file is NOT an error — recommend() degrades to category affinity,
 * which is what the site did before this module existed.
 */
export function loadSimilarityIndex(dataDir = join(__dirname, '..', 'data')) {
  if (loaded) return SIM;
  loaded = true;
  try {
    const f = join(dataDir, 'game-similarity.json');
    if (!existsSync(f)) {
      console.log('[recommender] no data/game-similarity.json — using category '
        + 'affinity only. Build it with: npm run rec-index');
      return SIM;
    }
    const raw = JSON.parse(readFileSync(f, 'utf8'));
    SIM = new Map(Object.entries(raw));
    console.log(`[recommender] similarity index loaded: ${SIM.size} games`);
  } catch (e) {
    console.warn('[recommender] similarity index load failed:', e.message);
  }
  return SIM;
}

export const indexSize = () => SIM.size;

/** Neighbours of a slug, or [] — never throws, never returns undefined. */
export function neighbours(slug) {
  return SIM.get(String(slug || '').toLowerCase()) || [];
}

/**
 * Similarity between two games in [0,1].
 * Uses the index when it knows the pair; otherwise falls back to a category
 * match, which is a coarse but honest proxy. Only ever used by the diversity
 * penalty, where being approximately right is enough.
 */
function pairSim(aSlug, a, b) {
  const list = SIM.get(aSlug);
  if (list) {
    for (const [nb, s] of list) if (nb === b.slug) return s;
  }
  if (a && a.category && a.category === b.category) return 0.5;
  return 0;
}

/**
 * Build a weighted taste profile from this device's history + favourites.
 * Returns Map<slug, weight> of the SEED games, most-influential first.
 */
function tasteProfile(history, favorites) {
  const seeds = new Map();
  // history: newest first, as store.history keeps it.
  history.forEach((slug, i) => {
    const w = Math.pow(RECENCY_DECAY, i);
    if (w < 0.01) return;                       // below this it cannot affect order
    seeds.set(slug, (seeds.get(slug) || 0) + w);
  });
  for (const slug of favorites) {
    seeds.set(slug, (seeds.get(slug) || 0) + FAVORITE_WEIGHT);
  }
  return seeds;
}

/**
 * The main entry point.
 *
 * @param {object}   o
 * @param {string[]} o.history    slugs, MOST RECENT FIRST
 * @param {string[]} o.favorites  slugs
 * @param {Function} o.getGame    slug -> game object (or undefined if unknown/hidden)
 * @param {Function} o.pool       () -> array of all candidate games (already filtered)
 * @param {number}   o.limit      how many to return
 * @param {Function} [o.playsOf]  slug -> play count, for the popularity prior
 * @returns {{slug,title,...,because}[]} games, each tagged with WHY it was picked
 */
export function recommend({ history = [], favorites = [], getGame, pool, limit = 18, playsOf }) {
  const hist = [...new Set(history.map(s => String(s || '').toLowerCase()).filter(Boolean))];
  const favs = [...new Set(favorites.map(s => String(s || '').toLowerCase()).filter(Boolean))];
  const seeds = tasteProfile(hist, favs);
  const played = new Set([...hist, ...favs]);

  // ── 1. Gather candidates from the neighbours of every seed ───────────────
  // score  = Σ over seeds (seedWeight × similarity)
  // because = the single seed that contributed most, so the UI can say
  //           "Because you played X" truthfully rather than guessing.
  const scores = new Map();   // slug -> score
  const because = new Map();  // slug -> { slug, weight } of the best seed
  for (const [seedSlug, seedW] of seeds) {
    for (const [nb, sim] of neighbours(seedSlug)) {
      if (played.has(nb)) continue;             // never recommend what they just played
      const contrib = seedW * sim;
      scores.set(nb, (scores.get(nb) || 0) + contrib);
      const cur = because.get(nb);
      if (!cur || contrib > cur.weight) because.set(nb, { slug: seedSlug, weight: contrib });
    }
  }

  // ── 2. Fall back to category affinity when the index cannot help ─────────
  // Covers two real cases: the index file is absent, and the ~15% of games the
  // builder found no confident neighbours for. Without this those users get an
  // empty row, which looks like a broken feature rather than a cold start.
  if (scores.size < limit) {
    const affinity = new Map();
    for (const [seedSlug, w] of seeds) {
      const g = getGame(seedSlug);
      if (g && g.category) affinity.set(g.category, (affinity.get(g.category) || 0) + w);
    }
    if (affinity.size) {
      const maxAff = Math.max(...affinity.values());
      for (const g of pool()) {
        if (!g || played.has(g.slug) || scores.has(g.slug)) continue;
        const a = affinity.get(g.category);
        if (!a) continue;
        // Scaled below any real similarity hit, so index-backed picks always win.
        scores.set(g.slug, (a / maxAff) * 0.25);
        if (!because.has(g.slug)) because.set(g.slug, { slug: null, weight: 0, category: g.category });
      }
    }
  }

  // ── 3. Popularity prior — decides between equally relevant games only ─────
  const pop = (slug) => {
    if (!playsOf) return 0;
    const p = playsOf(slug) || 0;
    return Math.min(1, Math.log10(1 + p) / 3);   // same curve the main feed uses
  };
  const ranked = [...scores.entries()]
    .map(([slug, s]) => ({ slug, score: s + POP_PRIOR * pop(slug) }))
    .sort((a, b) => b.score - a.score)
    // Bound the MMR pass: it is O(picked × candidates), and beyond a few hundred
    // candidates the tail cannot reach the output anyway.
    .slice(0, Math.max(limit * 12, 150));

  // ── 4. Greedy MMR + category quota + exploration ─────────────────────────
  const out = [];
  const usedCat = new Map();
  const maxPerCat = Math.max(2, Math.ceil(limit * MAX_CATEGORY_SHARE));
  const takenSlugs = new Set();
  const takenTitles = new Set();  // the catalog has real duplicate titles
  const deferred = [];            // relevant picks held back by the category quota

  // enforceQuota=false is used by the top-up pass below. The category cap is a
  // PREFERENCE, not a hard limit: a half-empty row is a worse outcome than a
  // slightly single-genre one, and someone who only plays racing games should
  // get racing games.
  const pushGame = (slug, why, enforceQuota = true) => {
    const g = getGame(slug);
    if (!g || takenSlugs.has(slug)) return false;
    const tkey = String(g.title || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    if (tkey && takenTitles.has(tkey)) return false;
    const cat = g.category || 'other';
    if (enforceQuota && (usedCat.get(cat) || 0) >= maxPerCat) return false;
    usedCat.set(cat, (usedCat.get(cat) || 0) + 1);
    takenSlugs.add(slug);
    if (tkey) takenTitles.add(tkey);
    out.push({ ...g, because: why });
    return true;
  };

  // Exploration pool: decent games the user has NOT played, ordered by
  // popularity. Kept lazy — never built when exploration cannot fire.
  let explorePool = null;
  const nextExplore = () => {
    if (!explorePool) {
      explorePool = pool()
        .filter(g => g && g.slug && !played.has(g.slug) && !scores.has(g.slug) && g.thumbnail)
        .sort((a, b) => pop(b.slug) - pop(a.slug))
        .slice(0, 400);
      // Fisher-Yates. NOT `sort(() => Math.random() - 0.5)` — that is the
      // classic broken shuffle (it is what the row this replaces used): the
      // comparator is inconsistent, so the result is neither a uniform
      // permutation nor even stable across engines. It matters here because
      // the pool arrives sorted by popularity, and at cold start every play
      // count is 0, so the sort is a no-op and the pool stays in catalog order
      // — which produced three "Police Car …" games in the first three slots.
      for (let i = explorePool.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [explorePool[i], explorePool[j]] = [explorePool[j], explorePool[i]];
      }
    }
    return explorePool.shift();
  };

  let ri = 0;
  while (out.length < limit && (ri < ranked.length || explorePool === null || explorePool.length)) {
    const slot = out.length;
    // Exploration slot — but never the first, so the row opens with its
    // strongest, most obviously-relevant pick.
    if (slot > 0 && slot % EXPLORE_EVERY === 0) {
      let picked = false;
      for (let tries = 0; tries < 25 && !picked; tries++) {
        const g = nextExplore();
        if (!g) break;
        picked = pushGame(g.slug, { kind: 'discover' });
      }
      if (picked) continue;
    }

    // Relevance slot — re-rank the remaining candidates by MMR against what is
    // already in the row, then take the best.
    let bestIdx = -1, bestVal = -Infinity;
    for (let i = ri; i < ranked.length; i++) {
      const c = ranked[i];
      if (takenSlugs.has(c.slug)) continue;
      const g = getGame(c.slug);
      if (!g) continue;
      let maxSim = 0;
      for (const chosen of out) {
        const s = pairSim(c.slug, g, chosen);
        if (s > maxSim) maxSim = s;
      }
      const val = MMR_LAMBDA * c.score - (1 - MMR_LAMBDA) * maxSim;
      if (val > bestVal) { bestVal = val; bestIdx = i; }
    }
    if (bestIdx === -1) break;

    const chosen = ranked[bestIdx];
    const why = because.get(chosen.slug);
    const seedGame = why && why.slug ? getGame(why.slug) : null;
    const label = seedGame
      ? { kind: 'similar', slug: seedGame.slug, title: seedGame.title }
      : { kind: 'category', category: why && why.category };
    if (!pushGame(chosen.slug, label)) {
      // Rejected by the category quota. DEFER it, do not discard it — an
      // earlier version spliced it away here, and the effect was that a user
      // whose taste is entirely one genre (all racing) lost every candidate
      // past the 5th and had the row padded out with 7 unrelated "discover"
      // picks. Relevant-but-over-quota beats irrelevant, so these come back in
      // the top-up pass below.
      deferred.push({ slug: chosen.slug, label });
      ranked.splice(bestIdx, 1);
      continue;
    }
    ranked.splice(bestIdx, 1);
  }

  // ── 5. Top-up ────────────────────────────────────────────────────────────
  // Two ways to end up short, both of which produced a visibly broken row in
  // testing before this pass existed:
  //
  //   a) COLD START — no history at all, so there are no seeds, no candidates,
  //      and the loop above exits immediately. A new visitor got an EMPTY row.
  //      They should get popular games.
  //   b) SINGLE-GENRE TASTE — someone whose whole history is racing generates
  //      only racing candidates, so the category quota rejected everything past
  //      the 5th and the row stopped at 5 of 12.
  //
  // Both are fixed the same way: keep filling, with the quota lifted.
  // Deferred first: these are genuinely relevant, they just lost a quota slot.
  // The explore cadence is honoured HERE too. Without it a single-genre user
  // ends the top-up with 12 of 12 from one category and zero discovery — the
  // filter bubble this module is partly meant to prevent. Relevance still wins
  // the majority of slots; discovery just keeps its fixed share.
  for (const d of deferred) {
    if (out.length >= limit) break;
    if (out.length > 0 && out.length % EXPLORE_EVERY === 0) {
      const g = nextExplore();
      if (g) pushGame(g.slug, { kind: 'discover' }, false);
      if (out.length >= limit) break;
    }
    pushGame(d.slug, d.label, false);
  }
  if (out.length < limit) {
    for (const c of ranked) {
      if (out.length >= limit) break;
      const why = because.get(c.slug);
      const seedGame = why && why.slug ? getGame(why.slug) : null;
      pushGame(c.slug, seedGame
        ? { kind: 'similar', slug: seedGame.slug, title: seedGame.title }
        : { kind: 'category', category: why && why.category }, false);
    }
  }
  while (out.length < limit) {
    const g = nextExplore();
    if (!g) break;
    pushGame(g.slug, { kind: 'discover' }, false);
  }

  return out;
}

export default { loadSimilarityIndex, recommend, neighbours, indexSize };
