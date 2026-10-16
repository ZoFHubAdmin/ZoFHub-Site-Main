# Community game requests

> **A request is a request.** A row in `public.recommendations` creates no game,
> triggers no import and grants no visibility. Additions go through the admin
> console and the catalog freeze — which is exactly what the disclosure beside
> the form tells the submitter.

---

## 1. One taxonomy, both sides

The genre list used to be **ten `<option>` elements written directly into
`public/community.html`**, while the server independently accepted *any
40-character string* as a category. Two consequences:

- the menu and the validation could not agree, because neither knew about the
  other — the server would have happily stored `"Platfromer"`;
- adding a genre meant editing markup, which is why it had not been done.

The list now lives in **one file**,
[`public/js/recommendation-taxonomy.js`](../../public/js/recommendation-taxonomy.js),
imported by the browser to **render** the form and by the server to **validate**
what comes back. This is the same arrangement `public/js/ai-prompt.js` already
uses for the AI system prompt, and for the same reason: an allow-list enforced on
one side only is a suggestion.

It is **data, not markup** — each entry is `{ id, label }`. Renaming a label is
safe; changing an id is a migration, which is the right way round.

### The 24 genres

Action · Adventure · Arcade · Platformer · Puzzle · Racing · Sports · Strategy ·
Simulation · Role-playing / RPG · Shooter · Fighting · Survival · Horror ·
Multiplayer · Casual · Idle / Clicker · Rhythm / Music · Card / Board ·
Educational · Creative / Sandbox · Retro / Classic · MMO / IO · **Other**

`other` is deliberately **last**, because it is the escape hatch and should read
as one.

---

## 2. The rules about the choice

| Rule | Why |
|---|---|
| **Up to 3 genres**, as checkboxes | A game can genuinely be a puzzle *and* a platformer. The single-choice menu this replaces forced a false pick. At the cap, the unchosen boxes are **disabled** so the limit is visible rather than discovered by having a submission refused. |
| **`other` requires an explanation** | "Other" with no explanation is the one combination that carries no information at all, so it is the one thing refused outright. |
| **Unknown ids are dropped, not fatal** | A submission naming two real genres and one typo is a usable submission; refusing the whole thing would lose a contribution over a spelling. |
| **Validated with the same function on both sides** | The message a submitter sees in the browser is the message the server would have given them — just without the round trip. |

`category` is **kept and still written**, set to the first chosen genre, so every
existing row and every existing reader of that column keeps working.

---

## 3. Free text is never markup

`cleanText()` is exported and used by **both** sides, because two
implementations of "what counts as safe text" is how one of them ends up more
generous than the other. It removes:

- C0 control characters and DEL,
- the zero-width and bidi marks (`U+200B`–`U+200F`), the bidi overrides
  (`U+202A`–`U+202E`) and the line/paragraph separators (`U+2028`, `U+2029`) —
  these are the characters that let one submission disturb the rendering of every
  row around it,
- `<` and `>`, because nothing here is ever markup.

Then it collapses whitespace and bounds the length.

---

## 4. What the submitter is told, and when

`DISCLOSURE` is **one constant**, rendered in both places it is promised:

1. **beside the submit button**, where it is read at the moment of use;
2. **in the confirmation**, because the instant a submission succeeds is exactly
   when somebody is most likely to believe their game is now being added.

> Game requests are suggestions, not guarantees. ZoFHub cannot add every
> requested game. Requests are reviewed based on licensing and permissions,
> safety, technical compatibility, quality, performance, maintenance
> requirements, and catalog capacity. The catalog is intentionally limited, and
> only authorized administrators can approve additions.

The confirmation deliberately does **not** say "Posted!" alone — that reads as
"it is being added". It says the request was received and is waiting for review.

A test asserts the prose is **not** duplicated into the HTML, so the two cannot
drift into saying different things.

---

## 5. Fields

| Field | Notes |
|---|---|
| Game name | required |
| Embed link | required; must be an **https** URL on a supported host (GameDistribution, OnlineGames.io, GameMonetize, HTMLGames, or a `y8.com/embed/…` link) |
| Official game URL | optional, and **distinct** from the embed link |
| Category | 1–3 genres from the shared list |
| Other explanation | required when `other` is chosen |
| Why do you recommend it? | optional |
| Anything else? | optional — controls, age suitability, known issues |
| Your name | defaults to this device's player name |

### URL safety, beyond the host allow-list

`recHostOk()` checks the host is a known portal — that is an **allow-list, not a
safety check**. `checkUrlSafety()` catches the shapes an allow-list alone does
not:

- credentials embedded in the URL (the `https://trusted.com@evil` phishing form),
- addresses that resolve inside our own infrastructure, including the cloud
  metadata endpoint,
- encoded IPv4 literals like `2130706433`, which read as a hostname to a string
  check and as `127.0.0.1` to a resolver.

### Duplicate detection

Matching on **provider identity** rather than on `embed_url` equality, because a
plain `WHERE embed_url = ?` treats the same game on a different partner
subdomain as new. An exact match is refused with the existing slugs; a
**title-only** match is accepted and flagged, because two different games really
are both called "Bubble Shooter" and rejecting on a name collision would lose
real games.

---

## 6. Migration safety

`db/18_recommendation_taxonomy.sql` is **additive**: `genres text[]`,
`other_text`, `official_url`, `extra`, plus CHECK constraints and a GIN index for
moderators filtering by genre. Nothing is dropped and nothing is rewritten.

Both the insert and the list **retry without these columns** when the migration
has not been applied, so deploying the code first degrades to the old shape
rather than rejecting submissions or showing an empty page. The card renderer
falls back from `genres[]` to the legacy `category` for older rows.

---

## 7. Related

- `public/js/recommendation-taxonomy.js` — the list and the rules
- `test/recommendation-taxonomy.test.mjs` — including the tests that prove
  neither side has grown its own copy
- [CATALOG-FREEZE.md](CATALOG-FREEZE.md) — why a request cannot become a game by
  itself
