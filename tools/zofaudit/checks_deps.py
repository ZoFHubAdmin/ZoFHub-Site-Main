"""The module import graph: broken targets, cycles, and modules nothing imports.

There is no bundler here, so nothing resolves imports until the moment Node or a
browser does. `import { x } from './utils.js'` with the file renamed to utils.mjs
is a clean parse, a clean lint, and a 404 in the browser console at runtime.
tools/check-js.mjs proves every module PARSES; this proves every module it names
is actually there.

The graph is also the dependency map: --json emits it whole, so "what imports
lib/supabase.mjs" stops being a grep.
"""
from __future__ import annotations

import re
from pathlib import Path

from .model import Finding
from .repo import ROOT, read, rel, strip_js_comments, line_of, files_with_suffix

CHECK = 'deps'

_STATIC_IMPORT = re.compile(
    r"""(?:^|\s)(?:import|export)\s+(?:[\w*{},\s]+\s+from\s+)?['"]([^'"]+)['"]""", re.M)
_DYNAMIC_IMPORT = re.compile(r"""import\(\s*['"]([^'"]+)['"]\s*\)""")

# Entry points: nothing imports these, by design.
ROOTS = {'server.js'}
ROOT_DIRS = ('test/', 'tools/', 'scripts/', 'public/js/', 'admin-ui/')


def _resolve(importer: Path, spec: str) -> Path | None:
    """Resolve a relative specifier to a file, or None if it does not exist."""
    if not spec.startswith('.'):
        return None                       # bare specifier: a package, not ours
    # Browser modules carry a cache-busting query — `./ad-slots.js?v=20260806`.
    # The server serves the file and ignores the query; only a resolver that
    # forgets this thinks the file is missing, and it reported eight of them.
    spec = spec.split('?', 1)[0].split('#', 1)[0]
    target = (importer.parent / spec).resolve()
    if target.is_file():
        return target
    # Extensionless is legal in Node's CJS resolution but not in ESM; this repo
    # is ESM throughout, so a missing extension is itself the bug. Try the
    # obvious completions only to report a precise message.
    for ext in ('.js', '.mjs', '.cjs', '/index.js', '/index.mjs'):
        cand = Path(str(target) + ext)
        if cand.is_file():
            return cand
    return None


def build_graph() -> tuple[dict[str, set[str]], dict[str, set[str]], list[Finding]]:
    """(all edges, STATIC edges only, findings).

    The two graphs differ in exactly one way and the difference matters. A
    dynamic `await import('./x.mjs')` inside a function body does not create an
    initialisation cycle: by the time it runs, both modules are fully evaluated.
    lib/cron-jobs.mjs uses one deliberately, and says so on the line above it —
    'import cycle (y8-ingest imports isTrademarkTitle from this module)'. Cycle
    detection that counts it reports the workaround as the problem it solves.
    """
    graph: dict[str, set[str]] = {}
    static: dict[str, set[str]] = {}
    problems: list[Finding] = []

    for path in files_with_suffix('.js', '.mjs', '.cjs'):
        name = rel(path)
        graph.setdefault(name, set())
        static.setdefault(name, set())
        src = strip_js_comments(read(path))
        for is_static, rx in ((True, _STATIC_IMPORT), (False, _DYNAMIC_IMPORT)):
            for m in rx.finditer(src):
                spec = m.group(1)
                if not spec or not spec.startswith('.'):
                    continue
                target = _resolve(path, spec)
                if target is None:
                    problems.append(Finding(
                        CHECK, 'error', f'import target does not exist: {spec}',
                        path=name, line=line_of(src, m.start()),
                        detail='Nothing resolves this until Node or the browser tries to, and then\n'
                               'it is a hard failure of whatever loaded the module.'))
                    continue
                try:
                    edge = rel(target)
                except ValueError:
                    continue              # resolved outside the repo; not ours
                graph[name].add(edge)
                if is_static:
                    static[name].add(edge)
    return graph, static, problems


def _cycles(graph: dict[str, set[str]]) -> list[list[str]]:
    """Every elementary cycle, found once each. Iterative — a deep chain in this
    graph would otherwise hit Python's recursion limit and take the check with it."""
    found: list[list[str]] = []
    seen_cycles: set[frozenset] = set()
    colour: dict[str, int] = {}

    for start in sorted(graph):
        if colour.get(start):
            continue
        stack = [(start, iter(sorted(graph.get(start, ()))))]
        path = [start]
        on_path = {start}
        colour[start] = 1
        while stack:
            node, children = stack[-1]
            advanced = False
            for child in children:
                if child in on_path:
                    cyc = path[path.index(child):]
                    key = frozenset(cyc)
                    if key not in seen_cycles:
                        seen_cycles.add(key)
                        found.append(cyc + [child])
                elif colour.get(child) != 2:
                    colour[child] = 1
                    stack.append((child, iter(sorted(graph.get(child, ())))))
                    path.append(child)
                    on_path.add(child)
                    advanced = True
                    break
            if not advanced:
                colour[node] = 2
                stack.pop()
                on_path.discard(path.pop())
    return found


def run(report) -> None:
    graph, static, problems = build_graph()
    report.extend(problems)
    report.fact('deps.modules', len(graph))
    report.fact('deps.edges', sum(len(v) for v in graph.values()))
    # The dependency map itself. Only in --json: it is data to query, not a
    # paragraph to read, and printing 90 edges buries the findings above it.
    report.facts['deps.graph'] = {k: sorted(v) for k, v in sorted(graph.items()) if v}

    for cycle in _cycles(static):
        report.add(Finding(
            CHECK, 'warn', f'static import cycle: {" → ".join(cycle)}',
            path=cycle[0],
            detail='In ESM one of these modules observes the other half-initialised.\n'
                   'It works until someone moves a top-level statement.\n'
                   'Breaking one edge with a dynamic import() inside a function is the\n'
                   'usual fix, and is not counted here.'))

    imported: set[str] = set()
    for targets in graph.values():
        imported |= targets

    for name in sorted(graph):
        if name in imported or name in ROOTS or name.startswith(ROOT_DIRS):
            continue
        report.add(Finding(
            CHECK, 'info', f'module is never imported: {name}', path=name,
            detail='Not an entry point and nothing pulls it in.'))
