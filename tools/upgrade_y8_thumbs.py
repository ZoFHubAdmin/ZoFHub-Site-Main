#!/usr/bin/env python3
"""
Re-fetch the Y8 thumbnails that were self-hosted at thumbnail size.

    npm run upgrade-y8-thumbs -- --dry-run
    npm run upgrade-y8-thumbs
    npm run upgrade-y8-thumbs -- --limit 200

WHY
---
A large block of the catalog is self-hosted from Y8 at **180x135**, which is
then displayed in a 512x384 tile - about an eighth of the pixels the slot wants,
so those tiles render visibly soft. This is not breakage (the audit scores them
"OK"), which is exactly why no failure-driven tool ever flagged them.

Y8 serves the same art much larger. Its cloudimage URLs encode the size in the
path (`w380h285_retina_webp-<hash>`), and `retina` means the delivered file is
760x570 - the 247 already-good tiles in the catalog came from that URL shape.
The original Y8 URLs are no longer in the database (they were rewritten to
/thumbs/ paths when the images were self-hosted), so the size cannot be
reconstructed from stored data - the current image has to be re-resolved from
the game's own Y8 page, the same way tools/fetch-y8-thumbs.mjs self-heals.

Downloads go through the shared validate/normalize pipeline and land at exactly
512x384, so the result is sharper AND smaller than an unprocessed 760x570 file.
The file path is unchanged (public/thumbs/<slug>.webp -> .jpg is written as a
sibling and the override repoints), so nothing else needs rewiring.

DELIBERATELY SLOW. Y8 is a single upstream and this walks thousands of pages;
hammering it gets the whole run 403'd, at which point every result is garbage.
Concurrency is capped low and each worker sleeps between pages.

Requires: pip install requests Pillow
"""

from __future__ import annotations

import argparse
import re
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from threading import Lock

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))

try:
    import requests
    from PIL import Image
except ImportError:
    sys.exit("Missing dep. Run: python -m pip install requests Pillow")

from scrape_thumbnails import validate, normalize

BASE = "http://localhost:8080"
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0 Safari/537.36")

# Same two patterns tools/fetch-y8-thumbs.mjs uses, in the same order.
RE_META = re.compile(
    r"""<meta[^>]+(?:property|name)=["'](?:og:image|twitter:image)["'][^>]+content=["']([^"']+)["']""",
    re.I)
RE_CDN = re.compile(
    r"""https?://cdn\d*\.y8\.com/cloudimage/[^"'\s)\\]+\.(?:webp|jpe?g|png|gif)""", re.I)
RE_EMBED = re.compile(r"y8\.com/embed/([^/?#]+)", re.I)

_print_lock = Lock()


def log(*a):
    with _print_lock:
        print(*a, flush=True)


def page_url(embed):
    m = RE_EMBED.search(str(embed or ""))
    return f"https://www.y8.com/games/{m.group(1)}" if m else None


def extract(html):
    m = RE_META.search(html)
    if m:
        return m.group(1)
    m = RE_CDN.search(html)
    return m.group(0) if m else None


def local_width(path: Path):
    try:
        im = Image.open(path)
        im.load()
        return im.size[0]
    except Exception:
        return None


def load_catalog(session):
    games, off = [], 0
    while True:
        d = session.get(f"{BASE}/api/games?limit=1000&offset={off}", timeout=180).json()
        if not d.get("games"):
            break
        games += d["games"]
        off += len(d["games"])
        if off >= d.get("total", 0):
            break
    return games


def main():
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default=BASE)
    ap.add_argument("--img-dir", default=str(ROOT / "public" / "thumbs"))
    ap.add_argument("--min-width", type=int, default=400,
                    help="upgrade anything narrower than this (default 400)")
    ap.add_argument("--limit", type=int, default=0, help="0 = all")
    ap.add_argument("--workers", type=int, default=3,
                    help="keep this small; Y8 403s the whole run if pushed")
    ap.add_argument("--delay", type=float, default=0.4, help="seconds between pages per worker")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    session = requests.Session()
    session.headers.update({"User-Agent": UA})

    log("Loading catalog...")
    games = load_catalog(session)
    img_dir = Path(args.img_dir)

    todo = []
    for g in games:
        t = str(g.get("thumbnail") or "")
        if not t.startswith("/thumbs/"):
            continue
        if "y8.com" not in str(g.get("embed_url") or g.get("url") or ""):
            continue
        f = ROOT / "public" / t.lstrip("/")
        w = local_width(f)
        if w is not None and w < args.min_width:
            todo.append((g, t, f, w))

    if args.limit:
        todo = todo[:args.limit]
    log(f"  {len(games)} games | {len(todo)} self-hosted Y8 thumbnails below "
        f"{args.min_width}px wide\n")
    if not todo:
        log("Nothing to upgrade.")
        return

    stats = {"upgraded": 0, "no_page": 0, "no_image": 0, "not_better": 0, "failed": 0}
    lock = Lock()

    def work(item):
        g, turl, path, oldw = item
        slug = g["slug"]
        pu = page_url(g.get("embed_url") or g.get("url"))
        if not pu:
            with lock: stats["no_page"] += 1
            return
        try:
            r = session.get(pu, timeout=30)
            time.sleep(args.delay)
            if r.status_code != 200:
                with lock: stats["failed"] += 1
                log(f"  {slug:<34} page HTTP {r.status_code}")
                return
            src = extract(r.text)
        except Exception as e:
            with lock: stats["failed"] += 1
            log(f"  {slug:<34} page error {type(e).__name__}")
            return
        if not src:
            with lock: stats["no_image"] += 1
            return
        try:
            ir = session.get(src, timeout=40)
            if ir.status_code != 200:
                with lock: stats["failed"] += 1
                return
            im, why = validate(ir.content)
            if im is None:
                with lock: stats["no_image"] += 1
                return
            if im.size[0] <= oldw:
                with lock: stats["not_better"] += 1
                return
            if not args.dry_run:
                img_dir.mkdir(parents=True, exist_ok=True)
                # Re-encode in the format the existing filename claims, so the
                # replacement doesn't leave express.static serving image/webp
                # over a JPEG body.
                fmt = "WEBP" if path.suffix.lower() == ".webp" else "JPEG"
                path.write_bytes(normalize(im, fmt))
            with lock: stats["upgraded"] += 1
            log(f"  {slug:<34} {oldw}px -> {im.size[0]}x{im.size[1]} upgraded")
        except Exception as e:
            with lock: stats["failed"] += 1
            log(f"  {slug:<34} download error {type(e).__name__}")

    with ThreadPoolExecutor(max_workers=args.workers) as ex:
        for i, _ in enumerate(ex.map(work, todo), 1):
            if i % 250 == 0:
                log(f"  ...{i}/{len(todo)}  ({stats['upgraded']} upgraded so far)")

    log("\n" + "=" * 58)
    for k, v in stats.items():
        log(f"  {k:<12} {v}")
    if not args.dry_run and stats["upgraded"]:
        log("\nFiles replaced in place - the /thumbs/ paths are unchanged, so no "
            "override edits are needed. Commit public/thumbs/ and restart.")


if __name__ == "__main__":
    main()
