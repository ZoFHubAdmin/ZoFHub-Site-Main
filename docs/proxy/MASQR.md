# MASQR: making a mirror domain last longer

> **Off by default.** With `MASQR_ENABLED` unset — every deployment that does
> not deliberately turn this on — nothing about the site changes. Verified, not
> asserted: see §7.

Machine-readable provenance: [`data/masqr-upstream.json`](../../data/masqr-upstream.json).

| | |
|---|---|
| Project | **The MASQR Project** |
| Upstream | <https://github.com/titaniumnetwork-dev/MasqrProject> |
| Docs | <https://docs.titaniumnetwork.org/technologies/masqr> |
| Licence | **AntiSkip License** — MIT text *plus* an added condition. **Not MIT.** |
| Copyright | © **Mercury Workshop** 2024 (not TitaniumNetwork, despite the org) |
| Reviewed | 2026-09-21, against the last upstream push (2024-02-19) |
| Code copied | **None** |

---

## 1. The problem

ZoFHub is built to be redeployed on throwaway mirror domains, because school
filters block the primary one. **Mirror rotation is the cure. This is the
prevention.**

A mirror nearly always dies the same way:

1. Someone shares the link.
2. It reaches a filter vendor.
3. The vendor's crawler fetches the URL.
4. It sees a web proxy.
5. The domain is filed under *proxy/anonymizer* and burned — often within hours,
   and for every future visitor at once.

Step 4 is the only one we control. MASQR is the project that named this problem
and the shape of the answer: **do not show the proxy to a client that was not
handed a key out of band.**

---

## 2. What this is — and what it is not

**It is not access control, and it must never be described as security.**
Anyone holding a key can pass it on, and the games hub — the large majority of
this site — stays completely open either way.

What it buys is narrower and real: an **unauthenticated automated classifier**
is not shown a proxy. That is a discovery-resistance property, not an
authorisation property. Conflating the two is how people end up trusting a gate
that was never load-bearing.

**Nothing is fabricated.** Upstream serves a decoy page per domain. ZoFHub
answers `404` on the proxy paths and shows the real games hub everywhere else.
The site genuinely *is* a games hub — there is no cover story to invent, and
inventing one would be the dishonest part.

---

## 3. How it works

```
        ┌──────────────────────────── unauthenticated ────────────────────────────┐
crawler │  GET /            → 200  the real games hub (16,900 games)              │
or       │  GET /browser     → 404  "not found"                                    │
visitor │  GET /gust,/uv/…  → 404                                                  │
        │  GET /healthz     → 200  never gated — see below                        │
        └─────────────────────────────────────────────────────────────────────────┘

        ┌──────────────────────── holds a key ────────────────────────────────────┐
        │  GET /browser?k=<key>  → 302 /browser  + signed HttpOnly grant cookie    │
        │  GET /browser          → 200  the proxy browser, as normal               │
        └─────────────────────────────────────────────────────────────────────────┘
```

**Keys are HMAC-signed and stateless.** `<expiry-base36>.<hmac-22>`, about 31
characters. No database row, no network call, no third party. That matters here
specifically: a mirror has to work the *moment* it boots, on a fresh host with
an empty database — and this repository currently has migrations waiting to be
applied, which is exactly the situation where a key system backed by a table
would be dead on arrival.

**The grant is re-verified on every request.** The cookie carries the signed key
itself; a cookie is an assertion by the client, never evidence on its own.

**Only document requests are gated.** A crawler fetches the *page*; it does not
go hunting for `/uv/uv.bundle.js`, and those paths are only discoverable from
the page it cannot read. Letting subresources through also avoids the ugly
failure where a grant expires mid-session and a service worker starts receiving
HTML where it expected JavaScript.

### Never gated, whatever else is configured

| Path | Why it must stay reachable |
|---|---|
| `/healthz`, `/ping`, `/api/health` | Gating it 404s the probe, Render marks the service unhealthy, and **the container restarts in a loop**. This one takes the site down. |
| `/privacy`, `/terms`, `/dmca`, `/cookies` | Legal obligations. A DMCA agent must be able to reach the policy. |
| `/licenses`, `/credits` | The AGPL §13 source offer for the proxy engines this site serves. |
| `/robots.txt`, `/sitemap.xml`, `/ads.txt`, `/favicon.ico` | Crawler and ad-network contract files. |
| everything else | The games hub, `/ai`, `/community`, `/leaderboard`, `/donate` — all open. |

The gated list is **derived from `PROXY_SURFACES`** in
[`lib/ad-providers.mjs`](../../lib/ad-providers.mjs) rather than restated. That list
is already the project's written answer to "is this proxy infrastructure?", and
two copies would drift — silently, which is how a newly added engine ends up
advertised to a crawler.

---

## 4. Using it

```bash
MASQR_ENABLED=1
MASQR_SECRET=<32+ random characters>     # required; the gate refuses to enable without it
MASQR_KEY_TTL_DAYS=30                    # optional, default 30
MASQR_DENY=404                           # or "redirect" to send people to the hub
```

