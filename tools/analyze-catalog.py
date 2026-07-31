#!/usr/bin/env python3
"""
tools/analyze-catalog.py — OFFLINE feed-ranking analysis for ZoFHub.

WHAT THIS IS FOR
  build-recommendations.py answers "what is similar to X" (the personalised
  row). THIS answers a different question: "in what ORDER should the main grid
  show 12,711 games to everyone?" That is the feed every visitor sees, and
  before this it was ranked by:

      3.0 · log10(1+plays)/3 + random() + 0.3·hasThumbnail

  …which is almost entirely random, because almost nothing has plays.

WHAT THE DATA ACTUALLY SAYS (measured, not assumed — see --report)
  • 71 of 16,913 games have ANY play count. 179 plays in total. Median 1.
    So per-game play data is statistically meaningless today, and ranking the
    feed by it would pin whichever handful of games got test traffic to page 1
    permanently — the classic rich-get-richer trap.
  • 4,691 games (27.7%) share a title with at least one other game. 2,343
    distinct titles appear 2-4 times. A user scrolling the grid sees the same
    game again and again under different slugs. THIS is the biggest feed-quality
    problem, and it is measurable with full confidence right now.
  • One category, "arcade", is 5,364 games — 31.7% of the catalog. A feed that
    samples proportionally is a third arcade on every page.

  So the honest analysis is: lean on the signals that are DENSE (title,
  category, tags, duplicates), and treat the play data with the scepticism 179
  events deserve — while making sure the same code gets it RIGHT once real
  traffic arrives. That is what the empirical-Bayes step below does: it weights
  a game's own play count by how much evidence there actually is behind it.

OUTPUT
  data/feed-ranking.json  →  { "scores": {slug: 0..1}, "canonical": {...}, … }
  server.js loads it at boot and blends it into the feed ordering.

HOW TO RUN
  npm run export-games        # refresh data/games-export.json
  npm run mood-index          # refresh data/mood-tags.json
  npm run feed-rank           # this script
  # restart the server

Standard library only — no pip installs.
"""
import json
import math
import os
import re
import sys
import time
import urllib.request
import urllib.error
from collections import Counter, defaultdict

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
GAMES = os.path.join(ROOT, "data", "games-export.json")
TAGS = os.path.join(ROOT, "data", "mood-tags.json")
OUT = os.path.join(ROOT, "data", "feed-ranking.json")
ENV = os.path.join(ROOT, ".env")

# ── Tunables ───────────────────────────────────────────────────────────────
# Empirical-Bayes strength. A game's own play count is trusted in proportion to
# how many plays back it: confidence = plays / (plays + PRIOR_STRENGTH).
#
# At PRIOR_STRENGTH=8, a game with 1 play (the current median) gets 11%
# confidence — 89% of its score comes from how its CATEGORY performs. A game
# with 100 plays gets 93% confidence and stands on its own record. This single
# constant is why the script is correct both today, on 179 plays, and later on
# millions, with no code change.
PRIOR_STRENGTH = 8.0

# Category-level shrinkage, and it needs to be MUCH stronger than the per-game
# one. Calibrating this the lazy way (reusing PRIOR_STRENGTH=8) produced a
# textbook failure that the --report caught: "io-games" collected a handful of
# plays across a small number of games, scored a category prior of 1.00, and the
# top of the feed became SNAKE WARZ / LOLbeans io / Conquer IO / Suroi / Snaker
# io / Worm Hunt — six io games in a row, off perhaps 30 play events.
#
# A per-game count and a per-category RATE need different scepticism: the rate
# has games-in-category in its denominator, so a small category swings wildly on
# very little evidence. At 250, a category needs ~250 plays before its own
# measured rate outweighs the global average. With 179 plays site-wide, every
# category correctly sits near the global mean — because we genuinely do not yet
# know which categories are popular, and the ranking should not pretend we do.
CAT_PRIOR_STRENGTH = 250.0

# Absolute evidence gate, and the most important constant in this file.
#
# Shrinkage alone cannot save you in this regime, which took three passes to see.
# With 179 plays across 16,913 games the global average is 0.011 plays/game, so a
# small category that received even 20 plays measures ~60x above average. Shrink
# that by 94% and it is STILL 4x average — statistically significant by any test,
# and substantively meaningless, because those plays are our own testing rather
# than a sample of user behaviour. Three rounds of tuning kept producing the same
# six io-games at the top of the feed for exactly this reason.
#
# So: trust the play signal in proportion to TOTAL site-wide evidence, and ramp
# it in smoothly rather than switching it on at a cliff.
#     trust = min(1, total_plays / PLAYS_FOR_FULL_TRUST)
# At 179 plays trust is 3.6%, so every category sits at a neutral 0.5 and the
# ranking is driven by the signals that ARE dense — duplicates, category balance,
# title quality. At 50k plays the signal is fully live. No code change needed in
# between; the same script simply starts believing the data once there is data.
PLAYS_FOR_FULL_TRUST = 50000.0

