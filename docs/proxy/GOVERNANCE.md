# Proxy governance: approved destinations only

The proxy engines — Ultraviolet, Scramjet, GUST and AnuraOS — are kept and
served. What this layer adds is that the **platform decides where they may
connect**, and an administrator decides what the platform is authorised to
reach.

| | |
|---|---|
| Decision engine | [`lib/proxy-control.mjs`](../../lib/proxy-control.mjs) |
| Persistence, permissions, audit | [`lib/proxy-service.mjs`](../../lib/proxy-service.mjs) |
| Wiring (hook, socket guard, upgrade handler) | [`server.js`](../../server.js) — search `Proxy governance` |
| Console | **Proxy control** in `/admin` |
| Tables | `proxy_targets`, `proxy_policies`, `proxy_providers` ([`db/control-plane.sql`](../../db/control-plane.sql)) |

---

## 1. The one door

Every engine leaves this server through the same `/wisp/` tunnel, which opens a
TCP connection to a host the visitor's browser names. That makes the tunnel the
enforcement point for all of them at once:

```text
browser ─▶ engine page (/uv, /scram, /gust, AnuraOS)
        ─▶ /wisp/ upgrade ── access mode · Origin · caps · session ──▶ refused, or:
        ─▶ stream request ── hostname hook (approved list) ──────────▶ HostBlocked, or:
        ─▶ socket connect ── re-check with port · DNS · private IPs ─▶ refused, or:
        ─▶ the approved destination
```

## 2. The decision

```text
decision = f(access mode, host, port, approved destinations, limits)
         ∈ { ALLOW, DENY, REVIEW }  + an internal reason code
```

| Reason | Meaning |
|---|---|
| `approved_target` | ALLOW — the host matches an approved, unexpired entry on an approved port |
| `unlisted` | REVIEW — nobody has approved this host. **Refused at runtime**, and counted |
| `pending_target` | REVIEW — proposed, not yet approved. Refused |
| `revoked_target`, `expired_target` | DENY |
| `port_not_approved`, `port_not_allowed` | DENY — the entry's ports, or the global port list |
| `ip_literal`, `internal_host`, `invalid_host` | DENY — before any list lookup |
| `proxy_disabled`, `staff_only` | DENY — the access mode |

**The default is refusal.** With no approved destinations, every stream is
refused. Before the database has loaded, only `PROXY_APPROVED_TARGETS` applies.

## 3. What can be approved

- A hostname (`en.wikipedia.org`) or a subdomain wildcard (`*.khanacademy.org`,
  which covers subdomains but **not** the bare domain or look-alikes).
- **Never** a pattern that amounts to the whole internet: `*`, a bare TLD, a
  wildcard over a public suffix (`*.com`, `*.co.uk`, `*.github.io`,
  `*.amazonaws.com`, …), or a wildcard-DNS service that maps names to arbitrary
  addresses (`nip.io`, `sslip.io`, `localtest.me`, …).
- **Never** an internal name (`localhost`, `*.local`, `*.internal`, `*.lan`, …) or
  an IP address.
- Ports: web ports only (80, 443, 8080, 8443).
- Every entry needs a **purpose** (why the platform is authorised to reach it),
  and may carry an owner and an expiry (at most two years ahead).

These rules are enforced three times: by the console's validation, by a `CHECK`
constraint in Postgres, and again when stored rows are loaded — a row written
around the console (by hand in the SQL editor) that the console would refuse is
reported and **ignored**, never applied.

### The approval workflow

1. **Propose** (`proxy.targets`). The entry is `pending` and not live.
2. **Approve** (`proxy.targets` **and a fresh password**). Re-validated at
   approval time, then applied to the live tunnel immediately.
3. **Revoke** at any time, with no confirmation prompt — responding to an
   incident must never be slowed down. Changing the pattern or adding a port to
   an approved entry puts it back to `pending`.

## 4. Why every connection is checked twice

wisp-js checks our hostname hook before it allocates a stream (cheap, early).
Then **our** socket class re-checks the destination *with its port*, resolves
DNS itself, refuses if **any** returned address is private, loopback,
link-local, CGNAT or reserved, and dials the address it validated.

That second check closes two gaps the library leaves:

- **DNS rebinding.** wisp-js resolves a name to check it, and the dialler would
  resolve it again. A name that answers public for the first lookup and private
  for the second would pass the check and reach the private network. We dial
  the address we checked.
- **A failed lookup.** If wisp-js's own lookup throws, it skips its private-IP
  check. Ours refuses instead.

An approved name that resolves privately is recorded as a security event
(`proxy_private_address`, at most once a minute per host).

## 5. Access modes

| Mode | Who | What happens |
|---|---|---|
| `public` | anyone | approved destinations only |
| `staff` | signed-in staff holding `proxy.use` | the tunnel, engine pages and assets check the admin session |
| `disabled` | nobody | engine pages answer 503, the tunnel refuses every upgrade; the rest of the site is unaffected |

The environment sets the starting mode (`PROXY_ACCESS_MODE`); a policy saved in
the console replaces it. Opening access (to `public`) needs a fresh password.

## 6. Limits

| Limit | Default | Bounds |
|---|--:|---|
| Concurrent tunnels | 512 | 1–2000 |
| Tunnels per client | 32 | 1–256 |
| Streams per tunnel | 256 | 1–1024 |
| Idle timeout | 10 min | 1–120 |
| Maximum session length | 240 min | 5–1440 |
| Ports | 80, 443, 8080, 8443 | a subset of those |

`WISP_MAX_PER_IP`, `WISP_MAX_STREAMS` and `WISP_ALLOWED_PORTS` in the
environment remain **ceilings**: the console can set a policy inside them, never
outside. Raising a limit needs a fresh password; lowering one never does.

## 7. Other checks on the upgrade

- **Origin.** A browser's WebSocket upgrade must come from this site's own
  origin (or one listed in `PROXY_ALLOWED_ORIGINS`), so another website cannot
  open tunnels through this server from its visitors' browsers.
- **One handler for both listeners.** The AnuraOS listener used to route its
  upgrades straight into the tunnel, skipping the global cap, the per-client cap
  and the idle timeout. Both listeners now share one handler.
- **Maintenance mode** closes the tunnel too.

## 8. Engines

Each engine can be switched off (its pages and assets answer 404). **External
companions** — Interstellar, DayDream, Nebula, NautilusOS, InvisiProxy, Kasm —
run as separate servers, so their traffic never reaches this tunnel and the
destination policy **cannot govern them**. They are one switch, **off by
default**, labelled "not governed" in the console.

## 9. Sessions: counts, never destinations

A live tunnel is tracked with an id, a short HMAC client tag, timestamps and
stream counts. **Destinations are never recorded per session**, and nothing
about sessions is written to the database — a per-tunnel row would be a browsing
record of an anonymous visitor. The last 100 closed sessions are kept in memory
with their end reason. Staff with `proxy.sessions` can end a live session.

The **Requested, not approved** panel shows refused hostnames with counts — no
identity, in memory only, bounded to 200, cleared on restart — so an
administrator can see what people need without learning who needed it.

---

**Related:** [control plane](../admin/CONTROL-PLANE.md) ·
[egress policy](INVISIPROXY.md) · [documentation map](../README.md#-documentation)
