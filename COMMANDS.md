# ZoFHub — Complete Command Reference

Every npm script and terminal command for the whole site, what each one does, and
how the pieces fit together. ZoFHub is a **Node.js + Express** app (vanilla
HTML/CSS/JS, **no build step**, Supabase for data). It is **always a proxy site**
monetized only by **proxy-friendly ad networks** (Adsterra / HilltopAds / Monetag) —
there is no Google AdSense and no separate "hub" mode.

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
| `npm run proxies` | Launch the optional standalone companion proxy browsers (NautilusOS · Interstellar · DayDream · Nebula) on their own ports. Prints why it skipped any that aren't ready. |
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
| `npm run fix-links` | Alias for the link checker (re-checks + updates link health). |
| `npm run audit` | Audit the catalog (health/coverage report). |
| `npm run audit-thumbnails` | Report which games are missing/broken thumbnails. |
| `npm run audit-licensing` | Audit games for licensing/trademark compliance. |
| `npm run clean-fakes` | Remove fake/synthetic GameDistribution hashes (games that 200 but never render). |
| `npm run purge-eduame` | One-off: purge legacy "Eduame" references. |
| `npm run build-mvp` | Rebuild the trimmed bundled catalog JSON (`api/games.json`). |

---

## 🤖 AI / Vibe Finder

| Command | What it does |
|---|---|
| `npm run mood-index` | Build `data/mood-tags.json` (the mood→game index powering the AI "Vibe Finder"). Needs **Python**. |

> This is the **only** Python script. Everything else is Node. The AI chat itself
> needs no command — it runs directly in the visitor's browser via Pollinations
> (keyless), so nothing to configure or run server-side.

---

## 💻 Raw terminal commands (not npm)

### Git — push to both accounts
```cmd
cd /d "C:\Users\jayes\OneDrive\Documents\CLAUDECODEPROJECTS\ZoFHub"
git add -A
git commit -m "describe your change"
git push origin main
git push backup main
```
- `origin` = your main account (ZSM1010), `backup` = second account (ZoFHubAdmin).
- If a push is **rejected** (something changed on GitHub, e.g. a web upload): `git pull --rebase origin main`, resolve any conflict, then push again.
- Check state anytime (safe): `git status` · `git log --oneline -5`.

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
| `SUPABASE_SERVICE_ROLE_KEY` | Legacy `eyJ…` equivalent. Still accepted; mirrored from `SUPABASE_SECRET_KEY` automatically so CLI tools keep working. |
| `SCORE_SECRET` | Signs the leaderboard proof-of-play tokens. |
| `PROXY_AD_SCRIPTS` | Comma-separated proxy-friendly ad loader script URL(s) (Adsterra popunder, Monetag push…). Google URLs are auto-rejected. |
| `PROXY_BANNER_TAG` | Optional footer banner tag (one line). Shows only when set. |
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
- **Ads** — proxy-friendly networks only, wired via `PROXY_AD_SCRIPTS` (page-level
  popunder/push) and `PROXY_BANNER_TAG` (footer banner). Clean blank space is
  reserved on pages for banners — no labels, no visible boxes. Google ad code can
  never load (it's stripped server-side).
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

:: Save + back up to both GitHub accounts
git add -A && git commit -m "update" && git push origin main && git push backup main
```
