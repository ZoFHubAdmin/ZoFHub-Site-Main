#!/usr/bin/env python3
"""Entry point for the ZoFHub repository auditor.

    npm run audit:repo                 # every check, human-readable
    npm run audit:repo -- --json       # machine-readable, for CI or a diff
    npm run audit:repo -- sql env      # only the named checks
    npm run audit:repo -- --list       # what checks exist

Direct:  python tools/audit.py [checks…] [--json] [--min-severity warn]

WHY A LAUNCHER AND NOT A PACKAGE ENTRY POINT
tools/run-python.mjs runs `python <path>`, which puts the script's own directory
on sys.path. Pointing it at tools/zofaudit/__main__.py would put the package's
INSIDE on the path, and every intra-package import would fail. Pointing it here
puts tools/ on the path, so `import zofaudit` resolves the package normally.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from zofaudit.cli import main  # noqa: E402  (must follow the sys.path line)

if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
