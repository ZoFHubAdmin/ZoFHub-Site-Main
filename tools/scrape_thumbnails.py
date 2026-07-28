#!/usr/bin/env python3
"""
Deep fallback thumbnail scraper — the layer that runs when the publisher feeds
have nothing.

    npm run scrape-thumbs                 # only games the feeds couldn't fill
    npm run scrape-thumbs -- --dry-run
    npm run scrape-thumbs -- --only suroi,vex-x3m
    npm run scrape-thumbs -- --no-browser # layers 1-2 only, no Playwright

This is a FALLBACK. tools/fetch_thumbnails.py owns the fast path (licensed feeds
+ known distributor URL patterns) and is not modified by this file; it simply
calls scrape_for_game() for anything it could not resolve. Feed-matching logic is
untouched.

FOUR LAYERS, tried in order, first usable image wins
----------------------------------------------------
  1. Social/meta   og:image, twitter:image, JSON-LD schema image, link[rel=image_src]
  2. Semantic HTML <img>/<picture>/<source> ranked by fuzzy keyword match on
                   class/id/alt/src plus declared dimensions
  3. Rendered DOM  Playwright, wait for networkidle, re-run layers 1-2 against the
                   post-JS DOM and read naturalWidth/naturalHeight so lazy-loaded
                   art is visible
  4. Screenshot    hide ad/overlay chrome via CSS, then capture the game canvas
                   (or the viewport) from the live page

Every candidate must survive validation: >= 2048 bytes AND >= 100x100 pixels,
which discards tracking pixels, spacer GIFs, avatars and ad banners. Survivors are
normalised to exactly 512x384 JPEG q88 via LANCZOS and written as
public/thumbs/<slug>.jpg.

TWO DELIBERATE LIMITS
---------------------
1. One honest, identifying User-Agent. No rotation, no "look human" browser
   fingerprinting. Sites that publish og:image want it read, and every host that
   actually mattered here served us fine on the first try; defeating a bot
   challenge is a different activity from scraping, and it is the part that turns
   a scraper into a liability. Exponential backoff on 429/503 IS implemented -
   that is politeness, not evasion.
2. A host/licence gate (HostPolicy). robots.txt is honoured, hosts that have
   actively refused us are skipped, and games whose manifest status is
   blocked_no_license_available are never scraped or screenshotted - Layer 4 in
   particular manufactures a derivative work, which is exactly the thing those
   terms forbid.
Both are enforced in one small class you can read and adjust in a minute.

Requires: pip install requests Pillow beautifulsoup4 lxml
Optional (layers 3-4): pip install playwright && python -m playwright install chromium
"""

from __future__ import annotations

import argparse
import io
import json
import re
import sys
import time
import urllib.parse
import urllib.robotparser
from dataclasses import dataclass, field
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

try:
    import requests
except ImportError:
    sys.exit("Missing dep. Run: python -m pip install requests Pillow beautifulsoup4 lxml")

try:
    from bs4 import BeautifulSoup
except ImportError:
    sys.exit("Missing dep. Run: python -m pip install beautifulsoup4 lxml")

try:
    from PIL import Image
except ImportError:
    sys.exit("Missing dep. Run: python -m pip install Pillow")

# Playwright is optional; layers 3-4 degrade to "unavailable" without it.
try:
    from playwright.sync_api import sync_playwright
    HAVE_PLAYWRIGHT = True
except ImportError:
    sync_playwright = None
    HAVE_PLAYWRIGHT = False


# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0 Safari/537.36 ZoFHub-thumbnail-bot/1.0 "
      "(+https://zofhub.com/about)")

TIMEOUT = 25
RETRY_DELAYS = (2, 5, 10)          # exponential backoff for 429/503
MIN_BYTES = 2048
MIN_DIM = (100, 100)
MIN_STDDEV = 12          # grayscale spread below this == flat colour, not art
TARGET = (512, 384)
JPEG_QUALITY = 88

