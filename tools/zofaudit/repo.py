"""Repository discovery: what counts as this project's own source, and what does not.

The single most important decision in a static auditor is where it stops
looking. ZoFHub vendors five third-party applications into the tree (the GUST
proxy, Scramjet, Interstellar, NautilusOS, DayDream and the Suroi self-host kit)
and carries ~14 MB of generated SQL loaders. Auditing those produces hundreds of
findings about code nobody here wrote and nobody here can change, which buries
the handful of findings that are actionable.

So VENDORED and GENERATED are excluded by path, in one place, with a reason
recorded next to each entry. Everything else is fair game.
"""
from __future__ import annotations

import os
import re
from functools import lru_cache
from pathlib import Path

# tools/zofaudit/repo.py → tools/zofaudit → tools → repo root
ROOT = Path(__file__).resolve().parents[2]

# Directories that are not this project's source. The reason matters: without it
# the next person cannot tell an exclusion that is still correct from one that
# was a shortcut.
EXCLUDED_DIRS = {
    'node_modules':  'dependencies',
    '.git':          'vcs',
    '__pycache__':   'python bytecode',
    # A Python virtual environment is node_modules for Python, and it is easy to
    # forget because it appears only after someone runs `pip install`. When one
    # was created here it brought 786 third-party files into a 1,090-file scan —
    # 72% of the audit was suddenly other people's code, and the JSON check had
    # started parsing Pillow's SBOM and playwright's CLI help.
    '.venv':         'python virtualenv',
    'venv':          'python virtualenv',
    'site-packages': 'installed python packages',
    '.tox':          'python test environments',
    '.mypy_cache':   'type-checker cache',
    '.pytest_cache': 'test-runner cache',
    '.ruff_cache':   'linter cache',
    'logs':          'runtime output',
    'licenses':      'upstream licence texts, copied verbatim',
    'scramjet':      'vendored proxy engine (Mercury Workshop)',
    'Interstellar':  'vendored proxy app',
    'NautilusOS':    'vendored proxy app',
    'DayDream':      'vendored proxy app',
    'suroi':         'vendored GPL self-host kit',
    '.claude':       'agent scratch',
    '.vscode':       'editor config',
}

# Specific subtrees, matched as repo-relative prefixes.
EXCLUDED_PREFIXES = (
    ('public/gust/', 'vendored GUST proxy app — serves itself'),
)

SOURCE_EXTS = {'.js', '.mjs', '.cjs', '.html', '.css', '.json', '.sql', '.py', '.md', '.yaml', '.yml'}


def rel(path: Path) -> str:
    """Repo-relative, forward slashes — so a finding reads the same on any OS."""
    return str(path.relative_to(ROOT)).replace(os.sep, '/')


def is_excluded(path: Path) -> bool:
    r = rel(path)
    if any(part in EXCLUDED_DIRS for part in Path(r).parts):
        return True
    return any(r.startswith(p) for p, _ in EXCLUDED_PREFIXES)


@lru_cache(maxsize=1)
def source_files() -> tuple[Path, ...]:
    """Every file this project owns, sorted so runs are reproducible."""
    out: list[Path] = []
    for dirpath, dirnames, filenames in os.walk(ROOT):
        here = Path(dirpath)
        # Prune in place — walking into node_modules and discarding it afterwards
        # takes seconds on a cold cache for no benefit.
        dirnames[:] = sorted(d for d in dirnames if d not in EXCLUDED_DIRS)
        for name in sorted(filenames):
            p = here / name
            if p.suffix.lower() in SOURCE_EXTS and not is_excluded(p):
                out.append(p)
    return tuple(out)


def files_with_suffix(*suffixes: str) -> list[Path]:
    s = {x.lower() for x in suffixes}
    return [p for p in source_files() if p.suffix.lower() in s]


@lru_cache(maxsize=4096)
def read(path: Path) -> str:
    """Text of a file, or '' if it cannot be decoded.

    errors='replace' rather than a raise: one file with a stray byte must not
    stop the audit, and every check here works on ASCII-ish structure anyway.
    """
    try:
        return path.read_text(encoding='utf-8', errors='replace')
    except OSError:
        return ''


def line_of(text: str, index: int) -> int:
    """1-indexed line number of a character offset."""
    return text.count('\n', 0, index) + 1


# ---------------------------------------------------------------------------
# Comment stripping
# ---------------------------------------------------------------------------
# This project comments heavily, and several comments QUOTE the code they warn
# about — public/js/game-of-the-day.js has one that reads `No inline onerror="…"
# here`. Any scanner that does not strip comments first will flag the file that
# documents avoiding the very thing being searched for. That is not a
# hypothetical: it happened, twice, to the checks in test/page-structure.test.mjs.
#
# The replacement preserves NEWLINES so reported line numbers stay correct. A
# strip that collapses lines makes every location in the report wrong by a
# growing offset, which is worse than not reporting a location at all.

def _blank_like(chunk: str) -> str:
    return '\n' * chunk.count('\n')


