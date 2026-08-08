# ZoFHub — Go-Live Checklist

The strategy: **one always-on proxy site, deployed once.** ZoFHub always runs the
web proxy (GUST/Ultraviolet/Scramjet/Wisp), so it is both the games hub and the
"unblocked at school" site on the **same** domain.

Because the proxy is always on, **Google AdSense/Ezoic can't be used** — they ban
proxy/anonymizer domains at the account level. Advertising comes from five
supported networks (HilltopAds / Adsterra / Monetag / Ad-Maven / PopAds) on the
**hub pages only**, plus the in-game ads the game publishers already run. Ads
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
- [ ] Run `db/schema.sql` (games).
- [ ] Run `db/community.sql` (leaderboard + recommendations + the `prune_scores`
      cap so the DB can't balloon).
- [ ] Copy the project URL + anon key + **service-role** key for env vars below.

## 3. Environment variables (set in the host dashboard — never commit)
| Var | Required | Notes |
|---|---|---|
| `SUPABASE_URL` | ✓ | |
| `SUPABASE_ANON_KEY` | ✓ | public/browser key (`SUPABASE_PUBLISHABLE_KEY` accepted too) |
| `SUPABASE_SECRET_KEY` | ✓ | server-only; bypasses RLS. The new `sb_secret_…` key from Settings → API Keys — **use this one** |
| `SUPABASE_SERVICE_ROLE_KEY` | — | legacy `eyJ…` JWT. **Disabled on this project** — the API answers `401 Legacy API keys are disabled`. Leave unset; `SUPABASE_SECRET_KEY` is mirrored onto this name for the CLI tools |
| `SCORE_SECRET` | ✓ | random 32+ chars; stable so score tokens survive restarts |
| `ADMIN_SECRET` | ✓ | random 32+ chars; unlocks `/admin` to review scores the anti-cheat layer flagged/quarantined. Without it the panel fails closed and flagged scores can never be released |
| `<NETWORK>_ENABLED` | — | `1` enables one of the five. Prefixes: `HILLTOPADS` `ADSTERRA` `MONETAG` `ADMAVEN` `POPADS`. All unset = ad-free |
| `<NETWORK>_SCRIPT` | — | that network's loader URL(s), comma-separated, https only; Google URLs auto-rejected |
| `<NETWORK>_<SLOT>_TAG` | — | raw tag for `HEADER` / `SIDEBAR` / `FOOTER` / `INCONTENT` |
| `PROXY_AD_SCRIPTS` | — | **deprecated** legacy loader list; still honoured, carries no network identity |
| `POLLINATIONS_REFERRER` | — | your domain (bare hostname), for AI attribution |
| `CRON_SECRET` | ✓ | protects `/healthz`; set the SAME value in your uptime monitor |
| `NODE_ENV` | `production` | |

## 4. Ad networks (proxy-friendly only)
Google AdSense/Ezoic are **not** an option here (they ban proxy sites). Best money
for an always-proxy games hub, in order:
1. **In-game ads — already wired.** Register your domain in your **GameMonetize**
   and **GameDistribution** publisher dashboards so their in-game ad revenue is
   attributed to you. This is your biggest, most reliable earner and needs no
   approval process.
2. **Display/pop networks — five supported, and no others:** **HilltopAds**,
   **Adsterra**, **Monetag**, **Ad-Maven**, **PopAds**. Enable each one
   independently:

   ```bash
   ADSTERRA_ENABLED=1
   ADSTERRA_SCRIPT=https://<loader URL from your dashboard>
   ```

   > ⚠ **None of them has approved this site.** All five review your specific
   > domain, and ZoFHub hosts a web proxy — raise that with each network
   > explicitly before enabling. Approval for one format does not extend to
   > another. See [`docs/ADVERTISING.md`](docs/ADVERTISING.md).

   Start with **one**. Stacking popunder networks makes them fight each other and
   trips their fraud checks — the fastest way to be banned by all and paid by
   none. Verify with `npm run check-ads` before you deploy.
- [ ] At least one `<NETWORK>_ENABLED` + `<NETWORK>_SCRIPT` set (or all unset to run ad-free).
- [ ] `npm run check-ads` passes — it catches the CSP blocking a network, which is otherwise silent.
- [ ] Confirmed with each enabled network that this domain, and the specific format, are approved.
- [ ] Checked `/browser` serves **no** advertising (it must not — verify after enabling).
- [ ] Any accidental Google/AdSense tag is auto-stripped server-side — nothing to do.

## 5. Pre-launch QA
- [ ] `/api/health` returns 200.
- [ ] Home loads; click a game → it plays without a refresh; Fullscreen on one line.
- [ ] Mobile: hamburger menu works; layout fits phone + iPad.
- [ ] Leaderboard: submit a score in a game → appears on `/leaderboard`.
- [ ] `/browser` loads and `/api/site-config` shows `"proxy": true` (always-on proxy).

## 6. Domain & DNS
- [ ] Point your domain at the service; if a domain gets filtered, add a fresh one.
- [ ] HTTPS (the host provisions certs automatically).
- [ ] `POLLINATIONS_REFERRER` + GameMonetize/GD referrer = your real domain.

## 7. Honest expectations
A brand-new low-traffic games site earns little at first (games display RPMs are
often ~$1–5 per 1,000 views, and embedded-game ad value is shared with the game
publisher). Proxy-friendly networks generally pay lower RPMs than mainstream
display networks, so revenue is modest until traffic grows.
