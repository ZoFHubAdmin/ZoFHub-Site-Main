# Y8 embeddable games — the standalone scraper

> **You usually don't need to run this by hand.** The live site keeps Y8 fresh on
> its own: the weekly **`y8-sync`** cron job (`lib/y8-ingest.mjs`) re-scrapes Y8's
> embed directory and upserts the games into Supabase. This standalone scraper
> (`scrape-y8.js`) is here for **manual / one-off** harvesting or debugging.

Everything comes from Y8's **official embed directory**
(`y8.com/games_for_your_website`), the sanctioned way to put Y8 games on your own
site via `<iframe>`. Every game exposes a stable embed URL:

```
https://y8.com/embed/<slug>
```

## Run the scraper

```bash
npm run y8-scrape                 # full catalog -> y8-games.json
node scrape-y8.js --pages 5       # just the first 5 pages
node scrape-y8.js --out games.json
```

No extra install needed (uses built-in `fetch` + regex). It self-detects the page
count, walks every page of the embed directory, dedupes across pages, and
backfills any missing thumbnail from the game's own page. A short delay between
requests keeps it polite — a full run takes a few minutes and yields a couple
thousand games.

Output shape (`y8-games.json`):

```json
{
  "name": "Cube Run",
  "slug": "cube_run",
  "embedUrl": "https://y8.com/embed/cube_run",
  "thumbnail": "https://cdn2.y8.com/cloudimage/397267/file/w380h285_webp-….webp",
  "gamePage": "https://www.y8.com/games/cube_run"
}
```

To turn a fresh `y8-games.json` into Supabase loader SQL, use the catalog SQL
generator (`node tools/generate-sql-from-json.mjs`) — see [GAMES-SETUP.md](GAMES-SETUP.md).

## Embedding — iframe only, never link out

The game is rendered **only** through `<iframe src=embedUrl>`. The thumbnail is
just an image; clicking a card opens the in-site iframe player (modal / route),
never a link out to y8.com.

```jsx
<iframe
  src={game.embedUrl}
  title={game.name}
  width="960" height="600"
  style={{ border: 0 }}
  allow="fullscreen; autoplay; gamepad"
  allowFullScreen
/>
```

## Caveats worth knowing

- **Verify before publishing.** A handful of older slugs 404 or get pulled. The
  scraper only lists what's currently in Y8's live embed directory, but the
  hourly link-checker also hides any game whose URL later goes dead.
- **Y8 keeps its own branding/ads inside the iframe** — that's the trade for free
  embedding. If you monetize the hub, skim Y8's publisher terms (`y8.com/terms`).
- **`X-Frame-Options`:** embed URLs are meant to be framed. If any specific game
  refuses to load in your frame, drop it rather than working around it.
