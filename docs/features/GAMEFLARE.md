# GameFlare: a catalog that is empty on purpose

> **Current state: 0 games are public, by design.** The boot log says so in one
> line — `[gameflare] 298 record(s), 0 playable — public catalog is empty by
> design`. That is the correct result of the rules below, not a bug to be fixed
> by relaxing them.

GameFlare is a second, **separate** game catalog with its own dataset, its own
player and its own verification pipeline. It shares nothing with the main
catalog (`CATALOG`), because its embedding terms are stricter than anything the
main catalog's machinery was built for.

| | |
|---|---|
| Dataset | [`data/gameflare_verified_games.json`](../../data/gameflare_verified_games.json) — 1.4 MB, **treated as untrusted input** |
| Validation | [`lib/gameflare-catalog.mjs`](../../lib/gameflare-catalog.mjs) — pure, no I/O |
| Embed discovery | [`lib/gameflare-embed-extract.mjs`](../../lib/gameflare-embed-extract.mjs), [`tools/gameflare-embed-discovery.mjs`](../../tools/gameflare-embed-discovery.mjs) |
| Verification | [`lib/gameflare-state.mjs`](../../lib/gameflare-state.mjs), [`lib/gameflare-verify.mjs`](../../lib/gameflare-verify.mjs), [`tools/gameflare-verify.mjs`](../../tools/gameflare-verify.mjs) |
| Player | [`public/gameflare-play.html`](../../public/gameflare-play.html), [`public/js/gameflare-player.js`](../../public/js/gameflare-player.js) |
| Catalog page | [`public/gameflare.html`](../../public/gameflare.html), [`public/js/gameflare-catalog.js`](../../public/js/gameflare-catalog.js) |
| CI | [`.github/workflows/gameflare-verify.yml`](../../.github/workflows/gameflare-verify.yml) — **manual only** |

---

## 1. The one rule

A record is publicly exposable **if and only if**:

1. it is in the dataset's top-level `games` array, **and**
2. its `iframe_compatibility.status` is **exactly** `"verified_working"`.

Nothing else qualifies — not `not_testable`, not any `failed_*` status, not a
record that merely looks complete.

As supplied, that yields zero:

```
games               0
failed_games        3    (blank_screen, network_dependency, legacy_technology)
not_testable_games  295
───────────────────────
298 traceability records, 0 exposable
```

289 of the 295 not-testable entries are discovery candidates with
`embed_url: null` — they were never iframe-tested. The dataset says so itself:
`integration_readiness.ready_for_public_catalog = false`. The code implements
that verdict rather than working around it.

---

## 2. URLs are taken, never made

The dataset's own embedding policy forbids constructing an embed URL by
transforming a page URL. So this code **never builds a URL**:

- the iframe `src` is the record's **exact** `embed_url`;
- the card image is its **exact** `thumbnail_url`;
- there is **no** normalisation, **no** derivation from the slug or the
  canonical page, and **no fallback URL** — a fallback is how an unverified
  endpoint reaches an iframe.

Both are checked against fixed, https-only **prefixes**, and a record fails as a
whole if either does:

| Field | Allowed prefix |
|---|---|
| `embed_url` | `https://www.gameflare.com/embed/` |
| canonical page | `https://www.gameflare.com/online-game/` |
| `thumbnail_url` | `https://data.gameflare.com/` |

**Prefixes, not regular expressions,** on purpose.
`https://www.gameflare.com.evil.test/embed/` matches a careless
`gameflare\.com.*embed` pattern and is a different origin. `startsWith` on a full
scheme + host + path cannot be fooled that way, because the host is pinned
before the first variable position.

Route slugs are attacker-controlled strings, so they are constrained to the
shape the dataset actually uses rather than decoded and trusted. Anything else
renders the first-party not-found state.

---

## 3. The player — deliberately not `/play/:slug`

GameFlare has its own route, `/gameflare/play/:slug`, instead of reusing the
main player. The main `/play` route sends some hosts through the embed proxy, and
the GameFlare policy forbids proxying, mirroring or modifying an embed. Reusing
it would break that rule silently the moment the proxy path applied.

The player keeps four rules ([`gameflare-player.js`](../../public/js/gameflare-player.js)):

| Rule | Why |
|---|---|
| **Exact `embed_url`, nothing else.** If it can't be resolved, a first-party message — never a navigation | a fallback is an unverified endpoint |
| **No `window.open`, no `target="_blank"`, no parent navigation** to gameflare.com | a failed load is a message in this page, not an escape hatch to theirs |
| **Nothing injected into the frame, nothing layered over it.** GameFlare's own bottom bar stays visible | the embed is theirs, unmodified |
| **No `sandbox` attribute** | the dataset verified these embeds *without* one; adding one turns a tested configuration into an untested one |