Mint a key as an admin (permission + CSRF, like every other admin write):

```bash
POST /api/admin/masqr/key   {"days": 7}
→ { "key": "…", "link": "https://your-mirror/browser?k=…", "expires": "…" }
```

The key is shown **once**. It is signed, not stored — there is nowhere to look
it up again, by design. Hand the link out however you distribute access: a bot,
a group chat, a class list.

**Misconfiguration fails OPEN, loudly.** A gate switched on without a secret
cannot verify anything, so it would deny every visitor — a half-broken site. It
runs ungated instead and says so at boot in terms nobody can miss. (Compare
[`lib/wisp-policy.mjs`](../../lib/wisp-policy.mjs), which fails toward the
*restrictive* default: there the safe direction is "refuse", here it is "do not
break the site over a missing setting".)

**The site chrome adapts.** A header advertising "Proxy Browser" that 404s would
look like a broken site rather than a quiet one, so the server leaves a
one-character, non-secret hint cookie (`zh_px`) and `layout.js` prunes the link.
It fails toward *showing* the link: a cookie-less browser gets the site it has
always had.

---

## 5. What was deliberately not taken from upstream

Upstream's reference backend is a demo, and adopting it as-is would have
imported real defects. Each of these is a decision, recorded in
`data/masqr-upstream.json`:

| Upstream | Here | Why |
|---|---|---|
| Fetches `license.mercurywork.shop/validate?license=<key>` per request | Offline HMAC | Key in a query string (logged by every hop); a third party gatekeeping your site; an un-timeout-ed call on every request; fails closed if that host is down |
| `authcheck=true` cookie | Signed key, re-verified | A plain true/false cookie is bypassed by typing one line into the console |
| Licence bound to one host | Deliberately **not** host-bound | Mirrors are disposable; host-binding invalidates every key at the moment of rotation |
| `console.log`s the key | Never logged | A secret in a log is a secret in a backup |
| `WWW-Authenticate: Basic` prompt | `?k=` consumed via redirect | Upstream's own comment says the dialog "gives it away" |
| `req.url.includes("/bare/")` bypass | Exact/prefix matching | `/anything?x=/bare/` walks straight through a substring test |
| Decoy `Checkfailed.html` per domain | 404 + the real games hub | Nothing to fabricate, and per-domain decoys do not scale to disposable mirrors |
| Builds a file path from the `Host` header | Reads no file from request input | The safest handling of a hostile path component is not to have one |

**Rejected entirely:** `LicensingServer/index.js` (in-memory Map lost on
restart; a `cleanupLicenses()` that iterates `for...in` over `Map.keys()` and
therefore never runs; a `delete map[key]` that does nothing; and `setInterval`
as the scheduler, which this repository's RULE 16 forbids outright) and
`MasqrFront/masqr.js` (stores `localStorage['LICENSE_CHECK'] = true` as proof of
validation).

---

## 6. Licensing and attribution

The upstream `LICENSE` is MIT text with an **added condition** — that the user
is not, and is not acting for, SurfSkip. It calls itself the *AntiSkip License*.
GitHub classifies it `NOASSERTION`; there is no SPDX identifier. It is
permissive for this project, which has no connection to SurfSkip, but **it must
not be recorded as MIT**.

Because **no upstream code is copied**, the notice-retention condition is not
engaged. Credit is given anyway, in `CREDITS.md` and on the site's own
`/credits` page: © Mercury Workshop 2024.

ZoFHub is not affiliated with or endorsed by Mercury Workshop or TitaniumNetwork.

---

## 7. Verification status

Tested against a real server, with a crawler's actual header shape (no
`Sec-Fetch-*`, generic `Accept`) rather than a browser pretending:

| Check | Result |
|---|---|
| `/browser`, `/gust`, `/uv/service/…`, `/api/proxies` for a crawler | 404 |
| 404 body names no engine, and does not name the gate either | pass |
| Games hub open, and really is the games page | 200 |
| `/healthz`, `/api/health`, `/privacy`, `/dmca`, `/terms`, `/licenses`, `/robots.txt` | all reachable |
| `?k=` → 302, key stripped from the redirect, HttpOnly grant issued | pass |
| Key holder gets the real proxy page | 200 |
| Forged grants (`true`, `1`, `authcheck`) | all 404 |
| Signing secret in any response or log | never |
| Nav link hidden when gated, back when granted | pass |
| **Gate off: `/browser` 200, `/api/proxies` 200, no cookie set** | pass |
| **Enabled without a secret: site still 200, warning logged** | pass |

35/35 live checks, plus 37 unit tests in
[`test/masqr.test.mjs`](../../test/masqr.test.mjs).

**Not verified:** whether this actually extends the life of a mirror domain in
the field. That depends on how each filter vendor classifies, and it cannot be
measured from here — only observed over time across real deployments.

---

**Related:** [documentation map](../README.md#-documentation) · [how it all fits together](../guides/HOW-IT-WORKS.md) · [the egress policy it sits in front of](INVISIPROXY.md) · [what a 404 means while debugging](../guides/DEBUGGING.md)
