// ============================================================================
// proxy-engine/mount.mjs — every AGPL proxy engine, behind one function.
// ----------------------------------------------------------------------------
// WHAT THIS IS. All routing, static mounting and tunnel wiring for GUST
// (libcurl.js + Wisp), Ultraviolet and Scramjet. Nothing else in the repository
// references these packages, and nothing in here touches Supabase, the catalog,
// the admin console, donations, feedback or any other ZoFHub feature. The only
// thing that crosses the boundary is an Express app and a Wisp handle.
//
// WHAT THIS IS NOT — READ THIS BEFORE RELYING ON IT.
//
// Moving these files into their own folder is GOOD ENGINEERING and is NOT a
// change to anyone's licence position. A directory is not a legal boundary.
// The AGPL's reach turns on whether two things form one combined program and on
// what is conveyed to users — not on where the source files sit in a tree, and
// not on which folder an npm package is mounted from. The same server process,
// the same deployment, the same origin and the same `npm install` are unchanged
// by this refactor, so anything that was true of ZoFHub's obligations before is
// still exactly true now.
//
// What IS true, and is what actually keeps this project compliant:
//   · These engines are UNMODIFIED upstream releases. AGPL-3.0 §5's obligation
//     to carry prominent change notices applies to MODIFIED versions; there are
//     none here. (Verified: zero changed files under every vendored copy and
//     every @mercuryworkshop / @titaniumnetwork-dev package.)
//   · They are served to users over a network, so AGPL-3.0 §13's source offer
//     applies, and docs/CREDITS.md carries it.
//
// If real separation is ever the goal — a different program, not a different
// folder — it needs a genuinely separate service: its own repository, its own
// deployment, its own origin and its own process, talking to the hub at arm's
// length. This module is shaped to make that move mechanical when the time
// comes (one function, one export, no imports from the hub), but on its own it
// does not achieve it, and nobody should plan around the idea that it does.
//
// SAME-ORIGIN IS DELIBERATE. The tunnel endpoint stays on this domain on
// purpose: GUST's Wisp target is rewritten to our own /wisp/ so that when the
// proxy is reachable, every byte of proxy traffic stays on this origin. Moving
// these engines to a foreign origin would break that property, defeat the cloak
// and require opening CORS and CSP to a third party. It is not done here.
// ============================================================================

import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ENGINE_DIR = dirname(fileURLToPath(import.meta.url));
const ASSETS = join(ENGINE_DIR, 'assets');

/** Locate an installed package directory, wherever node put it. */
function findNodeModulesDir(pkg, repoRoot) {
  const candidates = require.resolve.paths('') || [];
  for (const root of candidates) {
    const p = join(root, ...pkg.split('/'));
    if (existsSync(p)) return p;
  }
  const local = join(repoRoot, 'node_modules', ...pkg.split('/'));
  return existsSync(local) ? local : null;
}

/**
 * Mount every proxy engine onto an Express app.
 *
 * URL paths are IDENTICAL to the pre-extraction layout (/uv/, /scram/,
 * /baremux/, /epoxy/, /gust, /proxy). The service workers and the GUST bundle
 * are origin-sensitive — a service worker's scope is its own URL path — so the
 * files moved but the addresses did not, and no client needed changing.
 *
 * @returns {{ proxyStatus: object, wisp: object|null }}
 */
