# ZoFHub — Complete Command Reference

Every npm script and terminal command for the whole site, what each one does, and
how the pieces fit together. ZoFHub is a **Node.js + Express** app (vanilla
HTML/CSS/JS, **no build step**, Supabase for data). It is **always a proxy site**, with
advertising from five supported networks (HilltopAds / Adsterra / Monetag /
Ad-Maven / PopAds) on the hub pages only — never on the proxy, never Google
AdSense, and no separate "hub" mode.

> **Windows note:** most scripts run `node --use-system-ca …`. The `--use-system-ca`
> flag makes Node trust the Windows certificate store (needed on some school/office
> networks). On macOS/Linux it's harmless.

---

## 🚀 Running the server

| Command | What it does |
|---|---|
| `npm start` | Start the server → **http://localhost:8080**. Auto-fetches missing Y8 thumbnails on boot. |
| `npm run dev` | Start with `--watch` (auto-restarts when you edit a file). Auto-fetches missing thumbnails on boot. |
| `npm run restart` | Free port 8080, then start (use if a previous server is stuck on the port). Auto-fetches missing thumbnails on boot. |
| `npm run kill-port` | Just free port 8080 (kills whatever is using it). |
| `npm run proxies` | Launch the optional standalone companion proxy browsers (NautilusOS · Interstellar · DayDream) on their own ports. Prints why it skipped any that aren't ready. Nebula was removed from the working tree — restore it with `git checkout 07a2a6f7 -- Nebula` if you want it back. |
| `npm run dev:all` | Launch the main server **and** the companion proxies together; one Ctrl+C stops all. |

> **About the auto-thumbnails:** EVERY start command fetches missing Y8 thumbnails
> from the web on boot — it's built into the server start itself, so `npm start`,
> `npm run dev`, `npm run restart`, and production all do it automatically. It only
> touches games whose thumbnail is missing (pulls the image from that game's y8.com
> page), so it's fast and idempotent — nothing to do after the first pass. It runs in
> the **background** so it never delays the site, and it's a best-effort no-op if
> Supabase/network is unavailable. Turn it off with `SKIP_THUMB_FETCH=1`.

---

## 🗄️ Database & catalog (Supabase)

| Command | What it does |
|---|---|
| `npm run restore-games` | **One-command setup:** load every game source into Supabase. |
| `npm run migrate` | Migrate the game data into Supabase. |
| `npm run migrate:all` | Full migrate (all sources, no filtering). |
| `npm run migrate:dry` | Preview a migration — validates but **writes nothing**. |
| `npm run migrate:curated` | Migrate only the hand-curated set. |
| `npm run migrate:curated:dry` | Dry-run of the curated migration. |
| `npm run export-games` | Export the live catalog from Supabase to local JSON (back up / feed the mood index). |
| `npm run grow` | Add up to ~40 **render-verified** new games to the catalog now (same code the cron uses). |
| `npm run add-game` | Add one game interactively. |
| `npm run add-slope` | Add the Slope game specifically. |

### Schema: applying and proving it

| Command | What it does |
|---|---|
| `npm run db:verify` | **Ask the running database whether the deploy landed.** Compares the live schema against the migrations, and probes that every relation is actually *readable* — a table can deploy perfectly and still answer `42501 permission denied` to the app. Exit 0 means the deployed schema is this repository's. |
| `npm run db:verify:strict` | Same, but fails on warnings too. |
| `npm run build-schema-only` | Regenerate `db/SCHEMA-ONLY.sql` — all 13 migrations in one paste-able file. |
| `npm run build-all-in-one` | Regenerate `db/ALL-IN-ONE.sql` — schema **plus** the whole catalog (~6.5 MB, `psql` only). |
| `npm run check-schema-only` | Verify `db/SCHEMA-ONLY.sql` is current without writing. CI runs this. |
| `npm run check-all-in-one` | Same for `db/ALL-IN-ONE.sql`. |

> Applying the schema is one paste: **`db/SCHEMA-ONLY.sql`** into the Supabase SQL
> Editor. Do not assemble it from individual `db/*.sql` files — the order is
> load-bearing, and leaving one out is silent. `db/grants.sql` must run last of
> all; without it every table exists and nothing can read it.

