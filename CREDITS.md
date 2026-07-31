# Credits & Third‑Party Licenses

ZoFHub's proxy browser is built on open‑source proxy projects. Each is credited
below with its upstream repository and license.

## Embedded engines (served from this origin)

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

Every proxy engine ZoFHub serves — **Ultraviolet, Scramjet, GUST**, and the
**Wisp / Epoxy / libcurl transport stack** — is **AGPL‑3.0**, and **libcurl.js is
LGPL‑3.0‑or‑later**. They are served to users from this origin, so their license
notices are preserved in the vendored/npm files and the AGPL network‑use source
offer below applies to all of them. **bare‑mux** is MIT (its `package.json`
declares no license, but the package ships an MIT `LICENSE` file). None of these
are covered by the ZoFHub License.

> **Corrected 2026‑07‑30 — Ultraviolet and Scramjet are AGPL‑3.0, not MIT.**
> Both npm packages declare `"license": "MIT"` in `package.json`, but both ship a
> full **GNU AGPL‑3.0** text as their `LICENSE` file (661 lines, verified), and
> GitHub reports Ultraviolet's repository as AGPL‑3.0. Where the manifest and the
> LICENSE file disagree, **the LICENSE file is the operative grant**. This file and
> the public credits page previously listed both as MIT, which understated the
> obligation: AGPL‑3.0 §13 requires a network‑use source offer, and MIT does not.
> The §13 offer below now covers them.

### AGPL‑3.0 §13 network‑use source offer (all served proxy engines)

Covers **Ultraviolet, Scramjet, GUST, Wisp, Epoxy transport** and **libcurl
transport**, plus **libcurl.js** under LGPL‑3.0.

Because ZoFHub serves the AGPL‑3.0 components above over a network, their users
are offered the **corresponding source**: it is each project's upstream
repository (linked above) at the version pinned in `package-lock.json`
(`node_modules/@mercuryworkshop/*`, `node_modules/@titaniumnetwork-dev/ultraviolet`,
and the vendored `public/gust/`). ZoFHub runs them unmodified; any local
changes would be kept in this repository. To request the source for a specific
deployed build, ask in the official **ZoFHub Discord server** — the invite is
linked from the footer of the live site.

## Companion standalone browsers (optional, vendored into this private repo)

These are complete proxy‑browser apps that run as their own services. They are
**copyleft (AGPL‑3.0 / GPL‑3.0)** and are **not covered by the ZoFHub License** —
they're large upstream clones that cannot be relicensed. ZoFHub's core does not
depend on them and simply hides them from the engine list when they aren't
running.

**Where they live:** their full source trees are committed into this repository
(`NautilusOS/`, `Interstellar/`, `DayDream/`, `Nebula/`) because it doubles as a
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
| **Interstellar** | https://github.com/UseInterstellar/Interstellar | GPL‑3.0‑or‑later |
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

## A note on games

Game attribution and the "use official/authorized embeds, host no pirated
assets" guidance live in `README.md`. Nothing in this proxy work changes that.
