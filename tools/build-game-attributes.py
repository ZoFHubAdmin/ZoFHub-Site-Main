#!/usr/bin/env python3
"""
tools/build-game-attributes.py — OFFLINE structured attribute extractor.

WHAT THIS ADDS THAT mood-tags.json DOES NOT
  mood-tags.json gives every game a FLAT SET of words: ["brain","calm","chill",
  "logic","puzzle","relax","think","zen"]. That is enough to answer "show me
  something chill" by set overlap, and the Vibe Finder already does exactly that.

  It cannot answer any of these, which is what the feature was actually asked for:

      "I only have 10 minutes."
      "Something challenging but not frustrating."
      "I want something casual."
      "Not scary."

  The first needs a DURATION. The second needs difficulty on a SCALE, with a
  target in the middle — "challenging" and "frustrating" are the same axis, and
  the request is for a specific band of it, not the maximum. The third needs
  intensity as a magnitude. The fourth needs the ability to push a direction
  AWAY, which a set-overlap score has no way to express (a negative overlap is
  not a thing).

  So this converts the flat tags into SIX CONTINUOUS AXES plus an estimated
  session length, which makes all four answerable by distance-to-target.

THE AXES (each 0..1, 0.5 means "we genuinely do not know")
  calm         0 = frantic          1 = tranquil
  pace         0 = slow/turn-based  1 = twitch-fast
  brainy       0 = pure reflex      1 = pure thinking
  challenge    0 = effortless       1 = punishing
  social       0 = solitary         1 = competitive/versus
  cozy         0 = neutral/harsh    1 = cute/wholesome
  session_min  estimated minutes for one satisfying sitting

WHY NOT A MODEL
  A learned model needs labels. There are none: the catalog carries no
  descriptions (0% of 16,916), no play counts (0%), and no ratings, and the
  server logs no per-user sequences. Every axis below is therefore a
  DECLARED RULE over evidence we actually have — the game's category and the
  words in its title. That is auditable, deterministic, and honest about being
  a heuristic. A gradient-boosted ranker trained on zero labels would produce
  the same numbers with a false claim of having learned them.

  This is not a placeholder for a model. Given title-and-category-only inputs,
  a rules table IS the right estimator: there is no additional signal in the
  data for a model to find.

CONFIDENCE IS PART OF THE OUTPUT
  A game with no matching evidence gets 0.5 on every axis and confidence 0.
  Serving code must treat a 0.5/confidence-0 axis as "no opinion" and fall back
  to other signals, NOT as "perfectly average". Without this an unrecognised
  game looks like an ideal match for every mid-range request, which is the
  classic way a scoring system fills its top results with games it knows
  nothing about.

HOW TO RUN
  1) npm run export-games        # refresh data/games-export.json
  2) npm run mood-index          # refresh data/mood-tags.json  (input!)
  3) npm run game-attributes     # this script -> data/game-attributes.json
  4) restart the server

Standard library only — no pip installs, matching the rest of tools/.
"""
import json
import math
import os
import re
import sys
from collections import Counter, defaultdict

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
GAMES = os.path.join(ROOT, "data", "games-export.json")
FINAL = os.path.join(ROOT, "finalgames.json")
TAGS = os.path.join(ROOT, "data", "mood-tags.json")
OUT = os.path.join(ROOT, "data", "game-attributes.json")

TOKEN_RE = re.compile(r"[a-z0-9]+")

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass


def log(msg):
    print(msg, flush=True)


def die(msg):
    print("ERROR: " + msg, file=sys.stderr)
    sys.exit(1)


