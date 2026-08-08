# Advertising — architecture, configuration and compliance

ZoFHub supports **five** advertising networks and no others:

**HilltopAds · Adsterra · Monetag · Ad-Maven · PopAds**

Google AdSense and Ad Manager are refused at three separate layers and must
never be enabled. Google bans proxy and anonymiser domains at the **account**
level, so a single stray tag here could take down an unrelated AdSense account.

---

## ⚠ Read this before enabling anything

**No network has approved this site.** Every one of the five requires publisher
review of your specific domain, and this repository has no way to know the
outcome. Nothing in the code should be read as evidence of approval — the
registry in [`lib/ad-providers.mjs`](../lib/ad-providers.mjs) deliberately
records every provider as `needs-approval`, and a test fails the build if any
entry ever claims otherwise.

Approval for one format does not imply approval for another. Check the format
you are enabling against your own account dashboard.

---

## The one-minute version

```bash
# 1. Enable a network (host dashboard, never a committed file)
ADSTERRA_ENABLED=1
ADSTERRA_SCRIPT=https://<the loader URL Adsterra gave you>

# 2. Verify it will actually load
npm run check-ads

# 3. Confirm what is live
curl -s localhost:8080/api/admin/ads   # requires admin auth
```

Unset everything and the site runs ad-free with no empty boxes, no reserved
space and no requests. That is the default state and it is fully supported.

---

## Configuration

Every network uses the same seven variables. There is no per-network special
casing anywhere in the codebase.

| Variable | Purpose |
|---|---|
| `<NETWORK>_ENABLED` | `1` turns it on. Unset renders nothing. |
| `<NETWORK>_SCRIPT` | Page-level loader URL(s), comma-separated, https only |
| `<NETWORK>_ZONE` | The zone / site ID the network issues you |
| `<NETWORK>_HEADER_TAG` | Raw HTML — header leaderboard, 728×90 |
| `<NETWORK>_SIDEBAR_TAG` | Raw HTML — sidebar rectangle, 300×250 |
| `<NETWORK>_FOOTER_TAG` | Raw HTML — footer banner, 728×90 |
| `<NETWORK>_INCONTENT_TAG` | Raw HTML — the six in-content slots |

Prefixes: `HILLTOPADS` `ADSTERRA` `MONETAG` `ADMAVEN` `POPADS`

### Rules that are enforced, not suggested

**Enabled without configuration renders nothing.** Both halves are required, so
a half-finished setup produces no empty boxes.

**One slot, one network.** If two enabled networks both supply a `HEADER_TAG`,
the first in registry order wins. Two tags in one box means duplicate scripts, a
broken layout, and a policy breach on several networks.

**The same loader URL is never injected twice**, even if two networks list it.

**Tags are credentials.** Anyone holding one can serve ads billed to your
account. They are never sent to the browser beyond the markup that must render,
never returned by the admin API, and never logged. Set them in your host's
dashboard.

---

## Advertising never touches the proxy

This is a compliance and security boundary, not a layout preference.

ZoFHub serves two fundamentally different kinds of page from one origin:

| | What it is | Ads |
|---|---|---|
| **Native** | Pages ZoFHub authored — catalog, game pages, AI, community | Permitted |
| **Proxy** | `/browser`, `/gust`, `/uv/*`, `/sj/*`, Wisp, proxy assets | **Never** |

What renders on a proxy surface is *somebody else's website*, fetched and
rewritten on the visitor's behalf. Monetising it would mean placing our
advertising on a page we do not own, and injecting script into third-party
content in transit.

**This was not enforced before.** `public/browser.html` imports `layout.js`,
which is the module that loads the ad stack — so configuring any network would
have started serving ads on the proxy page. Nothing said that was wrong and
nothing tested it.

It is now enforced in three places:

1. **`isAdSurface()`** in `lib/ad-providers.mjs` — deny-list first, then an
   allow-list of native routes. **An unclassified route gets no ads**, because a
   route nobody classified is a route nobody reasoned about.
2. **`/api/site-config`** returns an empty ad payload for a proxy surface. The
   server never hands a proxy page anything to inject.
3. **`layout.js`** checks the path *before* requesting an ad config at all. This
   duplication is deliberate: `layout.js` is cached in visitors' browsers for a
   long time, so a client-side-only check would keep serving ads on the proxy
   page until every cached copy expired.

`test/ad-architecture.test.mjs` asserts all three, including that query strings
and fragments cannot smuggle a surface past the check.

---

## Placement

Four fixed slots, all inside ZoFHub's own layout:

| Slot | Size | Where |
|---|---|---|
| `header` | 728×90 / 320×50 mobile | Below the header, above content |
| `sidebar` | 300×250 | Inside the category sidebar; hidden below 900px |
| `footer` | 728×90 / 320×50 mobile | Page bottom |
| `incontent` | 728×90 responsive | Six positions the pages already declare |

