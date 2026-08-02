# ZoFHub — Go-Live Checklist

The strategy: **one always-on proxy site, deployed once.** ZoFHub always runs the
web proxy (GUST/Ultraviolet/Scramjet/Wisp), so it is both the games hub and the
"unblocked at school" site on the **same** domain.

Because the proxy is always on, **Google AdSense/Ezoic can't be used** — they ban
proxy/anonymizer domains at the account level. Monetization is entirely via
**proxy-friendly ad networks** (Adsterra / HilltopAds / Monetag) plus the in-game
ads the game publishers already run. If a domain gets filtered at schools, rotate
to a new domain — the code is unchanged.

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
| `PROXY_AD_SCRIPTS` | — | comma-separated proxy-friendly ad loader script URL(s); Google URLs auto-rejected. Blank = ad-free |
| `PROXY_BANNER_TAG` | — | optional single footer banner tag |
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
2. **Proxy-friendly display/pop networks** — **Adsterra**, **HilltopAds**,
   **Monetag**. Sign up, get your page-level loader script(s), and set them in
   `PROXY_AD_SCRIPTS` (comma-separated). Add one footer banner via
   `PROXY_BANNER_TAG` if you want. These are the only display networks that accept
   proxy traffic.
- [ ] `PROXY_AD_SCRIPTS` set (or intentionally blank to run ad-free).
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
