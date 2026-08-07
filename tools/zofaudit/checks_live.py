"""Does the RUNNING database match what these migrations say it should be?

Every other check in this package reasons about files. This one calls the
production database and compares.

WHY IT HAS TO EXIST
The Supabase GitHub integration applies `supabase/migrations/` on merge to
`main`, and its failure modes are all silent. Point it at the wrong repository,
or set the working directory to `supabase` instead of `.`, and it finds no
migrations, applies nothing, and reports success. Nothing in the repository can
tell — the files look right, the tests pass, and the database quietly keeps an
older schema. The only way to know a deploy landed is to ask the database.

That is not hypothetical either. On 2026-08-07 this comparison found
`submit_score(text, text, bigint)` and `prune_admin_state()` still live: objects
the migrations believed they had dropped, still present in production because a
`DROP` matched by the wrong argument types. Reading the files could never have
shown it.

CREDENTIALS
Read from the environment, then from `.env`. With none configured the check
reports that it was skipped and passes — a contributor without production keys,
and CI, must not see a failure for a check they cannot run. Nothing here writes,
and no key is ever printed.
"""
from __future__ import annotations

import json
import os
import re
import urllib.error
import urllib.request

from .model import Finding
from .repo import ROOT, read
from .checks_sql import build_schema, _view_columns

CHECK = 'live'

TIMEOUT = 20

# Tables the browser-facing key must never be able to read a row from. Deny by
# default is the documented posture; this is the assertion that it is still true
# of the running database, which is the only place it can actually be false.
MUST_NOT_LEAK = (
    'feedback', 'admin_sessions', 'admin_audit_logs',
    'admin_login_attempts', 'admin_security_events',
)


def _env(*names: str) -> str:
    for n in names:
        v = os.environ.get(n)
        if v:
            return v.strip()
    env_file = ROOT / '.env'
    if env_file.exists():
        for line in read(env_file).splitlines():
            m = re.match(r'\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*(.*)\s*$', line)
            if m and m.group(1) in names:
                return m.group(2).strip().strip('"').strip("'")
    return ''


def _get(url: str, key: str, accept: str = 'application/json'):
    req = urllib.request.Request(url, headers={
        'apikey': key, 'Authorization': f'Bearer {key}', 'Accept': accept,
    })
    with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
        return r.status, r.headers, r.read()


def run(report) -> None:
    base = _env('SUPABASE_URL').rstrip('/')
    secret = _env('SUPABASE_SECRET_KEY', 'SUPABASE_SERVICE_ROLE_KEY')
    anon = _env('SUPABASE_PUBLISHABLE_KEY', 'SUPABASE_ANON_KEY')

    if not base or not secret:
        report.add(Finding(
            CHECK, 'info', 'skipped — no SUPABASE_URL / secret key configured',
            detail='This check compares the running database against the migrations.\n'
                   'Without credentials it cannot run, which is not a failure.'))
        return

    try:
        status, _h, body = _get(base + '/rest/v1/', secret, 'application/openapi+json')
        spec = json.loads(body)
    except (urllib.error.URLError, OSError, ValueError) as exc:
        report.add(Finding(
            CHECK, 'warn', f'could not reach the database: {type(exc).__name__}',
            detail='Network or credentials. Nothing was verified against production.'))
        return

    paths = list((spec.get('paths') or {}).keys())
    live_rel = {p.lstrip('/') for p in paths if p != '/' and not p.startswith('/rpc/')}
    live_rpc = {p[5:] for p in paths if p.startswith('/rpc/')}

    schema, order = build_schema()
    want_rel = set(schema.tables) | set(schema.views)
    # PostgREST exposes only callable functions; a trigger function is invoked by
    # its trigger and never appears here, so comparing it would report a
    # difference that is not one.
    want_rpc = {fn.name for fn in schema.functions.values()
                if (fn.returns or '').lower() != 'trigger'}

    report.fact('live.relations', len(live_rel))
    report.fact('live.functions', len(live_rpc))
    report.fact('live.migrations_expected', len(order))

    # ── Did the deploy land? ────────────────────────────────────────────────
    for missing in sorted(want_rel - live_rel):
        report.add(Finding(
            CHECK, 'error', f'migrations create {missing}, the live database does not have it',
            detail='Either the migration has not been applied, or the integration is not\n'
                   'connected to the repository you push to. See supabase/README.md.'))
    for missing in sorted(want_rpc - live_rpc):
        report.add(Finding(
            CHECK, 'error', f'migrations create {missing}(), the live database does not have it',
            detail='Anything calling it is failing right now with a PostgREST 404.'))

    # ── Is anything live that no migration creates? ─────────────────────────
    for extra in sorted(live_rel - want_rel):
        report.add(Finding(
            CHECK, 'warn', f'live relation {extra} is created by no migration',
            detail='It exists only in the database. A rebuild from this repository would\n'
                   'not produce it. Adopt it into db/ or drop it.'))
    for extra in sorted(live_rpc - want_rpc):
        report.add(Finding(
            CHECK, 'warn', f'live function {extra}() is created by no migration',
            detail='Created outside the repository, most likely in the dashboard SQL editor.\n'
                   'An object nobody can account for is the one nobody dares remove later.'))

    # ── Columns ─────────────────────────────────────────────────────────────
    defs = spec.get('definitions') or {}
    for name in sorted(live_rel & want_rel):
        live_cols = set((defs.get(name, {}).get('properties') or {}).keys())
        if not live_cols:
            continue
        if name in schema.tables:
            want_cols = set(schema.tables[name].columns)
        else:
            want_cols = _view_columns(schema.views[name].body) or live_cols
        for c in sorted(want_cols - live_cols):
            report.add(Finding(
                CHECK, 'error', f'{name}.{c} is in the migrations but not in the live database',
                detail='A query selecting it fails against production right now.'))
        for c in sorted(live_cols - want_cols):
            report.add(Finding(
                CHECK, 'info', f'{name}.{c} exists live but no migration creates it',
                detail='A rebuild from this repository would not produce this column.'))

    # ── The browser-facing key must not be able to read private tables ──────
    # This is the one property that cannot be checked from the files at all:
    # RLS is only true or false of a running database.
    if not anon:
        report.add(Finding(
            CHECK, 'info', 'no publishable key configured — the RLS boundary was not probed'))
        return

    probed = 0
    for table in MUST_NOT_LEAK:
        if table not in live_rel:
            continue
        try:
            status, _h, body = _get(f'{base}/rest/v1/{table}?select=*&limit=1', anon)
        except urllib.error.HTTPError as e:
            if e.code in (401, 403):        # permission denied is the correct answer
                probed += 1
                continue
            status, body = e.code, b'[]'
        except (urllib.error.URLError, OSError):
            continue
        probed += 1
        try:
            rows = json.loads(body)
        except ValueError:
            rows = []
        if isinstance(rows, list) and rows:
            report.add(Finding(
                CHECK, 'error',
                f'the publishable key can READ {len(rows)} row(s) from {table}',
                detail='That key ships to every browser. This table is meant to be reachable\n'
                       'only with the secret key. Check its RLS policies and GRANTs.'))
    report.fact('live.rls_tables_probed', probed)
