export const config = {
  server: {
    // Local dev only — bind to loopback so this companion is never exposed
    // beyond this machine. index.ts prefers process.env.PORT/HOST over these,
    // and tools/proxies.mjs passes PORT=8093 (PORTS.daydream).
    host: "127.0.0.1",
    // 8093 matches PORTS.daydream in tools/proxies.mjs. The upstream default of
    // 8080 would collide with the ZoFHub server itself.
    port: 8093,
  },
  obfuscation: false,
  logging: false,
  db: {
    dialect: "sqlite",
    name: "daydreamx",
  },
  marketplace: {
    // Randomly generated (32 bytes hex). DayDream refuses to start with the
    // upstream "changeme" placeholder, which is why this file has to exist.
    psk: "f9c3295150e572b41e9054dd3c2f6bf5c1404ab22cd1b3ca940a2a1a8a1f8fdb",
  },
};