# How hard to counteract category over-representation. arcade is 31.7% of the
# catalog; without this the grid is a third arcade forever. 0 = no correction,
# 1 = fully flatten. 0.5 keeps big categories big while giving the other 86 a
# real chance to appear.
BALANCE_ALPHA = 0.5

# Floor for the balance weight. The first version referenced 1/87 as the "fair"
# share, i.e. it assumed all 87 categories should be equally sized, and duly
# crushed arcade to 0.19. That is over-correction: arcade IS legitimately the
# biggest genre, it just should not be a THIRD of every page. Referencing the
# median category share with a floor keeps the correction meaningful without
# pretending a 5,364-game category deserves the same room as a 3-game one.
#
# The floor was then raised from 0.55 to 0.88, because the top-200 measurement
# showed 0.55 flipped the problem clean over: arcade went from 31.7% of the
# catalog to 0.0% of the top 200, while categories holding 0.1% of the catalog
# took 5-6% of the feed each. The reason is that in the current data regime the
# other two signals are almost constant (interest is a flat 0.5 with no play
# data, title quality averages 0.997), so balance was the ONLY varying term and
# therefore sorted the entire feed by itself. A ranking weight that becomes the
# sole differentiator stops being a nudge and becomes the ordering.
#
# Softening the weight did NOT help, and that result is the useful one: at 0.15
# with a 0.88 floor the top 200 was STILL 0.0% arcade. The spread between the
# largest and smallest category worked out to ~0.018 of score, and when every
# other term is effectively constant, an 0.018 tiebreaker is not a tiebreaker —
# it IS the sort order. Any non-zero weight would have done the same.
#
# So balance is no longer part of the score at all. It is exported for the
# server to apply as a per-page diversity cap ("no single page is more than ~35%
# one category"), which is what was actually wanted: a constraint on each screen
# the user sees, not a global rule ranking every small category above every
# large one.
BALANCE_FLOOR = 0.88

# Score weights (must sum to 1.0).
# Weights. W_QUALITY started at 0.28 and was cut after the report showed mean
# title quality was 0.997 — this catalog's titles are already clean (median 16
# chars), so the signal is very nearly a constant, and a constant cannot order
# anything. It still earns a small weight for the genuine outliers it catches.
W_INTEREST = 0.65   # empirical-Bayes play signal
W_QUALITY = 0.35    # title/tag quality
# NOTE: there is deliberately no W_BALANCE. Category balance is EXPORTED for the
# server to apply per page, but it is not part of this score. See BALANCE_FLOOR.

# Duplicate handling. One copy of a title keeps its full score; every further
# copy is multiplied by this. NOT removed — it stays searchable and reachable
# from its category page, it just stops occupying repeat slots in the grid.
DUP_PENALTY = 0.25

TOKEN_RE = re.compile(r"[a-z0-9]+")
# Keyword-stuffed titles ("Free Online Super Game 3D Play Now Unblocked") are a
# reliable low-quality marker in scraped catalogs.
SPAM_WORDS = {"free", "online", "unblocked", "play", "now", "best", "top",
              "html5", "game", "games", "new", "super", "ultimate", "crazy"}


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


def norm_title(t):
    return " ".join(TOKEN_RE.findall(str(t or "").lower()))


