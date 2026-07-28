// tools/dev-all.mjs — ONE command to run the whole thing locally.
//
//   npm run dev:all
//
// Starts, in this single terminal, everything the /browser page can use:
//   • ZoFHub server        → http://localhost:8080
//       (built-in engines: Scramjet [default], Ultraviolet, GUST — always work)
//   • Companion launcher   → tools/proxies.mjs
//       (NautilusOS :8091, Interstellar :8092, DayDream :8093, Nebula :8094 —
//        each started only if it's actually set up on this machine)
//
// It frees the ports first (so a stale run can't block it), streams every
// child's logs here, and — the important part — a single Ctrl+C stops ALL of
// them together (server + every companion), so you never leave orphan processes
// holding ports. This is the convenient equivalent of running `npm run proxies`
// in one terminal and `npm run restart` in another.
//
// NOTE: this is DEV-ONLY. Companions are standalone apps that aren't deployed
// with the site, so on your live (Render) deploy only the built-in engines
// appear — which is correct, they're same-origin and always work there.

import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const NODE = process.execPath;
const PORTS = [8080, 8091, 8092, 8093, 8094];   // server + companion ports
const kids = [];

function stopAll(code = 0) {
  console.log('\n[dev:all] stopping the server + all companion proxies…');
  for (const c of kids) { try { c.kill(); } catch {} }
  // Give children a beat to release their ports, then exit.
  setTimeout(() => process.exit(code), 400);
}
process.on('SIGINT', () => stopAll(0));
process.on('SIGTERM', () => stopAll(0));

// Free every port we're about to use (sequential, quiet). kill-port is a no-op
// when the port is already free, so this is always safe.
function freePort(port) {
  return new Promise((resolve) => {
    const k = spawn(NODE, [join(ROOT, 'tools', 'kill-port.mjs'), String(port)], { cwd: ROOT, stdio: 'inherit' });
    k.on('exit', resolve);
    k.on('error', resolve);
  });
}

function launch(name, args, env = {}) {
  const child = spawn(NODE, args, { cwd: ROOT, stdio: 'inherit', env: { ...process.env, ...env } });
  child.on('error', (e) => console.error(`[dev:all] ${name} failed to start: ${e.message}`));
  child.on('exit', (code) => {
    console.log(`[dev:all] ${name} exited (code ${code}).`);
    // If the MAIN server dies, tear everything down — the site is the point.
    if (name === 'server') stopAll(code ?? 0);
  });
  kids.push(child);
  return child;
}

console.log('[dev:all] launching ZoFHub server + optional companion proxies — press Ctrl+C once to stop everything.\n');

for (const p of PORTS) await freePort(p);

// Companions are OPT-IN in the server (no defaults) — so dev:all explicitly points
// the server at the local companion ports. Only ones that are actually RUNNING show
// in the /browser dropdown; anything not started/built simply won't appear (no errors).
//
// EVERY companion tools/proxies.mjs can start must be listed here, or the server
// never probes it and a perfectly healthy engine stays invisible in the dropdown.
// NautilusOS was the casualty of that: it's pure static and always starts, yet
// without PROXY_NAUTILUS_URL the server had no idea it existed.
// Ports MUST match the PORTS map in tools/proxies.mjs.
const COMPANION_ENV = {
  PROXY_NAUTILUS_URL:     `http://localhost:${8091}/`,
  PROXY_INTERSTELLAR_URL: `http://localhost:${8092}/`,
  PROXY_DAYDREAM_URL:     `http://localhost:${8093}/`,
  PROXY_NEBULA_URL:       `http://localhost:${8094}/`,
};

// Main site first (built-in Scramjet/UV/GUST live here — these ALWAYS work), then
// the optional companion launcher.
launch('server',  ['--use-system-ca', 'server.js'], COMPANION_ENV);
launch('proxies', ['tools/proxies.mjs']);

console.log('\n[dev:all] ▶ Open http://localhost:8080/browser once it says the server is running.');
console.log('[dev:all]   Always available: Scramjet · Ultraviolet · GUST (built-in, same-origin).');
console.log('[dev:all]   Also shown IF running locally: NautilusOS · Interstellar · DayDream · Nebula.');
console.log('[dev:all]   The companion launcher prints exactly which ones started and why any were skipped.');
console.log('[dev:all]   NOTE: companions are LOCAL-ONLY — your deployed site uses the 3 built-ins.\n');
