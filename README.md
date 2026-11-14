<!--
  Root landing README — intentionally short. The COMPLETE documentation lives in
  docs/ (start at docs/README.md). Keep this file a summary that links inward, so
  there is only one place to maintain the deep detail.
-->

# 🎮 ZoFHub — Gaming · AI Hub

![Node](https://img.shields.io/badge/Node-%E2%89%A522-3c873a?logo=node.js&logoColor=white)
![Express](https://img.shields.io/badge/Server-Express-000000?logo=express&logoColor=white)
![Supabase](https://img.shields.io/badge/Database-Supabase-3ecf8e?logo=supabase&logoColor=white)
![No build step](https://img.shields.io/badge/build-none-blue)
![Tests](https://img.shields.io/badge/tests-1813%20passing-brightgreen)
![Deploy](https://img.shields.io/badge/Deploy-Render-46E3B7?logo=render&logoColor=white)
[![Discord](https://img.shields.io/badge/Discord-ZoFHub%20Official-5865F2?logo=discord&logoColor=white)](https://discord.gg/SeMuMRG9gG)

A single-server web app that bundles two things into one site:

1. **A games hub** — a catalog of **~16,900 games** (**~12,300 eligible** to serve, all from official/authorized embeds) of which the public roster is a fixed, curated set (`ACTIVE_GAMES_CAP`, default 100), with search, categories, favorites, a Game of the Day, a natural-language **Vibe Finder**, and a personalized **For You** row.
2. **A free AI assistant** — a **text** chat that runs **entirely in the visitor's browser**: one keyless `GET` to `text.pollinations.ai`, made by their own browser on their own IP. No prompt or reply ever touches this server, and that is **enforced by the server** — there are no AI routes left to relay one. Pictures exist only as the opt-in `/image` command: one `<img>` loaded by their browser from `image.pollinations.ai`, never relayed here. No audio or video generation.

Built with **Node.js + Express**, vanilla **HTML/CSS/JS** (no framework, **no build step**), and **Supabase** (Postgres). It runs as **one always-on site**, with optional advertising on pages ZoFHub wrote and never Google AdSense. Everything it fetches server-side on a visitor's behalf crosses a managed **sing-box** daemon — or is refused; there is no direct fallback.

---

## ✨ Highlights

- 🎮 **~12,300 eligible games** from GameMonetize, Y8, OnlineGames.io and GameDistribution — every one via a distributor that licenses third-party embedding. The public roster is a fixed, curated set (`ACTIVE_GAMES_CAP`, default 100; `0` serves them all).
- 🤖 **Browser-direct AI** — one keyless `GET https://text.pollinations.ai/<prompt>` from the visitor's own browser, read with `response.text()`. **Text, plus opt-in `/image` pictures** (one `<img>` for `https://image.pollinations.ai/<description>`); no audio or video generation. An 18-second wait follows every message and a 50-second wait every picture. No API key, no model picker, no server hop and no local inference engine — so there is exactly one way a prompt can travel, and it does not come through here.
- 🔎 **Per-game SEO** — every game page has a **unique, factual description** and full metadata (canonical, Open Graph, `schema.org` JSON-LD), generated from verified catalog metadata — no AI filler, no fabrication.
- 🧩 **Six ad networks, one role each** — Ad-Maven interstitial, ExoClick banners, HilltopAds push, Clickadu pre-roll, Mondiad native, PopAds popunder — region-aware, allowed only on pages ZoFHub wrote (deny-by-default), never AdSense.
- 🛠️ **A frozen, maintained catalog** — nothing adds games automatically (the grow, Y8 and GameDistribution jobs were retired; additions are a deliberate, re-authenticated admin act), while eight scheduled jobs keep it healthy: hourly link-checks, retention sweeps and a database heartbeat.
- 🛡️ **RBAC admin console** — a game CMS, moderation, typed settings, and a tamper-evident, hash-chained audit log, all behind real server-side roles.
- 💚 **Reliable by design** — memory-gated `/healthz` (503 above 85%), crash isolation, graceful shutdown.

The full feature tour, architecture, security model, database setup and operations are in **[docs/README.md](docs/README.md)**.

---

## 🚀 Quick start

**Prerequisites:** Node.js **22+** and Git. No compiler, no build step. Supabase is optional for local dev (without it, the app serves a bundled fallback catalog).

```bash
git clone <your-repo-url>
cd ZoFHub
npm ci                    # exactly what package-lock.json pins — same as CI and Render
npm run singbox:install   # the pinned sing-box daemon that carries server-side fetches (the Render build runs this too)
cp .env.example .env      # then fill in your values (see docs)
npm start                 # → http://localhost:8080
```

> **No daemon, no outbound fetches.** Anything that makes the server fetch a third-party URL — `/embed/` wrappers, thumbnails, link checks — crosses sing-box or is refused; there is no direct fallback. Skip `singbox:install` if you are not working on those, or, on a development machine only, set `SINGBOX_ALLOW_DIRECT=1` in `.env` (it is ignored in production). Details: [docs/proxy/SINGBOX.md](docs/proxy/SINGBOX.md).

```bash
npm test          # the node:test suite (no framework, no install step)
npm run check     # syntax-check every front-end module
npm run audit:ci  # the repository auditor — fails on anything at warn or above
```

> **Windows:** `npm start` runs `node --use-system-ca server.js` so Node trusts the Windows certificate store (some corporate/school TLS setups need it). Not needed on macOS/Linux/Docker.

---

## 📚 Documentation

Everything lives in **[`docs/`](docs/README.md)**:

| Area | Start here |
|---|---|
| **Overview & architecture** | [docs/README.md](docs/README.md) |
| **How it works** | [docs/guides/HOW-IT-WORKS.md](docs/guides/HOW-IT-WORKS.md) |
| **Commands & env vars** | [docs/guides/COMMANDS.md](docs/guides/COMMANDS.md) |
| **Go-live checklist** | [docs/guides/GO-LIVE.md](docs/guides/GO-LIVE.md) |
| **AI architecture** | [docs/features/AI-ARCHITECTURE.md](docs/features/AI-ARCHITECTURE.md) |
| **Per-game SEO** | [docs/features/GAME-SEO.md](docs/features/GAME-SEO.md) |
| **Advertising** | [docs/features/ADVERTISING.md](docs/features/ADVERTISING.md) |
| **Admin / RBAC control plane** | [docs/admin/CONTROL-PLANE.md](docs/admin/CONTROL-PLANE.md) |
| **Database & migrations** | [docs/database/RUN-IN-ORDER.md](docs/database/RUN-IN-ORDER.md) |
| **Egress & sing-box** | [docs/proxy/SINGBOX.md](docs/proxy/SINGBOX.md) |
| **Third-party licences** | [docs/CREDITS.md](docs/CREDITS.md) |

---

## 📜 License

ZoFHub's own code is under the terms in [`LICENSE`](LICENSE) — source-available, personal & non-commercial (not open source). The sing-box egress backend (GPL-3.0, run as a separate unmodified program) and every dependency keep their own upstream licences, which always take precedence for those components — see [docs/CREDITS.md](docs/CREDITS.md). Games are served through their publishers' official embed URLs; ZoFHub hosts no pirated game assets.

**Author:** ZSM1010 — maintained pseudonymously. Reach the project via the [ZoFHub Discord](https://discord.gg/SeMuMRG9gG).
