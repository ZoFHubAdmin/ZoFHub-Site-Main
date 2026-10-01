# InvisiProxy: what was integrated, and what was deliberately not

> **ZoFHub ships no InvisiProxy code.** No vendored copy, no npm dependency, no
> bundled build. It is integrated two ways: as an **optional external engine**
> you point at with `PROXY_INVISI_URL`, and as the **source of two ideas** that
> were reimplemented here from scratch. This document explains why that is the
> correct architecture rather than a shortcut, and records the provenance.

Machine-readable companion: [`data/invisiproxy-upstream.json`](../../data/invisiproxy-upstream.json).

| | |
|---|---|
| Project | **InvisiProxy LTS** (formerly Holy Unblocker LTS) |
| Upstream | <https://github.com/QuiteAFancyEmerald/InvisiProxy> |
| Reviewed at | **v7.0.2.1**, commit `243206fc698349403ea61015dfb384737921ebcb` |
| Reviewed on | 2026-09-21 |
| Licence | **AGPL-3.0-only** |
| Copyright | TitaniumNetwork and the InvisiProxy contributors |

---

## 1. Why it is not vendored

Three independent reasons, each sufficient on its own.

### It duplicates working architecture

InvisiProxy is a complete proxy **application**, not a library. It is built on
exactly the primitives ZoFHub already integrates directly:

| Primitive | InvisiProxy v7.0.2.1 | ZoFHub |
|---|---|---|
| Ultraviolet | `v3.2.10-headers` (tarball) | `^3.2.10` (npm) |
| Scramjet | `2.0.67-alpha.2` | `^1.1.0` |
| bare-mux | `^2.1.9` | `^2.1.9` |
| epoxy-transport | `^3.0.1` | `^2.1.28` |
| Wisp server | `mrrowisp ^3.1.6` | `@mercuryworkshop/wisp-js ^0.4.1` |
| HTTP framework | Fastify 5 | Express 4 |

Importing it would not add a capability. It would add a second implementation of
the capability this site already has — and ZoFHub's is verified working:
`npm run verify-proxy` renders real pages through all three built-in engines.

### It is structurally incompatible

- **Fastify 5 + pnpm workspace** against ZoFHub's **Express 4 + npm, no build step**.
- Its `package.json` declares `"postinstall": "playwright install chromium"`.
  This repository sets `ignore-scripts=true` in `.npmrc` precisely to stop
  install-time downloads, and `render.yaml` builds with `npm ci --omit=dev` to
  keep Playwright's ~300 MB out of production.
- It expects a process manager (`pm2`, `ecosystem.config.js`) and its own
  `config.json`. ZoFHub is one process configured entirely by environment
  variables, validated at startup.

### AGPL-3.0 §13 — the decisive reason

ZoFHub's own `LICENSE` is proprietary, and **ZoFHub is offered over a network**.
Copying InvisiProxy source into the served application would make the running
work a combination that includes AGPL-3.0 code, engaging §13: every user
interacting with it over the network would have to be offered the *complete
corresponding source of the whole combination*.

A subdirectory does not change that. Neither does a separate npm package inside
the same deployed process. **What does change it is process and deployment
separation:** InvisiProxy runs as its own service, deployed by whoever deploys
it, and ZoFHub merely links to it — the same relationship a browser bookmark
has. Its §13 obligation is real and belongs to its deployer.

This repository already reasons this way about GPL code; see the header of
`Dockerfile`, which builds sing-box from pinned upstream rather than vendoring
it, for the same argument applied to GPL-3.0.

> **ZoFHub's own AGPL obligations are unchanged by this document.** The site
> already serves Ultraviolet, Scramjet, Wisp, epoxy and libcurl.js to visitors,
> and `lib/licenses.mjs` carries the §5 change notices and §13 source offer for
> those. Nothing here weakens that.

---

## 2. What IS integrated

### (a) InvisiProxy as an optional engine

