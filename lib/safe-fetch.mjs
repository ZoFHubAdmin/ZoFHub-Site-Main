// ============================================================================
// safe-fetch.mjs — outbound HTTP for URLs this server did not choose itself.
//
// THE HOLE THIS CLOSES. Several routes fetch a URL that came from somewhere
// other than this codebase: a query parameter, a catalog row ingested from a
// third-party feed, a community submission. They were guarded by
// isInternalHost(), a STRING test on the hostname, and then handed to
// fetch(url, { redirect: 'follow' }). Two ways straight past that:
//
//   1. REDIRECTS. Only the first URL was checked. A public host that answers
//      `302 Location: http://169.254.169.254/latest/meta-data/` was followed,
//      by the server, to the cloud metadata service — with the scheme
//      downgraded to http on the way, which the https-only check never saw.
//   2. DNS. A hostname is not an address. `anything.example` can resolve to
//      127.0.0.1 or 10.0.0.5 (or resolve publicly for the check and privately
//      a moment later — DNS rebinding), and a string test cannot know.
//
// HOW. Every connection is made through node:http/https with a custom
// `lookup`: the address is validated at the moment the socket is opened, on
// the exact address the socket connects to, so there is no window between
// "checked" and "used" to rebind in. IP-literal hosts (which never reach
// `lookup`) are checked directly. Redirects are followed by hand, and each hop
// is re-validated from scratch — scheme, credentials, port and address.
//
// WHAT IT RETURNS. A standard web `Response`, so existing callers keep using
// .status, .ok, .headers.get(), .text(), .arrayBuffer() and .body unchanged.
// ============================================================================

import http from 'node:http';
import https from 'node:https';
import { lookup as dnsLookup } from 'node:dns';
import { isIP, BlockList } from 'node:net';
import { Readable, Transform } from 'node:stream';
import zlib from 'node:zlib';

