# ZoFHub — Project Analysis

A complete overview of the ZoFHub project located at
`C:\Users\jayes\OneDrive\Documents\CLAUDECODEPROJECTS\ZoFHub`, including every npm
command available in `package.json`.

## Project Overview

ZoFHub is a single-server web application that combines three features into one site:

1. **Games Hub** — 16,000+ free browser games served via official/authorized embed
   URLs, with search, categories, favorites, Game of the Day, a cheat-resistant
   leaderboard, and a community wall.
2. **Free AI Assistant** — chat + image generation via Pollinations, running
   directly in the visitor's browser (keyless — no API key, and prompts never pass
   through the server).
3. **Proxy Browser (optional)** — an "open the web" mode using GUST +
   Ultraviolet / Scramjet / Wisp for filtered networks.

**Built with:** Node.js + Express, vanilla HTML/CSS/JS (no framework, no build
step), and Supabase (Postgres) for catalog, scores, and community data.

## NPM Scripts Available

All commands come from `package.json`. Node scripts run with `--use-system-ca`
(makes Node trust the Windows certificate store for corporate/school TLS setups).

### Server Management

- `npm start` — `node --use-system-ca server.js` (start the server)
- `npm run dev` — `node --use-system-ca --watch server.js` (auto-restart on change)
- `npm run restart` — free port 8080, then start
- `npm run kill-port` — free port 8080
- `npm run proxies` — run the optional companion proxy browsers
- `npm run dev:all` — run the main server + companion proxies together

### Development & Build

- `npm run check` — JavaScript syntax check (`tools/check-js.mjs`)
- `npm run build-mvp` — build the trimmed MVP bundle (`tools/build-mvp.mjs`)

### Database & Migration

- `npm run migrate` — migrate data into Supabase (`tools/migrate-to-supabase.mjs`)
- `npm run migrate:dry` — dry-run migration (no writes)
- `npm run migrate:curated` — migrate only the curated set
- `npm run migrate:curated:dry` — dry-run curated migration
- `npm run restore-games` — load every game source into Supabase (one command)
- `npm run export-games` — export the catalog from Supabase to local JSON

### Catalog & Game Management

- `npm run add-game` — add an individual game (`tools/add-game.mjs`)
- `npm run add-slope` — add the Slope game (`tools/add-slope.mjs`)
- `npm run grow` — grow the catalog with render-verified games
- `npm run y8-scrape` — scrape the Y8 embed directory
- `npm run y8-harvest` — harvest raw Y8 game data
- `npm run y8-sync` — sync Y8 games into the catalog (`lib/y8-ingest.mjs`)
- `npm run fix-thumbnails` — fetch/repair Y8 thumbnails (`tools/fetch-y8-thumbs.mjs`)
- `npm run mood-index` — `python tools/build-mood-index.py` (build the mood-tag
  index that powers the AI "Vibe Finder" recommendations)

### Auditing & Maintenance

- `npm run audit` — audit the catalog (`tools/audit-catalog.mjs`)
- `npm run audit-thumbnails` — audit thumbnails
- `npm run audit-licensing` — audit game licensing/compliance
- `npm run link-check` — check for dead game links
- `npm run link-check:full` — full link-check pass
- `npm run clean-fakes` — remove fake GameDistribution hashes
- `npm run purge-eduame` — purge legacy "Eduame" references

> **Note:** `mood-index` is the only Python script (offline, stdlib-only). Every
> other tool is Node (ES modules, `.mjs`).

## Getting Started

```bash
# 1. Clone the repository
git clone https://github.com/ZSM1010/ZoFHub-Gaming-AI-Browser-Hub.git
cd ZoFHub-Gaming-AI-Browser-Hub

# 2. Install dependencies
npm install

# 3. Configure environment
cp .env.example .env      # then fill in your values (see Configuration)

# 4. Start the application
npm start                 # → http://localhost:8080
```

> A second private repo, `https://github.com/ZoFHubAdmin/ZoFHub-Site.git`, is used
> only as a full backup mirror (git remote `backup`), not a separate clone.

## Configuration

All configuration is via environment variables in `.env`. The essentials:

- `PORT` — server port (default `8080`)
- `HOST` — bind address (default `0.0.0.0`)
- `NODE_ENV` — `development` / `production`
- `SITE_MODE` — `full` (default: proxy **on** + proxy-friendly ads) or `hub`
  (AdSense-only, proxy off)
- `SUPABASE_URL` — Supabase project URL
- `SUPABASE_PUBLISHABLE_KEY` (a.k.a. anon key) — browser-safe, RLS-protected
- `SUPABASE_SERVICE_ROLE_KEY` — **server-only**, bypasses RLS for cron + writes
  (never expose to the browser or commit it)
