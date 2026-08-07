"""Database audit: replay the migrations, then hold the running code against them.

The two halves are what make this worth having. Replaying the migrations says
what the database WILL be; reading the Supabase calls in server.js and lib/ says
what the code BELIEVES it to be. Almost every database defect in a project shaped
like this one is a disagreement between those two, and neither half can see it
alone.
"""
from __future__ import annotations

import re
from pathlib import Path

from .model import Finding
from .repo import ROOT, read, rel, strip_js_comments, line_of
from .sqlmodel import Schema, apply_sql, signature, parse_arg_types

CHECK = 'sql'

# The migration order lives in ORDER inside tools/sync-supabase-migrations.mjs.
# It is read from there rather than restated here for the same reason that file
# exists at all: two hand-maintained copies of an ordering drift, and the drift
# is invisible until a preview branch provisions a schema production does not
# have. If that array is ever restructured this parser returns nothing and the
# check reports that it found no migrations, which is loud.
_ORDER_ENTRY = re.compile(
    r"\[\s*'(\d{14})'\s*,\s*'([a-z0-9_]+)'\s*,\s*'([^']+)'", re.I)

# Files under lib/ and at the root that talk to Postgres through supabase-js.
_RUNTIME_GLOBS = ('server.js', 'lib/*.mjs', 'api/*.mjs', 'scripts/*.mjs')


def _migration_order() -> list[tuple[str, str, str]]:
    src = read(ROOT / 'tools' / 'sync-supabase-migrations.mjs')
    start = src.find('const ORDER')
    if start == -1:
        return []
    end = src.find('\n];', start)
    return _ORDER_ENTRY.findall(src[start:end if end != -1 else len(src)])


def build_schema() -> tuple[Schema, list[tuple[str, str, str]]]:
    schema = Schema()
    order = _migration_order()
    for _ts, _name, src in order:
        path = ROOT / src
        if path.exists():
            apply_sql(schema, read(path), src)
    return schema, order


# ---------------------------------------------------------------------------
# What the code thinks the database looks like
# ---------------------------------------------------------------------------
# Filters and modifiers whose FIRST string argument is a column name. This is the
# PostgREST client surface the project actually uses; anything not listed is
# ignored rather than guessed at.
_COLUMN_METHODS = (
    'eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'like', 'ilike', 'is', 'in',
    'contains', 'order',
)
_COL_CALL = re.compile(r'\.(' + '|'.join(_COLUMN_METHODS) + r")\(\s*'([a-z_][a-z0-9_]*)'")
_SELECT_CALL = re.compile(r"\.select\(\s*'([^']*)'")
_WRITE_CALL = re.compile(r'\.(insert|update|upsert)\(\s*\{')
_FROM_CALL = re.compile(r"\.from\(\s*'([a-z_][a-z0-9_]*)'\s*\)")
_RPC_CALL = re.compile(r"\.rpc\(\s*'([a-z_][a-z0-9_]*)'")
_IDENT = re.compile(r'^[a-z_][a-z0-9_]*$')


def _brace_span(src: str, open_at: int) -> str:
    depth, i = 0, open_at
    while i < len(src):
        if src[i] == '{':
            depth += 1
        elif src[i] == '}':
            depth -= 1
            if depth == 0:
                return src[open_at + 1:i]
        i += 1
    return ''


def _top_level_parts(body: str) -> list[str]:
    """Split an object literal on its top-level commas."""
    parts, depth, buf = [], 0, []
    for ch in body:
        if ch in '{[(':
            depth += 1
        elif ch in '}])':
            depth -= 1
        if ch == ',' and depth == 0:
            parts.append(''.join(buf))
            buf = []
        else:
            buf.append(ch)
    parts.append(''.join(buf))
    return parts


def object_keys(body: str) -> set[str]:
    """Column names from an insert/update/upsert object literal.

    Each top-level element is either `key: value` or the shorthand `key`. The key
    is everything before the FIRST top-level colon — which is the distinction
    that matters, because a value is frequently a ternary and carries a colon of
    its own:

        username: username ? String(username).slice(0, 120) : null,

    An earlier version scanned for `identifier` followed by `:` or `,` anywhere
    in the literal, and duly reported a column named `null` on three tables and a
    column named `false` on a fourth. Nothing about those findings was true, and
    a report with four inventions in it is one nobody reads to the end.
    """
    out: set[str] = set()
    for part in _top_level_parts(body):
        depth, colon = 0, -1
        for i, ch in enumerate(part):
            if ch in '{[(':
                depth += 1
            elif ch in '}])':
                depth -= 1
            elif ch == ':' and depth == 0:
                colon = i
                break
        key = (part[:colon] if colon >= 0 else part).strip()
        if _IDENT.match(key):
            out.add(key)
        # Anything else — a computed key, a spread, a nested destructure — is not
        # decidably a column name, so it is left alone rather than guessed at.
    return out


