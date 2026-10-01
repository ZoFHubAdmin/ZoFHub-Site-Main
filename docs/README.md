# 🎮 ZoFHub — Gaming · AI · Browser Hub

![Node](https://img.shields.io/badge/Node-%E2%89%A522-3c873a?logo=node.js&logoColor=white)
![Express](https://img.shields.io/badge/Server-Express-000000?logo=express&logoColor=white)
![Supabase](https://img.shields.io/badge/Database-Supabase-3ecf8e?logo=supabase&logoColor=white)
![No build step](https://img.shields.io/badge/build-none-blue)
![Tests](https://img.shields.io/badge/tests-1009%20passing-brightgreen)
![Deploy](https://img.shields.io/badge/Deploy-Render-46E3B7?logo=render&logoColor=white)
[![Discord](https://img.shields.io/badge/Discord-ZoFHub%20Official-5865F2?logo=discord&logoColor=white)](https://discord.gg/SeMuMRG9gG)

A single-server web app that bundles three things into one site:

1. **A games hub** — **~12,300 playable games** served from official/authorized embeds (~16,900 catalogued; see [Catalog](#-the-catalog-what-is-actually-served)), with search, categories, favorites, a Game of the Day, a natural-language **Vibe Finder**, and a personalized **For You** row.
2. **A free AI assistant** — chat + image generation via [Pollinations](https://pollinations.ai), running **entirely in the visitor's browser**. Keyless, and **no prompt, reply or generated image ever touches this server** — that is enforced by the server, not just by convention. See [AI runs on the visitor's device](#-ai-runs-on-the-visitors-device).
3. **A proxy web browser** — an optional "open the web" mode (GUST + Ultraviolet/Scramjet/Wisp) for filtered networks, with an optional **managed [sing-box](proxy/SINGBOX.md)** backend for REALITY/VLESS transport.

> **Public metadata is framed as a security tool.** The served `<title>`, Open
> Graph and description tags present the site as a *"cloud-based web-security
> sandboxing tool and browser diagnostic hub"* rather than a games portal, so
> automated content filters classifying it by its metadata do not trip on gaming
> or unblocker keywords. This is a uniform rebrand of the public meta tags — the
> same for every viewer — not content served differently to scanners than to
> people.

It's built with **Node.js + Express**, vanilla **HTML/CSS/JS** (no framework, **no build step**), and **Supabase** (Postgres) for the catalog, feedback, and community data. It runs as **one always-on site** carrying both the games hub and the proxy, with optional advertising on the hub pages only — never on the proxy, and never Google AdSense.

---

## ✨ Features

- 🎮 **12,289 playable games** from GameMonetize, Y8, OnlineGames.io and GameDistribution — all via their official embed URLs, every one from a distributor that licenses third-party embedding. (Another ~4,630 rows are catalogued but deliberately not served — see [Catalog](#-the-catalog-what-is-actually-served).)
- ⚡ **Instant catalog** — the full game list is held in memory and refreshed from Supabase every 30 min; API responses are edge-cached.
- 🌟 **Game of the Day** — a deterministic daily pick (same for every visitor, changes at UTC midnight), genre-weighted toward what players actually play.
- 💬 **Feedback** — a "Send feedback" dialog on every page writes to an **insert-only** `feedback` table (anon may INSERT, never SELECT) and is read only from the admin console. Nothing submitted is ever shown publicly.
- 🙏 **Donations** — an optional "Support ZoFHub" dialog offering six **crypto-only** methods: **Solana**, **USDC**, **Bitcoin**, **Litecoin**, **Ethereum** and **Monero**. There is no card option, so a visitor without a wallet cannot donate — deliberate, not an oversight. SOL and USDC share **one address and one wallet**, listed separately so a donor holding dollars need not know USDC is an SPL token. Addresses live in the **environment, never in git**, are **checksum-verified at boot**, and a method that fails is dropped rather than served — a typo becomes a missing button, not lost donations. BTC, LTC and ETH get **full checksum** verification (ETH via a dependency-free **Keccak-256** + EIP-55 implementation, since `node:crypto` ships SHA-3, which is a different function); SOL, USDC and XMR are shape-checked only and say so. A **swap path** (pay BTC, LTC, SOL, ETH or DOGE; a non-custodial provider settles to Monero; nothing stored) exists as a server API but **no page offers it yet**. Full detail, including which party can and cannot see what: [DONATIONS.md](features/DONATIONS.md).
- 🕶️ **No accounts, no passwords** — every visitor gets an auto-generated device-local username (e.g. `SwiftFalcon1234`). Nothing to sign up for and no email required — the only addresses ever stored are ones a visitor volunteers, for the mirror-update list or a feedback reply. See [what the site remembers](features/VISITOR-FEATURES.md#8-what-the-site-remembers-about-you).
- 🤖 **Built-in AI** — text + image generation, streamed, browser-direct and keyless, with a "Vibe Finder" that recommends games from your mood and a local answer cache for instant repeats.
- 🌐 **Proxy browser (optional)** — GUST (libcurl.js + Wisp), Ultraviolet, and Scramjet engines for browsing on locked-down networks, plus optional external engines you host yourself ([Kasm](proxy/KASM.md), [InvisiProxy](proxy/INVISIPROXY.md)) — plus [AnuraOS](proxy/ANURA.md), a whole web OS with x86 emulation, served by this process on its own origin. `npm run verify-proxy` renders real pages through each one and fails if any stops working.
- 🧩 **Modular advertising** — six supported networks, **one role each**: Ad-Maven the between-games interstitial (**1 per visitor per 20 min**, a constant), ExoClick the header and sidebar banners, HilltopAds the in-page push, Clickadu a skippable video pre-roll before a game loads, Mondiad native widgets below the "for you" rows, PopAds a desktop-only game-page popunder. Region-localised tags, structurally excluded from every proxy surface, never Google AdSense, and an [ad-block gate](features/ADVERTISING.md#the-ad-block-gate) that locks only the premium proxy engines. See [💰 Advertising](#-advertising).
- 🛡️ **RBAC admin** — the interactive admin is the `owner`; the static machine token runs as `operator` (or `viewer`) and **cannot** revoke sessions or purge running config. Every denial is audited. See [🛡️ Admin console](#️-admin-console).
- 🔌 **Managed sing-box (optional)** — ZoFHub can build a pinned [sing-box](proxy/SINGBOX.md) release into the image, render its config, `sing-box check` it, spawn it, restart it with backoff, and stop it on shutdown — as a decoupled child process that never blocks the event loop. Off by default. GPL-3.0, run as a separate program, not vendored.
- 💚 **Crash-safe by design** — `/healthz` returns **503 above 85% memory** so an orchestrator recycles the container before the OOM killer hits mid-request; the Wisp tunnel has a global cap **and** a per-client cap so one runaway visitor cannot starve the pool.
- 🔒 **Stated egress policy** — `/wisp/` is the one endpoint that dials an address a stranger chose, so its rules are written down rather than inherited from a library default: a **port allowlist** (80/443/8080/8443 — not 25, 22 or 3306), **no UDP**, private/loopback addresses refused, and a per-tunnel stream cap. Proven against a live tunnel, including a control case. See [docs/proxy/INVISIPROXY.md](proxy/INVISIPROXY.md#2-what-is-integrated).
- 🕶️ **Mirror survival (MASQR)** — *off by default.* A mirror domain usually dies because a shared link reaches a filter vendor whose crawler fetches it, sees a proxy, and burns the domain. Switched on, an unauthenticated visitor sees only the games hub while the proxy surfaces answer 404; a signed key in a link unlocks them. Never gates `/healthz`, the legal pages or the games. Not access control — see [docs/proxy/MASQR.md](proxy/MASQR.md).
- 💤 **Free-tier friendly** — a secured `/healthz` keep-alive endpoint keeps Render + Supabase awake without a paid plan.
- 🛠️ **Self-maintaining** — scheduled jobs check dead links, grow the catalog with render-verified games, sync Y8, prune community posts and admin logs, and heartbeat the DB. See [`lib/cron-jobs.mjs`](../lib/cron-jobs.mjs).

---

## 🧱 Tech stack

| Layer | Choice |
|---|---|
| Server | Node.js (≥22) + Express, ES modules, **no build step** |
| Frontend | Vanilla HTML / CSS / JavaScript (no framework, no bundler) |
| Database | Supabase (Postgres) — accessed via PostgREST, RLS deny-by-default |
| AI | Pollinations, **browser-direct and keyless** — never proxied by this server |
| Proxy | GUST · Ultraviolet · Scramjet · Wisp · libcurl.js *(see [CREDITS.md](CREDITS.md))* |
| Egress | Explicit policy in [`lib/wisp-policy.mjs`](../lib/wisp-policy.mjs) — port allowlist, no UDP, private IPs blocked |
| Tests | `node:test` (built in — zero test dependencies), 1009 tests |
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
**self-hosted** instead of framed — see [`suroi/`](../suroi/).

### Why ~4,630 catalogued games are never served

This is deliberate, and it is the single most surprising thing about the catalog.
**Three different reasons** get confused constantly, so they are separated here:

**Excluded because they do not render**

- **HTMLGames (1,195)** — frame-busts via its on-page `GameLib/ThirdParty.js`, so an embed renders a broken or hijacked page.
- **GameFlare (154)** — every one of these rows points at **`distribution.gameflare.com/embed/`**, which returns `403` + `X-Frame-Options: SAMEORIGIN` for third-party embeds (re-verified 2026-07-29, 25/25 probes).
  The host matters: **`www.gameflare.com/embed/` behaves differently** and does frame — measured 2026-08-15, HTTP 200 with a readable child document. It is not a way to unblock these 154 rows, because it gates every game behind a mandatory ~30s AdInPlay pre-roll video ad whose revenue is GameFlare's, and because most titles tested still fail to start after it. See [`data/gameflare-embed-discovery.json`](../data/gameflare-embed-discovery.json) and `npm run gameflare:verify`. That work lives in a **separate** GameFlare catalog with its own player and stricter rules, currently empty by design — see [GAMEFLARE.md](features/GAMEFLARE.md).

**Excluded for licensing**

- **Famobi (603)** — blocked 2026-08-04. `tools/audit-licensing.mjs` puts Famobi in tier **ACCOUNT**: embedding is free but must run through their publisher programme and feed, and every catalog row is a raw `play.famobi.com` hotlink instead. Also removed as a catalog-growth source, so no new ones arrive.
- **Gamezop (228)** — tier **PARTNER-ID**: the embeds carry a *different* publisher's partner id, not ours.
- **Trademark titles (24)** — names that carry a third party's registered mark: Tetris, GTA, Minecraft, Fruit Ninja, Cookie Clicker, Five Nights at Freddy's, Geometry Dash, Fireboy & Watergirl, Hill Climb Racing, Subway Surfers, Smash Karts and others. Blocked by slug, by title **and** by host, because a re-import can change a slug but not a name. Found by running the repo's own 107-pattern list ([`tools/cleanup-ip.mjs`](../tools/cleanup-ip.mjs)) against the *served* catalog for the first time — it had only ever been pointed at the three source JSON files, so nothing had checked what visitors actually see.

**Excluded because they are dead**

- **33 games (0.27%)** proved broken by a full end-to-end probe of all 12,346 then-served games, each re-checked three times: 17 hard 404s, 11 connection resets, 3 soft-404s (a `200` whose body is GameDistribution's *"Not found at origin!"* page), 1 that forbids framing, 1 `403`. Re-run with **`npm run verify-catalog -- --all`**.

**Excluded as duplicates**

- **Curation overrides (2,465 remove rules — 2,450 by slug, 10 by host, 4 by title)** in [`data/catalog-overrides.json`](../data/catalog-overrides.json). Most are the same game ingested twice under a hyphen and an underscore slug.

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
| Chat / text | `fetch()` from the browser → `text.pollinations.ai` ([`public/js/pollinations.js`](../public/js/pollinations.js)) |
| Images | `<img src="https://image.pollinations.ai/prompt/…">` — the browser loads the bytes |
| Text-to-speech | the browser builds the Pollinations URL and plays it directly. No audio passes through us, and the prompt never reaches this server |
| The `pk_` key | [`/api/ai/key`](../server.js) serves the **publishable** key so the browser can call Pollinations itself. Publishable keys are designed to be public; a secret `sk_` key must never go here |

**Why server-side AI routes still exist.** Pollinations' text endpoint sits behind a Cloudflare Turnstile check keyed on the `Origin` header, and it rejects browser fetches from `http://` and `localhost` origins. A developer running the site locally would otherwise have no working AI at all. So `/api/ai/text`, `/api/ai/image` and `/api/ai/echo` remain — as a **local-development aid only**.

**This is enforced, not promised.** `aiServerAllowed()` in [`server.js`](../server.js) refuses those routes when:

- `NODE_ENV=production` — always, no exceptions (`render.yaml` sets it), **or**
- the client is not on loopback. `trust proxy` is on, so `req.ip` is the real client address and an internet visitor can never present as `127.0.0.1`.

**The same guard covers the Vibe Finder.** `/api/vibe` sits outside `/api/ai/*`, and its optional AI refinement (`vibeKeywordsFromAI()`) was once the one path that escaped: a mood search that missed the curated map sent the visitor's **typed text** to Pollinations **from this server's IP** — measured at 3 s of dead wait on an ordinary query like "relaxing puzzle". It now checks `aiServerAllowed()` first, so in production the Vibe Finder uses only the curated mood map and the deterministic ranker in [`lib/vibe-engine.mjs`](../lib/vibe-engine.mjs). Nothing degrades — the AI was only ever an optional refinement — and every mood search is instant.

There is **no escape hatch**. The old `AI_SERVER_FALLBACK=1` switch was read *before* `NODE_ENV`, so it could re-open these routes on a live deployment; nothing reads it now. The rule lives in [`lib/ai-guard.mjs`](../lib/ai-guard.mjs) and is applied twice: by each route, and by a middleware that runs ahead of CORS, the body parser and the rate limiter — so a refused request is answered `403 {"error":"client_side_only"}` for every method and every spelling of the path, before its body is read. A tunnel that connects from loopback on an internet visitor's behalf is refused too, whichever forwarding header names the visitor. [`test/production-guards.test.mjs`](../test/production-guards.test.mjs) proves it against a real `NODE_ENV=production` boot.

The client half matches: `IS_LOCAL` in `pollinations.js` gates the text fallback and is **exported** so `ai.js` gates its image fallback on the identical condition — two copies of that rule would eventually drift, and the one that drifted would quietly start routing AI through the server. [`test/ai-guard.test.mjs`](../test/ai-guard.test.mjs) pins the rule, [`test/server.test.mjs`](../test/server.test.mjs) asserts an internet visitor is refused on all three routes in every method and spelling, and [`test/production-guards.test.mjs`](../test/production-guards.test.mjs) repeats it under a real production boot — loopback included.

**What this buys you:** no AI compute or bandwidth on your host, no shared rate-limit pool (each visitor uses their own IP), and prompts that are never observable server-side.

### The server refuses to fetch AI providers for a caller

Three routes accept a caller-supplied URL and fetch it server-side: `/thumb`, `/asset` and `/api/proxy/diag`. All three now refuse the ~20 hosts in `AI_PROVIDER_HOSTS` (Pollinations, AI Horde, OpenAI, Anthropic, Google, Groq, Mistral, Cohere, DeepSeek, Together, Replicate, fal, OpenRouter, HuggingFace, Stability, xAI, Perplexity).

This matters because `/asset` is *deliberately* a general cross-origin proxy — the injected iframe shim routes game assets through it to fix WebGL canvas tainting — so "general" previously included inference endpoints. A denylist rather than an allowlist, because an allowlist over an open-ended set of game CDNs would break games.

Two further routes (`/api/ai/audio`, `/api/ai/video`) are closed in production even though neither performs inference: they take the prompt in the **query string**, and hosting platforms log request paths, so the access log would accumulate prompt text in a log this code never writes and cannot clear.

### Privacy posture

`Permissions-Policy` explicitly denies 16 capabilities the site does not use — `geolocation`, `camera`, `microphone`, `browsing-topics` (Google's Topics ad-profiling API), `interest-cohort`, `idle-detection`, `local-fonts`, `usb`, `serial`, `bluetooth`, `hid`, `midi`, `display-capture`, `attribution-reporting`, `run-ad-auction`, `join-ad-interest-group`. Because the header is an allowlist, anything unlisted falls back to the browser default — and this site embeds thousands of third-party game and ad frames that would otherwise inherit the ability to request them.

No third-party analytics, no tracking cookies, no source maps, no accounts. Prompts and AI responses are never logged or stored server-side. The one visitor count that exists — the admin console's "visitors today" — is an **in-memory** set of keyed IP hashes for the current UTC day, dropped at midnight and on every restart, and never written anywhere. Everything the site keeps, and for how long, is in one table: [VISITOR-FEATURES.md §8](features/VISITOR-FEATURES.md#8-what-the-site-remembers-about-you).

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

The Python tools under `tools/` are optional and separate — see [NEW-LAPTOP-SETUP.md](guides/NEW-LAPTOP-SETUP.md) and `tools/requirements.txt`. Nothing the server does depends on them. The one thing to know: the **auditors** (`npm run db:verify`, `npm run audit:repo`) are among them, so checking a database or the repository does need Python 3.

> **Windows note:** `npm start` runs `node --use-system-ca server.js`. The `--use-system-ca` flag makes Node trust the Windows certificate store, which some corporate/school TLS setups require. On macOS/Linux/Docker it isn't needed.

Handy scripts: `npm run dev` (auto-restart on change) · `npm run restart` (free the port + start) · `npm run check` (JS syntax check).

---

## ⚙️ Configuration

All configuration is via environment variables — copy [`.env.example`](../.env.example) to `.env` and fill it in. The essentials:

| Variable | Purpose |
|---|---|
| `SUPABASE_URL` | Your project URL. Not a secret — it is in every API call the app makes. |
| `SUPABASE_PUBLISHABLE_KEY` | The browser-safe key (`sb_publishable_…`, formerly "anon"). Subject to RLS. `SUPABASE_ANON_KEY` is accepted as an alias. |
| `SUPABASE_SECRET_KEY` | **Server-only.** The `sb_secret_…` key. Bypasses RLS; required for every write. Never expose to the browser. |
| `ADMIN_SECRET` | Machine bearer token for `/api/admin/*` — monitors and CLI. Runs as `operator`, **never `owner`**, so it cannot revoke sessions, purge config or mint mirror keys (see [RBAC](#role-based-access-control)). **Use 32+ random characters** — nobody types this. The server warns at boot if it is shorter. |
| `ADMIN_PASSWORD_HASH` | scrypt hash of the `/admin` login password, from `npm run admin-hash`. The plaintext password is never stored anywhere. If this is not a `scrypt$…` string the console does not open at all — see below. |
| `ADMIN_USERNAME` | Login name for `/admin`. Required alongside the hash. |
| `ADMIN_SESSION_SECRET` | Signs admin session cookies **and** keys the audit log's IP HMAC. 32+ random characters. Changing it logs everyone out. |
| `SITE_URL` | Optional. Names the site on the legal pages and pins the CORS origin. If unset, those pages derive the name from the request; CORS falls back to same-host matching. |
| `POLLINATIONS_PUBLIC_KEY` | Optional `pk_` key served to the browser to lift the anonymous per-IP AI limit. **Publishable by design** — never put an `sk_` key here. |
| `<NETWORK>_ENABLED` | Turn one of the six networks on. Prefixes: `ADMAVEN` `EXOCLICK` `HILLTOPADS` `CLICKADU` `MONDIAD` `POPADS`. See [💰 Advertising](#-advertising). |
| `<NETWORK>_<ROLE FIELD>` | The one variable (or two) for that network's role — e.g. `EXOCLICK_HEADER_TAG`, `CLICKADU_PREROLL_VAST`. Append `__<REGION>` for a regional value. |
| `REGION_ROUTES` | Optional regions (`ID:COUNTRIES=HOSTS;…`) for regional domains and regional ad tags. See [lib/geo.mjs](../lib/geo.mjs). |
| `CRON_SECRET` | Protects `/healthz`; set the same value in your uptime monitor. |
| `CRON_DISABLED` | Set `1` to disable the scheduled background jobs (e.g. on a replica/test instance). |

> **There is no fallback console.** Earlier builds served a second, simpler
> console to anonymous visitors whenever these variables were missing or
> malformed, authenticating it with `ADMIN_SECRET` alone. That meant a
> mis-set variable silently downgraded `/admin` from "sessions, CSRF, lockout
> and an audit log" to "one shared token, no throttle, markup handed to
> anybody who asked". `/admin` now answers **503 with a setup notice** in that
> state — a notice with no form, no endpoint names and nothing to authenticate
> against. Being locked out of your own console costs one `npm run admin-hash`;
> a console anyone can reach costs rather more.
>
> Presenting a **wrong** credential — a bad bearer token or a dead session
> cookie — is also throttled per IP now (`ADMIN_CRED_*` in `.env.example`),
> in memory, so it still applies when the database is unreachable. A request
> carrying *no* credential is an ordinary anonymous 401 and is never counted,
> so a passer-by cannot lock you out of your own site.

> **This is the essentials, not the full list.** The proxy egress policy
> (`WISP_*`), the mirror gate (`MASQR_*`), sing-box, companion engines and
> donations are covered in [COMMANDS.md → Environment variables](guides/COMMANDS.md#️-environment-variables-env);
> `.env.example` is the complete, commented list.

> **`SUPABASE_SERVICE_ROLE_KEY` is retired.** The legacy `eyJ…` JWT is no longer set. It cannot be rotated and Supabase turns it off at the end of 2026. If you still have one, paste a new `sb_secret_…` key into `SUPABASE_SECRET_KEY` and disable the legacy pair in the dashboard. The loader mirrors the secret key onto the old variable name at import time, so the CLI tools that read `SUPABASE_SERVICE_ROLE_KEY` keep working with nothing set.

### Two Supabase clients, two security contexts

[`lib/supabase.mjs`](../lib/supabase.mjs) exposes three accessors, and which one a code path uses is a security decision:

| Accessor | Key | Use |
|---|---|---|
| `getSupabaseAdmin()` | secret only, **never** falls back | every write. Returns `null` with no admin key, so a write fails loudly instead of being refused by RLS with an opaque `42501` |
| `getSupabasePublic()` | publishable only, **never** escalates | anywhere a public security context is the correct one |
| `getSupabase()` | admin if present, else publishable | read paths |

A deployment holding only the publishable key still boots and serves reads, but **cannot write** — so `supabasePrivilege().writable` is surfaced at boot and through an authenticated `/api/health`. There is **no browser Supabase client**: the browser only ever calls this app's own `/api` routes, so the SDK never ships to the client.

---

## 💰 Advertising

ZoFHub supports **six** networks and no others, and each owns exactly **one** role:

| Network | Role | Variable(s) |
|---|---|---|
| **Ad-Maven** | between-games interstitial, ≤ 1 per visitor per 20 min (a constant) | `ADMAVEN_INTERSTITIAL_TAG` / `_URL` |
| **ExoClick** | header 728×90 + sidebar 300×250 | `EXOCLICK_HEADER_TAG`, `EXOCLICK_SIDEBAR_TAG` |
| **HilltopAds** | in-page push | `HILLTOPADS_PUSH_SCRIPT` |
| **Clickadu** | VAST video pre-roll before a game loads, skippable at 5 s | `CLICKADU_PREROLL_VAST` |
| **Mondiad** | native widget below the "for you" rows | `MONDIAD_NATIVE_TAG` |
| **PopAds** | popunder, desktop game pages only | `POPADS_POPUNDER_TAG` |

Google AdSense and Ad Manager are refused at three separate layers and must never
be enabled — Google bans proxy/anonymiser domains at the **account** level, so one
stray tag could take down an unrelated AdSense account.

> ### ⚠ No network has approved this site
> All six require publisher review of your **specific domain**, and nothing in
> this repository can tell you the outcome. The provider registry records every
> network as `needs-approval`, and a test fails the build if an entry ever claims
> otherwise. Approval for one format does not imply approval for another.
>
> **ZoFHub hosts a web proxy, and its audience includes minors.** Raise the proxy
> explicitly with each network, and set every dashboard to mainstream (non-adult)
> categories. Full matrix: **[docs/features/ADVERTISING.md](features/ADVERTISING.md)**.

### Enabling a network

```bash
EXOCLICK_ENABLED=1
EXOCLICK_HEADER_TAG=<the zone code your dashboard gives you, on one line>
EXOCLICK_HEADER_TAG__SOUTH_ASIA=<optional: a different zone for one region>
```

**Strict roles:** a placement renders only its owner's code. An owner that is off
or unconfigured leaves its placement dark — nobody fills in — and a variable
outside a network's role (or for a retired network, or a legacy `PROXY_*` slot)
is read by nothing and **named** at boot, in the admin panel and by
`npm run check-ads`.

```bash
npm run check-ads      # will they actually load? roles → CSP → per-page serving → DNS
```

**Unset everything and the site runs ad-free** — no empty boxes, no reserved
space, no requests. That is the default and it is fully supported.

### Ads never touch the proxy

`/browser`, `/gust`, the engine and transport paths, Wisp, the service workers
and the companion engines **cannot** carry advertising — the authoritative list is
`PROXY_SURFACES` in [`lib/ad-providers.mjs`](../lib/ad-providers.mjs), which the
[MASQR gate](proxy/MASQR.md) also reads, so one list answers "is this proxy
infrastructure?" for both features. What renders there is somebody else's website, fetched on the
visitor's behalf — monetising it would mean injecting script into third-party
content in transit.

Enforced in three places: `isAdSurface()` in the registry, an empty ad payload
from `/api/site-config`, and a path check in `layout.js` that runs *before* it
asks the server for anything. An **unclassified route gets no ads**, because a
route nobody classified is a route nobody reasoned about.

### Placement

Four slots, all inside ZoFHub's own layout: header 728×90, sidebar 300×250,
footer 728×90, and seven in-content positions. Every slot reserves its exact size
up front so a late creative cannot shift the page, and an unset slot collapses to
nothing.

Never placed over game controls, navigation, the AI composer, or proxy content.
The Ad-Maven interstitial is throttled via `localStorage` to **1 per visitor per
20 minutes** and **fails closed** — if storage is unavailable it shows nothing
rather than firing unthrottled. Ad code also cannot reach the sing-box execution
layer: sing-box is a separate process on its own port, so there is no surface
there to inject into.

> **Honest expectations.** Proxy traffic pays low rates — often cents per 1,000
> views — so real income needs real, steady traffic first. Keep it clean: no fake
> loading timers, no "complete an offer to unlock" gates, no forced surveys. Clean
> placement is what keeps accounts alive.

---

## 🛡️ Admin console

`/admin` is the site's **control plane**: monitoring (overview, catalog health,
analytics, the feedback inbox, community moderation, the Security Centre) and
management — a game CMS with a Draft → Review → Published lifecycle, providers,
categories and tags, staff accounts with roles, typed settings and feature flags,
the proxy's approved destinations and limits, and a searchable, tamper-evident
audit trail. The full model is in **[admin/CONTROL-PLANE.md](admin/CONTROL-PLANE.md)**;
it needs the control-plane migration applied before its management sections work.

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
| `ADMIN_SECRET` | Independent **machine** token for monitors/CLI, sent as a Bearer header. Runs as `operator` by default — never `owner` |
| `ADMIN_SERVICE_ROLE` | Role the machine token runs as: `operator` (default), `viewer`, or a staff role below admin. `owner`, `super_admin` and `admin` are refused so a typo cannot escalate it |

### Role-based access control

Three kinds of principal reach `/api/admin`, with different power:

| Principal | Role | May not |
|---|---|---|
| The owner's password session (cookie, CSRF, idle timeout) | `owner` | — |
| A **staff account** (created in the console) | `super_admin`, `admin`, `content_manager`, `moderator`, `analyst` or `support` | anything outside its role; act on itself or on anyone at or above its rank |
| `ADMIN_SECRET` bearer token | `operator` (or `viewer`, or a staff role below admin) | revoke sessions, purge running config, **mint MASQR mirror keys**, re-authenticate for destructive actions |

Permissions are grouped by blast radius — the original seven (`telemetry.read`,
`catalog.read`, `catalog.write`, `moderation.write`, `security.read`,
`security.write`, `config.write`) plus the control plane's `games.*`, `users.*`,
`proxy.*`, `settings.manage`, `ads.manage`, `taxonomy.manage`,
`providers.manage` and `audit.export`; the role matrix is in
[admin/CONTROL-PLANE.md §2](admin/CONTROL-PLANE.md#2-who-can-do-what). A leaked monitoring token therefore cannot log every admin out,
clear the cache, or mint a key that unlocks the proxy on a gated mirror — none of
which a monitor ever needs to do. (`POST /api/admin/masqr/key` requires
`security.write`, which only `owner` holds.) `owner` holds a wildcard so a new
permission fails **closed** for every lesser role. Every denial is written to the
audit log with the role and principal that was refused. See
[`lib/admin-rbac.mjs`](../lib/admin-rbac.mjs).

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
  that refuses `UPDATE` and `DELETE`, and **hash-chained**, so a record altered by
  someone who disabled the trigger is still detected (Audit → Verify integrity).
  Every detail is redacted before it is written. Client IPs are stored only as a
  keyed HMAC, never as addresses.
- **Step-up** — permanent deletion, role changes, creating staff accounts,
  resetting passwords, approving proxy destinations, raising proxy limits,
  widening providers and maintenance mode all need the password re-entered in the
  last five minutes on that session.

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

## 💚 Reliability & resource safety

Five independent guards keep one bad session — or one traffic spike — from taking
the whole instance down.

- **Memory-gated health.** `GET /healthz` reports the *worse* of (RSS / container
  limit) and (V8 used-heap / heap limit), and returns **503 once it crosses 85%**
  (`HEALTH_MEM_MAX_PCT`). An orchestrator pulls the instance and starts a
  replacement *before* the kernel OOM-kills it mid-request — a rolling restart
  instead of dropped connections. The verdict (status code) is unauthenticated so
  a probe can act on it; the numbers and cron history need `CRON_SECRET`.
- **Catalog in memory, refreshed off the request path.** The full ~16,900-row
  catalog is held in local memory and refreshed from Supabase on a **30-minute
  background timer** (`CATALOG_REFRESH_MS`), so a traffic spike serves from RAM
  and never fans out into the database pool. A failed refresh keeps the last good
  copy.
- **Wisp tunnel hygiene.** Every upgraded socket gets TCP keepalive, a 10-minute
  idle reclaim, and a global concurrency cap (512 tunnels); the set is torn down
  on `SIGTERM` so a graceful stop does not wait for the platform's `SIGKILL`.
- **Per-client fairness cap.** One IP may hold at most `WISP_MAX_PER_IP` tunnels
  (default 32) out of the global pool, so a runaway tab or a leak on one
  visitor's end cannot starve everyone else. Refusals are reported separately
  from global-cap refusals in `/api/admin/proxy`, because "raise capacity" and
  "one client is misbehaving" are different problems.
- **Per-tunnel stream cap.** The two caps above count *tunnels*, but one Wisp
  tunnel multiplexes many *streams* — so without a third limit a single permitted
  tunnel could open connections without bound. `WISP_MAX_STREAMS` (default 256,
  set by [`lib/wisp-policy.mjs`](../lib/wisp-policy.mjs)) closes that gap; the same
  module sets the port allowlist and private-address refusal described in
  [docs/proxy/INVISIPROXY.md](proxy/INVISIPROXY.md).

The managed **sing-box** backend follows the same discipline: it runs as a
decoupled child process (never on the event loop), is validated with
`sing-box check` before every start so a bad config becomes one error line
instead of a hot restart loop, and backs off 1s → 60s on repeated failure. Full
detail in **[docs/proxy/SINGBOX.md](proxy/SINGBOX.md)**.

---

## 🗄️ Database setup (Supabase)

The live catalog and community features live in Supabase. Fastest path once your `.env` has the Supabase keys:

```bash
npm run restore-games     # loads every game source into Supabase in one command
```

Prefer the SQL editor? Paste **[`db/SCHEMA-ONLY.sql`](../db/SCHEMA-ONLY.sql)** — it is all 17 migrations concatenated in dependency order, generated from the same `ORDER` array in [`tools/sync-supabase-migrations.mjs`](../tools/sync-supabase-migrations.mjs) that produces `supabase/migrations/`, so it cannot drift from what the deploy applies. Assembling the schema by hand from individual `db/*.sql` files is the one thing not to do: the order is load-bearing and not alphabetical, and omitting a file is silent. Two things about that order matter: **the teardown and privilege files run at the end** — `db/feedback.sql` creates the private `feedback` table, `db/schema-hardening.sql` applies the audit corrections and must stay the last file that creates objects, and `db/grants.sql` runs last of all, granting privileges over whatever exists at the end (skip it and every table exists but answers `42501 permission denied`) — and **migration history is replayed forwards, never rewritten.** That second point is why `db/scores-restore.sql` exists as its own file: `db/feedback.sql` once retired the leaderboard by dropping `scores`, and commenting that drop out does nothing to a live database, because Supabase will not re-run a migration it has already recorded. Editing an applied migration changes the repository's account of the database without changing the database. Only a new forward migration can bring the table back — so the leaderboard is live, restored by migration 12, not by an edit to migration 11. Then load the `load-*.sql` game loaders. Big loaders are split into numbered `-partNN.sql` files that each stay under Supabase's editor save limit; run the parts in numeric order (every one is an idempotent upsert, so re-running is safe).

> **`db/ALL-IN-ONE.sql`** bundles everything into a single file, but at ~6.5 MB it's far too big for Supabase's web editor — it's for direct `psql` restores only: `psql "$SUPABASE_DB_URL" -f db/ALL-IN-ONE.sql`. For everyone else, `npm run restore-games` is the one-command path.

📄 Full walkthroughs: [docs/database/RUN-IN-ORDER.md](database/RUN-IN-ORDER.md) (short) · [GAMES-SETUP.md](database/GAMES-SETUP.md) (detailed) · [docs/database/ADDING-A-GAME.md](database/ADDING-A-GAME.md).

### Schema changes: `db/` is authored, `supabase/migrations/` is generated

Schema is authored in [`db/`](../db/). [`supabase/migrations/`](../supabase/migrations/) is a **generated mirror** that the Supabase GitHub integration applies to every preview branch and, on merge to `main`, to production.

```bash
npm run sync-migrations            # regenerate the mirror after editing db/
npm run sync-migrations -- --check # verify only; non-zero exit if stale
```

Two copies of the same DDL drift silently, and the failure mode is bad — Supabase would apply an **older** schema to production with no error anywhere. CI blocks that: `migrations-in-sync` fails the build if the mirror is stale, and `migrations-apply` runs every migration against a real Postgres 15, runs them **all a second time** to prove the idempotency each header claims, then asserts RLS is enabled on every table in `public`.

> **Working directory for the Supabase GitHub integration is `.`** — the field wants the path to the folder *containing* `supabase/`, not to `supabase/` itself. Entering `supabase` makes it look for `supabase/supabase/migrations/`, find nothing, and apply nothing, with no error shown anywhere.

### What lives in the database

| Table | Purpose |
|---|---|
| `games` | the catalog, ~16,900 rows. RLS: public may read `is_working = true`. ~12,300 of these reach visitors — see [Catalog](#-the-catalog-what-is-actually-served) |
| `scores` | the leaderboard. Implausible scores are quarantined (hidden from the board) and purged after 7 days — see [LEADERBOARD.md](features/LEADERBOARD.md). ⏳ *pending on the live project* |
| `game_stats` | per-game play counters. Counting restarted from zero when the database moved to a new project; it grows with play |
| `feedback` | "Send feedback" messages. RLS is **insert-only**: anon/authenticated may `INSERT` and nothing else, so a message can never be read back by the public |
| `subscriber_emails` | the mirror-update list — two columns, no IP, no timestamp; anon may `INSERT` only. ⏳ *pending on the live project* |
| `ai_feedback` | AI answer ratings, redacted before insert, consent per row, 180-day expiry; anon may `INSERT` only. ⏳ *pending on the live project* |
| `recommendations` | the community wall |
| `keepalive` | one row the `/healthz` probe pokes so a free-tier DB never pauses |
| `game_fingerprints` · `game_duplicates` · `rejected_submissions` | the discovery engine — operational metadata, **no public access at all**. The repository auditor notes nothing reads them yet |
| `admin_sessions` · `admin_audit_logs` · `admin_login_attempts` · `admin_security_events` | the admin console. Audit log is append-only (database trigger); **no public access at all** |

> **⏳ Pending** means the migration is in this repository but has not yet been
> applied to the live Supabase project — `npm run audit:repo` reports exactly
> these as its errors. The fix is in
> [docs/database/RUN-IN-ORDER.md §1b](database/RUN-IN-ORDER.md#1b-if-the-audit-reports-missing-tables).
> Until then, the features that write to them fail at the database, not in the page.

**RLS is deny-by-default everywhere and verified against production**: the publishable key gets `42501` on `INSERT` into `games`, sees 0 rows of every operational table, and reads exactly the `is_working = true` rows the policy permits (16,820 when measured).

---

## ☁️ Deployment

ZoFHub is a **persistent server** (it runs cron jobs, holds the catalog in memory, and serves the `/wisp` WebSocket) — so it needs a real host, **not** serverless. [`render.yaml`](../render.yaml) defines the single web service, ready to deploy. There is one deployment shape: the games hub and the proxy always run together.

- **Render auto-deploys** on every push to `main` (works with private repositories via Render's GitHub authorization).
- **Free tier:** the included `/healthz` endpoint + an external uptime monitor (e.g. cron-job.org) pinging it every ~10 min keeps the service (and Supabase) from sleeping.

Full launch checklist — domains, ad networks, QA — in **[GO-LIVE.md](guides/GO-LIVE.md)**.

### 🐳 Docker (optional)

```bash
docker build -t zofhub .
docker run -p 8080:8080 --env-file .env zofhub
```

The image is multi-stage. sing-box is **not** built by default
(`SINGBOX_VERSION=none`), so the standard image is unchanged. To bake in a pinned
release for managed mode:

```bash
docker build --build-arg SINGBOX_VERSION=v1.10.7 -t zofhub .
```

`go install` fetches that exact tag and verifies it against Go's checksum
database — no sing-box source is vendored into this repository (its GPL-3.0 terms
are incompatible with this repo's proprietary LICENSE, which is why the build
keeps them separate programs). See [docs/proxy/SINGBOX.md](proxy/SINGBOX.md).

---

## 📂 Project structure

```text
ZoFHub/
├── server.js              # the app: pages, API, game + AI routes (entry point)
├── render.yaml            # Render blueprint — one web service, hub + proxy together
├── Dockerfile             # container image (Node 22-alpine, port 8080; optional sing-box stage)
├── LICENSE                # ZoFHub's own terms — the only non-code file left at the root
├── .github/workflows/     # ci.yml (5 jobs) + gameflare-verify.yml (manual only)
│
├── docs/                  # ALL project documentation — you are here (docs/README.md)
│   ├── guides/            #   how it works, commands, debugging, go-live, new machine
│   ├── database/          #   catalog setup, migration order, one game, the Supabase mirror
│   ├── features/          #   AI, ads, embeds, Y8, GameFlare, leaderboard, donations, visitors, Suroi
│   ├── proxy/             #   egress policy, MASQR, sing-box, Kasm, AnuraOS
│   ├── reports/           #   generated reports (do not edit by hand)
│   └── CREDITS.md         #   third-party licences + the AGPL §13 source offer
│
├── lib/                   # server modules — supabase, cron-jobs, cache, ad-providers,
│                          #   ai-*, recommender, vibe-*, scores, donate/swap,
│                          #   wisp-policy (proxy egress), masqr (mirror gate),
│                          #   singbox-* (optional tunnel), kasm-host, anura-host, gameflare-*
├── proxy-engine/          # every AGPL proxy engine behind one mount function
│   ├── mount.mjs          #   routing, static mounts, tunnel wiring
│   └── assets/            #   gust/ (libcurl.js + Wisp) · uv/ (Ultraviolet) · scram/ (Scramjet)
├── public/                # what the visitor downloads
│   ├── *.html             #   pages (home, game, category, ai, community, leaderboard,
│   │                      #   donate, browser, gameflare…)
│   ├── css/  js/          #   styles + vanilla frontend modules
│   │   └── js/pollinations.js  # CLIENT-SIDE AI — the browser talks to Pollinations directly
│   └── assets/  thumbs/   #   images + self-hosted game thumbnails
├── admin-ui/              # the admin console — deliberately OUTSIDE public/ (see Admin console)
├── legal/                 # privacy / terms / DMCA / cookies / credits pages, as served
├── licenses/              # full AGPL-3.0 and LGPL-3.0 texts served by /licenses
│
├── db/                    # Supabase SQL — AUTHORED HERE (schema, migrations, loaders)
│   ├── SCHEMA-ONLY.sql    #   GENERATED — every migration in order (npm run build-schema-only)
│   └── ALL-IN-ONE.sql     #   GENERATED — schema + catalog, psql only (npm run build-all-in-one)
├── supabase/              # config + migrations/ (GENERATED mirror of db/) + seed.sql
├── data/                  # catalog-overrides.json, ranking/similarity data, donate.json,
│                          #   GameFlare datasets, *-upstream.json provenance records
├── api/                   # bundled catalog JSON (fallback when Supabase is down)
│
├── tools/                 # maintenance scripts, generators, verifiers, auditors
│   ├── _is-main.mjs       #   the import guard — tools that write must not run on import
│   ├── audit.py           #   entry point for the repository auditor
│   └── zofaudit/          #   the checks it runs (stdlib-only Python)
├── scripts/               # one-off data scripts
├── test/                  # node:test suites (1009 tests, no framework)
├── deploy/singbox/        # sing-box config templates + compose file
├── suroi/                 # self-hosting kit for Suroi (GPL-3.0) — see docs/features/SUROI.md
├── vendor/anura/          # AnuraOS bundle (AGPL-3.0, pinned, one declared modification)
│
└── DayDream/ Interstellar/ NautilusOS/ scramjet/
                           # companion / reference upstream trees — their own licences,
                           #   their own docs, not deployed (see docs/CREDITS.md)
```

Git-ignored and machine-local: `.env`, `logs/`, `verification-evidence/` (GameFlare screenshots).

---

## 🧪 Tests & CI

```bash
npm test        # 1009 tests across 225 suites, node:test — no framework, no install step
npm run check   # syntax-check every front-end module (public/js + admin-ui)
```

Tests run **without any secrets**: with no `.env` the server falls back to its bundled catalog, because a test that needs production keys is a test nobody runs. When a `.env` *is* present the suite gets stricter — the "no response body contains a real secret" test then compares every response against the 7 real configured values and **asserts it had something to compare against**, so it can never pass vacuously.

Five CI jobs run on every push and PR (`.github/workflows/ci.yml`):

| Job | What it proves |
|---|---|
| `startup-check` | the server boots and `/api/health` answers |
| `tests` | the full suite passes |
| `migrations-in-sync` | `supabase/migrations/` still mirrors `db/` |
| `migrations-apply` | every migration applies to a real Postgres 15, is idempotent on re-apply, and leaves RLS on for every `public` table |
| `repo-audit` | the [repository auditor](#-repository-auditor) finds nothing at **warn** or above — deliberately stricter than "no errors", because by the time a finding is an error it is a broken query or a missing route |

A sixth workflow, `gameflare-verify.yml`, is **manual-only** (`workflow_dispatch`).
It runs real Chromium against GameFlare candidates — work that cannot happen in
the web service, because production installs with `--omit=dev` and Playwright is
a dev dependency. It uploads results for a human to inspect and **writes nothing
to the live catalog**.

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
| `sql` | replays all 17 migrations, then holds every `.from()` / `.rpc()` / `.select()` in the runtime against the result — missing tables, missing columns, RPCs with no function, `DROP FUNCTION` that matches nothing, `SECURITY DEFINER` without a `revoke`, functions that do not pin `search_path`, tables without RLS, redundant indexes |
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

**All project documentation lives in this folder, `docs/`** — one place, organised
by purpose. This README is the reference manual; the map below is the index.

### Find it by question

| You want to… | Read |
|---|---|
| understand the whole thing in plain English | [guides/HOW-IT-WORKS.md](guides/HOW-IT-WORKS.md) |
| run a command | [guides/COMMANDS.md](guides/COMMANDS.md) |
| fix something that broke | [guides/DEBUGGING.md](guides/DEBUGGING.md) |
| deploy it | [guides/GO-LIVE.md](guides/GO-LIVE.md) |
| move to a new machine | [guides/NEW-LAPTOP-SETUP.md](guides/NEW-LAPTOP-SETUP.md) |
| set up the database | [database/GAMES-SETUP.md](database/GAMES-SETUP.md) → [database/RUN-IN-ORDER.md](database/RUN-IN-ORDER.md) |
| add or hide one game | [database/ADDING-A-GAME.md](database/ADDING-A-GAME.md) |
| change the schema | [database/SUPABASE-MIGRATIONS.md](database/SUPABASE-MIGRATIONS.md) |
| know what the site stores about a visitor | [features/VISITOR-FEATURES.md §8](features/VISITOR-FEATURES.md#8-what-the-site-remembers-about-you) |
| know what is third-party, and under which licence | [CREDITS.md](CREDITS.md) |
| run the admin console: roles, the game lifecycle, staff, settings, audit | [admin/CONTROL-PLANE.md](admin/CONTROL-PLANE.md) |
| control where the proxy may connect | [proxy/GOVERNANCE.md](proxy/GOVERNANCE.md) |
| import GameDistribution's catalog | [features/GAMEDISTRIBUTION.md](features/GAMEDISTRIBUTION.md) |

### The folder

```text
docs/
├── README.md        this file — the reference manual and the map
├── CREDITS.md       third-party licences, the §5 declarations, the AGPL §13 source offer
├── admin/           the admin control plane: roles, lifecycle, staff, settings, audit
├── guides/          how to understand, run, fix, deploy and move it
├── database/        loading the catalog, the migration order, the Supabase mirror
├── features/        one document per feature of the site
├── proxy/           one document per part of the proxy stack
└── reports/         generated output — never edited by hand
```

#### admin/

| Document | What it covers |
|---|---|
| [CONTROL-PLANE.md](admin/CONTROL-PLANE.md) | Roles and permissions, the game lifecycle, providers, staff accounts, settings, the audit trail, RLS per table, backup and recovery |

#### guides/

| Document | What it covers |
|---|---|
| [HOW-IT-WORKS.md](guides/HOW-IT-WORKS.md) | The plain-English tour — every section points at the detailed document |
| [COMMANDS.md](guides/COMMANDS.md) | Every npm script and raw command, and the environment variables worth knowing |
| [DEBUGGING.md](guides/DEBUGGING.md) | The failure checklist, what each log prefix means, and the panic button |
| [GO-LIVE.md](guides/GO-LIVE.md) | Host, database, environment, ad networks and pre-launch QA |
| [NEW-LAPTOP-SETUP.md](guides/NEW-LAPTOP-SETUP.md) | Clone, install, **restore `.env`**, run |

#### database/

| Document | What it covers |
|---|---|
| [GAMES-SETUP.md](database/GAMES-SETUP.md) | Loading the catalog, long form — and why there are three different game counts |
| [RUN-IN-ORDER.md](database/RUN-IN-ORDER.md) | The SQL run order, all 17 migrations, and what "pending" means |
| [COMPLETE-SETUP-GUIDE.md](database/COMPLETE-SETUP-GUIDE.md) | The short version |
| [ADDING-A-GAME.md](database/ADDING-A-GAME.md) | One game at a time, by SQL or by `catalog-overrides.json` |
| [SUPABASE-MIGRATIONS.md](database/SUPABASE-MIGRATIONS.md) | The generated `supabase/` mirror and the GitHub integration contract |

#### features/

| Document | Feature | Default |
|---|---|---|
| [AI-ARCHITECTURE.md](features/AI-ARCHITECTURE.md) | AI providers, the feedback pipeline, evaluation, the AI/proxy boundary | Pollinations on (browser-direct); Hugging Face off |
| [ADVERTISING.md](features/ADVERTISING.md) | The six networks and their roles, placement, regional tags, the ad-block gate, the proxy boundary, compliance | **all off** |
| [IFRAME-OPTIMIZATION-GUIDE.md](features/IFRAME-OPTIMIZATION-GUIDE.md) | How game embeds load, and the bug each timeout prevents | on |
| [Y8-SCRAPER.md](features/Y8-SCRAPER.md) | The standalone Y8 embed-directory scraper | manual |
| [GAMEFLARE.md](features/GAMEFLARE.md) | The separate GameFlare catalog, its player and its browser verifier | **0 games public, by design** |
| [GAMEDISTRIBUTION.md](features/GAMEDISTRIBUTION.md) | The weekly import of GameDistribution's catalog, with the licensing screen and review queue | on **once the control-plane migration is applied** |
| [LEADERBOARD.md](features/LEADERBOARD.md) | Proof-of-play tokens, plausibility checks, quarantine, retention | ⏳ table pending |
| [DONATIONS.md](features/DONATIONS.md) | Checksum-verified addresses, and the swap path | **off** until addresses are set |
| [VISITOR-FEATURES.md](features/VISITOR-FEATURES.md) | Identity, recommendations, live presence, mirror list, feedback, panic key — and what is stored | on |
| [SUROI.md](features/SUROI.md) | Self-hosting Suroi (GPL-3.0) instead of framing it | **untested kit** |

#### proxy/

| Document | Part of the stack | Default |
|---|---|---|
| [GOVERNANCE.md](proxy/GOVERNANCE.md) | Approved destinations, access modes, limits, engine switches, live sessions — where the proxy may connect | **fails closed**: nothing reachable until approved |
| [INVISIPROXY.md](proxy/INVISIPROXY.md) | The egress policy (`lib/wisp-policy.mjs`), the engine validator, and why InvisiProxy is not vendored | policy **always on**, restrictive |
| [MASQR.md](proxy/MASQR.md) | Mirror-survival gate — hides the proxy from crawlers | **off** |
| [SINGBOX.md](proxy/SINGBOX.md) | Optional outbound tunnel (REALITY/VLESS): adapter and managed supervisor | **off** |
| [KASM.md](proxy/KASM.md) | Kasm Workspaces and the external companion-desktop model | **off** |
| [ANURA.md](proxy/ANURA.md) | AnuraOS — a whole web OS, served on its own origin, one declared modification | on **if the bundle is present** |

#### reports/ and licensing

| Document | What it is |
|---|---|
| [reports/thumbnail-scrape-report.md](reports/thumbnail-scrape-report.md) | Generated by `npm run scrape-thumbs` — one run, not current state |
| [CREDITS.md](CREDITS.md) | Attribution, the §5 modification declarations, and the AGPL §13 source offer |
| [`LICENSE`](../LICENSE) | ZoFHub's own terms (source-available, non-commercial) — kept at the repository root |

### The pattern the integrations share

The proxy documents follow one architectural decision, worth stating once:

> **Third-party projects are integrated, not absorbed.** Where a project's
> functionality already exists here, or its licence is incompatible with this
> repository's own, it runs as an **external companion** or is **reimplemented as
> ZoFHub code with full provenance** — rather than vendored in.

Each such decision has a machine-readable record, so an upgrade review can diff
it: the upstream project, repository, licence, copyright holder, review date,
what was taken, what was rejected, and why.

| Provenance record | Upstream | Licence |
|---|---|---|
| [`data/invisiproxy-upstream.json`](../data/invisiproxy-upstream.json) | QuiteAFancyEmerald/InvisiProxy | AGPL-3.0 |
| [`data/masqr-upstream.json`](../data/masqr-upstream.json) | titaniumnetwork-dev/MasqrProject | AntiSkip (MIT text + a condition) — **not MIT** |

### Documents this project does not own

These directories are **upstream or companion trees** with their own READMEs.
Those files are left exactly as their authors wrote them, because they are
provenance — editing them would misrepresent what the upstream project says about
itself:

```
DayDream/    Interstellar/    NautilusOS/    scramjet/    vendor/anura/
```

If one of them says something wrong *about ZoFHub*, the correction belongs in
this folder, not in their files.

> **Corrected 2026-09-26:** an earlier index also listed `suroi/` here. Its README
> was ZoFHub's own self-hosting guide, not upstream text; it now lives at
> [features/SUROI.md](features/SUROI.md).

### How these documents are written

1. **Say what was verified and what was not.** Subsystem documents end with a
   verification section that separates measured results from claims.
   "Not verified" is a legitimate and useful entry.
2. **Record what was rejected, and why.** A decision *not* to use something is
   more useful six months later than a description of what was used.
3. **Never restate a list the code owns.** Point at the source array instead —
   two copies drift, and the drift is silent.
4. **Do not claim a security property that is not enforced.** MASQR is the worked
   example: it is described as discovery resistance, explicitly *not* as access
   control, everywhere it appears.
5. **Correct old documents loudly.** Where a claim changed, the document says so
   and what the old claim was, rather than quietly reading as if it had always
   been right.
6. **Generated files say so in their first lines**, and the generator writes that
   banner itself — anything added by hand to a generated file is lost on the next
   run.

---

## 💬 Community

Join the **[ZoFHub Official Discord](https://discord.gg/SeMuMRG9gG)** — announcements, game requests, and support. It's also the contact channel for licensing questions (see [`LICENSE`](../LICENSE)) and third-party source requests (see [CREDITS.md](CREDITS.md)).

---

## 📜 License & credits

ZoFHub's own code is under the terms in [`LICENSE`](../LICENSE) — a **source-available, personal & non-commercial** license (not open source). The bundled proxy engines (Ultraviolet, Scramjet, GUST, Wisp, Epoxy, libcurl transport) are **AGPL-3.0**, and **libcurl.js is LGPL-3.0-or-later** — they keep their **own** upstream licenses, which always take precedence for those components. Because they are served over a network, the **AGPL-3.0 §13 source offer** applies; see **[CREDITS.md](CREDITS.md)** for the full attribution and that offer. Standalone copyleft companion browsers are **not** included in this repository.

Games are served through their publishers' **official embed URLs**; ZoFHub hosts no pirated game assets.

## 👨‍💻 Author

**ZSM1010** — maintained pseudonymously. Reach the project via the [ZoFHub Discord](https://discord.gg/SeMuMRG9gG).