def read_env():
    """Minimal .env reader. server.js uses process.loadEnvFile() for the same
    file; this mirrors it so the script needs no arguments and no pip install."""
    env = {}
    if not os.path.exists(ENV):
        return env
    try:
        with open(ENV, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                env[k.strip()] = v.strip().strip('"').strip("'")
    except Exception as e:
        log("  ! could not read .env: %s" % e)
    return env


def fetch_play_stats():
    """Pull game_stats from Supabase over PostgREST with urllib.

    Optional by design: no network, no keys, or a down database all degrade to
    "no play data", and the analysis proceeds on content signals alone. A
    ranking build must never be the thing that blocks a deploy.
    """
    env = read_env()
    url = env.get("SUPABASE_URL") or os.environ.get("SUPABASE_URL")
    key = (env.get("SUPABASE_SECRET_KEY") or env.get("SUPABASE_SERVICE_ROLE_KEY")
           or os.environ.get("SUPABASE_SECRET_KEY")
           or os.environ.get("SUPABASE_SERVICE_ROLE_KEY"))
    if not url or not key:
        log("  ! no Supabase credentials — continuing with no play data.")
        return {}
    endpoint = url.rstrip("/") + "/rest/v1/game_stats?select=slug,plays&limit=50000"
    req = urllib.request.Request(endpoint, headers={
        "apikey": key, "Authorization": "Bearer " + key, "Accept": "application/json",
    })
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            rows = json.loads(r.read().decode("utf-8"))
        stats = {str(x.get("slug", "")).lower(): int(x.get("plays") or 0)
                 for x in rows if x.get("slug")}
        log("  play stats: %d games, %d plays total"
            % (len(stats), sum(stats.values())))
        return stats
    except Exception as e:
        log("  ! could not fetch game_stats (%s) — continuing without it." % e)
        return {}


def load_json(path, what):
    if not os.path.exists(path):
        return None
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception as e:
        log("  ! could not read %s: %s" % (what, e))
        return None


def title_quality(title, tags):
    """A 0..1 quality estimate from signals that are dense enough to trust.

    Deliberately NOT a taste judgement — it only measures things that correlate
    with a scraped-catalog entry being junk: keyword stuffing, an unreadably
    long title, no useful words left after stopwords, and thin tagging.
    """
    t = str(title or "")
    toks = TOKEN_RE.findall(t.lower())
    if not toks:
        return 0.0

    score = 1.0
    # Keyword stuffing: what fraction of the title is filler?
    spam = sum(1 for x in toks if x in SPAM_WORDS)
    spam_ratio = spam / len(toks)
    score -= 0.5 * spam_ratio

    # Length. Very long titles in these catalogs are SEO strings, not names.
    # Measured: median 16 chars, p95 30. Past ~45 it is almost always junk.
    if len(t) > 45:
        score -= 0.25
    elif len(t) > 34:
        score -= 0.10
    # Single-token titles are usually too generic to be findable ("Game").
    if len(toks) == 1 and len(toks[0]) <= 3:
        score -= 0.20

    # SHOUTING titles are a scrape artefact.
    letters = [c for c in t if c.isalpha()]
    if letters and sum(1 for c in letters if c.isupper()) / len(letters) > 0.8:
        score -= 0.15

    # Tag richness: a well-categorised game is more findable and more likely to
    # be a real, complete entry. Saturates at 6 tags.
    score += 0.15 * min(1.0, len(tags) / 6.0)

    return max(0.0, min(1.0, score))


def main():
    report_only = "--report" in sys.argv
    log("analyze-catalog: feed ranking")
    log("")

    raw = load_json(GAMES, "games-export.json")
    if raw is None:
        log("ERROR: missing %s — run `npm run export-games` first." % GAMES)
        sys.exit(1)
    games = raw if isinstance(raw, list) else raw.get("games", [])
    tagmap = load_json(TAGS, "mood-tags.json") or {}
    log("  catalog: %d games, %d tagged" % (len(games), len(tagmap)))
    plays = fetch_play_stats()
    log("")

    # ── 1. Category aggregates ───────────────────────────────────────────────
    # "Plays per game" is the right unit, not total plays: a category with 500
    # plays across 10 games is far more engaging than one with 500 across 5,000.
    cat_games = Counter()
    cat_plays = Counter()
    for g in games:
        c = (g.get("category") or "other").strip().lower()
        cat_games[c] += 1
        cat_plays[c] += plays.get(str(g.get("slug", "")).lower(), 0)

    total_games = max(1, sum(cat_games.values()))
    total_plays = sum(cat_plays.values())
    global_ppg = total_plays / total_games if total_games else 0.0

    # Shrink each category's plays-per-game toward the global mean, in
    # proportion to how many plays back it. A category with 2 plays does not get
    # to claim it is 10x more popular than one with 0.
    cat_prior = {}
    for c, n in cat_games.items():
        obs = cat_plays[c] / n if n else 0.0
        conf = cat_plays[c] / (cat_plays[c] + CAT_PRIOR_STRENGTH)
        cat_prior[c] = conf * obs + (1 - conf) * global_ppg
    # Express each category RELATIVE TO THE GLOBAL AVERAGE, where 1.0x average
    # maps to a neutral 0.5 and twice-average maps to 1.0.
    #
    # The obvious normalisation — divide every category by the largest — is a
    # trap, and it silently undid the shrinkage above. Shrinking pulls every
    # category to within a hair of the global mean (correct, on 179 plays), but
    # dividing by the max then re-expands those hair-thin differences across the
    # full 0..1 range. The report still showed io-games at 1.00 and six io games
    # leading the feed even AFTER the shrinkage constant was raised 30x, because
    # max-normalisation restored exactly the spread the shrinkage removed.
    #
    # Anchoring to the average instead means: no play data -> every category
    # sits at 0.5 and the signal correctly does nothing. As real traffic
    # arrives, categories genuinely above average drift up on their own.
    trust = min(1.0, total_plays / PLAYS_FOR_FULL_TRUST) if PLAYS_FOR_FULL_TRUST else 1.0
    if global_ppg > 0:
        for c in cat_prior:
            rel = max(0.0, min(1.0, 0.5 * (cat_prior[c] / global_ppg)))
            # Ramp from neutral (0.5) toward the measured value as evidence grows.
            cat_prior[c] = 0.5 + trust * (rel - 0.5)
    else:
        for c in cat_prior:
            cat_prior[c] = 0.5

    # ── 2. Category balance ──────────────────────────────────────────────────
    # Down-weight over-represented categories so one bucket cannot own the grid.
    ncats = max(1, len(cat_games))
    shares = sorted(n / total_games for n in cat_games.values())
    median_share = shares[len(shares) // 2] if shares else 1.0
    balance = {}
    for c, n in cat_games.items():
        share = n / total_games
        if share <= 0:
            balance[c] = 1.0
            continue
        w = (median_share / share) ** BALANCE_ALPHA
        balance[c] = max(BALANCE_FLOOR, min(1.0, w))

    # ── 3. Duplicate detection ───────────────────────────────────────────────
    # Group by normalised title and elect ONE canonical per group. The winner is
    # the most-played, then the one with a thumbnail, then the lowest id (the
    # earliest import, most likely the original rather than a re-scrape).
    by_title = defaultdict(list)
    for g in games:
        nt = norm_title(g.get("title"))
        if nt:
            by_title[nt].append(g)

    canonical = {}      # slug -> canonical slug for its title group
    dup_count = 0
    for nt, group in by_title.items():
        if len(group) == 1:
            continue
        group.sort(key=lambda g: (
            -plays.get(str(g.get("slug", "")).lower(), 0),
            0 if g.get("thumbnail_url") else 1,
            g.get("id") or 10**9,
        ))
        winner = str(group[0].get("slug", "")).lower()
        for g in group[1:]:
            canonical[str(g.get("slug", "")).lower()] = winner
            dup_count += 1

    # ── 4. Per-game score ────────────────────────────────────────────────────
    scores = {}
    quality_sum = 0.0
    for g in games:
        slug = str(g.get("slug", "")).lower()
        if not slug:
            continue
        cat = (g.get("category") or "other").strip().lower()
        p = plays.get(slug, 0)

        # Empirical Bayes: trust this game's own plays in proportion to how many
        # there are; otherwise fall back to how its category performs.
        conf = p / (p + PRIOR_STRENGTH)
        observed = min(1.0, math.log10(1 + p) / 3.0)   # same curve server.js uses
        interest = conf * observed + (1 - conf) * cat_prior.get(cat, 0.5)

        q = title_quality(g.get("title"), tagmap.get(slug) or [])
        quality_sum += q

        # ── Why this is QUANTISED rather than a continuous score ───────────
        # Three calibration attempts all produced the same pathology: the top of
        # the feed collapsed onto one category (six io-games, then 0% arcade and
        # 6% "memory", then 73% sports). The cause is not the weights. With no
        # usable play data, `interest` is a flat 0.5 and `quality` averages
        # 0.997, so EVERY term is very nearly constant — and when everything is
        # constant, whatever varies by 0.002 becomes the total sort order.
        # Any weighting produces spurious category clustering.
        #
        # We honestly know two things about these games: which are duplicates
        # (2,348, measured with certainty) and which have junk titles. We do NOT
        # know that sports beats arcade. So the score encodes only the former,
        # ROUNDED so that near-identical games become EXACT ties — and the
        # server's existing per-visit weighted shuffle then breaks those ties
        # randomly, which is genuine variety rather than invented signal.
        #
        # Once real traffic exists (trust passes 10%), the play signal is added
        # back and produces a real ordering. Same code, no change needed.
        if trust > 0.10:
            s = W_INTEREST * interest + W_QUALITY * q
        else:
            s = round(q * 8) / 8.0      # 9 coarse tiers, honest ties

        if slug in canonical:
            s *= DUP_PENALTY

        scores[slug] = round(max(0.0, min(1.0, s)), 4)

    # ── Report ───────────────────────────────────────────────────────────────
    log("  ── findings ──")
    log("  duplicate titles : %d games demoted (%.1f%% of catalog)"
        % (dup_count, 100.0 * dup_count / max(1, len(games))))
    log("  categories       : %d; largest '%s' at %.1f%% -> balance weight %.2f"
        % (ncats, cat_games.most_common(1)[0][0],
           100.0 * cat_games.most_common(1)[0][1] / total_games,
           balance.get(cat_games.most_common(1)[0][0], 1.0)))
    log("  mean title quality: %.3f" % (quality_sum / max(1, len(games))))
    log("  play-signal trust: %.1f%% (%d of %d plays needed for full trust)"
        % (100 * min(1.0, total_plays / PLAYS_FOR_FULL_TRUST), total_plays,
           int(PLAYS_FOR_FULL_TRUST)))
    if total_plays:
        top = sorted(cat_prior.items(), key=lambda kv: kv[1], reverse=True)[:5]
        log("  play signal      : %d plays over %d games — confidence for a"
            % (total_plays, len(plays)))
        log("                     median (1-play) game is %.0f%%, so %.0f%% of its"
            % (100 * (1 / (1 + PRIOR_STRENGTH)), 100 * (PRIOR_STRENGTH / (1 + PRIOR_STRENGTH))))
        log("                     score comes from its category, as it should.")
        log("  top categories   : %s"
            % ", ".join("%s %.2f" % (c, v) for c, v in top))
    else:
        log("  play signal      : NONE — scores are content-quality only.")

    ranked = sorted(scores.items(), key=lambda kv: kv[1], reverse=True)
    title_of = {str(g.get("slug", "")).lower(): g.get("title") for g in games}
    log("")
    log("  --- would now lead the feed ---")
    for slug, s in ranked[:8]:
        log("   %.3f  %s" % (s, title_of.get(slug, slug)))
    log("  --- would now sink ---")
    for slug, s in ranked[-4:]:
        log("   %.3f  %s" % (s, title_of.get(slug, slug)))

    # Empirical check that the balancing actually did something. Comparing the
    # top of the ranking against catalog share is the only honest way to know:
    # the weights are a hypothesis, this is the measurement.
    top_n = [slug for slug, _ in ranked[:200]]
    cat_of = {str(g.get("slug", "")).lower(): (g.get("category") or "other").strip().lower()
              for g in games}
    top_cats = Counter(cat_of.get(s_, "other") for s_ in top_n)
    log("")
    log("  --- top 200: share of feed vs share of catalog ---")
    for c, k in top_cats.most_common(6):
        log("   %-14s feed %5.1f%%   catalog %5.1f%%"
            % (c, 100.0 * k / len(top_n), 100.0 * cat_games[c] / total_games))
    biggest = cat_games.most_common(1)[0][0]
    log("   '%s' is %.1f%% of the catalog but %.1f%% of the top 200"
        % (biggest, 100.0 * cat_games[biggest] / total_games,
           100.0 * top_cats.get(biggest, 0) / len(top_n)))

    if report_only:
        log("")
        log("  --report given: nothing written.")
        return

    payload = {
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "stats": {
            "games": len(games),
            "duplicatesDemoted": dup_count,
            "categories": ncats,
            "playsTotal": total_plays,
            "gamesWithPlays": len(plays),
            "priorStrength": PRIOR_STRENGTH,
        },
        # slug -> 0..1. server.js blends this into the feed ordering.
        "scores": scores,
        # Per-category weight in (0,1]. NOT applied to the scores above — the
        # server uses it as a per-page diversity cap at serving time.
        "categoryBalance": {c: round(v, 4) for c, v in balance.items()},
        "categoryShare": {c: round(n / total_games, 5) for c, n in cat_games.items()},
        # slug -> the slug that "owns" this title, for anything that wants to
        # collapse duplicates rather than merely demote them.
        "canonical": canonical,
    }
    tmp = OUT + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(payload, f, separators=(",", ":"), ensure_ascii=False)
    os.replace(tmp, OUT)    # atomic — a crash mid-write cannot leave a torn file
    log("")
    log("  wrote %s (%.2f MB)"
        % (os.path.relpath(OUT, ROOT), os.path.getsize(OUT) / 1048576.0))
    log("  restart the server to load it.")


if __name__ == "__main__":
    main()