- `SCORE_SECRET` — signs the proof-of-play leaderboard tokens
- `PROXY_AD_SCRIPTS` — proxy-friendly ad-network loader script(s) (proxy build)
- `PROXY_BANNER_TAG` — optional footer display-banner tag (proxy build)
- `ADSENSE_CLIENT` — Google AdSense id (hub build only)
- `CRON_SECRET` — protects `/healthz`; set the same value in your uptime monitor
- `CRON_DISABLED` — set `1` to disable the scheduled jobs

### Database setup (Supabase)

**Quick method (one command, loads all game sources):**

```bash
npm run restore-games
```

**Manual method — run the SQL files in `db/` in order:**

1. `schema.sql`
2. `community.sql`
3. `community-scores-integrity.sql` (leaderboard anti-cheat functions)
4. *(optional)* `stats.sql`, `keepalive.sql`
5. the `load-*.sql` game loaders (run in numeric order — each is an idempotent
   upsert, so re-running is safe)

## Docker Deployment

```bash
docker build -t zofhub .
docker run -p 8080:8080 --env-file .env zofhub
```

## Production Deployment

ZoFHub needs a **persistent server** (not serverless) because it:

- runs scheduled cron jobs,
- holds the full game catalog in memory, and
- serves the `/wisp` WebSocket tunnel for the proxy engines.

`render.yaml` defines the Render deployment. Render auto-deploys on every push to
`main`. On the free tier, an external uptime monitor pinging `/healthz` keeps the
service (and Supabase) awake.

## Self-Maintaining Features

Scheduled jobs live in `lib/cron-jobs.mjs` (Node, ~7 jobs):

- **Link check** — flags dead game links.
- **Catalog growth** — adds render-verified new games.
- **Y8 sync** — ingests new Y8 embeds.
- **Score pruning** — trims each leaderboard to its top N and quarantines outliers.
- **Community pruning** — removes stale community posts.
- **DB heartbeat** — keeps the free-tier Supabase project from pausing.

## Project Structure

```text
ZoFHub/
├── server.js            # the entire app: pages, APIs, game/AI/web proxies (entry)
├── render.yaml          # Render deployment blueprint
├── Dockerfile           # container image (node:20-alpine, port 8080)
├── api/                 # bundled catalog JSON (fallback when Supabase is down)
├── data/                # catalog-overrides.json, score-limits.json, mood-tags.json
├── db/                  # Supabase SQL: schema, community, integrity, loaders
├── legal/               # privacy / terms / DMCA / cookies / credits source
├── lib/                 # server modules: supabase, cron-jobs, cache, y8 ingest
├── public/
│   ├── *.html           # pages (home, ai, community, leaderboard, browser, game…)
│   ├── css/  js/        # styles + vanilla frontend modules
│   ├── gust/            # GUST proxy-browser UI (libcurl.js + Wisp)
│   ├── uv/  scram/      # Ultraviolet + Scramjet proxy engines
│   └── assets/ thumbs/  # images + game thumbnails
└── tools/               # maintenance scripts (audits, migration, link checker)
```

## Key Features

- Aggregates games from official embed sources (GameMonetize, GameDistribution,
  Y8, Famobi, HTMLGames, OnlineGames.io).
- In-memory catalog, refreshed from Supabase every ~30 minutes; API responses
  edge-cached.
- **Game of the Day** — a deterministic daily pick (same for every visitor, changes
  at UTC midnight), genre-weighted toward what players actually play.
- **Cheat-resistant leaderboard** — signed proof-of-play sessions (single-use,
  minimum play time, per-game score ceilings); statistical outliers are quarantined.
- **No accounts** — every visitor gets an auto-generated device-local username.
- **Built-in AI** — text + image generation, browser-direct and keyless, plus a
  "Vibe Finder" that recommends games from the user's mood.
- **Proxy browser** — GUST (libcurl.js + Wisp), Ultraviolet, and Scramjet engines.
- **One codebase, two modes** — `SITE_MODE=full` (proxy) or `SITE_MODE=hub`
  (AdSense-only).
- Automated cron jobs handle link checking, catalog growth, score pruning, etc.

## Monetization

The **proxy build** (`SITE_MODE=full`, the default) uses proxy-friendly ad networks
(Monetag, Adsterra, HilltopAds) instead of Google AdSense, which bans proxy /
anonymizer sites at the account level. Ad configuration is entirely via environment
variables (Google ad code is auto-stripped so AdSense can never load on the proxy):

- `PROXY_AD_SCRIPTS` — page-level ad scripts (comma-separated for multiple networks)
- `PROXY_BANNER_TAG` — optional footer display banner (728×90)

The **hub build** (`SITE_MODE=hub`) uses standard Google AdSense via the
`ADSENSE_CLIENT` variable.

---

*This covers all npm commands and provides a comprehensive, accurate understanding
of the ZoFHub project based on its actual code and configuration.*
