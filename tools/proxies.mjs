// tools/proxies.mjs — launch the standalone "companion" proxy browsers.
//
//   npm run proxies
//
// ZoFHub embeds Ultraviolet, Scramjet and GUST directly (same origin).  The
// other open-source proxy browsers the project ships — NautilusOS, Interstellar,
// DayDream, Nebula — are whole self-contained apps that assume they own the site
// root, so they can't be nested under a sub-path of ZoFHub without service-worker
// and path collisions.  Instead each runs as its OWN service on its own port;
// the ZoFHub browser page probes /api/proxies and lists whichever are online.
//
// This launcher starts the ones that are ready on this machine:
//   • NautilusOS  — pure static, served here with a tiny built-in file server.
//   • Interstellar — run only if its deps are installed (Interstellar/node_modules).
//   • DayDream / Nebula — run only if they've been built (they need a build step).
//
// It NEVER installs or builds anything for you (those steps are heavy and can
// fail per-platform); it just reports what it started and what it skipped and
// why, so you always know exactly what the dropdown will show.

import http from 'node:http';
import { existsSync, statSync, createReadStream } from 'node:fs';
import { join, extname, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const PORTS = {
  nautilus:     Number(process.env.PROXY_NAUTILUS_PORT     || 8091),
  interstellar: Number(process.env.PROXY_INTERSTELLAR_PORT || 8092),
  daydream:     Number(process.env.PROXY_DAYDREAM_PORT     || 8093),
  nebula:       Number(process.env.PROXY_NEBULA_PORT       || 8094),
};

const MIME = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon', '.bin': 'application/octet-stream',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.map': 'application/json',
};

const started = [];
const skipped = [];
// Everything we launch, tracked so a single Ctrl+C stops it all (no orphans).
const children = [];   // spawned companion Node processes (Interstellar, …)
const servers = [];    // static http servers we own (NautilusOS)

// Free a port before we bind it. A companion child from a PREVIOUS run can
// survive a Ctrl+C and keep holding its port; without this, the next
// `npm run proxies` hits EADDRINUSE and the companion crashes with an ugly
// unhandled-error stack trace. Freeing first makes re-runs always work.
function freePort(port) {
  return new Promise((resolve) => {
    const k = spawn(process.execPath, [join(ROOT, 'tools', 'kill-port.mjs'), String(port)], { stdio: 'ignore' });
    k.on('exit', resolve);
    k.on('error', resolve);
  });
}

// Clean shutdown: kill every companion child + close our static servers so
// nothing is left orphaned holding a port after Ctrl+C.
let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('\n[proxies] stopping all companion services…');
  for (const c of children) { try { c.kill(); } catch {} }
  for (const s of servers) { try { s.close(); } catch {} }
  setTimeout(() => process.exit(0), 300);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// A minimal, safe static file server rooted at `dir`, serving index.html for
// directory requests.  Path traversal is blocked by normalising and confirming
// the resolved path stays inside `dir`.
function serveStatic(dir, port, name) {
  const server = http.createServer((req, res) => {
    try {
      let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
      if (urlPath.endsWith('/')) urlPath += 'index.html';
      const resolved = normalize(join(dir, urlPath));
      if (!resolved.startsWith(normalize(dir))) { res.writeHead(403).end('forbidden'); return; }
      let filePath = resolved;
      if (existsSync(filePath) && statSync(filePath).isDirectory()) filePath = join(filePath, 'index.html');
      if (!existsSync(filePath)) {
        // SPA-ish fallback to index.html so client routing still works.
        const fallback = join(dir, 'index.html');
        if (existsSync(fallback)) filePath = fallback;
        else { res.writeHead(404).end('not found'); return; }
      }
      res.setHeader('Content-Type', MIME[extname(filePath).toLowerCase()] || 'application/octet-stream');
      res.setHeader('Access-Control-Allow-Origin', '*');
      createReadStream(filePath).pipe(res);
    } catch (e) {
      res.writeHead(500).end('error');
    }
  });
  server.on('error', (e) => console.error(`[proxies] ${name} failed to bind :${port} — ${e.message}`));
  server.listen(port, () => {
    started.push(`${name.padEnd(13)} http://localhost:${port}/   (static)`);
    console.log(`[proxies] ${name} online → http://localhost:${port}/`);
  });
  servers.push(server);
  return server;
}