Set `PROXY_INVISI_URL` to a running instance and it appears in the `/browser`
engine picker alongside NautilusOS, Interstellar, DayDream and Nebula. It is
probed for reachability, listed only while it is up, and framed with a new-tab
escape hatch.

```bash
PROXY_INVISI_URL=https://invisi.example.com/
```

Running one (from its own checkout — **Node ≥22, pnpm**, per its `package.json`):

```bash
pnpm install && pnpm start
```

ZoFHub does not start it, bundle it, or manage it. With the variable unset —
the default, and every deploy — the engine does not exist.

> **Credentials are stripped from this URL.** `/api/proxies` publishes engine
> URLs unauthenticated, so a password written into `PROXY_INVISI_URL` would be
> handed to every visitor. `publicEngineUrl()` in `server.js` removes userinfo
> and warns at boot. This applies to all five companion variables.

### (b) An explicit egress policy — `lib/wisp-policy.mjs`

**This is the substantive change, and it is a security fix.**

Reviewing InvisiProxy's `src/server.mjs` shows its Wisp server configured with
an explicit posture: `allowPrivateIPs: false`, `allowUDP: false`, a port
whitelist, per-IP connection limits, flood protection. ZoFHub had **none of
that written down**. It had some of it by accident, because `wisp-js` happens to
default `allow_private_ips: false`.

An inherited default is a promise nobody made. Reading the installed `wisp-js`
options object directly showed three real gaps:

| `wisp-js` default | Consequence for ZoFHub |
|---|---|
| `port_whitelist: null` | The tunnel would dial **any** port — 25 (SMTP relay), 22, 3306, 6379. A web proxy that is also a port scanner. |
| `stream_limit_total: -1` | **Unlimited streams per tunnel.** ZoFHub capped tunnels per IP (32) but not what one tunnel could open. |
| `allow_udp_streams: true` | Worse than it looks — see below. |

**The UDP finding.** `wisp-js` picks the socket class per stream type:

```js
let SocketImpl = type === stream_types.TCP ? this.TCPSocket : this.UDPSocket;
```

ZoFHub injects only `TCPSocket` (the sing-box dialler). A UDP stream therefore
left the Node process **directly, bypassing sing-box entirely** — so
`SINGBOX_REQUIRE=1`, the operator's explicit *"never leak this server's own
IP"*, did not cover UDP. Nothing in ZoFHub uses UDP through the tunnel, so it is
now closed.

The policy is now stated, applied to the live server object before any upgrade
is routed, printed at boot, and exposed in `/api/admin/proxy`:

```
→ egress:  ports 80,443,8080,8443 · no UDP · private IPs blocked · max 256 streams/tunnel
```

**No InvisiProxy code was copied.** Upstream runs a different Wisp server
(`mrrowisp`) with a different API; not one line is applicable. What was taken is
the argument that these values belong in the application's configuration.

### (c) A real engine validator — `tools/verify-proxy.mjs`

Upstream ships `proxyServiceValidator.js`, and the idea of a runnable proxy
check is theirs. **Its method was not adopted**, for a reason worth recording.
It generates a proxy URL in a browser, then fetches it with axios:

```js
const response = await axios.get(url, { headers });
return response.status === 200;
```

A service worker only intercepts requests from clients it controls. An axios
request from Node is not a client at all, so it never reaches the proxy — it
hits the origin server. Measured here: fetching a `/uv/service/…` URL from
outside the worker's scope returns Express's own `{"error":"not found"}`. A 200
from that request would mean the *server* answered, which is the opposite of
what the check is trying to prove. This repository already names that trap
(RULE 3: never treat HTTP 200 as verification).

ZoFHub's version drives the real UI in a real browser and asserts on the
rendered document — requiring both that the frame points at the requested host
and that content only the real page has is present.

```bash
npm run verify-proxy
npm run verify-proxy -- --engine uv --target https://example.com/
```