def _chain_end(src: str, at: int, next_from: int) -> int:
    """Where the query chain starting at `at` stops.

    A supabase-js chain is one expression, so the statement's own semicolon ends
    it. Bounding it by a character count instead — the first thing that comes to
    mind — attributes the NEXT statement's filters to this table: that is how
    `.eq('is_working', …)` from a later query on `games` was reported as a
    missing column on `recommendations`.
    """
    depth = 0
    i = at
    limit = min(len(src), next_from)
    while i < limit:
        ch = src[i]
        if ch in '([{':
            depth += 1
        elif ch in ')]}':
            depth -= 1
        elif ch == ';' and depth <= 0:
            return i
        i += 1
    return limit


class Usage:
    """One `.from('table')` call chain, and every column it names."""

    def __init__(self, table: str, path: str, line: int):
        self.table = table
        self.path = path
        self.line = line
        self.columns: set[str] = set()
        self.star = False


def collect_usage() -> tuple[list[Usage], list[tuple[str, str, int]]]:
    """Every table access and RPC name the runtime code performs."""
    usages: list[Usage] = []
    rpcs: list[tuple[str, str, int]] = []

    files: list[Path] = []
    for pattern in _RUNTIME_GLOBS:
        files.extend(sorted(ROOT.glob(pattern)))

    for path in files:
        raw = read(path)
        if 'supabase' not in raw and '.from(' not in raw:
            continue
        src = strip_js_comments(raw)
        where = rel(path)

        for m in _RPC_CALL.finditer(src):
            rpcs.append((m.group(1), where, line_of(src, m.start())))

        starts = [(m.start(), m.group(1)) for m in _FROM_CALL.finditer(src)]
        for idx, (at, table) in enumerate(starts):
            next_from = starts[idx + 1][0] if idx + 1 < len(starts) else len(src)
            chain = src[at:_chain_end(src, at, next_from)]
            u = Usage(table, where, line_of(src, at))

            for sm in _SELECT_CALL.finditer(chain):
                cols = sm.group(1)
                if '(' in cols:          # embedded resource — out of scope
                    continue
                for c in cols.split(','):
                    c = c.strip().split(':')[-1].strip()
                    if c == '*':
                        u.star = True
                    elif re.fullmatch(r'[a-z_][a-z0-9_]*', c):
                        u.columns.add(c)

            for cm in _COL_CALL.finditer(chain):
                u.columns.add(cm.group(2))

            for wm in _WRITE_CALL.finditer(chain):
                u.columns |= object_keys(_brace_span(chain, chain.index('{', wm.end() - 1)))

            usages.append(u)

    return usages, rpcs


# ---------------------------------------------------------------------------
# View column resolution
# ---------------------------------------------------------------------------
def _view_columns(body: str) -> set[str] | None:
    """Column names a view exposes, or None when the select list is not decidable.

    Returning None rather than a guess matters: a wrong column set turns every
    query against the view into a false "column does not exist", and the check
    would be muted within a day.
    """
    m = re.search(r'\bselect\b(.*?)\bfrom\b', body, re.I | re.S)
    if not m:
        return None
    out: set[str] = set()
    depth, buf, parts = 0, [], []
    for ch in m.group(1):
        if ch in '([':
            depth += 1
        elif ch in ')]':
            depth -= 1
        if ch == ',' and depth == 0:
            parts.append(''.join(buf))
            buf = []
        else:
            buf.append(ch)
    parts.append(''.join(buf))

    for part in parts:
        p = part.strip()
        if not p:
            continue
        alias = re.search(r'\bas\s+"?([a-z_][a-z0-9_]*)"?\s*$', p, re.I)
        if alias:
            out.add(alias.group(1).lower())
            continue
        if p == '*':
            return None
        if re.fullmatch(r'[a-z_][a-z0-9_]*', p, re.I):
            out.add(p.lower())
            continue
        return None      # an expression with no alias — cannot name it
    return out or None


