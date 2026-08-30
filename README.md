# 🎮 ZoFHub — Gaming · AI · Browser Hub

![Node](https://img.shields.io/badge/Node-%E2%89%A522-3c873a?logo=node.js&logoColor=white)
![Express](https://img.shields.io/badge/Server-Express-000000?logo=express&logoColor=white)
![Supabase](https://img.shields.io/badge/Database-Supabase-3ecf8e?logo=supabase&logoColor=white)
![No build step](https://img.shields.io/badge/build-none-blue)
![Tests](https://img.shields.io/badge/tests-562%20passing-brightgreen)
![Deploy](https://img.shields.io/badge/Deploy-Render-46E3B7?logo=render&logoColor=white)
[![Discord](https://img.shields.io/badge/Discord-ZoFHub%20Official-5865F2?logo=discord&logoColor=white)](https://discord.gg/SeMuMRG9gG)

A single-server web app that bundles three things into one site:

1. **A games hub** — **~12,300 playable games** served from official/authorized embeds (~16,800 catalogued; see [Catalog](#-the-catalog-what-is-actually-served)), with search, categories, favorites, a Game of the Day, a natural-language **Vibe Finder**, and a personalized **For You** row.
2. **A free AI assistant** — chat + image generation via [Pollinations](https://pollinations.ai), running **entirely in the visitor's browser**. Keyless, and **no prompt, reply or generated image ever touches this server** — that is enforced by the server, not just by convention. See [AI runs on the visitor's device](#-ai-runs-on-the-visitors-device).
3. **A proxy web browser** — an optional "open the web" mode (GUST + Ultraviolet/Scramjet/Wisp) for filtered networks.

It's built with **Node.js + Express**, vanilla **HTML/CSS/JS** (no framework, **no build step**), and **Supabase** (Postgres) for the catalog, feedback, and community data. It runs as **one always-on site** carrying both the games hub and the proxy, with optional advertising on the hub pages only — never on the proxy, and never Google AdSense.

---

## ✨ Features

- 🎮 **12,289 playable games** from GameMonetize, Y8, OnlineGames.io and GameDistribution — all via their official embed URLs, every one from a distributor that licenses third-party embedding. (Another ~4,630 rows are catalogued but deliberately not served — see [Catalog](#-the-catalog-what-is-actually-served).)
- ⚡ **Instant catalog** — the full game list is held in memory and refreshed from Supabase every 30 min; API responses are edge-cached.
- 🌟 **Game of the Day** — a deterministic daily pick (same for every visitor, changes at UTC midnight), genre-weighted toward what players actually play.
- 💬 **Feedback** — a "Send feedback" dialog on every page writes to an **insert-only** `feedback` table (anon may INSERT, never SELECT) and is read only from the admin console. Nothing submitted is ever shown publicly.
- 🙏 **Donations** — an optional "Support ZoFHub" dialog. Addresses live in the **environment, never in git**, are **checksum-verified at boot**, and a method that fails is dropped rather than served. Optional **swap donations** let a donor pay BTC/LTC/SOL/ETH/DOGE while a non-custodial provider settles to Monero — no invoice, session or IP is stored anywhere. See [`lib/swap.mjs`](lib/swap.mjs) for exactly which party can and cannot see what.
- 🕶️ **No accounts, no passwords** — every visitor gets an auto-generated device-local username (e.g. `SwiftFalcon1234`). Nothing to sign up for, no emails collected.
- 🤖 **Built-in AI** — text + image generation, streamed, browser-direct and keyless, with a "Vibe Finder" that recommends games from your mood and a local answer cache for instant repeats.
- 🌐 **Proxy browser (optional)** — GUST (libcurl.js + Wisp), Ultraviolet, and Scramjet engines for browsing on locked-down networks.
- 🧩 **Modular advertising** — five supported networks (HilltopAds / Adsterra / Monetag / Ad-Maven / PopAds), each independently enabled, and structurally excluded from every proxy surface. Never Google AdSense. See [💰 Advertising](#-advertising).
- 💤 **Free-tier friendly** — a secured `/healthz` keep-alive endpoint keeps Render + Supabase awake without a paid plan.
- 🛠️ **Self-maintaining** — scheduled jobs check dead links, grow the catalog with render-verified games, sync Y8, prune community posts and admin logs, and heartbeat the DB. See [`lib/cron-jobs.mjs`](lib/cron-jobs.mjs).

---

## 🧱 Tech stack

| Layer | Choice |
|---|---|
| Server | Node.js (≥22) + Express, ES modules, **no build step** |
| Frontend | Vanilla HTML / CSS / JavaScript (no framework, no bundler) |
| Database | Supabase (Postgres) — accessed via PostgREST, RLS deny-by-default |
| AI | Pollinations, **browser-direct and keyless** — never proxied by this server |
| Proxy | GUST · Ultraviolet · Scramjet · Wisp · libcurl.js *(see [CREDITS.md](CREDITS.md))* |
| Tests | `node:test` (built in — zero test dependencies), 562 tests |
| CI | GitHub Actions — boot check, tests, migration mirror, live migration apply |
| Hosting | Render (persistent web service) — `render.yaml` included |

---

## 🎮 The catalog: what is actually served

The numbers differ at each layer, on purpose. Measured from
`data/games-export.json` with `data/catalog-overrides.json` applied — the same
path the server takes, and reproducible offline:

| Layer | Count | Why |
|---|---:|---|
| Rows in `data/games-export.json` | **16,916** | everything ever ingested |
| Visible to the public key (`games_public`) | 16,783 | the RLS policy is exactly `is_working = true` |
| **Actually served to visitors** | **12,289** | after provider exclusions + curation overrides |

Those counts drift as the hourly link-check and the grow job run. Reproduce every
number in this section with **`npm run audit-served`** — it applies
`data/catalog-overrides.json` to the export and prints exactly this breakdown. For
the live database instead: `npm run db:verify`, and `curl -s
localhost:8080/api/games?limit=1` (the `total` field) for what is actually served.

### Where the served games come from

| Provider | Served | Share |
|---|---:|---:|
| GameMonetize (`html5.gamemonetize.co`) | 9,546 | 77.7% |
| Y8 (`www.y8.com` + `y8.com`) | 2,347 | 19.1% |
| OnlineGames.io (`www.` + `cloud.onlinegames.io`) | 248 | 2.0% |
| GameDistribution (`html5.gamedistribution.com`) | 148 | 1.2% |

**Every served game now comes from a distributor that licenses third-party
embedding.** That is the whole list — no single-title hosts, no site roots, no
`famobi` / `smashkarts` / `gamezop` / `gameflare` / `htmlgames` URLs anywhere in
the served set.

**No game is embedded from a publisher's own site root any more.** Six were:
`smashkarts.io`, `suroi.io`, `bloxd.io`, `deadshot.io`, `lolbeans.io` and a
TurboWarp remake — each framing an entire live website rather than a licensed
embed URL. All are blocked by host, so a re-import cannot bring them back under a
new slug. Suroi is the one with a way forward: its code is GPL-3.0, so it can be
**self-hosted** instead of framed — see [`suroi/`](suroi/).

### Why ~4,630 catalogued games are never served

This is deliberate, and it is the single most surprising thing about the catalog.
**Three different reasons** get confused constantly, so they are separated here:

**Excluded because they do not render**

- **HTMLGames (1,195)** — frame-busts via its on-page `GameLib/ThirdParty.js`, so an embed renders a broken or hijacked page.
- **GameFlare (154)** — every one of these rows points at **`distribution.gameflare.com/embed/`**, which returns `403` + `X-Frame-Options: SAMEORIGIN` for third-party embeds (re-verified 2026-07-29, 25/25 probes).
  The host matters: **`www.gameflare.com/embed/` behaves differently** and does frame — measured 2026-08-15, HTTP 200 with a readable child document. It is not a way to unblock these 154 rows, because it gates every game behind a mandatory ~30s AdInPlay pre-roll video ad whose revenue is GameFlare's, and because most titles tested still fail to start after it. See [`data/gameflare-embed-discovery.json`](data/gameflare-embed-discovery.json) and `npm run gameflare:verify`.

**Excluded for licensing**

- **Famobi (603)** — blocked 2026-08-04. `tools/audit-licensing.mjs` puts Famobi in tier **ACCOUNT**: embedding is free but must run through their publisher programme and feed, and every catalog row is a raw `play.famobi.com` hotlink instead. Also removed as a catalog-growth source, so no new ones arrive.
- **Gamezop (228)** — tier **PARTNER-ID**: the embeds carry a *different* publisher's partner id, not ours.
- **Trademark titles (24)** — names that carry a third party's registered mark: Tetris, GTA, Minecraft, Fruit Ninja, Cookie Clicker, Five Nights at Freddy's, Geometry Dash, Fireboy & Watergirl, Hill Climb Racing, Subway Surfers, Smash Karts and others. Blocked by slug, by title **and** by host, because a re-import can change a slug but not a name. Found by running the repo's own 107-pattern list ([`tools/cleanup-ip.mjs`](tools/cleanup-ip.mjs)) against the *served* catalog for the first time — it had only ever been pointed at the three source JSON files, so nothing had checked what visitors actually see.

**Excluded because they are dead**

- **33 games (0.27%)** proved broken by a full end-to-end probe of all 12,346 then-served games, each re-checked three times: 17 hard 404s, 11 connection resets, 3 soft-404s (a `200` whose body is GameDistribution's *"Not found at origin!"* page), 1 that forbids framing, 1 `403`. Re-run with **`npm run verify-catalog -- --all`**.

**Excluded as duplicates**

- **Curation overrides (2,465 remove rules — 2,450 by slug, 10 by host, 4 by title)** in [`data/catalog-overrides.json`](data/catalog-overrides.json). Most are the same game ingested twice under a hyphen and an underscore slug.

Rows stay in the database rather than being deleted, so every exclusion is reversible from one file if a provider's policy or our licence position changes. Each rule carries a `_note` or `_why` recording the evidence.

**21 categories in the served set.** Largest: arcade (2,271), racing (1,223), girls (1,128), puzzle (1,095), action (1,081), shooting (1,056), sports (1,026).

### Keeping it that way

Two commands, and they answer different questions:

| Command | Asks | Cost |
|---|---|---|
| `npm run audit-served` | *Should this game be here, and is the row coherent?* Trademark names, site-root embeds, hotlinked thumbnails, duplicate slugs/embeds, missing fields, unrouted hosts, missing thumbnail files. | offline, instant |
| `npm run verify-catalog -- --all` | *Does it actually load?* Status after redirects, **framing headers**, content-type, soft-404 bodies. | ~37 min for all 12,289 |

The second exists because the first cannot see it, and because the hourly
link-checker only asks *"did it 404?"*. **A game can return a clean `200` and
still be a black rectangle**, because the response says it may not be framed.
GameFlare did exactly that — `200` to a browser, `403` + `SAMEORIGIN` to an
iframe — and 108 games rendered blank while the link checker called them healthy.

Sampled by default (`npm run verify-catalog`, ~570 probes, under a minute), and it
fails only on a **systemic** problem — one host over 20% broken — because failing
on ordinary catalog decay trains people to ignore the check.

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

**Prerequisites:** Node.js **22+** and Git — that is the whole list. No compiler, no Python, no build step. Supabase is optional for local dev; without it the app serves a bundled fallback catalog.

```bash
git clone https://github.com/ZSM1010/ZoFHub-Gaming-AI-Browser-Hub.git
cd ZoFHub-Gaming-AI-Browser-Hub
npm ci                    # exactly what package-lock.json pins — same as CI and Render

cp .env.example .env      # then fill in your values (see Configuration)
npm start                 # → http://localhost:8080
```

`.npmrc` sets `ignore-scripts=true`, so no dependency executes code while installing. That is a supply-chain control *and* a build requirement: one dependency ships a `preinstall` whose only job is to abort any install that is not pnpm. The one native addon in the tree (`bufferutil`, used by the Wisp tunnel) loads from prebuilt binaries, so node-gyp never runs.

The Python tools under `tools/` are optional and separate — see [NEW-LAPTOP-SETUP.md](NEW-LAPTOP-SETUP.md) and `tools/requirements.txt`. Nothing the server does depends on them.

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
| `ADMIN_SECRET` | Bearer token for `/api/admin/*` — the catalog, analytics, security and feedback endpoints. Unset = the panel and every admin route fail **closed**. |
| `ADMIN_PASSWORD_HASH` | scrypt hash of the `/admin` login password, from `npm run admin-hash`. The plaintext password is never stored anywhere. |
| `SITE_URL` | Optional. Names the site on the legal pages and pins the CORS origin. If unset, those pages derive the name from the request; CORS falls back to same-host matching. |
| `POLLINATIONS_PUBLIC_KEY` | Optional `pk_` key served to the browser to lift the anonymous per-IP AI limit. **Publishable by design** — never put an `sk_` key here. |
| `<NETWORK>_ENABLED` | Turn one of the five networks on. Prefixes: `HILLTOPADS` `ADSTERRA` `MONETAG` `ADMAVEN` `POPADS`. See [💰 Advertising](#-advertising). |
| `<NETWORK>_SCRIPT` | That network's loader URL(s), comma-separated, https only. |
| `<NETWORK>_<SLOT>_TAG` | Raw tag for a fixed slot — `HEADER` / `SIDEBAR` / `FOOTER` / `INCONTENT`. |
| `PROXY_AD_SCRIPTS` | **Deprecated** legacy loader list, kept so existing deploys keep earning. Carries no network identity — migrate to `<NETWORK>_*`. |
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

## 💰 Advertising

ZoFHub supports **five** networks and no others:

**HilltopAds · Adsterra · Monetag · Ad-Maven · PopAds**

Google AdSense and Ad Manager are refused at three separate layers and must never
be enabled — Google bans proxy/anonymiser domains at the **account** level, so one
stray tag could take down an unrelated AdSense account.

> ### ⚠ No network has approved this site
> All five require publisher review of your **specific domain**, and nothing in
> this repository can tell you the outcome. The provider registry records every
> network as `needs-approval`, and a test fails the build if an entry ever claims
> otherwise. Approval for one format does not imply approval for another.
>
> **ZoFHub hosts a web proxy.** Several networks restrict that, and the rules are
> not consistently published. Raise it explicitly with each network before
> enabling. Full matrix: **[docs/ADVERTISING.md](docs/ADVERTISING.md)**.

### Enabling a network

Every network uses the same variables — no per-network special casing anywhere:

```bash
ADSTERRA_ENABLED=1
ADSTERRA_SCRIPT=https://<the loader URL your dashboard gives you>
ADSTERRA_FOOTER_TAG=<script>…</script>     # optional, for a fixed slot
```

Prefixes: `HILLTOPADS` `ADSTERRA` `MONETAG` `ADMAVEN` `POPADS`.
Slots: `HEADER_TAG` `SIDEBAR_TAG` `FOOTER_TAG` `INCONTENT_TAG`.

```bash
npm run check-ads      # will they actually load? env → CSP → serving → DNS
```

**Unset everything and the site runs ad-free** — no empty boxes, no reserved
space, no requests. That is the default and it is fully supported.

Three rules are enforced rather than suggested: **enabled without configuration
renders nothing**, **one slot is owned by exactly one network**, and **the same
loader URL is never injected twice**.

### Ads never touch the proxy

`/browser`, `/gust`, `/uv/*`, `/sj/*`, Wisp and every proxy asset route **cannot**
carry advertising. What renders there is somebody else's website, fetched on the
visitor's behalf — monetising it would mean injecting script into third-party
content in transit.

Enforced in three places: `isAdSurface()` in the registry, an empty ad payload
from `/api/site-config`, and a path check in `layout.js` that runs *before* it
asks the server for anything. An **unclassified route gets no ads**, because a
route nobody classified is a route nobody reasoned about.

### Placement

Four slots, all inside ZoFHub's own layout: header 728×90, sidebar 300×250,
footer 728×90, and six in-content positions. Every slot reserves its exact size
up front so a late creative cannot shift the page, and an unset slot collapses to
nothing.

Never placed over game controls, navigation, the AI composer, or proxy content.
Interstitials are throttled via `localStorage` so a network cannot put a
full-screen ad between a player and the game they just clicked.

> **Honest expectations.** Proxy traffic pays low rates — often cents per 1,000
> views — so real income needs real, steady traffic first. Keep it clean: no fake
> loading timers, no "complete an offer to unlock" gates, no forced surveys. Clean
> placement is what keeps accounts alive.

---

## 🛡️ Admin console

`/admin` is a full operator dashboard: overview stats, game visibility, catalog
health, analytics, the feedback inbox, community moderation and a Security Centre.

```bash
npm run admin-hash        # prompts (hidden), prints the hash + a session secret
```

Put the three values it prints into your host's environment, then sign in at
`/admin/login`.

| Variable | Purpose |
|---|---|
| `ADMIN_USERNAME` | The operator's username |
| `ADMIN_PASSWORD_HASH` | scrypt hash — **never** a plaintext password |
| `ADMIN_SESSION_SECRET` | Keys session tokens and the audit trail's IP hashes (32+ chars) |
| `ADMIN_SECRET` | Independent **machine** token for monitors/CLI, sent as a Bearer header |

### How it is actually protected

- **Passwords** are verified server-side against a versioned `scrypt$N$r$p$salt$hash`
  string. A malformed, foreign or absent hash fails **closed** — it rejects every
  login rather than accepting every login.
- **Sessions** live in Postgres. The cookie carries a 256-bit random token; the
  database stores only its SHA-256 hash, so a dump of `admin_sessions` grants
  nobody a session. The cookie is `HttpOnly` + `SameSite=Strict` (+ `Secure` in
  production), so page JavaScript cannot read the credential at all.
- **Expiry** is enforced server-side on every request: an 8-hour absolute cap and
  a 30-minute idle timeout. A session whose **user agent** changes is revoked; one
  whose IP changes raises a security event but survives, because mobile networks
  legitimately change addresses.
- **Brute force** — five failures from one IP inside 15 minutes locks that IP for
  15 minutes. The password KDF runs even for an unknown username so response time
  cannot enumerate accounts, and every rejection returns the same generic message.
- **CSRF** — double-submit token plus `Origin` validation on every state-changing
  route. Bearer-token callers are exempt, because a browser never attaches an
  `Authorization` header automatically, so there is nothing to forge.
- **Audit** — `admin_audit_logs` is append-only, enforced by a database trigger
  that refuses `UPDATE` and `DELETE`. The dashboard exposes no path to edit it.
  Client IPs are stored only as a keyed HMAC, never as addresses.

### Two things worth knowing

The console's HTML lives in **`admin-ui/`, outside `public/`**. The first version
put it in `public/admin/`, where `express.static` served
`public/admin/admin-dashboard.html` to anonymous callers with a `200` — the auth
route below it never ran. Keeping the documents out of the web root means there
is no middleware order left to get wrong.

`?key=<secret>` **no longer authenticates anything**. A credential in a query
string is written to the hosting access log, kept in browser history, and
forwarded in the `Referer` of every outbound link on the page.

---

## 🗄️ Database setup (Supabase)

The live catalog and community features live in Supabase. Fastest path once your `.env` has the Supabase keys:

```bash
npm run restore-games     # loads every game source into Supabase in one command
```

Prefer the SQL editor? Paste **[`db/SCHEMA-ONLY.sql`](db/SCHEMA-ONLY.sql)** — it is all 13 migrations concatenated in dependency order, generated from the same `ORDER` array in [`tools/sync-supabase-migrations.mjs`](tools/sync-supabase-migrations.mjs) that produces `supabase/migrations/`, so it cannot drift from what the deploy applies. Assembling the schema by hand from individual `db/*.sql` files is the one thing not to do: the order is load-bearing and not alphabetical, and omitting a file is silent. Two things about that order matter: **the teardown and privilege files run at the end** — `db/feedback.sql` retires the leaderboard by dropping `scores` and its `SECURITY DEFINER` functions and creates the private `feedback` table, then `db/schema-hardening.sql` applies the audit corrections, and `db/grants.sql` runs last of all, granting privileges over whatever survived the drops (skip it and every table exists but answers `42501 permission denied`) — and the older `community-scores-*.sql` files still run even though the leaderboard is gone: migration history is replayed forwards, not rewritten. That is also why the corrections live in a new file instead of edits to the applied ones; Supabase will not re-run a migration it has already recorded, so editing one changes the repository's account of the database without changing the database. Then load the `load-*.sql` game loaders. Big loaders are split into numbered `-partNN.sql` files that each stay under Supabase's editor save limit; run the parts in numeric order (every one is an idempotent upsert, so re-running is safe).

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
| `games` | ~16,900 | the catalog. RLS: public may read `is_working = true`. ~12,300 of these reach visitors — see [Catalog](#-the-catalog-what-is-actually-served) |
| `game_stats` | 0 | per-game play counters. Empty: the database was rebuilt on a new project, so counting restarts from zero |
| `feedback` | — | "Send feedback" messages. RLS is **insert-only**: anon/authenticated may `INSERT` and nothing else, so a message can never be read back by the public |
| `recommendations` | 0 | the community wall |
| `keepalive` | 1 | one row the `/healthz` probe pokes so a free-tier DB never pauses |
| `game_fingerprints` · `game_duplicates` · `rejected_submissions` | 0 | the discovery engine — operational metadata, **no public access at all** |
| `admin_sessions` · `admin_audit_logs` · `admin_login_attempts` · `admin_security_events` | — | the admin console. Audit log is append-only (database trigger); **no public access at all** |

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
│                        #   ai-pipeline, recommender, credits, game-discovery
├── test/                # node:test suites (562 tests, no framework)
├── public/
│   ├── *.html           # pages (home, ai, community, browser, game…)
│   ├── css/  js/        # styles + vanilla frontend modules
│   │   └── pollinations.js  # CLIENT-SIDE AI — the browser talks to Pollinations directly
│   ├── gust/            # GUST proxy-browser UI (libcurl.js + Wisp)
│   ├── uv/  scram/      # Ultraviolet + Scramjet proxy engines
│   └── assets/ thumbs/  # images + game thumbnails
├── tools/               # maintenance scripts + sync-supabase-migrations.mjs
│   ├── audit.py         # entry point for the repository auditor
│   └── zofaudit/        # the checks it runs (stdlib-only Python)
└── db/ALL-IN-ONE.sql    # GENERATED — npm run build-all-in-one
```

---

## 🧪 Tests & CI

```bash
npm test        # 562 tests, node:test — no framework, no install step
npm run check   # syntax-check every front-end module (public/js + admin-ui)
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

## 🔎 Repository auditor

```bash
npm run db:verify             # is the DEPLOYED database what these migrations say?
npm run audit:repo            # every check, human-readable
npm run audit:sql             # just the database
npm run audit:repo:json       # machine-readable — includes the full import graph
npm run audit:ci              # exit 1 on anything at warn or above
```

Static analysis of the things this project has nothing else watching for. No build step means no bundler resolving imports, no type checker comparing a query to a schema, and no framework noticing a route nobody calls — so those are checked here instead. **Python 3, standard library only**: an auditor you have to `pip install` before running is one that does not get run. It needs no `.env` and reaches no network.

| Check | What it decides |
|---|---|
| `sql` | replays all 13 migrations, then holds every `.from()` / `.rpc()` / `.select()` in the runtime against the result — missing tables, missing columns, RPCs with no function, `DROP FUNCTION` that matches nothing, `SECURITY DEFINER` without a `revoke`, functions that do not pin `search_path`, tables without RLS, redundant indexes |
| `json` | every JSON file parses; `catalog-overrides.json` rules that contradict each other |
| `env` | read in code vs `.env.example` vs `render.yaml`, separating required variables from tunables that carry a default |
| `api` | routes the server registers vs paths the browser requests — in **both** directions |
| `deps` | import targets that do not exist, static import cycles, modules nothing imports |
| `assets` | files in `public/` that nothing references |
| `perf` | unstable pagination, unbounded selects, synchronous filesystem calls inside a request handler |
| `live` | the **running** database vs these migrations — objects missing, objects nobody declared, columns that differ, and whether the publishable key can read a private table (needs credentials; skips cleanly without) |

The `sql` check is the one that pays for the rest. Nearly every interesting question about this database — *does `scores` still exist? is that function reachable?* — is a property of the **sequence** of migrations, not of any single file, and no amount of careful reading of one file answers it. Replaying them does.

Findings carry the text that produced them, so the tool's work can be checked at a glance rather than taken on trust. Its own precision is guarded by `test/schema-integrity.test.mjs`, which re-derives the schema independently and asserts the same invariants — if the two ever disagree, one of them is wrong.

---

## 📚 Documentation

| Guide | What it covers |
|---|---|
| [HOW-IT-WORKS.md](HOW-IT-WORKS.md) | Plain-English tour of the whole app |
| [NEW-LAPTOP-SETUP.md](NEW-LAPTOP-SETUP.md) | Moving to a new machine (this private repo backs up everything — just clone + `npm ci`) |
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
