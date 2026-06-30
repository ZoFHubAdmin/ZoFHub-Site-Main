# Y8 Embeddable Games — data + scraper

Everything here comes from Y8's **official embed directory**
(`y8.com/games_for_your_website`), which is the sanctioned way to put Y8 games
on your own site via `<iframe>`. Every game exposes a stable embed URL:

```
https://y8.com/embed/<slug>
```

## Files

- **`y8-games-starter.json`** — 135 games pulled directly (name, slug, embedUrl).
  `thumbnail` is `null` here; run the scraper to fill thumbnails in.
- **`scrape-y8.js`** — Node 18+ script that walks **all 46 pages (~3,400 games)**
  and outputs each game with `name`, `slug`, `embedUrl`, `thumbnail`, `gamePage`.

## Run the scraper (in Claude Code / your terminal)

```bash
node scrape-y8.js                 # full catalog -> y8-games.json
node scrape-y8.js --pages 5       # just the first 5 pages
node scrape-y8.js --out games.json
```

No npm install needed (uses built-in `fetch` + regex). It self-detects the page
count, dedupes across pages, and backfills any missing thumbnail from the game's
own page. A 700ms delay between requests keeps it polite — the full run takes a
few minutes.

Output shape:

```json
{
  "name": "Cube Run",
  "slug": "cube_run",
  "embedUrl": "https://y8.com/embed/cube_run",
  "thumbnail": "https://cdn2.y8.com/cloudimage/397267/file/w380h285_webp-….webp",
  "gamePage": "https://www.y8.com/games/cube_run"
}
```

## Embedding — iframe only, no `<a>` to the game

The game itself is rendered **only** through `<iframe src=embedUrl>`. The
thumbnail is just an image; clicking a card should open the iframe player in your
own UI (modal / route), never link out to y8.com.

```jsx
// GameCard.jsx — thumbnail opens an in-site iframe player, no outbound <a>
function GameCard({ game, onPlay }) {
  return (
    <button className="game-card" onClick={() => onPlay(game)}>
      <img src={game.thumbnail} alt={game.name} loading="lazy" />
      <span>{game.name}</span>
    </button>
  );
}

function Player({ game }) {
  return (
    <iframe
      src={game.embedUrl}
      title={game.name}
      width="960"
      height="600"
      style={{ border: 0 }}
      scrolling="no"
      allow="fullscreen; autoplay; gamepad"
      allowFullScreen
    />
  );
}
```

## A couple of caveats worth knowing

- **Verify before publishing.** A handful of older slugs 404 or get pulled. The
  scraper only lists what's currently in Y8's live embed directory, but spot-check
  before shipping.
- **Y8 keeps its own branding/ads inside the iframe** — that's the trade for free
  embedding. If you plan to monetize the hub, skim Y8's publisher terms
  (`y8.com/terms`) so you're on the right side of their commercial-use rules.
- **`X-Frame-Options`:** embed URLs are meant to be framed, but if any specific
  game refuses to load in your frame, drop it rather than working around it.
