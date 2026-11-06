# ZoFHub — Go-Live Checklist

The strategy: **one always-on site, deployed once.** ZoFHub is a games hub with a
free AI assistant.

**Google AdSense/Ezoic are not used.** Advertising comes from six supported
networks, one role each (Ad-Maven / ExoClick / HilltopAds / Clickadu / Mondiad /
PopAds), on pages ZoFHub wrote only, plus the in-game ads the game publishers
already run. If a domain gets filtered at schools, rotate to a new domain — the
code is unchanged.

---

## 1. Host (NOT Vercel)
ZoFHub is a persistent server (cron + in-memory catalog + a supervised sing-box daemon), so
serverless won't work. Use **Render** (`render.yaml` included), Railway, Fly.io,
or a VPS.
- **Paid always-on plan** — simplest; nothing ever sleeps.
- **Free tier** — also works: it sleeps after ~15 min idle, but the built-in
  secured `/healthz` endpoint + an external uptime monitor (e.g. cron-job.org)
  pinging it every ~10 min keeps the service **and** Supabase awake. Set
  `CRON_SECRET` (below), point the monitor at
  `https://<your-service>.onrender.com/healthz` with that secret, and keep-alive
  **one** service only so you stay under Render's 750 free hours/month.

## 2. Database (Supabase)
- [ ] Paste **`db/SCHEMA-ONLY.sql`** into the SQL Editor and Run. One file, all 21
      schema migrations in dependency order, idempotent — re-running is safe.
      Do **not** paste `db/ALL-IN-ONE.sql`: at ~6.5 MB the web editor refuses it,
      and it is meant for `psql` restores.
- [ ] Load the catalog: `npm run restore-games` (~16,900 games over PostgREST, so
      no database connection string is needed).
- [ ] `npm run db:verify` — must report **0 error**. Do not skip this. Every way
      this deploy fails is silent: a schema that never applied, an integration
      pointed at the wrong repository, or tables that exist but no role can read
      (see the note on grants below). Asking the database is the only check that
      distinguishes those from success.
- [ ] Copy the project URL and the `sb_publishable_…` + `sb_secret_…` keys from
      Settings → API Keys for the env vars below.

> **Grants are part of the schema, not an afterthought.** `CREATE TABLE` grants
> nobody anything — a table its owner alone can read is indistinguishable from a
> working one until something queries it. `db/grants.sql` runs last and assigns
> the privileges explicitly rather than inheriting whatever a given project was
> provisioned with. If you ever see `42501 permission denied for table …`, that
> file did not run.

## 3. Environment variables (set in the host dashboard — never commit)
| Var | Required | Notes |
|---|---|---|
| `SUPABASE_URL` | ✓ | |
| `SUPABASE_ANON_KEY` | ✓ | public/browser key (`SUPABASE_PUBLISHABLE_KEY` accepted too) |
| `SUPABASE_SECRET_KEY` | ✓ | server-only; bypasses RLS. The new `sb_secret_…` key from Settings → API Keys — **use this one** |
| `SUPABASE_SERVICE_ROLE_KEY` | — | legacy `eyJ…` JWT. **Disabled on this project** — the API answers `401 Legacy API keys are disabled`. Leave unset; `SUPABASE_SECRET_KEY` is mirrored onto this name for the CLI tools |
| `ADMIN_USERNAME` | ✓ | login name for `/admin` |
| `ADMIN_PASSWORD_HASH` | ✓ | scrypt hash of the admin password — generate it with `npm run admin-hash`. The plaintext is never stored anywhere |
| `ADMIN_SESSION_SECRET` | ✓ | random 32+ chars; signs admin session cookies **and** keys the audit log's IP HMAC. Changing it logs everyone out and breaks correlation on existing audit rows |
| `ADMIN_SECRET` | ✓ | random 32+ chars; without it the admin console fails closed. Runs as `operator`, never `owner` |
| `ADMIN_SERVICE_ROLE` | — | role for the `ADMIN_SECRET` token: `operator` (default) or `viewer`. `owner` is refused |
| `<NETWORK>_ENABLED` | — | `1` enables one of the six. Prefixes: `ADMAVEN` `EXOCLICK` `HILLTOPADS` `CLICKADU` `MONDIAD` `POPADS`. All unset = ad-free |
| `ADMAVEN_INTERSTITIAL_TAG` / `_URL` | — | between-games interstitial; 1 / visitor / 20 min, fixed |
| `EXOCLICK_HEADER_TAG` / `_SIDEBAR_TAG` | — | header 728×90 and sidebar 300×250 |
| `HILLTOPADS_PUSH_SCRIPT` | — | in-page push loader URL(s) |
| `CLICKADU_PREROLL_VAST` | — | VAST tag for the video pre-roll before a game |
| `MONDIAD_NATIVE_TAG` | — | native widget below the "for you" rows |
| `POPADS_POPUNDER_TAG` | — | PopAds code, unmodified; desktop game pages only |
| `REGION_ROUTES` | — | optional regional domains + regional ad tags (`<VAR>__<REGION>`); see `.env.example` |
| `CRON_SECRET` | ✓ | protects `/healthz` detail; set the SAME value in your uptime monitor |
| `HEALTH_MEM_MAX_PCT` | — | `/healthz` returns 503 above this memory % (default 85) for zero-downtime recycles |
| `SINGBOX_*` | — | **enforced.** sing-box carries every connection the server makes for a visitor (embeds, thumbnails, assets, link checks) or the connection is **refused**; there is no direct fallback, and the development-only opt-outs (`SINGBOX_ALLOW_DIRECT`, `SINGBOX_REQUIRE=0`, `SINGBOX_EGRESS=0`) are **ignored in production**. ZoFHub supervises the daemon (`SINGBOX_MANAGED=0` stops that). **The daemon has to exist:** Render's build runs `npm run singbox:install` (pinned and SHA-256-verified; any failure fails the build, so the previous deploy keeps serving) and the Docker image builds it. After a deploy `/api/admin/proxy` should show `singboxProcess.running: true` and `singboxEgress.policy.mode: "enforced"`. See [docs/proxy/SINGBOX.md](../proxy/SINGBOX.md) |
| `EGRESS_DIRECT_ALLOW` | — | hosts the server may connect to **directly**, comma separated (`host` or `*.suffix`). Infrastructure only — the database, cache and mail hosts are already derived from your other settings. Anything else that is not loopback is refused by `lib/egress-guard.mjs` |
| `DONATE_*_ADDRESS` | — | donation addresses, **environment only, never committed**. Checksum-verified at boot; a method that fails is dropped rather than served |
| `NODE_ENV` | `production` | |

