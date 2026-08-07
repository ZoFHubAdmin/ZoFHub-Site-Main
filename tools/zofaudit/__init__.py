"""zofaudit — a static auditor for the ZoFHub repository.

WHAT THIS IS FOR
The project has no build step, no framework and no type checker, which is a
deliberate and defensible choice: it means a clone runs with `npm i && npm
start`. The cost is that a whole class of mistake has nothing watching for it —
a query against a table the schema no longer has, a route the frontend calls
that the server never registered, an env var read in code and named nowhere, a
`drop function` whose signature matches nothing.

Every one of those is decidable from the repository alone. This package decides
them, so the answer comes from running a command rather than from remembering.

STDLIB ONLY, ON PURPOSE
Nothing here imports anything outside the Python standard library. The other
Python tools in tools/ need requests, Pillow and bs4 to do their jobs, and
tools/requirements.txt exists for them. An auditor is different: it is the thing
you want to run on a fresh clone, in CI, or on a machine you have just been
handed, and "first install four packages" is exactly when it does not get run.

FINDINGS ARE EVIDENCE, NOT OPINION
Every check reports a file and a line, and says what is wrong rather than what
would be nicer. A checker that produces false positives gets muted, and a muted
checker is worse than no checker because it looks like coverage. Where a check
cannot be sure, it says so in the message and reports at INFO.
"""

__all__ = ['cli', 'model', 'repo']