> **If `npm run grow` "adds 0 games":** that's normal, not a bug. It only adds games
> that aren't already in the catalog. Once your Supabase catalog already covers the
> local source files, it correctly finds nothing new (`no new slugs in sample`). To
> grow further you need new source data or a fresh `npm run y8-sync`.

---

## 🎮 Y8 pipeline (fetching embeddable games from y8.com)

| Command | What it does |
|---|---|
| `npm run y8-scrape` | Scrape Y8's official "Games for your website" embed directory into `y8-games.json`. |
| `npm run y8-harvest` | Deeper harvest of Y8 games (heavier, more thorough). |
| `npm run y8-sync` | Ingest the scraped Y8 games into Supabase (upsert + revive, drops trademark titles). |
| `npm run fix-thumbnails` | Fill in missing thumbnails from each game's y8.com page (this is what `dev`/`restart` run automatically). |
| `npm run fix-thumbnails -- --self-host` | Also **download** the thumbnails into `public/thumbs/` and serve them locally (bulletproof against hotlink breakage). |
| `npm run fix-thumbnails -- --dry-run` | Show what it *would* fetch without writing anything. |

**Typical Y8 refresh:** `npm run y8-scrape` → `npm run y8-sync` → `npm run fix-thumbnails`.

---

## 🧹 Auditing & maintenance

| Command | What it does |
|---|---|
| `npm run check` | JavaScript syntax check across the project (fast sanity pass). |
| `npm run link-check` | Check a batch of game links and mark dead ones. |
| `npm run link-check:full` | Full link-check pass over the whole catalog. |
| `node --use-system-ca tools/sweep-dead-games.mjs` | Probe every working game and report dead ones (no npm alias — run it directly). Add `--apply` to actually mark them. Takes ~1–2 h for the full catalog. |
| `npm run audit` | Audit the catalog (health/coverage report). |
| `npm run audit-thumbnails` | Report which games are missing/broken thumbnails. |
| `npm run audit-licensing` | Audit games for licensing/trademark compliance. |
| `npm run clean-fakes` | Remove fake/synthetic GameDistribution hashes (games that 200 but never render). |
| `npm run purge-eduame` | One-off: purge legacy "Eduame" references. |
| `npm run build-mvp` | Rebuild the trimmed bundled catalog JSON (`api/games.json`). |
| `npm run build-merged` | Merge the raw source JSON files into one combined catalog. |
| `npm run build-curated` | Build the hand-curated catalog subset. |
| `npm run cleanup-ip` | Find and remove trademark/IP-infringing titles. |
| `npm run check-ads` | Validate your ad config **before** you find out the slow way that the CSP is blocking a network (the symptom is silent: a console line and no revenue). |
| `npm run gamezop` | Switch Gamezop URLs to our own partner id. |
| `npm run sync-migrations` | Regenerate `supabase/migrations/` from `db/`. Add `-- --check` to verify without writing — this is what CI runs. |
| `npm run audit:repo` | Whole-repository audit: SQL, API surface, assets, dependencies, env, JSON, performance. Reports error/warn/info. |
| `npm run audit:sql` | The SQL half alone — replays every migration and checks the end state. |
| `npm run audit:repo:json` | Same as `audit:repo`, machine-readable (`data/audit-report.json`). |
| `npm run audit:ci` | The gate CI runs — fails the build on any error. |
| `npm run quality` | Catalog quality report. |
| `npm run verify-thumbs` | Confirm thumbnail URLs still resolve. |
| `npm run admin-hash` | Generate the scrypt `ADMIN_PASSWORD_HASH` for `/admin`. Never store the plaintext password. |
| `npm run css-tokens` | Check the CSS design tokens are consistent. |
| `npm run og-sync` | Refresh Open Graph / social preview metadata. |
| `npm test` | The full suite — 426 tests, no network, no credentials required. |

---

## 🤖 AI / Vibe Finder

| Command | What it does |
|---|---|
| `npm run mood-index` | Build `data/mood-tags.json` (the mood→game index). Needs **Python**. |
| `npm run game-attributes` | Build `data/game-attributes.json` — scores every game on six axes (calm, pace, brainy, challenge, social, cozy) plus session length, each with a confidence weight. This is what the Vibe Finder and "For You" rank against. Needs **Python**. |
| `npm run rec-index` | Build the title-similarity index the recommender uses. |
| `npm run feed-rank` | Precompute feed ranking scores and demote duplicates. |
| `npm run eval-rec` | Score the recommender against seven synthetic player profiles — fill rate, duplicates, category entropy, personalization, coverage. Averaged over 3 runs, because a single run's diversity number swings enough to make a one-shot reading meaningless. Needs **Python**. |