# ---------------------------------------------------------------------------
# THE EVIDENCE TABLES
#
# Each axis lists tokens that push it UP and tokens that push it DOWN. A token
# is matched against the union of {mood tags} ∪ {title words} ∪ {category}.
#
# Weights are deliberately coarse (1 or 2). Fine-grained weights would imply a
# precision this evidence does not have, and tuning them without labels is just
# moving numbers until the spot-check looks nice.
#
# THE ONE RULE THESE FOLLOW: a token appears on an axis only if seeing that word
# alone would let a person confidently guess the direction. "zen" clearly means
# calm. "arcade" does not clearly mean anything on any axis — it is 31.7% of the
# catalog and covers both Pac-Man and a driving sim, so it appears NOWHERE below.
# Putting a token on an axis "because it usually correlates" is how 5,367 arcade
# games end up with identical vectors and the Vibe Finder returns the same wall
# of games for every mood.
# ---------------------------------------------------------------------------
AXES = {
    "calm": {
        "up": {
            "zen": 2, "relax": 2, "calm": 2, "chill": 2, "patience": 2, "satisfying": 2,
            "coloring": 2, "jigsaw": 2, "garden": 1, "farm": 1, "solitaire": 1,
            "mahjong": 1, "sort": 1, "organize": 1, "tile": 1, "idle": 1, "care": 1,
            "sudoku": 1, "crossword": 1, "bubble": 1, "match": 1, "cozy": 2, "peaceful": 2,
            "quiet": 2, "slow": 1, "meditat": 2, "fishing": 1, "bake": 1, "cook": 1,
        },
        "down": {
            "intense": 2, "adrenaline": 2, "frantic": 2, "chaos": 2, "chaotic": 2,
            "smash": 1, "war": 1, "battle": 1, "fight": 1, "shoot": 1, "gun": 1,
            "zombie": 1, "horror": 2, "scary": 2, "evil": 1, "survival": 1, "combat": 1,
            "fast": 1, "speed": 1, "rage": 2, "extreme": 1, "tense": 2, "panic": 2,
            "sniper": 1, "strike": 1, "punch": 1, "boxing": 1, "ragdoll": 1,
        },
    },
    "pace": {
        "up": {
            "fast": 2, "speed": 2, "dash": 2, "run": 2, "reflex": 2, "rush": 2,
            "hypercasual": 1, "tap": 1, "jump": 1, "flappy": 1, "race": 1, "racing": 1,
            "drift": 1, "moto": 1, "bike": 1, "adrenaline": 2, "chase": 1, "parkour": 2,
            "subway": 1, "turbo": 2, "nitro": 2, "escape": 1, "action": 1, "arcade": 0,
            "energetic": 1, "active": 1, "quick": 1, "hyper": 2,
        },
        "down": {
            "think": 2, "logic": 2, "strategy": 2, "plan": 2, "patience": 2, "puzzle": 1,
            "sudoku": 2, "chess": 2, "solitaire": 1, "mahjong": 1, "crossword": 2,
            "word": 1, "jigsaw": 2, "idle": 2, "tycoon": 1, "manage": 1, "turn": 2,
            "coloring": 2, "zen": 1, "calm": 1, "board": 2,
        },
    },
    "brainy": {
        "up": {
            "brain": 2, "logic": 2, "think": 2, "puzzle": 2, "smart": 2, "memory": 2,
            "focus": 2, "strategy": 2, "plan": 2, "math": 2, "word": 2, "sudoku": 2,
            "chess": 2, "crossword": 2, "spelling": 2, "vocabulary": 2, "letters": 2,
            "riddle": 2, "quiz": 2, "solve": 2, "mystery": 1, "escape": 1, "hidden": 1,
            "observation": 1, "connect": 1, "sort": 1, "numbers": 1, "2048": 1,
            "jigsaw": 1, "maze": 1, "learn": 2, "clue": 1, "detective": 1, "trivia": 2,
        },
        "down": {
            "reflex": 2, "tap": 2, "dash": 2, "run": 1, "jump": 1, "smash": 2,
            "punch": 2, "shoot": 1, "flappy": 2, "clicker": 1, "idle": 1, "ragdoll": 2,
            "crazy": 1, "silly": 1, "goofy": 1, "hypercasual": 2, "speed": 1,
        },
    },
    "challenge": {
        "up": {
            "challenge": 2, "hard": 2, "difficult": 2, "impossible": 2, "extreme": 2,
            "intense": 2, "competitive": 1, "precision": 2, "skill": 2, "sniper": 1,
            "survival": 1, "boss": 2, "hardcore": 2, "expert": 2, "master": 1,
            "pro": 1, "insane": 2, "brutal": 2, "rage": 2, "nightmare": 2, "arena": 1,
            "versus": 1, "strategy": 1, "chess": 1, "tower-defense": 1, "defense": 1,
        },
        "down": {
            "easy": 2, "casual": 2, "relax": 1, "chill": 1, "idle": 2, "clicker": 2,
            "simple": 2, "kids": 2, "baby": 2, "beginner": 2, "coloring": 2,
            "cute": 1, "care": 1, "dress": 1, "makeover": 1, "salon": 1, "zen": 1,
            "satisfying": 1, "calm": 1, "toddler": 2, "preschool": 2,
        },
    },
    "social": {
        "up": {
            "multiplayer": 2, "versus": 2, "competitive": 2, "arena": 2, "pvp": 2,
            "2-player": 2, "team": 2, "battle": 1, "tournament": 2, "league": 1,
            "online": 1, "io": 2, "io-games": 2, "royale": 2, "duel": 2, "coop": 2,
            "soccer": 1, "football": 1, "basketball": 1, "sport": 1, "sports": 1,
            "boxing": 1, "party": 1, "war": 1,
        },
        "down": {
            "solitaire": 2, "idle": 1, "clicker": 1, "coloring": 1, "jigsaw": 1,
            "sudoku": 1, "crossword": 1, "story": 1, "zen": 1, "patience": 2,
            "hidden": 1, "care": 1,
        },
    },
    "cozy": {
        "up": {
            "cute": 2, "pet": 2, "baby": 2, "puppy": 2, "kitten": 2, "cat": 1, "dog": 1,
            "garden": 2, "farm": 2, "care": 2, "coloring": 2, "sweet": 2, "candy": 1,
            "bake": 2, "cook": 1, "princess": 1, "fashion": 1, "salon": 1, "dress": 1,
            "makeover": 1, "beauty": 1, "love": 1, "romantic": 1, "wedding": 1,
            "flower": 2, "cozy": 2, "adorable": 2, "kawaii": 2, "bunny": 2, "panda": 2,
        },
        "down": {
            "zombie": 2, "horror": 2, "scary": 2, "evil": 2, "dark": 1, "ghost": 1,
            "granny": 1, "haunted": 2, "war": 2, "gun": 2, "sniper": 2, "blood": 2,
            "kill": 2, "death": 2, "gore": 2, "shooter": 1, "combat": 1, "weapon": 1,
        },
    },
}

