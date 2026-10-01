# GameDistribution import: the whole catalog, screened for licensing

> **Weekly, automatic, and behind the review queue.** Clean games can publish
> themselves; any game that names a third-party trademark waits for a person.
> Nothing runs until the control-plane migration is applied
> ([CONTROL-PLANE.md §1](../admin/CONTROL-PLANE.md#1-before-it-works-apply-the-migration)).

| | |
|---|---|
| Importer | [`lib/gamedistribution-import.mjs`](../../lib/gamedistribution-import.mjs) |
| Trademark list | [`lib/trademark.mjs`](../../lib/trademark.mjs) — shared with the grow job and the Y8 ingest |
| Command line | `npm run gd:import` ([`tools/gamedistribution-import.mjs`](../../tools/gamedistribution-import.mjs)) |
| Schedule | weekly, Sundays 05:00 UTC (`gd-import` in `lib/cron-jobs.mjs`) — gated by `catalog.gd_auto_import` |
| Console | Content → **GameDistribution import…** (needs `games.import`); Review for held games |
| Tests | [`test/gamedistribution-import.test.mjs`](../../test/gamedistribution-import.test.mjs), on real feed records |

---

## 1. Where the games come from

GameDistribution publishes its catalog to portals through an official JSON feed:

```text
https://catalog.api.gamedistribution.com/api/v2.0/rss/All/?collection=All&…&format=json&amount=100&page=N
```

That feed — not the `gamedistribution.com/games/` page, which is a client-side
app whose markup is not a contract — is the source. It is paged at 100 games
(asking for more still returns 100), and on **2026-09-26 it held 21,673 entries
over 217 pages**. `robots.txt` for gamedistribution.com disallows nothing. The
crawl waits 0.8 s between pages (~3 minutes in all) and identifies itself as
`ZoFHub-catalog-sync/1.0`.

**A short or empty page is confirmed before it is believed.** A crawl on the same
day got an empty page 107 and would have stopped at 10,600 games while reporting
success. The importer now re-fetches a short page and probes the next one; a gap
is skipped and reported, not mistaken for the end.

## 2. Exact URLs — never built

For each game the feed gives an id (`Md5`), the embed URL and a list of
thumbnails GameDistribution publishes for it.

- **Embed:** accepted only if it is exactly
  `https://html5.gamedistribution.com/<that id>/`. That base URL is what is
  stored. The sample snippet GameDistribution shows portals ends in
  `?gd_sdk_referrer_url=https://www.example.com/games/{game-path}` — that is a
  **placeholder**, and it is never stored. When a visitor opens the game,
  `/play/<slug>` adds `gd_sdk_referrer_url` pointing at this site's real
  `/play/<slug>` URL (`injectGdReferrer` in `server.js`), on whatever domain the
  site is served from.
- **Thumbnail:** one of the feed's **own** asset URLs for that id on
  `img.gamedistribution.com` — the 512×384 one where listed, which is the image
  GameDistribution shows beside each game. An asset on any other host, or for
  another id, is refused. Nothing is constructed.
- **Size:** the feed's `Width`/`Height` are kept (`embed_width`/`embed_height`),
  e.g. 800×600, 960×600, 1920×1080.

## 3. The licensing screen

GameDistribution distributes these games to third-party portals at no cost, on
the condition that they run **unmodified in its own iframe, with its SDK and ads
intact** — that is the licence basis recorded on the provider
(`game_providers.license_basis`), and it is why GameDistribution games are always
framed directly, never proxied or self-hosted. On top of that, every game is
screened:

| Outcome | When | Effect |
|---|---|---|
| **Rejected** | the feed marks it not live (`Status ≠ 2`), not https, not HTML5, or its embed/thumbnail is not GameDistribution's own URL for that id | never imported |
| **Held for review** | its **title, a tag or its description** names a mark on the shared trademark list (Minecraft, Roblox, Tetris, Among Us, Squid Game, Mario, Spider-Man, Pac-Man, …); or another provider already lists a game with the same title | imported as `pending_review` with the reasons attached |
| **Clean** | none of the above | `published` when `catalog.gd_auto_publish_clean` is on, otherwise `pending_review` |

**What automation can and cannot do.** A pattern match cannot decide
infringement — whether a "block-building sky island" game infringes anyone is a
legal judgement. What the screen guarantees is that **a person looks at every
game where a known mark appears**, and the review queue records who approved
what. Tags matter: many games never name the mark in their title, but their
publisher tags them `minecraft` or `roblox` to be found — which is exactly the
signal that they trade on it.

### The six games requested

Verified against the live feed and in a real browser (headless Chromium,
2026-09-26): each embed loaded GameDistribution's splash, and after pressing
**PLAY** the game itself rendered — a menu or live gameplay — framed with the
play page's own sandbox and permissions.

| Game | Id | Screen | Would be |
|---|---|---|---|
| Flip Duel | `d48120b598174ba48e3d35e2733fa575` | clean | published |
| Arena Strike Battle | `1bd090f478884877be24fb1e1fea1f23` | clean | published |
| Moto Traffic Rider | `9bde41f232834eff9ea81554ecee8279` | clean | published |
| Cross the Road | `888abfd4058149059db1e1e778d6bfa6` | tag `roblox` | held for review |
| Blockland Oneblock Skyblock | `7a4f5e733d4b4de8afba79c38f6ddb18` | tag `minecraft` | held for review |
| Roller Coaster: Obby Race | `6322e360cffc45f188d111985753b274` | tag `roblox` | held for review |

For the three held games the decision is the reviewer's. The rendered games
make the reason concrete: Blockland's character is a Minecraft-style block
figure, and the two Roblox-tagged games use Roblox-style avatars.

## 4. Running it

```bash
npm run gd:import                                   # DRY RUN of the whole live feed (default)
npm run gd:import -- --only <id>,<id>               # dry run of specific games
npm run gd:import -- --apply                        # write to the database
npm run gd:import -- --apply --no-auto-publish      # write, but everything waits for review
npm run gd:import -- --report import.json           # keep the full report
```

`--apply` refuses to write unless the control-plane migration is on the database
and the Supabase secret key is in `.env`. Without a database, the dry run
compares against `data/games-export.json`, so duplicates and games already
present are detected as they would be for real.

From the console: **Content → GameDistribution import…** runs the same code in
the background (one run at a time, rate limited, `games.import` only — a visitor
can never trigger it), with a dry-run button and the last run's report.

**Re-running is safe.** A game already imported (matched on provider + id) is
skipped, and a game an editor has changed is never overwritten by the feed.

## 5. What a first real import looks like

Dry run of the full live feed on 2026-09-26, compared against the current
catalog:

| | Games |
|---|--:|
| Feed entries (217 pages, no gaps) | 21,673 |
| Duplicates inside the feed | 18 |
| **Rejected** — not live (`Status ≠ 2`), not https, no GameDistribution thumbnail, or a mismatched embed (a game can fail several) | 2,870 |
| Already in the catalog (matched on provider + id) | 141 |
| **Held for review** | **3,355** |
| &nbsp;&nbsp;· another provider already lists the same title | 2,408 |
| &nbsp;&nbsp;· a trademark in the tags / title / description | 600 / 189 / 276 |
| **Clean — would publish** | **15,289** |
| Rows that failed validation | 0 |

(A held game can carry more than one flag, so the flag rows add up to more than 3,355.)

The first `--apply` therefore adds on the order of fifteen thousand games. The
public catalog loads every published game into memory; watch the memory line in
`/api/admin/system` after the first import, and use `--no-auto-publish` if you
would rather publish in reviewed batches.

---

**Related:** [control plane](../admin/CONTROL-PLANE.md) · [licensing audit](../guides/HOW-IT-WORKS.md) ·
[documentation map](../README.md#-documentation)