> The AI chat itself needs no command — it runs directly in the visitor's browser
> via Pollinations (keyless), so there is nothing to configure or run server-side.
>
> **There is no trained model here.** The catalog has no recorded plays, no
> descriptions and no database tags, so there is nothing to learn from; the
> recommender is content-based and says so. `npm run eval-rec` is how you tell
> whether a change to it actually helped.

### The other Python tools (thumbnails)

There are **four** Python scripts in total; everything else in this project is Node.

| Command | What it does |
|---|---|
| `npm run fix-missing-thumbs` | Fetch thumbnails that are missing from the catalog. |
| `npm run scrape-thumbs` | Scrape thumbnails from publisher pages. |
| `npm run normalize-thumbs` | Re-encode oversized thumbnails down to a sane size. |
| `npm run upgrade-y8-thumbs` | Re-fetch Y8 thumbnails at full thumbnail resolution. |

---

## 💻 Raw terminal commands (not npm)

### Git — save your work to GitHub
```cmd
cd /d "C:\Users\sumat\Documents\CLAUDECODEPROJECTS\ZoFHub"
git status
git add -A
git commit -m "describe your change"
git push origin main
```
- `origin` = `ZSM1010/ZoFHub-Gaming-AI-Browser-Hub`. Check what is actually
  configured with `git remote -v` — that output is the source of truth.
- **The optional `backup` remote (second account).** `git push backup main` only
  works once you add it; on a fresh clone it fails with *"'backup' does not appear
  to be a git repository"*, and because that error prints AFTER a successful
  `git push origin main` it is easy to miss — you think both accounts are synced
  when only one is. To set it up:

  ```cmd
  :: 1. Create the repo on github.com under the second account FIRST (empty, no README).
  :: 2. That account must add this one as a collaborator, or the push is denied.
  git remote add backup https://github.com/ZoFHubAdmin/ZoFHub-Site.git
  git push backup main
  ```

  Verify it took effect with `git remote -v` (you should see four lines, not two).

  ⚠️ **Supabase can only watch ONE repository.** If you keep two remotes, make sure
  the one connected in Supabase → Integrations → GitHub is the one you actually
  push to most reliably; otherwise a failed push to the watched repo leaves your
  database on a stale schema with no error anywhere. Keeping a single remote
  avoids this class of bug entirely.
- If a push is **rejected** (something changed on GitHub, e.g. a web upload):
  `git pull --rebase origin main`, resolve any conflict, then push again.
- Check state anytime (safe, changes nothing): `git status` · `git log --oneline -5`.

### Docker
```cmd
docker build -t zofhub .
docker run -p 8080:8080 --env-file .env zofhub
```

### Run a single tool directly (bypassing npm)
```cmd
node --use-system-ca tools/grow-catalog.mjs --dry-run --target=10
```

---

## ⚙️ Environment variables (`.env`)

Copy `.env.example` → `.env` and fill in:

| Variable | Purpose |
|---|---|
| `PORT` / `HOST` | Server port (default 8080) / bind address. |
| `SUPABASE_URL` | Supabase project URL. |
| `SUPABASE_PUBLISHABLE_KEY` | Public (browser-safe) key. |
| `SUPABASE_SECRET_KEY` | **Server-only** admin key (cron + writes + thumbnail fetch), the new `sb_secret_…` form. Preferred. |
| `SUPABASE_SERVICE_ROLE_KEY` | Legacy `eyJ…` name. **The legacy pair is disabled on this project** — presenting an old key returns `401 Legacy API keys are disabled`. Do not set it. The loader mirrors `SUPABASE_SECRET_KEY` onto this name automatically, which is the only reason the CLI tools that read it still work. |
| `ADMIN_USERNAME` | Login name for `/admin`. |
| `ADMIN_PASSWORD_HASH` | scrypt hash of the admin password — generate with `npm run admin-hash`. The plaintext is never stored. |
| `ADMIN_SESSION_SECRET` | Signs admin session cookies **and** keys the audit log's IP HMAC. Changing it logs everyone out. |
| `ADMIN_SECRET` | Unlocks the admin console. Without it the console fails closed. |
| `CRON_SECRET` | Protects `/healthz`. Set the same value in your uptime monitor. |
| `<NETWORK>_ENABLED` | Enable one of the five: `HILLTOPADS` `ADSTERRA` `MONETAG` `ADMAVEN` `POPADS`. Enabled without a script/tag renders nothing. |
| `<NETWORK>_SCRIPT` | That network's loader URL(s), comma-separated, https only. Google URLs auto-rejected. |
| `<NETWORK>_ZONE` | The zone / site ID the network issues. Never sent to the browser. |
| `PROXY_AD_SCRIPTS` | **Deprecated** legacy loader list. Still honoured so live deploys keep earning, but carries no network identity. |
| `PROXY_BANNER_TAG` | Footer banner tag, 728×90 (one line). Shows only when set. |
| `PROXY_HEADER_TAG` | Header leaderboard tag, 728×90, under the site header. Shows only when set. |
| `PROXY_SIDEBAR_TAG` | Sidebar rectangle tag, 300×250, in the category sidebar. Hidden below 900px wide. |

> **Start with ONE network.** Stacking several popunder networks makes them fight
> each other and trips their fraud checks — the fastest way to get banned by all
> of them and paid by none. Add a second only once the first is paying out.
> Run `npm run check-ads` after configuring; the CSP allowlist is derived
> automatically from these variables, so no code change is ever needed.
| `CRON_SECRET` | Protects `/healthz`; set the same value in your uptime monitor. |
| `CRON_DISABLED` | Set `1` to disable the background jobs. |
| `SKIP_THUMB_FETCH` | Set `1` to skip the automatic on-boot Y8 thumbnail fetch. |

---

## 🧠 How everything works

- **Server (`server.js`)** — one Express app serving the pages, the game/AI/web
  proxies, and all `/api/*` endpoints. Holds the full game catalog in memory and
  refreshes it from Supabase every ~30 min.
- **Catalog** — games come from official embed sources (GameMonetize,
  GameDistribution, Y8, Famobi, HTMLGames, OnlineGames.io). Supabase is the source of
  truth; a bundled JSON is the offline fallback.
- **Always-on proxy** — GUST (libcurl.js + Wisp), Ultraviolet, and Scramjet let
  visitors open the web on filtered networks. The `/wisp` WebSocket tunnel carries
  the traffic. This is why ZoFHub needs a **persistent host** (not serverless).
- **Ads** — five supported networks, each enabled independently via
  `<NETWORK>_ENABLED` + `<NETWORK>_SCRIPT` (`lib/ad-providers.mjs` is the
  registry). Slots reserve their exact size so a late creative cannot shift the
  page, and an unset slot collapses to nothing. **Structurally excluded from every
  proxy surface.** Google ad code can never load — it is refused at three layers.
  See [`docs/ADVERTISING.md`](docs/ADVERTISING.md).
- **Cron jobs (`lib/cron-jobs.mjs`)** — 7 scheduled jobs (link-check hourly, catalog
  grow every 3 days, Y8 sync weekly, score/community prune + Supabase keep-alive
  daily). They only run **while the server process is alive**, so on a free host that
  sleeps, run the jobs manually (`npm run grow`, `npm run y8-sync`) or use a dedicated
  cron service.
- **AI Vibe Finder** — the `/api/vibe` endpoint maps a mood to game genres (mood
  index + Pollinations) and searches the full catalog; the chat runs browser-direct
  and keyless.

---

## ⚡ Common workflows

```cmd
:: First-time local setup
npm install
copy .env.example .env       :: then fill in Supabase keys
npm run restore-games        :: load the catalog into Supabase
npm start                    :: → http://localhost:8080

:: Everyday development (auto-grabs missing Y8 thumbnails first)
npm run dev

:: Refresh Y8 games + thumbnails
npm run y8-scrape && npm run y8-sync && npm run fix-thumbnails

:: Add render-verified new games right now
npm run grow

:: Save your work to GitHub
git add -A && git commit -m "update" && git push origin main

:: If you also keep the optional second-account remote, push it too. Run this as
:: its OWN line, not chained with && — chaining hides whether the first one
:: failed, and a silent failure here is how the two accounts drift apart.
git push backup main
```
