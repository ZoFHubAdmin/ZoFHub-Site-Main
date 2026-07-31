#!/usr/bin/env python3
"""
tools/build-recommendations.py — OFFLINE item-item similarity index for ZoFHub.

WHY THIS IS PYTHON, AND WHY IT RUNS OFFLINE (never on the live server):
  Same split as build-mood-index.py. The live site is Node and has to answer
  /api/for-you in milliseconds. THIS is the opposite job: one heavy pass over
  the whole ~17k-game catalog, comparing games against each other. Doing that
  per-request would be absurd; doing it once, offline, and shipping a lookup
  table means the server does an O(1) dict read instead of O(n) maths.

  Output: data/game-similarity.json  →  { "slug": [["neighbour", 0.83], ...] }
  The Node side (lib/recommender.mjs) loads it at boot and never recomputes.

WHY CONTENT-BASED AND NOT COLLABORATIVE FILTERING:
  The obvious build here is "people who played X also played Y" (item-item
  collaborative filtering). It is the wrong call TODAY, and the data says so:
  at the time of writing only 71 games out of ~12.7k had ANY play count — about
  0.6%. A co-play matrix built from that is almost entirely empty, and an empty
  matrix produces confident-looking garbage. So this builds similarity from what
  we actually have for EVERY game: its mood/genre tags, its category, and the
  words in its title.
  Content similarity is also the floor that always works, including for a game
  added an hour ago with zero plays — the cold-start case that pure
  collaborative filtering cannot answer at all.

  What the Node side DOES use today is live play counts as a popularity prior
  for tie-breaks and exploration (lib/recommender.mjs, POP_PRIOR). That is the
  honest limit of what current data supports. Real co-play would need per-user
  play SEQUENCES, which the server does not log — adding that is a deliberate
  decision about data collection and per-instance state, not a quick win, so it
  is left undone rather than faked.

HOW TO RUN:
  1) npm run export-games                  # refresh data/games-export.json
  2) npm run mood-index                    # refresh data/mood-tags.json (tags!)
  3) npm run rec-index                     # this script
  4) restart the server                    # loads data/game-similarity.json

  Order matters: this reads mood-tags.json, which is the single richest signal.
  Without it the index still builds (category + title only) but is much weaker.

Standard library only — no pip installs, matching the rest of tools/.
"""
import json
import math
import os
import re
import sys
import time
from collections import Counter, defaultdict

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
GAMES = os.path.join(ROOT, "data", "games-export.json")
TAGS = os.path.join(ROOT, "data", "mood-tags.json")
OUT = os.path.join(ROOT, "data", "game-similarity.json")

# ---------------------------------------------------------------------------
# Tunables. All overridable from the command line, e.g.:
#   python tools/build-recommendations.py --top-k 16 --max-df 2000
# ---------------------------------------------------------------------------
TOP_K = 12          # neighbours stored per game. 12 fills a row with room to filter.
MAX_DF = 1800       # terms appearing in MORE games than this are skipped during
                    # candidate generation. See the big comment in build_index().
MIN_SCORE = 0.06    # drop neighbours below this cosine — a weak "match" is worse
                    # than showing nothing, because it reads as a broken feature.

# A single shared word is a COINCIDENCE, not a similarity signal.
#
# Found by eyeballing the first build: "Spinning Shooter" recommended
# "Spinning Art" (0.278) and "Draw Spinning" (0.248) ABOVE "Space Shooter"
# (0.188). A shooter was being matched to drawing games. The cause is subtle and
# worth stating, because it looks like correct behaviour: "spinning" is a RARE
# word, so TF-IDF gives it a big weight, and one rare shared word outweighed
# total genre disagreement. Meanwhile "Space Shooter" — the genuinely right
# answer — shares the COMMON word "shooter", whose IDF is near zero.
#
# Requiring two independent shared terms fixes it at the root instead of by
# fiddling with weights: a game that matches on one lucky token and nothing else
# is no longer a neighbour at all.
MIN_OVERLAP = 2

