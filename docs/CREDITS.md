# Credits & Third‑Party Licenses

ZoFHub's proxy browser is built on open‑source proxy projects. Each is credited
below with its upstream repository and license.

## Embedded engines (served by this deployment)

These ship via npm packages (`@titaniumnetwork-dev/ultraviolet`,
`@mercuryworkshop/*`) and are served directly by `server.js`.

| Project | Role in ZoFHub | Repository | License |
|---|---|---|---|
| **Ultraviolet** | In‑page proxy engine (service worker) | https://github.com/titaniumnetwork-dev/Ultraviolet | **AGPL‑3.0** |
| **Scramjet** | In‑page proxy engine (service worker) | https://github.com/MercuryWorkshop/scramjet | **AGPL‑3.0** |
| **bare‑mux** | Transport multiplexer | https://github.com/MercuryWorkshop/bare-mux | MIT |
| **Wisp (wisp‑js)** | Tunnel protocol client (the `/wisp/` tunnel) | https://github.com/MercuryWorkshop/wisp-client-js | **AGPL‑3.0** |
| **Epoxy transport** | TLS‑over‑Wisp transport | https://github.com/MercuryWorkshop/EpoxyTransport | **AGPL‑3.0‑only** |
| **libcurl transport** | curl‑over‑Wisp transport | https://github.com/MercuryWorkshop/libcurl-transport | **AGPL‑3.0‑only** |
| **libcurl.js** | WASM curl used by GUST | https://github.com/ading2210/libcurl.js | **LGPL‑3.0‑or‑later** |
| **GUST** | Service‑worker‑free libcurl + Wisp browser | https://github.com/nautilus-os/GUST | **AGPL‑3.0** |
| **HORIZON** | Single‑file proxy browser (a remodelled GUST) | https://github.com/RiptideMC/HORIZON | **AGPL‑3.0** |
| **Interstellar** | Multi‑page proxy browser (Ultraviolet + Scramjet) | https://github.com/UseInterstellar/Interstellar | **AGPL‑3.0** |

> **HORIZON and Interstellar run from this origin, under this server's tunnel.**
> Both are vendored under [`proxy-engine/assets/`](../proxy-engine/assets/) and
> mounted at `/horizon` and `/interstellar`. Each is **modified** so its Wisp
> transport uses this deployment's own same-origin `/wisp/` endpoint rather than a
> third-party relay — see the §5 declarations below.

Every proxy engine ZoFHub serves — **Ultraviolet, Scramjet, GUST, HORIZON,
Interstellar**, and the **Wisp / Epoxy / libcurl transport stack** — is
**AGPL‑3.0**, and **libcurl.js is LGPL‑3.0‑or‑later**. They are served to users
**over a network by this deployment**, all from this origin, so their
license notices are preserved in the vendored/npm files and the AGPL network‑use
source offer below applies to all of them. **bare‑mux** is MIT (its
`package.json` declares no license, but the package ships an MIT `LICENSE` file).
None of these are covered by the ZoFHub License.

> **Corrected 2026‑07‑30 — Ultraviolet and Scramjet are AGPL‑3.0, not MIT.**
> Both npm packages declare `"license": "MIT"` in `package.json`, but both ship a
> full **GNU AGPL‑3.0** text as their `LICENSE` file (661 lines, verified), and
> GitHub reports Ultraviolet's repository as AGPL‑3.0. Where the manifest and the
> LICENSE file disagree, **the LICENSE file is the operative grant**. This file and
> the public credits page previously listed both as MIT, which understated the
> obligation: AGPL‑3.0 §13 requires a network‑use source offer, and MIT does not.
> The §13 offer below now covers them.

### AGPL‑3.0 §13 network‑use source offer (all served proxy engines)

Covers **Ultraviolet, Scramjet, GUST, HORIZON, Interstellar, Wisp, Epoxy
transport** and **libcurl transport**, plus **libcurl.js** under LGPL‑3.0.

Because ZoFHub serves the AGPL‑3.0 components above over a network, their users
are offered the **corresponding source**: it is each project's upstream
repository (linked above) at the version pinned in `package-lock.json`
(`node_modules/@mercuryworkshop/*`, `node_modules/@titaniumnetwork-dev/ultraviolet`,
and the vendored `proxy-engine/assets/gust/`). To request the source for a specific deployed
build, ask in the official **ZoFHub Discord server** — the invite is linked from
the footer of the live site.

