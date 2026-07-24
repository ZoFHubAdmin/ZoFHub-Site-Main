# 🎮 ZoFHub — Gaming · AI · Browser Hub

![Node](https://img.shields.io/badge/Node-%E2%89%A518-3c873a?logo=node.js&logoColor=white)
![Express](https://img.shields.io/badge/Server-Express-000000?logo=express&logoColor=white)
![Supabase](https://img.shields.io/badge/Database-Supabase-3ecf8e?logo=supabase&logoColor=white)
![No build step](https://img.shields.io/badge/build-none-blue)
![Deploy](https://img.shields.io/badge/Deploy-Render-46E3B7?logo=render&logoColor=white)
[![Discord](https://img.shields.io/badge/Discord-ZoFHub%20Official-5865F2?logo=discord&logoColor=white)](https://discord.gg/SeMuMRG9gG)

A single-server web app that bundles three things into one site:

1. **A games hub** — 16,000+ free browser games served from official/authorized embeds, with search, categories, favorites, a Game of the Day, a cheat-resistant global leaderboard, and a community wall.
2. **A free AI assistant** — chat + image generation via [Pollinations](https://pollinations.ai), running **directly in the visitor's browser** (keyless — no API key, and prompts never pass through this server).
3. **A proxy web browser** — an optional "open the web" mode (GUST + Ultraviolet/Scramjet/Wisp) for filtered networks.

It's built with **Node.js + Express**, vanilla **HTML/CSS/JS** (no framework, **no build step**), and **Supabase** (Postgres) for the catalog, scores, and community data. It runs as **one always-on proxy site** that shows the proxy **and** ads together, monetized entirely by **proxy-friendly ad networks** (no Google AdSense).

---

## ✨ Features

- 🎮 **16,000+ games** from GameMonetize, GameDistribution, Y8, Famobi, HTMLGames, OnlineGames.io & GameFlare — all via their official embed URLs.
- ⚡ **Instant catalog** — the full game list is held in memory and refreshed from Supabase every 30 min; API responses are edge-cached.
- 🌟 **Game of the Day** — a deterministic daily pick (same for every visitor, changes at UTC midnight), genre-weighted toward what players actually play.
- 🏆 **Cheat-resistant leaderboard** — score submissions require a signed **proof-of-play session** (single-use, minimum play time, per-game score ceilings); statistical outliers are quarantined instead of shown.
- 🕶️ **No accounts, no passwords** — every visitor gets an auto-generated device-local username (e.g. `SwiftFalcon1234`). Nothing to sign up for, no emails collected.
- 🤖 **Built-in AI** — text + image generation, streamed, browser-direct and keyless, with a "Vibe Finder" that recommends games from your mood and a local answer cache for instant repeats.
- 🌐 **Proxy browser (optional)** — GUST (libcurl.js + Wisp), Ultraviolet, and Scramjet engines for browsing on locked-down networks.
- 🧩 **Always-on proxy + ads** — one site runs the web proxy **and** ads together, monetized by proxy-friendly networks (Adsterra / HilltopAds / Monetag). No Google AdSense. See [💰 Monetization](#-monetizing-the-proxy-build).
- 💤 **Free-tier friendly** — a secured `/healthz` keep-alive endpoint keeps Render + Supabase awake without a paid plan.
- 🛠️ **Self-maintaining** — 7 scheduled jobs check dead links, grow the catalog with render-verified games, sync Y8, prune scores & community posts, and heartbeat the DB. See [`lib/cron-jobs.mjs`](lib/cron-jobs.mjs).

---

## 🧱 Tech stack

| Layer | Choice |
|---|---|
| Server | Node.js (≥18) + Express, ES modules, **no build step** |
| Frontend | Vanilla HTML / CSS / JavaScript (no framework) |
| Database | Supabase (Postgres) — accessed via PostgREST |
| AI | Pollinations (browser-direct, keyless — no server proxying) |
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
| `SUPABASE_URL` / `SUPABASE_ANON_KEY` | Public Supabase access (optional locally). |
| `SUPABASE_SERVICE_ROLE_KEY` | **Server-only.** Bypasses RLS for cron + writes. Never expose to the browser or commit it. |
| `SCORE_SECRET` | Signs the proof-of-play leaderboard tokens. Keep it stable. |
| `PROXY_AD_SCRIPTS` | Proxy-friendly ad-network loader script(s), comma-separated (**proxy build**). See [💰 Monetization](#-monetizing-the-proxy-build). |
| `PROXY_BANNER_TAG` | Optional footer display-banner tag (**proxy build**). See [💰 Monetization](#-monetizing-the-proxy-build). |
| `CRON_SECRET` | Protects `/healthz`; set the same value in your uptime monitor. |
| `CRON_DISABLED` | Set `1` to disable the scheduled background jobs (e.g. on a replica/test instance). |

---

## 💰 Monetizing the proxy build

The proxy site runs **ads and the proxy at the same time** — it just uses a
**proxy-friendly ad network** (Monetag / Adsterra / HilltopAds) instead of Google
AdSense, because Google bans proxy / anonymizer sites at the **account level**.
Nothing here can put AdSense on the proxy: Google ad code is **stripped
server-side** ([`/api/site-config`](server.js)), so an AdSense account can never be
put at risk. There are **two** places to paste ad code — both are environment
variables, so no code changes are needed to go live.

**1. Page-level ad scripts → `PROXY_AD_SCRIPTS`**
Your network's main loader script(s) — these run the popunder / push / interstitial
formats the network manages itself. Comma-separate to stack multiple networks:

```
PROXY_AD_SCRIPTS=https://your-adsterra-tag.com/invoke.js,https://your-hilltop-tag.com/loader.js
```

**2. Footer display banner → `PROXY_BANNER_TAG`**
An optional fixed **728×90** banner for the clean, labelled slot at the very bottom
of the page. Paste the raw banner tag your network gives you (usually two `<script>`
tags) as **one line**:

```
PROXY_BANNER_TAG=<script>atOptions={...}</script><script src="//network/invoke.js"></script>
```

Leave `PROXY_BANNER_TAG` blank and the footer slot simply never appears — **no empty
"Advertisement" boxes, ever.** The slot is isolated with a divider + spacing so it
can't be mis-clicked as a nav button (that protects your ad-account standing).

### Recommended networks (all accept proxy sites; none require AdSense)

| Network | Best format | Approval | Min payout |
|---|---|---|---|
| **Adsterra** | Popunder, Social Bar, Banner, Direct Link | Instant | $5 (crypto/Paxum) |
| **HilltopAds** | Banner (728×90), Popunder, In-page Push | Instant | $20, weekly |
| **Monetag** | Push, In-page Push, MultiTag | Instant | $5, monthly |

> Start with **one** (Adsterra or HilltopAds). Run at most **one popunder network**
> plus a push and a banner — stacking several popunder tags makes them fight and
> trips fraud checks. Adult-focused networks (ExoClick, ClickADilla) are a poor fit
> for a mostly-teen audience — skip them.

### Step-by-step: sign up → get your banner tag → add it to `.env`

1. **A parent/guardian registers as the _Publisher_** (the account, tax form, and
   payout must be in an adult's name). Add your site's domain in the dashboard;
   approval for these networks is automated (usually minutes).
2. **Create the ad unit(s):**
   - **Page-level script** (popunder / push): create that unit, copy its `https://…`
     loader URL, and add it to `PROXY_AD_SCRIPTS` (comma-separated for more than one).
   - **Footer 728×90 banner** (e.g. HilltopAds → *Banner* → 728×90, or Adsterra →
     *Banner 728×90*): the dashboard gives you a small HTML snippet (usually two
     `<script>` tags). Copy the whole snippet, put it on **one line**, and set it as
     `PROXY_BANNER_TAG`.
3. **Add them to your host** (**Render → your service → Environment**) and to your
   local `.env`, then redeploy. The footer banner appears the moment the tag is set;
   page-level ads start on the next load.
4. **Add more over time.** As each network is approved, append its loader URL to
   `PROXY_AD_SCRIPTS` (keep them comma-separated). Only ever keep **one** popunder
   network active at a time.

> **Real talk + ethics:** proxy traffic pays low rates (often cents per 1,000
> views), so real income needs real, steady traffic first. Keep it clean and honest
> — **no** fake loading timers, **no** "complete an offer to unlock" gates, **no**
> forced surveys. Clean placement is what keeps your accounts alive and your visitors
> coming back.

---

## 🗄️ Database setup (Supabase)

The live catalog and community features live in Supabase. Fastest path once your `.env` has the Supabase keys:

```bash
npm run restore-games     # loads every game source into Supabase in one command
```

Prefer the SQL editor? Run the files in [`db/`](db/) in order — **`schema.sql` → `community.sql` → `community-scores-integrity.sql` (leaderboard anti-cheat: quarantine + cleanup functions) → (optional) `stats.sql` → (optional) `keepalive.sql` → the `load-*.sql` game loaders**. Big loaders are split into numbered `-partNN.sql` files that each stay under Supabase's editor save limit; run the parts in numeric order (every one is an idempotent upsert, so re-running is safe).

> **`db/ALL-IN-ONE.sql`** bundles everything into a single file, but at ~6.7 MB it's far too big for Supabase's web editor — it's for direct `psql` restores only: `psql "$SUPABASE_DB_URL" -f db/ALL-IN-ONE.sql`. For everyone else, `npm run restore-games` is the one-command path.

📄 Full walkthroughs: [db/RUN-IN-ORDER.md](db/RUN-IN-ORDER.md) (short) · [GAMES-SETUP.md](GAMES-SETUP.md) (detailed) · [db/ADDING-A-GAME.md](db/ADDING-A-GAME.md).

---

## ☁️ Deployment

ZoFHub is a **persistent server** (it runs cron jobs, holds the catalog in memory, and serves the `/wisp` WebSocket) — so it needs a real host, **not** serverless. [`render.yaml`](render.yaml) defines both services (hub + proxy) ready to deploy.

- **Render auto-deploys** on every push to `main` (works with private repositories via Render's GitHub authorization).
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
├── data/                # catalog-overrides.json, score-limits.json, game data manifests
├── db/                  # Supabase SQL: schema, community, integrity, loaders, ALL-IN-ONE
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
| [NEW-LAPTOP-SETUP.md](NEW-LAPTOP-SETUP.md) | Moving to a new machine (this private repo backs up everything — just clone + `npm install`) |
| [GO-LIVE.md](GO-LIVE.md) | Deployment, domains, ad networks, launch QA |
| [GAMES-SETUP.md](GAMES-SETUP.md) | Loading the full game catalog into Supabase |
| [db/RUN-IN-ORDER.md](db/RUN-IN-ORDER.md) | The exact SQL run order |
| [db/ADDING-A-GAME.md](db/ADDING-A-GAME.md) | Adding / hiding individual games |
| [IFRAME-OPTIMIZATION-GUIDE.md](IFRAME-OPTIMIZATION-GUIDE.md) | How game embeds load fast + reliably |
| [DEBUGGING.md](DEBUGGING.md) | "How do I fix this?" checklist |
| [CREDITS.md](CREDITS.md) | Third-party proxy engines + their licenses |
| [Y8-SCRAPER.md](Y8-SCRAPER.md) | The standalone Y8 embed-directory scraper |

---

## 💬 Community

Join the **[ZoFHub Official Discord](https://discord.gg/SeMuMRG9gG)** — announcements, game requests, and support. It's also the contact channel for licensing questions (see [`LICENSE`](LICENSE)) and third-party source requests (see [CREDITS.md](CREDITS.md)).

---

## 📜 License & credits

ZoFHub's own code is under the terms in [`LICENSE`](LICENSE) — a **source-available, personal & non-commercial** license (not open source). The bundled proxy engines (Ultraviolet, Scramjet, Wisp, Epoxy, libcurl.js) keep their **own** upstream licenses (MIT / AGPL-3.0 / LGPL-3.0) — see **[CREDITS.md](CREDITS.md)** for the full attribution and the AGPL network-use source offer. Standalone copyleft companion browsers are **not** included in this repository.

Games are served through their publishers' **official embed URLs**; ZoFHub hosts no pirated game assets.

## 👨‍💻 Author

**ZSM1010** — maintained pseudonymously. Reach the project via the [ZoFHub Discord](https://discord.gg/SeMuMRG9gG).
