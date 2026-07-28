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
// logs are visible.  `extraArgs` lets a companion be launched through a runner
// (DayDream's entry point is TypeScript, so it goes through tsx).
function runNode(cwd, entry, port, name, env = {}, extraArgs = []) {
  const child = spawn(process.execPath, [entry, ...extraArgs], {
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
  started.push(`${name.padEnd(13)} http://localhost:${port}/   (node ${extraArgs.length ? extraArgs.join(' ') : entry})`);
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

// ---- DayDream — needs deps + a vite build + config.js --------------------
// Each precondition is reported SEPARATELY. A single "not built" catch-all
// couldn't tell you whether deps were missing, the build hadn't run, or a
// config file was absent — so you'd re-run the wrong command and still be
// stuck. index.ts is TypeScript, so it's launched through tsx.
const ddDir = join(ROOT, 'DayDream');
// NOTE: the build check targets dist/index.html, not just dist/. The vite build
// writes dist/ early (static assets are copied first) and index.html LAST, so a
// bare existsSync('dist') is true while a build is still running or after one
// that died halfway — and DayDream would then launch and serve 404s to a
// dropdown entry that looked healthy.
const ddMissing = [
  !existsSync(join(ddDir, 'node_modules'))          && 'deps not installed (cd DayDream && pnpm install)',
  !existsSync(join(ddDir, 'dist', 'index.html'))    && 'not built (cd DayDream && pnpm run build)',
  !existsSync(join(ddDir, 'config.js'))             && 'config.js missing (copy config.example.js → config.js and set a real marketplace psk)',
].filter(Boolean);
if (!existsSync(join(ddDir, 'index.ts'))) {
  skipped.push('DayDream     — folder/index.ts missing.');
} else if (ddMissing.length) {
  skipped.push(`DayDream     — ${ddMissing.join('; ')}.`);
} else {
  runNode(ddDir, join('node_modules', 'tsx', 'dist', 'cli.mjs'), PORTS.daydream, 'DayDream', {}, ['index.ts']);
}

// ---- Nebula — needs deps + BOTH halves of its build ----------------------
// Nebula is a pnpm project (npm install produces a broken tree) and its build
// has two halves: `build:server` compiles server/server.ts → server/server.js,
// and `build:client` produces dist/server/entry.mjs, which server.js imports at
// startup. Checking only server/server.js used to silently skip Nebula forever
// while saying nothing about WHY, and the advice it printed (npm) was wrong.
const nebDir = join(ROOT, 'Nebula');
const nebMissing = [
  !existsSync(join(nebDir, 'node_modules'))                  && 'deps not installed (cd Nebula && pnpm install)',
  !existsSync(join(nebDir, 'server', 'server.js'))           && 'server not compiled (cd Nebula && pnpm run build:server)',
  !existsSync(join(nebDir, 'dist', 'server', 'entry.mjs'))   && 'client not built (cd Nebula && pnpm run build:client)',
  !existsSync(join(nebDir, 'config.toml'))                   && 'config.toml missing (copy config.example.toml → config.toml)',
].filter(Boolean);
if (!existsSync(join(nebDir, 'package.json'))) {
  skipped.push('Nebula       — folder missing.');
} else if (nebMissing.length) {
  skipped.push(`Nebula       — ${nebMissing.join('; ')}.`);
} else {
  runNode(nebDir, join('server', 'server.js'), PORTS.nebula, 'Nebula');
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
