// lib/anura-host.mjs — serve AnuraOS from this process, on its own origin.
// ---------------------------------------------------------------------------
// AnuraOS (AGPL-3.0, github.com/MercuryWorkshop/anuraOS) is a whole web OS, not
// a library. It assumes it owns a site root, and that assumption is not
// negotiable from the outside:
//
//   * its 526 files reference /assets, /libs, /apps, /bin, /x86images,
//     /bundle.css and /anura-sw.js as ROOT-absolute paths, and both /assets and
//     /browser collide with routes ZoFHub already owns;
//   * rewriting those onto /anura/* is not merely awkward, it is WRONG — the
//     same absolute strings also name paths inside the guest filesystem of the
//     emulated x86 machine (/usr, /tmp, /boot, /opfs). A rewrite fixes the URLs
//     and silently corrupts the Linux image, which looks fine until somebody
//     opens a terminal;
//   * it registers a ROOT-scoped service worker, which would fight
//     Ultraviolet's at /uv/ and Scramjet's at /scram/.
//
// So it gets a real origin instead of a subpath. An origin is scheme + host +
// PORT, which means a second listener on this same process is already a
// separate origin — no DNS, no second deployment, no rewriting, and AnuraOS
// serves from / exactly as it expects. That is the default here.
//
// Where a second port is not reachable (Render exposes one), naming a hostname
// gives the same isolation on the main listener: point a subdomain at this
// service and set ANURA_HOST.
//
// ONE FILE IS MODIFIED, AND IT IS DECLARED. Every byte is served as upstream
// published it EXCEPT /config.json, which gains a `wisp-url` pointing at this
// deployment's own tunnel — without it AnuraOS has no network at all (see
// withWispUrl below). That makes this a modified version under AGPL §5, and
// lib/licenses.mjs records it as one, exactly as it does for GUST.

import { existsSync, statSync, createReadStream, readFileSync } from 'node:fs';
import { join, normalize, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
export const ANURA_DIR = join(HERE, '..', 'vendor', 'anura');

/** Did somebody actually run `npm run fetch-anura`? */
export function anuraBundlePresent(dir = ANURA_DIR) {
  try { return statSync(join(dir, 'index.html')).isFile(); } catch { return false; }
}

// Explicit, because getting these wrong is not cosmetic: a .wasm served as
// octet-stream fails instantiateStreaming, and AnuraOS's own extensions
// (.ajs commands, .lib/.app manifests) are unknown to every mime database.
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.ajs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.lib': 'application/json; charset=utf-8',
  '.app': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.bin': 'application/octet-stream',
  '.iso': 'application/octet-stream',
  '.img': 'application/octet-stream',
};

/**
 * Rewrite AnuraOS's config so its networking points at OUR tunnel.
 *
 * AGPL §5 APPLIES TO THIS. It is a modification of the served work, declared as
 * one in lib/licenses.mjs, for the same reason and in the same shape as the
 * change ZoFHub already makes to GUST.
 *
 * WHY IT IS NECESSARY. lib/Anura.js does `new Networking(settings.get("wisp-url"))`,
 * and the shipped config.json sets no `wisp-url` at all — so the value is
 * undefined, the WebSocket constructor resolves it against the page, and the
 * browser app has no tunnel. Nothing inside AnuraOS reports this; it simply
 * fails to load sites.
 *
 * The URL is built from the REQUEST, not from config, so the tunnel is always
 * the same origin the visitor already has open. That keeps every byte of proxy
 * traffic on this deployment — no third-party relay — and it keeps working on a
 * mirror domain, which a baked-in hostname would not.
 *
 * `relay-url` is left alone: it is AnuraOS's own peer-to-peer feature, not the
 * proxy path, and repointing something we do not serve would be a lie.
 */
function withWispUrl(raw, req, port) {
  const proto = String(req?.headers?.['x-forwarded-proto'] || '').split(',')[0].trim()
    || (req?.socket?.encrypted ? 'https' : 'http');
  const rawHost = String(req?.headers?.['x-forwarded-host'] || req?.headers?.host || '')
    .split(',')[0].trim();
  const hostname = rawHost.replace(/:\d+$/, '') || '127.0.0.1';
  const authority = port ? `${hostname}:${port}` : rawHost || hostname;
  const scheme = proto === 'https' ? 'wss' : 'ws';

  const cfg = JSON.parse(raw);
  cfg.defaultsettings = { ...(cfg.defaultsettings || {}), 'wisp-url': `${scheme}://${authority}/wisp/` };
  return JSON.stringify(cfg);
}

/**
 * The request handler that serves the bundle as a site root.
 *
 * Deliberately not express.static: this runs on its own origin and must set
 * cross-origin isolation headers on EVERY response, including the 404s, or the
 * one request that misses them costs the whole document its SharedArrayBuffer.
 *
 * `port` is the port this handler is reachable on, when it is a second listener.
 * It is needed only to build the wisp-url, whose authority must carry the port.
 */
