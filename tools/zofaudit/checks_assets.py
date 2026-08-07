"""Files served out of public/ that nothing in the project references.

An unreferenced asset is not a bug, and this check never reports one as an
error. It is reported because the alternative is that nobody ever finds out: a
stylesheet for a page that was deleted, a hero image from two designs ago, a
script whose <script> tag went with a refactor. They are shipped, they are
cached, and they are indistinguishable from live files by looking at the
directory.

The reference search is deliberately generous — basename anywhere in any source
file counts — because a false "unused" that gets acted on deletes a live asset.
The bias is towards missing a dead file rather than naming a live one.
"""
from __future__ import annotations

import re

from .model import Finding
from .repo import ROOT, read, rel, source_files

CHECK = 'assets'

ASSET_EXTS = {'.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.ico', '.avif',
              '.css', '.js', '.mjs', '.woff', '.woff2', '.ttf', '.mp3', '.ogg', '.json'}

# Served by a route or by convention rather than by a reference in source.
CONVENTIONAL = {
    'public/robots.txt', 'public/sitemap.xml', 'public/favicon.ico',
    'public/manifest.json', 'public/sw.js', 'public/404.html', 'public/index.html',
}


def run(report) -> None:
    assets = [
        p for p in source_files()
        if rel(p).startswith('public/') and p.suffix.lower() in ASSET_EXTS
    ]
    if not assets:
        report.fact('assets.scanned', 0)
        return

    # One pass over every source file, building a single haystack. Searching each
    # asset against the whole tree separately is O(assets × bytes) and turns a
    # one-second check into a minute-long one on a repo this size.
    haystack_parts = []
    for p in source_files():
        if p.suffix.lower() in {'.js', '.mjs', '.cjs', '.html', '.css', '.json', '.md', '.yaml', '.yml'}:
            haystack_parts.append(read(p))
    haystack = '\n'.join(haystack_parts)

    unused = []
    for p in assets:
        name = rel(p)
        if name in CONVENTIONAL:
            continue
        base = p.name
        # A file always occurs once in its own text if it is a source file, and
        # package.json-style listings mention names too. Two or more mentions
        # anywhere means something points at it.
        hits = haystack.count(base)
        if hits <= (1 if p.suffix.lower() in {'.js', '.mjs', '.css'} else 0):
            unused.append((name, p.stat().st_size))

    report.fact('assets.scanned', len(assets))
    report.fact('assets.unreferenced', len(unused))

    for name, size in sorted(unused, key=lambda x: -x[1]):
        report.add(Finding(
            CHECK, 'info', f'nothing references {name}', path=name,
            evidence=f'{size:,} bytes',
            detail='Searched every .js/.mjs/.html/.css/.json/.md/.yaml file in the project\n'
                   'for this basename. Check before deleting — a name built at runtime\n'
                   'from a variable would not be found here.'))
