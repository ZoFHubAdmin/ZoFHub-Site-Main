# 🎮 ZoFHub — Gaming · AI · Browser Hub

![Node](https://img.shields.io/badge/Node-%E2%89%A518-3c873a?logo=node.js&logoColor=white)
![Express](https://img.shields.io/badge/Server-Express-000000?logo=express&logoColor=white)
![Supabase](https://img.shields.io/badge/Database-Supabase-3ecf8e?logo=supabase&logoColor=white)
![No build step](https://img.shields.io/badge/build-none-blue)
![Deploy](https://img.shields.io/badge/Deploy-Render-46E3B7?logo=render&logoColor=white)

A single-server web app that bundles three things into one site:

1. **A games hub** — 16,000+ free browser games served from official/authorized embeds, with search, categories, favorites, a global leaderboard, and a community wall.
2. **A free AI assistant** — chat + image generation via [Pollinations](https://pollinations.ai), proxied through the server (no API key required for the visitor).
3. **A proxy web browser** — an optional "open the web" mode (GUST + Ultraviolet/Scramjet/Wisp) for filtered networks.

It's built with **Node.js + Express**, vanilla **HTML/CSS/JS** (no framework, **no build step**), and **Supabase** (Postgres) for the catalog, scores, and community data. One codebase deploys as either the **monetizable hub** or the **proxy site** by flipping a single environment variable.

---

## ✨ Features

- 🎮 **16,000+ games** from GameMonetize, GameDistribution, Y8, Famobi, HTMLGames, OnlineGames.io & GameFlare — all via their official embed URLs.
- ⚡ **Instant catalog** — the full game list is held in memory and refreshed from Supabase every 30 min; API responses are edge-cached.
- 🏆 **Leaderboard & community** — per-game and global high scores (proof-of-play protected), plus a community recommendation wall and honest live-visitor presence.
- 🤖 **Built-in AI** — text + image generation, streamed, with a "Vibe Finder" that recommends games from your mood.
- 🌐 **Proxy browser (optional)** — GUST (libcurl.js + Wisp), Ultraviolet, and Scramjet engines for browsing on locked-down networks.
- 🧩 **Two deploy modes, one codebase** — `SITE_MODE=hub` (ads on, proxy off) vs `SITE_MODE=full` (proxy on, ads off). See [GO-LIVE.md](GO-LIVE.md).
- 💤 **Free-tier friendly** — a secured `/healthz` keep-alive endpoint keeps Render + Supabase awake without a paid plan.
- 🛠️ **Self-maintaining** — scheduled jobs check dead links, grow the catalog, sync Y8, prune scores, and heartbeat the DB.

---

## 🧱 Tech stack

| Layer | Choice |
|---|---|
| Server | Node.js (≥18) + Express, ES modules, **no build step** |
| Frontend | Vanilla HTML / CSS / JavaScript (no framework) |
| Database | Supabase (Postgres) — accessed via PostgREST |
| AI | Pollinations (server-proxied) |
| Proxy | GUST · Ultraviolet · Scramjet · Wisp · libcurl.js *(see [CREDITS.md](CREDITS.md))* |
| Hosting | Render (persistent web service) — `render.yaml` included |

---

## 🚀 Quick start

**Prerequisites:** Node.js **18+** and Git. Supabase is optional for local dev — without it the app serves a bundled fallback catalog.

```bash
git clone https://github.com/ZSM1010/ZoFHub-Gaming-AI-Browser-Hub.git
cd ZoFHub-Gaming-AI-Browser-Hub
npm install

cp .env.example .env      # then fill in your values (see Configuration)
npm start                 # → http://localhost:8080
```

> **Windows note:** `npm start` runs `node --use-system-ca server.js`. The `--use-system-ca` flag makes Node trust the Windows certificate store, which some corporate/school TLS setups require. On macOS/Linux/Docker it isn't needed.

Handy scripts: `npm run dev` (auto-restart on change) · `npm run restart` (free the port + start) · `npm run check` (JS syntax check).

---

## ⚙️ Configuration

All configuration is via environment variables — copy [`.env.example`](.env.example) to `.env` and fill it in. The essentials:

| Variable | Purpose |
|---|---|
| `SITE_MODE` | `hub` (games + ads, proxy off) or `full` (proxy on, ads off). Default `full`. |
| `SUPABASE_URL` / `SUPABASE_ANON_KEY` | Public Supabase access (optional locally). |
| `SUPABASE_SERVICE_ROLE_KEY` | **Server-only.** Bypasses RLS for cron + writes. Never expose to the browser or commit it. |
| `SCORE_SECRET` | Signs the proof-of-play leaderboard tokens. Keep it stable. |
| `ADSENSE_CLIENT` | Your `ca-pub-…` id — lights up ad units + `/ads.txt` (**hub only**). |
| `CRON_SECRET` | Protects `/healthz`; set the same value in your uptime monitor. |

---

## 🗄️ Database setup (Supabase)

The live catalog and community features live in Supabase. Fastest path once your `.env` has the Supabase keys:

```bash
npm run restore-games     # loads every game source into Supabase in one command
```

Prefer the SQL editor? Run the files in [`db/`](db/) in order — **`schema.sql` → `community.sql` → (optional) `stats.sql` → (optional) `keepalive.sql` → the `load-*.sql` game loaders**. Big loaders are split into numbered `-partNN.sql` files that each stay under Supabase's editor save limit; run the parts in numeric order (every one is an idempotent upsert, so re-running is safe).

📄 Full walkthroughs: [db/RUN-IN-ORDER.md](db/RUN-IN-ORDER.md) (short) · [GAMES-SETUP.md](GAMES-SETUP.md) (detailed) · [db/ADDING-A-GAME.md](db/ADDING-A-GAME.md).

---

## ☁️ Deployment

ZoFHub is a **persistent server** (it runs cron jobs, holds the catalog in memory, and serves the `/wisp` WebSocket) — so it needs a real host, **not** serverless. [`render.yaml`](render.yaml) defines both services (hub + proxy) ready to deploy.

- **Render auto-deploys** on every push to `main`.
- **Free tier:** the included `/healthz` endpoint + an external uptime monitor (e.g. cron-job.org) pinging it every ~10 min keeps the service (and Supabase) from sleeping.

Full launch checklist — domains, ad networks, QA — in **[GO-LIVE.md](GO-LIVE.md)**.

### 🐳 Docker (optional)

```bash
docker build -t zofhub .
docker run -p 8080:8080 --env-file .env zofhub
```

---

## 📂 Project structure

```text
ZoFHub/
├── server.js            # the entire app: pages, API, game/AI/web proxies (entry point)
├── render.yaml          # Render blueprint (hub + proxy services)
├── Dockerfile           # container image (Node 20-alpine, port 8080)
├── api/                 # bundled catalog JSON (fallback when Supabase is down)
├── data/                # catalog-overrides.json + game data manifests
├── db/                  # Supabase SQL: schema, community, stats, keepalive, load-*.sql
├── legal/               # privacy / terms / DMCA / cookies source
├── lib/                 # server modules: supabase, cron-jobs, cache, y8 ingest
├── public/
│   ├── *.html           # pages (home, ai, community, leaderboard, browser, game…)
│   ├── css/  js/        # styles + vanilla frontend modules
│   ├── gust/            # GUST proxy-browser UI (libcurl.js + Wisp)
│   ├── uv/  scram/      # Ultraviolet + Scramjet proxy engines
│   └── assets/ thumbs/  # images + game thumbnails
└── tools/               # maintenance scripts (audits, SQL generators, link checker)
```

---

## 📚 Documentation

| Guide | What it covers |
|---|---|
| [HOW-IT-WORKS.md](HOW-IT-WORKS.md) | Plain-English tour of the whole app |
| [GO-LIVE.md](GO-LIVE.md) | Deployment, domains, ad networks, launch QA |
| [GAMES-SETUP.md](GAMES-SETUP.md) | Loading the full game catalog into Supabase |
| [db/RUN-IN-ORDER.md](db/RUN-IN-ORDER.md) | The exact SQL run order |
| [db/ADDING-A-GAME.md](db/ADDING-A-GAME.md) | Adding / hiding individual games |
| [IFRAME-OPTIMIZATION-GUIDE.md](IFRAME-OPTIMIZATION-GUIDE.md) | How game embeds load fast + reliably |
| [DEBUGGING.md](DEBUGGING.md) | "How do I fix this?" checklist |
| [CREDITS.md](CREDITS.md) | Third-party proxy engines + their licenses |
| [Y8-SCRAPER.md](Y8-SCRAPER.md) | The standalone Y8 embed-directory scraper |

---

## 📜 License & credits

ZoFHub's own code is under the terms in [`LICENSE`](LICENSE). The bundled proxy engines (Ultraviolet, Scramjet, Wisp, Epoxy, libcurl.js) keep their **own** upstream licenses (MIT / AGPL-3.0 / LGPL-3.0) — see **[CREDITS.md](CREDITS.md)** for the full attribution and the AGPL network-use source offer. Standalone copyleft companion browsers are **not** included in this repository.

Games are served through their publishers' **official embed URLs**; ZoFHub hosts no pirated game assets.

## 👨‍💻 Author

**ZSM1010** — https://github.com/ZSM1010
