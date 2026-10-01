# AnuraOS: a whole web OS, served from its own origin

> **Off unless the bundle is present.** `npm run fetch-anura` downloads it; with
> nothing in `vendor/anura/` the engine is not offered at all, rather than
> advertised and 404ing.

| | |
|---|---|
| Project | **AnuraOS** — browser-based web OS with v86 x86 emulation |
| Upstream | <https://github.com/MercuryWorkshop/anuraOS> |
| Licence | **AGPL-3.0** |
| Pinned at | commit [`08136cc`](https://github.com/MercuryWorkshop/anuraOS/commit/08136cc0f0e51fcb2a4ce18edc54bb180e61c915) |
| Vendored at | [`vendor/anura/`](../../vendor/anura/) — 526 files, ~50 MB |
| Modified | **Yes — one file.** Declared under AGPL §5. See §4 |
| Code | [`lib/anura-host.mjs`](../../lib/anura-host.mjs), 17 tests in [`test/anura-host.test.mjs`](../../test/anura-host.test.mjs) |

---

## 1. Why it cannot live on a subpath

This is the decision the whole module exists to implement, and it is not a
matter of taste.

AnuraOS is **an operating system, not a library**. It assumes it owns a site
root, and that assumption cannot be negotiated from outside:

1. **Root-absolute paths everywhere.** Its 526 files reference `/assets`,
   `/libs`, `/apps`, `/bin`, `/x86images`, `/bundle.css` and `/anura-sw.js`.
   Two of those — `/assets` and `/browser` — **collide with routes ZoFHub
   already owns.**

2. **Rewriting them is not awkward, it is *wrong*.** The same absolute strings
   also name paths **inside the guest filesystem of the emulated x86 machine**
   (`/usr`, `/tmp`, `/boot`, `/opfs`). A blind rewrite fixes the URLs and
   **silently corrupts the Linux image** — which looks completely fine until
   somebody opens a terminal inside the emulator.

3. **It registers a root-scoped service worker**, which would fight
   Ultraviolet's at `/uv/` and Scramjet's at `/scram/`.

So it gets a **real origin** instead. An origin is scheme + host + **port**,
which means *a second listener on this same process is already a separate
origin* — no DNS, no second deployment, no rewriting, and AnuraOS serves from
`/` exactly as it expects.

---

## 2. The four exposure modes

`anuraExposure()` resolves exactly one of these:

| Mode | When | What happens |
|---|---|---|
| `external` | `PROXY_ANURA_URL` is set | An instance **you** host. This process serves nothing |
| `host` | `ANURA_HOST` is set | Served on the main listener under a hostname you point at this service |
| `port` | default | A **second listener**, port **8095** by default |
| `disabled` | `ANURA_PORT=0` (or `off`/`false`/`no`) | An operator who does not want a second listener |
| `absent` | no bundle in `vendor/anura/` | Not offered. Never advertised-then-404 |

**Use `ANURA_HOST` on Render**, which exposes one port. Point a subdomain at the
service; the isolation is identical because it is still a distinct origin.

### Unset and invalid are different answers

```js
if (raw === '') return { mode: 'port', port: 8095, serves: true, present };
const port = Number(raw);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  return { mode: 'disabled', serves: false, present, reason: `invalid ANURA_PORT "${raw}"` };
}
```

`Number('banana') || 8095` would treat a **typo as "use the default"** — quietly
serving on a port the operator never chose, and then the one thing they would
have grepped the config for is not the port actually in use. A typo disables the
engine and says why. Only a genuinely absent value falls back.

---

## 3. Why the URL is built from the request

Both `anuraUrlFor()` and the `wisp-url` rewrite derive the hostname from the
**incoming request**, never from configuration.

The whole site is domain-agnostic so it can be redeployed on a throwaway mirror.
**An engine URL baked to one hostname would send visitors of the mirror straight
back to the blocked domain** — the exact failure the mirror exists to avoid.

`null` means there is nothing to offer, and callers must treat that as "no
entry", not "entry that is down".

---

## 4. The one modification — AGPL §5

**Exactly one file is changed**, and only in transit: `/config.json` gains a
`wisp-url` in `defaultsettings`.

### Why it is necessary

AnuraOS's own `lib/Anura.js` (vendored at `vendor/anura/lib/Anura.js`) does `new Networking(settings.get("wisp-url"))`, and **the shipped
`config.json` sets no `wisp-url` at all.** The value is `undefined`, the
WebSocket constructor resolves it against the page, and the browser app has no
tunnel. Nothing inside AnuraOS reports this — it simply fails to load sites.

### Why it points at our own tunnel

The URL is built from the request, so the tunnel is always the same origin the
visitor already has open. Every byte of proxy traffic stays on this deployment —
**no third-party relay** — and it keeps working on a mirror domain.

### What is deliberately *not* changed

`relay-url` is left alone. It is AnuraOS's own peer-to-peer feature, not the
proxy path, and **repointing something we do not serve would be a lie.**

> This makes ZoFHub's copy a **modified version** under AGPL §5.
> [`lib/licenses.mjs`](../../lib/licenses.mjs) records it as one, the live
> `/licenses` page states it, and the corresponding source is served at
> `/licenses/anura-modifications`. Everything else in the bundle is served
> **byte-for-byte as published**. See [CREDITS.md](../CREDITS.md).

---

## 5. Headers, and why they are on every response

v86 needs `SharedArrayBuffer`, which a browser grants only to a
**cross-origin-isolated** document:

```
Cross-Origin-Opener-Policy:   same-origin
Cross-Origin-Embedder-Policy: require-corp
Cross-Origin-Resource-Policy: cross-origin   (so its own assets load under require-corp)
X-Content-Type-Options:       nosniff
```

This is **not** `express.static`, deliberately. The headers must be set on
**every** response **including the 404s** — the one request that misses them
costs the whole document its `SharedArrayBuffer`, and the emulator then fails to
start with an unrelated-looking console error.

### MIME types are explicit

Getting these wrong is not cosmetic: a `.wasm` served as `octet-stream` fails
`instantiateStreaming`, and AnuraOS's own extensions (`.ajs` commands,
`.lib`/`.app` manifests) are unknown to every MIME database. So the table is
written out rather than inferred.

