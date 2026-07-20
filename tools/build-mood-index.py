#!/usr/bin/env python3
"""
tools/build-mood-index.py — OFFLINE mood/genre tagger for the ZoFHub catalog.

WHY THIS IS PYTHON (and why it runs OFFLINE, never on the live server):
  The live site is Node and answers /api/vibe in well under a second. THIS is the
  opposite kind of job — a one-off, run-on-your-own-machine data pass over the
  whole ~16k-game catalog. That's exactly what Python is good at: offline data
  processing. It reads the exported catalog, derives mood/genre tags for every
  game from its CATEGORY + TITLE, and writes data/mood-tags.json. The Node server
  loads that file at boot and its Vibe Finder scores games by these tags — so a
  racing game titled "Nitro X" (whose title contains no mood words at all) still
  turns up for "energetic" / "competitive", and an arcade game titled
  "Zombie Sniper" turns up for "scary".

HOW TO RUN (do this whenever the catalog has grown a lot — it's not automatic):
  1) npm run export-games              # refresh data/games-export.json from Supabase
  2) python tools/build-mood-index.py  # writes data/mood-tags.json
  3) restart the server                # it loads data/mood-tags.json at boot

Standard library only — no pip installs.
"""
import json
import os
import re
import sys
from collections import Counter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "data", "games-export.json")
OUT = os.path.join(ROOT, "data", "mood-tags.json")

# Mirror the server's category canonicalisation so our category lookups line up
# with the categories the live catalog actually uses (server.js: canonCategory).
CATEGORY_ALIASES = {
    "puzzles": "puzzle", "puzzle-and-logic": "puzzle-logic",
    "sports-and-racing": "sports-racing", "io": "io-games", "card-games": "card",
    "hidden-object-games": "puzzle", "hidden-object": "puzzle", "car": "racing",
    "cars": "racing", "traffic": "racing", "bike": "racing", "board": "strategy",
    "sandbox": "simulator", "training": "arcade", "music": "arcade",
    "horror": "adventure", "observation": "puzzle", "tripeaks-and-golf": "card",
    "pyramid": "card", "other": "arcade",
}

