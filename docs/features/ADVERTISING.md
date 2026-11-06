# Advertising — architecture, configuration and compliance

ZoFHub supports **six** advertising networks and no others, and each one owns
exactly **one** role:

| Network | Role | Renders | Variable(s) |
|---|---|---|---|
| **Ad-Maven** | `interstitial` | Full-screen unit between game launches — **at most once per visitor per 20 minutes** | `ADMAVEN_INTERSTITIAL_TAG`, `ADMAVEN_INTERSTITIAL_URL` |
| **ExoClick** | `display` | Header 728×90 (320×50 mobile) and sidebar 300×250 | `EXOCLICK_HEADER_TAG`, `EXOCLICK_SIDEBAR_TAG` |
| **HilltopAds** | `in-page-push` | In-page push notification, positioned by the network | `HILLTOPADS_PUSH_SCRIPT` |
| **Clickadu** | `preroll` | VAST video before a game's frame loads — game pages only | `CLICKADU_PREROLL_VAST` |
| **Mondiad** | `native` | Native widget below the "for you" game grids | `MONDIAD_NATIVE_TAG` |
| **PopAds** | `popunder` | Popunder — **desktop game pages only** | `POPADS_POPUNDER_TAG` |

Every network also takes `<NETWORK>_ENABLED` (required) and `<NETWORK>_ZONE`
(shown in the admin panel, renders nothing).

Google AdSense and Ad Manager are refused at three separate layers and must
never be enabled: a single stray Google tag could put an unrelated Google
account at risk, and none of the six networks needs one.

Source of truth: [`lib/ad-providers.mjs`](../../lib/ad-providers.mjs).

---

## ⚠ Read this before enabling anything

**No network has approved this site.** Every one of the six requires publisher
review of your specific domain, and this repository has no way to know the
outcome. The registry deliberately records every provider as `needs-approval`,
and a test fails the build if any entry ever claims otherwise.

Approval for one format does not imply approval for another. Check the format
you are enabling against your own account dashboard.

**This site's audience includes minors.** ExoClick and Clickadu in particular
sell adult demand alongside mainstream: register the site as **mainstream** and
exclude adult categories in every dashboard that offers the setting.

---

## The one-minute version

```bash
# 1. Enable a network (host dashboard, never a committed file)
EXOCLICK_ENABLED=1
EXOCLICK_HEADER_TAG=<the zone code ExoClick gave you, on one line>

# 2. Verify it will actually load
npm run check-ads

# 3. Confirm what is live
curl -s localhost:8080/api/admin/ads   # requires admin auth
```

Unset everything and the site runs ad-free with no empty boxes, no reserved
space and no requests. That is the default state and it is fully supported.

---

## Strict roles

A role renders **only its owner's code**. If the owner is disabled, or supplies
no value for its role, that placement goes dark — no other network fills in.

The earlier registry let any enabled network inherit a disabled owner's slots,
and every time that happened the site ran code the operator had not chosen for
that position: two scripts competing for one box, layout shift, and placements
some network's policy did not allow.

A variable outside a network's role — `EXOCLICK_FOOTER_TAG`,
`HILLTOPADS_SCRIPT`, anything for the retired `MONETAG_*` / `ADSTERRA_*`
networks, the pre-provider `PROXY_AD_SCRIPTS` / `PROXY_*_TAG` slot variables —
is **read by nothing**, and its **name** (never its value) is printed at boot,
in the admin panel and by `npm run check-ads`.

**Enabled without configuration renders nothing.** Both halves are required, so
a half-finished setup produces no empty boxes.

**Tags are credentials.** Anyone holding one can serve ads billed to your
account. They are never sent to the browser beyond the markup that must render,
never returned by the admin API, and never logged.

---

## Regional tags

With regions defined in `REGION_ROUTES` (see [lib/geo.mjs](../../lib/geo.mjs)),
any role variable can be overridden for one region by appending `__<REGION>`:

```bash
REGION_ROUTES=SOUTH_ASIA:IN,PK,BD,LK,NP,BT,MV;NORTH_AMERICA:US,CA
EXOCLICK_HEADER_TAG=<global zone>
EXOCLICK_HEADER_TAG__SOUTH_ASIA=<a zone tuned for South Asian demand>
```

Resolution is per field: a region gets its override where one exists and the
global value everywhere else, so a partial override never loses a placement and
a visitor in any region sees a filled placement whenever a global tag exists. A
network configured *only* for one region is active only there. The visitor's
country comes from the edge's country header (`GEO_COUNTRY_HEADER`, default
Cloudflare's `cf-ipcountry`) and is used for that one request; it is not
stored. The CSP covers the script origins of every region, not only the global
tags.