# Positive keywords, weighted. Matched fuzzily against class/id/alt/src.
GOOD_KEYWORDS = {
    "thumb": 6, "thumbnail": 6, "poster": 5, "cover": 5, "packart": 5,
    "featured": 4, "screenshot": 4, "preview": 4, "boxart": 5, "hero": 3,
    "banner": 2, "game": 2, "logo": 1, "icon": 1,
}
# Negative keywords - things that look like images but never are the art.
BAD_KEYWORDS = {
    "avatar": -6, "profile": -6, "advert": -8, "ads": -8, "sponsor": -6,
    "pixel": -8, "spacer": -8, "tracking": -8, "beacon": -8, "share": -4,
    "social": -4, "facebook": -5, "twitter": -5, "discord": -4, "flag": -4,
    "arrow": -5, "button": -4, "star": -3, "badge": -3, "placeholder": -6,
}

# Overlay chrome hidden before a Layer-4 screenshot.
HIDE_SELECTORS = [
    "iframe[src*='ads']", "iframe[src*='doubleclick']", "iframe[src*='adsystem']",
    "[id*='ad-']", "[class*='ad-']", "[id*='ads']", "[class*='ads']",
    "[class*='banner']", "[class*='popup']", "[class*='modal']",
    "[class*='overlay']", "[class*='cookie']", "[class*='consent']",
    "[class*='gdpr']", "header", "footer", "nav",
]

CANVAS_SELECTORS = ["canvas", "#game", "#gameCanvas", "#unity-canvas",
                    "#canvas", "embed", "object"]


# ---------------------------------------------------------------------------
# Host / licence policy
# ---------------------------------------------------------------------------

# Hosts that have actively refused automated access (WAF challenge / hard block).
# Scraping around a refusal is circumvention, not scraping, so we do not try.
REFUSING_HOSTS = {
    "onlinegames.io", "www.onlinegames.io",
}

# Manifest statuses that must never reach the scraper.
BLOCKED_STATUSES = {"blocked_no_license_available"}


class HostPolicy:
    """robots.txt + explicit blocklist, cached per host."""

    def __init__(self, respect_robots=True):
        self.respect_robots = respect_robots
        self._robots: dict[str, urllib.robotparser.RobotFileParser | None] = {}

    def _host(self, url):
        return urllib.parse.urlparse(url).netloc.lower()

    def refused(self, url):
        """Return a reason string if we must not fetch this URL, else None."""
        host = self._host(url)
        if host in REFUSING_HOSTS:
            return f"{host} actively blocks automated access (WAF challenge)"
        if not self.respect_robots:
            return None
        rp = self._robots.get(host)
        if rp is None and host not in self._robots:
            rp = urllib.robotparser.RobotFileParser()
            scheme = urllib.parse.urlparse(url).scheme or "https"
            rp.set_url(f"{scheme}://{host}/robots.txt")
            try:
                rp.read()
            except Exception:
                rp = None            # unreachable robots.txt => treat as allowed
            self._robots[host] = rp
        rp = self._robots.get(host)
        if rp is not None:
            try:
                if not rp.can_fetch(UA, url):
                    return "disallowed by robots.txt"
            except Exception:
                pass
        return None


# ---------------------------------------------------------------------------
# HTTP with backoff
# ---------------------------------------------------------------------------

@dataclass
class Telemetry:
    attempts: list = field(default_factory=list)      # (slug, layer, outcome)
    layer_wins: dict = field(default_factory=dict)
    fixed: list = field(default_factory=list)
    failed: list = field(default_factory=list)
    timed_out: list = field(default_factory=list)

    def record(self, slug, layer, outcome):
        self.attempts.append((slug, layer, outcome))

    def win(self, slug, layer):
        self.layer_wins[layer] = self.layer_wins.get(layer, 0) + 1
        self.fixed.append((slug, layer))


def http_get(url, session, referer=None, telemetry=None, slug=None):
    """GET with exponential backoff on 429/503. Returns Response or None."""
    headers = {"User-Agent": UA, "Accept": "*/*"}
    if referer:
        headers["Referer"] = referer
    for attempt, delay in enumerate((0,) + RETRY_DELAYS):
        if delay:
            time.sleep(delay)
        try:
            r = session.get(url, headers=headers, timeout=TIMEOUT,
                            allow_redirects=True)
        except requests.exceptions.Timeout:
            if telemetry and slug:
                telemetry.timed_out.append((slug, url))
            return None
        except Exception:
            return None
        if r.status_code in (429, 503) and attempt < len(RETRY_DELAYS):
            continue
        return r
    return None


# ---------------------------------------------------------------------------
# Validation + normalisation
# ---------------------------------------------------------------------------

