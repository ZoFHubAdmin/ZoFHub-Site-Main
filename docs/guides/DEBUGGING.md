# 🛠️ ZoFHub — Debugging & "How Do I Fix This?" Guide

A plain-language checklist for when something breaks. You don't need to be an
advanced coder to use this — just go top to bottom.

> **Not sure how a piece works?** [HOW-IT-WORKS.md](HOW-IT-WORKS.md) is the tour.
> **Looking for a command?** [COMMANDS.md](COMMANDS.md) has every one.

---

## ⚡ The 30-second rule: 9 times out of 10 it's one of these three
1. **Your browser is showing an OLD version** → not really broken, just cached.
2. **There's a red error message** telling you exactly what's wrong.
3. **The server/deploy didn't restart** with your new code.

Check them in order. You rarely have to "figure it out" from scratch.

---

## Step 1 — Hard refresh, ALWAYS FIRST
`Ctrl + Shift + R` (Windows) — forces the browser to re-download everything.

Before you EVER say "the fix didn't work," do this. Half the time it *is* the fix.

---

## Step 2 — Open the Console and read the red text (most useful skill!)
1. Press **`F12`** (or right-click page → **Inspect**).
2. Click the **Console** tab.
3. Look for text in **red**. It names the file + line, e.g. `pollinations.js:42 — TypeError`.

👉 You don't need to understand it. **Copy the red text and paste it to Claude.**
That one line is worth more than three paragraphs of "it's not working."

Also handy: the **Network** tab → reload with it open → anything **red** = a file
or request that failed to load.

---

## Step 3 — Is it broken for everyone, or just me?
- Open the site in **Incognito** (`Ctrl + Shift + N`), or on your **phone**.
- Works there but not your normal browser? → it was cache/an extension on your end (not a real bug).
- Broken everywhere? → real bug. Tell Claude (with the Step 2 error).

---

## Step 3b — `/browser` says "Uh oh! There was an error loading…"? Check your antivirus first

**You no longer have to guess.** The server probes one outbound TLS connection
at boot and, if a known interception root signed it, prints this and shows a red
bar on `/browser` naming the product:

```
  -> WARNING: the proxy will fail on every https site -
             outbound TLS on this machine is being intercepted by Avast
             (the certificate for example.com is signed by "Avast Web/Mail Shield Root").
```

If you see that, skip to the fix at the end of this section. The rest explains
why, and how to confirm it by hand.

The failure arrives with **either** of these error texts, depending on engine
and version — both mean the same thing:

```
InvalidCertificate(UnknownIssuer)   ·   invalid peer certificate: UnknownIssuer
Io(Custom { kind: UnexpectedEof, error: "tls handshake eof" })
```

**this is almost certainly your antivirus, not the site.** Avast, AVG, Kaspersky,
ESET and Bitdefender all offer "HTTPS scanning", which works by intercepting
every secure connection and re-signing it with their own root certificate.

That root is installed in **Windows'** trust store, so `curl`, Chrome and
`npm start` (which runs `node --use-system-ca`) all accept it happily. The proxy
engines cannot: Ultraviolet, Scramjet, GUST and HORIZON terminate TLS inside a **WebAssembly**
client that ships its **own** list of trusted authorities and cannot see
Windows' store at all. It meets a certificate signed by an issuer it has never
heard of and refuses it, exactly as it should.

**How to confirm it in ten seconds** — this prints who signed the certificate
your machine actually receives:

```bash
node -e "const t=require('tls');const s=t.connect({host:'example.com',port:443,servername:'example.com',rejectUnauthorized:false},()=>{console.log(s.getPeerCertificate().issuer);s.end()})"
```

