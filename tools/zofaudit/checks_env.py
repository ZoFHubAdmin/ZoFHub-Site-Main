"""Environment variables: what the code reads, what the deploy sets, what is documented.

There is no schema for process.env. A variable is created by being typed, in one
file, and every other place that needs it has to spell it identically. The
failure is always silent — `process.env.ADSTERRA_TAG` when the deploy sets
`ADSTERRA_BANNER_TAG` is not an error, it is `undefined`, and the feature simply
does not appear. On this project that means an ad slot that never fills or a
provider that never loads, which looks exactly like "no ad was served".

So the three lists are compared: read in code, present in .env.example, declared
in render.yaml. A name in the first and neither of the others is the one that
bites.
"""
from __future__ import annotations

import re

from .model import Finding
from .repo import ROOT, read, rel, strip_js_comments, line_of, files_with_suffix

CHECK = 'env'

_ENV_READ = re.compile(r'process\.env\.([A-Z][A-Z0-9_]*)')
_ENV_INDEX = re.compile(r"process\.env\[\s*'([A-Z][A-Z0-9_]*)'\s*\]")

# Set by the platform or by Node itself, so their absence from .env.example is
# correct rather than an omission.
AMBIENT = {
    'NODE_ENV', 'PORT', 'HOST', 'NODE_VERSION', 'NODE_OPTIONS', 'TZ', 'HOME',
    'PATH', 'TEMP', 'TMP', 'CI',
    # Set by activating a Python virtualenv, never by a deployment.
    # tools/run-python.mjs reads it to prefer the project's own interpreter.
    'VIRTUAL_ENV',
}
# Prefixes the platform or the tooling injects. Render sets a dozen RENDER_*
# variables on every instance; none of them belongs in .env.example, and
# enumerating them means the list is wrong the next time Render adds one.
AMBIENT_PREFIXES = ('RENDER_', 'npm_', 'VERCEL_', 'GITHUB_')


def _is_ambient(name: str) -> bool:
    return name in AMBIENT or name.startswith(AMBIENT_PREFIXES)


def _declared_in_env_example() -> tuple[set[str], bool]:
    path = ROOT / '.env.example'
    if not path.exists():
        return set(), False
    # A COMMENTED assignment counts as declared. .env.example uses `# NAME=<how
    # to fill it in>` throughout for optional settings, deliberately, so that
    # copying the file to .env does not set them to empty. Treating those as
    # undeclared reports the file's own convention as an omission — it flagged
    # PROXY_SIDEBAR_TAG and PROXY_INCONTENT_TAG, both of which are documented
    # there with a worked example.
    names = set()
    for line in read(path).splitlines():
        m = re.match(r'#?\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=', line.strip())
        if m:
            names.add(m.group(1))
    return names, True


def _declared_in_render() -> tuple[set[str], bool]:
    path = ROOT / 'render.yaml'
    if not path.exists():
        return set(), False
    return set(re.findall(r'^\s*-\s*key:\s*([A-Z][A-Z0-9_]*)\s*$', read(path), re.M)), True


# Trailing context that means the read supplies its own answer when the variable
# is absent: a fallback (`|| 8080`, `?? ''`) or a comparison (`=== '1'`).
_HAS_DEFAULT = re.compile(r"""^[\s)\]]*(?:\.\w+\([^)]*\)[\s)\]]*)*(\|\||\?\?|===|!==|==|!=)""")


# The variable is itself somebody else's fallback: `SUPABASE_URL || NEXT_PUBLIC_…`.
# Being last in the chain means nothing follows it, which is not the same as
# having no default — the whole expression IS the default. Reading only forwards
# reported the last alternative of every such pair as a required variable.
_IS_A_FALLBACK = re.compile(r'(\|\||\?\?)\s*$')


def _is_optional(src: str, start: int, end: int) -> bool:
    """Does this read degrade gracefully when the variable is unset?

    It matters because the two cases need different reactions. An undeclared
    variable that is read bare is a deployment that will not work. An undeclared
    tunable with `|| 30_000` behind it works perfectly and is merely
    undocumented — reporting both at the same volume produced forty warnings, and
    forty warnings is a list nobody reads.
    """
    if _HAS_DEFAULT.match(src[end:end + 200]):
        return True
    return bool(_IS_A_FALLBACK.search(src[max(0, start - 200):start]))


