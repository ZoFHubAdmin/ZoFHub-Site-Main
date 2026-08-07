"""A small Postgres DDL reader, and a replay of the migrations onto one schema.

WHY REPLAY, RATHER THAN READ THE FILES
The interesting questions about this database cannot be answered by reading any
one file. `scores` is created in db/community.sql, altered by four more, and
dropped by db/feedback.sql; whether it exists is a property of the SEQUENCE, not
of any file in it. The same goes for every function, because CREATE OR REPLACE
means the last definition wins and DROP means the signature has to match.

So this module reads the DDL, applies it in the order tools/sync-supabase-migrations.mjs
declares, and hands back the state a fresh database would actually be in. That
final state is what the checks then ask questions of — which is how a mistake
like "the teardown dropped submit_score(text, text, integer) but the function
created was submit_score(text, text, bigint)" becomes visible at all.

SCOPE
This parses the DDL this repository writes: enough grammar to be right about
these files, not a general Postgres parser. Anything it does not recognise is
IGNORED rather than guessed at, and `Schema.unparsed` keeps the count so a
sudden drop in coverage is visible instead of silent.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field

# ---------------------------------------------------------------------------
# Lexing
# ---------------------------------------------------------------------------
# Dollar quoting is why this cannot be a regex. Every function body in this repo
# is wrapped in $$ … $$, those bodies contain semicolons, single quotes and --
# comments, and a naive split on ';' tears them in half. The scanner below tracks
# the four contexts that matter and is the only place that decides what is code.

_DOLLAR_OPEN = re.compile(r'\$([A-Za-z_][A-Za-z0-9_]*)?\$')


def _scan(sql: str):
    """Yield (kind, start, end) spans: 'code', 'line_comment', 'block_comment',
    'string', 'dollar'."""
    i, n = 0, len(sql)
    code_start = 0
    while i < n:
        ch = sql[i]
        if ch == '-' and sql.startswith('--', i):
            j = sql.find('\n', i)
            j = n if j == -1 else j
            yield ('code', code_start, i)
            yield ('line_comment', i, j)
            i = code_start = j
        elif ch == '/' and sql.startswith('/*', i):
            j = sql.find('*/', i + 2)
            j = n if j == -1 else j + 2
            yield ('code', code_start, i)
            yield ('block_comment', i, j)
            i = code_start = j
        elif ch == "'":
            j = i + 1
            while j < n:
                if sql[j] == "'":
                    if j + 1 < n and sql[j + 1] == "'":   # '' is an escaped quote
                        j += 2
                        continue
                    j += 1
                    break
                j += 1
            yield ('code', code_start, i)
            yield ('string', i, j)
            i = code_start = j
        elif ch == '$':
            m = _DOLLAR_OPEN.match(sql, i)
            if m:
                tag = m.group(0)
                j = sql.find(tag, m.end())
                j = n if j == -1 else j + len(tag)
                yield ('code', code_start, i)
                yield ('dollar', i, j)
                i = code_start = j
            else:
                i += 1
        else:
            i += 1
    yield ('code', code_start, n)


def strip_comments(sql: str) -> str:
    """Blank out comments, preserving newlines so line numbers survive."""
    out = list(sql)
    for kind, a, b in _scan(sql):
        if kind in ('line_comment', 'block_comment'):
            for k in range(a, b):
                if out[k] != '\n':
                    out[k] = ' '
    return ''.join(out)


def split_statements(sql: str) -> list[tuple[str, int]]:
    """(statement_text, 1-indexed start line) for each top-level statement."""
    cleaned = strip_comments(sql)
    # Semicolons inside strings and dollar-quoted bodies are not separators.
    protected = list(cleaned)
    for kind, a, b in _scan(cleaned):
        if kind in ('string', 'dollar'):
            for k in range(a, b):
                if protected[k] == ';':
                    protected[k] = '\x00'
    marked = ''.join(protected)

    out, start = [], 0
    for m in re.finditer(r';', marked):
        chunk = cleaned[start:m.start()]
        if chunk.strip():
            out.append((chunk, cleaned.count('\n', 0, start + len(chunk) - len(chunk.lstrip())) + 1))
        start = m.end()
    tail = cleaned[start:]
    if tail.strip():
        out.append((tail, cleaned.count('\n', 0, start) + 1))
    return out


# ---------------------------------------------------------------------------
# Type normalisation
# ---------------------------------------------------------------------------
# Postgres identifies a function by name AND argument types, and it resolves
# aliases before comparing: drop function f(int) does drop f(integer). A checker
# that compares the spelling instead of the type reports a phantom mismatch on
# every alias, so the aliases are folded here, once.
_TYPE_ALIASES = {
    'int': 'integer', 'int4': 'integer',
    'int2': 'smallint',
    'int8': 'bigint',
    'bool': 'boolean',
    'varchar': 'character varying',
    'char': 'character',
    'timestamptz': 'timestamp with time zone',
    'timestamp': 'timestamp without time zone',
    'timetz': 'time with time zone',
    'float8': 'double precision',
    'float4': 'real',
    'decimal': 'numeric',
}

_TYPE_WORDS = {
    'text', 'integer', 'int', 'int2', 'int4', 'int8', 'bigint', 'smallint',
    'boolean', 'bool', 'jsonb', 'json', 'uuid', 'numeric', 'decimal', 'real',
    'double', 'precision', 'character', 'varying', 'varchar', 'char', 'bytea',
    'date', 'interval', 'money', 'inet', 'cidr', 'xml', 'serial', 'bigserial',
    'smallserial', 'timestamptz', 'timestamp', 'time', 'timetz', 'float4',
    'float8', 'record', 'anyelement', 'trigger', 'void',
}


def normalize_type(raw: str) -> str:
    t = re.sub(r'\s+', ' ', raw.strip().lower())
    t = re.sub(r'\s*\(\s*\d+\s*(,\s*\d+\s*)?\)', '', t)   # varchar(255) → varchar
    array = t.endswith('[]')
    if array:
        t = t[:-2].strip()
    t = _TYPE_ALIASES.get(t, t)
    return t + '[]' if array else t


def _split_top_level(s: str) -> list[str]:
    parts, depth, buf = [], 0, []
    for ch in s:
        if ch == '(':
            depth += 1
        elif ch == ')':
            depth -= 1
        if ch == ',' and depth == 0:
            parts.append(''.join(buf))
            buf = []
        else:
            buf.append(ch)
    if ''.join(buf).strip():
        parts.append(''.join(buf))
    return parts


def parse_arg_types(arglist: str) -> tuple[str, ...]:
    """('text', 'text', 'bigint') from either a CREATE or a DROP argument list.

    Handles both spellings this repo uses: named-and-typed with defaults
    (`p_score bigint`, `keep integer default 1000`) and bare types (`text, text,
    integer`), because a DROP writes the second and a CREATE writes the first —
    and the whole point is to compare one against the other.
    """
    out = []
    for raw in _split_top_level(arglist):
        a = raw.strip()
        if not a:
            continue
        a = re.sub(r'\s+(default|=)\s+.*$', '', a, flags=re.IGNORECASE | re.DOTALL)
        a = re.sub(r'^\s*(in|out|inout|variadic)\s+', '', a, flags=re.IGNORECASE)
        words = a.split()
        if not words:
            continue
        if len(words) > 1 and words[0].lower() not in _TYPE_WORDS:
            words = words[1:]           # first token was the parameter NAME
        out.append(normalize_type(' '.join(words)))
    return tuple(out)


def signature(name: str, argtypes: tuple[str, ...]) -> str:
    return f'{name}({", ".join(argtypes)})'


# ---------------------------------------------------------------------------
# Objects
# ---------------------------------------------------------------------------
@dataclass
class Origin:
    file: str
    line: int


@dataclass
class Column:
    name: str
    type: str
    origin: Origin


@dataclass
class Table:
    name: str
    columns: dict[str, Column] = field(default_factory=dict)
    rls: bool = False
    policies: list[str] = field(default_factory=list)
    origin: Origin | None = None


@dataclass
class Function:
    name: str
    argtypes: tuple[str, ...]
    security: str = ''            # 'definer' | 'invoker' | '' (= invoker by default)
    search_path: str | None = None
    returns: str = ''
    body: str = ''
    revoked_from_public: bool = False
    origin: Origin | None = None

    @property
    def sig(self) -> str:
        return signature(self.name, self.argtypes)


@dataclass
class Index:
    name: str
    table: str
    columns: tuple[str, ...]
    unique: bool = False
    predicate: str = ''
    origin: Origin | None = None


@dataclass
class Trigger:
    name: str
    table: str
    function: str
    origin: Origin | None = None


@dataclass
class View:
    name: str
    security_invoker: bool = False
    body: str = ''
    origin: Origin | None = None


@dataclass
class Schema:
    """State after replaying every migration, plus the drops that hit nothing."""

    tables: dict[str, Table] = field(default_factory=dict)
    functions: dict[str, Function] = field(default_factory=dict)   # keyed by signature
    indexes: dict[str, Index] = field(default_factory=dict)
    triggers: dict[str, Trigger] = field(default_factory=dict)
    views: dict[str, View] = field(default_factory=dict)

    dropped_tables: list[tuple[str, Origin]] = field(default_factory=list)
    # DROP FUNCTION statements that matched no function that ever existed. This
    # is the list that catches a teardown aiming at the wrong signature.
    empty_function_drops: list[tuple[str, Origin]] = field(default_factory=list)
    # Every function signature that was ever created, including ones later
    # dropped — needed to tell "the drop was redundant" from "the drop missed".
    ever_created: set[str] = field(default_factory=set)
    statements: int = 0
    unparsed: int = 0


# ---------------------------------------------------------------------------
# Statement patterns
# ---------------------------------------------------------------------------
_Q = r'(?:public\.)?"?([a-z_][a-z0-9_]*)"?'

RE_CREATE_TABLE = re.compile(r'^\s*create\s+table\s+(?:if\s+not\s+exists\s+)?' + _Q + r'\s*\(', re.I)
RE_DROP_TABLE = re.compile(r'^\s*drop\s+table\s+(?:if\s+exists\s+)?' + _Q, re.I)
RE_ADD_COLUMN = re.compile(
    r'^\s*alter\s+table\s+' + _Q + r'\s+add\s+column\s+(?:if\s+not\s+exists\s+)?'
    r'"?([a-z_][a-z0-9_]*)"?\s+(.+)$', re.I | re.S)
RE_ENABLE_RLS = re.compile(r'^\s*alter\s+table\s+' + _Q + r'\s+enable\s+row\s+level\s+security', re.I)
RE_CREATE_POLICY = re.compile(r'^\s*create\s+policy\s+"?([^"\n]+?)"?\s+on\s+' + _Q, re.I)
RE_DROP_POLICY = re.compile(r'^\s*drop\s+policy\s+(?:if\s+exists\s+)?"?([^"\n]+?)"?\s+on\s+' + _Q, re.I)
RE_CREATE_INDEX = re.compile(
    r'^\s*create\s+(unique\s+)?index\s+(?:concurrently\s+)?(?:if\s+not\s+exists\s+)?'
    r'"?([a-z_][a-z0-9_]*)"?\s+on\s+' + _Q + r'\s*(?:using\s+\w+\s*)?\((.*?)\)\s*(where\s+.*)?$',
    re.I | re.S)
RE_DROP_INDEX = re.compile(r'^\s*drop\s+index\s+(?:if\s+exists\s+)?' + _Q, re.I)
RE_CREATE_FUNC = re.compile(
    r'^\s*create\s+(?:or\s+replace\s+)?function\s+' + _Q + r'\s*\((.*?)\)\s*(.*)$', re.I | re.S)
RE_DROP_FUNC = re.compile(
    r'^\s*drop\s+function\s+(?:if\s+exists\s+)?' + _Q + r'\s*(?:\((.*?)\))?', re.I | re.S)
RE_CREATE_VIEW = re.compile(
    r'^\s*create\s+(?:or\s+replace\s+)?view\s+' + _Q + r'\s*(.*?)\s+as\s+(.*)$', re.I | re.S)
RE_DROP_VIEW = re.compile(r'^\s*drop\s+view\s+(?:if\s+exists\s+)?' + _Q, re.I)
RE_CREATE_TRIGGER = re.compile(
    r'^\s*create\s+trigger\s+"?([a-z_][a-z0-9_]*)"?\s+(.*?)\s+on\s+' + _Q +
    r'(.*?)execute\s+(?:function|procedure)\s+' + _Q, re.I | re.S)
RE_DROP_TRIGGER = re.compile(r'^\s*drop\s+trigger\s+(?:if\s+exists\s+)?"?([a-z_][a-z0-9_]*)"?\s+on\s+' + _Q, re.I)
RE_REVOKE_FUNC = re.compile(
    r'^\s*revoke\s+.*?\s+on\s+function\s+' + _Q + r'\s*\((.*?)\)\s+from\s+(.*)$', re.I | re.S)

_KNOWN_STARTS = re.compile(
    r'^\s*(select|insert|update|delete|comment|grant|revoke|alter|set|begin|commit|do|with|analyze|vacuum|truncate|notify)\b',
    re.I)


def _columns_from_create(stmt: str, file: str, line: int) -> dict[str, Column]:
    open_at = stmt.index('(')
    depth, end = 0, len(stmt)
    for i in range(open_at, len(stmt)):
        if stmt[i] == '(':
            depth += 1
        elif stmt[i] == ')':
            depth -= 1
            if depth == 0:
                end = i
                break
    cols: dict[str, Column] = {}
    for part in _split_top_level(stmt[open_at + 1:end]):
        p = part.strip()
        if not p:
            continue
        first = p.split()[0].lower().strip('"')
        # Table-level constraints are not columns.
        if first in ('constraint', 'primary', 'unique', 'foreign', 'check', 'exclude', 'like'):
            continue
        words = p.split()
        if len(words) < 2:
            continue
        cols[first] = Column(first, normalize_type(words[1]), Origin(file, line))
    return cols


def apply_sql(schema: Schema, sql: str, file: str) -> Schema:
    """Fold one file's DDL into the running schema state."""
    for stmt, line in split_statements(sql):
        schema.statements += 1
        s = re.sub(r'\s+', ' ', stmt).strip()
        origin = Origin(file, line)

        m = RE_CREATE_TABLE.match(s)
        if m:
            name = m.group(1).lower()
            t = schema.tables.get(name) or Table(name, origin=origin)
            for cname, col in _columns_from_create(stmt, file, line).items():
                t.columns.setdefault(cname, col)
            schema.tables[name] = t
            continue

        m = RE_DROP_TABLE.match(s)
        if m:
            name = m.group(1).lower()
            schema.tables.pop(name, None)
            schema.dropped_tables.append((name, origin))
            # Indexes, triggers and policies go with the table.
            for k, ix in list(schema.indexes.items()):
                if ix.table == name:
                    del schema.indexes[k]
            for k, tg in list(schema.triggers.items()):
                if tg.table == name:
                    del schema.triggers[k]
            continue

        m = RE_ADD_COLUMN.match(s)
        if m:
            tname, cname, rest = m.group(1).lower(), m.group(2).lower(), m.group(3)
            t = schema.tables.setdefault(tname, Table(tname, origin=origin))
            t.columns.setdefault(cname, Column(cname, normalize_type(rest.split()[0]), origin))
            continue

        m = RE_ENABLE_RLS.match(s)
        if m:
            t = schema.tables.setdefault(m.group(1).lower(), Table(m.group(1).lower(), origin=origin))
            t.rls = True
            continue

        m = RE_DROP_POLICY.match(s)
        if m:
            t = schema.tables.get(m.group(2).lower())
            if t and m.group(1) in t.policies:
                t.policies.remove(m.group(1))
            continue

        m = RE_CREATE_POLICY.match(s)
        if m:
            t = schema.tables.setdefault(m.group(2).lower(), Table(m.group(2).lower(), origin=origin))
            if m.group(1) not in t.policies:
                t.policies.append(m.group(1))
            continue

        m = RE_CREATE_INDEX.match(s)
        if m:
            uniq, iname, tname, cols, pred = m.groups()
            schema.indexes[iname.lower()] = Index(
                iname.lower(), tname.lower(),
                tuple(c.strip().lower() for c in _split_top_level(cols)),
                bool(uniq), (pred or '').strip(), origin)
            continue

        m = RE_DROP_INDEX.match(s)
        if m:
            schema.indexes.pop(m.group(1).lower(), None)
            continue

        m = RE_DROP_TRIGGER.match(s)
        if m:
            schema.triggers.pop(m.group(1).lower(), None)
            continue

        m = RE_CREATE_TRIGGER.match(s)
        if m:
            schema.triggers[m.group(1).lower()] = Trigger(
                m.group(1).lower(), m.group(3).lower(), m.group(5).lower(), origin)
            continue

        m = RE_DROP_VIEW.match(s)
        if m:
            schema.views.pop(m.group(1).lower(), None)
            continue

        m = RE_CREATE_VIEW.match(s)
        if m:
            schema.views[m.group(1).lower()] = View(
                m.group(1).lower(),
                'security_invoker' in m.group(2).lower(),
                m.group(3), origin)
            continue

        m = RE_DROP_FUNC.match(s)
        if m:
            name, args = m.group(1).lower(), m.group(2)
            if args is None:
                # DROP FUNCTION with no argument list removes every overload.
                for k in [k for k in schema.functions if k.startswith(name + '(')]:
                    del schema.functions[k]
                continue
            sig = signature(name, parse_arg_types(args))
            if sig in schema.functions:
                del schema.functions[sig]
            elif sig not in schema.ever_created:
                schema.empty_function_drops.append((sig, origin))
            continue

        m = RE_CREATE_FUNC.match(s)
        if m:
            name, args, tail = m.group(1).lower(), m.group(2), m.group(3)
            sig = signature(name, parse_arg_types(args))
            sp = re.search(r"set\s+search_path\s*(?:=|to)\s*('[^']*'|\S+)", tail, re.I)
            ret = re.search(r'returns\s+(.+?)\s+language', tail, re.I | re.S)
            body = re.search(r'\$([A-Za-z_]\w*)?\$(.*)\$\1?\$', tail, re.S)
            fn = Function(
                name=name,
                argtypes=parse_arg_types(args),
                security='definer' if re.search(r'security\s+definer', tail, re.I)
                         else ('invoker' if re.search(r'security\s+invoker', tail, re.I) else ''),
                search_path=(sp.group(1).strip("'") if sp else None),
                returns=re.sub(r'\s+', ' ', ret.group(1)).strip() if ret else '',
                body=body.group(2) if body else '',
                origin=origin,
            )
            prev = schema.functions.get(sig)
            if prev:
                fn.revoked_from_public = prev.revoked_from_public
            schema.functions[sig] = fn
            schema.ever_created.add(sig)
            continue

        m = RE_REVOKE_FUNC.match(s)
        if m:
            sig = signature(m.group(1).lower(), parse_arg_types(m.group(2)))
            fn = schema.functions.get(sig)
            if fn and re.search(r'\b(public|anon|authenticated)\b', m.group(3), re.I):
                fn.revoked_from_public = True
            continue

        if not _KNOWN_STARTS.match(s):
            schema.unparsed += 1

    return schema