A real issuer (DigiCert, Let's Encrypt, Amazon) means the proxy problem is real —
report it. Anything naming your antivirus means **the deployed site is fine** and
only your machine is affected. This was measured here on 2026-08-07: the issuer
came back `Avast Web/Mail Shield Root`, and it had already cost one full
debugging session before anyone thought to look.

**The decisive test, if you want certainty.** The engines are identical for
`http://` and `https://`; only the TLS layer differs. So proxy a plain HTTP site
and compare. Measured here:

| Through the same engine | Result |
|---|---|
| `http://example.com/` via HORIZON | **renders the real page** |
| `http://example.com/` via Ultraviolet | **renders the real page** |
| `https://example.com/` via HORIZON | engine error page |
| `https://example.com/` via Ultraviolet | engine error page |
| `npm run verify-proxy` (all https) | **0/6** |

Two independent engines working over HTTP and failing over HTTPS is not an
engine bug — it is the TLS layer, and nothing above it. If `http://` fails too,
then something else is wrong and this section does not apply.

**The fix.** Turn off HTTPS/SSL scanning in the product named:

- **Avast / AVG** — Menu -> Settings -> Protection -> Core Shields ->
  *Configure shield settings* -> Web Shield -> uncheck **Enable HTTPS scanning**
- **Kaspersky** — Settings -> Network settings -> *Do not scan encrypted connections*
- **ESET** — Advanced setup -> Web and email -> SSL/TLS -> disable protocol filtering
- **Bitdefender** — Protection -> Online Threat Prevention -> **Encrypted Web Scan** off

Or test against the live site instead: a deployed host has no interception, so
**this never affects visitors**. The tunnel's outbound connection is opened by
the SERVER, so it is the server's network that matters, not the visitor's — a
visitor running antivirus is unaffected either way.

---

## Step 3c — `/browser` returns **404**? That may be the MASQR gate, not a bug

If `/browser`, `/horizon`, `/uv/service/…` or `/api/proxies` return **404** while the
games hub loads perfectly, check whether the mirror gate is switched on. The
boot banner says so in one line:

```
→ masqr:   proxy surfaces gated · keys valid 30d · deny 404     ← gate is ON
→ masqr:   off (proxy is open to everyone)                      ← gate is OFF
```

When `MASQR_ENABLED=1`, the proxy surfaces are hidden from anyone without a key.
**That is the feature working**, not a failure. Either:

- open the site with a key — `https://your-site/browser?k=<key>` (mint one from
  the admin console: `POST /api/admin/masqr/key`), or
- unset `MASQR_ENABLED` for local development.

A 404 here is deliberately indistinguishable from a page that does not exist —
that is the whole point — so the boot log is the only place that tells you.

Full detail: [docs/proxy/MASQR.md](../proxy/MASQR.md).

---

## Step 3d — A specific site won't load *through* the proxy

The proxy has an explicit egress policy, and it refuses things on purpose. The
boot banner prints the effective policy:

```
→ egress:  ports 80,443,8080,8443 · no UDP · private IPs blocked · max 256 streams/tunnel
```

Then match the symptom:

| Symptom | Likely cause |
|---|---|
| Connection closes immediately on a non-web port (SSH, SMTP, database) | `WISP_ALLOWED_PORTS` — only 80, 443, 8080, 8443 by default |
| A hostname is always refused | `WISP_BLOCKED_HOSTS` |
| `localhost` / `192.168.…` / `169.254.169.254` refused | deliberate — private-network and cloud-metadata protection. Turning this off exposes your host's internal network |
| Many tabs, then new streams fail | `WISP_MAX_STREAMS` / `WISP_MAX_PER_IP` |

These defaults are **restrictive on purpose**, and every widening prints a warning
at boot. Full detail: [docs/proxy/INVISIPROXY.md](../proxy/INVISIPROXY.md).

---

## Step 3e — "Is the proxy actually working?" — don't guess, measure

An HTTP 200 from a proxy route proves **nothing**. The route can answer while the
page renders blank, and that has caused a wrong diagnosis here before.

```bash
npm run verify-proxy
```

This drives a **real browser** through the Ultraviolet engine
and checks that pages actually render. It is the only claim about the proxy
working that is worth making.

> ⚠️ A `fetch()` from `/browser` is **never** intercepted by a service worker
> scoped to `/uv/service/`. Testing the proxy with `curl` or `fetch` measures
> Express, not the proxy — it will happily return the server's own
> `{"error":"not found"}` and look like a proxy failure.

---

## Step 3f — The AI says "does not accept requests from localhost"? Change the address, not the code

**Symptom.** On your own machine, every AI message fails. Before this was
detected properly it showed as a bare `The AI service refused the request
(error 403)`, which told you nothing.

**Cause.** The AI provider fronts its endpoint with a Cloudflare Turnstile check
keyed on the browser's `Origin` header, and it refuses `http://localhost`.
Measured with the same prompt in the same second, varying only the origin:

| Address you opened the site at | Result |
|---|---|
| `http://localhost:8080` | **403** `{"error":"Missing Turnstile token"}` |
| `http://127.0.0.1:8080` | **200** |
| a deployed `https://` site | **200** |

`localhost` and `127.0.0.1` are the **same server**. The provider only accepts
one of the two spellings.

**Fix.** Open the site at **`http://127.0.0.1:8080`** instead of
`http://localhost:8080`. Nothing to install, nothing to configure, and the AI
answers immediately. The in-page message now names this address for you,
including the port you are actually using.

**This does not affect your live site.** A deployed https origin is accepted, so
visitors never see it. It is a local-development quirk only.

**What is NOT the fix.** Routing the prompt through our own server to hide the
403. That is the one thing the AI architecture exists to prevent — see
[AI-ARCHITECTURE.md](../features/AI-ARCHITECTURE.md). There is also no
client-side trick available: a browser always sends `Origin` on a cross-origin
request, and `mode: 'no-cors'` would make the answer unreadable.

Verify it yourself any time with:

```bash
npm run verify-ai
```

---

## Step 4 — Test on your own computer before blaming the live site
1. Open a terminal in the project folder.
2. Run:  `npm start`
3. Open **http://localhost:8080** in your browser.
4. Press `Ctrl + C` in the terminal to stop it.

- Works locally but not live? → it's a **deploy** problem → Step 5.
- Broken locally too? → it's a **code** problem → tell Claude + paste the Console error.

> If `npm start` errors with "cannot find module," run `npm install` once first.

---

## Step 4b — The three checks that find most problems without a browser

```bash
npm test             # the full suite — run this before every push
npm run check        # parses every JS file (catches syntax errors, no import)
npm run audit:repo   # repository-wide audit: schema, env, API, deps, assets
```

`npm run audit:repo` is the one that catches *config* drift — a migration that
was never applied, an env var documented but unused, an asset referenced but
missing. If it reports errors about tables that do not exist, see Step 6b.

---

## Step 5 — Live site broken? Check Render (the robot that runs your site)
When you push to GitHub, Render auto-rebuilds and restarts your site.

- **Render dashboard → your service → "Events"** → did the latest deploy
  **succeed or fail**? A failed deploy means the live site is still on OLD code.
- **→ "Logs"** → red lines = the server is crashing. Copy them to Claude.
- ⚠️ **Free plan sleeps** when idle — the first visit takes 20–50s to wake up.
  That's normal, not a bug. (If you set up the `/healthz` keep-alive monitor from
  [GO-LIVE.md](GO-LIVE.md), it stays awake.)

