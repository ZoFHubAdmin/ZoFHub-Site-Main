# How ZoFHub Works — plain-English guide

This explains the whole site in simple terms, part by part. No prior knowledge
needed. Think of the site as **one program (`server.js`) that hands web pages to
visitors, plus a database (Supabase) that remembers all the games and scores.**

---

## The big picture (how a visit flows)

1. Someone opens your site → their browser asks your **server** for a page.
2. The **server** (`server.js`) sends back the HTML/CSS/JS files in `public/`.
3. The page's JavaScript asks the server for data (e.g. "give me games") via
   **API endpoints** like `/api/games`.
4. The server reads that data from **Supabase** (your database) and sends it back.
5. The browser draws the game tiles, and when you click one it loads the game in
   an **iframe** (a little window showing the game from its original site).

That's it. Everything below is just detail on each piece.

---

## The pieces, one by one

### 1. `server.js` — the brain (always running)
A single long-running program (built with **Express**). It:
- Serves every page and file under `public/`.
- Answers API requests (`/api/games`, `/api/scores`, `/api/ai/...`, etc.).
- Builds each game page (`/play/<game>`) and category page on the fly.
- Runs the AI proxy, the game proxy, and (when enabled) the web-proxy tunnel.
- **Must stay running 24/7** — that's why it goes on Render/Railway, NOT Vercel.