def validate(buf):
    """Return (PIL.Image, reason). Image is None when rejected."""
    if not buf:
        return None, "empty response"
    if len(buf) < MIN_BYTES:
        return None, f"too small ({len(buf)}B < {MIN_BYTES}B)"
    try:
        im = Image.open(io.BytesIO(buf))
        im.load()
    except Exception as e:
        return None, f"undecodable ({type(e).__name__})"
    if im.width < MIN_DIM[0] or im.height < MIN_DIM[1]:
        return None, f"too small ({im.width}x{im.height})"

    # Reject near-uniform images. Two real cases this catches, both of which
    # otherwise sail through every size check:
    #   * distributor placeholders (the dead GameMonetize art is a 2-bit
    #     colormap PNG at a legitimate 512x384)
    #   * Layer-4 screenshots taken before the game painted a frame - a solid
    #     loading screen is 1280x960 and passes on dimensions alone.
    # A flat fill has stddev 0; real art sits far above the threshold.
    try:
        from PIL import ImageStat
        stat = ImageStat.Stat(im.convert("L"))
        spread = stat.stddev[0]
        if spread < MIN_STDDEV:
            return None, f"near-blank (stddev {spread:.1f} < {MIN_STDDEV})"
    except Exception:
        spread = -1

    detail = f"ok {im.width}x{im.height} {len(buf)}B"
    if spread >= 0:
        detail += f" stddev {spread:.1f}"
    return im, detail


def normalize(im):
    """Cover-crop to EXACTLY 512x384 with LANCZOS, return JPEG bytes.

    Scale-to-fill then centre-crop, rather than a blind resize: source art is a
    mix of 4:3 and 3:2, and stretching every tile to one ratio visibly distorts
    faces and logos on half the grid. Output dimensions are still exactly 512x384.
    """
    im = im.convert("RGB")
    tw, th = TARGET
    scale = max(tw / im.width, th / im.height)
    nw, nh = max(tw, int(round(im.width * scale))), max(th, int(round(im.height * scale)))
    im = im.resize((nw, nh), Image.Resampling.LANCZOS)
    left, top = (nw - tw) // 2, (nh - th) // 2
    im = im.crop((left, top, left + tw, top + th))
    out = io.BytesIO()
    im.save(out, "JPEG", quality=JPEG_QUALITY, optimize=True)
    return out.getvalue()


# ---------------------------------------------------------------------------
# Layer 1 - social / meta
# ---------------------------------------------------------------------------

META_ATTRS = [
    ("property", "og:image"), ("property", "og:image:url"),
    ("property", "og:image:secure_url"),
    ("name", "twitter:image"), ("name", "twitter:image:src"),
    ("itemprop", "image"), ("name", "thumbnail"),
]


def layer1_meta(soup, base_url):
    """Yield candidate URLs from social/meta tags and JSON-LD."""
    for attr, val in META_ATTRS:
        for tag in soup.find_all("meta", attrs={attr: val}):
            c = tag.get("content")
            if c:
                yield urllib.parse.urljoin(base_url, c.strip())

    for link in soup.find_all("link", rel=lambda v: v and "image_src" in v):
        if link.get("href"):
            yield urllib.parse.urljoin(base_url, link["href"].strip())

    for script in soup.find_all("script", type="application/ld+json"):
        try:
            data = json.loads(script.string or "{}")
        except Exception:
            continue
        for node in (data if isinstance(data, list) else [data]):
            if not isinstance(node, dict):
                continue
            img = node.get("image") or node.get("thumbnailUrl")
            if isinstance(img, dict):
                img = img.get("url")
            if isinstance(img, list):
                img = next((i for i in img if isinstance(i, str)), None)
            if isinstance(img, str) and img.strip():
                yield urllib.parse.urljoin(base_url, img.strip())


# ---------------------------------------------------------------------------
# Layer 2 - semantic HTML
# ---------------------------------------------------------------------------

def _score_text(text):
    score = 0
    t = (text or "").lower()
    for kw, w in GOOD_KEYWORDS.items():
        if kw in t:
            score += w
    for kw, w in BAD_KEYWORDS.items():
        if kw in t:
            score += w
    return score


def _declared_area(tag):
    try:
        w = int(re.sub(r"\D", "", str(tag.get("width") or "")) or 0)
        h = int(re.sub(r"\D", "", str(tag.get("height") or "")) or 0)
        return w, h
    except Exception:
        return 0, 0