#### Three of them are modified — §5 declarations

> **Corrected 2026‑09‑21.** This paragraph previously read *"ZoFHub runs them
> unmodified."* That was **wrong**: several served AGPL‑3.0 components carry declared
> modifications, and AGPL §5 requires modified versions to carry prominent notices
> stating that they were changed and when. The machine-readable record in
> [`lib/licenses.mjs`](../lib/licenses.mjs) was correct throughout and is what the
> live `/licenses` page serves; only this file understated it.

| Component | Changed | What was changed | Corresponding source |
|---|---|---|---|
| **GUST** | 2026‑07‑30 | (1) Default Wisp server repointed to this site's **own same-origin `/wisp/`** instead of the upstream public `wisp.mercurywork.shop`, so proxy traffic never leaves this domain. (2) Added ZoFHub's shared cloak system (panic key, tab title/favicon cloaking) for parity with the rest of the site. | served at `/gust/index.html`, source at [`proxy-engine/assets/gust/index.html`](../proxy-engine/assets/gust/index.html) |
| **HORIZON** | 2026‑10‑16 | Every Wisp reference is repointed to this site's own same-origin `/wisp/` endpoint, and the upstream pool of third-party public relays (and the built-in Discord client's own relay list) is removed, so proxied traffic is governed by this deployment's approved-destination policy instead of leaving to a stranger's relay. **No other file or feature is altered.** | served at `/horizon`, source at [`proxy-engine/assets/horizon/index.html`](../proxy-engine/assets/horizon/index.html) |
| **Interstellar** | 2026‑10‑16 | (1) All asset, page and proxy-prefix paths are rewritten to live beneath `/interstellar`, so it runs as a same-origin sub-mount instead of owning the origin. (2) Its Wisp transport uses this deployment's own `/wisp/` tunnel. (3) The upstream Google Analytics tag (`GT-K46PHV4`) is removed so it does not beacon on page load. | served at `/interstellar`, source under [`proxy-engine/assets/interstellar/`](../proxy-engine/assets/interstellar/) |

Every other component listed above **is** served unmodified.

## Companion standalone browsers (optional, vendored into this private repo)

These are complete proxy‑browser apps that run as their own services. They are
**copyleft (AGPL‑3.0 / GPL‑3.0)** and are **not covered by the ZoFHub License** —
they're large upstream clones that cannot be relicensed. ZoFHub's core does not
depend on them and simply hides them from the engine list when they aren't
running.

**Where they live:** their full source trees are committed into this repository
(`NautilusOS/`, `DayDream/`, `Nebula/`) because it doubles as a
private full-machine backup. That is fine while the repo stays **private** — the
copyleft obligations below are triggered by *distribution* and by *offering the
software over a network*, neither of which a private backup does. They are **not
deployed with the live site**; the deployed ZoFHub uses only its three built-in
same-origin engines.

**Local modifications:** DayDream and Nebula have been modified here so they can
actually build — each had a dependency pinned to a GitHub release asset that
upstream has since deleted (repointed to the same version on npm), unapproved
pnpm build scripts, and a missing `terser` dependency in DayDream. Under
AGPL‑3.0 these changes must be published **if** you ever serve either app over a
network. They are currently local-dev only.

| Project | Repository | License |
|---|---|---|
| **NautilusOS** | https://github.com/nautilus-os/NautilusOS | AGPL‑3.0 |
| **DayDream** | https://github.com/NightProxy/DayDream | AGPL‑3.0 |
| **Nebula** | https://github.com/NebulaServices/Nebula | AGPL‑3.0 |

### License obligations (read before deploying any of these publicly)

- **GPL‑3.0 / AGPL‑3.0 are copyleft.** If you install and serve any of these,
  keep its `LICENSE` file in place and its source available.
- **AGPL‑3.0 (NautilusOS, DayDream, Nebula) adds a network clause:** if you offer
  one over a network, you must offer those users its complete corresponding
  source. Running them unmodified and linking back to the upstream repositories
  above is the simplest way to comply. If you modify one, publish your changes.
