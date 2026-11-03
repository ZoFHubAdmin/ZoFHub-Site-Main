# sing-box integration

> **Status: WIRED. Two independent halves — read the second one.**
>
> **1. Telemetry (opt-in, inert by default).**
> [`lib/singbox.mjs`](../../lib/singbox.mjs) is read by `GET /api/admin/proxy` and
> rendered by the admin console's **Proxy** view. With `SINGBOX_API_URL` unset —
> the default — the panel shows *"Not connected"*. It never shows zeroes.
>
> **2. Egress (ENFORCED — fail-closed).**
> Every connection this server makes **on a visitor's behalf** crosses sing-box,
> or is **refused**: the Wisp tunnel's TCP streams
> ([`lib/singbox-socket.mjs`](../../lib/singbox-socket.mjs)) and every server-side
> fetch of a URL we did not write — embeds, thumbnails, assets, link checks,
> importers ([`lib/egress.mjs`](../../lib/egress.mjs)). This is not a dashboard: it
> changes where the site's traffic leaves from. There is **no direct fallback** — a
> fallback fires exactly when the daemon is down, which is exactly when it would
> expose this server's address — and in production nothing can switch it off:
> `SINGBOX_ALLOW_DIRECT`, `SINGBOX_REQUIRE=0` and `SINGBOX_EGRESS=0` are
> **ignored** when `NODE_ENV=production`. Underneath both paths sits a
> process-level guard ([`lib/egress-guard.mjs`](../../lib/egress-guard.mjs)) that
> refuses any other outbound connection that is not loopback or a named
> infrastructure host. See
> [§0c](#0c-egress--the-half-that-actually-carries-traffic),
> [§0d](#0d-server-side-fetches), [§0e](#0e-the-backstop-guard) and
> [§0g](#0g-deploying-it-what-has-to-be-true).
>
> **Two supervision modes.** *Managed* (the default): ZoFHub renders the config,
> validates it with `sing-box check`, spawns the daemon, restarts it with backoff
> if it dies, and kills it on shutdown. *Read-only* (`SINGBOX_MANAGED=0`): you
> run the daemon yourself, or not at all, and ZoFHub only reads it.
>
> What is **not** vendored: sing-box's source. The binary arrives at build time,
> **pinned** to one upstream release — built by the Dockerfile, or downloaded and
> SHA-256-verified by `npm run singbox:install` on a native Node runtime such as
> Render's ([§0](#0-getting-the-binary)).
>
> The configs in [`deploy/singbox/`](../../deploy/singbox/) are **starting
> templates** written against the sing-box 1.11+ schema. They parse as valid JSON
> and their security-relevant properties are asserted by tests, but they have not
> been run against a live daemon — and sing-box changes its config schema between
> major versions. Run `sing-box check -c config.json` before trusting either.

### Licensing and attribution

sing-box is **GPL-3.0** and carries an additional clause: *"no derivative work
may use the name or imply association with this application without prior
consent."*

ZoFHub complies by not being a derivative work of it. The integration talks to
sing-box's **SOCKS5 inbound and HTTP management API over the network**, between
two separate processes — the same relationship ZoFHub already has with the
AGPL-3.0 proxy engines it runs beside. No sing-box source or binary is vendored,
linked or compiled in: `docker-compose.yml` pulls the unmodified upstream image,
the Dockerfile builds an unmodified pinned release, and the build-time installer
downloads the unmodified official release asset into `.singbox/`, which is
git-ignored. So ZoFHub's own license is unaffected, and the GPL's copyleft does
not reach it.

On the name clause: this documentation and the admin panel refer to sing-box
**factually** — "an instance you run" — and the console labels the card
*"sing-box (external)"*. ZoFHub is **not affiliated with, endorsed by, or
associated with** sing-box or its authors, and nothing here should be read as
implying otherwise.

---

## How the two telemetry sources differ

`GET /api/admin/proxy` reports **two** things, and they must not be confused:

| Block | Source | Trust |
|---|---|---|
| `tunnels`, `engines` | Measured **in-process** — the Wisp tunnel and the engines from `proxy-engine/mount.mjs` | Cannot disagree with the server; they *are* the server |
| `singbox` | Read over the network from a **separate daemon you run** | Only as good as the daemon; may be absent entirely |

The `singbox` block is the one that can be missing, so it is the one designed to
fail loudly. Every non-success returns `{ reachable: false, reason }` and
**carries no statistics at all** — no `live`, no byte counts. A dashboard
therefore *cannot* render "0 connections, 0 bytes" for a daemon that never
answered, because those fields do not exist on a failure. That distinction is
asserted by test, for all seven failure modes.

---

## 0. Getting the binary

sing-box is Go; ZoFHub is Node. There is no way to link one into the other —
even fully vendored it compiles to a standalone binary that runs as its own
process. So the binary is built or downloaded, not imported. There are two
routes, and they install **the same pinned release**.

**A native Node runtime (Render, as `render.yaml` is written).** The build runs
`npm run singbox:install` after `npm ci`
([`tools/install-singbox.mjs`](../../tools/install-singbox.mjs)):

1. it reads [`data/singbox-release.json`](../../data/singbox-release.json) — a
   version and, per platform, the **SHA-256** of the official release asset,
   committed to this repository;
2. it downloads that asset from `github.com/SagerNet/sing-box/releases` over TLS;
3. it **refuses the file unless its SHA-256 equals the committed digest**, so what
   runs is the exact file that was reviewed when it was pinned, whatever a release
   page happens to serve on the day of a build;
4. it extracts the one binary into `.singbox/bin/` (git-ignored — never
   committed), marks it executable and runs `sing-box version` to prove it is the
   one asked for.

The supervisor looks in `.singbox/bin/` before it falls back to a bare `sing-box`
on `PATH`: the pinned one is the verified one, and the native runtime has nothing
on `PATH` at all. The installer is idempotent, and **it fails the build on any
problem** — a failed build leaves the previous deploy running, whereas a build
that "succeeds" without the daemon would replace a working site with one that
refuses every proxied connection.

**Docker.**

```bash
# Pinned, reproducible, verified against Go's checksum database.
docker build -t zofhub .                       # builds the pinned default
```

The version is pinned in the Dockerfile (`ARG SINGBOX_VERSION`, currently
`v1.14.1`) and the build is ON by default, because sing-box carries every proxied
connection rather than sitting beside it. A test fails if the Dockerfile and
`data/singbox-release.json` name different versions.

**The Go image and the sing-box tag are coupled — bump them together.**
v1.14.1's `go.mod` requires `go 1.25.5`, and an older toolchain fails the build
outright rather than warning, so stage 1 pins `golang:1.25.14-alpine`. Raising
`SINGBOX_VERSION` without checking its `go.mod` is the way this build breaks.
Pass `--build-arg SINGBOX_VERSION=none` to skip the stage and build a binary-free
image. That image **starts**, but it refuses every proxied stream and server-side
fetch (there is no direct fallback — §0c); use it only where the daemon arrives
some other way (`SINGBOX_BIN`).

**Moving to a newer release** is three edits: `version` and every digest in
`data/singbox-release.json` (the comment in that file gives the `gh api` call that
prints GitHub's own digests), and the Dockerfile's `SINGBOX_VERSION`.

**Why not vendor the source?** ZoFHub's `LICENSE` is proprietary — *"NOT an
open-source license"*, forbidding redistribution — and this repo is pushed to a
remote. GPL-3.0 §5 requires any distributed work containing GPL code to be
licensed under the GPL. Those terms are mutually exclusive, so a copy of
sing-box's source in this tree would both infringe its license and void
ZoFHub's. Building a pinned upstream release inside the image keeps the two
works separate and keeps both licenses intact.

---

## 0b. Managed mode

| | Read-only (`SINGBOX_MANAGED=0`) | Managed (default) |
|---|---|---|
| Who starts the daemon | You | ZoFHub |
| Config | Yours | Rendered from `config.template.json` |
| Validated before start | — | `sing-box check`, every time |
| On crash | Your supervisor | Restart, backoff 1s → 60s |
| On shutdown | Yours | SIGTERM → SIGKILL after 3s |
| Needs the binary in the image | No | Yes |

The `sing-box check` step is the load-bearing one. A daemon started with a bad
config exits instantly; supervised naively that is a hot restart loop —
hundreds of spawns a second, a filled disk, a pinned core. Validating first
turns a crash loop into one error line.

**A missing binary is not a bad config, and no longer pretends to be.** ENOENT
surfaces from `sing-box check`, not from `spawn`, so it used to take the
"config rejected" branch: it retried every 60 seconds forever and logged
`config rejected: spawn sing-box ENOENT` for a config that was perfectly valid.
Both halves of that were wrong. `checkConfig` now flags `missingBinary`
separately, and the supervisor **gives up** — one log line, no retry loop,
`gaveUp: "binary not found"` in `/api/admin/proxy`, and every proxied connection
is refused until a binary is installed (there is no direct fallback — §0c). A
rejected *config* still backs off 1s → 60s, because a redeploy can fix that one.

`/api/admin/proxy` reports the daemon's API (`singbox`) and the supervisor
(`singboxProcess`) **separately**, because "we never launched it" and "we
launched it and it is crash-looping" are different problems and one number
cannot say both.

---

## 0c. Egress — the half that actually carries traffic

Everything above is observation. This is the part that changes behaviour, and it
is **on by default**.

[`lib/singbox-socket.mjs`](../../lib/singbox-socket.mjs) hands the Wisp tunnel a
socket class that dials through sing-box's SOCKS5 inbound instead of connecting
straight out of Node. Every TCP stream the proxy opens for a visitor goes
through it, so sing-box carries the site's real traffic and the Clash API
reports actual connections rather than an empty table.

```
browser → /wisp/ → wisp-js ServerConnection → GuardedTCPSocket
        → (governor check + resolveGuarded)  → SingboxTCPSocket
        → SOCKS5 CONNECT (ATYP by target)   → sing-box → origin
```

**No upstream patch.** wisp-js supports an injected socket class: `routeRequest`
threads `conn_options` into `new ServerConnection(ws, path, conn_options)`,
which reads `{TCPSocket}` out of it. ZoFHub passes its class through that
documented extension point, so the AGPL engine stays byte-for-byte unmodified —
which is what keeps `CREDITS.md`'s §13 offer honest. That contract belongs to
somebody else's package, so
[`test/wisp-egress-contract.test.mjs`](../../test/wisp-egress-contract.test.mjs)
pins it against the **bundle require() actually loads**: a dependency bump that
stopped honouring the option would otherwise break nothing visible and silently
send every byte out of Node again.

**The route is matched exactly, and that is a security control.** wisp-js serves
two protocols on one path and picks by URL shape: a trailing `/` gets the Wisp
protocol, anything else gets `WSProxyConnection` — a host:port relay addressed
as `/wisp/example.com:443` that ignores `conn_options` and hard-codes its own
socket. So a prefix match would leave a working proxy that bypasses sing-box,
bypasses `egressStats()`, and ignores the egress policy. `routeProxyUpgrade`
accepts exactly `/wisp/` and answers everything else `400`. (Not an SSRF hole in
either branch — wsproxy runs the same destination filter. What the bypass leaked
was the egress path, not the target.)

**Egress covers TCP only — so UDP is switched off.** wisp-js selects the socket
class per stream type:

```js
let SocketImpl = type === stream_types.TCP ? this.TCPSocket : this.UDPSocket;
```

ZoFHub injects `TCPSocket` and nothing else, so a **UDP** stream never touched
`SingboxTCPSocket` at all — it left the Node process directly, outside the
daemon, outside `egressStats()`, and outside the egress policy. An operator who
wanted a guarantee that their server's own IP is never exposed did not get it for
UDP.

Nothing in ZoFHub uses UDP through the tunnel, so
[`lib/wisp-policy.mjs`](../../lib/wisp-policy.mjs) sets `allow_udp_streams: false`
and the hole is closed. `WISP_ALLOW_UDP=1` is honoured **only** where a developer
has permitted direct egress (outside production); everywhere else it is ignored,
with a warning that says why — and the backstop guard (§0e) refuses direct UDP
anyway. If UDP is ever genuinely needed, the fix is a `UDPSocket` class that dials
through sing-box — not the flag.

**Failure is a refusal, not a leak.** An earlier version fell back to a direct
connection when the daemon did not answer — "degraded and visible beats broken
and mysterious". That is the right trade for a dashboard and the wrong one for a
control whose purpose is that this server's address is never exposed to a
destination: a fallback fires exactly when the daemon is down, which is exactly
when an attacker (or a crash loop) would want it to. A refused stream is a
visible, retryable error; a silent direct one is a leak nobody sees.

So a stream the daemon cannot carry is **closed** (Wisp close reason *network
error*), a server-side fetch fails with `EgressUnavailableError` (`code:
'EEGRESS'`, shown to a visitor as a `502`), and both are counted. The supervisor
restarts a dead daemon with backoff, and the first request after it is back
works — nothing needs a redeploy.

| Setting | Default | Effect |
|---|---|---|
| `SINGBOX_SOCKS` | `127.0.0.1:2080` | where the mixed/SOCKS inbound listens |
| `SINGBOX_DIAL_TIMEOUT_MS` | `8000` | bounds a stalled handshake |
| `SINGBOX_ALLOW_DIRECT=1`, `SINGBOX_REQUIRE=0`, `SINGBOX_EGRESS=0` | unset | **Development only.** Any one of them lets a developer with no sing-box binary on their laptop connect directly when the daemon cannot carry a stream; the boot log says so. **When `NODE_ENV=production` all three are ignored** — and the boot log says that too. |

[`lib/egress-policy.mjs`](../../lib/egress-policy.mjs) is the whole rule, in one
function (`egressPolicy`), read by every path — so there is exactly one place that
decides, and `singboxEgress.policy.mode` in `/api/admin/proxy` (`enforced` or
`direct-permitted`) says which answer it gave. The same module's
`EgressUnavailableError` is deliberately **not** the SSRF module's
`BlockedDestinationError`: that one means "you asked for somewhere we never go" (a
client error), this one means "we would have gone, and the egress path is down" (a
server-side outage, to be retried).

`egressStats()` (in `/api/admin/proxy` as `singboxEgress`) reports
`viaSingbox` / `viaDirect` / `refused` for tunnel streams, `fetchViaSingbox` /
`fetchDirect` / `fetchRefused` for server-side fetches, the `policy`, and a
`singboxSharePct` — the one number worth alerting on. It is **`null`, not `0`**,
before anything has been proxied, because 0% of zero streams is no data rather
than a fault. In production `viaDirect` and `fetchDirect` stay at zero.

### Verified against a real daemon, not a mock

The unit tests speak real SOCKS5 over real sockets, but against a mock server —
so they cannot confirm that *sing-box itself* accepts what this code sends. That
was checked separately, against an actual **sing-box 1.14.1** binary:

| Check | Result |
|---|---|
| `sing-box check` on the rendered default template | **passes** — `mixed` inbound and `action: reject` are valid for 1.14.x |
| Supervisor renders → validates → spawns it | `[singbox] supervisor: running (ok)`, 0 restarts |
| `curl --socks5-hostname` straight through the inbound | `HTTP 200` |
| A real page fetched through `/wisp/` end to end | `HTTP/1.1 200 OK`, 1067 bytes |
| `singboxEgress` after that fetch | `viaSingbox=1, viaDirect=0, share=100%` |
| The daemon's own Clash counter | `downloadBytes=1067` — **matches the bytes the tunnel client received** |
| The daemon killed under a running server and held down | Wisp streams closed with *network error*; uncached embeds answered `502`; `fetchDirect` stayed `0`; and the server process held **no connection to anything but its database**, checked with `netstat` |
| The daemon released | the supervisor restarted it; the next Wisp stream and the next embed worked, with no redeploy |
| `npm run verify-proxy`, all four engines | Ultraviolet, Scramjet, GUST and HORIZON each rendered `http://example.com/` in a real Chromium, through the enforced path |

The byte-counter row is the one that matters most: it means the traffic
genuinely crossed the daemon rather than merely being reported as having done so.
The outage rows are the evidence that the control fails closed — that "the daemon
is down" produces refusals, not connections from this host.

**What this does not weaken.** wisp-js resolves and filters the destination
itself *before* connect, refusing loopback and private targets regardless of
which socket class is injected, and both shipped configs reject private ranges
again at the routing layer. Two independent checks, neither relying on the other
being correct.

**DNS is resolved LOCALLY, not by the daemon — and that is a deliberate
trade.** An earlier version of this page claimed remote DNS with "no local
leak". That is **not** what the default path does. `GuardedTCPSocket`
(`server.js`) calls `resolveGuarded()` *before* dialling, checks that every
address the name answers with is public, and then replaces the hostname with the
address it validated. That is what closes the DNS-rebinding window between the
policy decision and the connection — without it, an approved name could answer
with a public address for the check and a private one for the dial.

The cost is real and worth stating: **this server's resolver sees every proxied
hostname**, so sing-box is not providing DNS privacy in the default
configuration. What it provides is egress — the origin sees the daemon's
address, not this server's.

Because the target is usually already an address by then,
`buildConnectRequest()` encodes the CONNECT by **what the target actually is**:
`ATYP=0x01` for an IPv4 literal, `0x04` for IPv6, `0x03` for a real hostname.
Announcing an address as a domain name asks the daemon to re-parse it; sing-box
tolerates that, but RFC 1928 has explicit types and not every SOCKS server
guesses. A hostname still goes out as `ATYP=0x03`, so remote resolution works
wherever the caller has not already resolved.

---

## 0d. Server-side fetches

The Wisp tunnel is one way a visitor makes this server connect out. The other is
asking it to fetch a URL: a game embed, a thumbnail, an asset, a link check, a
catalog import. All of those go through
[`lib/safe-fetch.mjs`](../../lib/safe-fetch.mjs), which used to dial straight from
Node. It now hands `node:http` / `node:https` an `Agent` whose sockets are tunnels
through the daemon ([`lib/egress.mjs`](../../lib/egress.mjs)) — through
`Agent.createConnection`, the one supported seam for "connect somewhere else".
Nothing in Node is patched and nothing global changes: only requests handed this
agent are affected.

```
safeFetch → validating resolver (every answer public) → the validated ADDRESS
          → SOCKS5 CONNECT by IPv4/IPv6 literal → sing-box → origin
          → TLS over the tunnel, verified against the original HOSTNAME
```

What stays exactly as it was is the SSRF defence. The name is still resolved by
the validating resolver first and **every** answer must be public; what is dialled
is that validated *address*, never the name, so neither the daemon nor a
rebinding resolver can be steered to a private target between the check and the
connection. The daemon's own routing layer refuses private ranges again — a
second, independent check. TLS is verified against the hostname the caller asked
for (SNI and certificate name), not the address dialled, and `rejectUnauthorized`
is not something a caller can turn off.

Two choices worth knowing. **One request per tunnel** (`keepAlive: false`): a
pooled socket was dialled — and its address validated — for some *earlier*
request, and reusing it would skip exactly the check this module exists to make.
And **at most three addresses** are tried for one name, because an IPv6 answer
from a host with no IPv6 route is the common case and this is a courtesy, not a
scan.

A fetch that cannot cross the daemon fails with `EgressUnavailableError` and is
counted in `fetchRefused`. `waitForSingbox()` lets boot-time work (the thumbnail
job, the TLS probe) wait for the daemon rather than start a burst of refusals
before it is up.

---

## 0e. The backstop guard

§0c and §0d fix the two ways we *know* a visitor can make this server connect
out. That is a list of the doors someone remembered.
[`lib/egress-guard.mjs`](../../lib/egress-guard.mjs) is the wall: it wraps
`net.Socket.prototype.connect` and the `dgram` send/connect methods, and refuses
every outbound connection that is neither

- **loopback** — sing-box's own inbound, the Clash API, health probes; nor
- **a named infrastructure host** — a host the *operator* configured.

Every outbound TCP connection Node makes — `node:http`, `node:https`, `node:tls`,
the built-in `fetch`, the Redis client, a WebSocket client — bottoms out in
`net.Socket.prototype.connect`, so wrapping that one method covers code we did not
write and cannot audit line by line. A code path nobody has written yet, a
dependency that starts making its own requests, or a regression in §0c or §0d now
fails with `EEGRESS_BLOCKED`, a counter and a log line, instead of quietly
exposing this server's address.

**The allowlist is derived from the environment**, not written in code: the
Supabase URL, `REDIS_URL` / `UPSTASH_REDIS_URL`, `SINGBOX_API_URL`, the host in
`SINGBOX_SOCKS`, `api.resend.com` only when `RESEND_API_KEY` is set, `sideshift.ai`
only when it is the selected swap provider, the `PROXY_*_URL` companion engines
this server only *probes*, and anything in `EGRESS_DIRECT_ALLOW` (comma
separated; `host` is exact, `*.suffix` is any subdomain but not the apex).
Hostnames only — a connection URL carries credentials, and only the host is kept.
A host that was never configured can never be reached, and adding a database needs
no code change.

**Why infrastructure may go direct and visitor traffic may not.** Routing the
database through a daemon that the site itself supervises would make a daemon
restart an outage of the whole site. So those hosts are *named*, and nothing else
is let through.

Refusals are recorded as `egress_bypass_blocked` security events and shown under
`egressGuard` in `/api/admin/proxy` — hostnames and counts only, never a URL, a
path or a credential. In production the guard is always in `enforce` mode and
`EGRESS_GUARD` is ignored; elsewhere `EGRESS_GUARD=warn` logs what would have been
blocked without blocking it.

**What it cannot see, said plainly.** DNS lookups are not TCP connections: a name
resolved by this process is still seen by this host's resolver (§0c). It guards
*this* process — a child process is a different process, so each installs its own
(`tools/fetch-y8-thumbs.mjs` does). And it is **not a sandbox**: code that can run
arbitrary JavaScript in this process can restore the original method. The goal is
the failure that actually occurs — accident and regression — not a hostile
dependency, which no in-process control can stop.
[`test/egress-inventory.test.mjs`](../../test/egress-inventory.test.mjs) is its
counterpart at review time: it scans the server code and fails if a file starts
dialling out on its own.

---

## 0f. Engines that run in the visitor's browser

Everything above is the server. Two of the built-in engines, GUST and HORIZON
(vendored under `proxy-engine/assets/`), are whole browser apps whose *code runs
in the visitor's browser* and which chose their own relay. Left alone they could
be pointed at a Wisp server of the visitor's choosing — typed into the settings,
restored from storage, HORIZON's *Reset* button's upstream default, the bundled
Discord client's saved relay — and GUST's proxied pages could open native
WebSockets that skip the tunnel altogether. Each of those is traffic that belongs
to this site leaving without crossing sing-box.

They are patched to pin the tunnel to this site's own `/wisp/` (which §0c carries
through the daemon) and to open WebSockets through the tunnel
(`libcurl.WebSocket`).
[`test/proxy-same-origin-wisp.test.mjs`](../../test/proxy-same-origin-wisp.test.mjs)
fails if a stored, typed or default relay on another origin ever returns. The
patches are recorded as modifications in `lib/licenses.mjs` and
[`docs/CREDITS.md`](../CREDITS.md), as the AGPL-3.0 requires.

The **companion engines** (`PROXY_NAUTILUS_URL`, `PROXY_DAYDREAM_URL`, …) are
separate, operator-hosted services that this server only probes. What those
services do with a visitor's traffic is outside this server, and outside what it
can enforce.

---

## 0g. Deploying it: what has to be true

The daemon is part of the site now, not an optional extra, so a deploy has to
carry it.

- **Render (native Node).** `render.yaml`'s `buildCommand` is
  `npm ci --omit=dev && npm run singbox:install`; no dashboard change is needed.
  If the pinned download cannot be fetched or does not match its digest, **the
  build fails** — on purpose, so the previous deploy keeps serving.
- **Docker.** The default build carries the daemon (§0).
- **Check it after every deploy.** `GET /api/admin/proxy` (admin) should show
  `singboxProcess.running: true`, `singboxEgress.policy.mode: "enforced"`, a
  growing `viaSingbox` / `fetchViaSingbox`, `viaDirect` and `fetchDirect` at
  **0**, and `egressGuard.blocked` at 0 in steady state. A non-zero
  `egressGuard.blocked` is a real finding: `lastBlocked.origin` names the file that
  tried to connect out.
- **Infrastructure other than Supabase, Redis, Resend and sideshift** that has to
  be reached directly goes in `EGRESS_DIRECT_ALLOW` (declared in `render.yaml`
  without a value). Never put a destination a visitor chose there.
- **If the daemon is down,** proxy streams and every server-side fetch (game-embed
  wrappers, thumbnail fetches, link checks) are refused until the supervisor
  brings it back. The catalog, accounts and AI — which do not use the proxy — keep
  working.

---

## 1. Deployment shape (the part that has to be true first)

> This section is about the **optional REALITY profile**, where sing-box owns a
> public `:443`. The default egress daemon is a loopback-only SOCKS inbound that
> ZoFHub spawns itself inside the same container (§0b) and needs none of this.

ZoFHub currently deploys as a **single Node container** (`Dockerfile`, one web
service in `render.yaml`). sing-box is a separate long-running daemon that binds
its own ports and, for a REALITY inbound on :443, needs to own the TLS
termination that Render's own edge currently owns.

That means sing-box cannot simply be "added" to the existing Render web
service. It needs either:

- a **second service** (a VPS or container host where you control the network
  edge and can bind :443 directly), with ZoFHub's Node app behind it; or
- a **sidecar container** in a host that supports multi-container pods, with the
  Clash API bound to loopback and never exposed publicly.

Until one of those is true there is nothing for the panel to read, and the
`singbox` block reports `reachable: false` — which is the correct answer, not a
failure. [`deploy/singbox/docker-compose.yml`](../../deploy/singbox/docker-compose.yml)
is the two-service arrangement that satisfies this.

---

## 2. A REALITY inbound (draft — run `sing-box check` first)

REALITY needs a real, reachable TLS site to borrow a handshake from
(`handshake.server`); it does not terminate its own certificate. The private key
is generated with `sing-box generate reality-keypair` and belongs in the
environment, never in a committed file.

```jsonc
{
  "log": { "level": "warn", "timestamp": true },

  // Loopback-only management API. This is the ONE thing the ZoFHub adapter would
  // read. It must never bind a public interface: anyone who reaches it can
  // rewrite routing and read every connection.
  "experimental": {
    "clash_api": {
      "external_controller": "127.0.0.1:9090",
      "secret": "${SINGBOX_API_SECRET}"        // long random; injected, not committed
    },
    "cache_file": { "enabled": true, "path": "/var/lib/sing-box/cache.db" }
  },

  "inbounds": [
    {
      "type": "vless",
      "tag": "vless-reality-in",
      "listen": "0.0.0.0",
      "listen_port": 443,
      "users": [
        // One entry per client. `name` is a label for the panel; the uuid IS the
        // credential. Cycling a client = replace its uuid and hot-reload.
        { "name": "owner",   "uuid": "${SINGBOX_UUID_OWNER}",   "flow": "xtls-rprx-vision" }
      ],
      "tls": {
        "enabled": true,
        "server_name": "www.microsoft.com",   // must match handshake.server below
        "reality": {
          "enabled": true,
          "handshake": { "server": "www.microsoft.com", "server_port": 443 },
          "private_key": "${SINGBOX_REALITY_PRIVATE_KEY}",
          "short_id": ["${SINGBOX_REALITY_SHORT_ID}"]
        }
      },
      // bounded so a stalled handshake cannot pin a connection open forever —
      // the same idle-reclaim discipline server.js applies to the Wisp tunnel.
      "multiplex": { "enabled": true, "padding": true }
    }
  ],

  "outbounds": [
    { "type": "direct", "tag": "direct" },
    { "type": "block",  "tag": "block" }
  ],

  // Granular routing. `final` is the default; rules match before it.
  "route": {
    "rules": [
      // Never let the tunnel reach the management API or the loopback host.
      { "ip_cidr": ["127.0.0.0/8", "::1/128"], "outbound": "block" }
    ],
    "final": "direct"
  }
}
```

Validate before trusting: `sing-box check -c config.json`, then
`sing-box run -c config.json`.

---

## 3. Client connection strings

sing-box derives each client's connection string from the inbound above. These
are documented for you to hand to a client app; the admin panel does **not**
generate or store them today — it is read-only telemetry, and minting credentials
is a write path that belongs behind `config.write` with `sing-box check` in the
loop (see section 4).

- **VLESS-REALITY URI** (what a client app imports):
  `vless://<uuid>@<host>:443?security=reality&sni=www.microsoft.com&pbk=<public-key>&sid=<short-id>&flow=xtls-rprx-vision&type=tcp#zofhub-owner`
- **Cycling a credential** is: generate a new uuid, replace the user's `uuid` in
  the inbound, hot-reload (section 4), hand the client the new URI. The old
  string dies the instant the reload lands — there is no revocation list to
  maintain because the credential IS the uuid.

The `pbk` (public key) is the public half of the REALITY keypair and is safe to
put in a URI; the private key never leaves the server environment.

---

## 4. The adapter (shipped and registered)

Implemented in [`lib/singbox.mjs`](../../lib/singbox.mjs) and read by
`GET /api/admin/proxy`. Reproduced here in abridged form; the file is the
authority.

It is written so its output **cannot** be mistaken for the in-process telemetry:
every failure returns `{ reachable: false, reason }` and carries no statistics,
so the panel says "no such service" rather than "no traffic". It also never
rejects — one dead daemon must not be able to take down the whole proxy
endpoint, which awaits it inline.

Verified against a mock Clash API across all five states (connected, not
configured, wrong secret, daemon down, non-Clash response).

```js
// lib/singbox.mjs (abridged — see the real file for the full error taxonomy).
// Registered in server.js; inert while SINGBOX_API_URL is unset.
const BASE = process.env.SINGBOX_API_URL || '';          // e.g. http://127.0.0.1:9090
const SECRET = process.env.SINGBOX_API_SECRET || '';

export async function singboxTelemetry({ timeoutMs = 1500 } = {}) {
  if (!BASE) return { reachable: false, reason: 'not-configured' };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    // Clash API: /connections is the live connection table; /traffic streams
    // up/down bytes. One cheap poll of /connections is enough for a dashboard.
    const r = await fetch(`${BASE}/connections`, {
      headers: SECRET ? { authorization: `Bearer ${SECRET}` } : {},
      signal: ctrl.signal,
    });
    if (!r.ok) return { reachable: false, reason: `http-${r.status}` };
    const d = await r.json();
    const conns = Array.isArray(d.connections) ? d.connections : [];
    return {
      reachable: true,
      live: conns.length,
      // Totals are cumulative counters from the daemon, surfaced as-is.
      uploadBytes: Number(d.uploadTotal) || 0,
      downloadBytes: Number(d.downloadTotal) || 0,
    };
  } catch (e) {
    // Abort, refused connection, or unreachable host — all "no such service",
    // never a zero that reads as "healthy but idle".
    return { reachable: false, reason: e.name === 'AbortError' ? 'timeout' : 'unreachable' };
  } finally {
    clearTimeout(timer);
  }
}
```

### Hot-reload of routing — specified, NOT implemented

The adapter is **read-only**. The one write the panel would perform is
`PUT {external_controller}/configs?force=true` with `{ "path": "config.json" }`,
which tells sing-box to re-read its config from disk without dropping active
connections. The panel would write the edited config to that path first, then
issue the reload.

This is deliberately not built yet, for two reasons worth stating:

1. **It cannot be tested here.** A reload is only meaningfully verified against
   a real daemon holding real connections. Shipping an untested write path
   against a config file is how you get a proxy that silently stops routing.
2. **It needs a config editor to be useful**, and a malformed config accepted by
   the panel becomes an outage — so it needs `sing-box check` in the loop
   before the reload, not after.

When it is built, gate it behind the `config.write` permission
(see [`lib/admin-rbac.mjs`](../../lib/admin-rbac.mjs)) — it is exactly the class of
running-config change the static service token is already denied.

---

## 5. Environment variables

The ZoFHub-side variables are **declared** in `.env.example` and, where they matter
in production, `render.yaml`. The REALITY and UUID ones are consumed by sing-box
itself when rendering the REALITY template, not by ZoFHub.

| Variable | Purpose |
|---|---|
| `SINGBOX_SOCKS` | Where the mixed/SOCKS inbound listens. Default `127.0.0.1:2080`. |
| `SINGBOX_DIAL_TIMEOUT_MS` | Bounds a stalled SOCKS handshake. Default 8000. |
| `SINGBOX_ALLOW_DIRECT`, `SINGBOX_REQUIRE=0`, `SINGBOX_EGRESS=0` | **Development-only** opt-outs of the fail-closed egress (§0c). **Ignored when `NODE_ENV=production`**, and deliberately not declared in `render.yaml`. |
| `EGRESS_DIRECT_ALLOW` | Extra hosts this server may connect to *directly*, comma separated (`host` exact, `*.suffix` any subdomain). Infrastructure only (§0e). |
| `EGRESS_GUARD` | `enforce` / `warn` / `off`, **outside production only** (§0e). |
| `SINGBOX_MANAGED` | `0` stops ZoFHub supervising the daemon. **Default on.** |
| `SINGBOX_BIN` / `SINGBOX_CONFIG_PATH` / `SINGBOX_CONFIG_TEMPLATE` | Binary, rendered-config path (written `0600`), template override. |
| `SINGBOX_API_URL` | Loopback Clash API, e.g. `http://127.0.0.1:9090`. Unset ⇒ adapter reports `not-configured`; managed mode sets it. |
| `SINGBOX_API_SECRET` | Bearer secret for that API. **Generated at boot when unset**, so the default deploy needs no configuration. |
| `SINGBOX_REALITY_PRIVATE_KEY` | REALITY profile only. From `sing-box generate reality-keypair`. Server-only. |
| `SINGBOX_REALITY_SHORT_ID` | REALITY profile only. |
| `SINGBOX_UUID_*` | REALITY profile only; one per client credential. Cycling = replacing one of these. |

`SINGBOX_API_TIMEOUT_MS` (default 1500) bounds how long `/api/admin/proxy` will
wait for the daemon, so a hung sing-box cannot hang the admin console.

---

## 6. Files

| Path | What it is |
|---|---|
| [`lib/singbox.mjs`](../../lib/singbox.mjs) | The read-only telemetry adapter. Registered. |
| [`lib/singbox-socket.mjs`](../../lib/singbox-socket.mjs) | **The egress path.** SOCKS5 dialler injected into the Wisp tunnel. |
| [`lib/egress-policy.mjs`](../../lib/egress-policy.mjs) | The one rule: may a visitor-driven connection leave directly? No — a developer outside production may opt in, loudly (§0c). |
| [`lib/egress.mjs`](../../lib/egress.mjs) | Server-side fetches through the daemon (§0d). |
| [`lib/egress-guard.mjs`](../../lib/egress-guard.mjs) | The process-level backstop: nothing else leaves (§0e). |
| [`tools/install-singbox.mjs`](../../tools/install-singbox.mjs) | Build-time install of the pinned, SHA-256-verified binary (§0). |
| [`data/singbox-release.json`](../../data/singbox-release.json) | The pin: version and per-platform digests. |
| [`lib/singbox-supervisor.mjs`](../../lib/singbox-supervisor.mjs) | Managed mode: render, validate, spawn, restart, stop. |
| [`proxy-engine/mount.mjs`](../../proxy-engine/mount.mjs) | `routeProxyUpgrade` — exact `/wisp/` match, closing the wsproxy bypass. |
| `Dockerfile` | Stage 1 builds the pinned release; on by default. |
| [`test/singbox.test.mjs`](../../test/singbox.test.mjs) | 28 tests: all seven failure modes, plus both shipped profiles. |
| [`test/singbox-supervisor.test.mjs`](../../test/singbox-supervisor.test.mjs) | 26 tests: defaults, rendering, config-as-credential, wiring, missing-binary give-up. |
| [`test/singbox-egress.test.mjs`](../../test/singbox-egress.test.mjs) | Real SOCKS5 over real sockets, refusal when the daemon is down, the development opt-out, CONNECT address types. |
| [`test/wisp-egress-contract.test.mjs`](../../test/wisp-egress-contract.test.mjs) | 9 tests pinning wisp-js's injection point and the exact-path match. |
| [`test/egress-policy.test.mjs`](../../test/egress-policy.test.mjs) | Production ignores every opt-out; a developer's is explicit and announced. |
| [`test/egress-agent.test.mjs`](../../test/egress-agent.test.mjs) | Server-side fetches against real mock daemons: validated address dialled, refusal, no direct retry. The TLS group skips itself, with a stated reason, on a machine whose antivirus intercepts TLS. |
| [`test/egress-guard.test.mjs`](../../test/egress-guard.test.mjs) | Every `net`/`dgram` call shape, the derived allowlist, enforce/warn, production always enforcing. |
| [`test/egress-inventory.test.mjs`](../../test/egress-inventory.test.mjs) | Static scan of the server code: nothing dials out on its own, and nothing outside `test/` can switch egress to direct. |
| [`test/proxy-same-origin-wisp.test.mjs`](../../test/proxy-same-origin-wisp.test.mjs) | GUST and HORIZON stay pinned to this site's own `/wisp/` (§0f). |
| [`test/singbox-install.test.mjs`](../../test/singbox-install.test.mjs) | The installer: digest mismatch refuses, an intact install is left alone, the pin matches the Dockerfile. |
| [`deploy/singbox/config.template.json`](../../deploy/singbox/config.template.json) | **Default profile:** loopback mixed/SOCKS inbound — the egress path. Verified with `sing-box check` against a real 1.14.1 binary. |
| [`deploy/singbox/config.reality.template.json`](../../deploy/singbox/config.reality.template.json) | **REALITY profile**, for a host where you own `:443`. Select it with `SINGBOX_CONFIG_TEMPLATE`. |
| [`deploy/singbox/docker-compose.yml`](../../deploy/singbox/docker-compose.yml) | The two-service shape that lets sing-box own `:443`. |
| `server.js` → `GET /api/admin/proxy` | Serves the `singbox` block beside in-process `tunnels`. |
| `admin-ui/assets/admin.js` → Proxy view | Renders it, or "not connected". |
---

**Related:** [documentation map](../README.md#-documentation) · [how it all fits together](../guides/HOW-IT-WORKS.md) · [the egress policy that governs what reaches it](INVISIPROXY.md) · [go-live checklist](../guides/GO-LIVE.md)