> **The container is restart-looping?** Check that nothing is blocking `/healthz`.
> A health probe that 404s makes Render mark the service unhealthy and restart it
> forever. This is why the MASQR gate never gates health endpoints.
>
> If `/healthz` is reachable but the container *still* recycles, it is returning
> **503** — read the body **with `CRON_SECRET`** (`curl -H "Authorization: Bearer
> $CRON_SECRET" .../healthz`) and the `reason` names it: sustained memory over
> `HEALTH_MEM_MAX_PCT`, a sustained event-loop stall over
> `HEALTH_EVENT_LOOP_P99_MS`, or an `uncaughtException` (the `fault` field). A
> breach must persist for `HEALTH_SUSTAIN_MS` (10s) to count, so a transient spike
> will not do it — a *steady* 503 means the instance is genuinely over a limit or
> too small for the catalog (the boot log warns when memory is already near the
> ceiling at startup). `/livez` is liveness only; `/readyz` mirrors `/healthz`.

## Step 5b — Something that used to load now 403s or shows "blocked"

An `/embed`, `/asset`, `/thumb` or `/api/frame-check` request can now be refused
outright when its target URL is not a public web address — that is the SSRF guard
in [`lib/safe-fetch.mjs`](../../lib/safe-fetch.mjs) doing its job. Legitimate game
CDNs are unaffected; a refusal means the URL (or a redirect from it) pointed at a
private/loopback address, a non-web port, or an AI endpoint. A catalog row whose
`embed_url` triggers this is a bad row, not a bug in the guard.

---

## Step 6 — Games / scores / data broken? Check Supabase (the database)
- **Supabase dashboard → Table Editor** → is the data actually there?
- **→ Logs** → are requests failing?
- Games vanished or won't load → usually here.

### Step 6b — `42501 permission denied for table …`

The table **exists** and still cannot be read. This means `db/grants.sql` never
ran, or ran before a later migration created the table.

A `select count(*)` in the Supabase SQL editor runs as the **table owner**, so it
succeeds and tells you nothing. Use the check that connects the way the app does:

```bash
npm run db:verify
```

Fix by re-running `db/SCHEMA-ONLY.sql` (idempotent — safe to re-run). Grants run
last, on purpose. See [docs/database/RUN-IN-ORDER.md](../database/RUN-IN-ORDER.md).