**Never placed:** over game controls, over navigation, inside gameplay, over the
AI composer, over proxy content, or anywhere an ad could be mistaken for a site
control.

Every slot reserves its exact size at creation time, so a late-loading creative
cannot shift the page. An unset slot collapses to nothing and reserves no space
— there are no empty "Advertisement" boxes, ever.

`adFrequencyController` in `public/js/ad-slots.js` throttles interstitials via
`localStorage`, so a network that would fire one on every page view cannot put a
full-screen ad between a player and the game they just clicked.

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
| Proxy/anonymiser content acceptance | **Not verified** | ZoFHub hosts a web proxy. Several networks restrict this and the rules are not consistently published. **Raise it explicitly with each network before enabling.** |
| Traffic-source requirements | **Not verified** | Check your account dashboard. |
| Minimum-traffic thresholds | **Not verified** | Varies by network and changes. |
| Audience-age requirements | **Not verified** | ZoFHub is a games site and may attract minors. This has real consequences for ad targeting and for COPPA/GDPR-K. **Verify before enabling.** |

### Per network

| Network | Formats wired up | Status | Notes |
|---|---|---|---|
| **HilltopAds** | banner, in-page push | Needs approval | Confirm which formats are approved for this domain. |
| **Adsterra** | banner, Social Bar, native banner | Needs approval | Social Bar is an overlay — check it against the placement rules above before enabling on game pages. Not enabled by default. |
| **Monetag** | MultiTag, banner, in-page push | Needs approval | MultiTag selects formats server-side, so what it serves can change with no code change here. Review what it actually renders after enabling. |
| **Ad-Maven** | direct-link, banner | Needs approval | Direct-link is a destination URL, not a script. Attach it to something a person deliberately clicks — never auto-trigger it, never disguise it as navigation. |
| **PopAds** | popunder | Needs approval | **Requires their code unmodified.** Passed through byte-for-byte; never rewritten, minified or re-wrapped. Approve the exact URLs it runs on with PopAds first. |

### Things this codebase will not do

No fake impressions or clicks. No automated interaction. No hidden or
zero-opacity ads. No forced interactions. No clickjacking. No refresh loops. No
impression inflation. No modification of any network's code to alter tracking,
attribution or fraud detection. No injection into proxied third-party pages.

These are absent by construction, and the reasons are recorded in the source
rather than only here.

---

## Failure handling

An ad failure must never break the site. Every path degrades to nothing:

- **Blocked / offline / no fill** → the slot stays empty; the page is unchanged
- **Ad script throws** → caught; nothing else is affected
- **`/api/site-config` unreachable** → no ads load, site works normally
- **CSP refuses an origin** → the browser blocks it; nothing else breaks

**No retries and no reloads.** A network that failed once is not asked again on
that page view. Retry loops generate junk requests that look like fraud to the
network and cost the visitor bandwidth for nothing.

---

## Diagnosing "the ads don't work"

Ad misconfiguration here is **silent**. The server accepts the tag,
`/api/site-config` serves it, `proxy-ads.js` injects it — and the browser's CSP
can refuse it. Nothing crashes, no endpoint 500s, the page looks perfect. The
only trace is a console line, so the natural conclusion is "this network doesn't
pay".

```bash
npm run check-ads
```

Walks the same path a visitor's browser does and reports on each hop: env → CSP
→ serving → host reachability. Non-zero exit if anything would stop an ad from
rendering, so it can gate a deploy.

The CSP allowlist is **derived from your configuration**, not hardcoded — these
networks rotate loader domains constantly and a static list would rot silently.
If a network chains to a different domain, add it to `PROXY_AD_ORIGINS`.

---

## Legacy variables (deprecated)

`PROXY_AD_SCRIPTS`, `PROXY_BANNER_TAG`, `PROXY_HEADER_TAG`,
`PROXY_SIDEBAR_TAG`, `PROXY_INCONTENT_TAG` predate the provider layer. They
still work — upgrading must not silently switch off a live site's revenue — and
fill only slots no enabled network claimed.

They carry **no network identity**, so nothing can report which network is
serving or disable one without disabling all of them. The server logs a notice
at boot while any are in use. Migrate to `<NETWORK>_*`.

---

## Files

| File | Role |
|---|---|
| `lib/ad-providers.mjs` | The registry. Networks, slots, surfaces, config resolution. |
| `public/js/proxy-ads.js` | Injects resolved loader scripts. Once each, never rewritten. |
| `public/js/ad-slots.js` | Header / sidebar / in-content slots + interstitial throttle. |
| `public/js/footer-ad.js` | The isolated footer banner. |
| `public/js/layout.js` | Loads the ad stack — and refuses to on a proxy surface. |
| `tools/check-ads.mjs` | Pre-deploy verification. |
| `test/ad-architecture.test.mjs` | The guarantees above, asserted. |