# ---------------------------------------------------------------------------
# SESSION LENGTH
#
# Minutes for ONE satisfying sitting — not "how long the game can be played",
# which for an idle game is forever. The question a player asks is "can I finish
# something meaningful in the time I have", so an idle/tycoon game scores LONG
# even though you can technically close it after 30 seconds.
#
# Base is 12 minutes: the middling arcade game. Evidence moves it.
# ---------------------------------------------------------------------------
SESSION_BASE = 12.0
SESSION_EVIDENCE = {
    # short — one round is over in a couple of minutes
    "hypercasual": -7, "tap": -6, "flappy": -7, "dash": -5, "quick": -5,
    "reflex": -5, "stack": -5, "helix": -5, "jump": -3, "run": -3, "slice": -4,
    "bubble": -2, "match": -2, "arcade": -1, "snake": -4, "pinball": -4,
    "breakout": -3, "arkanoid": -3, "ball": -2, "pop": -4, "spot": -4,
    "difference-games": -3, "memory": -3, "reaction": -6, "one": -2,
    # long — a sitting means a run, a build, or a story
    "tycoon": +14, "idle": +12, "clicker": +9, "strategy": +12, "adventure": +9,
    "rpg": +16, "quest": +9, "story": +9, "survival": +10, "craft": +10,
    "build": +8, "city": +9, "farm": +8, "manage": +10, "simulator": +9,
    "sandbox": +12, "world": +7, "empire": +12, "tower-defense": +8,
    "campaign": +10, "escape": +5, "mystery": +6, "detective": +6,
    "jigsaw": +5, "sudoku": +4, "crossword": +6, "chess": +8, "solitaire": +3,
    "mahjong": +3, "time-management": +6, "dungeon": +9,
}
SESSION_MIN = 2.0
SESSION_MAX = 45.0

# Words that carry no signal on any axis. Kept separate from the axis tables so
# that adding a stopword cannot silently change an axis definition.
NOISE = {
    "game", "games", "play", "online", "free", "html5", "unblocked", "the", "and",
    "for", "with", "new", "best", "top", "super", "ultimate", "version", "player",
    "io", "fun", "cool", "amazing", "great", "real", "3d", "2d", "hd", "full",
}


