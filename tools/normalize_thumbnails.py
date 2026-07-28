#!/usr/bin/env python3
"""
Find oversized remote thumbnails and self-host them at a sane size.

    npm run normalize-thumbs -- --dry-run
    npm run normalize-thumbs                    # fix everything over the threshold
    npm run normalize-thumbs -- --threshold 500 --limit 200

WHY
---
A 512x384 game tile should weigh 30-90KB. The catalog contained thumbnails of
8.5MB, 12.1MB and 22.8MB - real, correctly-licensed publisher art, just shipped
at full resolution. They are not "broken", so no audit that only checks for
failures ever flags them; they simply make the homepage cost tens of megabytes
and time out under concurrency.

This walks the live catalog, HEADs every remote thumbnail for its
Content-Length, and for anything over the threshold downloads it once, crops it
to exactly 512x384 (LANCZOS, quality 88) and writes it to public/thumbs/. The
source is unchanged: this is the SAME licensed publisher image, re-encoded. It
does not go looking for replacement art on the open web, which would trade a
size problem for a licensing one.

Wiring goes into data/catalog-overrides.json as patch rules tagged
"_source": "normalize_thumbnails", so re-runs replace only their own rules.

Requires: pip install requests Pillow
"""

from __future__ import annotations

import argparse
import json
import ssl
import sys
import urllib.parse
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))

try:
    import requests
except ImportError:
    sys.exit("Missing dep. Run: python -m pip install requests Pillow")

from scrape_thumbnails import validate, normalize      # one shared image pipeline

BASE = "http://localhost:8080"
UA = "Mozilla/5.0 (compatible; ZoFHub-thumbnail-bot/1.0)"
_SSL = ssl.create_default_context()
_SSL.check_hostname = False
_SSL.verify_mode = ssl.CERT_NONE


def upstream(game):
    """Real CDN URL for a game, or '' if already self-hosted.

    /api/games hands back thumbnails already routed through the same-origin
    image proxy (/thumb?u=<urlencoded>), so a naive startswith('http') test
    matches nothing. Unwrap u= first.
    """
    raw = str(game.get("thumbnail") or game.get("thumbnail_url") or "")
    if raw.startswith("/thumb?u="):
        return urllib.parse.unquote(raw.split("u=", 1)[1])
    return raw if raw.startswith("http") else ""


def load_catalog(session, base):
    games, off = [], 0
    while True:
        d = session.get(f"{base}/api/games?limit=1000&offset={off}", timeout=120).json()
        page = d.get("games", [])
        if not page:
            break
        games += page
        off += len(page)
        if off >= d.get("total", 0):
            break
    return games


def head_size(args):
    game, session = args
    url = upstream(game)
    if not url:
        return None
    try:
        r = session.head(url, timeout=20, allow_redirects=True,
                         headers={"User-Agent": UA})
        return (game["slug"], url, int(r.headers.get("Content-Length") or 0))
    except Exception:
        return None


def main():
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass

    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default=BASE)
    ap.add_argument("--overrides", default=str(ROOT / "data" / "catalog-overrides.json"))
    ap.add_argument("--img-dir", default=str(ROOT / "public" / "thumbs"))
    ap.add_argument("--url-prefix", default="/thumbs")
    ap.add_argument("--threshold", type=int, default=300,
                    help="KB above which a thumbnail is rewritten (default 300)")
    ap.add_argument("--limit", type=int, default=0, help="0 = no cap")
    ap.add_argument("--workers", type=int, default=24)
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    threshold = args.threshold * 1024
    session = requests.Session()

    print("Loading catalog...")
    games = load_catalog(session, args.base)
    remote = [g for g in games if upstream(g)]
    print(f"  {len(games)} games | {len(remote)} remote thumbnails")

    print(f"Measuring (threshold {args.threshold}KB)...")
    sizes = []
    with ThreadPoolExecutor(max_workers=args.workers) as ex:
        for i, r in enumerate(ex.map(head_size, ((g, session) for g in remote)), 1):
            if r and r[2] > 0:
                sizes.append(r)
            if i % 2000 == 0:
                print(f"  ...{i}/{len(remote)}", flush=True)

    total = sum(s[2] for s in sizes)
    big = sorted([s for s in sizes if s[2] > threshold], key=lambda x: -x[2])
    if args.limit:
        big = big[:args.limit]
    print(f"  measured {len(sizes)} | total {total/1048576:.1f}MB "
          f"| avg {total/max(len(sizes),1)/1024:.0f}KB")
    print(f"  over threshold: {len(big)} "
          f"({sum(s[2] for s in big)/1048576:.1f}MB)\n")

    if not big:
        print("Nothing oversized. Done.")
        return

    img_dir = Path(args.img_dir)
    rules, before, after, done = [], 0, 0, 0
    for slug, url, n in big:
        try:
            r = session.get(url, timeout=120, headers={"User-Agent": UA})
            raw = r.content
        except Exception as e:
            print(f"  {slug:<34} FETCH FAILED {type(e).__name__}")
            continue
        im, why = validate(raw)
        if im is None:
            print(f"  {slug:<34} rejected: {why}")
            continue
        data = normalize(im)
        if len(data) >= len(raw):
            print(f"  {slug:<34} already optimal, skipped")
            continue
        if not args.dry_run:
            img_dir.mkdir(parents=True, exist_ok=True)
            (img_dir / f"{slug}.jpg").write_bytes(data)
        before += len(raw)
        after += len(data)
        done += 1
        print(f"  {slug:<34} {len(raw)/1048576:6.2f}MB -> {len(data)/1024:5.1f}KB")
        rules.append({
            "_source": "normalize_thumbnails",
            "_note": f"Upstream thumbnail was {len(raw)/1048576:.2f}MB; self-hosted at 512x384.",
            "match": {"slug": slug},
            "set": {"thumbnail_url": f"{args.url_prefix.rstrip('/')}/{slug}.jpg"},
        })

    path = Path(args.overrides)
    doc = json.loads(path.read_text(encoding="utf-8"))
    existing = doc.get("patch", [])
    kept = [r for r in existing if r.get("_source") != "normalize_thumbnails"]
    doc["patch"] = kept + rules
    if not args.dry_run:
        path.write_text(json.dumps(doc, indent=2, ensure_ascii=False) + "\n",
                        encoding="utf-8")

    print(f"\n{'=' * 58}")
    print(f"{done} thumbnails normalised"
          f"{' (DRY RUN - nothing written)' if args.dry_run else ''}")
    if before:
        print(f"{before/1048576:.1f}MB -> {after/1024:.0f}KB "
              f"({100*(1-after/before):.2f}% smaller)")
    print(f"catalog-overrides.json: replaced {len(existing)-len(kept)} own rule(s) "
          f"with {len(rules)}")
    if not args.dry_run:
        print("Restart the server for the changes to take effect.")


if __name__ == "__main__":
    main()