# ---------------------------------------------------------------------------
# The check
# ---------------------------------------------------------------------------
def run(report) -> None:
    schema, order = build_schema()
    report.fact('sql.migrations', len(order))
    report.fact('sql.statements_parsed', schema.statements)
    report.fact('sql.tables_after_replay', len(schema.tables))
    report.fact('sql.functions_after_replay', len(schema.functions))
    report.fact('sql.indexes_after_replay', len(schema.indexes))

    if not order:
        report.add(Finding(CHECK, 'error',
                           'could not read the ORDER array from tools/sync-supabase-migrations.mjs',
                           path='tools/sync-supabase-migrations.mjs',
                           detail='Every check below depends on it, so none of them ran.'))
        return

    usages, rpcs = collect_usage()
    used_tables = {u.table for u in usages}
    called_rpcs = {name for name, _, _ in rpcs}
    report.fact('sql.tables_used_by_code', len(used_tables))

    # ── Every db/*.sql that defines schema must be in the migration order ────
    # A schema file nobody registered is never applied to a preview branch or to
    # production, and the only symptom is a missing object at runtime.
    registered = {src for _ts, _n, src in order}
    for path in sorted((ROOT / 'db').glob('*.sql')):
        name = rel(path)
        # ALL-IN-ONE.sql is generated FROM the ordered files; it has its own
        # check below. Loaders are data.
        if path.name.startswith(('load-', 'y8-games')) or path.name == 'ALL-IN-ONE.sql':
            continue
        if name in registered:
            continue
        if re.search(r'\bcreate\s+(table|function|view|index|policy|trigger)\b', read(path), re.I):
            report.add(Finding(
                CHECK, 'error',
                f'{path.name} defines schema but is not in the migration ORDER',
                path=name,
                detail='Supabase applies supabase/migrations/ only. A file outside that\n'
                       'order is never applied to a preview branch or to production.'))

    # ── The one-file bootstrap must provision the same database ─────────────
    # db/ALL-IN-ONE.sql is a documented restore path (`psql -f`). It was
    # generated once and then the schema moved on without it, so it drifted to
    # five of the twelve schema files — no admin tables, no feedback table — and
    # nothing in the repository could notice. It is generated by
    # tools/build-all-in-one.mjs now; this is the check that it still agrees.
    aio = ROOT / 'db' / 'ALL-IN-ONE.sql'
    if aio.exists():
        bootstrap = apply_sql(Schema(), read(aio), 'db/ALL-IN-ONE.sql')
        for kind, want, got in (
            ('table', set(schema.tables), set(bootstrap.tables)),
            ('function', set(schema.functions), set(bootstrap.functions)),
        ):
            for missing in sorted(want - got):
                report.add(Finding(
                    CHECK, 'error',
                    f'db/ALL-IN-ONE.sql does not create {kind} {missing}',
                    path='db/ALL-IN-ONE.sql',
                    detail='It is a documented restore path, so a database built from it would\n'
                           'be missing this. Regenerate: npm run build-all-in-one'))
            for extra in sorted(got - want):
                report.add(Finding(
                    CHECK, 'warn',
                    f'db/ALL-IN-ONE.sql leaves behind {kind} {extra}, which the migrations drop',
                    path='db/ALL-IN-ONE.sql',
                    detail='Regenerate: npm run build-all-in-one'))

    # ── A DROP FUNCTION that matches nothing ────────────────────────────────
    # Postgres identifies a function by name AND argument types. A drop naming a
    # signature that was never created silently does nothing, which reads in
    # review exactly like a drop that worked.
    #
    # Severity turns on ONE question: does another overload of that name survive?
    # If it does, the drop was almost certainly aimed at it and missed, and the
    # object the author believed they removed is still in the database — that is
    # an error. If nothing of that name survives, the drop is merely belt-and-
    # braces against a spelling some older hand-run script may have installed,
    # which is a defensible thing to write and not worth shouting about.
    survivors: dict[str, list[str]] = {}
    for sig in schema.functions:
        survivors.setdefault(sig.split('(')[0], []).append(sig)

    for sig, origin in schema.empty_function_drops:
        name = sig.split('(')[0]
        alive = sorted(survivors.get(name, []))
        if alive:
            report.add(Finding(
                CHECK, 'error', f'drop function matches nothing, but {name} still exists: {sig}',
                path=origin.file, line=origin.line,
                detail='Postgres matches a DROP by name AND argument types, so this removed\n'
                       'nothing. Surviving signature(s): ' + ', '.join(alive) + '\n'
                       'If one of those was the target, it is still in the database.'))
        else:
            report.add(Finding(
                CHECK, 'info', f'drop function is a no-op — nothing of that signature was created: {sig}',
                path=origin.file, line=origin.line))

    # ── Functions ───────────────────────────────────────────────────────────
    for sig, fn in sorted(schema.functions.items()):
        # A trigger function's caller is its trigger, not JS.
        bound = any(t.function == fn.name for t in schema.triggers.values())
        called = fn.name in called_rpcs

        if fn.security == 'definer':
            if not fn.revoked_from_public:
                report.add(Finding(
                    CHECK, 'error',
                    f'SECURITY DEFINER function is not revoked from anon/authenticated: {sig}',
                    path=fn.origin.file, line=fn.origin.line,
                    detail='It runs with the definer\'s rights and the publishable key can reach it.\n'
                           'Add: revoke all on function ' + sig + ' from public, anon, authenticated;'))
            if not called and not bound:
                report.add(Finding(
                    CHECK, 'warn',
                    f'SECURITY DEFINER function has no caller anywhere: {sig}',
                    path=fn.origin.file, line=fn.origin.line,
                    detail='Elevated-privilege code with no caller is pure liability — it can only\n'
                           'ever be invoked by accident or by someone who should not be invoking it.'))
        elif not called and not bound:
            report.add(Finding(
                CHECK, 'info', f'function has no caller in this repository: {sig}',
                path=fn.origin.file, line=fn.origin.line))

        if fn.search_path is None:
            report.add(Finding(
                CHECK, 'warn', f'function does not pin search_path: {sig}',
                path=fn.origin.file, line=fn.origin.line,
                detail="db/schema.sql sets the house standard and says why: `security invoker`\n"
                       "plus `set search_path = ''` clears Supabase's Function Search Path\n"
                       'Mutable advisor. now() still resolves — pg_catalog is always implicit.'))

    # ── Tables ──────────────────────────────────────────────────────────────
    for name, table in sorted(schema.tables.items()):
        if not table.rls:
            report.add(Finding(
                CHECK, 'error', f'table has no row level security: {name}',
                path=table.origin.file if table.origin else '',
                line=table.origin.line if table.origin else 0,
                detail='Without RLS the publishable key that ships to every browser can read it.\n'
                       'Add: alter table public.' + name + ' enable row level security;'))
        if name not in used_tables:
            report.add(Finding(
                CHECK, 'info', f'table is never read or written by this repository: {name}',
                path=table.origin.file if table.origin else '',
                line=table.origin.line if table.origin else 0,
                detail='Not necessarily wrong — schema can land before the feature — but an\n'
                       'empty table nobody queries is also how an abandoned feature looks.'))

    # ── Code against schema ─────────────────────────────────────────────────
    view_cols = {name: _view_columns(v.body) for name, v in schema.views.items()}

    for u in usages:
        known_cols: set[str] | None = None
        if u.table in schema.tables:
            known_cols = set(schema.tables[u.table].columns)
        elif u.table in schema.views:
            known_cols = view_cols.get(u.table)
        else:
            dropped = [(n, o) for n, o in schema.dropped_tables if n == u.table]
            extra = (f'\nIt was dropped by {dropped[-1][1].file}:{dropped[-1][1].line}.'
                     if dropped else '')
            report.add(Finding(
                CHECK, 'error',
                f"code queries a relation the schema does not define: {u.table}",
                path=u.path, line=u.line,
                detail='Every call on this table fails at runtime.' + extra))
            continue

        if known_cols is None:
            continue
        for col in sorted(u.columns - known_cols):
            report.add(Finding(
                CHECK, 'error',
                f'column does not exist: {u.table}.{col}',
                path=u.path, line=u.line,
                detail='Known columns: ' + ', '.join(sorted(known_cols))))

    for name, path, line in rpcs:
        if not any(fn.name == name for fn in schema.functions.values()):
            report.add(Finding(
                CHECK, 'error', f'code calls an RPC the schema does not define: {name}()',
                path=path, line=line,
                detail='PostgREST answers this with 404 and the calling job silently does nothing.'))

    # ── Indexes ─────────────────────────────────────────────────────────────
    # A redundant index is not free: every INSERT and UPDATE maintains it, and it
    # occupies cache that the index it duplicates could have used.
    by_table: dict[str, list] = {}
    for ix in schema.indexes.values():
        by_table.setdefault(ix.table, []).append(ix)
    for table, group in sorted(by_table.items()):
        for a in group:
            for b in group:
                if a.name == b.name or a.predicate.lower() != b.predicate.lower():
                    continue
                if len(a.columns) < len(b.columns) and b.columns[:len(a.columns)] == a.columns:
                    if a.unique and not b.unique:
                        continue          # a UNIQUE prefix is a constraint, not a duplicate
                    report.add(Finding(
                        CHECK, 'info',
                        f'index {a.name} is a prefix of {b.name} on {table}',
                        path=a.origin.file if a.origin else '', line=a.origin.line if a.origin else 0,
                        evidence=f'{a.name}({", ".join(a.columns)}) ⊂ {b.name}({", ".join(b.columns)})',
                        detail='A leading-column prefix is already served by the wider index.'))