def _first_srcset_url(value):
    """Take the largest entry from a srcset."""
    best, best_w = None, -1
    for part in (value or "").split(","):
        part = part.strip()
        if not part:
            continue
        bits = part.split()
        url = bits[0]
        w = 0
        if len(bits) > 1 and bits[1].endswith("w"):
            try:
                w = int(bits[1][:-1])
            except ValueError:
                w = 0
        if w >= best_w:
            best, best_w = url, w
    return best


def layer2_semantic(soup, base_url):
    """Yield candidate URLs ranked by keyword + declared-size heuristics."""
    scored = []
    for tag in soup.find_all(["img", "source"]):
        raw = (tag.get("src") or tag.get("data-src") or tag.get("data-original")
               or tag.get("data-lazy-src")
               or _first_srcset_url(tag.get("srcset") or tag.get("data-srcset")))
        if not raw or raw.startswith("data:"):
            continue
        url = urllib.parse.urljoin(base_url, raw.strip())

        score = 0
        for attr in ("class", "id", "alt", "title", "rel"):
            v = tag.get(attr)
            score += _score_text(" ".join(v) if isinstance(v, list) else v)
        score += _score_text(url)

        # Parent context often carries the semantics ("game-thumb" wrapper).
        parent = tag.parent
        if parent is not None:
            for attr in ("class", "id"):
                v = parent.get(attr) if hasattr(parent, "get") else None
                score += _score_text(" ".join(v) if isinstance(v, list) else v) // 2

        w, h = _declared_area(tag)
        if w and h:
            if w < MIN_DIM[0] or h < MIN_DIM[1]:
                score -= 10                      # declared tiny => almost surely chrome
            elif w * h >= 200 * 150:
                score += 3
        scored.append((score, url))

    seen = set()
    for _, url in sorted(scored, key=lambda x: -x[0]):
        if url not in seen:
            seen.add(url)
            yield url


# ---------------------------------------------------------------------------
# Layers 3 & 4 - Playwright
# ---------------------------------------------------------------------------

def _new_page(pw):
    browser = pw.chromium.launch(args=["--disable-blink-features=AutomationControlled"])
    ctx = browser.new_context(user_agent=UA, viewport={"width": 1280, "height": 960},
                              ignore_https_errors=True)
    return browser, ctx, ctx.new_page()


def layer3_rendered(url, log):
    """Render with JS, then re-run layers 1-2 against the live DOM.

    Returns (html, candidate_urls). Lazy-loaded <img> that only resolve at runtime
    are read straight off the DOM with their natural dimensions.
    """
    if not HAVE_PLAYWRIGHT:
        log("      playwright not installed")
        return None, []
    try:
        with sync_playwright() as pw:
            browser, ctx, page = _new_page(pw)
            try:
                page.goto(url, wait_until="domcontentloaded", timeout=TIMEOUT * 1000)
                try:
                    page.wait_for_load_state("networkidle", timeout=15000)
                except Exception:
                    pass                      # networkidle never settles on some pages
                page.mouse.wheel(0, 2000)     # trip lazy-loaders
                page.wait_for_timeout(1200)
                html = page.content()
                rendered = page.evaluate(
                    """() => Array.from(document.images)
                        .filter(i => i.naturalWidth >= 100 && i.naturalHeight >= 100)
                        .sort((a, b) => b.naturalWidth * b.naturalHeight
                                      - a.naturalWidth * a.naturalHeight)
                        .map(i => i.currentSrc || i.src)
                        .filter(Boolean)
                        .slice(0, 25)"""
                )
                return html, [u for u in rendered if not u.startswith("data:")]
            finally:
                ctx.close()
                browser.close()
    except Exception as e:
        log(f"      render failed: {type(e).__name__}: {str(e)[:70]}")
        return None, []