def load_json(path, what):
    if not os.path.exists(path):
        return None
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception as exc:
        log("  ! could not read %s (%s)" % (what, exc))
        return None


def load_games():
    """Merge every catalog source we have, so an attribute exists for any game
    the live site can serve — including the finalgames.json entries that are
    merged in at boot and are NOT in the Supabase export."""
    seen = {}

    data = load_json(GAMES, "games-export.json")
    if data:
        for g in (data if isinstance(data, list) else data.get("games", [])):
            slug = (g.get("slug") or "").strip().lower()
            if slug:
                seen[slug] = {
                    "slug": slug,
                    "title": g.get("title") or "",
                    "category": (g.get("category") or "").strip().lower(),
                    "tags": g.get("tags") or [],
                }

    data = load_json(FINAL, "finalgames.json")
    if data:
        for g in (data if isinstance(data, list) else data.get("games", [])):
            title = g.get("title") or ""
            # finalgames.json has no slug field — the server derives one from the
            # title. Mirror that here or these games get no attributes at all.
            slug = re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-")
            if not slug:
                continue
            if slug in seen:
                # Already have it from Supabase; just enrich the tags, since
                # finalgames carries real publisher tags for 93% of its rows.
                if g.get("tags"):
                    merged = set(seen[slug]["tags"]) | set(g["tags"])
                    seen[slug]["tags"] = sorted(merged)
                continue
            seen[slug] = {
                "slug": slug,
                "title": title,
                "category": (g.get("category") or "").strip().lower(),
                "tags": g.get("tags") or [],
            }

    if not seen:
        die("no catalog source found — run `npm run export-games` first.")
    return list(seen.values())


def evidence_tokens(game, moodmap):
    """The bag of words an axis is scored against.

    Three sources, deliberately deduplicated into a SET rather than a multiset:
    a title that says "Car Car Racing Car" should not get three times the pace
    evidence of one that says "Car Racing". Repetition in these titles is SEO
    keyword-stuffing, not emphasis.
    """
    toks = set()
    for t in (moodmap.get(game["slug"]) or []):
        toks.add(str(t).lower())
    for t in (game.get("tags") or []):
        toks.add(str(t).lower())
    cat = game.get("category") or ""
    if cat:
        toks.add(cat)
        # "mahjong solitaire" should also match "mahjong" and "solitaire"
        for part in TOKEN_RE.findall(cat):
            toks.add(part)
    for tok in TOKEN_RE.findall((game.get("title") or "").lower()):
        if tok in NOISE or len(tok) < 2 or tok.isdigit():
            continue
        toks.add(tok)
    return toks


def score_axis(tokens, table):
    """Signed evidence -> (value in 0..1, confidence in 0..1).

    The squash is a logistic on (up - down). Two properties matter:
      * it is monotonic, so more evidence never flips the direction, and
      * it saturates, so a title stuffed with eight synonyms of "fast" does not
        get to be twice as fast as one that says "fast" twice. Saturation is the
        point — beyond a few pieces of agreeing evidence, extra agreement tells
        us nothing new.

    Confidence is driven by the AMOUNT of evidence, not its direction, and is
    reduced when evidence conflicts. A game tagged both "chill" and "intense"
    (they exist — a relaxing game with an intense boss mode) should not be
    reported as confidently mid-range; it should be reported as unsure.
    """
    up = sum(w for t, w in table["up"].items() if t in tokens)
    down = sum(w for t, w in table["down"].items() if t in tokens)
    total = up + down
    if total == 0:
        return 0.5, 0.0
    net = up - down
    value = 1.0 / (1.0 + math.exp(-net / 2.2))
    # Evidence volume -> confidence, saturating at ~6 points of evidence.
    volume = min(1.0, total / 6.0)
    # Agreement: 1.0 when all evidence points one way, 0 when perfectly split.
    agreement = abs(net) / total
    confidence = round(volume * (0.35 + 0.65 * agreement), 3)
    return round(value, 3), confidence


def score_session(tokens):
    """Estimated minutes for one sitting, plus a confidence."""
    delta = 0.0
    hits = 0
    for t, w in SESSION_EVIDENCE.items():
        if t in tokens:
            delta += w
            hits += 1
    if hits == 0:
        return round(SESSION_BASE, 1), 0.0
    # Average rather than sum: a game tagged both "quick" and "tap" is short, not
    # twice-short. Summing let a title with four short-ish words underflow to the
    # 2-minute floor and claim more certainty than the words support.
    minutes = SESSION_BASE + (delta / math.sqrt(hits))
    minutes = max(SESSION_MIN, min(SESSION_MAX, minutes))
    return round(minutes, 1), round(min(1.0, hits / 3.0), 3)


