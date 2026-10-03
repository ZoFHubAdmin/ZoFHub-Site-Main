<!--
  Root landing README — intentionally short. The COMPLETE documentation lives in
  docs/ (start at docs/README.md). Keep this file a summary that links inward, so
  there is only one place to maintain the deep detail.
-->

# 🎮 ZoFHub — Gaming · AI · Browser Hub

![Node](https://img.shields.io/badge/Node-%E2%89%A522-3c873a?logo=node.js&logoColor=white)
![Express](https://img.shields.io/badge/Server-Express-000000?logo=express&logoColor=white)
![Supabase](https://img.shields.io/badge/Database-Supabase-3ecf8e?logo=supabase&logoColor=white)
![No build step](https://img.shields.io/badge/build-none-blue)
![Tests](https://img.shields.io/badge/tests-1379%20passing-brightgreen)
![Deploy](https://img.shields.io/badge/Deploy-Render-46E3B7?logo=render&logoColor=white)
[![Discord](https://img.shields.io/badge/Discord-ZoFHub%20Official-5865F2?logo=discord&logoColor=white)](https://discord.gg/SeMuMRG9gG)

A single-server web app that bundles three things into one site:

1. **A games hub** — **~12,300 playable games** served from official/authorized embeds (~16,900 catalogued), with search, categories, favorites, a Game of the Day, a natural-language **Vibe Finder**, and a personalized **For You** row.
2. **A free AI assistant** — chat + image generation that runs **entirely in the visitor's browser**, with a **user-chosen provider** (Pollinations by default, or opt-in Puter.js / Hugging Face — nothing forced). No prompt, reply or image ever touches this server, and that is **enforced by the server**.
3. **A proxy web browser** — an optional "open the web" mode (GUST + Ultraviolet/Scramjet/Wisp) for filtered networks, whose egress runs through a managed **sing-box** daemon by default.

Built with **Node.js + Express**, vanilla **HTML/CSS/JS** (no framework, **no build step**), and **Supabase** (Postgres). It runs as **one always-on site**, with optional advertising on the hub pages only — never on the proxy, and never Google AdSense.

---

## ✨ Highlights

- 🎮 **~12,300 served games** from GameMonetize, Y8, OnlineGames.io and GameDistribution — every one via a distributor that licenses third-party embedding.
- 🤖 **Browser-direct AI** — streamed chat + image generation with a **provider picker** (Pollinations · Puter.js · Hugging Face). The default stays free, paid models are labelled and never forced, and nothing is proxied through this server.
- 🔎 **Per-game SEO** — every game page has a **unique, factual description** and full metadata (canonical, Open Graph, `schema.org` JSON-LD), generated from verified catalog metadata — no AI filler, no fabrication.
- 🧩 **Six ad networks, one role each** — Ad-Maven interstitial, ExoClick banners, HilltopAds push, Clickadu pre-roll, Mondiad native, PopAds popunder — region-aware, structurally excluded from every proxy surface, never AdSense.
- 🛠️ **Self-maintaining catalog** — a background **grow** job adds up to 30 **render-verified** games every ~36 hours (no black screens), plus hourly link-checks, weekly Y8 and GameDistribution imports.
- 🛡️ **RBAC admin console** — a game CMS, moderation, typed settings, and a tamper-evident, hash-chained audit log, all behind real server-side roles.
- 💚 **Reliable by design** — memory-gated `/healthz` (503 above 85%), Wisp tunnel caps (global + per-IP + per-stream), crash isolation, graceful shutdown.

The full feature tour, architecture, security model, database setup and operations are in **[docs/README.md](docs/README.md)**.

---

## 🚀 Quick start

**Prerequisites:** Node.js **22+** and Git. No compiler, no build step. Supabase is optional for local dev (without it, the app serves a bundled fallback catalog).

```bash
git clone <your-repo-url>
cd ZoFHub
npm ci                    # exactly what package-lock.json pins — same as CI and Render
cp .env.example .env      # then fill in your values (see docs)
npm start                 # → http://localhost:8080
```

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
| **Proxy, egress & sing-box** | [docs/proxy/SINGBOX.md](docs/proxy/SINGBOX.md) · [docs/proxy/INVISIPROXY.md](docs/proxy/INVISIPROXY.md) |
| **Third-party licences** | [docs/CREDITS.md](docs/CREDITS.md) |

---

## 📜 License

ZoFHub's own code is under the terms in [`LICENSE`](LICENSE) — source-available, personal & non-commercial (not open source). Bundled proxy engines (Ultraviolet, Scramjet, GUST, Wisp, Epoxy, libcurl transport) and the sing-box egress backend keep their own upstream licences (AGPL-3.0 / LGPL-3.0 / GPL-3.0), which always take precedence for those components; because they are served over a network, the AGPL-3.0 §13 source offer applies — see [docs/CREDITS.md](docs/CREDITS.md). Games are served through their publishers' official embed URLs; ZoFHub hosts no pirated game assets.

**Author:** ZSM1010 — maintained pseudonymously. Reach the project via the [ZoFHub Discord](https://discord.gg/SeMuMRG9gG).