> **Check the boot log after deploying.** It prints one `[prefix]` line per
> subsystem and is the fastest way to confirm what is actually switched on:
>
> ```
> [egress] enforced: every visitor-driven connection crosses sing-box, or is refused
> [singbox] supervisor: running (...)
> [ads] roles → ...
> ```

## 4. Ad networks
Google AdSense/Ezoic are **not** used here. Best money for a games hub, in order:
1. **In-game ads — already wired.** Register your domain in your **GameMonetize**
   and **GameDistribution** publisher dashboards so their in-game ad revenue is
   attributed to you. This is your biggest, most reliable earner and needs no
   approval process.
2. **Display/video/pop networks — six supported, one role each, and no
   others:** **Ad-Maven** (interstitial), **ExoClick** (header + sidebar),
   **HilltopAds** (in-page push), **Clickadu** (video pre-roll), **Mondiad**
   (native), **PopAds** (desktop popunder). Enable each one independently:

   ```bash
   EXOCLICK_ENABLED=1
   EXOCLICK_HEADER_TAG=<zone code from your dashboard, one line>
   ```

   > ⚠ **None of them has approved this site.** All six review your specific
   > domain — check each network's terms before enabling. The audience
   > includes minors: set every dashboard to mainstream (non-adult) categories. See
   > [`docs/features/ADVERTISING.md`](../features/ADVERTISING.md).

   Start with **one**. Stacking popunder networks makes them fight each other and
   trips their fraud checks — the fastest way to be banned by all and paid by
   none. Verify with `npm run check-ads` before you deploy.
- [ ] At least one `<NETWORK>_ENABLED` + its role variable set (or all unset to run ad-free).
- [ ] The boot log's `[ads] set but NOT used:` line is absent — every ad variable you set is one the code reads.
- [ ] `npm run check-ads` passes — it catches the CSP blocking a network, which is otherwise silent.
- [ ] Confirmed with each enabled network that this domain, and the specific format, are approved.
- [ ] `npm run check-ads` also confirms a path nobody classified is handed no advertising (deny-by-default).
- [ ] Any accidental Google/AdSense tag is auto-stripped server-side — nothing to do.

## 5. Pre-launch QA
- [ ] `/api/health` returns 200.
- [ ] Home loads; click a game → it plays without a refresh; Fullscreen on one line.
- [ ] Mobile: hamburger menu works; layout fits phone + iPad.
- [ ] Vibe Finder: type "something calm I can play in 10 minutes" → returns games,
      and each one shows why it was picked.
- [ ] "For You" fills after playing a few games, and no single category owns the row.
- [ ] Admin: log in at `/admin`; confirm a logged-out request to
      `/api/admin/dashboard` returns **401**, not 200.
- [ ] Admin → **Egress** shows sing-box connected and running, with **0** refused fetches.
- [ ] `npm test` passes and `npm run audit:repo` reports no errors
      you have not consciously accepted.
- [ ] **`npm run verify-ai` passes** — it drives a real browser through the AI page and checks what actually crosses the network.
- [ ] `npm run db:verify` passes — it proves the tables are *readable*, which a
      row count in the SQL editor does not.

## 6. Domain & DNS
- [ ] Point your domain at the service; if a domain gets filtered, add a fresh one.
- [ ] HTTPS (the host provisions certs automatically).
- [ ] GameMonetize / GameDistribution referrer = your real domain. (The AI needs
      nothing: it is one keyless GET from each visitor's own browser, so there is
      no key, referrer or model to configure.)

## 7. Honest expectations
A brand-new low-traffic games site earns little at first (games display RPMs are
often ~$1–5 per 1,000 views, and embedded-game ad value is shared with the game
publisher). The networks used here generally pay lower RPMs than mainstream
display networks, so revenue is modest until traffic grows.