# Field weights. Tags are curated and semantic ("scary", "competitive"), so they
# carry the most signal. Category is reliable but coarse — "arcade" alone covers
# ~24% of the catalog, so weighting it too high would just recommend the biggest
# bucket to everyone. Title tokens are noisy but are the ONLY thing separating
# two games that share a category and tags ("Zombie Sniper" vs "Bubble Pop"),
# and they are what links a series together ("Moto X3M 2" → "Moto X3M 3"), which
# is one of the most obviously-correct recommendations we can make.
W_TAG = 1.0
W_CATEGORY = 0.95   # raised from 0.7: genre agreement should outrank a shared word
W_TITLE = 0.42      # lowered from 0.55, same reason — see MIN_OVERLAP above

# Title words that carry no signal. Without this, every game titled "... Game 3D
# Online Free" looks similar to every other, which is exactly the failure mode
# that makes a recommender feel random.
STOPWORDS = {
    "game", "games", "play", "playing", "online", "free", "the", "a", "an", "and",
    "or", "of", "for", "with", "to", "in", "on", "at", "by", "new", "best", "top",
    "super", "ultimate", "extreme", "world", "io", "html5", "unblocked", "version",
    "player", "players", "fun", "cool", "amazing", "great", "real", "simulator",
    "sim", "adventure", "arcade", "casual",
}

TOKEN_RE = re.compile(r"[a-z0-9]+")


# Windows consoles default to cp1252, which cannot encode box-drawing characters
# or the accented titles in this catalog ("Tagliche Wortsuche" prints as "T?gliche"
# without this, and a bare print() of it raises UnicodeEncodeError and kills the
# build). Force UTF-8 on stdout so the report is readable everywhere.
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

def log(msg):
    print(msg, flush=True)


def die(msg):
    print("ERROR: " + msg, file=sys.stderr)
    sys.exit(1)


def parse_args():
    """Tiny arg parser — argparse would work too, but this keeps the script
    dependency-free and readable at a glance."""
    global TOP_K, MAX_DF, MIN_SCORE, MIN_OVERLAP
    args = sys.argv[1:]
    i = 0
    while i < len(args):
        a = args[i]
        if a == "--top-k" and i + 1 < len(args):
            TOP_K = int(args[i + 1]); i += 2
        elif a == "--max-df" and i + 1 < len(args):
            MAX_DF = int(args[i + 1]); i += 2
        elif a == "--min-score" and i + 1 < len(args):
            MIN_SCORE = float(args[i + 1]); i += 2
        elif a == "--min-overlap" and i + 1 < len(args):
            MIN_OVERLAP = int(args[i + 1]); i += 2
        elif a in ("-h", "--help"):
            print(__doc__); sys.exit(0)
        else:
            die("unknown argument: " + a)


def load_games():
    if not os.path.exists(GAMES):
        die("missing %s — run `npm run export-games` first." % GAMES)
    with open(GAMES, "r", encoding="utf-8") as f:
        data = json.load(f)
    games = data if isinstance(data, list) else data.get("games", [])
    if not games:
        die("no games found in %s" % GAMES)
    return games


def load_tags():
    """mood-tags.json is optional but strongly recommended — it is the richest
    signal we have. Build it with `npm run mood-index`."""
    if not os.path.exists(TAGS):
        log("  ! data/mood-tags.json missing — falling back to category + title")
        log("    only. Run `npm run mood-index` first for a much better index.")
        return {}
    with open(TAGS, "r", encoding="utf-8") as f:
        return json.load(f)


def norm_title(title):
    """Collapse a title to a comparison key, so "Turn 90" and "turn  90!" are
    recognised as the same game surfacing twice under different slugs."""
    return " ".join(TOKEN_RE.findall((title or "").lower()))


def title_tokens(title):
    """Lowercase word tokens from a title, minus stopwords and bare numbers.

    Numbers are dropped because '2' in 'Moto X3M 2' says nothing about what the
    game IS — but they are KEPT when attached to letters ('3d', 'x3m'), which do
    carry signal."""
    out = []
    for tok in TOKEN_RE.findall((title or "").lower()):
        if tok in STOPWORDS or len(tok) < 2 or tok.isdigit():
            continue
        out.append(tok)
    return out