# A `/` in JavaScript is a regex literal or a division sign depending on what
# came before it, and nothing but context distinguishes them. Getting this wrong
# is not cosmetic: server.js is full of patterns like /^\/api\/(games|play)/,
# and a scanner that treats those parentheses as code cannot balance a block.
# That is exactly what happened — every route handler's extent ran past its own
# route, and the check for blocking filesystem calls inside handlers reported
# twenty findings, all of them module-init code, none of them true.
#
# The rule below is the one minifiers use: after a value (identifier, number,
# closing bracket) a `/` divides; after an operator, a punctuator or a keyword
# it opens a regex.
_VALUE_END = re.compile(r'[\w$)\]]$')
_REGEX_KEYWORDS = {
    'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void',
    'throw', 'case', 'do', 'else', 'yield', 'await',
}


def _regex_can_start_here(src: str, i: int) -> bool:
    j = i - 1
    while j >= 0 and src[j] in ' \t\r\n':
        j -= 1
    if j < 0:
        return True
    if not _VALUE_END.match(src[j]):
        return True
    # A word character can still end a keyword rather than a value.
    k = j
    while k >= 0 and (src[k].isalnum() or src[k] in '_$'):
        k -= 1
    return src[k + 1:j + 1] in _REGEX_KEYWORDS


def _js_spans(src: str):
    """Yield (kind, start, end) for comments and literals. kind is
    'line', 'block', 'string', 'template' or 'regex'."""
    i, n = 0, len(src)
    while i < n:
        c = src[i]
        if c == '/' and i + 1 < n and src[i + 1] == '/':
            j = src.find('\n', i)
            j = n if j == -1 else j
            yield ('line', i, j)
            i = j
        elif c == '/' and i + 1 < n and src[i + 1] == '*':
            j = src.find('*/', i + 2)
            j = n if j == -1 else j + 2
            yield ('block', i, j)
            i = j
        elif c in '\'"':
            j = i + 1
            while j < n and src[j] != c:
                if src[j] == '\\':
                    j += 1
                elif src[j] == '\n':
                    break               # unterminated; treat the line as the end
                j += 1
            j = min(j + 1, n)
            yield ('string', i, j)
            i = j
        elif c == '`':
            j, depth = i + 1, 0
            while j < n:
                if src[j] == '\\':
                    j += 2
                    continue
                if src[j] == '$' and j + 1 < n and src[j + 1] == '{':
                    depth += 1
                    j += 2
                    continue
                if src[j] == '}' and depth:
                    depth -= 1
                elif src[j] == '`' and not depth:
                    break
                j += 1
            j = min(j + 1, n)
            yield ('template', i, j)
            i = j
        elif c == '/' and _regex_can_start_here(src, i):
            j, in_class = i + 1, False
            while j < n:
                if src[j] == '\\':
                    j += 2
                    continue
                if src[j] == '[':
                    in_class = True
                elif src[j] == ']':
                    in_class = False
                elif src[j] == '/' and not in_class:
                    break
                elif src[j] == '\n':
                    j = i            # not a regex after all — back out
                    break
                j += 1
            if j <= i:
                i += 1
                continue
            j += 1
            while j < n and src[j] in 'dgimsuvy':      # flags
                j += 1
            yield ('regex', i, j)
            i = j
        else:
            i += 1


def _blank_span(out: list, a: int, b: int) -> None:
    for k in range(a, b):
        if out[k] != '\n':
            out[k] = ' '


def strip_js_comments(src: str) -> str:
    """Remove // and /* */ comments, leaving literals and line count intact."""
    out = list(src)
    for kind, a, b in _js_spans(src):
        if kind in ('line', 'block'):
            _blank_span(out, a, b)
    return ''.join(out)


def strip_html_comments(src: str) -> str:
    return re.sub(r'<!--.*?-->', lambda m: _blank_like(m.group(0)), src, flags=re.DOTALL)


def mask_js_strings(src: str) -> str:
    """Comments AND string CONTENTS blanked, quotes and length preserved.

    For structural scanning — matching braces, finding the end of a function —
    where a parenthesis inside a string literal is not a parenthesis. Without
    this, balancing the body of `app.get('/play/:gameSlug', …)` runs past the end
    of the handler on the first `'(('` in a regex or a message, and every finding
    after that point is attributed to the wrong route. That is not hypothetical:
    it reported the same readFileSync under two different routes at once, which
    is how it was noticed.

    Offsets and line numbers are identical to the input, so a match found here
    can be reported against the original text.
    """
    out = list(src)
    for kind, a, b in _js_spans(src):
        if kind in ('line', 'block'):
            _blank_span(out, a, b)
        else:                       # literal: keep the delimiters, blank the middle
            _blank_span(out, a + 1, max(a + 1, b - 1))
    return ''.join(out)


def js_brackets_balance(src: str) -> dict:
    """Net bracket counts of a masked source — a self-test for the scanner.

    A whole, syntactically valid module must come out at zero on every kind. If
    it does not, the masker is mis-reading something, and every check that
    balances a block on it is quietly wrong. Cheap to compute, so the tests
    assert it rather than trusting the scanner.
    """
    pairs = {'(': ')', '[': ']', '{': '}'}
    net = {k: 0 for k in pairs}
    closing = {v: k for k, v in pairs.items()}
    for ch in mask_js_strings(src):
        if ch in pairs:
            net[ch] += 1
        elif ch in closing:
            net[closing[ch]] -= 1
    return net