export function mountProxyEngines(app, express, { repoRoot } = {}) {
  const proxyStatus = {
    gust: false, horizon: false, interstellar: false,
    ultraviolet: false, scramjet: false,
    bare: false, wisp: false, epoxy: false, libcurl: false,
  };
  const root = repoRoot || join(ENGINE_DIR, '..');
  let wisp = null;

  // ── GUST — libcurl.js + Wisp, no service worker ──────────────────────────
  // A single vendored HTML bundle plus its own assets (libcurl, font-awesome,
  // pdf.js, iso-639-1), all served from this origin.
  const gustIndex = join(ASSETS, 'gust', 'index.html');
  if (existsSync(gustIndex)) {
    proxyStatus.gust = true;
    // The explicit document route is registered BEFORE the asset mount so the
    // bare /gust and /proxy paths always resolve to the bundle itself.
    app.get(['/gust', '/proxy'], (req, res) => res.sendFile(gustIndex));
    // GUST vendors pdf.js as ES modules (.mjs). Some Express/send builds do not
    // map that extension, and a wrong MIME makes the browser refuse the module
    // import outright. This used to be handled by the public/ static mount;
    // when the bundle moved out of public/ the fix had to come with it.
    app.use('/gust', express.static(join(ASSETS, 'gust'), {
      setHeaders(res, filePath) {
        if (filePath.endsWith('.mjs')) {
          res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
        }
      },
    }));
  } else {
    console.warn('[zofhub] GUST: proxy-engine/assets/gust/index.html missing — engine unavailable.');
  }

  // ── HORIZON ──────────────────────────────────────────────────────────────────────────────
  // A single self-contained HTML file (a remodelled GUST): libcurl + Wisp, no
  // service worker, no assets of its own. Served at /horizon exactly as GUST is
  // served at /gust. Vendored with its Wisp target repointed to this origin's
  // /wisp/ and its third-party relay pool removed, so its egress is governed by
  // the same tunnel as every other engine (see the file header and
  // /licenses/horizon-modifications).
  const horizonIndex = join(ASSETS, 'horizon', 'index.html');
  if (existsSync(horizonIndex)) {
    proxyStatus.horizon = true;
    app.get('/horizon', (req, res) => res.sendFile(horizonIndex));
  } else {
    console.warn('[zofhub] HORIZON: proxy-engine/assets/horizon/index.html missing ─ engine unavailable.');
  }

  // ── Interstellar ─────────────────────────────────────────────────────────────────────────
  // A multi-page proxy UI that drives Ultraviolet + Scramjet through ITS OWN
  // service worker, scoped to /interstellar/uv/. Unlike GUST and HORIZON it has
  // a tree of pages and assets, all vendored under assets/interstellar and
  // rewritten at vendor time to live beneath /interstellar. The UV and Scramjet
  // ENGINE files are NOT vendored (they would drift from the package); they are
  // served from the installed packages below, while the CONFIG files that name
  // this mount's prefixes come from the vendored tree.
  const interDir = join(ASSETS, 'interstellar');
  const interIndex = join(interDir, 'index.html');
  if (existsSync(interIndex)) {
    proxyStatus.interstellar = true;
    const page = (file) => (req, res) => res.sendFile(join(interDir, file));
    app.get('/interstellar', page('index.html'));
    app.get('/interstellar/home', page('home.html'));
    app.get('/interstellar/games', page('games.html'));
    app.get(['/interstellar/apps', '/interstellar/play.html'], page('apps.html'));
    app.get('/interstellar/settings', page('settings.html'));
    app.get('/interstellar/tabs', page('tabs.html'));
    // The content-filter endpoint the search box calls on every navigation.
    // Interstellar ships filtering OFF; a stub keeps that a clean 200 rather
    // than a 404 on every keystroke. ZoFHub's approved-destination policy is
    // what actually governs where the tunnel may connect, not this.
    app.post('/interstellar/filter/verdict', (req, res) => res.json({ blocked: false }));
    // Our rewritten engine CONFIGS win over the package files of the same name.
    app.get('/interstellar/assets/ultraviolet/uv.config.js',
      (req, res) => res.sendFile(join(interDir, 'assets', 'ultraviolet', 'uv.config.js')));
    app.get('/interstellar/assets/scramjet/scramjet.config.js',
      (req, res) => res.sendFile(join(interDir, 'assets', 'scramjet', 'scramjet.config.js')));
    try {
      const { uvPath } = require('@titaniumnetwork-dev/ultraviolet');
      if (uvPath && existsSync(uvPath)) app.use('/interstellar/assets/ultraviolet/', express.static(uvPath));
    } catch (e) { console.warn('[zofhub] Interstellar/UV:', e.message); }
    const sjRoot = findNodeModulesDir('@mercuryworkshop/scramjet', root);
    if (sjRoot && existsSync(join(sjRoot, 'dist'))) app.use('/interstellar/assets/scramjet/', express.static(join(sjRoot, 'dist')));
    // Everything else Interstellar ships (page assets, SW, media, block pages).
    app.use('/interstellar', express.static(interDir, {
      setHeaders(res, filePath) {
        if (filePath.endsWith('sw.js')) res.setHeader('Service-Worker-Allowed', '/interstellar/');
        if (filePath.endsWith('.mjs')) res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
      },
    }));
  } else {
    console.warn('[zofhub] Interstellar: proxy-engine/assets/interstellar/index.html missing ─ engine unavailable.');
  }

  // ── Ultraviolet ──────────────────────────────────────────────────────────
  // Our own uv.config.js must win over the package default, so it is registered
  // ahead of the package static mount.
  app.get('/uv/uv.config.js', (req, res) => res.sendFile(join(ASSETS, 'uv', 'uv.config.js')));
  try {
    const { uvPath } = require('@titaniumnetwork-dev/ultraviolet');
    if (uvPath && existsSync(uvPath)) {
      app.use('/uv/', express.static(uvPath));
      proxyStatus.ultraviolet = true;
    }
  } catch (e) { console.warn('[zofhub] Ultraviolet:', e.message); }

  // ── Shared transport: bare-mux → epoxy → /wisp/ ──────────────────────────
  const bareRoot = findNodeModulesDir('@mercuryworkshop/bare-mux', root);
  const epoxyRoot = findNodeModulesDir('@mercuryworkshop/epoxy-transport', root);
  if (bareRoot && existsSync(join(bareRoot, 'dist'))) {
    app.use('/baremux/', express.static(join(bareRoot, 'dist')));
    proxyStatus.bare = true;
  }
  if (epoxyRoot && existsSync(join(epoxyRoot, 'dist'))) {
    app.use('/epoxy/', express.static(join(epoxyRoot, 'dist')));
    proxyStatus.epoxy = true;
  }
  // libcurl.js transport ─ the alternative Interstellar offers in Settings. Only
  // reached when a visitor switches off epoxy, but a 404 there would strand them
  // with a dead tunnel and no hint why, so it is mounted whenever installed.
  const libcurlRoot = findNodeModulesDir('@mercuryworkshop/libcurl-transport', root);
  if (libcurlRoot && existsSync(join(libcurlRoot, 'dist'))) {
    app.use('/libcurl/', express.static(join(libcurlRoot, 'dist')));
    proxyStatus.libcurl = true;
  }

  // ── Scramjet ─────────────────────────────────────────────────────────────
  // Shares the SAME transport as Ultraviolet; only the in-page rewriting engine
  // and its service worker differ. Our fetch-handling SW wraps the packaged
  // worker factory, so its explicit route must beat the package static mount.
  app.get('/scram/scramjet.sw.js', (req, res) =>
    res.sendFile(join(ASSETS, 'scram', 'scramjet.sw.js')));
  const scramjetRoot = findNodeModulesDir('@mercuryworkshop/scramjet', root);
  if (scramjetRoot && existsSync(join(scramjetRoot, 'dist'))) {
    app.use('/scram/', express.static(join(scramjetRoot, 'dist')));
    proxyStatus.scramjet = true;
  }

  // ── Wisp tunnel ──────────────────────────────────────────────────────────
  // Returned rather than wired here: the HTTP upgrade event belongs to the
  // server object, which this module deliberately does not receive.
  try {
    wisp = require('@mercuryworkshop/wisp-js/server').server;
    proxyStatus.wisp = true;
  } catch (e) { console.warn('[zofhub] Wisp:', e.message); }

  return { proxyStatus, wisp };
}

