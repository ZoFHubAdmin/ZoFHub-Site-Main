# Per-game SEO content — unique, factual, generated from the catalog

> Every `/play/<slug>` page carries a **unique description and complete SEO
> metadata**, built deterministically from the fields the catalog actually holds.
> No AI at request time, no fabrication, and no per-request database or network
> call.

| | |
|---|---|
| Module | [`lib/game-seo.mjs`](../../lib/game-seo.mjs) — pure, deterministic, no DOM/network |
| Rendered by | `/play/:slug` in [`server.js`](../../server.js) (memoised per origin on the cached game object) |
| Template | [`public/game.html`](../../public/game.html) placeholders: `{{SEO_TITLE}}`, `{{META_DESCRIPTION}}`, `{{CANONICAL_URL}}`, `{{JSON_LD}}`, `{{GAME_ABOUT}}` |
| Styling | `.game-about` in [`public/css/game-page.css`](../../public/css/game-page.css) |
| Tests | [`test/game-seo.test.mjs`](../../test/game-seo.test.mjs) |

---

## 1. What it produces

For every game, from its **title, category, tags and platform** — and nothing else:

- **A visible on-page section** (`About <game>`): a readable prose description, tag
  chips, and a details card (Category → links to the category page, Players, Price).
  Real HTML a reader benefits from, never a hidden keyword block.
- **A unique `<meta name="description">`** — ≤160 chars, names the game, no stuffing.
  (Previously every game shared one generic sentence.)
- **An SEO `<title>`** — `Game — Play Online | ZoFHub`, or just `Game | ZoFHub`
  when the title is already long.
- **`<link rel="canonical">`**, plus `og:url`, and `og:`/`twitter:` descriptions
  wired to the same unique text.
- **JSON-LD** (`schema.org` `VideoGame`): name, url, description, genre (the
  category), `applicationCategory`, `operatingSystem`, a free `offers` block and
  the `ZoFHub` publisher — **verified fields only**.

## 2. Grounded in metadata — it never invents facts

The generator states only what the catalog knows. It never fabricates a
developer, release date, rating, player count, story or control scheme. Two games
read differently because their **tags** differ ("2 Player, Basketball, Ragdoll"
vs "Platform, Parkour, Stickman"), not because a template shuffles synonyms.

Authority order, highest first:

1. **stored** — a substantive description the catalog already carries (≥60 chars,
   ≥10 words) wins and is returned verbatim (whitespace-collapsed, length-bounded).
2. **generated** — built from genre (category) + lead tags + a two-player line
   when a tag supports it + the category it belongs to.
3. **minimal** — a game with almost no metadata gets a short, honest, factual
   description and is marked `minimal`, so it can be flagged for review rather
   than padded with filler.

## 3. Safe and cheap

- **Untrusted content.** Every value is HTML-escaped where it lands in markup, and
  the JSON-LD payload escapes `<`/`>`/`&` so it can never break out of its
  `<script>` tag. Hostile titles/tags/descriptions render as inert text.
- **No per-request cost.** Generation is pure string work, memoised per origin on
  the in-memory game object, so a crawler or a visitor hitting a page never
  triggers AI or database work.

## 4. Where it plugs into the existing SEO surface

The site already had per-game `<title>`/Open Graph tags, a `robots.txt`, and a
full `sitemap.xml` (home, sections, every category, every game). This fills the
gaps that were missing: the unique description, canonical link, JSON-LD and the
visible description section.

## 5. Not yet built (honest scope)

The generation + rendering half is complete and tested. The **admin-side** tooling
the full spec describes is a follow-on and is **not** implemented yet: a per-game
SEO editor, bulk "generate missing / find duplicates" operations, an internal
quality score, a content-change audit trail, and an analytics panel. The data
model supports adding them later (the `source` marker — `stored` / `generated` /
`minimal` — is the hook a review queue would read).

---

**Related:** [AI architecture](AI-ARCHITECTURE.md) · [GameDistribution import](GAMEDISTRIBUTION.md) ·
[documentation map](../README.md#-documentation)