**A `load` event proves nothing about the game.** The frame is cross-origin:
`load` means the browser fetched a document, not that a game initialised, and the
parent cannot look inside. So `load` is a loading signal only, and nothing on the
page ever claims a game was verified as playable.

### Advertising: none, structurally

The dataset marks `commercial_use` as `not_verified`, and external advertising
around the embed as *"unclear; do not show external advertising around GameFlare
embeds unless written permission is obtained."*

So:

- `/gameflare` is **not** in the ad registry's native-surface list, and an
  unclassified route gets no ads ([ADVERTISING.md](ADVERTISING.md));
- the player page contains two ad slots **above and below** the frame that are
  `hidden` and **rendered by nothing**. They exist only so that a future,
  *written* authorisation has a place to go that does not overlay the iframe.

---

## 4. Getting from 0 to 1: discovery, then verification

### Step 1 — discover the embed URL GameFlare itself publishes

```bash
npm run gameflare:embeds                 # every record missing an embed_url
npm run gameflare:embeds -- --slug NAME  # just one
npm run gameflare:embeds -- --recheck    # revisit ones already resolved
```

Writes [`data/gameflare-embed-discovery.json`](../../data/gameflare-embed-discovery.json).

The **only** legitimate source for a missing `embed_url` is the URL GameFlare
publishes on the game page, read in this order:

1. the **"Embed code" widget** — a `<textarea>` holding GameFlare's own
   `<iframe src="…">` snippet. This decides;
2. the page's own `#iframe-in-game` player. This cross-checks.

A disagreement between them is **reported, not resolved** — "the page shows one
URL and offers another" is a fact a human should see.

`https://www.gameflare.com/embed/${slug}/` is **never** assembled, even when the
pattern is obvious and would produce the identical string. A guess that happens
to be right is still a guess, and carries no evidence the endpoint exists.

**GameFlare serves missing games as HTTP 200** with an `ERROR 404 / PAGE DOES
NOT EXIST` body, so existence is decided by the page text, not the status code.
A Cloudflare interstitial is recognised and never parsed as a game page.

| Discovery status | Meaning |
|---|---|
| `missing_embed_url` | not yet looked at |
| `embed_url_found` | the page published one, and it passes the prefix check |
| `embed_url_invalid` | the page published one that fails the prefix check |
| `embed_url_unavailable` | the game is gone, publishes no embed code, or could not be read — the reason is kept, because only some of those are worth retrying |

**A discovered URL grants no eligibility.** It makes a record *testable*. It is
applied as an overlay that only fills fields the dataset left `null`.

### Step 2 — verify in a real browser

```bash
npm run gameflare:verify                    # the candidate pool
npm run gameflare:verify -- --slug a,b,c    # specific games
npm run gameflare:verify -- --resume        # keep earlier results, test the rest
```

Writes [`data/gameflare-verification.json`](../../data/gameflare-verification.json)
and screenshots under `verification-evidence/<slug>/`.

It drives **this site's own player route** in Chromium, clicks GameFlare's
in-frame Play control, sits through whatever advertisement appears, and then
decides whether a real game came up behind it.

---

## 5. How verification decides — and the failure it was rebuilt against

The first detector asked one question of one screenshot: *are these pixels
varied?* It reported **7 of 9 candidates as verified.** Opening the screenshots
showed LinkedIn and Popeyes **video advertisements** counting down `00:02 / 00:30`.
A video ad is the richest possible frame; "not blank" was measuring the ad.

**Rich pixels are not a game**, and that heuristic does not appear anywhere now.
Nor does "HTTP 200" — a status code proves a server answered, not that a game
runs.

Instead, a state machine ([`gameflare-state.mjs`](../../lib/gameflare-state.mjs))
combines three layers that would not fail together:

| Layer | What it reads |
|---|---|
| **DOM** | the ad container and its countdown, the `<video>` and its `currentTime`, the game `<canvas>` and its size, the Ruffle element |
| **Frames** | nested ad frames (the IMA SDK loads one) and their URLs |
| **Pixels** | the frame's luminance distribution, and change between samples |

Playwright drives Chromium over CDP, so it can **read** a cross-origin child
frame that page JavaScript never could. Every such call is a read — nothing is
injected or modified, and **the shipped site does none of this**; it exists only
in the test harness.

The DOM layer is decisive. If it ever becomes unreadable, evidence degrades to
pixels only, which is **explicitly too weak to reach `game_playable`**. Losing the
ability to observe must produce "I cannot tell", never "it is fine".

**A pass requires a game surface appearing strictly *after* the last ad sample.**
A canvas that was there all along proves no transition happened.

### States and outcomes

```
iframe_loading → gameflare_page → ad_playing → ad_finished
              → game_loading → game_initialized → game_playable   (or game_failed / unknown)
```

Failures are **not** collapsed into one "failed", because they call for different
actions — retry, drop, or never touch the title again:

