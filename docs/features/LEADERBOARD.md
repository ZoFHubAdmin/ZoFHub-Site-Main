# The leaderboard: trusting a number a stranger typed

> **Status: pending on the live project.** The `scores` table is created by
> `db/scores-restore.sql`, which has not yet been applied (see
> [RUN-IN-ORDER.md §1b](../database/RUN-IN-ORDER.md#1b-if-the-audit-reports-missing-tables)).
> Until it is, `/leaderboard` shows **"not installed"** and the game page shows no
> submit button. Nothing is broken; the feature is simply switched off by the
> absence of its table.

| | |
|---|---|
| Rules | [`lib/scores.mjs`](../../lib/scores.mjs) — pure, no database, no Express |
| Submit UI | [`public/js/score-submit.js`](../../public/js/score-submit.js), on every game page |
| Board | `/leaderboard` ([`public/js/leaderboard.js`](../../public/js/leaderboard.js)); `?game=<slug>` for one game |
| Schema | migrations 2, 3, 4, 5, 10 and 12 — see [RUN-IN-ORDER.md](../database/RUN-IN-ORDER.md#the-17-migrations-in-order) |
| Retention | the nightly `score-prune` job, 03:55 UTC |

---

## 1. The honest premise

Every game on this site runs in a **cross-origin iframe** served by its
publisher. There is no way to read a real score out of one. So every score here
is **player-reported** — not as a shortcut, but because it is the only thing
possible.

That sets the threat model, stated plainly in the code:

> **None of this makes a self-reported score true. It makes a fake score cost
> something.**

To get a number onto the public board you must have opened the game, waited a
plausible length of time, used a token that works once, and landed inside a
believable range. Anything outside that is held back rather than shown and
quietly believed.

---

## 2. Proof of play

```
open /play/<slug>  ──►  POST /api/scores/session { slug }  ──►  one-time token
       … play …
click Submit       ──►  POST /api/scores { slug, score, player_name, token }
```

- **The token is requested when the page opens, not when you click submit.** The
  gap between the two is how the server tells a finished run from a script that
  posted a number the instant it loaded the page.
- **Single use.** A second submission with the same token fails, so one opened
  game cannot become a stream of submissions.
- **Bound to the game.** A token issued for one slug does not work for another.
- **Held in memory**, 6-hour lifetime (`SCORE_SESSION_TTL_MS`), at most 20,000
  outstanding. It must work with no database, and a token that outlives a restart
  is not worth storing.
- **Bounded per address.** Each requesting address (a keyed hash of the client
  IP) gets its own FIFO slice — `SCORE_SESSION_MAX_PER_OWNER`, default 2,000,
  sized so a whole school NAT fits. Past it, that address's *own* oldest token is
  dropped. The earlier design shed the globally-oldest token instead, so one
  address issuing tokens quickly could quietly evict everyone else's and their
  next score would fail as "unknown or expired" with nothing to explain it.

The name field is **prefilled** with the device-local identity
([`identity.js`](../../public/js/identity.js)) — a generated name like
`SwiftFalcon1234` — and **can be edited**, up to 40 characters. The board keeps
**one row per name per game** (a unique index on `slug, player_name`): a better
score updates that row in place, a worse one does not replace it.

That also means a name is not an identity. Editing it produces a separate row, so
the de-duplication is per *name*, not per person. The play token, the timing
check and the plausibility checks are what make a fake cost something — the name
is presentation.

> `identity.js`'s own header says there is "no free-text name to spoof". That was
> true of the original design; the submit dialog now lets the name be edited, so
> this document describes the current behaviour instead.

---

## 3. What counts as a plausible score

| Check | Default | Setting | Result when it fails |
|---|---:|---|---|
| Absolute ceiling | 1,000,000,000 | `SCORE_MAX` | quarantined — `above_absolute_ceiling` |
| Minimum time played | 8 s | `SCORE_MIN_PLAY_MS` | quarantined — `submitted_too_fast` |
| Outlier factor | 10× the board's best | `SCORE_OUTLIER_FACTOR` | quarantined — `far_above_existing_board` |

**An empty board only applies the ceiling** — otherwise the very first honest
player would be quarantined for having no predecessors.

**Input is parsed strictly, not generously.** `Number()` accepts `'1e9'`,
`'0x10'`, `'12abc'` and `Infinity`; the score parser rejects all of them, plus
negatives and fractions. Surrounding whitespace *is* trimmed, because this is
typed by a person and a trailing space is a typo, not an attack. A player name
that is not a string (`{"$ne": null}`, `["x"]`) becomes the default rather than
travelling a different code path, and control characters are stripped because
the name is rendered next to other people's.

---

## 4. Quarantine — and what the player is told

A score that fails a check is stored with `status = 'flagged'`, a
`flag_reason`, and `flag_evidence` (why, in reviewable detail). It is **never
shown on the public board**: the row-level-security policy exposes only
`status = 'ok'` rows, and the evidence columns are never selected publicly.

**The player is told the truth.** A quarantined submission answers
*"Score saved but held for review — it is unusually high for this game"* — never
a silent success, and never a place on a board it is not actually on. A score
shown as posted when it is actually held is a lie the player would repeat to
their friends.

Each row also carries `ip_tag`: a **keyed HMAC** of the submitter's address,
never the address itself. It exists so that a cluster of outliers from one source
can be correlated, and it cannot be reversed into an IP.

### Ranking

Score descending, then **earliest submission first**, so a tie goes to whoever
got there first rather than to whatever order the database returned. Equal scores
share a rank — `1, 2, 2, 4` — which is what a reader expects a leaderboard to mean.

Public rows are stripped to what a board needs: the database `id` and
`created_at` are removed, because a sequential id leaks how many scores exist.

---

## 5. Retention

The nightly **`score-prune`** job (03:55 UTC) calls `prune_scores()`, which:

1. **deletes quarantined (`flagged`) scores older than 7 days**, and
2. keeps only the **top 200 visible scores per game** (`SCORES_KEEP_PER_GAME`).

Flagged rows are excluded from that top-200 ranking, so a fake outlier can never
hold a slot that belongs to a real score.

> **Corrected 2026-09-26.** Earlier versions of these documents said quarantined
> scores were "never silently deleted". That described migration 4, whose
> `prune_scores()` kept unreviewed rows indefinitely. The function has been
> redefined four times, each `CREATE OR REPLACE` superseding the last, and the
> version that actually runs is migration 12's — which purges them after a week.

**There is no review screen.** No admin route lists or approves flagged scores,
so in practice a quarantined score is hidden and then removed. That is a
defensible outcome for an implausible self-reported number, but it should be
understood as *expiry*, not *review*.

---

## 6. Routes

| Route | What |
|---|---|
| `POST /api/scores/session` | issue a one-time play token for a known slug. Rate-limited |
| `POST /api/scores` | submit. `429` rate-limited · `400` malformed · `403` bad/used/expired token · `503` leaderboard not installed · `502` save failed |
| `GET /api/scores` | the public board; `?slug=` for one game, `limit` 1–100 (default 25). Answers `available: false` when the table is missing |
| `GET /leaderboard` | the page. Renders **not installed**, **empty** and **failed** as three different things |

---

## 7. Configuration

```bash
# SCORE_MAX=1000000000            # absolute ceiling
# SCORE_MIN_PLAY_MS=8000          # minimum plausible play time
# SCORE_SESSION_TTL_MS=21600000   # play-token lifetime (6 h)
# SCORE_OUTLIER_FACTOR=10         # quarantine above N× the board's best
# SCORES_KEEP_PER_GAME=200        # rows kept per game by the nightly prune
```

All optional; the defaults above apply when unset.

---

**Related:** [documentation map](../README.md#-documentation) · [the schema history](../database/RUN-IN-ORDER.md) · [visitor identity and other visitor features](VISITOR-FEATURES.md) · [the ten scheduled jobs](../guides/HOW-IT-WORKS.md#11-the-night-shift--ten-scheduled-jobs-libcron-jobsmjs)