# category slug -> mood/genre tags. The vocabulary deliberately mixes GENRE words
# (puzzle, race, shoot) with FEELING words (chill, competitive, cute) because the
# Vibe Finder treats the user's own typed words as search keywords — so tagging a
# game "competitive" makes it match someone who types "I feel competitive".
CATEGORY_TAGS = {
    "puzzle": ["puzzle", "brain", "logic", "think", "calm", "zen", "chill", "relax", "sort", "block", "match"],
    "puzzle-games": ["puzzle", "brain", "logic", "think", "calm", "zen", "chill", "relax"],
    "puzzle-logic": ["puzzle", "brain", "logic", "think", "calm", "zen", "chill", "relax"],
    "brain-games": ["brain", "puzzle", "logic", "think", "memory", "smart", "focus"],
    "word-games": ["word", "puzzle", "brain", "think", "spelling", "calm"],
    "daily-puzzles": ["puzzle", "brain", "logic", "daily", "calm", "chill"],
    "mahjong-solitaire": ["mahjong", "tile", "puzzle", "calm", "zen", "chill", "relax", "brain"],
    "mahjong-connect": ["mahjong", "tile", "connect", "puzzle", "calm", "zen", "relax"],
    "mahjong-games": ["mahjong", "tile", "puzzle", "calm", "zen", "relax"],
    "3d-mahjong": ["mahjong", "tile", "puzzle", "calm", "zen", "relax"],
    "match-3-games": ["match", "puzzle", "bubble", "candy", "calm", "chill", "relax"],
    "connect-3": ["match", "connect", "puzzle", "calm", "chill"],
    "bubble-shooter": ["bubble", "shoot", "pop", "match", "calm", "chill", "relax"],
    "collapse-games": ["match", "block", "puzzle", "calm", "chill"],
    "bejeweled": ["match", "gem", "puzzle", "calm", "chill"],
    "zuma-games": ["zuma", "ball", "shoot", "arcade", "chill"],
    "klondike": ["solitaire", "card", "calm", "chill", "relax"],
    "freecell": ["solitaire", "card", "calm", "chill", "relax"],
    "spider": ["solitaire", "card", "calm", "chill", "relax"],
    "solitaire-games": ["solitaire", "card", "calm", "chill", "relax"],
    "card": ["card", "solitaire", "strategy", "calm", "chill"],
    "sudoku": ["sudoku", "number", "brain", "logic", "calm", "focus"],
    "crosswords": ["crossword", "word", "brain", "calm", "focus"],
    "math-games": ["math", "number", "brain", "logic", "learn", "smart"],
    "memory": ["memory", "brain", "match", "calm", "focus"],
    "difference-games": ["spot", "observation", "calm", "relax", "focus"],
    "tile-games": ["tile", "match", "puzzle", "calm", "chill"],
    "2048-and-merge": ["2048", "merge", "number", "brain", "puzzle", "chill"],
    "1010-block": ["block", "puzzle", "brain", "calm", "chill"],
    "tetris": ["tetris", "block", "retro", "classic", "arcade"],
    "maze-games": ["maze", "puzzle", "escape", "brain"],

    "racing": ["race", "racing", "car", "drift", "speed", "fast", "drive", "competitive", "energetic"],
    "sports-racing": ["sport", "race", "racing", "ball", "competitive", "energetic", "active"],
    "sports": ["sport", "soccer", "football", "basketball", "ball", "competitive", "energetic", "active"],
    "shooting": ["shoot", "shooter", "gun", "sniper", "war", "strike", "fps", "action", "competitive", "intense"],
    "shooting-and-war": ["shoot", "war", "gun", "army", "action", "intense", "competitive"],
    "action": ["action", "fight", "battle", "smash", "punch", "intense", "competitive", "energetic"],
    "adventure": ["adventure", "quest", "explore", "world", "survival", "hero", "story", "epic"],
    "platform": ["platform", "jump", "run", "adventure", "arcade"],
    "arcade": ["arcade", "fun", "classic", "quick", "casual"],
    "hypercasual": ["run", "jump", "dash", "tap", "quick", "casual", "fun", "fast", "energetic"],
    "clicker": ["idle", "clicker", "merge", "tycoon", "relax", "chill", "casual"],
    "multiplayer": ["multiplayer", "arena", "battle", "competitive", "versus"],
    "io-games": ["io", "multiplayer", "arena", "competitive", "versus"],
    "2-player": ["versus", "competitive", "fun", "party"],
    "girls": ["dress", "makeover", "fashion", "cute", "girly", "princess", "beauty", "salon", "love", "romantic", "creative"],
    "skill": ["skill", "precision", "arcade", "challenge"],
    "strategy": ["strategy", "think", "brain", "tower", "plan", "smart"],
    "simulator": ["simulator", "build", "tycoon", "sandbox", "create", "relax", "chill"],
    "retro": ["retro", "classic", "pixel", "arcade", "nostalgic"],
    "funny": ["funny", "silly", "fun", "crazy", "goofy", "laugh"],
    "time-management": ["cook", "serve", "manage", "busy", "fun"],
}

