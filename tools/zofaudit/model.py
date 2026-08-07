"""Findings, severities and the report they add up to.

One idea worth stating: a finding carries `evidence` — the literal text that
caused it. Reading "unused function" tells you nothing you can act on; reading
"unused function · drop function if exists public.submit_score(text, text,
integer)" tells you immediately whether the tool is right, and that is the
difference between a report someone acts on and a report someone dismisses.
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field, asdict
from typing import Iterable

# Ordered worst-first. The CLI's --min-severity compares by this index, and the
# exit code is derived from it, so the order is load-bearing.
SEVERITIES = ('error', 'warn', 'info')

_RANK = {s: i for i, s in enumerate(SEVERITIES)}

# ANSI, but only when the stream is a TTY — a redirected report must stay
# greppable, and escape codes in a CI log are noise.
_COLOR = {'error': '\033[31m', 'warn': '\033[33m', 'info': '\033[36m'}
_DIM = '\033[2m'
_BOLD = '\033[1m'
_OFF = '\033[0m'


@dataclass(frozen=True)
class Finding:
    """One thing that is wrong, with enough detail to check the tool's work."""

    check: str            # which check produced it, e.g. 'sql'
    severity: str         # 'error' | 'warn' | 'info'
    message: str          # what is wrong, in one line
    path: str = ''        # repo-relative, forward slashes
    line: int = 0         # 1-indexed; 0 when the finding is about a file as a whole
    evidence: str = ''    # the literal text that triggered it
    detail: str = ''      # optional second paragraph: why it matters / what to do

    def __post_init__(self):
        if self.severity not in _RANK:
            raise ValueError(f'unknown severity {self.severity!r}')

    @property
    def rank(self) -> int:
        return _RANK[self.severity]

    @property
    def where(self) -> str:
        if not self.path:
            return ''
        return f'{self.path}:{self.line}' if self.line else self.path

    def render(self, color: bool = False) -> str:
        sev = self.severity.upper().ljust(5)
        if color:
            sev = f'{_COLOR[self.severity]}{sev}{_OFF}'
        head = f'  {sev} {self.message}'
        out = [head]
        if self.where:
            loc = f'        {self.where}'
            out.append(f'{_DIM}{loc}{_OFF}' if color else loc)
        if self.evidence:
            ev = f'        > {self.evidence.strip()}'
            out.append(f'{_DIM}{ev}{_OFF}' if color else ev)
        if self.detail:
            for para in self.detail.strip().split('\n'):
                out.append(f'        {para}')
        return '\n'.join(out)


@dataclass
class Report:
    """Everything one run found, plus the facts the checks established.

    `facts` is not decoration. A check that finds nothing still learned
    something — how many tables survive the migration replay, how many routes
    the server registers — and printing that is what distinguishes "the check
    passed" from "the check silently did nothing", which is the failure mode
    every static tool eventually has.
    """

    findings: list[Finding] = field(default_factory=list)
    facts: dict = field(default_factory=dict)
    checks_run: list[str] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)   # checks that themselves blew up

    def add(self, *findings: Finding) -> None:
        self.findings.extend(findings)

    def extend(self, findings: Iterable[Finding]) -> None:
        self.findings.extend(findings)

    def fact(self, key: str, value) -> None:
        self.facts[key] = value

    def counts(self) -> dict:
        out = {s: 0 for s in SEVERITIES}
        for f in self.findings:
            out[f.severity] += 1
        return out

    def filtered(self, min_severity: str) -> list[Finding]:
        limit = _RANK[min_severity]
        keep = [f for f in self.findings if f.rank <= limit]
        # Worst first, then by location so repeated runs print identically —
        # a report that reorders itself cannot be diffed between commits.
        keep.sort(key=lambda f: (f.rank, f.check, f.path, f.line, f.message))
        return keep

    def to_json(self) -> str:
        return json.dumps(
            {
                'checks': self.checks_run,
                'counts': self.counts(),
                'facts': self.facts,
                'findings': [asdict(f) for f in self.findings],
                'check_errors': self.errors,
            },
            indent=2,
            sort_keys=True,
            default=str,
        )

    def render(self, min_severity: str = 'info', color: bool = False) -> str:
        shown = self.filtered(min_severity)
        out: list[str] = []

        # Scalars only. Structured facts — the dependency map is 90 edges — are
        # data for --json to query, and printing them here buries the findings
        # they sit above.
        scalars = {k: v for k, v in self.facts.items() if isinstance(v, (int, float, str, bool))}
        if scalars:
            title = 'What this run established'
            out.append(f'{_BOLD}{title}{_OFF}' if color else title)
            width = max(len(k) for k in scalars)
            for key in sorted(scalars):
                out.append(f'  {key.ljust(width)}  {scalars[key]}')
            structured = sorted(set(self.facts) - set(scalars))
            if structured:
                out.append(f'  (--json also carries: {", ".join(structured)})')
            out.append('')

        by_check: dict[str, list[Finding]] = {}
        for f in shown:
            by_check.setdefault(f.check, []).append(f)

        for check in sorted(by_check):
            title = f'{check} — {len(by_check[check])} finding(s)'
            out.append(f'{_BOLD}{title}{_OFF}' if color else title)
            for f in by_check[check]:
                out.append(f.render(color))
            out.append('')

        c = self.counts()
        hidden = len(self.findings) - len(shown)
        summary = (f'{c["error"]} error, {c["warn"]} warn, {c["info"]} info'
                   f' across {len(self.checks_run)} check(s)')
        if hidden:
            summary += f' ({hidden} below --min-severity {min_severity})'
        out.append(f'{_BOLD}{summary}{_OFF}' if color else summary)

        for e in self.errors:
            out.append(f'  CHECK FAILED: {e}')

        return '\n'.join(out)