def build_vectors(games, tagmap):
    """Turn every game into a sparse weighted term vector, TF-IDF style.

    Returns (vectors, slugs) where vectors[i] is {term: weight}, L2-normalised so
    that a plain dot product IS the cosine similarity. Normalising here means the
    hot inner loop later does no division at all.
    """
    # Namespaced terms so a CATEGORY "racing" and a TAG "racing" are distinct
    # features. Without the prefix they collapse into one, which quietly
    # double-counts the same evidence and skews everything toward big categories.
    raw = []
    df = Counter()
    skipped = 0

    for g in games:
        slug = (g.get("slug") or "").strip().lower()
        if not slug:
            skipped += 1
            continue
        terms = Counter()

        for t in (tagmap.get(slug) or []):
            t = str(t).strip().lower()
            if t:
                terms["t:" + t] += W_TAG

        cat = (g.get("category") or "").strip().lower()
        if cat:
            terms["c:" + cat] += W_CATEGORY

        for tok in title_tokens(g.get("title")):
            terms["w:" + tok] += W_TITLE

        if not terms:
            skipped += 1
            continue

        raw.append((slug, terms, norm_title(g.get("title"))))
        for term in terms:
            df[term] += 1

    n = len(raw)
    if not n:
        die("no usable games (every game lacked slug/tags/category/title)")

    # Standard smoothed IDF. A term in every game gets ~0 weight; a term in a
    # handful gets a large one. This is what makes a rare tag like "roguelike"
    # count for far more than "fun".
    idf = {term: math.log(n / (1.0 + cnt)) + 1.0 for term, cnt in df.items()}

    vectors = []
    slugs = []
    norm_titles = []
    for slug, terms, ntitle in raw:
        vec = {}
        for term, tf in terms.items():
            w = tf * idf[term]
            if w > 0:
                vec[term] = w
        norm = math.sqrt(sum(w * w for w in vec.values()))
        if norm <= 0:
            continue
        for term in vec:
            vec[term] /= norm
        vectors.append(vec)
        slugs.append(slug)
        norm_titles.append(ntitle)

    log("  vectors: %d games, %d distinct terms (%d games skipped)"
        % (len(vectors), len(df), skipped))
    return vectors, slugs, df, norm_titles


def build_index(vectors, slugs, df, norm_titles):
    """Top-K nearest neighbours for every game, via an inverted index.

    THE SCALE PROBLEM: comparing every game to every other is n^2. At ~17k games
    that is ~285 MILLION pairs — minutes-to-hours in pure Python, and pointless,
    because the overwhelming majority of pairs share no terms at all and score
    exactly 0.

    THE FIX (standard information-retrieval accumulator): walk each game's terms,
    look up the posting list for that term, and add the contribution ONLY to
    games that actually share it. Games sharing nothing are never touched.

    MAX_DF is the other half. A term present in 8,000 games has a posting list of
    8,000 entries, contributes almost nothing (its IDF is tiny), and would
    single-handedly dominate the runtime. Skipping high-document-frequency terms
    during accumulation is a big constant-factor win for a negligible accuracy
    cost — those terms are the least discriminative ones by definition.
    """
    postings = defaultdict(list)
    for i, vec in enumerate(vectors):
        for term in vec:
            if df[term] <= MAX_DF:
                postings[term].append(i)

    n = len(vectors)
    skipped_terms = sum(1 for t, c in df.items() if c > MAX_DF)
    log("  inverted index: %d usable terms (%d skipped as too common, df > %d)"
        % (len(postings), skipped_terms, MAX_DF))

    index = {}
    started = time.time()
    dropped_overlap = 0
    dropped_dupe = 0

    for i in range(n):
        vec = vectors[i]
        scores = defaultdict(float)
        overlap = defaultdict(int)      # how many DISTINCT terms each candidate shares
        for term, wi in vec.items():
            plist = postings.get(term)
            if not plist:
                continue
            for j in plist:
                if j != i:
                    scores[j] += wi * vectors[j][term]
                    overlap[j] += 1

        if scores:
            # nlargest via sort on a bounded dict — the accumulator only ever
            # holds games that shared at least one term, so this stays small.
            ranked = sorted(scores.items(), key=lambda kv: kv[1], reverse=True)
            neighbours = []
            # The catalog contains genuine duplicate TITLES under different slugs
            # (re-imports of the same game from different publishers). Showing
            # "Turn 90" twice in a row reads as a broken feature even though the
            # underlying rows are distinct — so keep only the best-scoring one.
            seen_titles = set()
            own_title = norm_titles[i]
            for j, s in ranked:
                if s < MIN_SCORE:
                    break                       # sorted desc — nothing below will pass
                if overlap[j] < MIN_OVERLAP:
                    dropped_overlap += 1
                    continue
                nt = norm_titles[j]
                if nt and (nt in seen_titles or nt == own_title):
                    dropped_dupe += 1
                    continue
                seen_titles.add(nt)
                neighbours.append([slugs[j], round(s, 3)])
                if len(neighbours) >= TOP_K:
                    break
            if neighbours:
                index[slugs[i]] = neighbours

        if (i + 1) % 2000 == 0:
            rate = (i + 1) / max(0.001, time.time() - started)
            log("    %d/%d games (%.0f/s)" % (i + 1, n, rate))

    log("  done in %.1fs" % (time.time() - started))
    log("  filtered: %d single-term coincidences, %d duplicate titles"
        % (dropped_overlap, dropped_dupe))
    return index


