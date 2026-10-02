# sing-box integration

> **Status: WIRED. Two independent halves — read the second one.**
>
> **1. Telemetry (opt-in, inert by default).**
> [`lib/singbox.mjs`](../../lib/singbox.mjs) is read by `GET /api/admin/proxy` and
> rendered by the admin console's **Proxy** view. With `SINGBOX_API_URL` unset —
> the default — the panel shows *"Not connected"*. It never shows zeroes.
>
> **2. Egress (ON BY DEFAULT).**
> [`lib/singbox-socket.mjs`](../../lib/singbox-socket.mjs) routes **every TCP stream
> the proxy opens on a visitor's behalf** through sing-box's local SOCKS5
> inbound. This is not a dashboard: it changes where the site's traffic leaves
> from. It is enabled unless `SINGBOX_EGRESS=0`, and when no daemon answers it
> **falls back to a direct connection and counts it** — degraded and visible
> beats broken and mysterious. Operators who would rather fail than expose the
> server's own address set `SINGBOX_REQUIRE=1`. See
> [§0c](#0c-egress--the-half-that-actually-carries-traffic).
>
> **Two supervision modes.** *Managed* (the default): ZoFHub renders the config,
> validates it with `sing-box check`, spawns the daemon, restarts it with backoff
> if it dies, and kills it on shutdown. *Read-only* (`SINGBOX_MANAGED=0`): you
> run the daemon yourself, or not at all, and ZoFHub only reads it.
>
> What is **not** automated in either mode: sing-box's source is not vendored
> here. The Dockerfile builds a **pinned** upstream release — on by default, and
> skipped with `--build-arg SINGBOX_VERSION=none`.
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
sing-box's **HTTP management API over the network**, between two separate
processes — the same relationship ZoFHub already has with the AGPL-3.0 proxy
engines it runs beside. No sing-box source or binary is vendored, linked or
compiled in; `docker-compose.yml` pulls the unmodified upstream image. So
ZoFHub's own license is unaffected, and the GPL's copyleft does not reach it.

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
process. So the binary is built, not imported:

```bash
# Pinned, reproducible, verified against Go's checksum database.
docker build -t zofhub .                       # builds the pinned default
```

The version is pinned in the Dockerfile (`ARG SINGBOX_VERSION`, currently
`v1.14.1`) and the build is ON by default, because sing-box carries the proxy
egress rather than sitting beside it.

**The Go image and the sing-box tag are coupled — bump them together.**
v1.14.1's `go.mod` requires `go 1.25.5`, and an older toolchain fails the build
outright rather than warning, so stage 1 pins `golang:1.25.14-alpine`. Raising
`SINGBOX_VERSION` without checking its `go.mod` is the way this build breaks. Pass `--build-arg SINGBOX_VERSION=none` to skip the stage and build a
binary-free image; the site still runs, every stream takes the direct fallback,
and `/api/admin/proxy` says so.

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
`gaveUp: "binary not found"` in `/api/admin/proxy`, and egress degrades to
direct. A rejected *config* still backs off 1s → 60s, because a redeploy can
fix that one.

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
bypasses `egressStats()`, and ignores `SINGBOX_REQUIRE=1`. `routeProxyUpgrade`
accepts exactly `/wisp/` and answers everything else `400`. (Not an SSRF hole in
either branch — wsproxy runs the same destination filter. What the bypass leaked
was the egress path, not the target.)

**`SINGBOX_REQUIRE` covers TCP only — and UDP is now switched off because of
it.** wisp-js selects the socket class per stream type:

```js
let SocketImpl = type === stream_types.TCP ? this.TCPSocket : this.UDPSocket;
```

ZoFHub injects `TCPSocket` and nothing else, so a **UDP** stream never touched
`SingboxTCPSocket` at all — it left the Node process directly, outside the
daemon, outside `egressStats()`, and outside `SINGBOX_REQUIRE=1`. An operator
who set that flag to guarantee their server's own IP is never exposed did not
get that guarantee for UDP.

Nothing in ZoFHub uses UDP through the tunnel, so
[`lib/wisp-policy.mjs`](../../lib/wisp-policy.mjs) now sets `allow_udp_streams:
false` by default and the hole is closed. `WISP_ALLOW_UDP=1` reopens it and
warns, naming this exact consequence. If UDP is ever genuinely needed, the fix
is a `UDPSocket` class that dials through sing-box — not the flag.

**Failure is degradation, not an outage.** A default that takes the proxy down
when a daemon is missing is worse than no default. A failed dial falls back to a
direct connection and is counted:

| Setting | Default | Effect |
|---|---|---|
| `SINGBOX_EGRESS` | `1` | `0` dials directly and never contacts the daemon |
| `SINGBOX_SOCKS` | `127.0.0.1:2080` | where the mixed/SOCKS inbound listens |
| `SINGBOX_REQUIRE` | unset | `1` fails the stream rather than connecting directly |
| `SINGBOX_DIAL_TIMEOUT_MS` | `8000` | bounds a stalled handshake |

`egressStats()` (in `/api/admin/proxy` as `singboxEgress`) reports
`viaSingbox` / `viaDirect` / `refused` and a `singboxSharePct` — the one number
worth alerting on. It is **`null`, not `0`**, before anything has been proxied,
because 0% of zero streams is no data rather than a fault.

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
| Boot with **no** binary present | tunnel still returns `HTTP/1.1 200 OK`; `viaDirect=1`, fallback cause recorded, `/healthz` 200 |

The last two rows are the ones that matter. The byte counter matching means the
traffic genuinely crossed the daemon rather than merely being reported as
having done so; and the no-binary row is the evidence that on-by-default is safe
to ship, because the degraded path is a working site rather than a broken one.

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

## 1. Deployment shape (the part that has to be true first)

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

The first three are **declared** in `.env.example` and `render.yaml` and read by
the shipped adapter. The rest are consumed by sing-box itself when rendering
`deploy/singbox/config.template.json`, not by ZoFHub.

| Variable | Purpose |
|---|---|
| `SINGBOX_EGRESS` | `0` stops routing proxy traffic through sing-box. **Default on.** |
| `SINGBOX_SOCKS` | Where the mixed/SOCKS inbound listens. Default `127.0.0.1:2080`. |
| `SINGBOX_REQUIRE` | `1` fails a stream rather than falling back to a direct connection. |
| `SINGBOX_DIAL_TIMEOUT_MS` | Bounds a stalled SOCKS handshake. Default 8000. |
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
| [`lib/singbox-supervisor.mjs`](../../lib/singbox-supervisor.mjs) | Managed mode: render, validate, spawn, restart, stop. |
| [`proxy-engine/mount.mjs`](../../proxy-engine/mount.mjs) | `routeProxyUpgrade` — exact `/wisp/` match, closing the wsproxy bypass. |
| `Dockerfile` | Stage 1 builds the pinned release; on by default. |
| [`test/singbox.test.mjs`](../../test/singbox.test.mjs) | 28 tests: all seven failure modes, plus both shipped profiles. |
| [`test/singbox-supervisor.test.mjs`](../../test/singbox-supervisor.test.mjs) | 26 tests: defaults, rendering, config-as-credential, wiring, missing-binary give-up. |
| [`test/singbox-egress.test.mjs`](../../test/singbox-egress.test.mjs) | 23 tests: real SOCKS5 over real sockets, fallback, strict mode, CONNECT address types. |
| [`test/wisp-egress-contract.test.mjs`](../../test/wisp-egress-contract.test.mjs) | 9 tests pinning wisp-js's injection point and the exact-path match. |
| [`deploy/singbox/config.template.json`](../../deploy/singbox/config.template.json) | **Default profile:** loopback mixed/SOCKS inbound — the egress path. Verified with `sing-box check` against a real 1.14.1 binary. |
| [`deploy/singbox/config.reality.template.json`](../../deploy/singbox/config.reality.template.json) | **REALITY profile**, for a host where you own `:443`. Select it with `SINGBOX_CONFIG_TEMPLATE`. |
| [`deploy/singbox/docker-compose.yml`](../../deploy/singbox/docker-compose.yml) | The two-service shape that lets sing-box own `:443`. |
| `server.js` → `GET /api/admin/proxy` | Serves the `singbox` block beside in-process `tunnels`. |
| `admin-ui/assets/admin.js` → Proxy view | Renders it, or "not connected". |
---

**Related:** [documentation map](../README.md#-documentation) · [how it all fits together](../guides/HOW-IT-WORKS.md) · [the egress policy that governs what reaches it](INVISIPROXY.md) · [go-live checklist](../guides/GO-LIVE.md)
