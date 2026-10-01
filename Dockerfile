# ── Stage 1: sing-box ───────────────────────────────────────────────────────
# sing-box (github.com/SagerNet/sing-box) is GPL-3.0 and is built here from a
# PINNED upstream version. Its source is deliberately NOT vendored into this
# repository: ZoFHub's own LICENSE is proprietary and this repo is pushed to a
# remote, so a copy of GPL-3.0 source in the tree would be a conveyance of GPL
# code under incompatible terms. Building an unmodified upstream release inside
# the image keeps the two works separate — ZoFHub runs sing-box as its own
# process and talks to it over a socket; it does not link, modify or derive
# from it. ZoFHub is not affiliated with or endorsed by its authors.
#
# The build is ON BY DEFAULT, because sing-box now carries the proxy's egress
# (lib/singbox-socket.mjs) rather than sitting beside it as a dashboard widget.
# An image without the binary still runs: the supervisor reports a missing
# binary once, stops retrying, and every proxied stream falls back to a direct
# connection while saying so in /api/admin/proxy. Pass SINGBOX_VERSION=none to
# build that lighter image deliberately.
#
# PINNED, NOT FLOATING. `latest` here would mean a rebuild six months from now
# silently ships a different proxy daemon with a different config schema — the
# exact failure the supervisor's `sing-box check` exists to catch, moved to a
# place where it costs a deploy instead of a log line.
ARG SINGBOX_VERSION=v1.14.1

# Go version is tied to the sing-box version: v1.14.1's go.mod requires go
# 1.25.5, and an older toolchain fails the build outright. Bump both together.
FROM golang:1.25.14-alpine AS singbox
ARG SINGBOX_VERSION
ARG SINGBOX_TAGS=with_quic,with_utls
# `go install` fetches the module at an exact tag and verifies it against the
# checksum database — no clone, no submodule, no source in our tree, and a
# tampered upstream fails the build rather than shipping silently.
RUN set -eux; \
    mkdir -p /out; \
    if [ "$SINGBOX_VERSION" = "none" ]; then \
      echo "sing-box build skipped (SINGBOX_VERSION=none)"; \
    else \
      apk add --no-cache git build-base; \
      CGO_ENABLED=0 go install -v \
        -trimpath \
        -tags "$SINGBOX_TAGS" \
        -ldflags "-s -w" \
        github.com/sagernet/sing-box/cmd/sing-box@"$SINGBOX_VERSION"; \
      cp /go/bin/sing-box /out/sing-box; \
      /out/sing-box version; \
    fi

# ── Stage 2: ZoFHub ─────────────────────────────────────────────────────────
FROM node:22-alpine

WORKDIR /app

# .npmrc is copied WITH the manifests, not later with the rest of the source.
# It carries ignore-scripts=true, and @mercuryworkshop/scramjet declares
# `preinstall: npx only-allow pnpm`, which exits 1 under npm. node:22-alpine
# ships npm 10, which has no install-script gate of its own — so if this layer
# runs before .npmrc is present, the build fails on preinstall. `package*.json`
# does not glob it.
COPY package*.json .npmrc ./
RUN npm install --omit=dev

# The /out directory always exists, so this COPY succeeds whether or not a
# binary was built. A conditional COPY is not expressible in a Dockerfile, and
# an unconditional one against a missing path fails the build.
COPY --from=singbox /out/ /usr/local/bin/
RUN if [ -f /usr/local/bin/sing-box ]; then chmod 0755 /usr/local/bin/sing-box; fi

COPY . .

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

# Exec form on purpose: node stays PID 1 and receives SIGTERM directly, so
# container stops are graceful. `npm start` would fork and swallow the signal.
# The flags must stay in step with package.json's start script.
#
# node is PID 1 and therefore the reaper for the sing-box child it spawns —
# lib/singbox-supervisor.mjs kills it explicitly on SIGTERM so it cannot be
# orphaned into a zombie when the container stops.
CMD ["node", "--use-system-ca", "server.js"]