- **ZoFHub's own code** is licensed under the ZoFHub License (see `LICENSE`) —
  that applies to ZoFHub's code only, **not** to any of the third‑party
  components above.

## MASQR (idea adopted — no code vendored, no dependency added)

**ZoFHub ships no Masqr code.** The upstream project named a problem this site
has — a mirror domain dies when a shared link reaches a filter vendor whose
crawler fetches it, sees a web proxy, and burns the domain — and the shape of
the answer: don't show the proxy to a client that wasn't handed a key out of
band. `lib/masqr.mjs` is ZoFHub's own implementation of that idea, written from
scratch. It is **off by default**.

| Project | Repository | License |
|---|---|---|
| **The MASQR Project** | https://github.com/titaniumnetwork-dev/MasqrProject | **AntiSkip License** (MIT text **+ an added condition**) |

Copyright © **Mercury Workshop** 2024 — named in the upstream `LICENSE`, even
though the repository sits in the `titaniumnetwork-dev` organisation.

> ⚠ **It is not MIT.** The licence is MIT's text with an extra condition — that
> you are not, and are not acting on behalf of, SurfSkip. Upstream calls it the
> *AntiSkip License*; GitHub classifies it `NOASSERTION` and there is no SPDX
> identifier for it. It is permissive for this project, which has no connection
> to SurfSkip, but recording it as "MIT" would be wrong.

Because no upstream code is copied, the notice-retention condition is not
engaged. Credit is given regardless, here and on the site's `/credits` page.

Full provenance — including the eight places ZoFHub deliberately diverges
(offline HMAC keys instead of a third-party licence server; a signed grant
instead of `authcheck=true`; keys *not* host-bound because mirrors are
disposable; the key never logged) — is in **`docs/proxy/MASQR.md`** and
**`data/masqr-upstream.json`**.

ZoFHub is not affiliated with or endorsed by Mercury Workshop or TitaniumNetwork.

## InvisiProxy LTS (optional external engine — neither vendored nor depended on)

**ZoFHub ships no InvisiProxy code.** No vendored copy, no npm dependency, no
bundled build. It is integrated as an *optional external engine*
(`PROXY_INVISI_URL`) that you deploy yourself, plus two ideas that were
reimplemented here from scratch against different libraries.

| Project | Repository | License |
|---|---|---|
| **InvisiProxy LTS** (formerly Holy Unblocker LTS) | https://github.com/QuiteAFancyEmerald/InvisiProxy | **AGPL‑3.0‑only** |