### 2. Supabase — the memory (the database)
A hosted Postgres database. The main tables:
- **`games`** — every game (`slug` = short name, `title`, `game_url` = the
  game's address, `thumbnail_url` = its picture, `category`, `is_working`).
- **`scores`** — leaderboard entries (one best score per player per game).
- **`recommendations`** — community "you should add this" submissions.
- **`game_stats`** — play counts, so they survive restarts.
- **`keepalive`** — a one-row heartbeat that stops a free-tier DB from pausing.
You set these up by pasting the files in `db/` into Supabase's SQL Editor,
**in order** (see `db/RUN-IN-ORDER.md`): `schema.sql` (games) →
`community.sql` (scores + recommendations) → optional `stats.sql` + `keepalive.sql`
→ then the numbered `load-*.sql` game loaders (split into small `-partNN.sql`
files so the editor saves them reliably; each prints a running count as proof it
saved). Or just run `npm run restore-games` to load every source at once.

### 3. The catalog (the list of games shown on the homepage)
- On startup the server loads **all working games into memory** (a fast in-memory
  copy called `CATALOG`), and refreshes it from Supabase every 30 minutes.
- The homepage asks `/api/games?limit=...&offset=...` and the server slices that
  in-memory list. (So to change what shows on the homepage, you change the data
  in Supabase, not the page.)
- `spreadCatalog()` mixes the Y8 games evenly through the list so one big batch
  doesn't clump at the top.

### 4. The pages (what the visitor sees) — in `public/`
- `index.html` — homepage grid (built by `js/catalog.js`).
- `game.html` — the template for every `/play/<game>` page (the player + the game
  iframe + leaderboard). Filled in per-game by the server.
- `ai.html` — the AI assistant chat (`js/ai.js`).
- `community.html`, `leaderboard.html` — community + global high scores.
- `browser.html` / `gust/` — the proxy browser (only on the proxy deployment).
- `css/` styles, `js/` behavior. `js/layout.js` runs on every page (header,
  footer, mobile menu, ads).

### 5. Playing a game (and the "no more black screen / refresh" fix)
When you click a tile you go to `/play/<game>`. The game shows inside an
**iframe** (a framed window pointing at the game's real home, e.g. y8.com).
- The iframe is loaded by `js/game-page.js`. The important fix: the page now
  **waits to know the game is loading before it shows it, and hides the loading
  screen the instant the game's frame loads** — so the game is playable right
  away with no need to refresh or tap repeatedly. While it boots you see a
  blurred picture of the game (branded), never a flat black screen.
- If a game's original site refuses to be framed, the page automatically retries
  through the server's **game proxy** (`/embed/<game>`) so it still loads.
- (Browsers cache code, so when you change `js`/`css` you bump the `?v=` number
  in the HTML — that forces everyone to download the new version.)

### 6. The AI assistant
- Uses **Pollinations** (a free AI service). But the browser never talks to it
  directly — it asks **your** server (`/api/ai/text` and `/api/ai/image`), and
  your server talks to Pollinations and relays the answer. This "masks" the AI so
  networks only ever see traffic to your own site.

### 7. The proxy browser (the risky/optional part)
- `browser.html` + the `gust/`, `/uv/`, `/scram/`, `/wisp` pieces let a user
  browse other sites through your server. This is the "unblocked at school"
  feature. It's powered by open-source proxies (credited in `CREDITS.md`).
- Mainstream ad networks (like Google AdSense) reject anonymizer/proxy sites,
  which is why ZoFHub uses a fixed list of five alternative networks (see Ads
  below). Advertising runs on the hub pages only — never on the proxy itself.

### 8. Ads
- **Five networks are supported and no others:** HilltopAds, Adsterra, Monetag,
  Ad-Maven, PopAds. Each is enabled independently with
  `<NETWORK>_ENABLED=1` plus a `<NETWORK>_SCRIPT` or slot tag. Enabled without
  configuration renders nothing, and unset means genuinely nothing — no boxes, no
  reserved space, no requests.
- **Google AdSense is never used** and is refused at three layers. Google bans
  proxy domains at the *account* level, so one stray tag could take down an
  unrelated account.
- **Ads never run on the proxy.** `/browser`, `/gust` and every proxy asset route
  are excluded structurally — in the registry, in the API, and in the client. What
  renders there is somebody else's website, and monetising it would mean injecting
  script into third-party content in transit.
- **No network has approved this site.** All five require review of your specific
  domain. See [`docs/ADVERTISING.md`](docs/ADVERTISING.md) for the compliance
  matrix and what still needs verifying.
- (In-game ads inside the games are handled by the game makers —
  GameMonetize/GameDistribution — and pay you separately.)

### 9. The background jobs (`lib/cron-jobs.mjs`) — the night shift
Seven tasks the server runs on a schedule, so the catalog stays healthy without
you touching it:
- **link-check** (hourly) — hides games whose link is truly dead (404/410).
- **grow** — adds new verified games over time.
- **y8-sync** (weekly) — re-scrapes Y8's embed directory and refreshes the games.
- **scores-prune** (daily) — trims the leaderboard to the top 200 per game so the
  database can't balloon.
- **keepalive** (daily) — writes a heartbeat row so a free-tier Supabase project
  never hits its inactivity pause.
- **health** + **rec-cleanup** — housekeeping.

### 10. One deployment — always a proxy site
ZoFHub deploys **once**, as a single always-on proxy site (the web proxy is never
turned off). There is no hub/AdSense mode: because the proxy is always running,
Google/AdSense can't be used, and monetization is entirely via the proxy-friendly
networks in section 8. If you ever scale to more than one replica, they share one
database, so set `CRON_DISABLED=1` on every replica except one. See `render.yaml`
and `GO-LIVE.md`.

---

## The folders at a glance
- `server.js` — the program.
- `public/` — everything the visitor downloads (pages, styles, scripts, images).
- `lib/` — server helper modules (Supabase access, cron jobs, caching, Y8 ingest).
- `db/` — the SQL you paste into Supabase to set up the database.
- `tools/` — one-off scripts you run by hand (audits, the SQL generator, etc.).
- `data/` — config like `catalog-overrides.json` (hide/patch/add games without
  touching the database).
- `y8-games.json` — the scraped list of Y8 games (one source for the
  `db/load-*.sql` loaders, generated by `tools/generate-sql-from-json.mjs`).

## When you change something, how do you see it?
- Changed a **page/style/script** in `public/`? Restart the server (or redeploy)
  and **hard-refresh** the browser (Ctrl+Shift+R). The `?v=` bump forces it.
- Changed the **games**? Update Supabase (or run the SQL), and the catalog
  refreshes within 30 minutes (or on restart).
