# How ZoFHub works — the plain-English tour

This explains the whole site, part by part, with no prior knowledge assumed.
It is the **map**; every section points at the detailed document for that piece.

The one-sentence version:

> **One program (`server.js`) hands web pages to visitors, a database (Supabase)
> remembers the games, and a bundled web proxy lets a visitor browse the rest of
> the internet through the same server.**

Everything below is detail on those three things.

> **Where to go next:** all documentation lives in `docs/`.
> [The README](../README.md) is the reference manual and its
> [documentation map](../README.md#-documentation) lists every file;
> [COMMANDS.md](COMMANDS.md) is every command, and [DEBUGGING.md](DEBUGGING.md)
> is what to do when it breaks.

---

## 1. The big picture (how a single visit flows)

1. Someone opens the site → their browser asks the **server** for a page.
2. The server (`server.js`) sends back HTML/CSS/JS from `public/`.
3. That page's JavaScript asks the server for data — `/api/games`, `/api/vibe`,
   `/api/scores` — over **API endpoints**.
4. The server answers from its **in-memory catalog**, which it loaded from
   **Supabase** at boot and refreshes every 30 minutes.
5. The browser draws the game tiles. Clicking one opens `/play/<slug>`, which
   runs the game in an **iframe** pointed at the publisher's official embed URL.

Two things happen *outside* that flow, and they are the parts people find
surprising:

- **The AI never touches this server.** The visitor's own browser calls
  Pollinations directly, on their own IP. See §7.
- **The proxy is a separate machine inside the same program.** It has its own
  service workers, its own network tunnel and its own egress policy. See §8.

---

## 2. `server.js` — the brain

One long-running **Express** program. It:

- serves every page and file under `public/`;
- answers the API (`/api/games`, `/api/scores`, `/api/ai/*`, `/api/vibe`, …);
- builds each `/play/<slug>` and `/category/<slug>` page on the fly;
- mounts the proxy engines and the Wisp tunnel;
- runs ten scheduled background jobs (§11);
- **must stay running 24/7**, which is why it deploys to Render and *not* to a
  serverless host like Vercel.

There is **no build step**. Node ≥22 runs the source directly — what is in the
repo is what executes. `npm run check` parses every `.js`/`.mjs` file without
importing it, and is the closest thing to a compile gate.

---

## 3. Supabase — the memory

A hosted Postgres database, reached over PostgREST. Every table is
**deny-by-default** under row-level security; the site gets exactly the
privileges `db/grants.sql` hands it and nothing more.

| Table | What it holds |
|---|---|
| **`games`** | every game: `slug`, `title`, `game_url` (the iframe src), `thumbnail_url`, `category`, `is_working` |
| **`games_public`** (view) | the public read surface — exactly `is_working = true` |
| **`scores`** | leaderboard submissions. Implausible ones are *quarantined* — hidden from the public board — and purged after 7 days. See [LEADERBOARD.md](../features/LEADERBOARD.md) |
| **`recommendations`** | community "you should add this" submissions |
| **`game_stats`** | per-game play counters, so they survive restarts |
| **`game_fingerprints`**, **`game_duplicates`** | provider fingerprints the discovery engine uses to spot the same game under two slugs |
| **`rejected_submissions`** | what the grow job tested and refused, so it does not retest forever |
| **`feedback`** | contact-form messages. Write-only to the public; only the server reads them |
| **`subscriber_emails`** | the mirror-update list. Two columns — no IP, no timestamp |
| **`ai_feedback`** | thumbs up/down on AI answers, redacted before insert, consent recorded per row |
| **`admin_sessions`**, **`admin_audit_logs`**, **`admin_login_attempts`**, **`admin_security_events`** | the admin console's session store and append-only audit trail |
| **`keepalive`** | a one-row heartbeat so a free-tier database never hits its inactivity pause |

> **The leaderboard is live.** An earlier migration (`db/feedback.sql`) retired
> the `scores` table, and an earlier version of this document said so. That drop
> is now commented out and `db/scores-restore.sql` brings the table back. Supabase
> tracks migrations by filename, so un-commenting a drop in an already-applied
> file changes nothing on a live database — **only a new forward migration can
> restore it.** That is why a separate restore file exists.

**Setting it up is one paste:** `db/SCHEMA-ONLY.sql` into Supabase's SQL Editor.
That file is generated from the canonical migration order, so it cannot drift
from what the deploy applies. Then `npm run restore-games` loads the catalog and
`npm run db:verify` proves the schema landed — including that the tables are
*readable*, which is not the same thing as existing.

Full detail: [docs/database/RUN-IN-ORDER.md](../database/RUN-IN-ORDER.md) ·
[docs/database/COMPLETE-SETUP-GUIDE.md](../database/COMPLETE-SETUP-GUIDE.md) ·
[docs/database/SUPABASE-MIGRATIONS.md](../database/SUPABASE-MIGRATIONS.md)

---

## 4. The catalog — what actually gets shown

- At boot the server loads all working games into memory (`CATALOG`) and
  refreshes from Supabase **every 30 minutes**.
- The homepage calls `/api/games?limit=…&offset=…`; the server slices that
  in-memory list. **To change what the homepage shows, you change the data — not
  the page.**
- `spreadCatalog()` mixes the big Y8 batch evenly through the list so one import
  does not clump at the top.
- `data/catalog-overrides.json` hides, patches or adds games **without touching
  the database** — useful for a fast fix you can review in a diff.

The counts differ at each layer on purpose: everything ever ingested, what the
public key can see, and what is actually served are three different numbers.
`npm run audit-served` reproduces all three offline. The README's catalog section
explains why thousands of catalogued games are deliberately never served.

---

## 5. The pages — what the visitor sees (`public/`)

| File | Page |
|---|---|
| `index.html` | homepage grid (built by `js/catalog.js`) |
| `game.html` | the template behind every `/play/<slug>` — the player + game iframe |
| `category.html` | one category's grid |
| `ai.html` | the AI assistant (`js/ai.js`) |
| `community.html` | community submissions |
| `leaderboard.html` | scores |
| `donate.html` | donation addresses |
| `browser.html`, `gust/` | the proxy browser |
| `404.html` | not found |

`css/` holds styles, `js/` holds behaviour, and **`js/layout.js` runs on every
page** — it builds the header, footer, mobile menu and ad slots.

Browsers cache aggressively, so every CSS/JS link ends in `?v=YYYYMMDD`. When a
change refuses to show up even after a hard refresh, that number is usually the
reason.

---

## 6. Playing a game

Clicking a tile goes to `/play/<slug>`. The game runs in an **iframe** pointed at
the publisher's official embed URL (y8.com, GameMonetize, …).

`js/game-page.js` drives it through `js/iframe-loader-optimized.js`, and the
behaviour that matters is: **the page waits until it knows the game is loading
before revealing it, and hides the loading screen the instant the frame loads.**
No black screen, no refreshing, no tapping twice. While it boots you see a
blurred, branded still of the game.

If a publisher's site refuses to be framed, the page retries through the
server's game proxy (`/embed/<slug>`) so it still loads.

Full detail: [IFRAME-OPTIMIZATION-GUIDE.md](../features/IFRAME-OPTIMIZATION-GUIDE.md)

---

## 7. The AI assistant — it runs on the visitor's device

This is the part that surprises people most: **no prompt, reply or generated
image passes through this server in production.**

- Chat, images and text-to-speech all go **browser-direct to Pollinations**, from
  the visitor's own machine on their own IP.
- The server hands the browser a **publishable** (`pk_`) key, which is designed
  to be public. A secret key must never go there.
- Server-side AI routes still exist, but only as a **local-development aid** —
  Pollinations rejects browser calls from `http://localhost`. `aiServerAllowed()`
  refuses them whenever `NODE_ENV=production` or the caller is not on loopback.
- **The Vibe Finder uses no AI in production either.** It maps your mood with a
  curated index and ranks games deterministically. Its optional AI refinement is
  behind the same guard — it once sent visitors' typed text to Pollinations from
  the server's IP, which is exactly what this design exists to prevent.
- An **optional second provider** (Hugging Face) runs in the browser under the
  visitor's own token, off by default.

What that buys: no AI compute or bandwidth on your host, no shared rate limit,
and prompts that are not observable server-side because they never arrive.

Feedback on AI answers is separate, consented, redacted, and **never mixed with
proxy traffic**. That boundary is structural, not a promise — see
[docs/features/AI-ARCHITECTURE.md](../features/AI-ARCHITECTURE.md).

---

## 8. The proxy browser

`browser.html` plus `gust/`, `/uv/`, `/scram/` and `/wisp/` let a visitor browse
other sites through your server. This is the "unblocked at school" feature, and
it is the reason several other decisions on this page exist.

**Three engines, all open-source and credited** in [CREDITS.md](../CREDITS.md):

| Engine | How it works |
|---|---|
| **Scramjet** | service worker, newer rewriter |
| **Ultraviolet** | service worker, the long-standing one |
| **GUST** | runs libcurl.js in the page |

**How a request actually leaves the building:**

```
page → service worker → bare-mux → epoxy-transport → same-origin /wisp/
     → Wisp server → (optional) sing-box SOCKS5 → the internet
```

Three things guard that path:

- **`lib/wisp-policy.mjs`** — an explicit egress policy: which ports may be
  reached, which hostnames are refused, whether private/loopback addresses are
  allowed, and how many streams one client may open. It **fails safe** (a missing
  setting gives the restrictive default) and warns at boot on every widening.
  See [docs/proxy/INVISIPROXY.md](../proxy/INVISIPROXY.md).
- **sing-box** — an optional outbound tunnel so proxy traffic leaves from
  somewhere other than your web host. See [docs/proxy/SINGBOX.md](../proxy/SINGBOX.md).
- **Companion engines** — Kasm Workspaces and others can be pointed at as
  *external* deployments rather than bundled ([docs/proxy/KASM.md](../proxy/KASM.md)).
  **AnuraOS** is different: a whole web OS with x86 emulation, served by *this*
  process on its **own origin**, because it assumes it owns a site root
  ([docs/proxy/ANURA.md](../proxy/ANURA.md)).

**Verify it actually works** with `npm run verify-proxy`, which drives a real
browser through every engine and checks that pages render. An HTTP 200 from the
proxy route proves nothing — the page can still be blank.

---

## 9. The MASQR gate (off by default)

A mirror domain usually dies the same way: someone shares the link, a filter
vendor's crawler fetches it, sees a web proxy, and files the domain under
*proxy/anonymizer*.

When `MASQR_ENABLED=1`, an unauthenticated visitor gets the **real games hub**
and a `404` on the proxy paths. A signed key in a link unlocks them.

- **Off by default** — unset, nothing about the site changes.
- **Not access control.** A key holder can pass it on, and the games hub stays
  open to everyone regardless. It buys discovery resistance, nothing more.
- **Health checks are never gated** — gating `/healthz` would restart-loop the
  container.

Full detail: [docs/proxy/MASQR.md](../proxy/MASQR.md)

---

## 10. Ads

- **Six networks, one role each, and no others:** Ad-Maven (interstitial,
  ≤ 1 per 20 min), ExoClick (header + sidebar), HilltopAds (in-page push),
  Clickadu (video pre-roll before a game loads), Mondiad (native, below the
  "for you" rows), PopAds (desktop game-page popunder). Each is enabled
  independently with `<NETWORK>_ENABLED=1` plus its role variable. Enabled
  without configuration renders nothing; unset means genuinely nothing — no
  boxes, no reserved space, no requests. A visitor whose ad-blocker stays on for
  three pages finds only the premium proxy engines (AnuraOS and the standalone
  browsers) locked; games and the built-in engines never are.
- **Google AdSense is never used**, and is refused at three layers. Google bans
  proxy domains at the *account* level, so one stray tag could take down an
  unrelated account.
- **Ads never run on the proxy.** `/browser`, `/gust` and every proxy asset route
  are excluded structurally — in the registry, in the API and in the client. What
  renders there is somebody else's website, and monetising it would mean
  injecting script into third-party content in transit.
- **No network has approved this site.** All five review your specific domain.

In-game ads inside the games belong to the game makers (GameMonetize,
GameDistribution) and pay separately.

Full detail: [docs/features/ADVERTISING.md](../features/ADVERTISING.md)

---

## 11. The night shift — ten scheduled jobs (`lib/cron-jobs.mjs`)

Everything that keeps the catalog healthy without you touching it. All times UTC.

| Job | When | What it does |
|---|---|---|
| `link-check` | hourly, `:00` | hides games whose link is truly dead (404/410) |
| `grow` | hourly `:30`, 3-day gate inside | adds render-verified games over time |
| `health` | daily 00:05 | logs working/dead counts |
| `rec-cleanup` | daily 00:15 | removes stale unseen recommendations, trims to the cap |
| `retention` | daily 03:40 | trims admin logs. The SQL function floors its own arguments, so this can shrink the audit trail but never erase it |
| `orphan-stats` | Mondays 03:50 | clears play counters for games that no longer exist |
| `score-prune` | daily 03:55 | trims scores per the retention rules |
| `y8-sync` | Sundays 04:00 | re-scrapes Y8's embed directory and upserts |
| `ai-feedback-prune` | daily 04:05 | enforces the 180-day promise in `db/15_ai_feedback.sql` |
| `keepalive` | daily 06:00 | writes the heartbeat row |

A first link-check also fires 30 seconds after boot.

These use **`node-cron`, not `setInterval`** — a real scheduler with real cron
expressions. Run more than one replica and they all share one database, so set
`CRON_DISABLED=1` on every replica but one.

---

## 12. Beside the catalog: the leaderboard, GameFlare and visitor features

Three features that sit beside the catalog, each with its own document:

- **The leaderboard** trusts a number a stranger typed — because the games are
  cross-origin iframes, no real score can be read out of one. So a score costs
  something to fake: a one-time play token issued when the game opens, a
  minimum play time, and plausibility checks. Implausible scores are hidden and
  purged after a week. → [LEADERBOARD.md](../features/LEADERBOARD.md)
- **GameFlare** is a second catalog with its own player, its own strict rules
  (exact URLs, no proxying, no sandbox, no ads) and a real-browser verifier. It
  is **empty by design** until a run proves a game actually starts behind its
  video ad. → [GAMEFLARE.md](../features/GAMEFLARE.md)
- **Visitor features** — the generated username, "For You", the live
  "N playing now" count, the mirror-update email list, feedback and the panic
  key — plus one table of everything the site stores about a visitor and for how
  long. → [VISITOR-FEATURES.md](../features/VISITOR-FEATURES.md)

---

## 13. The admin console

`/admin` — session-based login, **role-based access control**, CSRF on every
write, and an append-only audit trail in Postgres.

Two facts worth knowing up front:

- **`security.write` is owner-only.** A static machine token (`ADMIN_SECRET`) can
  authenticate but **can never be `owner`**, so a leaked token cannot mint proxy
  keys or change security settings.
- The audit log is append-only by grant, not by convention.

---

## 14. Donations

`data/donate.json` declares which methods exist; each address comes from an
**environment variable**, never a committed file. A committed address is a
permanent, searchable link between the repo and a wallet, and git history keeps
it even after removal.

Every address is **checked at load time** and a method whose address fails is
**dropped rather than served** — a missing donate button costs nothing, a wrong
one costs every donation until somebody notices.

- **BTC, LTC and ETH get a full checksum.** ETH uses EIP-55, which needs real
  Keccak-256 — not `node:crypto`'s SHA-3 — so the repository carries a
  dependency-free implementation. Paste the mixed-case ETH address your wallet
  shows; an all-lowercase one carries no checksum and is rejected.
- **SOL, USDC and XMR are checked for shape only**, and the boot log says so by
  name. Send yourself a test transaction before publishing those.

There is also a "pay any coin, settle in Monero" **swap path** — but it exists
only as a server API; **no page offers it yet**. It would hide the flow from the
**public** and **not from the swap provider**, who necessarily learns the
amounts, addresses and timing.

Full detail: [DONATIONS.md](../features/DONATIONS.md)

---

## 15. Deployment — one shape, always a proxy site

ZoFHub deploys **once**, as a single always-on proxy site. There is no
"hub-only / AdSense" mode: the proxy is always running, so Google cannot be used
and monetisation is entirely via the proxy-friendly networks in §10.

See `render.yaml` and [GO-LIVE.md](GO-LIVE.md).

---

## 16. The folders at a glance

| Path | What lives there |
|---|---|
| `server.js` | the program |
| `public/` | everything the visitor downloads |
| `proxy-engine/` | every AGPL proxy engine (GUST, Ultraviolet, Scramjet) behind one mount function |
| `lib/` | server helper modules (Supabase, cron, proxy policy, ads, AI, scores, donations) |
| `admin-ui/` | the admin console — deliberately outside `public/` |
| `db/` | authored SQL — the source of truth for the schema |
| `supabase/migrations/` | the **generated** mirror the Supabase GitHub integration reads |
| `tools/` | scripts you run by hand (audits, generators, verifiers) |
| `test/` | the test suite (`npm test`) |
| `docs/` | **all** documentation — `guides/`, `database/`, `features/`, `proxy/`, `reports/` |
| `data/` | config and datasets (`catalog-overrides.json`, `donate.json`, provenance records) |
| `legal/` | the served privacy, terms, DMCA, cookies and credits pages |

The full annotated tree is in the README's
[project structure](../README.md#-project-structure) section.

---

## 17. "I changed something — how do I see it?"

| Changed | Do this |
|---|---|
| a page, style or script in `public/` | restart (or redeploy) **and hard-refresh** (`Ctrl+Shift+R`). Bump the `?v=` if it still will not show |
| the games | update Supabase — the catalog refreshes within 30 minutes, or instantly on restart |
| the schema | author in `db/`, then `npm run sync-migrations`, then commit. **Never hand-edit `supabase/migrations/`** |
| anything at all | `npm test` before you push |
