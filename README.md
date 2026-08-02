# 🎮 ZoFHub — Gaming · AI · Browser Hub

![Node](https://img.shields.io/badge/Node-%E2%89%A522-3c873a?logo=node.js&logoColor=white)
![Express](https://img.shields.io/badge/Server-Express-000000?logo=express&logoColor=white)
![Supabase](https://img.shields.io/badge/Database-Supabase-3ecf8e?logo=supabase&logoColor=white)
![No build step](https://img.shields.io/badge/build-none-blue)
![Tests](https://img.shields.io/badge/tests-129%20passing-brightgreen)
![Deploy](https://img.shields.io/badge/Deploy-Render-46E3B7?logo=render&logoColor=white)
[![Discord](https://img.shields.io/badge/Discord-ZoFHub%20Official-5865F2?logo=discord&logoColor=white)](https://discord.gg/SeMuMRG9gG)

A single-server web app that bundles three things into one site:

1. **A games hub** — **12,711 playable games** served from official/authorized embeds (16,913 catalogued; see [Catalog](#-the-catalog-what-is-actually-served)), with search, categories, favorites, a Game of the Day, a cheat-resistant global leaderboard, and a community wall.
2. **A free AI assistant** — chat + image generation via [Pollinations](https://pollinations.ai), running **entirely in the visitor's browser**. Keyless, and **no prompt, reply or generated image ever touches this server** — that is enforced by the server, not just by convention. See [AI runs on the visitor's device](#-ai-runs-on-the-visitors-device).
3. **A proxy web browser** — an optional "open the web" mode (GUST + Ultraviolet/Scramjet/Wisp) for filtered networks.

It's built with **Node.js + Express**, vanilla **HTML/CSS/JS** (no framework, **no build step**), and **Supabase** (Postgres) for the catalog, scores, and community data. It runs as **one always-on proxy site** that shows the proxy **and** ads together, monetized entirely by **proxy-friendly ad networks** (no Google AdSense).

---

## ✨ Features

- 🎮 **12,711 playable games** from GameMonetize, Y8, Famobi and GameDistribution — all via their official embed URLs. (Another 4,202 rows are catalogued but deliberately not served — see [Catalog](#-the-catalog-what-is-actually-served).)
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
| Server | Node.js (≥22) + Express, ES modules, **no build step** |
| Frontend | Vanilla HTML / CSS / JavaScript (no framework, no bundler) |
| Database | Supabase (Postgres) — accessed via PostgREST, RLS deny-by-default |
| AI | Pollinations, **browser-direct and keyless** — never proxied by this server |
| Proxy | GUST · Ultraviolet · Scramjet · Wisp · libcurl.js *(see [CREDITS.md](CREDITS.md))* |
| Tests | `node:test` (built in — zero test dependencies), 129 tests |
| CI | GitHub Actions — boot check, tests, migration mirror, live migration apply |
| Hosting | Render (persistent web service) — `render.yaml` included |

---

## 🎮 The catalog: what is actually served

The numbers differ at each layer, on purpose. Measured live:

| Layer | Count | Why |
|---|---:|---|
| Rows in Supabase `games` | **16,913** | everything ever ingested |
| `is_working = true` | 16,820 | 93 failed the link checker |
| Visible to the public key | 16,820 | the RLS policy is exactly `is_working = true` |
| **Actually served to visitors** | **12,711** | after provider exclusions + curation overrides |

### Where the served games come from

| Provider | Served | Share |
|---|---:|---:|
| GameMonetize (`html5.gamemonetize.co`) | 9,576 | 75.3% |
| Y8 (`www.y8.com`) | 2,367 | 18.6% |
| Famobi (`play.famobi.com`) | 607 | 4.8% |
| GameDistribution (`html5.gamedistribution.com`) | 155 | 1.2% |
| Direct `.io` titles (smashkarts, suroi, bloxd, deadshot, turbowarp) | 5 | <0.1% |

### Why ~4,200 catalogued games are never served

This is deliberate, and it is the single most surprising thing about the catalog:

- **HTMLGames (1,195), OnlineGames.io (311)** — both **frame-bust**. They actively break out of an `<iframe>`, so an embed renders a broken or hijacked page. They are excluded at the source-of-truth level (`server.js`), and were also removed as catalog-growth sources.
- **Gamezop (228), GameFlare (154)** — excluded for the same anti-framing behaviour.
- **Curation overrides (2,306 remove rules)** — duplicates, trademark-risk titles, and dead embeds, in [`data/catalog-overrides.json`](data/catalog-overrides.json).

They stay in the database rather than being deleted, so the exclusion is reversible if a provider ever changes its framing policy.

**87 distinct categories.** Largest: arcade (5,364), action (1,205), racing (1,202), girls (1,130), puzzle (1,118), shooting (1,057), sports (1,055).

---

## 🔒 AI runs on the visitor's device

Every AI call ZoFHub makes in production goes **browser-direct to Pollinations from the visitor's own machine, on their own IP**. No prompt, reply, or generated image passes through this server, and no API key is required.

| Feature | How it reaches Pollinations |
|---|---|
| Chat / text | `fetch()` from the browser → `text.pollinations.ai` ([`public/js/pollinations.js`](public/js/pollinations.js)) |
| Images | `<img src="https://image.pollinations.ai/prompt/…">` — the browser loads the bytes |
| Text-to-speech | the browser builds the Pollinations URL and plays it directly. No audio passes through us, and the prompt never reaches this server |
| The `pk_` key | [`/api/ai/key`](server.js) serves the **publishable** key so the browser can call Pollinations itself. Publishable keys are designed to be public; a secret `sk_` key must never go here |

**Why server-side AI routes still exist.** Pollinations' text endpoint sits behind a Cloudflare Turnstile check keyed on the `Origin` header, and it rejects browser fetches from `http://` and `localhost` origins. A developer running the site locally would otherwise have no working AI at all. So `/api/ai/text`, `/api/ai/image` and `/api/ai/echo` remain — as a **local-development aid only**.

**This is enforced, not promised.** `aiServerAllowed()` in [`server.js`](server.js) refuses those routes when:

- `NODE_ENV=production` — always, no exceptions (`render.yaml` sets it), **or**
- the client is not on loopback. `trust proxy` is on, so `req.ip` is the real client address and an internet visitor can never present as `127.0.0.1`.

`AI_SERVER_FALLBACK=1` is an explicit opt-in escape hatch for debugging on a non-loopback dev host. Refused requests get `403 {"error":"client_side_only"}`.

The client half matches: `IS_LOCAL` in `pollinations.js` gates the text fallback and is **exported** so `ai.js` gates its image fallback on the identical condition — two copies of that rule would eventually drift, and the one that drifted would quietly start routing AI through the server. Four tests in [`test/server.test.mjs`](test/server.test.mjs) assert an internet visitor is refused on all three routes.

**What this buys you:** no AI compute or bandwidth on your host, no shared rate-limit pool (each visitor uses their own IP), and prompts that are never observable server-side.

### The server refuses to fetch AI providers for a caller

Three routes accept a caller-supplied URL and fetch it server-side: `/thumb`, `/asset` and `/api/proxy/diag`. All three now refuse the ~20 hosts in `AI_PROVIDER_HOSTS` (Pollinations, AI Horde, OpenAI, Anthropic, Google, Groq, Mistral, Cohere, DeepSeek, Together, Replicate, fal, OpenRouter, HuggingFace, Stability, xAI, Perplexity).

This matters because `/asset` is *deliberately* a general cross-origin proxy — the injected iframe shim routes game assets through it to fix WebGL canvas tainting — so "general" previously included inference endpoints. A denylist rather than an allowlist, because an allowlist over an open-ended set of game CDNs would break games.

Two further routes (`/api/ai/audio`, `/api/ai/video`) are closed in production even though neither performs inference: they take the prompt in the **query string**, and hosting platforms log request paths, so the access log would accumulate prompt text in a log this code never writes and cannot clear.

### Privacy posture

`Permissions-Policy` explicitly denies 16 capabilities the site does not use — `geolocation`, `camera`, `microphone`, `browsing-topics` (Google's Topics ad-profiling API), `interest-cohort`, `idle-detection`, `local-fonts`, `usb`, `serial`, `bluetooth`, `hid`, `midi`, `display-capture`, `attribution-reporting`, `run-ad-auction`, `join-ad-interest-group`. Because the header is an allowlist, anything unlisted falls back to the browser default — and this site embeds thousands of third-party game and ad frames that would otherwise inherit the ability to request them.

No analytics, no telemetry, no source maps, no accounts. Prompts and AI responses are never logged or stored server-side.

**Known and accepted:** the web proxy (GUST / Ultraviolet / Scramjet / Wisp) relays whatever a user browses to, including AI sites. That is the proxy's purpose, and it is user-initiated rather than something the site's own AI features do.

---

## 🚀 Quick start

**Prerequisites:** Node.js **22+** and Git. Supabase is optional for local dev — without it the app serves a bundled fallback catalog.

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
| `SUPABASE_URL` | Your project URL. Not a secret — it is in every API call the app makes. |
| `SUPABASE_PUBLISHABLE_KEY` | The browser-safe key (`sb_publishable_…`, formerly "anon"). Subject to RLS. `SUPABASE_ANON_KEY` is accepted as an alias. |
| `SUPABASE_SECRET_KEY` | **Server-only.** The `sb_secret_…` key. Bypasses RLS; required for every write. Never expose to the browser. |
| `SCORE_SECRET` | Signs the proof-of-play leaderboard tokens. Keep it stable. |
| `ADMIN_SECRET` | Unlocks `/admin`, where you review the scores the anti-cheat layer flagged or quarantined. Unset = the panel and `/api/admin/*` fail closed, and flagged scores stay hidden with nobody able to release them. |
| `SITE_URL` | Optional. Names the site on the legal pages and pins the CORS origin. If unset, those pages derive the name from the request; CORS falls back to same-host matching. |
| `POLLINATIONS_PUBLIC_KEY` | Optional `pk_` key served to the browser to lift the anonymous per-IP AI limit. **Publishable by design** — never put an `sk_` key here. |
| `PROXY_AD_SCRIPTS` | Proxy-friendly ad-network loader script(s), comma-separated (**proxy build**). See [💰 Monetization](#-monetizing-the-proxy-build). |
| `PROXY_BANNER_TAG` | Optional footer display-banner tag (**proxy build**). See [💰 Monetization](#-monetizing-the-proxy-build). |
| `CRON_SECRET` | Protects `/healthz`; set the same value in your uptime monitor. |
| `CRON_DISABLED` | Set `1` to disable the scheduled background jobs (e.g. on a replica/test instance). |
| `AI_SERVER_FALLBACK` | Set `1` **only** to allow the local-dev AI routes from a non-loopback host. Never set it in production. |

> **`SUPABASE_SERVICE_ROLE_KEY` is retired.** The legacy `eyJ…` JWT is no longer set. It cannot be rotated and Supabase turns it off at the end of 2026. If you still have one, paste a new `sb_secret_…` key into `SUPABASE_SECRET_KEY` and disable the legacy pair in the dashboard. The loader mirrors the secret key onto the old variable name at import time, so the CLI tools that read `SUPABASE_SERVICE_ROLE_KEY` keep working with nothing set.

### Two Supabase clients, two security contexts

[`lib/supabase.mjs`](lib/supabase.mjs) exposes three accessors, and which one a code path uses is a security decision:

| Accessor | Key | Use |
|---|---|---|
| `getSupabaseAdmin()` | secret only, **never** falls back | every write. Returns `null` with no admin key, so a write fails loudly instead of being refused by RLS with an opaque `42501` |
| `getSupabasePublic()` | publishable only, **never** escalates | anywhere a public security context is the correct one |
| `getSupabase()` | admin if present, else publishable | read paths |

A deployment holding only the publishable key still boots and serves reads, but **cannot write** — so `supabasePrivilege().writable` is surfaced at boot and through an authenticated `/api/health`. There is **no browser Supabase client**: the browser only ever calls this app's own `/api` routes, so the SDK never ships to the client.

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

### Schema changes: `db/` is authored, `supabase/migrations/` is generated

Schema is authored in [`db/`](db/). [`supabase/migrations/`](supabase/migrations/) is a **generated mirror** that the Supabase GitHub integration applies to every preview branch and, on merge to `main`, to production.

```bash
npm run sync-migrations            # regenerate the mirror after editing db/
npm run sync-migrations -- --check # verify only; non-zero exit if stale
```

Two copies of the same DDL drift silently, and the failure mode is bad — Supabase would apply an **older** schema to production with no error anywhere. CI blocks that: `migrations-in-sync` fails the build if the mirror is stale, and `migrations-apply` runs every migration against a real Postgres 15, runs them **all a second time** to prove the idempotency each header claims, then asserts RLS is enabled on every table in `public`.

> **Working directory for the Supabase GitHub integration is `.`** — the field wants the path to the folder *containing* `supabase/`, not to `supabase/` itself. Entering `supabase` makes it look for `supabase/supabase/migrations/`, find nothing, and apply nothing, with no error shown anywhere.

### What lives in the database

| Table | Rows (live) | Purpose |
|---|---:|---|
| `games` | 16,913 | the catalog. RLS: public may read `is_working = true` |
| `game_stats` | 71 | per-game play counters (179 plays recorded) |
| `scores` | 1 | leaderboard, with anti-cheat `status` quarantine |
| `recommendations` | 0 | the community wall |
| `keepalive` | 1 | one row the `/healthz` probe pokes so a free-tier DB never pauses |
| `game_fingerprints` · `game_duplicates` · `rejected_submissions` | 0 | the discovery engine — operational metadata, **no public access at all** |

**RLS is deny-by-default everywhere and verified against production**: the publishable key gets `42501` on `INSERT`, sees 0 rows of every operational table, and reads exactly the 16,820 games the policy permits.

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
├── Dockerfile           # container image (Node 22-alpine, port 8080)
├── .github/workflows/   # CI: boot check · tests · migration mirror · migration apply
├── api/                 # bundled catalog JSON (fallback when Supabase is down)
├── data/                # catalog-overrides.json, feed-ranking.json, game-similarity.json
├── db/                  # Supabase SQL — AUTHORED HERE (schema, community, loaders)
├── supabase/            # CLI config + migrations/ (GENERATED mirror of db/) + seed.sql
├── legal/               # privacy / terms / DMCA / cookies source
├── lib/                 # server modules — supabase, supabase-keys, cron-jobs, cache,
│                        #   ai-pipeline, weather, recommender, credits, game-discovery
├── test/                # node:test suites (129 tests, no framework)
├── public/
│   ├── *.html           # pages (home, ai, community, leaderboard, browser, game…)
│   ├── css/  js/        # styles + vanilla frontend modules
│   │   └── pollinations.js  # CLIENT-SIDE AI — the browser talks to Pollinations directly
│   ├── gust/            # GUST proxy-browser UI (libcurl.js + Wisp)
│   ├── uv/  scram/      # Ultraviolet + Scramjet proxy engines
│   └── assets/ thumbs/  # images + game thumbnails
└── tools/               # maintenance scripts + sync-supabase-migrations.mjs
```

---

## 🧪 Tests & CI

```bash
npm test        # 129 tests, node:test — no framework, no install step
npm run check   # syntax-check every JS module
```

Tests run **without any secrets**: with no `.env` the server falls back to its bundled catalog, because a test that needs production keys is a test nobody runs. When a `.env` *is* present the suite gets stricter — the "no response body contains a real secret" test then compares every response against the 7 real configured values and **asserts it had something to compare against**, so it can never pass vacuously.

Four CI jobs run on every push and PR:

| Job | What it proves |
|---|---|
| `startup-check` | the server boots and `/api/health` answers |
| `tests` | the full suite passes |
| `migrations-in-sync` | `supabase/migrations/` still mirrors `db/` |
| `migrations-apply` | every migration applies to a real Postgres 15, is idempotent on re-apply, and leaves RLS on for every `public` table |

`migrations-apply` is **not** a deploy path — it uses a throwaway container and no secrets. Migrations reach production only through the Supabase GitHub integration; a second deploy path would be two systems racing on the same DDL.

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

ZoFHub's own code is under the terms in [`LICENSE`](LICENSE) — a **source-available, personal & non-commercial** license (not open source). The bundled proxy engines (Ultraviolet, Scramjet, GUST, Wisp, Epoxy, libcurl transport) are **AGPL-3.0**, and **libcurl.js is LGPL-3.0-or-later** — they keep their **own** upstream licenses, which always take precedence for those components. Because they are served over a network, the **AGPL-3.0 §13 source offer** applies; see **[CREDITS.md](CREDITS.md)** for the full attribution and that offer. Standalone copyleft companion browsers are **not** included in this repository.

Games are served through their publishers' **official embed URLs**; ZoFHub hosts no pirated game assets.

## 👨‍💻 Author

**ZSM1010** — maintained pseudonymously. Reach the project via the [ZoFHub Discord](https://discord.gg/SeMuMRG9gG).
