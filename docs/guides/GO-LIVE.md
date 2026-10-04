# ZoFHub — Go-Live Checklist

The strategy: **one always-on proxy site, deployed once.** ZoFHub always runs the
web proxy (GUST/Ultraviolet/Scramjet/Wisp), so it is both the games hub and the
"unblocked at school" site on the **same** domain.

Because the proxy is always on, **Google AdSense/Ezoic can't be used** — they ban
proxy/anonymizer domains at the account level. Advertising comes from six
supported networks, one role each (Ad-Maven / ExoClick / HilltopAds / Clickadu /
Mondiad / PopAds), on the **hub and game pages only**, plus the in-game ads the
game publishers already run. Ads
never run on the proxy itself. If a domain gets filtered at schools, rotate to a
new domain — the code is unchanged.

---

## 1. Host (NOT Vercel)
ZoFHub is a persistent server (cron + in-memory catalog + `/wisp` WebSocket), so
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
- [ ] Paste **`db/SCHEMA-ONLY.sql`** into the SQL Editor and Run. One file, all 16
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
| `POLLINATIONS_REFERRER` | — | your domain (bare hostname), for AI attribution |
| `CRON_SECRET` | ✓ | protects `/healthz` detail; set the SAME value in your uptime monitor |
| `HEALTH_MEM_MAX_PCT` | — | `/healthz` returns 503 above this memory % (default 85) for zero-downtime recycles |
| `WISP_MAX_PER_IP` | — | max concurrent proxy tunnels per client IP (default 32); stops one client starving the pool |
| `WISP_ALLOWED_PORTS` | — | ports the tunnel may dial (default `80,443,8080,8443`). Deliberately excludes 25/22/3306 — see [docs/proxy/INVISIPROXY.md](../proxy/INVISIPROXY.md) |
| `WISP_ALLOW_UDP` | — | default off. UDP **bypasses sing-box**, so `SINGBOX_REQUIRE` does not cover it |
| `WISP_ALLOW_PRIVATE_IPS` | — | default off. Leave it off: on means the public tunnel can reach your private network and `169.254.169.254` |
| `WISP_MAX_STREAMS` | — | concurrent streams **one tunnel** may hold (default 256) |
| `WISP_ALLOW_LOOPBACK_IPS` | — | default off. Leave it off: on means the tunnel can reach services bound to localhost on the host itself |
| `WISP_BLOCKED_HOSTS` | — | anchored glob patterns refused outright, e.g. `*.internal.example.com` |
| `MASQR_ENABLED` | — | **off by default.** `1` hides the proxy surfaces from anyone without a key. See [docs/proxy/MASQR.md](../proxy/MASQR.md) |
| `MASQR_SECRET` | if gated | 32+ random chars. **Required when `MASQR_ENABLED=1`** — without it the gate refuses to engage and warns loudly rather than locking everyone out |
| `MASQR_KEY_TTL_DAYS` | — | key lifetime, default 30 |
| `MASQR_DENY` | — | `404` (default) or `redirect` |
| `PROXY_INVISI_URL` | — | optional [InvisiProxy](../proxy/INVISIPROXY.md) instance you host yourself; unset = engine not offered |
| `PROXY_KASM_URL` | — | optional [Kasm](../proxy/KASM.md) desktop you host yourself. **Userinfo is stripped** — a `user:pass@` URL would otherwise leak the password through `/api/proxies` |
| `SINGBOX_*` | — | **on by default** in the Docker image: sing-box carries the proxy's egress and ZoFHub supervises it. `SINGBOX_MANAGED=0` stops supervising, `SINGBOX_EGRESS=0` stops tunnelling, `SINGBOX_REQUIRE=1` fails a stream rather than falling back to direct. Without the binary (Render's native Node runtime, for one) every stream takes the direct fallback and `/api/admin/proxy` says so. See [docs/proxy/SINGBOX.md](../proxy/SINGBOX.md) |
| `DONATE_*_ADDRESS` | — | donation addresses, **environment only, never committed**. Checksum-verified at boot; a method that fails is dropped rather than served |
| `NODE_ENV` | `production` | |

> **Check the boot banner after deploying.** It prints one line per subsystem and
> is the fastest way to confirm what is actually switched on:
>
> ```
> → egress:  ports 80,443,8080,8443 · no UDP · private IPs blocked · max 256 streams/tunnel
> → masqr:   off (proxy is open to everyone)
> → admin:   password login active (sessions, CSRF, lockout)
> ```

## 4. Ad networks (proxy-friendly only)
Google AdSense/Ezoic are **not** an option here (they ban proxy sites). Best money
for an always-proxy games hub, in order:
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
   > domain, and ZoFHub hosts a web proxy — raise that with each network
   > explicitly before enabling. The audience includes minors: set every
   > dashboard to mainstream (non-adult) categories. See
   > [`docs/features/ADVERTISING.md`](../features/ADVERTISING.md).

   Start with **one**. Stacking popunder networks makes them fight each other and
   trips their fraud checks — the fastest way to be banned by all and paid by
   none. Verify with `npm run check-ads` before you deploy.
- [ ] At least one `<NETWORK>_ENABLED` + its role variable set (or all unset to run ad-free).
- [ ] The boot log's `[ads] set but NOT used:` line is absent — every ad variable you set is one the code reads.
- [ ] `npm run check-ads` passes — it catches the CSP blocking a network, which is otherwise silent.
- [ ] Confirmed with each enabled network that this domain, and the specific format, are approved.
- [ ] Checked `/browser` serves **no** advertising (it must not — verify after enabling).
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
- [ ] `/browser` loads and `/api/site-config` shows `"proxy": true` (always-on proxy).
- [ ] `npm test` passes (1379 tests) and `npm run audit:repo` reports no errors
      you have not consciously accepted.
- [ ] **`npm run verify-proxy` renders real pages through every engine.** An HTTP
      200 from a proxy route proves nothing — the page can still be blank.
- [ ] `npm run db:verify` passes — it proves the tables are *readable*, which a
      row count in the SQL editor does not.
- [ ] If `MASQR_ENABLED=1`: mint a key, confirm the link unlocks `/browser`,
      confirm `/healthz` still answers **200**, and confirm a plain visitor still
      gets the games hub. A gated `/healthz` restart-loops the container.

## 6. Domain & DNS
- [ ] Point your domain at the service; if a domain gets filtered, add a fresh one.
- [ ] HTTPS (the host provisions certs automatically).
- [ ] `POLLINATIONS_REFERRER` + GameMonetize/GD referrer = your real domain.

## 7. Honest expectations
A brand-new low-traffic games site earns little at first (games display RPMs are
often ~$1–5 per 1,000 views, and embedded-game ad value is shared with the game
publisher). Proxy-friendly networks generally pay lower RPMs than mainstream
display networks, so revenue is modest until traffic grows.
