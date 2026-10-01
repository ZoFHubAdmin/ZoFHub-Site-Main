# Kasm Workspaces as a proxy-browser engine

> **One setting turns this on: `PROXY_KASM_URL`.** Unset — which is the default
> and every deploy — the engine does not exist and `/browser` is unchanged.

`/browser` offers three kinds of engine, and this adds a fourth kind rather than
a fourth copy of the same idea:

| Engine | What it actually is | Where the work happens |
|---|---|---|
| Scramjet, Ultraviolet | rewrite HTML/JS in a service worker | the visitor's tab |
| GUST | libcurl.js + Wisp, no service worker | the visitor's tab |
| AnuraOS | a web OS emulating x86 | the visitor's tab |
| **Kasm** | **a real Linux desktop in a container** | **somebody's server** |

A site that refuses every rewriting proxy cannot tell a Kasm session apart from
an ordinary desktop browser, because that is exactly what it is. The cost is
that it needs a real machine behind it.

---

## 1. Why ZoFHub cannot host it

AnuraOS is static files, so `lib/anura-host.mjs` serves them from this process.
Kasm cannot work that way, and no amount of effort changes that:

- **Upstream ships Dockerfiles, not a bundle.**
  [`kasmtech/workspaces-images`](https://github.com/kasmtech/workspaces-images)
  is a build recipe. Using one means `docker build` and `docker run` — a
  container runtime, present at runtime.
- **A session is a whole desktop.** The documented command requires
  `--shm-size=512m`, and RAM scales with concurrent *users*, not with instances.
- **There is no Docker daemon inside a Render web service** (`render.yaml`).
  Shelling out to `docker` from `server.js` would work on a developer's laptop
  and fail on every production deploy — the worst possible failure shape.

So there is one honest integration and this is it: **you** run the container,
ZoFHub records its address, checks whether it is answering, and offers it in the
engine picker. Same arrangement as `PROXY_ANURA_URL` and the other companions.

---

## 2. Running one

```bash
docker run --rm -it --shm-size=512m -p 6901:6901 \
  -e VNC_PW=yourpassword kasmweb/desktop:1.19.0
```

Then point ZoFHub at it:

```bash
PROXY_KASM_URL=https://your-host:6901/
KASM_LABEL=Kasm Desktop        # optional; these images vary enormously
```

Sign in at Kasm itself with user `kasm_user` and the `VNC_PW` you chose.
Other images swap the last argument: `kasmweb/chrome`, `kasmweb/firefox`,
`kasmweb/vs-code`, `kasmweb/kali-rolling-desktop`, and around a hundred more.

> Upstream notes that audio, uploads, downloads and microphone pass-through
> work only inside the full Kasm Workspaces platform, not in a standalone
> container.

---

## 3. The certificate problem, which is the whole problem

**The standalone container serves https only, with a certificate it generates
for itself at startup.** Both halves are visible in
`workspaces-core-images/src/common/startup_scripts/vnc_startup.sh`:

```
:215  vncserver … -sslOnly …
:597  openssl req -x509 -nodes -days 3650 -newkey rsa:2048 \
        -keyout …/self.pem -out …/self.pem \
        -subj "/C=US/ST=VA/L=None/O=None/OU=DoFu/CN=kasm/…"
```

A browser will not load an origin with an untrusted certificate inside an
iframe, **and it tells the embedding page nothing when it refuses.** Left alone,
the symptom is a blank frame followed 25 seconds later by ZoFHub's generic "this
page didn't load" — which points the finger at the proxy, which is innocent.

KasmVNC is not the obstacle: its source carries no `X-Frame-Options` and no
`Content-Security-Policy`, so it does not refuse framing. The certificate does.

`lib/kasm-host.mjs` therefore probes the instance and classifies the result, so
the page can say something true and actionable *before* creating a frame that
was never going to fill:

| What the probe finds | What `/browser` does |
|---|---|
| answering, certificate trusted | embeds it normally |
| answering, certificate self-signed | shows "open in a new tab and accept the certificate once", with the link |
| answering over plain `http`, page is `https` | shows "a secure page cannot embed plain http" |
| answering on a private address | says so — that address works only from that network |
| not answering | lists it as offline, with the reason (`ECONNREFUSED`, `timeout`, …) |

**To make it embed properly, give it a real certificate** — put a reverse proxy
with Let's Encrypt in front of the container. That is the only change needed;
everything else already works.

### Why the probe accepts an untrusted certificate

`kasmProbe()` sets `rejectUnauthorized: false`. That is deliberate and narrow:
the container's certificate is self-signed *by design*, so a verifying probe
cannot tell "switched off" from "running normally", and the operator would be
shown **offline** for a healthy service.

It is safe because of what the result is used for. Nothing is sent — no
credentials, no cookies, no body. Nothing in the response is parsed or trusted.
The outcome decides which sentence the page displays, and nothing else. The
visitor's own browser still enforces certificate validity on the connection that
carries their session, so this cannot weaken anything the visitor does.

---

## 4. Security notes

- **Never put a password in `PROXY_KASM_URL`.** `/api/proxies` is
  unauthenticated and publishes that URL to every visitor. Credentials are
  stripped before the value is stored and a warning is logged at boot — but that
  is a backstop, not a feature. Sign in at Kasm.
  *(The same stripping now applies to `PROXY_NAUTILUS_URL`,
  `PROXY_INTERSTELLAR_URL`, `PROXY_DAYDREAM_URL` and `PROXY_NEBULA_URL`.)*
- **`KASM_LABEL` is rendered as text, never as markup** — stripped server-side
  and inserted as a text node client-side.
- **The probe is cached for 10 seconds and de-duplicated in flight.** Without
  both, an unauthenticated endpoint plus a refresh loop turns ZoFHub into a
  small traffic amplifier pointed at your own server.
- **`/kasm` is classified as a proxy surface** in `lib/ad-providers.mjs`, so no
  advertising can ever be attached to it. A remote desktop is the last place an
  ad script belongs.
- **A Kasm session exits from your server's IP, not the visitor's.** It is a
  real computer with a real filesystem, and it is a fundamentally different
  exposure from a page rewriter. Do not expose one publicly without a password
  you chose, and think about who can reach it.

---

## 5. Licensing

Nothing from Kasm is copied into this repository, built into the image, or
served to visitors — which is why there is no entry in `lib/licenses.mjs`. That
file exists to make the AGPL §13 source offer for copyleft code *this site
transmits*, and this site transmits none of Kasm.

`workspaces-images/LICENSE.md` is MIT text, but it opens with a disclaimer that
it covers **only** the code in that repository, "not … dependencies from outside
of this repository, to include other projects owned and/or maintained by Kasm
Technologies." So the MIT grant covers the Dockerfiles, not what they install:
**KasmVNC is GPL-2.0**, and the Kasm Workspaces *platform* is a separate
commercial product. An operator who builds and runs these images is the one
distributing them, and those obligations are theirs. See `CREDITS.md`.

ZoFHub is not affiliated with or endorsed by Kasm Technologies Inc.

---

## 6. Verification status

Tested against a real HTTPS server carrying a certificate generated with the
**same command and subject** the container uses, answering `401` the way
KasmVNC does before sign-in — covering the untrusted-certificate case, the
plain-http case, the private-address case, the down case, the credential-
stripping case and the embedded happy path, in Node and in real Chromium.

**Not tested against a running KasmVNC container**: there is no Docker on the
machine this was built on. The certificate behaviour is read from upstream
source rather than observed, and is cited above so it can be checked. If you run
one and the frame behaves differently, that is the gap.

---

**Related:** [documentation map](../README.md#-documentation) · [how it all fits together](../guides/HOW-IT-WORKS.md) · [the other external engines](INVISIPROXY.md#2-what-is-integrated) · [AnuraOS attribution](../CREDITS.md)