An override for a region that is not in `REGION_ROUTES` is reported as unread.

---

## Where advertising may appear

This is a compliance and security boundary, not a layout preference.

Ads render only on pages ZoFHub authored — the catalog, game pages, the AI page,
the community page, the leaderboard and the legal pages. The rule is
**deny-by-default**: a path that matches none of the entries in
**`NATIVE_SURFACES`** (`lib/ad-providers.mjs`) gets no ads at all, because a
route nobody classified is a route nobody reasoned about. `/donate` is
deliberately ad-free as well.

(This site once hosted a web-proxy browser, whose pages were other people's
websites fetched in transit and could never carry our advertising. The browser
is gone; the allow-list stays deny-by-default so nothing new is ever advertised
on by accident.)

It is enforced in two places:

1. **`isAdSurface()`** — an allow-list of native routes.
   **An unclassified route gets no ads.**
2. **`/api/site-config`** returns every ad field present and *empty* for a
   non-native surface. A request with no `?surface=` and no same-host Referer is
   no surface at all, and gets nothing. `layout.js` only ever mounts what that
   payload contains, so it cannot show an ad the server refused.

> **History.** Until this revision `/api/site-config` had two route handlers.
> The first always answered and never called `next()`, so the second — the one
> carrying the ad payload — never ran: configuring a network changed nothing on
> the live site, and every check still passed. There is now one handler, and a
> test counts them.

---

## Placements

| Placement | Size | Where | Network |
|---|---|---|---|
| Header | 728×90 / 320×50 mobile | Below the header, above content | ExoClick |
| Sidebar | 300×250 | Inside the category sidebar; hidden below 900px | ExoClick |
| Native | reserves 180px, grows with the widget | Inside `#featuredRow` and `#forYouRow`, below the grid, labelled **Sponsored** | Mondiad |
| Push | network-positioned | Page-level loader only | HilltopAds |
| Interstitial | full screen | Between game launches | Ad-Maven |
| Pre-roll | fills the game frame | Before the game loads | Clickadu |
| Popunder | none (behind the page) | Desktop game pages | PopAds |

**Never placed:** over game controls, over navigation, inside gameplay, over the
AI composer, or anywhere an ad could be mistaken for a site
control. Every fixed box reserves its size at creation time, so a late creative
cannot shift the page; an unset placement collapses to nothing.

The in-content banner positions that older builds declared (between homepage
rows, above/below the catalog, on category pages, below related games) have no
owner under the six-role matrix, so their containers were removed rather than
left hidden.

### Native widgets

Loaded only when the row they sit in is **visible and within 300px of the
viewport** (an `IntersectionObserver` on the row). `#forYouRow` stays hidden
until the device has play history, and a widget loaded into a hidden row would
be an impression nobody could see — which networks treat as invalid traffic.

### The between-games interstitial

`mountInterstitial()` in `public/js/ad-slots.js` binds one delegated listener to
game-launch links. Four rules, all enforced in code and asserted in tests:

1. **The player always reaches the game.** Every exit navigates; a 15-second
   failsafe navigates even if the creative hangs.
2. **A deliberate navigation is never stolen.** Modified clicks and
   `target=_blank` links pass straight through.
3. **At most one per 20 minutes, per device.** `INTERSTITIAL_COOLDOWN_MS` in
   `public/js/ad-frequency.js` is a constant; no server value or variable can
   change it. The throttle **fails closed** — no `localStorage`, no interstitial.
4. **A direct-link is never auto-opened.** `_INTERSTITIAL_URL` renders as a
   labelled sponsored link the visitor may ignore.

### The video pre-roll

`public/js/preroll.js` is a small, dependency-free VAST player (VAST 2.0–4.x,
Linear). `game-page.js` gives the game iframe its `src` only after the pre-roll
settles:

- **The game always loads.** Completed, skipped, no fill, blocked, unplayable,
  autoplay refused, or hung — every outcome settles the promise. The player has
  a 45-second failsafe and `game-page.js` an outer 50-second cap on top of it.
- **Skippable at the creative's `skipoffset`,** 5 seconds when none is given —
  which is Clickadu's own rule for VAST creatives.
- **Nothing is shown until there is a playable ad.** No fill leaves the normal
  game loader on screen for the moment the attempt took.
- **Never back to back with the interstitial.** If the interstitial fired in
  the last 2 minutes, that game load skips the pre-roll.
- **The impression fires on the first frame shown**, never on page load.
- **No wait when there is no pre-roll.** The server templates
  `ZOFHUB_GAME.preroll` into the game page; when no region has a pre-roll
  configured, the frame binds immediately without waiting on `/api/site-config`.

### The popunder

