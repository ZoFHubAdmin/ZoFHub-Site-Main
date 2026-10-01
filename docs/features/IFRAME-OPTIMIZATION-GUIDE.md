# How game embeds load — the iframe loader

Every game on ZoFHub runs in a cross-origin `<iframe>` pointed at its publisher's
official embed URL. This document explains how that frame is loaded, why the
timings are what they are, and which bugs each decision exists to prevent.

**Source:** [`public/js/iframe-loader-optimized.js`](../../public/js/iframe-loader-optimized.js),
driven by [`public/js/game-page.js`](../../public/js/game-page.js).

> ⚠️ **This document was rewritten on 2026-09-21.** Earlier versions described a
> 4-second timeout, a 3-attempt retry and a 15-second ceiling. **Those numbers
> were replaced in the code and the document was never updated** — the timings
> below are read from the source constants. If you remember "4 seconds", that
> memory is from the version that caused the bug described in §2.

---

## 1. The constants (the whole configuration)

| Constant | Value | What it governs |
|---|---:|---|
| `MAX_RETRIES` | **2** | full-chain restarts before the error card |
| `PROXY_TIMEOUT` | **15 s** | each `/embed/<slug>` stage |
| `DIRECT_TIMEOUT` | **25 s** | the direct-publisher stage |
| `PREFLIGHT_TIMEOUT` | **3 s** | the `/api/frame-check` HEAD probe |
| `OPTIMISTIC_REVEAL` | **2.5 s** | when the overlay comes off regardless |
| `NET_TIMEOUT` | **35 s** | overlay safety net — must exceed any single stage |

These are **last-resort fallbacks, not the happy path.** The iframe's own `load`
event reveals the game the instant it is genuinely ready, which for most games is
well under a second.

---

## 2. Why the timeouts are generous now (the bug that changed them)

The original loader used a 4-second stage timeout. That is shorter than a healthy
heavy WebGL title takes to fire its outer `load` event — 5 to 12 seconds is
routine, because these publishers preload an entire game engine before the event
fires.

So the loader would give up on a game that was loading perfectly, tear the frame
down, and start it again from zero. The game never got far enough to appear, and
the cycle repeated: **the "it keeps trying and never loads" bug.**

There is also no upside to failing fast here. The proxy strips `X-Frame-Options`,
so there is no "blocked by the publisher" case that a short timeout would detect
early. Waiting costs nothing and fixes the failure.

`DIRECT_TIMEOUT` (25 s) is even more generous for a second reason, described next.

---

## 3. `directOnly` — the publishers that must never be proxied

**GameMonetize and GameDistribution black-screen when proxied.** Their SDK cannot
pull its assets through `/embed`, so the frame sits at `LOADING 0%` forever.

The server never proxies them, and the loader must not either. `directOnly`
carries that fact to the client, and `buildStages()` skips every proxy stage when
it is set.

This is why the direct timeout was raised from 12 s to 25 s: on a slow school
connection, a 12-second budget was a coin-flip, and **when it lost, the loader
"recovered" by switching these publishers to the proxy — which black-screens
them.** A false timeout did not just delay the game, it broke it. The generous
budget makes that impossible.

---

## 4. The stage chain

```
directOnly = false                      directOnly = true
─────────────────────────               ─────────────────────────
1. /embed/<slug>          15 s          1. publisher URL      25 s
2. /embed/<slug>?ua=1     15 s
3. /embed/<slug>?ua=2     15 s
4. publisher URL          25 s
```

`?ua=1` and `?ua=2` re-request through the proxy with different user-agent
strings, for publishers that vary their framing rules by client.

After the last stage, the chain restarts — up to `MAX_RETRIES` (2) times — and
then shows the error card.

---

## 5. The optimistic reveal (the most important behaviour)

A cross-origin iframe fires its `load` event **long after the game is actually
interactive** — and many cross-origin games never fire one we can observe at all.
Waiting for it leaves a "Loading…" overlay sitting on top of a game the visitor
could already be playing. That was the **"it keeps saying loading"** bug.

So the overlay comes off after **2.5 seconds regardless**:

```
t=0      frame src set, overlay shown
t=2.5s   overlay fully hidden — the game is visible whether or not `load` fired
t=?      `load` fires → finish() → timers cleared
```

The always-visible notice bar under the frame is what offers **Reload** if a game
is genuinely stuck. That is a better answer than a spinner, because the spinner
cannot tell the two cases apart and the visitor can.

### The consequence: a stage timeout must not reload a revealed frame

```js
onStageTimeout() {
  if (this.loaded) return;
  if (this.revealed) { this.loader?.classList.add('hide'); return; }  // ← do NOT advance
  this.advanceStage();
}
```

Once the frame has been revealed, the game is almost certainly running — the
timeout only means *our* `load` event never arrived, which is normal
cross-origin behaviour. Advancing the stage here would reload a **working game**.
That is the "it restarts itself" bug.

A genuine load error still fails over, through `onError`.

---

## 6. Two timer bugs worth knowing about

Both were real, and both are the kind that come back if the distinction is lost.

**`clearTimers()` vs `clearStageTimer()`.** `armTimeout()` must clear *only* the
per-stage timer. An earlier version called the full `clearTimers()`, which also
wiped the reveal and net timers — so the overlay never came off and sat on top of
a game that had already loaded.

**Bound handlers are created once.** `this.onLoad.bind(this)` returns a *new*
function object every call, so `removeEventListener` with a fresh bind removes
nothing. The constructor binds once into `this._onLoad` / `this._onError` and
both registration and removal use those, so `destroy()` actually destroys.

---

## 7. What else the loader does

- **Resource hints.** `preconnect` and `dns-prefetch` links are injected for
  every stage origin plus the upstream, so DNS and TLS are already warm when the
  frame is created.
- **Preflight.** A 3-second `HEAD` to `/api/frame-check` detects an obviously
  dead URL before committing the frame to it.
- **`AbortController`.** The preflight is cancelled on any state change, so a
  pending probe never resolves into a stage that has already moved on.
- **`about:blank` is ignored.** Setting `src` fires a `load` for the blank
  document first; treating that as success would hide the overlay before anything
  had loaded.

---

## 8. Changing the timings

They are plain constants at the top of the file. Before shortening any of them,
read §2 and §3 — **every timeout in this file was lengthened to fix a bug, and
shortening it brings that bug back.** The failure mode is not "a slow game takes
longer", it is "a healthy game never appears".

If you do change them, keep the invariant:

```
NET_TIMEOUT  >  the longest single stage timeout
```

Otherwise the overlay safety net can fire while a legitimate stage is still
running.

---

## 9. Related

- [HOW-IT-WORKS.md §6](../guides/HOW-IT-WORKS.md) — where this sits in the request flow
- [GAMES-SETUP.md](../database/GAMES-SETUP.md) — loading the catalog these games come from
- `/api/frame-check` and `/embed/:slug` in [`server.js`](../../server.js) — the server halves
