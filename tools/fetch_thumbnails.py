#!/usr/bin/env python3
"""
Recover and self-host thumbnails for the games listed in data/games-manifest.json.

    npm run fix-missing-thumbs            # resolve + download + wire up
    npm run fix-missing-thumbs -- --dry-run

WHY THIS EXISTS
---------------
13 catalog games fell back to the two-letter initials tile. The cause was NOT a
licensing gate: GameDistribution's stored URLs end in "-512x384.jpeg", which
returns 403 AccessDenied, while the identical asset at "-512x384.jpg" returns a
real JPEG. One character. Probing a list of known-good URL shapes per network —
and validating that the response is actually an image — is the whole fix, and it
survives the next time a distributor rotates their scheme.

TWO DESIGN DECISIONS WORTH KNOWING
----------------------------------
Matching is on game_id, never on title. "Vex 3", "Vex 9" and "Vex X3M" are the
same series by the same author; any fuzzy title match will cross them. The id
from the embed URL is the only safe key.

Thumbnails are downloaded and SELF-HOSTED, never hotlinked. Hotlinking produced
every failure mode observed here: 403s from GameDistribution, placeholder stubs
from GameMonetize, a WAF challenge from onlinegames.io, and — because
img.gamemonetize.com is an ad-network host — silent breakage under ad-blockers.
Self-hosting removes all four at once.

Output goes where the SERVE layer actually reads it:
  * images  -> public/thumbs/<slug>.jpg
  * wiring  -> data/catalog-overrides.json, as `patch` rules tagged
               "_source": "fetch_thumbnails" so re-runs replace only their own
               rules and never touch hand-written ones.

Optional licensed feeds (all free, all account-gated) take priority over URL
patterns when configured, because a feed URL is authoritative:
    GameDistribution  https://acc.gamedistribution.com/rss-builder   -> GD_FEED_URL
    Y8                https://www.y8.com/games_for_your_website      -> Y8_FEED_URL
GameMonetize's feed is public and needs no key.

Stdlib only. `requests` and `Pillow` are used if installed but are NOT required.
"""

import argparse
import json
import os
import ssl
import sys
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

GM_FEED = "https://rss.gamemonetize.com/rssfeed.php?format=json&num=All"
TIMEOUT = 30
MIN_BYTES = 1024           # anything smaller is a placeholder, not art
UA = "Mozilla/5.0 (compatible; ZoFHub-thumbfetch/1.0)"
THUMB_KEYS = ("thumb", "image", "thumbnail", "graphic_288x192",
              "screenshotPath", "cover")

_SSL = ssl.create_default_context()

# Real-image magic bytes. The 403 bodies are XML <Error> documents and the dead
# GameMonetize assets are sub-1KB stubs, so checking the signature AND the size
# rejects both without needing an image library.
MAGIC = {
    b"\xff\xd8\xff": "jpg",
    b"\x89PNG\r\n\x1a\n": "png",
    b"GIF87a": "gif",
    b"GIF89a": "gif",
}


def http_get(url, referer=None):
    """Return (status, body_bytes). Never raises."""
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    if referer:
        req.add_header("Referer", referer)
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT, context=_SSL) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        try:
            return e.code, e.read()
        except Exception:
            return e.code, b""
    except Exception:
        return 0, b""


def image_kind(buf):
    """Return 'jpg'/'png'/... if buf is a real image of usable size, else None."""
    if not buf or len(buf) < MIN_BYTES:
        return None
    for sig, kind in MAGIC.items():
        if buf.startswith(sig):
            return kind
    if buf[:4] == b"RIFF" and buf[8:12] == b"WEBP":
        return "webp"
    return None


def pick_thumb(d):
    """Pull the best available thumbnail field out of a feed item."""
    thumbs = d.get("thumbs")
    if isinstance(thumbs, dict):
        for k in THUMB_KEYS:
            if thumbs.get(k):
                return thumbs[k]
    for k in THUMB_KEYS:
        if d.get(k):
            return d[k]
    return None


def extract_id(url):
    """Pull the game hash/id out of an embed URL."""
    if not url:
        return None
    parts = [p for p in str(url).rstrip("/").split("/") if p and ":" not in p]
    return parts[-1] if parts else None