Copyright © TitaniumNetwork and the InvisiProxy contributors — led by
[QuiteAFancyEmerald](https://github.com/QuiteAFancyEmerald), with
[yoct1](https://github.com/yoct1), [kinglalu](https://github.com/kinglalu) and
others named in the upstream repository's contributor and release records.

**Why it is not vendored.** It is a complete proxy *application* built on the
same primitives ZoFHub already integrates directly (Ultraviolet, Scramjet, Wisp,
bare‑mux, epoxy), on Fastify + pnpm rather than Express + npm — so importing it
would duplicate working architecture rather than add capability. Decisively, it
is **AGPL‑3.0** and ZoFHub's own LICENSE is proprietary: because ZoFHub is
offered over a network, copying its source into the served work would engage
AGPL‑3.0 §13 for the combination. A subdirectory is not a licence boundary;
**process and deployment separation is**. Run separately, its §13 obligation is
real and belongs to whoever deploys it.

**What reviewing it did change**, both written from scratch and copying no code:

- `lib/wisp-policy.mjs` — ZoFHub's Wisp tunnel now *states* its egress rules
  (port allowlist, no UDP, private IPs blocked, per‑tunnel stream cap) instead
  of inheriting them from a library default. Upstream runs a different Wisp
  server (`mrrowisp`) with a different API; what was taken is the argument that
  these belong in the application's configuration.
- `tools/verify-proxy.mjs` — a runnable check that each engine really renders
  pages. Upstream's `proxyServiceValidator.js` is why this exists; its method
  (fetching the generated proxy URL with axios) was **not** adopted, because a
  service worker does not intercept a request from a client it does not control,
  so that request never reaches the proxy at all.

Full provenance, including everything deliberately rejected and the upgrade
procedure: **`docs/proxy/INVISIPROXY.md`** and **`data/invisiproxy-upstream.json`**.

ZoFHub is not affiliated with or endorsed by TitaniumNetwork or the InvisiProxy
project.

## Kasm Workspaces (optional remote-desktop engine — neither vendored nor built)

Kasm is the one engine ZoFHub **never touches the bytes of**. Upstream ships
Dockerfiles, not a bundle, and a session is a whole Linux desktop — so it runs
on the operator's own Docker host and ZoFHub only records its address in
`PROXY_KASM_URL`, probes whether it is answering, and offers it in the `/browser`
engine list. Nothing from these projects is copied into this repository, built
into the image, or served to visitors.

That is why there is no entry for it in `lib/licenses.mjs`: that file exists to
make the AGPL §13 source offer for copyleft code **this site transmits**, and
this site transmits none of Kasm.

| Project | Repository | License |
|---|---|---|
| **Kasm workspaces-images** | https://github.com/kasmtech/workspaces-images | MIT (see its `LICENSE.md`) |
| **Kasm workspaces-core-images** | https://github.com/kasmtech/workspaces-core-images | MIT |
| **KasmVNC** (inside the images) | https://github.com/kasmtech/KasmVNC | **GPL‑2.0** |

**The MIT grant is narrower than it looks.** `workspaces-images/LICENSE.md` opens
with a disclaimer: *"This license applies only to the source code that is
directly maintained in this git repository, it does not extend to dependencies
from outside of this repository, to include other projects owned and/or
maintained by Kasm Technologies."* So the MIT text covers the **Dockerfiles**,
not what they install — KasmVNC is GPL‑2.0, and the Kasm Workspaces *platform*
(the multi-user orchestrator, as opposed to a single standalone container) is a
separate commercial product under its own terms. An operator who builds and runs
these images is the one distributing them, and those obligations are theirs.

ZoFHub is not affiliated with or endorsed by Kasm Technologies Inc.

## sing-box (default egress backend — built, not vendored)

| Project | Repository | License |
|---|---|---|
| **sing-box** | https://github.com/SagerNet/sing-box | **GPL‑3.0** (+ a name/association clause) |

sing-box is handled differently from everything above, and the difference is
deliberate. Its source is **not** in this repository. The `Dockerfile` builds a
**pinned, unmodified upstream release** into the image (`go install …@<tag>`;
built by default, `SINGBOX_VERSION=none` skips the stage). ZoFHub talks to it as
a **separate operating-system process** — over its HTTP management API
(`lib/singbox.mjs`), by spawning and supervising it
(`lib/singbox-supervisor.mjs`), and by dialling its SOCKS inbound for the
proxy's egress (`lib/singbox-socket.mjs`).

- **Why not vendored:** the served engines above are AGPL and this repo stays
  private, so committing them is fine. sing-box is GPL‑3.0, and GPL‑3.0 §5
  requires any *distributed* work containing GPL source to be GPL — incompatible
  with this repo's proprietary `LICENSE`. Building a separate binary keeps the
  two works separate: running a program is not deriving from it, so ZoFHub's own
  license is unaffected and the copyleft does not reach it.
- **The name clause** ("no derivative work may use the name or imply association
  without prior consent") is respected by referring to sing-box factually —
  "an instance you run" — and never branding ZoFHub as affiliated with or
  endorsed by SagerNet. **ZoFHub is not affiliated with, endorsed by, or
  associated with sing-box or its authors.**
- **This obligation is now live by default, not conditional.** The binary used
  to be opt-in (`SINGBOX_VERSION=none`), so the GPL‑3.0 distribution terms only
  mattered if you asked for them. The default image now **contains sing-box**,
  which means anyone who ships that image is distributing a GPL‑3.0 program and
  must keep its `LICENSE` in place and offer its corresponding source. The
  source is an unmodified upstream release at the pinned tag, so pointing at the
  repository above satisfies it — but it has to actually be offered. Build with
  `--build-arg SINGBOX_VERSION=none` if you would rather not take that on; the
  site runs without it.

Full detail: [docs/proxy/SINGBOX.md](proxy/SINGBOX.md).

## A note on games

Game attribution and the "use official/authorized embeds, host no pirated
assets" guidance live in the [README](README.md#-the-catalog-what-is-actually-served). Nothing in this proxy work changes that.