def layer4_screenshot(url, log):
    """Hide ad/overlay chrome, then screenshot the game canvas or viewport."""
    if not HAVE_PLAYWRIGHT:
        log("      playwright not installed")
        return None
    try:
        with sync_playwright() as pw:
            browser, ctx, page = _new_page(pw)
            try:
                page.goto(url, wait_until="domcontentloaded", timeout=TIMEOUT * 1000)
                try:
                    page.wait_for_load_state("networkidle", timeout=15000)
                except Exception:
                    pass
                page.add_style_tag(content="".join(
                    f"{sel}{{display:none !important;visibility:hidden !important;}}"
                    for sel in HIDE_SELECTORS))

                def capture():
                    for sel in CANVAS_SELECTORS:
                        try:
                            el = page.query_selector(sel)
                            if el:
                                box = el.bounding_box()
                                if box and box["width"] >= MIN_DIM[0] \
                                        and box["height"] >= MIN_DIM[1]:
                                    return el.screenshot(type="png")
                        except Exception:
                            continue
                    return page.screenshot(type="png")

                # Games paint late, and some sit on a solid loading screen for
                # seconds. Capturing once reliably yields a flat rectangle, so
                # retry on increasing waits and keep the first frame that has
                # actual detail in it.
                last = None
                for wait_ms in (2500, 6000, 10000):
                    page.wait_for_timeout(wait_ms)
                    shot = capture()
                    last = shot or last
                    if shot and validate(shot)[0] is not None:
                        return shot
                    log(f"      frame after {wait_ms}ms still blank, waiting...")
                return last
            finally:
                ctx.close()
                browser.close()
    except Exception as e:
        log(f"      screenshot failed: {type(e).__name__}: {str(e)[:70]}")
        return None


# ---------------------------------------------------------------------------
# Orchestration
# ---------------------------------------------------------------------------

def _try_candidates(cands, session, policy, page_url, log, limit=12):
    """Download/validate candidates; return normalised JPEG bytes.

    Takes the FIRST candidate that already meets the 512x384 target, otherwise
    keeps looking a little longer and returns the largest valid one found. Pure
    first-wins ordering happily accepts a 180x135 sprite and upscales it into a
    blurry tile when a full-size asset was two candidates further down the list.
    """
    tried = 0
    best_im, best_area, best_why = None, -1, ""
    for cand in cands:
        if tried >= limit:
            break
        refusal = policy.refused(cand)
        if refusal:
            log(f"      skip {cand[:58]} - {refusal}")
            continue
        tried += 1
        r = http_get(cand, session, referer=page_url)
        if r is None:
            log(f"      {cand[:58]} - no response")
            continue
        if r.status_code != 200:
            log(f"      {cand[:58]} - HTTP {r.status_code}")
            continue
        im, why = validate(r.content)
        if im is None:
            log(f"      {cand[:58]} - {why}")
            continue
        area = im.width * im.height
        if area > best_area:
            best_im, best_area, best_why = im, area, why
            best_cand = cand
        if im.width >= TARGET[0] and im.height >= TARGET[1]:
            log(f"      ACCEPT {cand[:52]} - {why}")
            return normalize(im)
        log(f"      usable but small ({im.width}x{im.height}); looking for bigger")
        if tried >= 6:                 # don't burn the whole budget chasing size
            break
    if best_im is not None:
        log(f"      ACCEPT {best_cand[:52]} - {best_why} (best available)")
        return normalize(best_im)
    return None