---

## Step 6c — Empty on purpose: things that look broken but are not

Check this list before debugging any of them.

| What you see | Why | Where it is explained |
|---|---|---|
| `/gameflare` shows no games | the GameFlare catalog is **empty by design** until a browser run verifies a game | [GAMEFLARE.md](../features/GAMEFLARE.md) |
| `/leaderboard` says **"not installed"**, and game pages have no submit button | the `scores` table migration is pending on the live project | [LEADERBOARD.md](../features/LEADERBOARD.md) |
| No donate button at all | no `DONATE_*_ADDRESS` is set, or every address failed validation — the boot log says which | [DONATIONS.md](../features/DONATIONS.md) |
| No "pay with another coin" option on `/donate` | the swap path is a server API with **no page yet** | [DONATIONS.md §5](../features/DONATIONS.md#5-swap-donations--pay-any-coin-settle-in-monero-api-only) |
| No ads anywhere | every network is off until you enable one — and `/browser`, `/horizon`, `/gameflare` and `/donate` never carry ads | [ADVERTISING.md](../features/ADVERTISING.md) |
| `/browser` returns 404 | the MASQR gate is on (Step 3c) | [MASQR.md](../proxy/MASQR.md) |
| Only ~784 games | Supabase is unreachable, so the bundled fallback catalog is serving | [GAMES-SETUP.md](../database/GAMES-SETUP.md#7-step-4--restart-and-confirm) |
| `npm run audit:repo` reports 6 errors about `scores`, `subscriber_emails`, `ai_feedback` | three forward migrations have not reached the live database | [RUN-IN-ORDER.md §1b](../database/RUN-IN-ORDER.md#1b-if-the-audit-reports-missing-tables) |

---

## 🚨 Panic button: roll back (do this FIRST when the whole site is down)
Don't debug under pressure. **Get back to "working," THEN fix the bug.**
- **Render → Deploys** → pick a previous working deploy → **"Redeploy"**.
- Site returns to how it was minutes ago. Now fix calmly.

---

## ❌ Never do these (so you can't cause a disaster)
- Don't commit/push your **`.env`** file (secret keys). It's already ignored — keep it that way.
- Don't delete/rename **database columns or tables** in Supabase without asking Claude first — that can wipe data.
- Don't push straight to live when unsure — test locally (Step 4) first.
- **Don't `import` a script from `tools/`** to "just read a function out of it."
  Several of them write to the live database on import. They are guarded now
  (`tools/_is-main.mjs`, enforced by `test/tool-safety.test.mjs`), and that guard
  exists because an import once ran a full migration against production.
- When in doubt, ask **before** doing something you can't undo.

---

## 💬 How to ask Claude so it's fixed in ONE go
Give these four things (rough is fine):
1. **What you did** — "I clicked the Vibe Finder button"
2. **What you expected** — "it should show games"
3. **What actually happened** — "it spins forever"
4. **The red Console error** (Step 2) — paste it, or a screenshot.

A screenshot of the screen with the Console open is the gold standard.

---

## 📌 Your project's quick facts

- **Start locally:** `npm start` → http://localhost:8080
- **Live host:** Render (auto-deploys when you push to GitHub)
- **Node:** 22+ — no build step, the source is what runs
- **Database:** Supabase. Main tables: `games` (+ the `games_public` view),
  `scores`, `recommendations`, `game_stats`, `feedback`, `subscriber_emails`,
  `ai_feedback`, `keepalive`, and the four `admin_*` tables
- **Schema source of truth:** `db/` — `supabase/migrations/` is **generated**
  (`npm run sync-migrations`), never hand-edited
- **Cache trick:** every CSS/JS link ends in `?v=YYYYMMDD`. When a change won't
  show up even after a hard refresh, that number probably needs bumping

### Which log prefix means what

| Prefix | Subsystem |
|---|---|
| `[cron:…]` | a scheduled job — the name after the colon is the job |
| `[masqr]` | the mirror gate — a warning here means it is **not** enabled (§3c) |
| `[egress]` | proxy egress policy. `WARNING:` on this prefix means a restriction was **widened** (§3d) |
| `[singbox]` | the optional outbound tunnel |
| `[kasm]` | an external companion desktop |
| `catalog refreshed from Supabase: N games` | the 30-minute catalog reload — a healthy heartbeat |

The boot banner also prints one `→ ` line per subsystem (`→ masqr:`,
`→ egress:`, …). That banner is the fastest way to see what is actually switched
on in a running deployment.
