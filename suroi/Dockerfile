# Suroi — https://github.com/HasangerGames/suroi  ·  GPL-3.0
#
# Builds a SELF-HOSTED Suroi from a pinned upstream commit. Nothing is vendored
# into ZoFHub's git history; the clone happens at build time, which also makes
# the GPL-3.0 §6(d) source offer exact — SUROI_COMMIT is what you actually ran.
#
# This is a SEPARATE SERVICE. It shares no runtime with ZoFHub (Node, no build
# step) and must not be merged into it — see docs/features/SUROI.md on why that boundary is
# what keeps ZoFHub out of GPL scope.

# ── Build ──────────────────────────────────────────────────────────────────
# Upstream requires Bun, not Node: the server entry point is `bun src/server.ts`
# and it depends on @types/bun and Bun's native APIs. Node cannot run it.
FROM oven/bun:1 AS build

# Pinned deliberately. A branch name is not a source offer — "we built from
# main" does not tell anyone which code they are entitled to.
ARG SUROI_REPO=https://github.com/HasangerGames/suroi.git
ARG SUROI_COMMIT=85df5067b19a876cac4304232cc1e68ff1b07c7f

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /src
# Fetch the one commit rather than the history — same result, far less data.
RUN git init . \
 && git remote add origin "$SUROI_REPO" \
 && git fetch --depth 1 origin "$SUROI_COMMIT" \
 && git checkout FETCH_HEAD \
 && git rev-parse HEAD > /src/BUILT_FROM_COMMIT

# Bun workspaces: client, common, server, tests — installed from the root.
RUN bun install --frozen-lockfile

# Vite production build of the client (upstream: `bun build:client`).
RUN bun run build:client

# ── Runtime ────────────────────────────────────────────────────────────────
FROM oven/bun:1 AS runtime
WORKDIR /app

COPY --from=build /src /app

# The licence text and the exact commit travel WITH the running image, so the
# source offer stays answerable from the deployed artifact itself rather than
# from a README someone has to go find.
COPY --from=build /src/LICENSE /app/LICENSE
COPY --from=build /src/BUILT_FROM_COMMIT /app/BUILT_FROM_COMMIT

# Our config, NOT upstream's config.example.json — that file ships plaintext
# passwords for thirteen privileged roles (developr/developr, administratr/
# administratr, several with isDev:true). They are local-development defaults
# and are public in the repo, so deploying them unchanged grants admin to
# anyone who can read GitHub.
COPY config.json /app/server/config.json

# Upstream's default. It binds 127.0.0.1 in their example config; config.json
# here sets 0.0.0.0 so the container is reachable from outside it.
EXPOSE 8000
ENV NODE_ENV=production

# Upstream: `bun start` === `cd server && bun .`
CMD ["bun", "start"]
