# Credits & Third‑Party Licenses

ZoFHub's proxy browser is built on open‑source proxy projects. Each is credited
below with its upstream repository and license.

## Embedded engines (served from this origin)

These ship via npm packages (`@titaniumnetwork-dev/ultraviolet`,
`@mercuryworkshop/*`) and are served directly by `server.js`.

| Project | Role in ZoFHub | Repository | License |
|---|---|---|---|
| **Ultraviolet** | In‑page proxy engine (service worker) | https://github.com/titaniumnetwork-dev/Ultraviolet | MIT |
| **Scramjet** | In‑page proxy engine (service worker) | https://github.com/MercuryWorkshop/scramjet | MIT |
| **bare‑mux** | Transport multiplexer | https://github.com/MercuryWorkshop/bare-mux | see upstream `LICENSE` |
| **Wisp (wisp‑js)** | Tunnel protocol client (the `/wisp/` tunnel) | https://github.com/MercuryWorkshop/wisp-client-js | **AGPL‑3.0** |
| **Epoxy transport** | TLS‑over‑Wisp transport | https://github.com/MercuryWorkshop/EpoxyTransport | **AGPL‑3.0** |
| **libcurl transport** | curl‑over‑Wisp transport | https://github.com/MercuryWorkshop/libcurl-transport | **AGPL‑3.0** |
| **libcurl.js** | WASM curl used by GUST | https://github.com/ading2210/libcurl.js | **LGPL‑3.0‑or‑later** |
| **GUST** | Service‑worker‑free libcurl + Wisp browser | Mercury Workshop ecosystem | uses the AGPL/LGPL libs above |

Ultraviolet and Scramjet are MIT‑licensed. The **Wisp / Epoxy / libcurl
transport stack is AGPL‑3.0** and **libcurl.js is LGPL‑3.0‑or‑later** — these are
served to users from this origin, so their license notices are preserved in the
vendored/npm files and the AGPL network‑use source offer below applies. None of
these are covered by the ZoFHub License.

### AGPL‑3.0 §13 network‑use source offer (for the in‑use transport stack)

Because ZoFHub serves the AGPL‑3.0 components above over a network, their users
are offered the **corresponding source**: it is each project's upstream
repository (linked above) at the version pinned in `package-lock.json`
(`node_modules/@mercuryworkshop/*`). ZoFHub runs them unmodified; any local
changes would be kept in this repository. To request the source for a specific
deployed build, open an issue at
<https://github.com/zofhubgamingofficialdev-100/ZoFHub-Gaming-Site>.

## Companion standalone browsers (optional, NOT included in this repository)

These are complete proxy‑browser apps that run as their own services. They are
**copyleft (AGPL‑3.0 / GPL‑3.0)** and are **not bundled in this repository** —
they're large upstream clones that cannot be relicensed under the ZoFHub License.
Install them separately if you want those engines; ZoFHub's core does not depend
on them and simply hides them from the engine list when they're not running.

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