def report(index, vectors, slugs, games):
    """Print a few real examples. A similarity index is very easy to build
    WRONG in a way that still produces plausible-looking JSON, so the build
    prints actual neighbours for eyeballing rather than just a success line."""
    titles = {}
    for g in games:
        s = (g.get("slug") or "").lower()
        if s:
            titles[s] = g.get("title") or s

    covered = len(index)
    total = len(slugs)
    log("")
    log("  coverage: %d/%d games have neighbours (%.1f%%)"
        % (covered, total, 100.0 * covered / max(1, total)))
    sizes = [len(v) for v in index.values()]
    if sizes:
        log("  neighbours per game: avg %.1f, min %d, max %d"
            % (sum(sizes) / len(sizes), min(sizes), max(sizes)))

    # Sample games that actually have a decent number of neighbours, so the
    # printed spot-check is representative rather than a lucky pick.
    picks = [s for s in slugs if len(index.get(s, [])) >= 3][:400]
    step = max(1, len(picks) // 5)
    log("")
    log("  --- spot check (eyeball these; they should look related) ---")
    for slug in picks[::step][:5]:
        log("  %s" % titles.get(slug, slug))
        for nb, score in index[slug][:4]:
            log("      %.3f  %s" % (score, titles.get(nb, nb)))


def main():
    parse_args()
    log("build-recommendations: top-k=%d max-df=%d min-score=%.2f min-overlap=%d"
        % (TOP_K, MAX_DF, MIN_SCORE, MIN_OVERLAP))
    log("")
    log("  reading %s" % os.path.relpath(GAMES, ROOT))
    games = load_games()
    log("  reading %s" % os.path.relpath(TAGS, ROOT))
    tagmap = load_tags()
    log("  %d games, %d tagged" % (len(games), len(tagmap)))
    log("")

    vectors, slugs, df, norm_titles = build_vectors(games, tagmap)
    index = build_index(vectors, slugs, df, norm_titles)
    report(index, vectors, slugs, games)

    # NOTE ON WHAT IS *NOT* FILTERED HERE:
    # data/catalog-overrides.json removes ~2.3k games (dead hosts, duplicates,
    # unlicensed copies). This index deliberately does NOT apply those rules.
    # Re-implementing the matcher (slug / titleAllOf / hostIncludes) in Python
    # would be a second copy of logic that already lives in
    # lib/catalog-overrides.mjs, and the two WOULD drift. Instead the Node side
    # filters every recommendation against the live catalog, so a removed game
    # simply never gets returned. Costs a little file size; buys correctness.
    tmp = OUT + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(index, f, separators=(",", ":"), ensure_ascii=False)
    os.replace(tmp, OUT)   # atomic: a crash mid-write can't leave a torn file

    size_mb = os.path.getsize(OUT) / (1024.0 * 1024.0)
    log("")
    log("  wrote %s (%.2f MB)" % (os.path.relpath(OUT, ROOT), size_mb))
    log("  restart the server to load it.")


if __name__ == "__main__":
    main()
