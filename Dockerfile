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

COPY . .

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

# Exec form on purpose: node stays PID 1 and receives SIGTERM directly, so
# container stops are graceful. `npm start` would fork and swallow the signal.
# The flags must stay in step with package.json's start script.
CMD ["node", "--use-system-ca", "server.js"]