// ── Address policy ─────────────────────────────────────────────────────────
// Everything that is not ordinary public unicast. Sources: IANA IPv4/IPv6
// Special-Purpose Address Registries (RFC 6890 and successors).
const BLOCKED = new BlockList();
for (const [net, bits] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
]) BLOCKED.addSubnet(net, bits, 'ipv4');
for (const [net, bits] of [
  ['::', 128], ['::1', 128], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['100::', 64],
  ['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['fc00::', 7], ['fe80::', 10],
  ['fec0::', 10], ['ff00::', 8],
]) BLOCKED.addSubnet(net, bits, 'ipv6');

/** Is `ip` a public unicast address this server may connect to? */
export function isPublicAddress(ip) {
  const s = String(ip || '').replace(/^\[|\]$/g, '');
  const fam = isIP(s);
  if (fam === 4) return !BLOCKED.check(s, 'ipv4');
  if (fam === 6) {
    // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible forms are judged as the
    // IPv4 address they carry — ::ffff:127.0.0.1 is loopback.
    const mapped = s.toLowerCase().match(/^::(?:ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/);
    if (mapped) return isPublicAddress(mapped[1]);
    const hexMapped = s.toLowerCase().match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (hexMapped) {
      const a = parseInt(hexMapped[1], 16), b = parseInt(hexMapped[2], 16);
      return isPublicAddress(`${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`);
    }
    if (/^::ffff:/i.test(s)) return false;
    return !BLOCKED.check(s, 'ipv6');
  }
  return false;
}

export class BlockedDestinationError extends Error {
  constructor(message) { super(message); this.name = 'BlockedDestinationError'; this.code = 'EBLOCKED'; }
}

/**
 * A dns.lookup replacement that refuses non-public answers. If ANY address a
 * name resolves to is private, the whole name is refused: a host that is
 * public and private at once is exactly the rebinding shape.
 * Supports both call shapes net.connect uses ({ all: true } for happy-eyeballs).
 */
export function guardedLookup(hostname, options, callback) {
  if (typeof options === 'function') { callback = options; options = {}; }
  const opts = typeof options === 'number' ? { family: options } : { ...(options || {}) };
  dnsLookup(hostname, { ...opts, all: true }, (err, addresses) => {
    if (err) return callback(err);
    const list = Array.isArray(addresses) ? addresses : [];
    if (!list.length) return callback(new BlockedDestinationError(`${hostname} did not resolve`));
    const bad = list.find((a) => !isPublicAddress(a.address));
    if (bad) return callback(new BlockedDestinationError(`${hostname} resolves to a non-public address`));
    if (opts.all) return callback(null, list);
    return callback(null, list[0].address, list[0].family);
  });
}

// Ports a game CDN, thumbnail host or publisher page actually uses. Anything
// else turns this server into a port scanner for the public internet.
const ALLOWED_PORTS = new Set(['', '80', '443', '8080', '8443']);

/**
 * Validate one URL before connecting. Throws BlockedDestinationError.
 * Exported so callers can reject early with a clean 4xx.
 *
 * `denyHost` is a caller's own refusal list, applied to EVERY hop rather than
 * only the first — the server passes lib/ai-hosts.mjs here, so a public host
 * that redirects to an inference endpoint is refused before that second
 * connection is ever opened. `allowedPorts` exists for tests that need a real
 * listener on an ephemeral port; no production caller changes it.
 */
export function assertFetchable(url, { allowHttp = false, denyHost = null, allowedPorts = ALLOWED_PORTS } = {}) {
  let u;
  try { u = url instanceof URL ? url : new URL(String(url)); }
  catch { throw new BlockedDestinationError('not a valid URL'); }
  if (u.protocol !== 'https:' && !(allowHttp && u.protocol === 'http:')) {
    throw new BlockedDestinationError(`scheme ${u.protocol} is not allowed`);
  }
  if (u.username || u.password) throw new BlockedDestinationError('credentials in URL are not allowed');
  if (!allowedPorts.has(u.port)) throw new BlockedDestinationError(`port ${u.port} is not allowed`);
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (!host) throw new BlockedDestinationError('no host');
  if (typeof denyHost === 'function' && denyHost(host)) {
    throw new BlockedDestinationError('destination is not fetched by this server');
  }
  if (isIP(host) && !isPublicAddress(host)) {
    throw new BlockedDestinationError('address is not public');
  }
  if (/^localhost\.?$/i.test(host) || /\.(localhost|local|internal|intranet|lan|home\.arpa)\.?$/i.test(host)) {
    throw new BlockedDestinationError('internal hostname');
  }
  return u;
}

// Response headers that describe the CONNECTION or the encoding we undo, not
// the resource — never forwarded into the Response we hand back.
const DROP_HEADERS = new Set([
  'connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'proxy-authenticate',
  'proxy-connection', 'te', 'trailer', 'content-encoding', 'content-length', 'set-cookie',
]);

function capBytes(maxBytes) {
  let seen = 0;
  return new Transform({
    transform(chunk, _enc, cb) {
      seen += chunk.length;
      if (seen > maxBytes) return cb(new Error('response exceeds size limit'));
      cb(null, chunk);
    },
  });
}

function decoderFor(encoding) {
  const e = String(encoding || '').trim().toLowerCase();
  if (e === 'gzip' || e === 'x-gzip') return zlib.createGunzip();
  if (e === 'deflate') return zlib.createInflate();
  if (e === 'br') return zlib.createBrotliDecompress();
  return null;
}

function requestOnce(u, { method, headers, timeoutMs, lookup }) {
  return new Promise((resolve, reject) => {
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request(u, {
      method,
      headers,
      lookup,
      // Never reuse a pooled socket: pooled sockets were opened (and their
      // address validated) for some earlier request.
      agent: false,
    });
    const ttfb = setTimeout(() => {
      const e = new Error('upstream timed out'); e.name = 'AbortError';
      req.destroy(e);
    }, timeoutMs);
    req.on('response', (res) => {
      clearTimeout(ttfb);
      // Idle guard for the body: a peer that stops sending is dropped.
      req.setTimeout(60_000, () => req.destroy(new Error('upstream stalled')));
      resolve(res);
    });
    req.on('error', (e) => { clearTimeout(ttfb); reject(e); });
    req.end();
  });
}

/**
 * Fetch `url` with every hop validated. Resolves to a web Response.
 *
 * @param {string|URL} url
 * @param {object}  [o]
 * @param {string}  [o.method='GET']
 * @param {object}  [o.headers]
 * @param {number}  [o.timeoutMs=15000]   time to first byte, per hop
 * @param {number}  [o.maxRedirects=5]
 * @param {boolean} [o.allowHttp=false]   permit plain http (still address-checked)
 * @param {number}  [o.maxBytes=104857600] decoded body ceiling
 * @param {(host: string) => boolean} [o.denyHost] refuse these hosts on every hop
 * @param {Set<string>} [o.allowedPorts]  tests only; see assertFetchable
 */
export async function safeFetch(url, {
  method = 'GET', headers = {}, timeoutMs = 15_000, maxRedirects = 5,
  allowHttp = false, maxBytes = 100 * 1024 * 1024, lookup = guardedLookup,
  denyHost = null, allowedPorts = ALLOWED_PORTS,
} = {}) {
  const policy = { allowHttp, denyHost, allowedPorts };
  let current = assertFetchable(url, policy);
  // Only encodings this module can undo; anything else would reach the caller
  // still compressed with no header saying so.
  const hdrs = { ...headers, 'accept-encoding': 'gzip, deflate, br' };
  delete hdrs['Accept-Encoding'];

  for (let hop = 0; ; hop++) {
    const res = await requestOnce(current, { method, headers: hdrs, timeoutMs, lookup });
    const status = res.statusCode || 502;
    const location = res.headers.location;
    if (status >= 300 && status < 400 && location && hop < maxRedirects) {
      res.resume();                                   // discard the redirect body
      let next;
      try { next = new URL(location, current); }
      catch { throw new BlockedDestinationError('redirect to an invalid URL'); }
      current = assertFetchable(next, policy);
      // A redirect never carries the original Referer across hosts it chose.
      continue;
    }

    const out = new Headers();
    for (const [k, v] of Object.entries(res.headers)) {
      if (DROP_HEADERS.has(k.toLowerCase()) || v === undefined) continue;
      out.set(k, Array.isArray(v) ? v.join(', ') : String(v));
    }
    const nullBody = method === 'HEAD' || [101, 103, 204, 205, 304].includes(status);
    let body = null;
    if (!nullBody) {
      const dec = decoderFor(res.headers['content-encoding']);
      let stream = dec ? res.pipe(dec) : res;
      if (dec) res.on('error', (e) => dec.destroy(e));
      const cap = capBytes(maxBytes);
      stream.on('error', (e) => cap.destroy(e));
      stream = stream.pipe(cap);
      body = Readable.toWeb(stream);
    } else {
      res.resume();
    }
    // Response() only accepts 200-599; anything else from a broken upstream is
    // reported as a gateway error rather than thrown as a TypeError.
    const safeStatus = status >= 200 && status <= 599 ? status : 502;
    const response = new Response(body, { status: safeStatus, headers: out });
    Object.defineProperty(response, 'url', { value: current.href });
    return response;
  }
}