// Run a child Node app (its own server) with PORT set, inheriting stdio so its
// logs are visible.  Returns true if it was launched.
function runNode(cwd, entry, port, name, env = {}) {
  const child = spawn(process.execPath, [entry], {
    cwd, stdio: 'inherit',
    env: { ...process.env, PORT: String(port), ...env },
  });
  child.on('error', (e) => console.error(`[proxies] ${name} spawn error: ${e.message}`));
  child.on('exit', (code) => {
    if (!shuttingDown && code && code !== 0) {
      console.error(`[proxies] ${name} exited (code ${code}) — its port may already be in use. Re-run \`npm run proxies\` (it now frees ports first).`);
    }
  });
  children.push(child);
  started.push(`${name.padEnd(13)} http://localhost:${port}/   (node ${entry})`);
  console.log(`[proxies] ${name} starting → http://localhost:${port}/`);
  return child;
}

// Free every companion port FIRST — clears any orphaned process from a prior
// run so binding can't fail with EADDRINUSE. This is what makes re-running
// `npm run proxies` reliable instead of crashing the second time.
for (const p of Object.values(PORTS)) await freePort(p);

// ---- NautilusOS — pure static, always available -------------------------
const nautilusDir = join(ROOT, 'NautilusOS');
if (existsSync(join(nautilusDir, 'index.html'))) {
  serveStatic(nautilusDir, PORTS.nautilus, 'NautilusOS');
} else {
  skipped.push('NautilusOS   — folder/index.html missing (clone nautilus-os/NautilusOS).');
}

// ---- Interstellar — needs its deps installed ----------------------------
const interDir = join(ROOT, 'Interstellar');
if (existsSync(join(interDir, 'node_modules'))) {
  runNode(interDir, 'index.js', PORTS.interstellar, 'Interstellar');
} else if (existsSync(join(interDir, 'index.js'))) {
  skipped.push(`Interstellar — deps not installed.  Run:  cd Interstellar && npm install   (then re-run npm run proxies)`);
} else {
  skipped.push('Interstellar — folder/index.js missing.');
}

// ---- DayDream — needs a build (vite) ------------------------------------
const ddDir = join(ROOT, 'DayDream');
if (existsSync(join(ddDir, 'dist')) && existsSync(join(ddDir, 'node_modules'))) {
  runNode(ddDir, 'index.ts', PORTS.daydream, 'DayDream');
} else {
  skipped.push('DayDream     — not built.  Run:  cd DayDream && npm install && npm run build   (heavy; optional).');
}

// ---- Nebula — needs a build (astro + sqlite) ----------------------------
const nebDir = join(ROOT, 'Nebula');
if (existsSync(join(nebDir, 'server', 'server.js')) && existsSync(join(nebDir, 'node_modules'))) {
  runNode(nebDir, join('server', 'server.js'), PORTS.nebula, 'Nebula');
} else {
  skipped.push('Nebula       — not built.  Run:  cd Nebula && npm install && npm run build   (heavy; optional).');
}

// ---- summary ------------------------------------------------------------
setTimeout(() => {
  console.log('\n──────────────────────────────────────────────');
  console.log('Companion proxy browsers (OPTIONAL — the site works fine without any)');
  console.log('──────────────────────────────────────────────');
  if (started.length) { console.log('RUNNING:'); for (const s of started) console.log('  ✓ ' + s); }
  if (skipped.length) {
    console.log('NOT STARTED (optional — this is NOT an error; set up only if you want them):');
    for (const s of skipped) console.log('  • ' + s);
  }
  console.log('\nThese are LOCAL-ONLY extras. Your real site (and every deploy) uses the');
  console.log('built-in Scramjet · Ultraviolet · GUST engines, which always work.');
  console.log('Open /browser and any RUNNING companion above will appear in the dropdown.');
  console.log('Press Ctrl+C to stop all companion services.\n');
}, 600);