def run(report) -> None:
    read_in: dict[str, tuple[str, int, bool]] = {}
    for path in files_with_suffix('.mjs', '.js', '.cjs'):
        name = rel(path)
        # Browser code has no process.env. Tests are excluded because they read
        # env to make ASSERTIONS about it — test/server.test.mjs lists every
        # secret name to prove none of them reaches the browser — and counting
        # those as configuration reported SCORE_SECRET, for a feature that was
        # retired, as a variable operators must set.
        if name.startswith(('public/js/', 'admin-ui/', 'test/')):
            continue
        src = strip_js_comments(read(path))
        for m in list(_ENV_READ.finditer(src)) + list(_ENV_INDEX.finditer(src)):
            # An ASSIGNMENT is not a read. Tools and tests set env vars.
            if re.match(r'\s*=[^=]', src[m.end():m.end() + 3]):
                continue
            var = m.group(1)
            optional = _is_optional(src, m.start(), m.end())
            prev = read_in.get(var)
            # One bare read anywhere makes the variable required, whatever the
            # other sites do.
            if prev is None:
                read_in[var] = (name, line_of(src, m.start()), optional)
            elif prev[2] and not optional:
                read_in[var] = (name, line_of(src, m.start()), False)

    example, has_example = _declared_in_env_example()
    render, has_render = _declared_in_render()

    report.fact('env.read_in_code', len(read_in))
    report.fact('env.in_env_example', len(example))
    report.fact('env.in_render_yaml', len(render))

    if not has_example:
        report.add(Finding(
            CHECK, 'warn', '.env.example is missing',
            detail='It is the only inventory of what a deployment has to set.'))
    if not has_render:
        report.add(Finding(CHECK, 'info', 'render.yaml is missing — deploy vars not cross-checked'))

    undocumented_optional = 0
    for name, (path, line, optional) in sorted(read_in.items()):
        if _is_ambient(name):
            continue
        if not has_example or name in example or (has_render and name in render):
            continue
        if optional:
            undocumented_optional += 1
            report.add(Finding(
                CHECK, 'info', f'{name} is an undocumented tunable (it has a default)',
                path=path, line=line,
                detail='Harmless unset, but nobody operating this can discover it exists.'))
        else:
            report.add(Finding(
                CHECK, 'warn', f'{name} is read with no fallback and declared nowhere',
                path=path, line=line,
                detail='Not in .env.example and not in render.yaml, so nothing tells an\n'
                       'operator to set it — and the code has no default. It will be\n'
                       'undefined in every deployment configured from those files.'))
    report.fact('env.undocumented_tunables', undocumented_optional)

    # The reverse direction is quieter but still worth one line: a variable an
    # operator is told to set, which nothing reads, is a configuration step that
    # can only ever waste someone's time. It found WEATHER_TTL_MS and
    # WEATHER_TIMEOUT_MS documented as "Weather grounding (lib/weather.mjs)" —
    # a module that no longer exists.
    #
    # Tests are excluded from the READ scan above but must be counted here, or
    # TEST_PORT — which exists precisely so the suite can avoid a port clash —
    # is reported as configuration nothing uses.
    in_tests = set()
    for path in files_with_suffix('.mjs', '.js'):
        if rel(path).startswith('test/'):
            in_tests |= {m.group(1) for m in _ENV_READ.finditer(read(path))}

    for name in sorted(n for n in example - set(read_in) - in_tests if not _is_ambient(n)):
        report.add(Finding(
            CHECK, 'info', f'{name} is in .env.example but nothing reads it',
            path='.env.example'))

    # .env itself must never be committed. This is cheap to check and expensive
    # to get wrong, so it is checked even though .gitignore covers it.
    gitignore = read(ROOT / '.gitignore')
    if (ROOT / '.env').exists() and not re.search(r'^\s*\.env\s*$', gitignore, re.M):
        report.add(Finding(
            CHECK, 'error', '.env exists but .gitignore does not list it',
            path='.gitignore',
            detail='A single `git add -A` publishes every live credential in it.'))
