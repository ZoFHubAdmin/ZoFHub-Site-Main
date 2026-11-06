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

## Step 3b — Embeds, thumbnails or assets fail? Check the sing-box path

Anything the **server** fetches for a visitor — the `/embed/<slug>` wrapper,
thumbnails, game assets, the hourly link check — goes out through the sing-box
daemon or is refused. There is no direct fallback, so when the daemon is down the
symptom is a failed fetch, not a slow one. The log line behind it reads
`sing-box egress unavailable and direct egress is refused: …` (error code `EEGRESS`).

Check, in this order:

1. **Is the daemon there?** `npm run singbox:install` downloads the pinned,
   SHA-256-verified binary into `.singbox/`. On a fresh clone it is simply not
   installed yet, and the supervisor says so once and stops retrying.
2. **What does the server think?** The admin console's **Egress** view
   (`/api/admin/egress`) shows the daemon, its supervisor (running, restarts,
   last exit), how many fetches were carried and how many were **refused**, and
   whether the egress guard has blocked anything.
3. **The boot log.** `[egress] enforced: …` is the normal line. `[egress]
   DEVELOPMENT: direct egress is PERMITTED` means a developer opt-out is active
   (it is never honoured in production). `[singbox] supervisor: not started
   (<reason>)` says why the daemon is not running.

On a development machine only, `SINGBOX_ALLOW_DIRECT=1` in `.env` lets fetches go
out directly while you are not working on the egress path. Full detail:
[docs/proxy/SINGBOX.md](../proxy/SINGBOX.md).

> A refusal that names a private, loopback or metadata address is a different
> thing: the SSRF defence in `lib/safe-fetch.mjs` refused it on purpose.

---

## Step 3c — The AI says "does not accept requests from localhost"? Change the address, not the code

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

## Step 3d — Puter.js never shows a sign-in screen, or answers "Unauthorized"

Puter is the visitor's **own account**, so the AI page needs a sign-in (or sign-up)
window before the first message. Pick **Puter.js** in the sidebar and the panel
under the switcher says whether you are signed in and offers a **Sign in to Puter**
button; sending a message while signed out starts the same sign-in first.

If nothing opens, work down this list:

1. **Allow pop-ups for the site.** Puter's sign-in is a separate window. If the
   browser blocks it, the SDK shows its own *Continue / Cancel* dialog — press
   **Continue**. The panel also says in words when a window was blocked.
2. **Check what the SDK thinks it is.** In the browser console, type `puter.env`.
   It must say `web` (or `app`/`gui`). `nodejs` means something on the page defined
   a global `process` object before the SDK loaded, so it concluded it was running
   in Node.js and never opens a window — the request then goes out with no account
   and Puter answers `401 Unauthorized`. `ensurePuter()` hides `window.process` for
   the SDK's first load, so seeing `nodejs` again means a script is re-creating it
   *during* that load; look for a polyfill or a browser extension.
3. **Reload once.** The SDK decides its environment once per page load and cannot be
   loaded a second time on the same page (it registers a custom element that cannot
   be registered twice), so a repaired page needs a fresh load.
4. **Private windows and blocked site data** can stop Puter remembering you, in
   which case you are simply asked to sign in again.

Details: [AI-ARCHITECTURE.md → The second provider: Puter.js](../features/AI-ARCHITECTURE.md#the-second-provider-puterjs).

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
> forever.
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
| No ads anywhere | every network is off until you enable one — and `/gameflare` and `/donate` never carry ads | [ADVERTISING.md](../features/ADVERTISING.md) |
| `/browser` returns 404 | the proxy browser was removed on purpose — there is no such page | [HOW-IT-WORKS.md §9](HOW-IT-WORKS.md) |
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
| `[egress]` | the egress policy (§3b). `DEVELOPMENT: direct egress is PERMITTED` means the fail-closed rule was opted out of (never honoured in production) |
| `[egress-guard]` | the process-level backstop. `BLOCKED direct tcp connection to host:port (from file:line)` means something tried to connect out without crossing sing-box — a finding, not noise (docs/proxy/SINGBOX.md §0e) |
| `[singbox]` | the outbound tunnel every server-side fetch crosses |
| `catalog refreshed from Supabase: N games` | the 30-minute catalog reload — a healthy heartbeat |

The boot log prints one `[prefix]` line per subsystem (`[egress]`, `[singbox]`,
`[ads]`, …). Reading it is the fastest way to see what is actually switched on in
a running deployment.