# words found INSIDE a title -> extra tags (adds specifics the category misses,
# e.g. category:arcade + title "Zombie Sniper" -> scary + shooter).
TITLE_KEYWORDS = {
    "zombie": ["zombie", "scary", "horror", "shoot"], "horror": ["horror", "scary", "dark"],
    "scary": ["scary", "horror"], "ghost": ["ghost", "scary", "horror"], "granny": ["granny", "scary", "horror"],
    "evil": ["evil", "scary", "dark"], "haunted": ["haunted", "scary", "horror"],
    "drift": ["drift", "car", "racing", "speed"], "car": ["car", "racing", "drive"], "truck": ["truck", "racing", "drive"],
    "moto": ["moto", "bike", "racing"], "bike": ["bike", "racing"], "parking": ["parking", "car", "racing"],
    "sniper": ["sniper", "shoot", "shooter", "gun"], "gun": ["gun", "shoot", "shooter"], "shoot": ["shoot", "shooter"],
    "war": ["war", "shoot", "army", "action"], "fps": ["fps", "shoot", "shooter"], "strike": ["strike", "shoot", "action"],
    "soccer": ["soccer", "football", "sport", "ball"], "football": ["football", "sport", "ball"],
    "basketball": ["basketball", "sport", "ball"], "golf": ["golf", "sport"], "pool": ["pool", "sport"],
    "dress": ["dress", "fashion", "girly", "cute"], "makeover": ["makeover", "fashion", "girly", "cute"],
    "princess": ["princess", "girly", "cute"], "salon": ["salon", "fashion", "girly"],
    "wedding": ["wedding", "love", "romantic", "girly"], "baby": ["baby", "cute", "care"],
    "cat": ["cat", "cute", "pet"], "dog": ["dog", "cute", "pet"], "puppy": ["puppy", "cute", "pet"], "kitten": ["kitten", "cute", "pet"],
    "zen": ["zen", "calm", "chill", "relax"], "bubble": ["bubble", "pop", "calm"], "candy": ["candy", "match", "sweet", "chill"],
    "jigsaw": ["jigsaw", "puzzle", "calm"], "coloring": ["coloring", "color", "calm", "creative", "relax"],
    "color": ["color", "calm", "creative"], "garden": ["garden", "relax", "calm", "farm"],
    "sudoku": ["sudoku", "brain", "logic", "calm"], "chess": ["chess", "brain", "strategy"], "mahjong": ["mahjong", "tile", "calm", "zen"],
    "run": ["run", "fast", "energetic"], "dash": ["dash", "fast", "energetic"], "jump": ["jump", "arcade"],
    "merge": ["merge", "idle", "relax"], "idle": ["idle", "clicker", "relax"], "tycoon": ["tycoon", "idle", "build"],
    "dragon": ["dragon", "adventure", "fantasy"], "ninja": ["ninja", "action", "adventure"], "escape": ["escape", "puzzle", "adventure"],
    "stickman": ["stickman", "action", "fight"], "ragdoll": ["ragdoll", "funny", "action"], "boxing": ["boxing", "fight", "sport"],
    "fight": ["fight", "action", "battle"], "smash": ["smash", "action", "fight"], "punch": ["punch", "fight", "action"],
    "farm": ["farm", "relax", "build", "calm"], "cook": ["cook", "serve", "fun"], "build": ["build", "create", "calm"],
    "retro": ["retro", "classic", "nostalgic"], "pixel": ["pixel", "retro", "classic"], "tetris": ["tetris", "retro", "block"],
    "party": ["party", "fun", "multiplayer"], "draw": ["draw", "creative", "fun"], "love": ["love", "romantic", "cute"],
}

_slug_re = re.compile(r"[^a-z0-9]+")
_token_re = re.compile(r"[a-z0-9]+")


def canon(cat):
    c = _slug_re.sub("-", str(cat or "arcade").lower().replace("&", " and ")).strip("-") or "arcade"
    return CATEGORY_ALIASES.get(c, c)


def tags_for(game):
    tags = set()
    cat = canon(game.get("category"))
    tags.add(cat)                                  # the game's own category is always a tag
    tags.update(CATEGORY_TAGS.get(cat, ["arcade", "fun", "casual"]))
    for tok in _token_re.findall(str(game.get("title") or "").lower()):
        if tok in TITLE_KEYWORDS:
            tags.update(TITLE_KEYWORDS[tok])
    return sorted(tags)


def main():
    if not os.path.exists(SRC):
        print(f"ERROR: {SRC} not found. Run:  npm run export-games", file=sys.stderr)
        sys.exit(1)
    with open(SRC, encoding="utf-8") as f:
        raw = json.load(f)
    games = raw if isinstance(raw, list) else raw.get("games", [])
    index = {}
    tag_counts = Counter()
    for g in games:
        slug = g.get("slug")
        if not slug:
            continue
        t = tags_for(g)
        index[slug] = t
        tag_counts.update(t)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(index, f, separators=(",", ":"), ensure_ascii=False)
    total_tags = sum(len(v) for v in index.values())
    print(f"\nOK - tagged {len(index):,} games  ->  {OUT}")
    print(f"  avg tags/game: {total_tags / max(len(index), 1):.1f}")
    print("  top mood/genre tags:")
    for tag, n in tag_counts.most_common(24):
        print(f"    {tag:<14} {n:,}")


if __name__ == "__main__":
    main()
