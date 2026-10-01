# Suroi — self-hosted, GPL-3.0

ZoFHub used to show Suroi by putting `https://suroi.io/` in an `<iframe>`. That
framed the developers' own live commercial site — their servers, their traffic,
their ads — with no licence behind it. That row is **removed**.

Suroi itself is free software, so it can be hosted properly instead. The kit for
doing that is [`suroi/`](../../suroi/) — a `Dockerfile` and a hardened
`config.json`. This document explains it.

---

## What Suroi is, and why it is not like the other 12,000 games

Every other game on ZoFHub is a static bundle a distributor licenses you to put
in an iframe. **Suroi is not that.** It is:

- a **client** — TypeScript + Svelte + PixiJS, built with Vite
- a **game server** — a stateful, always-on Bun process holding live games in
  memory and talking WebSockets (`maxGames: 5`, `maxPlayersPerGame: 80`)

Both halves must run. Upstream serves production behind NGINX.

**Read this before deploying:** a self-hosted battle royale has **its own player
pool, and yours starts empty.** suroi.io is fun because thousands of people are
on it. Your instance would be one person alone on the map until you have real
traffic. That is a product decision, not a licensing one — but it is the reason
most sites link to suroi.io rather than host it.

---

## Licence: GPL-3.0

Verified against the source, not assumed:

| Where | What it says |
|---|---|
| `LICENSE` | full GNU GPL v3, 29 June 2007 |
| `package.json` | `"license": "GPL-3.0"` |
| `client/package.json`, `server/package.json` | `"license": "GPL-3.0"` |
| separate asset licence | **none** — one LICENSE at the root covers code and assets alike |

### What that obliges you to do

GPL obligations attach on **conveying** the program. Serving the built client to
a visitor's browser *is* conveying it, so these apply the moment you deploy:

1. **Keep every copyright and licence notice intact.** Do not strip headers out
   of the source or the build.
2. **Offer the corresponding source.** GPL-3.0 §6(d) lets you satisfy this with
   a network URL, which is why `SUROI_COMMIT` (below, and in the Dockerfile) is exact rather than a
   branch name — "we built from `main`" is not a source offer.
3. **If you modify anything, your modified version is also GPL-3.0**, must say
   it was changed and when, and its source must be offered the same way. Push
   your fork publicly; a private repo does not satisfy §6.
4. **Attribute it.** Suroi is by HasangerGames. Credit is on `/credits`.

### What it does *not* oblige you to do

**ZoFHub does not become GPL.** Suroi runs as a **separate program** in its own
container, reached over the network. GPL-3.0 §5 calls that mere aggregation, and
aggregation does not propagate the licence. This stays true only while the
boundary holds — so:

> **Never import Suroi code into ZoFHub's `server.js`, `lib/` or `public/js/`.**
> Doing that would build a combined work and would put the entire ZoFHub
> codebase under GPL-3.0.

An iframe or a link across a network boundary is fine. A shared build is not.

---

## Pinned upstream

```
repo    https://github.com/HasangerGames/suroi.git
commit  85df5067b19a876cac4304232cc1e68ff1b07c7f
dated   2026-08-02
version 0.30.5
```

[`suroi/Dockerfile`](../../suroi/Dockerfile) clones that exact commit. Nothing is vendored into this repo,
which keeps ~91 MB of upstream source out of ZoFHub's git history and makes the
source offer in §6(d) trivially honest: it is upstream's own repository, at a
commit that pins what you actually built.

If you change Suroi, that stops being sufficient — fork it publicly, point
`SUROI_REPO` at your fork, and set `SUROI_COMMIT` to your commit.

---

## Deploying

Suroi needs **Bun**, a build step, and a persistent process. ZoFHub is Node with
no build step. They do not share a runtime, so this is a **second service**, not
an addition to the existing one.

```sh
docker build -t suroi ./suroi
docker run -p 8000:8000 suroi
```

On Render: a separate **Docker** web service with `./suroi/Dockerfile` as the
root. It must be on a paid instance — a free instance spins down when idle, and
a game server that sleeps drops every live match.

### Before it faces the internet

`server/config.example.json` ships **plaintext passwords for privileged roles**
(`developr`/`developr`, `administratr`/`administratr`, and eleven more, several
with `isDev: true`). Those are upstream's local-development defaults. Deploying
them unchanged hands admin to anyone who has read the public repo — which is
everyone. [`suroi/config.json`](../../suroi/config.json) removes the entire `roles` block; add
back only roles you need, with real secrets injected at runtime, never committed.

---

## Turning the catalog row back on

The `suroi` row is currently blocked by host in
[`data/catalog-overrides.json`](../../data/catalog-overrides.json). Once your
instance is live, replace the block with an `add` entry pointing at **your own**
hostname:

```json
{ "slug": "suroi",
  "title": "Suroi",
  "game_url": "https://suroi.yourdomain.com/",
  "category": "io-games" }
```

Leave the `hostIncludes: "suroi.io"` rule in place — that one exists to stop the
upstream site being framed again, and it should outlive this.

---

## Status of this kit

**Untested.** Bun is not installed on the machine this was written on, so the
Dockerfile has not been built or run here. It follows upstream's documented
install/build/start commands (`bun install` → `bun run build:client` →
`bun start`) and their stated NGINX production model. Expect to adjust the
static-serving and WebSocket wiring for your host before it works end to end.
The licence analysis above *is* verified — it was read from the source.

---

**Related:** [documentation map](../README.md#-documentation) · [licensing and credits](../CREDITS.md) · [how the catalog decides what is served](../database/GAMES-SETUP.md)