export function anuraHandler(dir = ANURA_DIR, { port = null } = {}) {
  const root = normalize(dir);

  return function serveAnura(req, res) {
    // v86 needs SharedArrayBuffer, which the browser only grants to a
    // cross-origin-isolated document. Without both of these the emulator does
    // not start and the failure surfaces as an unrelated-looking console error.
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    // Its own assets must be loadable under require-corp.
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    // This origin serves ONE third-party app and nothing of ZoFHub's. It is not
    // an open file host: no directory listings, no traversal, no upload.
    res.setHeader('X-Content-Type-Options', 'nosniff');

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.statusCode = 405;
      res.setHeader('Allow', 'GET, HEAD');
      return res.end();
    }

    let pathname;
    try {
      pathname = decodeURIComponent(new URL(req.url, 'http://anura.invalid').pathname);
    } catch {
      res.statusCode = 400;
      return res.end('bad request');
    }
    if (pathname.endsWith('/')) pathname += 'index.html';

    // Traversal guard. normalize() resolves ".." BEFORE the prefix check, and
    // the separator on the end stops /vendor/anura-evil from passing a plain
    // startsWith against /vendor/anura.
    const full = normalize(join(root, pathname));
    if (full !== root && !full.startsWith(root + sep)) {
      res.statusCode = 403;
      return res.end('forbidden');
    }

    let st;
    try { st = statSync(full); } catch { st = null; }
    if (!st || !st.isFile()) {
      res.statusCode = 404;
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      return res.end('not found');
    }

    // The one file that is not served verbatim — see withWispUrl().
    if (pathname === '/config.json') {
      let out;
      try {
        out = withWispUrl(readFileSync(full, 'utf8'), req, port);
      } catch {
        // A config we cannot parse is upstream's to fix; serving it unchanged
        // is closer to correct than serving nothing.
        out = null;
      }
      if (out !== null) {
        const buf = Buffer.from(out, 'utf8');
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Content-Length', String(buf.length));
        // Derived from the request host, so it must not be cached across hosts.
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Vary', 'Host, X-Forwarded-Host, X-Forwarded-Proto');
        return req.method === 'HEAD' ? res.end() : res.end(buf);
      }
    }

    res.setHeader('Content-Type', TYPES[extname(full).toLowerCase()] || 'application/octet-stream');
    res.setHeader('Content-Length', String(st.size));
    // The bundle is immutable for a given fetch; the digest in
    // data/anura-release.json is what changes when it is refreshed.
    res.setHeader('Cache-Control', 'public, max-age=3600');

    if (req.method === 'HEAD') return res.end();
    const stream = createReadStream(full);
    stream.on('error', () => { res.destroy(); });
    return stream.pipe(res);
  };
}

/**
 * How is AnuraOS exposed, if at all?
 *
 * Precedence is deliberate, most explicit first:
 *   1. PROXY_ANURA_URL — somebody else's deployment. We serve nothing.
 *   2. ANURA_HOST      — a hostname pointed at THIS service; host-based origin
 *                        on the main listener. The production shape.
 *   3. ANURA_PORT      — a second listener here. Different port, different
 *                        origin, zero configuration. The default.
 *
 * Returns { mode, host, port, externalUrl, serves } where `serves` says whether
 * THIS process is responsible for the bytes.
 */
export function anuraExposure(env = process.env, { present = anuraBundlePresent() } = {}) {
  const external = String(env.PROXY_ANURA_URL || '').trim();
  if (external) {
    return { mode: 'external', externalUrl: external, serves: false, present };
  }
  // Nothing to serve. Say so rather than advertising an engine that 404s.
  if (!present) return { mode: 'absent', serves: false, present };

  const host = String(env.ANURA_HOST || '').trim().toLowerCase();
  if (host) return { mode: 'host', host, serves: true, present };

  // 0 / off is a real choice: an operator who does not want a second listener.
  const raw = String(env.ANURA_PORT ?? '').trim();
  if (/^(0|off|false|no)$/i.test(raw)) return { mode: 'disabled', serves: false, present };

  // UNSET and INVALID are different answers. `Number('banana') || 8095` treats
  // a typo as "use the default", which quietly serves on a port the operator
  // never chose — and then the one thing they would have grepped the config for
  // is not the port in use. Only an absent value falls back.
  if (raw === '') return { mode: 'port', port: 8095, serves: true, present };

  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { mode: 'disabled', serves: false, present, reason: `invalid ANURA_PORT "${raw}"` };
  }
  return { mode: 'port', port, serves: true, present };
}

/**
 * The URL a BROWSER should open, resolved against the request that asked.
 *
 * Request-derived on purpose: the whole site is domain-agnostic so it can be
 * redeployed on a throwaway mirror, and an engine URL baked to one hostname
 * would send visitors of the mirror back to the blocked domain. `null` means
 * there is nothing to offer, which the caller must treat as "no entry" rather
 * than "entry that is down".
 */
export function anuraUrlFor(req, exposure) {
  if (!exposure || exposure.mode === 'absent' || exposure.mode === 'disabled') return null;
  if (exposure.mode === 'external') return exposure.externalUrl;

  const proto = String(req?.headers?.['x-forwarded-proto'] || req?.protocol || 'http')
    .split(',')[0].trim();

  if (exposure.mode === 'host') return `${proto}://${exposure.host}/`;

  // Port mode. Keep the hostname the visitor is already using — 'localhost' for
  // a developer, the mirror's name for everyone else — and swap only the port.
  const rawHost = String(req?.headers?.['x-forwarded-host'] || req?.headers?.host || '')
    .split(',')[0].trim();
  const hostname = rawHost.replace(/:\d+$/, '') || '127.0.0.1';
  return `${proto}://${hostname}:${exposure.port}/`;
}
