"""Patterns that cost time, or correctness, once there is enough data.

Only decidable ones. "This loop looks expensive" is an opinion and would make the
report longer without making it more useful; each check here corresponds to a
specific failure that has a specific fix.

The first of them found a live defect, which is why it is first:
loadPlayStats() paged through game_stats with .range() and NO .order(). A
LIMIT/OFFSET with no ORDER BY has no defined row order in Postgres, and
flushPlayStats() writes that table every sixty seconds — so a slow boot could
load the wrong lifetime play counts, and the only symptom would be a handful of
games quietly ranking below where they had earned.
"""
from __future__ import annotations

import re

from .model import Finding
from .repo import ROOT, read, rel, strip_js_comments, mask_js_strings, line_of, files_with_suffix

CHECK = 'perf'

_FROM = re.compile(r"\.from\(\s*'([a-z_][a-z0-9_]*)'\s*\)")
_ROUTE_HANDLER = re.compile(r"\bapp\.(get|post|put|patch|delete|all)\(\s*'([^']+)'")
_SYNC_FS = re.compile(r'\b(readFileSync|writeFileSync|statSync|readdirSync|existsSync|appendFileSync)\s*\(')


# `let q = supabase` — the receiver sits between the `=` and the `.from(`, so the
# trailing [\w.$]* is what makes this match at all.
_ASSIGNED = re.compile(r'\b(?:let|const|var)\s+(\w+)\s*=\s*(?:await\s+)?[\w.$]*$')


def _chain(src: str, at: int, stop: int) -> str:
    """The query chain beginning at `at`, ending at its own statement's semicolon."""
    depth, i = 0, at
    while i < stop:
        c = src[i]
        if c in '([{':
            depth += 1
        elif c in ')]}':
            depth -= 1
        elif c == ';' and depth <= 0:
            return src[at:i]
        i += 1
    return src[at:stop]


def _full_query(src: str, at: int, stop: int) -> str:
    """The chain, plus the later statements that keep building it.

    supabase-js query builders are values, so a query is often assembled across
    several statements:

        let q = supabase.from('games').select('id, slug');
        q = SELF_HOST ? q.ilike('game_url', '%y8.com%') : q.is('thumbnail_url', null);
        const { data } = await q.order('id', …).range(from, from + 999);

    Reading only the first statement sees a select with no filter, no order and
    no bound, and reports all three — while the finished query has all three. So
    when the chain is ASSIGNED rather than executed, the statements that go on to
    mention that variable are folded in before anything is judged.
    """
    chain = _chain(src, at, stop)
    line_start = src.rfind('\n', 0, at) + 1
    m = _ASSIGNED.search(src[line_start:at])
    if not m:
        return chain
    name = m.group(1)
    # Only forward, only within this chain's own region, and only statements that
    # actually name the variable.
    tail = src[at + len(chain):stop]
    uses = [s for s in tail.split(';') if re.search(rf'\b{re.escape(name)}\b', s)]
    return chain + ' ' + ' '.join(uses)


def _balanced_block(src: str, open_paren: int) -> tuple[int, int]:
    depth, i = 0, open_paren
    while i < len(src):
        if src[i] == '(':
            depth += 1
        elif src[i] == ')':
            depth -= 1
            if depth == 0:
                return open_paren, i
        i += 1
    return open_paren, len(src)