**This immediately corrected a wrong belief.** The Ultraviolet engine had been
recorded as broken — "service worker returns HTTP 500" — on the strength of a
207-byte response body. 207 bytes is example.com's actual body length. UV was
fine:

```
pass  scramjet  https://example.com/             1945ms  "Example Domain"
pass  scramjet  https://www.wikipedia.org/       3036ms  "Wikipedia"
pass  uv        https://example.com/             1900ms  "Example Domain"
pass  uv        https://www.wikipedia.org/       1885ms  "Wikipedia"
pass  gust      https://example.com/             6299ms  "Example Domain"
pass  gust      https://www.wikipedia.org/       6210ms  "Wikipedia"
```

GUST is checked differently: it is an *app* engine that owns a whole browser UI,
so the check drives GUST's own address bar one frame down and reads the document
it renders into its inner `#frame` (a `blob:` URL). There is no encoded `src` to
compare, so the rendered text is the only evidence — and because the two targets
have distinct markers, a stale frame cannot satisfy it.

---

## 3. What was rejected, and why

| Component | Why not |
|---|---|
| Fastify server, routes, templates, views, pages | ZoFHub has its own application and its own site. |
| `mrrowisp` | ZoFHub's `wisp-js` integration is pinned by `test/wisp-egress-contract.test.mjs` and carries traffic through sing-box via an injected `TCPSocket`. Swapping it would discard verified architecture *and* that egress guarantee. |
| **Ultraviolet `v3.2.10-headers`** | Tempting — its release note fixes *"TypeError: headers is not iterable"* with newer transports. But upstream also says *"may have issues not tested in-depth"*, it is an unpinnable GitHub tarball rather than a registry release, and **ZoFHub's npm 3.2.10 is verified working**. Replacing a working dependency with an untested one is the wrong trade. Recorded as the upgrade path *if* that error is ever observed. |
| Client-side Tor/SOCKS5 (`socks5h://localhost:9050`) | ZoFHub routes egress server-side through sing-box. A second, browser-side proxy selector would be a duplicate mechanism with a weaker guarantee. |
| `config.json` | ZoFHub is configured by environment variables, validated at startup. |
| Scramjet 2.x | ZoFHub is on 1.1.0 and it works. 2.0.67-**alpha**.2 is a pre-release; upgrading is a separate, testable decision, not a side effect of this work. |
| Upstream's `TODO.md` items | Reviewed as context only. They describe *upstream's* roadmap against *upstream's* architecture; none translate to a gap here. |

---

## 4. Configuration

| Variable | Default | Meaning |
|---|---|---|
| `PROXY_INVISI_URL` | *(unset)* | A running InvisiProxy instance. Unset = engine not offered. |
| `WISP_ALLOWED_PORTS` | `80,443,8080,8443` | Ports the tunnel may dial. Accepts `8000-8100` ranges, or `any` to disable the check (warns loudly). |
| `WISP_ALLOW_UDP` | `0` | UDP streams. **Bypasses sing-box** — leave off. |
| `WISP_ALLOW_PRIVATE_IPS` | `0` | RFC1918/CGNAT/link-local. Never enable in production. |
| `WISP_ALLOW_LOOPBACK_IPS` | `0` | The server's own loopback interface. |
| `WISP_MAX_STREAMS` | `256` | Concurrent streams one tunnel may hold. `-1` disables (warns). |
| `WISP_BLOCKED_HOSTS` | *(unset)* | Comma-separated host globs, e.g. `*.evil.net,ads.example.com`. Anchored. |
| `WISP_MAX_PER_IP` | `32` | Pre-existing: tunnels one client may hold. |

Invalid values **fail safe, not closed**: the secure default is kept and the
problem is reported. A typo in a port list must not take the site down, and it
must never *widen* the policy.

---

## 5. Security

Verified behaviourally in `test/wisp-egress-security.test.mjs`, which speaks the
Wisp protocol over a real WebSocket to a real tunnel:

| Attempt | Result |
|---|---|
| `127.0.0.1:<internal>` | refused — `0x48 HostBlocked` |
| `localhost:<internal>` (by name) | refused — resolved before the decision, so name tricks do not help |
| `169.254.169.254:80` (cloud metadata) | refused |
| `10.0.0.1`, `192.168.1.1`, `172.16.0.1` | refused |
| non-web port on an allowed host | refused |
| UDP stream | refused |
| 3rd stream against a cap of 2 | refused — `0x49 ConnThrottled` |

**The control matters most.** "Everything was refused" is also what a completely
broken tunnel looks like, so the same internal address is reached *successfully*
under a deliberately loosened policy. That proves the refusals are the policy
talking and not a dead socket.

Adding InvisiProxy as an engine adds **no new server-side attack surface**:
ZoFHub stores a URL, makes one `GET` to check liveness, and lets the browser
frame it. No request is proxied through ZoFHub to it.

---

## 6. Privacy

Nothing about this integration logs proxied traffic.

- ZoFHub **does not log** URLs, request bodies, responses, headers or cookies
  passing through `/wisp/`. Tunnel telemetry is counters only — streams opened
  and closed, bytes read and written, and a per-IP tunnel *count* used for the
  cap. See `wispSnapshot()`.
- Choosing the InvisiProxy engine sends the visitor's browser to **its** origin.
  From that point it is that deployment's privacy policy that applies, not
  ZoFHub's. ZoFHub sees none of that traffic.
- **Proxy activity is never AI training data.** The boundary is structural, not
  a policy promise: the AI feedback pipeline (`lib/ai-feedback.mjs`,
  `docs/features/AI-ARCHITECTURE.md`) only ever ingests rows submitted through
  `POST /api/ai/feedback`, which carries a deliberate user action and a consent
  flag defaulting to false. No proxy or tunnel code path can reach it. Network
  telemetry and AI feedback are separate systems that share no storage.

---

## 7. Keeping the integration current

Because nothing is vendored, "upgrading" means two small things.

**The engine.** Redeploy your own InvisiProxy instance. Nothing in ZoFHub
changes; the URL is the whole interface.

**The provenance record.** When re-reviewing a newer upstream release:

1. `gh api repos/QuiteAFancyEmerald/InvisiProxy/releases --jq '.[0].tag_name'`
2. Compare `package.json` between the recorded commit and the new tag — the
   dependency table in §1 is what goes stale first.
3. Re-read `src/server.mjs` for Wisp configuration changes. That is the file
   that motivated `lib/wisp-policy.mjs`; if upstream adds a protection we lack,
   that is a finding.
4. Confirm the licence is still AGPL-3.0 (`gh api …/license`). A licence change
   would change the analysis in §1.
5. Update `reviewedVersion`, `reviewedCommit` and `reviewedOn` in
   `data/invisiproxy-upstream.json`, and this table.

Do not pull upstream commits into this tree. The integration boundary is the
URL, and keeping it that way is what keeps §1 true.

---

## 8. Verification status

| Check | Result |
|---|---|
| `npm test` | see the report — includes 27 policy + 12 live egress-security tests |
| `npm run verify-proxy` | 6/6 pages rendered through Scramjet, Ultraviolet **and GUST** |
| SSRF against a live tunnel | 5/5 internal destinations refused; control case reached |
| Upstream licence | AGPL-3.0 confirmed via GitHub API at commit `243206fc` |

**Not verified:** ZoFHub has never been run against a live InvisiProxy instance,
because that requires deploying one. The engine path it uses is the same
`COMPANION_ENGINES` code the other four companions use, which *is* exercised by
tests — but the specific claim "InvisiProxy renders correctly inside ZoFHub's
frame" is untested here and is stated as such.

---

**Related:** [documentation map](../README.md#-documentation) · [how it all fits together](../guides/HOW-IT-WORKS.md) · [the optional tunnel behind it](SINGBOX.md) · [the mirror gate in front of it](MASQR.md) · [debugging blocked destinations](../guides/DEBUGGING.md)
