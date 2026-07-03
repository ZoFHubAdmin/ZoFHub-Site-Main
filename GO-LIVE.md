# ZoFHub — Go-Live Checklist

The strategy: **Both, separated.** One codebase, deployed twice via env vars.

| | Hub domain (money) | Proxy domain (school audience) |
|---|---|---|
| Example | `zofhub.com` | `zofhub-play.com` (rotate when blocked) |
| `SITE_MODE` | `hub` (web proxy OFF) | `full` (web proxy ON) |
| Ads | AdSense/Ezoic + in-game | in-game ads only |
| Audience | open web / home | schools / filtered networks |
| Apply to ad networks? | YES | NO |

Why split: ad networks reject/ban proxy-anonymizer sites, and school filters block
them; you can't have one domain be both monetizable *and* unblockable. Separating
keeps the hub clean for revenue and lets the proxy domain rotate freely.

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
| Var | Hub | Proxy | Notes |
|---|---|---|---|
| `SITE_MODE` | `hub` | `full` | the only behavioral difference |
| `SUPABASE_URL` | ✓ | ✓ | |
| `SUPABASE_ANON_KEY` | ✓ | ✓ | |
| `SUPABASE_SERVICE_ROLE_KEY` | ✓ | ✓ | server-only; bypasses RLS |
| `SCORE_SECRET` | ✓ | ✓ | random 32+ chars; stable so score tokens survive restarts |
| `ADSENSE_CLIENT` | ✓ `ca-pub-…` | — | lights up ad units **and** `/ads.txt` |
| `POLLINATIONS_REFERRER` | your domain | your domain | AI attribution |
| `CRON_SECRET` | ✓ | ✓ | protects `/healthz`; set the SAME value in your uptime monitor |
| `NODE_ENV` | `production` | `production` | |

## 4. Ad networks (do this only for the HUB domain)
Best money for a games hub, in order:
1. **In-game ads — already wired.** Register your hub domain in your
   **GameMonetize** and **GameDistribution** publisher dashboards so their
   in-game ad revenue is attributed to you. This is your biggest, most reliable
   earner and needs no AdSense approval.
2. **Ezoic** — best first display network: no traffic minimum, gives Google AdX
   access, higher RPM than plain AdSense.
3. **AdSense** — easy to apply; lower RPM; may scrutinize a games hub. Fine as a
   starter. Set `ADSENSE_CLIENT` and the units + `/ads.txt` populate automatically.
4. **Playwire / Snigel / AdinPlay** — gaming-specialized, highest RPM; apply once
   you have real traffic (tens-to-hundreds of thousands of views/month).
- [ ] `/ads.txt` shows your publisher line (auto from `ADSENSE_CLIENT`).
- [ ] Keep ads OFF the proxy — already enforced in `ads.js`.

## 5. Pre-launch QA
- [ ] `/api/health` returns 200.
- [ ] Home loads; click a game → it plays without a refresh; Fullscreen on one line.
- [ ] Mobile: hamburger menu works; layout fits phone + iPad.
- [ ] Leaderboard: submit a score in a game → appears on `/leaderboard`.
- [ ] Hub build: visiting `/browser` redirects to `/`; `/api/site-config` shows
      `"proxy": false`. Proxy build: `/browser` loads; `"proxy": true`.

## 6. Domain & DNS
- [ ] Point the hub domain at the hub service; the proxy domain at the proxy service.
- [ ] HTTPS (the host provisions certs automatically).
- [ ] `POLLINATIONS_REFERRER` + GameMonetize/GD referrer = your real hub domain.

## 7. Honest expectations
A brand-new low-traffic games site earns little at first (games display RPMs are
often ~$1–5 per 1,000 views, and embedded-game ad value is shared with the game
publisher). Revenue grows with traffic. Self-hosted/original games keep 100% and
earn more per play than embeds.
