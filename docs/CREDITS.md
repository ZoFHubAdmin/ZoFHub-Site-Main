# Credits & Third‑Party Licenses

ZoFHub is built on open‑source software, and its games are provided by third‑party
publishers. Each is credited, and each keeps its **own** license, which always takes
precedence for that component. ZoFHub's own code is covered by the ZoFHub License
([`LICENSE`](../LICENSE)).

The complete list of npm packages the project installs — with each package's
license read from its `LICENSE` file rather than trusted from its metadata — is
generated from the versions actually running and shown on the public
[Credits & Licenses](../legal/credits.html) page (served at `/credits`). It cannot
drift from what is deployed. The one component that is **not** an npm package, and
is run as a separate program, is credited below.

## History: the retired proxy browser

Earlier versions also served a web‑proxy browser built on AGPL‑3.0 projects
(Ultraviolet, Scramjet, GUST, HORIZON and the Epoxy / libcurl transports, with
Wisp and libcurl.js under LGPL‑3.0), listed several optional companion browsers
and desktop images (NautilusOS, DayDream, Nebula, InvisiProxy, Kasm), and carried
an original implementation of the MASQR discovery‑gate idea. **All of it has been
removed** — none of that code is served, installed or depended on any more — and
with it the AGPL §13 source offer that existed only because those engines were
served over a network. The code remains in this repository's git history.

## sing-box (default egress backend — built, not vendored)

| Project | Repository | License |
|---|---|---|
| **sing-box** | https://github.com/SagerNet/sing-box | **GPL‑3.0-or-later** (+ a name/association clause) |

Copyright © 2022 **nekohasekai** (`contact-sagernet@sekai.icu`) — the individual maintainer named in
sing-box's own `LICENSE` file, not the `SagerNet` organization name. Verified 2026‑10‑29 directly
against that file, which also confirms the name/association clause's exact wording: *"no derivative
work may use the name or imply association with this application without prior consent."*

sing-box is handled deliberately. Its source is **not** in this repository. The `Dockerfile` builds a
**pinned, unmodified upstream release** into the image (`go install …@<tag>`;
built by default, `SINGBOX_VERSION=none` skips the stage). ZoFHub talks to it as
a **separate operating-system process** — over its HTTP management API
(`lib/singbox.mjs`), by spawning and supervising it
(`lib/singbox-supervisor.mjs`), and by dialling its SOCKS inbound for the
server's outbound fetches (`lib/egress.mjs`, `lib/singbox-socket.mjs`).

- **Why not vendored:** sing-box is GPL‑3.0, and GPL‑3.0 §5
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
assets" guidance live in the [README](README.md#-the-catalog-what-is-actually-served). Nothing in this file changes that.