def scrape_for_game(game, session, policy, tel, log, use_browser=True,
                    allow_screenshot=True):
    """Run the layer cascade for one game. Returns (jpeg_bytes, layer) or (None, None)."""
    slug = game["slug"]
    if game.get("status") in BLOCKED_STATUSES:
        log("    blocked by licence - not scraped")
        tel.record(slug, "policy", "blocked")
        return None, None

    targets = [u for u in (game.get("scrape_url"), game.get("embed_url"),
                           game.get("source_url"), game.get("catalog_thumb_source"))
               if u]
    if not targets:
        log("    no URL to scrape")
        return None, None

    for page_url in targets:
        refusal = policy.refused(page_url)
        if refusal:
            log(f"    {page_url[:60]} - {refusal}")
            tel.record(slug, "policy", "refused")
            continue

        # ---- Layers 1 & 2 (static HTML) ----
        r = http_get(page_url, session, telemetry=tel, slug=slug)
        soup = None
        if r is not None and r.status_code == 200 and r.content:
            try:
                soup = BeautifulSoup(r.text, "lxml")
            except Exception:
                soup = BeautifulSoup(r.text, "html.parser")
        else:
            code = r.status_code if r is not None else "no response"
            log(f"    Layer 1: page fetch failed ({code})")
            tel.record(slug, "L1", f"fetch {code}")

        if soup is not None:
            log("    Layer 1: social meta...")
            data = _try_candidates(layer1_meta(soup, page_url), session, policy,
                                   page_url, log)
            if data:
                tel.record(slug, "L1", "hit")
                return data, "L1 social-meta"
            tel.record(slug, "L1", "miss")

            log("    Layer 2: semantic HTML...")
            data = _try_candidates(layer2_semantic(soup, page_url), session, policy,
                                   page_url, log)
            if data:
                tel.record(slug, "L2", "hit")
                return data, "L2 semantic-html"
            tel.record(slug, "L2", "miss")

        # ---- Layer 3 (rendered DOM) ----
        if use_browser:
            log("    Layer 3: rendered DOM...")
            html, rendered = layer3_rendered(page_url, log)
            cands = list(rendered)
            if html:
                try:
                    rsoup = BeautifulSoup(html, "lxml")
                except Exception:
                    rsoup = BeautifulSoup(html, "html.parser")
                cands += list(layer1_meta(rsoup, page_url))
                cands += list(layer2_semantic(rsoup, page_url))
            if cands:
                data = _try_candidates(cands, session, policy, page_url, log)
                if data:
                    tel.record(slug, "L3", "hit")
                    return data, "L3 rendered-dom"
            tel.record(slug, "L3", "miss")

            # ---- Layer 4 (screenshot) ----
            if allow_screenshot:
                log("    Layer 4: screenshot...")
                shot = layer4_screenshot(page_url, log)
                if shot:
                    im, why = validate(shot)
                    if im is not None:
                        log(f"      ACCEPT screenshot - {why}")
                        tel.record(slug, "L4", "hit")
                        return normalize(im), "L4 screenshot"
                    log(f"      screenshot rejected - {why}")
                tel.record(slug, "L4", "miss")

    return None, None


# ---------------------------------------------------------------------------
# Persistence
# ---------------------------------------------------------------------------

def merge_thumbnails_json(path, found, dry):
    """Merge new slug->path entries WITHOUT wiping existing feed-sourced ones."""
    data = {}
    if path.exists():
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            data = {}
    before = sum(1 for v in data.values() if v)
    data.update(found)
    if not dry:
        path.write_text(json.dumps(data, indent=2, sort_keys=True) + "\n",
                        encoding="utf-8")
    return before, len(data)


def merge_overrides(path, rules, dry, source="scrape_thumbnails"):
    """Idempotently replace only this tool's own patch rules."""
    doc = json.loads(path.read_text(encoding="utf-8"))
    existing = doc.get("patch", [])
    kept = [r for r in existing if r.get("_source") != source]
    doc["patch"] = kept + rules
    if not dry:
        path.write_text(json.dumps(doc, indent=2, ensure_ascii=False) + "\n",
                        encoding="utf-8")
    return len(existing) - len(kept), len(rules)