def fetch_feed(url, label):
    """Return {game_id_lower: thumb_url}. Handles JSON and RSS shapes."""
    print(f"  fetching {label} feed...")
    status, body = http_get(url)
    if status != 200 or not body:
        print(f"    failed (status {status})")
        return {}
    text = body.decode("utf-8", "replace").strip()

    index = {}
    try:
        if text.startswith(("[", "{")):
            data = json.loads(text)
            items = data if isinstance(data, list) else \
                data.get("items") or data.get("games") or []
            for it in items:
                thumb = pick_thumb(it)
                if not thumb:
                    continue
                # NOTE: GameMonetize's "id" is a numeric id, NOT the embed hash.
                # The hash only appears inside url/thumb, so extract_id matters.
                keys = [it.get("id"), it.get("guid"), it.get("gameId"),
                        it.get("slug"),
                        extract_id(it.get("url") or it.get("link") or
                                   it.get("iframeUrl") or ""),
                        extract_id(str(thumb).rsplit("/", 1)[0])]
                for k in filter(None, keys):
                    index.setdefault(str(k).lower(), thumb)
        else:
            root = ET.fromstring(text)
            for item in root.iter("item"):
                def tag(n):
                    el = item.find(n)
                    return el.text.strip() if el is not None and el.text else ""
                thumb = next((tag(k) for k in THUMB_KEYS if tag(k)), None)
                if not thumb:
                    continue
                for k in filter(None, [tag("id"), tag("guid"), tag("slug"),
                                       extract_id(tag("url") or tag("link"))]):
                    index.setdefault(str(k).lower(), thumb)
    except Exception as e:
        print(f"    parse error: {e}")
        return {}

    print(f"    {len(index)} entries indexed")
    return index


def normalize(buf, kind):
    """Re-encode to a sane size if Pillow is available; otherwise pass through.

    Deliberately preserves aspect ratio — the source art is a mix of 4:3
    (512x384) and 3:2 (288x192), and a blind resize to one fixed size stretches
    faces and text on half the catalog.
    """
    try:
        import io
        from PIL import Image
    except ImportError:
        return buf, kind
    try:
        im = Image.open(io.BytesIO(buf)).convert("RGB")
        im.thumbnail((512, 512), Image.LANCZOS)
        out = io.BytesIO()
        im.save(out, "JPEG", quality=88, optimize=True)
        return out.getvalue(), "jpg"
    except Exception:
        return buf, kind


def resolve(game, feeds, patterns):
    """Yield candidate thumbnail URLs for a game, best source first."""
    gid = game.get("game_id")
    if gid:
        hit = feeds.get(game["network"], {}).get(str(gid).lower())
        if hit:
            yield hit, "licensed feed"
    src = game.get("catalog_thumb_source")
    if src:
        yield src, "catalog value"
    if gid:
        for pat in patterns.get(game["network"], []):
            yield pat.replace("{id}", str(gid)), "url pattern"


def deep_scrape(game):
    """Bridge to tools/scrape_thumbnails.py. Returns (jpeg_bytes, layer_name).

    Imported LAZILY and inside a try, so the fast path above keeps working with
    nothing but the standard library. The scraper needs requests/bs4/Pillow, and
    optionally Playwright; if any is absent we say so and move on rather than
    failing the run.
    """
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    try:
        import requests as _rq
        from scrape_thumbnails import (HostPolicy, Telemetry, scrape_for_game)
    except SystemExit as e:
        print(f"    deep scrape unavailable: {e}")
        return None, None
    except Exception as e:
        print(f"    deep scrape unavailable: {type(e).__name__}: {e}")
        return None, None
    try:
        return scrape_for_game(game, _rq.Session(), HostPolicy(), Telemetry(),
                               lambda m: print(m))
    except Exception as e:
        print(f"    deep scrape error: {type(e).__name__}: {str(e)[:80]}")
        return None, None


def merge_overrides(path, rules, dry):
    """Idempotently replace this tool's own patch rules in catalog-overrides.json."""
    doc = json.loads(path.read_text(encoding="utf-8"))
    existing = doc.get("patch", [])
    kept = [r for r in existing if r.get("_source") != "fetch_thumbnails"]
    removed = len(existing) - len(kept)
    doc["patch"] = kept + rules
    if not dry:
        path.write_text(json.dumps(doc, indent=2, ensure_ascii=False) + "\n",
                        encoding="utf-8")
    return removed, len(rules)


