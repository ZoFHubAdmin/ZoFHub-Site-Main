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

// How hard an explicit skip pushes a game away.
//
// A skip is WEAKER evidence than a play, and asymmetric with it: opening a game
// means "I wanted this", but scrolling past one means anything from "not today"
// to "the thumbnail was ugly" to "I already own it elsewhere". Treating it as an
// equal-and-opposite play would let a few idle scrolls erase a genuine taste.
//
// So a skipped game is suppressed outright (they said no to THAT game), but its
// NEIGHBOURS are only nudged — enough that skipping five racing games in a row
// moves the feed, not enough that skipping one does.
const SKIP_NEIGHBOUR_PENALTY = 0.22;

// The axes in data/game-attributes.json. Mirrors lib/vibe-intent.mjs AXES;
// duplicated as a plain constant rather than imported so that recommender.mjs
// keeps working with no attribute artifact and no vibe module present.
const ATTR_AXES = ['calm', 'pace', 'brainy', 'challenge', 'social', 'cozy'];

// When the category quota blocks a fill, RELAX it rather than removing it.
//
// The top-up used to lift the cap entirely, which is how a racing-only profile
// ended up 16/18 racing: the main loop correctly capped racing at 8, then the
// top-up put the other 8 back. Going straight from "40% cap" to "no cap" threw
// away the whole diversity guarantee at the first sign of pressure — in a
// catalog of 16,823 games, which can obviously supply something else.
//
// Staged: try the normal cap, then a loose one, and only then unlimited. The
// unlimited stage still exists because a SHORT row is genuinely worse than a
// single-genre one — it just is not reached until 65% has been tried.
const RELAXED_CATEGORY_SHARE = 0.65;

// Weight of a vibe request carried over into the feed.
//
// Deliberately small. The feed is the ambient, always-on surface; a mood someone
// typed once is a passing state, not a preference. If this were large, a single
// "something relaxing" search would turn the whole homepage into puzzle games
// for the rest of the session — which is exactly the over-fitting the exploration
// slots exist to prevent. 0.35 shifts the ordering perceptibly and cannot own it.
const VIBE_WEIGHT = 0.35;

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
 * @param {string[]} [o.skips]    slugs the visitor scrolled past without opening
 * @param {object}   [o.vibe]     { targets } from lib/vibe-intent.mjs — the last
 *                                mood they searched, as a soft preference
 * @param {Function} [o.attrsOf]  slug -> attribute record, required for `vibe`
 * @returns {{slug,title,...,because}[]} games, each tagged with WHY it was picked
 *
 * Every added parameter is optional and defaults to the previous behaviour, so
 * existing callers keep working unchanged.
 */
