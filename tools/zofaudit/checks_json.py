"""Every JSON file parses, and the ones the server loads mean what it assumes.

Parsing is the easy half and still worth doing: this project reads a dozen JSON
files at boot with `JSON.parse(readFileSync(...))`, several are hand-edited, and
a stray comma in data/catalog-overrides.json takes the catalog overrides out of
service with one warning in a log nobody is reading.

The second half is the interesting one. A file can parse perfectly and still be
self-contradictory — a game listed as featured AND removed, the same slug patched
twice with different titles — and the server resolves those silently by whichever
rule happens to run last. Those are decidable here.
"""
from __future__ import annotations

import json
from collections import Counter

from .model import Finding
from .repo import ROOT, files_with_suffix, read, rel

CHECK = 'json'

# Files the server reads at boot or on refresh. A parse failure in one of these
# is a runtime degradation, not a lint warning, so they are separated out.
LOAD_BEARING = {
    'data/catalog-overrides.json',
    'data/mood-tags.json',
    'data/feed-ranking.json',
    'finalgames.json',
    'api/games.json',
    'package.json',
    'render.yaml',
}


def _load(path):
    try:
        return json.loads(read(path)), None
    except json.JSONDecodeError as e:
        return None, f'line {e.lineno} column {e.colno}: {e.msg}'
    except ValueError as e:
        return None, str(e)


def run(report) -> None:
    parsed = 0
    for path in files_with_suffix('.json'):
        name = rel(path)
        data, err = _load(path)
        if err:
            report.add(Finding(
                CHECK,
                'error' if name in LOAD_BEARING else 'warn',
                f'JSON does not parse: {name}',
                path=name, evidence=err,
                detail=('The server reads this file at boot.' if name in LOAD_BEARING else '')))
            continue
        parsed += 1
        if name == 'data/catalog-overrides.json':
            _check_overrides(report, data, name)
        elif name in ('finalgames.json', 'api/games.json'):
            _check_game_list(report, data, name)

    report.fact('json.files_parsed', parsed)


def _slug_of(entry):
    if isinstance(entry, str):
        return entry
    if isinstance(entry, dict):
        return entry.get('slug') or entry.get('id')
    return None


def _check_overrides(report, data, name) -> None:
    """catalog-overrides.json drives what the site shows. Its rules can disagree.

    The order server-side is: patch, then add, then remove, then featured. So a
    slug in both `remove` and `featured` produces a featured tile pointing at a
    game the catalog no longer contains — the homepage renders a hole, and
    nothing logs anything, because each rule did exactly what it was told.
    """
    if not isinstance(data, dict):
        report.add(Finding(CHECK, 'error', f'{name}: expected an object at the top level', path=name))
        return

    buckets = {k: data.get(k) or [] for k in ('patch', 'add', 'remove', 'featured')}
    for key, value in buckets.items():
        if not isinstance(value, list):
            report.add(Finding(CHECK, 'error', f'{name}: `{key}` should be a list', path=name))
            buckets[key] = []

    sets = {}
    for key, value in buckets.items():
        slugs = [s for s in (_slug_of(e) for e in value) if s]
        sets[key] = set(slugs)
        report.fact(f'overrides.{key}', len(value))
        for slug, n in Counter(slugs).items():
            if n > 1:
                report.add(Finding(
                    CHECK, 'warn', f'{name}: `{key}` lists {slug} {n} times',
                    path=name,
                    detail='Whichever rule is applied last silently wins; the others are dead.'))

    # Which rule wins depends on WHERE it runs in applyCatalogOverrides(), and
    # the three cases genuinely differ. `remove` and `patch` and the featured
    # flag are all decided inside the filter loop, in that order, so a removed
    # game is never patched and never featured. `add`, by contrast, is injected
    # AFTER the loop and is not re-filtered — so an added game survives a remove
    # rule that names it.
    #
    # Stating that backwards would be worse than not checking: a report that
    # confidently explains the wrong mechanism sends someone to fix the wrong
    # file. The direction of each of these was read off lib/catalog-overrides.mjs.
    for slug in sorted(sets['featured'] & sets['remove']):
        report.add(Finding(
            CHECK, 'warn', f'{name}: {slug} is featured and also removed',
            path=name,
            detail='The featured flag is set inside the filter loop, after the remove test,\n'
                   'so this game is never reached. The homepage carousel is one short.'))

    for slug in sorted(sets['patch'] & sets['remove']):
        report.add(Finding(
            CHECK, 'warn', f'{name}: {slug} is patched and also removed',
            path=name,
            detail='Patches are applied after the remove test in the same loop, so this\n'
                   'patch can never run. Either the patch or the removal is unintended.'))

    for slug in sorted(sets['add'] & sets['remove']):
        report.add(Finding(
            CHECK, 'info', f'{name}: {slug} is in `add` and also in `remove`',
            path=name,
            detail='`add` wins: injected entries are prepended after filtering and are not\n'
                   'themselves re-filtered. The catalog copy is dropped and the curated one\n'
                   'is served in its place. Deliberate for a hand-picked replacement;\n'
                   'accidental if the remove rule was generated by a sweep.'))

    for entry in buckets['add']:
        if not isinstance(entry, dict):
            continue
        missing = [f for f in ('slug', 'title') if not entry.get(f)]
        url = entry.get('embed_url') or entry.get('game_url') or entry.get('url')
        if not url:
            missing.append('embed_url')
        if missing:
            report.add(Finding(
                CHECK, 'error',
                f'{name}: `add` entry is missing {", ".join(missing)}',
                path=name, evidence=json.dumps(entry)[:160],
                detail='setCatalog() will inject it and it will render as a broken tile.'))


def _check_game_list(report, data, name) -> None:
    games = data if isinstance(data, list) else (data.get('games') if isinstance(data, dict) else None)
    if not isinstance(games, list):
        report.add(Finding(CHECK, 'warn', f'{name}: no game array found', path=name))
        return
    report.fact(f'{name}.entries', len(games))

    slugs = [g.get('slug') for g in games if isinstance(g, dict) and g.get('slug')]
    dupes = {s: n for s, n in Counter(slugs).items() if n > 1}
    if dupes:
        # Not an error: loadFinalGames() de-dupes by slug on the way in and says
        # so. Worth knowing, because a duplicate means one of the two entries'
        # metadata is silently discarded.
        top = ', '.join(sorted(dupes)[:5])
        report.add(Finding(
            CHECK, 'info',
            f'{name}: {len(dupes)} duplicate slug(s); the first copy wins',
            path=name, evidence=top + ('…' if len(dupes) > 5 else '')))

    missing_url = sum(
        1 for g in games
        if isinstance(g, dict) and not (g.get('embed_url') or g.get('game_url') or g.get('url')))
    if missing_url:
        report.add(Finding(
            CHECK, 'warn', f'{name}: {missing_url} entr(y/ies) have no playable URL', path=name,
            detail='normalizeRuntimeEntry() drops these, so they are dead weight in the file.'))
