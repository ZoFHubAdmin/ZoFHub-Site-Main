"""Routes the server registers, against paths the browser asks for.

test/dead-routes.test.mjs already guards one direction of this and guards it
well. This check exists for the other direction, which nothing covered: a route
that is registered and that NOTHING calls. Those accumulate — the leaderboard
left four behind when its client was deleted — and each one is a maintained,
publicly reachable entry point that no longer has a reason to exist.

Both directions are reported, because the two failures look nothing alike: a
client calling a missing route is a broken feature, while a server offering an
uncalled route is attack surface with no owner.
"""
from __future__ import annotations

import re

from .model import Finding
from .repo import ROOT, read, rel, strip_js_comments, strip_html_comments, line_of, files_with_suffix

CHECK = 'api'

_ROUTE = re.compile(r"\bapp\.(get|post|put|patch|delete|all)\(\s*'([^']+)'")
# Routes registered by looping a table — the legal pages do this — are real
# routes with no literal app.get() to find. Their paths come from the array.
# The control-plane API registers every route through one gating helper,
# add('<method>', '/api/admin/...', '<permission>', ...), in lib/admin-api.mjs.
_ADD_ROUTE = re.compile(r"\badd\(\s*'(get|post|put|patch|delete)'\s*,\s*'(/api/admin/[^']+)'")
_TABLE_ROUTE = re.compile(r"for\s*\(\s*const\s+\[?\s*\w+.*?of\s+(\w+)\s*\)", re.S)

# `api(…)` as well as `fetch(…)`: admin-ui/assets/admin.js wraps every call in a
# helper that adds the CSRF header, so a check that only knew about fetch()
# thought the entire admin API had no callers.
# `call(...)` is admin-ui/assets/admin-control.js's wrapper (CSRF + step-up retry).
_CALL = r'(?:fetch|api|apiGet|apiPost|request|call)'
_FETCH = re.compile(_CALL + r"""\(\s*(?:'|")(/[^'"?#]*)(?:'|")\s*(\+)?""")
_TEMPLATE_FETCH = re.compile(_CALL + r'\(\s*`(/[^`]*)`')
# `${r.id}` is one path segment whose value is not known statically. Substituting
# a placeholder lets the whole path be matched against `/api/x/:id/seen` instead
# of truncating at the `$` and reporting the prefix as a route that does not
# exist — which is what it did to /api/recommendations/${r.id}/seen.
_INTERPOLATION = re.compile(r'\$\{[^}]*\}')


def _express_to_regex(route: str) -> re.Pattern:
    """`/api/games/:slug` → a matcher for concrete paths."""
    parts = []
    for seg in route.split('/'):
        if seg.startswith(':'):
            parts.append(r'[^/]+')
        elif seg == '*':
            parts.append(r'.*')
        else:
            parts.append(re.escape(seg))
    return re.compile('^' + '/'.join(parts) + '$')


def collect_routes() -> list[tuple[str, str, int]]:
    """(method, path, line) for every route server.js registers."""
    src = strip_js_comments(read(ROOT / 'server.js'))
    out = [(m.group(1), m.group(2), line_of(src, m.start())) for m in _ROUTE.finditer(src)]

    # Loop-registered paths: find `app.get(...)` inside a for-of over an array
    # whose literal members are strings starting with '/'.
    for m in re.finditer(r"for\s*\(\s*const\s+[\w{}\[\],\s]+\s+of\s+([A-Z_][A-Z0-9_]*)\s*\)", src):
        name = m.group(1)
        decl = re.search(rf'const\s+{name}\s*=\s*(\[[^;]*?\]);', src, re.S)
        if not decl:
            continue
        for lit in re.findall(r"'(/[^']*)'", decl.group(1)):
            out.append(('get', lit, line_of(src, decl.start())))
        for slug in re.findall(r"'([a-z0-9-]+)'", decl.group(1)):
            out.append(('get', '/' + slug, line_of(src, decl.start())))

    api = ROOT / 'lib' / 'admin-api.mjs'
    if api.exists():
        asrc = strip_js_comments(read(api))
        out += [(m.group(1), m.group(2), line_of(asrc, m.start())) for m in _ADD_ROUTE.finditer(asrc)]
    return out


def collect_requests() -> list[tuple[str, str, int]]:
    """(path, file, line) for every same-origin path the client asks for."""
    out = []
    for path in files_with_suffix('.js', '.mjs', '.html'):
        name = rel(path)
        if not name.startswith(('public/', 'admin-ui/', 'legal/')):
            continue
        raw = read(path)
        src = strip_html_comments(raw) if path.suffix == '.html' else strip_js_comments(raw)
        for m in _TEMPLATE_FETCH.finditer(src):
            out.append((_INTERPOLATION.sub('X', m.group(1)).split('?')[0],
                        name, line_of(src, m.start())))
        for m in _FETCH.finditer(src):
            path_literal = m.group(1)
            # `fetch('/api/x/' + id)` — the literal is a prefix, not the path.
            if m.group(2):
                path_literal = path_literal.rstrip('/') + '/X'
            out.append((path_literal, name, line_of(src, m.start())))
    return out


def run(report) -> None:
    routes = collect_routes()
    requests = collect_requests()
    report.fact('api.routes_registered', len({(m, p) for m, p, _ in routes}))
    report.fact('api.client_fetches', len({p for p, _, _ in requests}))

    if not routes:
        report.add(Finding(CHECK, 'error', 'no routes parsed out of server.js — this check ran blind',
                           path='server.js'))
        return

    matchers = [(_express_to_regex(p), p) for _m, p, _l in routes]

    seen_by_client: set[str] = set()
    for want, where, line in requests:
        hit = next((literal for rx, literal in matchers if rx.match(want)), None)
        if hit is None:
            report.add(Finding(
                CHECK, 'error', f'client requests a path no route serves: {want}',
                path=where, line=line,
                detail='Express answers 404 and the calling code takes its error branch —\n'
                       'or, more often, silently renders nothing.'))
        else:
            seen_by_client.add(hit)

    # Server-side references count too: a route the server itself redirects to,
    # links to in HTML, or lists in the sitemap is not dead.
    referenced = set(seen_by_client)
    haystack = []
    for path in files_with_suffix('.js', '.mjs', '.html'):
        name = rel(path)
        if name.startswith(('public/', 'admin-ui/', 'legal/')) or name == 'server.js':
            haystack.append(read(path))
    blob = '\n'.join(haystack)

    api_routes = [(m, p, l) for m, p, l in routes if p.startswith('/api/')]
    for method, route, line in api_routes:
        if route in referenced:
            continue
        # A route named anywhere at all — a redirect, a doc string, a test — is
        # not evidence of nothing calling it, but it IS evidence that deleting it
        # is not a one-line decision. Only report the ones with no mention.
        if blob.count(route) <= 1:
            report.add(Finding(
                CHECK, 'info', f'no caller found for {method.upper()} {route}',
                path='server.js', line=line,
                detail='Nothing in public/, admin-ui/, legal/ or server.js references it.\n'
                       'Either it is for an external consumer, or it is left over.'))