| Outcome | Meaning |
|---|---|
| `verified_working` | a game surface appeared after the ad and passed the checks |
| `failed_ad_timeout` | the ad never ended — **retryable** |
| `failed_blank_after_ad` | the ad ended and nothing came up |
| `failed_game_initialization` / `failed_gameplay` / `failed_runtime` | a game started and broke |
| `failed_new_tab` / `failed_new_window` / `failed_parent_navigation` | it tried to escape the frame — never retried |
| `failed_network` | a condition of the moment — **retryable** |
| `failed_legacy_technology` | e.g. a Flash title Ruffle never brings up |
| `not_testable` | could not be exercised at all — **retryable** |

Only those three are retried (`TRANSIENT` in `gameflare-verify.mjs`). A timeout
or a network fault is a condition of the moment; a game that opens a tab will
open one every time.

### Observed sequence (measured 2026-08-15)

```
t=0     landing page in-frame, a PLAY GAME control, no canvas, no ad
t+4s    #adinplay-container is inserted
t+7s    "Loading advertisement"
t+10s   countdown 00:00 / 00:30, a <video> from a CDN plays
t+40s   the ad container hides
then    sprunki-phase-6  → a live 933×700 canvas     (game_playable)
        monopoly-online  → a Ruffle element, no canvas, permanently (game_failed)
```

### Leave concurrency at 1

It is a correctness setting, not a speed knob. Every candidate sits through a real
video ad, and parallel browsers starve each other's video decode. Measured on the
same nine games, the observed ad duration went **32 s at 1 → 35–55 s at 2 → ~70 s
at 3**, and titles that pass alone (`sprunki-phase-6`) timed out or reported blank
alongside others. Raising it manufactures false negatives. Budget ~75 s per
candidate.

---

## 6. Where verification runs — and where it cannot

**Not on the deployed service.** Render installs with `npm ci --omit=dev`, and
Playwright is a dev dependency, so Chromium does not exist in production. That is
deliberate: a 300 MB browser has no business in a request-serving process, and
~90 s per candidate is not work a web process should hold open.

| Where | How |
|---|---|
| Locally | `npm install --include=dev`, `npx playwright install chromium`, then the commands above |
| GitHub Actions | the **GameFlare verification** workflow, `workflow_dispatch` only — inputs `slugs`, `limit` (default 9), `concurrency` (default **1**) |

The workflow uploads results and screenshots as an artifact **for a human to
inspect**. It writes nothing to the live catalog.

**There is no schedule, and no promotion path yet.** The rotation system this
would feed — active slots, periodic refresh, promotion and retirement — is
deliberately **not built** until the verifier is trustworthy and the candidate
pool is known to contain real games. The server reads only the supplied dataset,
never `gameflare-verification.json`, so a pass changes nothing public on its own.

### Read the screenshots before believing a pass

Three separate rounds of false positives — a black frame, a pre-roll video ad,
and a loading splash with a banner on it — were each caught by opening
`verification-evidence/<slug>/` and looking. **A pass is evidence from one
browser, on one machine, at one moment.** It is not a guarantee.

---

## 7. The verification preview (off by default)

Structurally valid records that are *not* verified form the **candidate pool**
(currently 291 of 298, 282 of them via recovered embed URLs). They are **never
served publicly**.

The only way to open one is the player's **verification preview**, which requires
`GAMEFLARE_VERIFY_TOKEN`, supplied as an `x-gameflare-verify` header or a
`?verify=` parameter and compared with `timingSafeEqual`. Prefer the header: a
query-string token is written to the host's access log. **Unset — the
default, including production — means the preview does not exist at all**, rather
than merely being hard to guess. Set it for a verification run, then unset it.

No public request can trigger discovery, verification or a refresh: those are
command-line and manual-workflow operations only.

---

## 8. Routes

| Route | What |
|---|---|
| `GET /gameflare` | the catalog page — an honest empty state today |
| `GET /gameflare/play/:slug` | the internal player |
| `GET /api/gameflare/games` | exposable records only (sorts: `rank` (default), `rating`, `plays`, `name`) |
| `GET /api/gameflare/games/:slug` | one exposable record |
| `GET /api/admin/gameflare-audit` | admin only — dataset counts, `publicCatalogEmpty`, and up to 200 rejected records with their reasons |

---

## 9. Verification status of this document

Every rule above is read from the source files listed at the top. The dataset
counts (298 / 0 / 3 / 295 / 289) and the candidate-pool figures come from the
modules' own headers and the server's boot log. The ad-duration and timing
measurements were taken on 2026-08-15 and are recorded in the module headers;
they were **not** re-measured for this document.

---

**Related:** [documentation map](../README.md#-documentation) · [commands](../guides/COMMANDS.md#️-gameflare-verification-separate-from-the-main-catalog) · [the ad boundary](ADVERTISING.md) · [how the main catalog's embeds load](IFRAME-OPTIMIZATION-GUIDE.md)