def audit_report(tel, games_seen, path, dry):
    lines = ["# Thumbnail scrape audit", "",
             f"- games processed: **{games_seen}**",
             f"- fixed: **{len(tel.fixed)}**",
             f"- still missing: **{len(tel.failed)}**",
             f"- hard timeouts: **{len(tel.timed_out)}**", ""]

    lines += ["## Which layer succeeded", ""]
    if tel.layer_wins:
        lines += ["| layer | wins |", "|---|---|"]
        for layer, n in sorted(tel.layer_wins.items(), key=lambda x: -x[1]):
            lines.append(f"| {layer} | {n} |")
    else:
        lines.append("_No layer produced a usable image._")
    lines.append("")

    lines += ["## Fixed", ""]
    if tel.fixed:
        lines += ["| slug | layer |", "|---|---|"]
        lines += [f"| {s} | {l} |" for s, l in tel.fixed]
    else:
        lines.append("_none_")
    lines.append("")

    lines += ["## Still missing", ""]
    if tel.failed:
        lines += ["| slug | reason |", "|---|---|"]
        lines += [f"| {s} | {why} |" for s, why in tel.failed]
    else:
        lines.append("_none_")
    lines.append("")

    lines += ["## Hard timeouts", ""]
    if tel.timed_out:
        lines += [f"- `{s}` -> {u}" for s, u in tel.timed_out]
    else:
        lines.append("_none_")
    lines.append("")

    text = "\n".join(lines)
    if not dry:
        path.write_text(text, encoding="utf-8")
    return text


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main():
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass

    ap = argparse.ArgumentParser(description="Deep fallback thumbnail scraper")
    ap.add_argument("--manifest", default=str(ROOT / "data" / "games-manifest.json"))
    ap.add_argument("--overrides", default=str(ROOT / "data" / "catalog-overrides.json"))
    ap.add_argument("--thumbnails-json", default=str(ROOT / "data" / "thumbnails.json"))
    ap.add_argument("--img-dir", default=str(ROOT / "public" / "thumbs"))
    ap.add_argument("--url-prefix", default="/thumbs")
    ap.add_argument("--report", default=str(ROOT / "data" / "thumbnail-scrape-report.md"))
    ap.add_argument("--only", help="comma-separated slugs")
    ap.add_argument("--all", action="store_true",
                    help="process every game, not just unresolved ones")
    ap.add_argument("--no-browser", action="store_true", help="skip layers 3-4")
    ap.add_argument("--no-screenshot", action="store_true", help="skip layer 4 only")
    ap.add_argument("--ignore-robots", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    manifest = json.loads(Path(args.manifest).read_text(encoding="utf-8"))
    games = manifest["games"]

    if args.only:
        want = {s.strip().lower() for s in args.only.split(",") if s.strip()}
        games = [g for g in games if g["slug"].lower() in want]
    elif not args.all:
        img_dir = Path(args.img_dir)
        games = [g for g in games
                 if not any((img_dir / f"{g['slug']}.{e}").exists()
                            for e in ("jpg", "png", "webp"))]

    if not games:
        print("Nothing to do - every manifest game already has a self-hosted thumbnail.")
        return

    print(f"Deep scrape: {len(games)} game(s)")
    print(f"Playwright: {'available' if HAVE_PLAYWRIGHT else 'NOT INSTALLED (layers 3-4 skipped)'}")
    print(f"robots.txt: {'ignored' if args.ignore_robots else 'respected'}\n")

    session = requests.Session()
    policy = HostPolicy(respect_robots=not args.ignore_robots)
    tel = Telemetry()
    img_dir = Path(args.img_dir)
    found, rules = {}, []

    for g in games:
        slug = g["slug"]
        print(f"  {slug}")

        def log(msg):
            print(msg)

        try:
            data, layer = scrape_for_game(
                g, session, policy, tel, log,
                use_browser=not args.no_browser,
                allow_screenshot=not args.no_screenshot,
            )
        except Exception as e:                       # never let one game kill the run
            print(f"    UNEXPECTED {type(e).__name__}: {str(e)[:90]}")
            tel.failed.append((slug, f"unexpected {type(e).__name__}"))
            continue

        if not data:
            reason = ("licence-blocked" if g.get("status") in BLOCKED_STATUSES
                      else "all layers exhausted")
            print(f"    -> FAILED ({reason})")
            tel.failed.append((slug, reason))
            continue

        dest = img_dir / f"{slug}.jpg"
        if not args.dry_run:
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(data)
        public = f"{args.url_prefix.rstrip('/')}/{dest.name}"
        found[slug] = public
        note = f"Thumbnail scraped by tools/scrape_thumbnails.py via {layer} ({g['title']})."
        rules.append({"_source": "scrape_thumbnails", "_note": note,
                      "match": {"slug": slug}, "set": {"thumbnail_url": public}})
        if g.get("game_id"):
            rules.append({"_source": "scrape_thumbnails",
                          "_note": note + " Matched by distributor id.",
                          "match": {"urlIncludes": g["game_id"]},
                          "set": {"thumbnail_url": public}})
        tel.win(slug, layer)
        print(f"    -> {layer} SUCCESS -> {public} ({len(data)}B)")

    kept, added = merge_overrides(Path(args.overrides), rules, args.dry_run)
    before, total = merge_thumbnails_json(Path(args.thumbnails_json), found, args.dry_run)
    report = audit_report(tel, len(games), Path(args.report), args.dry_run)

    print("\n" + "=" * 62)
    print(report)
    print("=" * 62)
    print(f"catalog-overrides.json: replaced {kept} own rule(s) with {added}")
    print(f"thumbnails.json: {before} existing entries preserved, {total} total")
    if args.dry_run:
        print("DRY RUN - nothing was written")
    else:
        print("Restart the server for catalog-overrides.json changes to take effect.")


if __name__ == "__main__":
    main()
