# Visitor features — and exactly what each one remembers

The smaller features a visitor touches: identity, recommendations, the live
player count, the mirror-update list, feedback and the panic key. Each is short
to describe; together they are most of what the site knows about anyone, so this
page ends with a single table of what is stored, where, and for how long.

---

## 1. Identity — a generated name, no account

Every visitor gets a randomly generated player name and id on first load — for
example `SwiftFalcon1234` — saved in the browser's `localStorage` and reused
wherever a name is needed ([`public/js/identity.js`](../../public/js/identity.js)).

- **No sign-up, no password, no email.** There is nothing to register for.
- **It is device-local.** Clearing site data gives you a new name; another
  device has its own.
- On the leaderboard the name **prefills** the submit field and can be edited —
  see [LEADERBOARD.md](LEADERBOARD.md#2-proof-of-play).

---

## 2. "For You" and recommendations

Signals live **in your browser only** ([`public/js/signals.js`](../../public/js/signals.js)):

- games you opened, and games you starred;
- games you scrolled past without opening, so they stop coming back;
- roughly how long you played — only as *under 15 s*, *under 2 min* or *longer*,
  never an exact duration;
- your last few searches, and the last mood you typed into the Vibe Finder
  (forgotten after 45 minutes).

When the homepage or the Vibe Finder needs them, that list is sent **with that
one request** — `POST /api/for-you` for the homepage row, `POST /api/vibe` for a
mood search — used to order the results, and **not kept**. The homepage call is
a `POST` rather than a `GET` for two reasons: a history of 60 slugs does not
belong in a URL, and a `GET` would invite a CDN to cache one person's row and
serve it to everyone. The response is `no-store`.

A recommendation row is decoration. If anything inside it fails, the page shows
fewer tiles — never an error.

**The Vibe Finder calls no AI in production.** It maps a mood with a curated
index and ranks games deterministically
([`lib/vibe-engine.mjs`](../../lib/vibe-engine.mjs)). See
[AI-ARCHITECTURE.md](AI-ARCHITECTURE.md).

---

## 3. Game of the Day

One featured game, **the same for everyone all day**. A hash of today's UTC date
indexes into the popular, thumbnailed games, so it changes once per calendar day
and is stable across restarts and across visitors — no per-visit randomness.
`GET /api/game-of-the-day`.

---

## 4. Live presence — "N playing now"

The site-wide live count and the per-game "N playing now" badge
([`public/js/presence.js`](../../public/js/presence.js)).

```
every 2 s   POST /api/presence/beat  { sessionId, slug }  → fresh snapshot { total, games: { slug: n } }
pagehide    sendBeacon → leave
```

| Constant | Value | Why |
|---|---:|---|
| beat interval | 2 s | feels live, and stays well inside the TTL |
| `PRESENCE_TTL_MS` | 8 s | a tab that stops beating drops out |
| `PRESENCE_MAX_SESSIONS` | 20,000 | global memory bound; a full store refuses *new* sessions, never evicts live ones |
| per-address budget | burst 600, 200 / s | coarse flood limit, sized for a whole school NAT (`PRESENCE_IP_*`) |
| per-tab budget | burst 10, 1 / s | precise limit, keyed on the tab's own session id |
| sessions per address | 500 | tabs one address can have *counted* at once (`PRESENCE_MAX_SESSIONS_PER_IP`) |

**Short polling, not a long-lived `EventSource`.** A per-tab SSE connection holds
one of the browser's ~6 HTTP/1.1 connections open forever, so seven tabs
saturated the pool and starved the beats — the "count takes 8–11 s to update"
bug.

> **Changed 2026-09-26:** `GET /api/presence/stream` (the unused SSE endpoint)
> has been **removed**. It had no limit of its own, so any client could hold an
> unbounded number of connections against the process, and nothing called it.
> The store now lives in [`lib/presence-store.mjs`](../../lib/presence-store.mjs),
> and the snapshot is memoised so a beat no longer walks every session.

**Why two budgets, and why the per-address one is so high.** An earlier version
used a single shared per-IP bucket at ~5 beats/s. That was too tight for the
audience — a classroom of thirty tabs on one NAT beats 15/s, so two-thirds of
their beats were refused and the count flickered — and it was *shared* with every
other write endpoint, so a burst of beats quietly drained the feedback and score
limits. Now the per-address budget (200/s) serves a large NAT; the per-tab budget
(1/s, keyed on the random session id) stops one runaway tab without touching its
neighbours; and a **separate** cap on distinct sessions per address (500) is what
bounds fabricated players, since the generous address budget can no longer be
spent inventing them. Each endpoint has its own bucket, so no two can drain each
other ([`lib/rate-limit.mjs`](../../lib/rate-limit.mjs)). **Sharing one public IP
is not an edge case here — it is the school or library NAT this site is built
for.**

The `sessionId` is a random per-tab value. Sessions live in memory only.

---

## 5. The mirror-update list

Censorship insurance: **if this domain is blocked, an address collected today is
the only channel left to say where the mirror is.** `POST /api/subscribe`.

- **Only the address is stored.** No IP, no timestamp, no user agent
  ([`db/14_subscriber_emails.sql`](../../db/14_subscriber_emails.sql) — two
  columns). The rate limiter sees an IP, as it must, in memory, and writes it
  nowhere.
- **The response is deliberately uniform.** It never reveals whether an address
  was already on the list; the table is write-only to the public key precisely so
  nobody can enumerate it, and an "already subscribed" reply would hand that back
  one request at a time.
- **Mail provider optional.** With `RESEND_API_KEY` + `RESEND_AUDIENCE_ID` set,
  addresses are also added to a Resend audience. With neither set, the
  subscription still succeeds and the row is still stored, so nothing is lost by
  turning it on later.

> ⏳ The `subscriber_emails` table is **pending on the live project** — see
> [RUN-IN-ORDER.md §1b](../database/RUN-IN-ORDER.md#1b-if-the-audit-reports-missing-tables).

---

## 6. Feedback

The "Send feedback" dialog on every page (`POST /api/feedback`).

| Stored | Detail |
|---|---|
| message | 4–2,000 characters |
| kind, page | what it is about, and where it was sent from |
| email | **only if the visitor chooses to enter one** |
| `ip_hash` | a keyed hash, never the address — enough to spot one source filing forty, useless for identifying anybody |
| user agent | truncated to 300 characters |

**Private by design.** There is no `GET`: the RLS policy grants the public key
`INSERT` only, so it cannot read back even the row it just wrote. Messages are
read in the admin console.

---

## 7. The panic key

A top-right **Panic** button and a customisable hotkey (default **Ctrl + `**)
that instantly leaves the site ([`public/js/panic.js`](../../public/js/panic.js)).
Three modes:

| Mode | What happens |
|---|---|
| **cloak** | re-hosts the site inside a fresh `about:blank` tab and sends *this* tab to a safe page. Falls back to *redirect* if pop-ups are blocked |
| **redirect** | `location.replace()` to the chosen page |
| **overlay** | drops an iframe of the safe page on top of ZoFHub; the URL does not change |

Settings — mode, destination, hotkey — are saved in `localStorage`. The same
cloak system is built into the GUST proxy browser, which is one of GUST's two
declared modifications ([CREDITS.md](../CREDITS.md)).

---

## 8. What the site remembers about you

| What | Where | How long | Identifies you? |
|---|---|---|---|
| Generated name + id, favorites, recommendation signals, panic settings | **your browser** (`localStorage`) | until you clear site data | stays on your device |
| Interstitial frequency cap | your browser — one timestamp | until you clear site data | no — it contains nothing about you |
| Presence session | server **memory** | ~8 s after your last beat | no — a random per-tab id |
| Daily visitor tally (admin console) | server **memory** — a set of keyed IP hashes | dropped at UTC midnight and on every restart | no — cannot be walked back to an address |
| Play token (leaderboard) | server **memory** | single use, ≤ 6 h | no |
| Leaderboard score | database | top 200 per game; quarantined ones 7 days | a name you chose + a keyed IP hash |
| Feedback | database | until the operator deletes it | only what you typed; IP as a keyed hash |
| Mirror-update email | database | until removed | the address you volunteered — nothing else |
| AI feedback (thumbs) | database | 180 days | redacted before insert; consent recorded per row |
| AI prompts and replies | **never reach the server** | — | — |
| Pages you browse through the proxy | not logged by this code | — | see [INVISIPROXY.md §6](../proxy/INVISIPROXY.md#6-privacy) |
| Server access logs | your **host** (Render) | per the host's retention | may include your IP — outside this code's control |

The daily tally is what the admin console's "visitors today" shows. It is labelled
**"today, this instance"** because it is per-process and resets on deploy — it is
an operational counter, not analytics, and nothing about it leaves the process.

---

**Related:** [documentation map](../README.md#-documentation) · [the leaderboard](LEADERBOARD.md) · [the AI system](AI-ARCHITECTURE.md) · [the privacy page served to visitors](../../legal/privacy.html)