export function recommend({
  history = [], favorites = [], getGame, pool, limit = 18, playsOf,
  skips = [], vibe = null, attrsOf = null,
}) {
  const hist = [...new Set(history.map(s => String(s || '').toLowerCase()).filter(Boolean))];
  const favs = [...new Set(favorites.map(s => String(s || '').toLowerCase()).filter(Boolean))];
  const skipped = new Set(skips.map(s => String(s || '').toLowerCase()).filter(Boolean));
  const seeds = tasteProfile(hist, favs);
  // Skipped games are never shown again in this row, exactly like played ones.
  const played = new Set([...hist, ...favs, ...skipped]);

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

  // ── 2b. Negative signal — what they scrolled past ────────────────────────
  // Applied to the NEIGHBOURS of skipped games, because the skipped games
  // themselves are already excluded. This is what makes "stop showing me this
  // kind of thing" actually work: five skipped racing games collectively pull
  // every racing candidate down, without a single skip doing much on its own.
  if (skipped.size) {
    for (const s of skipped) {
      for (const [nb, sim] of neighbours(s)) {
        if (!scores.has(nb)) continue;
        scores.set(nb, scores.get(nb) - SKIP_NEIGHBOUR_PENALTY * sim);
      }
    }
  }

  // ── 2c. Vibe carry-over — the mood they last asked for ───────────────────
  // The Vibe Finder and the feed are separate systems that share a vocabulary.
  // This is the only coupling between them, it is one-directional, and it is
  // skipped entirely when either the attributes or the vibe are absent — so
  // both systems still work standalone, which was a requirement.
  const vibeTargets = vibe && vibe.targets ? vibe.targets : null;
  const vibeFit = (slug) => {
    if (!vibeTargets || !attrsOf) return 0;
    const a = attrsOf(slug);
    if (!a || (a.confidence ?? 0) < 0.2) return 0;
    let num = 0, den = 0;
    for (const [axis, t] of Object.entries(vibeTargets)) {
      const v = a[axis];
      if (typeof v !== 'number') continue;
      num += t.weight * (1 - Math.abs(v - t.value));
      den += t.weight;
    }
    return den > 0 ? num / den : 0;
  };

  // ── 3. Popularity prior — decides between equally relevant games only ─────
  const pop = (slug) => {
    if (!playsOf) return 0;
    const p = playsOf(slug) || 0;
    return Math.min(1, Math.log10(1 + p) / 3);   // same curve the main feed uses
  };
  const ranked = [...scores.entries()]
    .map(([slug, s]) => ({
      slug,
      score: s + POP_PRIOR * pop(slug) + VIBE_WEIGHT * vibeFit(slug),
    }))
    .sort((a, b) => b.score - a.score)
    // Bound the MMR pass: it is O(picked × candidates), and beyond a few hundred
    // candidates the tail cannot reach the output anyway.
    .slice(0, Math.max(limit * 12, 150));

  // ── 4. Greedy MMR + category quota + exploration ─────────────────────────
  const out = [];
  const usedCat = new Map();
  const takenSlugs = new Set();
  const takenTitles = new Set();  // the catalog has real duplicate titles
  const deferred = [];            // relevant picks held back by the category quota

  // ── The per-category cap scales with how many tastes the visitor has ─────
  //
  // A flat 40% cap looks fine until someone has several tastes. Measured on a
  // profile with racing + puzzle + shooting + sports history and dress-up
  // favourites: the row came back 8 racing, 8 girls, 2 arcade. Puzzle, shooting
  // and sports — three of their five demonstrated interests — appeared ZERO
  // times, because the two highest-scoring categories are each allowed 8 of 18
  // and together that is the whole row.
  //
  // The cap has to be a share of the row DIVIDED BY the number of tastes being
  // represented, not a fixed fraction. Five tastes means roughly four slots
  // each; one taste means six, with adjacent picks covering the rest.
  //
  // Floor of 2 — i.e. one taste may own up to HALF the row, never more.
  //
  // A floor of 3 was tried first and it over-corrected: a racing-only visitor
  // dropped to 4 of 12 racing games, and test/recommender.test.mjs correctly
  // failed it with "a racing fan should get mostly racing". Both bounds are
  // real requirements pulling opposite ways — recognise the preference, but do
  // not build a bubble — and half the row is the line that satisfies both.
  //
  // Ceiling of 6 so a very broad profile does not fragment into two-game
  // slivers of everything.
  //
  // Declared here rather than beside the adjacency code that also uses it: the
  // cap below needs it, and a `const` referenced before its declaration is a
  // temporal-dead-zone crash at request time, not a compile error.
  const seedCategories = new Set();
  for (const slug of seeds.keys()) {
    const g = getGame(slug);
    if (g && g.category) seedCategories.add(g.category);
  }
  const tasteBreadth = Math.max(2, Math.min(6, seedCategories.size || 3));
  const baseCap = Math.max(2, Math.ceil(limit / tasteBreadth));

  // `capShare` is the fraction of the row one category may occupy, or null for
  // no cap. The category limit is a PREFERENCE that relaxes under pressure
  // rather than a hard rule — but it relaxes in STAGES (see
  // RELAXED_CATEGORY_SHARE), because dropping it entirely at the first blocked
  // pick is what produced a 16-of-18 single-genre row.
  const pushGame = (slug, why, capShare = MAX_CATEGORY_SHARE) => {
    const g = getGame(slug);
    if (!g || takenSlugs.has(slug)) return false;
    const tkey = String(g.title || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    if (tkey && takenTitles.has(tkey)) return false;
    const cat = g.category || 'other';
    if (capShare !== null) {
      // The normal cap is breadth-derived; the relaxed stage is a flat share.
      // Whichever is LARGER wins, so relaxation always genuinely relaxes.
      const cap = capShare === MAX_CATEGORY_SHARE
        ? baseCap
        : Math.max(baseCap, Math.ceil(limit * capShare));
      if ((usedCat.get(cat) || 0) >= cap) return false;
    }
    usedCat.set(cat, (usedCat.get(cat) || 0) + 1);
    takenSlugs.add(slug);
    if (tkey) takenTitles.add(tkey);
    out.push({ ...g, because: why });
    return true;
  };

  // ── Adjacent-category discovery ──────────────────────────────────────────
  // The bubble this fixes, measured by tools/eval-recommendations.py before it
  // existed: a profile of nothing but racing games produced a row that was 89%
  // racing (16 of 18). Every candidate the similarity index generates for a
  // racing-only history is itself racing, so relevance ranking alone can only
  // ever deepen the bubble.
  //
  // Random exploration breaks it but throws away the profile — a racing fan
  // gets a dress-up game, which is variety without relevance and reads as the
  // feed being broken.
  //
  // The attribute vectors give the third option, and it is exactly what the
  // brief describes: find games with a SIMILAR FEEL but a DIFFERENT CATEGORY.
  // A fast, competitive, high-challenge racing player gets fast, competitive,
  // high-challenge SPORTS and ACTION games. Still recognisably for them; not
  // more of the same thing.
  //
  // Needs attrsOf. Without it this returns nothing and the old random
  // exploration carries the slot, so the behaviour degrades rather than breaks.
  // NOT a centroid — the seed vectors themselves.
  //
  // Averaging them is the obvious implementation and it is wrong for exactly
  // the users who need this most. Someone who plays racing AND puzzles has a
  // mean vector of "medium pace, medium challenge, medium everything", which
  // describes nothing they have ever played. Every adjacent pick then converges
  // on that meaningless midpoint, and a genuinely broad profile gets the
  // NARROWEST row of anyone — measured at 0.19 attribute diversity against 0.30
  // for a cold-start visitor, which is backwards.
  //
  // Matching against the nearest seed instead treats a multi-taste profile as
  // the several tastes it actually is, so a racing-and-puzzle player gets both
  // fast adjacent games and slow ones.
  const tasteVectors = () => {
    if (!attrsOf || !seeds.size) return null;
    const vecs = [];
    // Highest-weight seeds first, capped: adjacency is O(candidates x vectors)
    // and the tail of a decayed profile cannot change the outcome.
    const ordered = [...seeds.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
    for (const [slug, w] of ordered) {
      const a = attrsOf(slug);
      if (!a || (a.confidence ?? 0) < 0.2) continue;
      const v = {};
      let ok = false;
      for (const axis of ATTR_AXES) {
        if (typeof a[axis] === 'number') { v[axis] = a[axis]; ok = true; }
      }
      if (ok) vecs.push({ v, w });
    }
    return vecs.length ? vecs : null;
  };

  let adjacentPool = null;
  const nextAdjacent = () => {
    if (adjacentPool === null) {
      const vectors = tasteVectors();
      if (!vectors) { adjacentPool = []; return undefined; }
      adjacentPool = pool()
        .filter(g => g && g.slug && !played.has(g.slug) && !scores.has(g.slug)
          && g.thumbnail && g.category && !seedCategories.has(g.category))
        .map(g => {
          const a = attrsOf(g.slug);
          if (!a || (a.confidence ?? 0) < 0.25) return null;
          // Fit to the NEAREST taste, not the average of all of them.
          let best = 0;
          for (const { v } of vectors) {
            let d = 0, n = 0;
            for (const axis of ATTR_AXES) {
              if (typeof a[axis] !== 'number' || typeof v[axis] !== 'number') continue;
              d += Math.abs(a[axis] - v[axis]); n += 1;
            }
            if (!n) continue;
            const fit = 1 - d / n;
            if (fit > best) best = fit;
          }
          if (best <= 0) return null;
          // A stated mood steers WHICH adjacent games get picked.
          //
          // Without this the vibe can only reorder candidates the similarity
          // index already produced — and for a single-taste profile those are
          // all one genre, so "something relaxing" from a racing player had
          // literally nothing calm to promote. Discovery is the one slot where
          // a mood can legitimately introduce games the profile alone would
          // never surface, so it is applied here and only here.
          //
          // Ordering only: a game must still clear the same relevance bar
          // below, so this can shift the choice among qualifying games and
          // cannot smuggle in something that does not fit the profile at all.
          return { slug: g.slug, fit: best, vibe: vibeFit(g.slug) };
        })
        .filter(x => x && x.fit >= 0.72)      // must genuinely feel similar
        .sort((a, b) => (b.fit + b.vibe) - (a.fit + a.vibe))
        .slice(0, 200);
      // Shuffle the qualifying set so the same adjacent games do not lead every
      // request — Fisher-Yates, for the reason spelled out below.
      for (let i = adjacentPool.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [adjacentPool[i], adjacentPool[j]] = [adjacentPool[j], adjacentPool[i]];
      }
    }
    return adjacentPool.shift();
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
      // Adjacent-category first: a same-feel/different-genre pick keeps the row
      // relevant while still leaving the bubble. Random discovery is the
      // fallback for when no adjacent game clears the similarity bar.
      for (let tries = 0; tries < 12 && !picked; tries++) {
        const a = nextAdjacent();
        if (!a) break;
        picked = pushGame(a.slug, { kind: 'adjacent' });
      }
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
  // ── Top-up, in strict priority order ────────────────────────────────────
  //
  // THE ORDER IS THE WHOLE POINT, and getting it wrong is what produced a
  // 16-of-18 single-genre row. The first version relaxed the category cap
  // before trying adjacent games — so it filled the racing profile with more
  // racing while 5,212 same-feel/different-genre games sat unused.
  //
  // Correct priority, most to least desirable:
  //   1. deferred picks that still fit under the normal cap
  //   2. ADJACENT — same feel, different genre. Relevant AND diverse, so it
  //      beats anything that sacrifices one for the other.
  //   3. random discovery
  //   4. only now, relax the category cap
  //   5. and only then, no cap at all — a short row is still the worst outcome
  //
  // Stage 4 exists because a niche taste genuinely can exhaust 1-3: if nothing
  // in the catalog feels adjacent, more of what they like beats padding.

  const fillFrom = (capShare) => {
    for (const d of deferred) {
      if (out.length >= limit) return;
      pushGame(d.slug, d.label, capShare);
    }
    for (const c of ranked) {
      if (out.length >= limit) return;
      const why = because.get(c.slug);
      const seedGame = why && why.slug ? getGame(why.slug) : null;
      pushGame(c.slug, seedGame
        ? { kind: 'similar', slug: seedGame.slug, title: seedGame.title }
        : { kind: 'category', category: why && why.category }, capShare);
    }
  };

  fillFrom(MAX_CATEGORY_SHARE);                                    // 1
  while (out.length < limit) {                                     // 2
    const a = nextAdjacent();
    if (!a) break;
    pushGame(a.slug, { kind: 'adjacent' }, MAX_CATEGORY_SHARE);
  }
  while (out.length < limit) {                                     // 3
    const g = nextExplore();
    if (!g) break;
    pushGame(g.slug, { kind: 'discover' }, MAX_CATEGORY_SHARE);
  }
  if (out.length < limit) fillFrom(RELAXED_CATEGORY_SHARE);        // 4
  if (out.length < limit) fillFrom(null);                          // 5

  return out;
}

export default { loadSimilarityIndex, recommend, neighbours, indexSize };
