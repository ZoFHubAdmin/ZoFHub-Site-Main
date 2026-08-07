"""Command line: pick checks, run them, print or serialise the report.

Exit codes are the contract. 0 = clean at the chosen threshold, 1 = findings at
or above it, 2 = the auditor itself failed. A tool whose exit code does not
distinguish "nothing wrong" from "I could not tell" cannot be wired into
anything, and this one is meant to be wired into things.
"""
from __future__ import annotations

import sys
import time

from .model import Report, SEVERITIES

# name → (module attribute, one-line description). Imported lazily so a syntax
# error in one check cannot stop the others from running.
CHECKS = {
    'sql':    ('checks_sql',    'replay the migrations; hold every Supabase call against the result'),
    'live':   ('checks_live',   'compare the RUNNING database against the migrations (needs credentials)'),
    'json':   ('checks_json',   'parse and shape-check every JSON file the app loads'),
    'env':    ('checks_env',    'environment variables: read in code, documented, defaulted'),
    'api':    ('checks_api',    'routes the server registers vs paths the browser requests'),
    'deps':   ('checks_deps',   'module import graph: cycles, orphans, missing targets'),
    'assets': ('checks_assets', 'files shipped in public/ that nothing references'),
    'perf':   ('checks_perf',   'patterns that cost time or correctness at scale'),
}

USAGE = """\
usage: python tools/audit.py [check…] [options]

checks (default: all)
{checks}

options
  --json                 emit the report as JSON on stdout
  --min-severity LEVEL   error | warn | info   (default: info)
  --fail-on LEVEL        exit 1 at or above this level (default: error)
  --list                 print the check names and exit
  -h, --help             this text
"""


def _usage() -> str:
    width = max(len(k) for k in CHECKS)
    lines = '\n'.join(f'  {k.ljust(width)}  {v[1]}' for k, v in sorted(CHECKS.items()))
    return USAGE.format(checks=lines)


def _force_utf8() -> None:
    """Windows consoles default to cp1252, which cannot encode an arrow.

    Without this the auditor dies with a UnicodeEncodeError partway through
    printing — on the platform this project is developed on. errors='replace'
    rather than a hard switch, because a console that genuinely cannot render a
    character should show a box, not take the report down with it.
    """
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding='utf-8', errors='replace')
        except (AttributeError, ValueError, OSError):
            pass


def main(argv: list[str]) -> int:
    _force_utf8()
    want: list[str] = []
    as_json = False
    min_severity = 'info'
    fail_on = 'error'

    it = iter(range(len(argv)))
    i = 0
    while i < len(argv):
        arg = argv[i]
        if arg in ('-h', '--help'):
            print(_usage())
            return 0
        if arg == '--list':
            for name, (_mod, desc) in sorted(CHECKS.items()):
                print(f'{name}\t{desc}')
            return 0
        if arg == '--json':
            as_json = True
        elif arg in ('--min-severity', '--fail-on'):
            i += 1
            if i >= len(argv) or argv[i] not in SEVERITIES:
                print(f'{arg} needs one of: {", ".join(SEVERITIES)}', file=sys.stderr)
                return 2
            if arg == '--min-severity':
                min_severity = argv[i]
            else:
                fail_on = argv[i]
        elif arg.startswith('-'):
            print(f'unknown option: {arg}\n', file=sys.stderr)
            print(_usage(), file=sys.stderr)
            return 2
        elif arg in CHECKS:
            want.append(arg)
        else:
            print(f'unknown check: {arg}. Try --list.', file=sys.stderr)
            return 2
        i += 1

    selected = want or sorted(CHECKS)
    report = Report()
    t0 = time.time()

    for name in selected:
        module_name = CHECKS[name][0]
        try:
            module = __import__(f'zofaudit.{module_name}', fromlist=['run'])
            module.run(report)
            report.checks_run.append(name)
        except Exception as exc:            # one broken check must not hide the rest
            report.errors.append(f'{name}: {type(exc).__name__}: {exc}')

    report.fact('run.seconds', round(time.time() - t0, 2))

    if as_json:
        print(report.to_json())
    else:
        print(report.render(min_severity, color=sys.stdout.isatty()))

    if report.errors:
        return 2
    limit = SEVERITIES.index(fail_on)
    return 1 if any(f.rank <= limit for f in report.findings) else 0