/**
 * Route a WebSocket upgrade into the Wisp tunnel.
 * Returns true when the request was handled, so the caller can decide what to
 * do with everything else.
 *
 * `connOptions` is wisp-js's own extension point, not a local invention:
 * routeRequest threads it into `new ServerConnection(ws, path, conn_options)`,
 * which reads `{TCPSocket}` out of it (server/connection.mjs). ZoFHub passes a
 * socket class that dials through sing-box, which is how the proxy's egress is
 * redirected WITHOUT modifying a byte of the AGPL engine — the difference
 * between using a package and forking one, and the reason docs/CREDITS.md can still
 * say these engines run unmodified.
 *
 * Passed per-upgrade rather than captured once at mount time so the egress
 * decision is re-read per connection: a supervised sing-box that died and came
 * back does not need a redeploy to be used again.
 *
 * ── THE PATH IS MATCHED EXACTLY, AND THAT IS A SECURITY CONTROL ────────────
 * wisp-js offers TWO protocols on one route and picks between them by looking
 * at the URL: `path.endsWith("/")` gets ServerConnection (the Wisp protocol),
 * and ANYTHING ELSE gets WSProxyConnection (server/wsproxy.mjs), a plain
 * host:port relay addressed as `/wisp/example.com:443`.
 *
 * WSProxyConnection takes `(ws, path)` and ignores conn_options entirely — it
 * hard-codes `new NodeTCPSocket(...)`. So a client that asks for the wsproxy
 * shape gets a connection dialled straight out of Node: past sing-box, past
 * `egressStats()`, and past SINGBOX_REQUIRE=1, whose entire promise is that the
 * server's own IP is never the one that shows up at the origin. A prefix match
 * here would leave that opt-out reachable by anyone who can type a URL.
 *
 * Every ZoFHub client asks for exactly `/wisp/` — GUST's GUST_DEFAULT_WISP and
 * browser.js's `setTransport` both build that string and nothing else — so an
 * exact match costs us nothing and closes the bypass. A query string is
 * rejected too, deliberately: wisp-js tests the RAW url, so `/wisp/?x=1` does
 * not end in `/` and would fall through to wsproxy as surely as a host:port.
 *
 * (This is not an SSRF hole in either branch — wsproxy does run the same
 * `filter.is_stream_allowed` check, so loopback and private ranges stay
 * refused. What leaks is the egress path, not the target.)
 */
const WISP_PATH = '/wisp/';

export function routeProxyUpgrade(wisp, req, socket, head, connOptions = {}) {
  if (req?.url !== WISP_PATH || !wisp?.routeRequest) return false;
  wisp.routeRequest(req, socket, head, { ...connOptions });
  return true;
}