def build(games, moodmap):
    out = {}
    dist = defaultdict(list)
    zero_conf = Counter()

    for g in games:
        tokens = evidence_tokens(g, moodmap)
        rec = {}
        confs = []
        for axis, table in AXES.items():
            v, c = score_axis(tokens, table)
            rec[axis] = v
            confs.append(c)
            dist[axis].append(v)
            if c == 0.0:
                zero_conf[axis] += 1
        mins, mc = score_session(tokens)
        rec["session_min"] = mins
        dist["session_min"].append(mins)
        if mc == 0.0:
            zero_conf["session_min"] += 1
        # One confidence for the whole record keeps the serving side simple: it
        # needs to know "how much should I trust this vector", not per-axis
        # bookkeeping it would only ever average anyway.
        rec["confidence"] = round((sum(confs) + mc) / (len(confs) + 1), 3)
        out[g["slug"]] = rec

    return out, dist, zero_conf


def report(attrs, dist, zero_conf, total):
    log("")
    log("  --- axis distributions (want SPREAD, not a spike at 0.5) ---")
    for axis in list(AXES.keys()) + ["session_min"]:
        vals = sorted(dist[axis])
        if not vals:
            continue
        n = len(vals)
        p = lambda q: vals[min(n - 1, int(q * n))]
        unknown = zero_conf[axis]
        log("  %-12s p10=%-6.2f p50=%-6.2f p90=%-6.2f   no-evidence: %d (%.1f%%)"
            % (axis, p(0.10), p(0.50), p(0.90), unknown, 100.0 * unknown / n))

    confs = sorted(r["confidence"] for r in attrs.values())
    n = len(confs)
    log("")
    log("  confidence: p10=%.2f p50=%.2f p90=%.2f"
        % (confs[int(0.1 * n)], confs[int(0.5 * n)], confs[int(0.9 * n)]))
    weak = sum(1 for c in confs if c < 0.15)
    log("  low-confidence games (<0.15): %d (%.1f%%) — served as 'no opinion'"
        % (weak, 100.0 * weak / n))

    # Spot check. An attribute table is very easy to get backwards, and the JSON
    # looks identical either way, so print real games at the extremes.
    log("")
    log("  --- spot check: most/least on each axis ---")
    for axis in AXES:
        ranked = sorted(attrs.items(), key=lambda kv: kv[1][axis])
        lo = [s for s, _ in ranked[:3]]
        hi = [s for s, _ in ranked[-3:]]
        log("  %-10s low: %-46s high: %s"
            % (axis, ", ".join(lo)[:46], ", ".join(hi)[:46]))
    ranked = sorted(attrs.items(), key=lambda kv: kv[1]["session_min"])
    log("  %-10s low: %-46s high: %s"
        % ("session", ", ".join(s for s, _ in ranked[:3])[:46],
           ", ".join(s for s, _ in ranked[-3:])[:46]))


def main():
    if "--help" in sys.argv or "-h" in sys.argv:
        print(__doc__)
        return
    log("build-game-attributes")
    log("")
    games = load_games()
    moodmap = load_json(TAGS, "mood-tags.json") or {}
    if not moodmap:
        log("  ! data/mood-tags.json missing — attributes will rest on title +")
        log("    category only, which is much weaker. Run `npm run mood-index`.")
    log("  %d games, %d with mood tags" % (len(games), len(moodmap)))

    attrs, dist, zero_conf = build(games, moodmap)
    report(attrs, dist, zero_conf, len(games))

    tmp = OUT + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(attrs, f, separators=(",", ":"), ensure_ascii=False)
    os.replace(tmp, OUT)          # atomic — a crash cannot leave a torn file
    size_mb = os.path.getsize(OUT) / (1024.0 * 1024.0)
    log("")
    log("  wrote %s (%.2f MB, %d games)"
        % (os.path.relpath(OUT, ROOT), size_mb, len(attrs)))
    log("  restart the server to load it.")


if __name__ == "__main__":
    main()