def main():
    # Windows consoles default to cp1252, which mangles the em-dashes below.
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass

    ap = argparse.ArgumentParser()
    ap.add_argument("--manifest", default=str(ROOT / "data" / "games-manifest.json"))
    ap.add_argument("--overrides", default=str(ROOT / "data" / "catalog-overrides.json"))
    ap.add_argument("--img-dir", default=str(ROOT / "public" / "thumbs"))
    ap.add_argument("--url-prefix", default="/thumbs")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--deep", action="store_true",
                    help="fall back to tools/scrape_thumbnails.py for games the "
                         "feeds and URL patterns cannot resolve (slow; may launch "
                         "a headless browser)")
    args = ap.parse_args()

    manifest = json.loads(Path(args.manifest).read_text(encoding="utf-8"))
    games = manifest["games"]
    patterns = {k: v.get("thumb_url_patterns", [])
                for k, v in manifest.get("networks", {}).items()}

    print("Feeds")
    feeds = {}
    if os.environ.get("GD_FEED_URL"):
        feeds["gamedistribution"] = fetch_feed(os.environ["GD_FEED_URL"], "GameDistribution")
    else:
        print("  GD_FEED_URL unset — using URL patterns for GameDistribution")
    feeds["gamemonetize"] = fetch_feed(GM_FEED, "GameMonetize")
    if os.environ.get("Y8_FEED_URL"):
        feeds["y8"] = fetch_feed(os.environ["Y8_FEED_URL"], "Y8")
    else:
        print("  Y8_FEED_URL unset — skipping Y8")

    img_dir = Path(args.img_dir)
    rules, filled, gaps = [], [], []

    print("\nGames")
    for g in games:
        slug, status = g["slug"], g.get("status", "")
        print(f"  {slug}")

        if status == "blocked_no_license_available":
            gaps.append((slug, "licensing prohibits commercial display"))
            print("    skipped — no commercial license available, empty by design")
            continue
        if status == "not_in_catalog":
            gaps.append((slug, "no such catalog entry"))
            print("    skipped — not in the catalog")
            continue

        saved = None
        for url, how in resolve(g, feeds, patterns):
            st, body = http_get(url)
            kind = image_kind(body)
            if kind:
                body, kind = normalize(body, kind)
                dest = img_dir / f"{slug}.{kind}"
                if not args.dry_run:
                    dest.parent.mkdir(parents=True, exist_ok=True)
                    dest.write_bytes(body)
                saved = f"{args.url_prefix.rstrip('/')}/{dest.name}"
                print(f"    {how}: {len(body)}B -> {saved}")
                break
            why = f"status {st}" if st != 200 else f"not an image ({len(body)}B)"
            print(f"    {how} rejected — {why}")

        # ---- Fallback: deep scrape, ONLY when the fast path found nothing ----
        # Feed + URL-pattern logic above is untouched; this runs strictly on the
        # leftovers. Off unless --deep, because it is slow and may launch a browser.
        if not saved and args.deep:
            data, layer = deep_scrape(g)
            if data:
                dest = img_dir / f"{slug}.jpg"
                if not args.dry_run:
                    dest.parent.mkdir(parents=True, exist_ok=True)
                    dest.write_bytes(data)
                saved = f"{args.url_prefix.rstrip('/')}/{dest.name}"
                print(f"    deep scrape ({layer}): {len(data)}B -> {saved}")

        if not saved:
            gaps.append((slug, "no usable art from any source"))
            continue

        filled.append(slug)
        note = f"Self-hosted thumbnail recovered by tools/fetch_thumbnails.py ({g['title']})."
        # Only title/thumbnail_url/category are honoured in `set`; the loader
        # fans thumbnail_url out to both field names itself.
        rules.append({"_source": "fetch_thumbnails", "_note": note,
                      "match": {"slug": slug},
                      "set": {"thumbnail_url": saved}})
        # Also match on the distributor id, in case the live DB slug differs.
        if g.get("game_id"):
            rules.append({"_source": "fetch_thumbnails",
                          "_note": f"{note} Matched by distributor id.",
                          "match": {"urlIncludes": g["game_id"]},
                          "set": {"thumbnail_url": saved}})

    removed, added = merge_overrides(Path(args.overrides), rules, args.dry_run)

    print("\n" + "=" * 60)
    print(f"{len(filled)}/{len(games)} thumbnails self-hosted"
          f"{' (DRY RUN — nothing written)' if args.dry_run else ''}")
    print(f"catalog-overrides.json: replaced {removed} own rule(s) with {added}")

    flagged = [g["slug"] for g in games if g.get("risk_flags")]
    if flagged:
        print(f"\nReview risk_flags in {Path(args.manifest).name} before going live:")
        for s in flagged:
            print(f"  - {s}")

    if gaps:
        print("\nStill empty (the initials fallback tile covers these):")
        for slug, why in gaps:
            print(f"  {slug:24s} {why}")
    print("\nRestart the server for catalog-overrides.json changes to take effect.")


if __name__ == "__main__":
    main()