def run(report) -> None:
    # tools/ is included. Those are maintenance CLIs rather than request paths,
    # but several of them page the entire games table and then decide what to
    # delete or rewrite from what they read — so a skipped row there is a wrong
    # decision made on incomplete data, which is worse than a slow request.
    runtime = [p for p in files_with_suffix('.js', '.mjs')
               if rel(p) == 'server.js' or rel(p).startswith(('lib/', 'api/', 'tools/', 'scripts/'))]

    paged = unbounded = 0

    for path in runtime:
        name = rel(path)
        src = strip_js_comments(read(path))

        starts = [m.start() for m in _FROM.finditer(src)]
        for idx, at in enumerate(starts):
            stop = starts[idx + 1] if idx + 1 < len(starts) else len(src)
            chain = _full_query(src, at, stop)
            line = line_of(src, at)

            if '.range(' in chain:
                paged += 1
                if '.order(' not in chain:
                    report.add(Finding(
                        CHECK, 'error',
                        'paginated read with .range() and no .order()',
                        path=name, line=line,
                        evidence=re.sub(r'\s+', ' ', chain)[:140],
                        detail='LIMIT/OFFSET without ORDER BY has no defined row order. Rows can be\n'
                               'returned twice or skipped entirely as soon as anything writes to the\n'
                               'table during the walk. Order by a unique column and page on it.'))
                else:
                    # Ordered OFFSET is deterministic on a table nothing is
                    # writing to, and only drifts when the set changes DURING the
                    # walk. In a request path or a cron that is a certainty —
                    # link-check flips is_working while the catalog refresh pages
                    # through it. In a CLI someone runs by hand it is unlikely,
                    # and the remedy is to run it again. Same defect, different
                    # odds, so different volume: a warning that fires forever on
                    # code nobody intends to change is how a report gets ignored.
                    is_cli = name.startswith(('tools/', 'scripts/'))
                    report.add(Finding(
                        CHECK, 'info' if is_cli else 'warn',
                        'OFFSET pagination — unstable if the set changes mid-walk',
                        path=name, line=line,
                        evidence=re.sub(r'\s+', ' ', chain)[:140],
                        detail='.range(from, from+N) re-counts from the start of the result set on\n'
                               'every page, so a row leaving the set shifts the window and one row is\n'
                               'skipped. It also makes Postgres discard every row before the offset.\n'
                               'Keyset — .order(key).lt(key, lastSeen).limit(N) — fixes both.'))

            # A read with no bound and no aggregate walks the whole table into
            # memory. Three things make a chain not that, and all three have to
            # be excluded or the check reports its own blind spots:
            #   • an aggregate or single-row form, which is bounded by definition
            #   • a limit or a page
            #   • ANY filter — the first version listed only .eq and .in, and duly
            #     reported a DELETE narrowed by two .lt() calls as an unbounded read
            # A write chain is not a read at all; a .select() after .delete()
            # returns the affected rows, which the filters already bounded.
            filtered = any(f'.{op}(' in chain for op in
                           ('eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'like', 'ilike',
                            'is', 'in', 'contains', 'match', 'or', 'filter'))
            writing = any(f'.{op}(' in chain for op in ('insert', 'update', 'upsert', 'delete'))
            if ('.select(' in chain and not filtered and not writing
                    and '.limit(' not in chain and '.range(' not in chain
                    and '.single(' not in chain and '.maybeSingle(' not in chain
                    and 'head: true' not in chain and "count: 'exact'" not in chain):
                unbounded += 1
                report.add(Finding(
                    CHECK, 'warn', 'unbounded select — no limit, no filter',
                    path=name, line=line,
                    evidence=re.sub(r'\s+', ' ', chain)[:140],
                    detail='This reads the whole table into memory and grows with it.'))

    report.fact('perf.paginated_reads', paged)
    report.fact('perf.unbounded_selects', unbounded)

    # ── Synchronous filesystem work inside a request handler ────────────────
    # Node serves every request on one thread. A readFileSync in a handler stops
    # every other in-flight request for the duration, and the cost is invisible
    # until concurrency arrives.
    src = strip_js_comments(read(ROOT / 'server.js'))
    # Balance parentheses on a view with string CONTENTS blanked. Offsets are
    # identical, so matches map back to the real source — but a '(' inside a
    # message or a regex is no longer counted, which is what made the handler
    # boundary run past its own route and attribute one readFileSync to two.
    structural = mask_js_strings(read(ROOT / 'server.js'))
    for m in _ROUTE_HANDLER.finditer(src):
        open_paren = structural.index('(', m.start())
        a, b = _balanced_block(structural, open_paren)
        body = structural[a:b]
        for fs in _SYNC_FS.finditer(body):
            report.add(Finding(
                CHECK, 'warn',
                f'{fs.group(1)}() inside the {m.group(2)} handler',
                path='server.js', line=line_of(src, a + fs.start()),
                detail='Blocks the event loop for every concurrent request, not just this one.\n'
                       'Read it once at boot, or use the promise API.'))