PopAds' code is injected byte for byte, and only when all three hold: the server
sent it (game pages only), the page is `/play/<slug>`, and the browser is a
desktop one (a fine pointer that can hover, a viewport of at least 1024px, no
mobile user agent, not an iPad reporting a desktop UA).

---

## Compliance matrix

Status values are used precisely:

- **Confirmed** — stated in the network's own current documentation
- **Needs approval** — depends on this specific domain being reviewed
- **Not verified** — could not be confirmed from an authoritative source

### What applies to every network

| Item | Status | Notes |
|---|---|---|
| Site approval for `zofhub.*` | **Needs approval** | Per-domain review. Not granted by anything in this repo. |
| Format approval | **Needs approval** | Approval for one format does not extend to another. |
| Content acceptance | **Not verified** | Confirm with each network that a free games-and-AI site is acceptable before enabling. |
| Traffic-source requirements | **Not verified** | Check your account dashboard. |
| Audience-age requirements | **Not verified** | The audience includes minors. Consequences for ad targeting and COPPA/GDPR-K. Set every network to mainstream-only. |

### Per network

| Network | Formats wired up | Status | Notes |
|---|---|---|---|
| **Ad-Maven** | interstitial, direct-link | Needs approval | Rendered only inside ZoFHub's throttled overlay. A direct-link is a destination URL, never auto-triggered. |
| **ExoClick** | banner | Needs approval | Header and sidebar zones only. Mainstream-only setting required. |
| **HilltopAds** | in-page push | Needs approval | A loader script; needs no container. |
| **Clickadu** | video pre-roll (VAST) | Needs approval | Clickadu requires `skipOffset` 00:00:05 and the `skip` event on VAST creatives; the player honours both. Mainstream-only setting required. |
| **Mondiad** | native | Needs approval | Paste the delivery code and the element code together. Labelled Sponsored. |
| **PopAds** | popunder | Needs approval | **Requires their code unmodified.** Passed through byte for byte. Desktop game pages only. |

### Things this codebase will not do

No fake impressions or clicks. No automated interaction. No hidden or
zero-opacity ads, and no ad loaded where nobody can see it. No forced
interactions. No clickjacking. No refresh loops. No impression inflation. No
modification of any network's code to alter tracking, attribution or fraud
detection. No injection into third-party pages. No attempt to evade the
visitor's content blocker, and nothing is ever locked behind one.

---

## Failure handling

An ad failure must never break the site. Every path degrades to nothing:

- **Blocked / offline / no fill** → the placement stays empty; the page is unchanged
- **Ad script throws** → caught; nothing else is affected
- **`/api/site-config` unreachable** → no ads load, the site works normally
- **CSP refuses an origin** → the browser blocks it; nothing else breaks
- **Pre-roll fails in any way** → the game loads

**No retries and no reloads.** A network that failed once is not asked again on
that page view.

---

## Diagnosing "the ads don't work"

```bash
npm run check-ads
```

Walks the path a visitor's browser does and reports on each hop: which network
is active in which role (and which variables are set but unread) → CSP → what
`/api/site-config` actually serves to a hub page, a game page and a path nobody classified →
host reachability. Non-zero exit if anything would stop an ad from rendering.

The CSP allowlist is **derived from your configuration**, including every
region's tags and loader URLs built inside inline code (PopAds builds its own,
protocol-relative). If a network chains to a domain you never pasted, add it to
`PROXY_AD_ORIGINS`.

---

## Files

| File | Role |
|---|---|
| `lib/ad-providers.mjs` | The registry: networks, roles, surfaces, regional resolution, CSP origins. |
| `lib/geo.mjs` | Regions: the visitor's country and region, and regional routing. |
| `public/js/site-config.js` | The page's one `/api/site-config` request, shared by every module. |
| `public/js/proxy-ads.js` | Injects the push loader. Once, never rewritten. |
| `public/js/ad-slots.js` | Header, sidebar, native, popunder, interstitial. |
| `public/js/ad-frequency.js` | The 20-minute throttle, shared by the interstitial and the pre-roll. |
| `public/js/preroll.js` | The VAST pre-roll player. |
| `public/js/layout.js` | Loads the ad stack, from whatever `/api/site-config` hands this page. |
| `tools/check-ads.mjs` | Pre-deploy verification. |
| `test/ad-architecture.test.mjs`, `test/ad-boundary.test.mjs`, `test/production-guards.test.mjs` | The guarantees above, asserted. |

---

**Related:** [documentation map](../README.md#-documentation) · [how it all fits together](../guides/HOW-IT-WORKS.md) · [how the server's own traffic is handled](../proxy/SINGBOX.md) · [go-live checklist](../guides/GO-LIVE.md)