---

## 6. Configuration

```bash
# Nothing set → second listener on :8095, if the bundle is present.
ANURA_PORT=8095          # or 0/off to disable the second listener
ANURA_HOST=os.example.com  # serve on the main listener under this hostname
PROXY_ANURA_URL=https://…  # point at an instance you host; we serve nothing
```

Fetch or refresh the bundle:

```bash
npm run fetch-anura
```

The boot banner states which mode is active:

```
→ anura:   http://localhost:8095 (own origin, same process)
```

---

## 7. Verification status

| Check | Result |
|---|---|
| `test/anura-host.test.mjs` | **17/17 pass** — exposure modes, invalid-port handling, request-derived URLs, the config rewrite |
| Bundle integrity | 526 files present, pinned to commit `08136cc` |
| `config.json` rewrite | asserted to add `wisp-url` and to leave `relay-url` untouched |
| Licence | AGPL-3.0, modification declared in `lib/licenses.mjs` and on `/licenses` |

**Not verified here:** that the **x86 emulator actually boots** in a browser and
reaches the network through the rewritten `wisp-url`. That needs the 50 MB
bundle fetched and a real browser session with cross-origin isolation intact;
the header and config logic is tested, the end-to-end boot is not. If you run it
and the emulator starts but has no network, the `wisp-url` rewrite is the first
thing to check.

---

**Related:** [documentation map](../README.md#-documentation) · [how it all fits together](../guides/HOW-IT-WORKS.md) · [the tunnel it dials](INVISIPROXY.md) · [attribution and the §5 declaration](../CREDITS.md)
