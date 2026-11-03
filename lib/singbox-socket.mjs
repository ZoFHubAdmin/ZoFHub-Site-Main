// lib/singbox-socket.mjs — route the proxy's egress through sing-box.
// ---------------------------------------------------------------------------
// THIS is what makes sing-box part of the site rather than a dashboard widget.
// Every TCP stream the Wisp tunnel opens on a visitor's behalf is dialled
// through sing-box's local SOCKS5 inbound instead of straight out of Node, so
// sing-box carries the site's actual proxy traffic and its Clash API reports
// real connections instead of an empty table.
//
// ── HOW IT ATTACHES (no upstream patch) ────────────────────────────────────
// wisp-js supports an injectable socket class: ServerConnection reads
// `{TCPSocket}` out of the conn_options that routeRequest() threads through
// (see node_modules/@mercuryworkshop/wisp-js/src/server/connection.mjs — the
// `this.TCPSocket = TCPSocket || NodeTCPSocket` line). We pass this class there.
// The AGPL engine is used through a documented extension point and stays
// byte-for-byte unmodified, which is what keeps docs/CREDITS.md's §13 offer honest.
//
// ── THERE IS NO DIRECT FALLBACK ────────────────────────────────────────────
// This module used to fall back to a direct connection when the daemon did not
// answer ("degraded and visible beats broken and mysterious"). That fallback is
// gone. It fired exactly when sing-box was down — which is exactly when the
// server's own address would be exposed to a destination — so the control
// failed open at the moment it mattered. A stream the daemon cannot carry is now
// REFUSED (EgressUnavailableError, counted, visible in /api/admin/proxy) and the
// visitor retries; it is never quietly dialled from this host instead.
//
// The only way to a direct dial is lib/egress-policy.mjs: a developer outside
// production setting SINGBOX_ALLOW_DIRECT=1 (or the older SINGBOX_REQUIRE=0 /
// SINGBOX_EGRESS=0). In production those variables are ignored.
//
// ── WHAT THIS DOES NOT WEAKEN ──────────────────────────────────────────────
// wisp-js runs its own SSRF filter (server/filter.mjs) BEFORE connect(): it
// resolves the hostname itself and refuses loopback/private targets regardless
// of which socket class is injected, and the shipped config blocks private
// ranges again at the routing layer. Two independent checks, neither of which
// relies on this file being correct.
//
// ── DNS IS RESOLVED LOCALLY, BY DESIGN ─────────────────────────────────────
// This layer does NOT give the site remote DNS, and it would be wrong to claim
// it does. ZoFHub wraps this class in GuardedTCPSocket (server.js), which
// resolves the destination itself, verifies every answer is a public address,
// and replaces the hostname with the one it validated — closing the rebinding
// window between the policy check and the dial. So this server's resolver sees
// every proxied hostname. What sing-box provides is EGRESS: the origin sees the
// daemon's address, not this server's.

import net from 'node:net';
import { egressPolicy, EgressUnavailableError } from './egress-policy.mjs';

// ── Tunables ───────────────────────────────────────────────────────────────

/** Where sing-box's mixed/SOCKS inbound listens. Loopback by default. */
export function socksTarget(env = process.env) {
  const raw = String(env.SINGBOX_SOCKS || '127.0.0.1:2080').trim();
  const i = raw.lastIndexOf(':');
  if (i < 1) return { host: '127.0.0.1', port: 2080 };
  const port = Number(raw.slice(i + 1));
  return {
    host: raw.slice(0, i).replace(/^\[|\]$/g, '') || '127.0.0.1',
    port: Number.isFinite(port) && port > 0 ? port : 2080,
  };
}

/** Is sing-box tried at all? Yes, always — except a developer's explicit opt-out outside production. */
export const singboxEgressEnabled = (env = process.env) => egressPolicy(env).singboxEnabled;

/**
 * Is a stream the daemon cannot carry REFUSED rather than dialled directly?
 * Yes, by default and always in production. Kept under its old name so existing
 * callers read as before; the answer is the inverse of "direct is permitted".
 */
export const singboxEgressRequired = (env = process.env) => !egressPolicy(env).directAllowed;

const DIAL_TIMEOUT_MS = Number(process.env.SINGBOX_DIAL_TIMEOUT_MS) || 8000;

// ── Observability ──────────────────────────────────────────────────────────
// Counters, not a log: one line per proxied stream would be unreadable at any
// real traffic level, and the question an operator actually has is "what share
// of egress is going through sing-box right now".
const stats = {
  viaSingbox: 0,      // Wisp streams that completed the SOCKS5 handshake
  viaDirect: 0,       // Wisp streams dialled directly (a developer's opt-out only)
  refused: 0,         // Wisp streams refused because sing-box could not carry them
  fetchViaSingbox: 0, // server-side fetches (embeds, thumbnails, link checks) tunnelled
  fetchDirect: 0,     // …dialled directly (a developer's opt-out only)
  fetchRefused: 0,    // …refused because sing-box could not carry them
  lastError: null,    // most recent dial/handshake failure, human-readable
  lastFallbackAt: null,
  lastRefusedAt: null,
};

/** Called by the HTTP egress agent (lib/egress.mjs) so fetches are counted too. */
export function noteFetchEgress(kind, detail) {
  if (kind === 'viaSingbox') stats.fetchViaSingbox++;
  else if (kind === 'direct') { stats.fetchDirect++; stats.lastFallbackAt = new Date().toISOString(); }
  else if (kind === 'refused') {
    stats.fetchRefused++;
    stats.lastRefusedAt = new Date().toISOString();
    if (detail) stats.lastError = `sing-box egress: ${detail}`;
  }
}

export function egressStats() {
  const streams = stats.viaSingbox + stats.viaDirect;
  const fetches = stats.fetchViaSingbox + stats.fetchDirect;
  const total = streams + fetches;
  const policy = egressPolicy();
  return {
    ...stats,
    total,
    // The single number worth alerting on. `null` (not 0) when nothing has been
    // proxied yet, because 0% on zero streams is not a fault — it is no data.
    // Under enforcement it can only ever be 100 or null; anything lower means a
    // developer opted out, and the panel says so.
    singboxSharePct: total ? Math.round(((stats.viaSingbox + stats.fetchViaSingbox) / total) * 100) : null,
    enabled: singboxEgressEnabled(),
    required: singboxEgressRequired(),
    policy: {
      mode: policy.mode,
      production: policy.production,
      directAllowed: policy.directAllowed,
      ignoredOverrides: policy.ignoredOverrides,
    },
    socks: socksTarget(),
  };
}

/** Test seam. */
export function _resetEgressStats() {
  for (const k of Object.keys(stats)) stats[k] = typeof stats[k] === 'number' ? 0 : null;
}

// ── A minimal async byte queue ─────────────────────────────────────────────
// Mirrors the contract wisp-js's ServerStream expects of a socket's internal
// queue: `get()` resolves to undefined once closed, which is the loop's exit
// signal. Reimplemented rather than imported because wisp-js does not export it
// (package.json `exports` allows only ".", "./client" and "./server"), and
// reaching past a package's export map is how a dependency bump breaks a site.
class ByteQueue {
  constructor(maxSize = 128) {
    this.maxSize = maxSize;
    this.queue = [];
    this.getCallbacks = [];
    this.putCallbacks = [];
    this.closed = false;
  }
  get size() { return this.queue.length; }

  async put(data) {
    if (this.closed) return;
    if (this.size <= this.maxSize) { this.queue.push(data); this.getCallbacks.shift()?.(); return; }
    await new Promise((resolve) => this.putCallbacks.push(resolve));
    if (this.closed) return;
    this.queue.push(data);
    this.getCallbacks.shift()?.();
  }

  async get() {
    if (this.size > 0) { this.putCallbacks.shift()?.(); return this.queue.shift(); }
    if (this.closed) return undefined;
    await new Promise((resolve) => this.getCallbacks.push(resolve));
    this.putCallbacks.shift()?.();
    return this.queue.shift();
  }

  close() {
    this.closed = true;
    this.queue = [];
    let cb;
    while ((cb = this.getCallbacks.shift())) cb();
    while ((cb = this.putCallbacks.shift())) cb();
  }
}

// ── SOCKS5 ─────────────────────────────────────────────────────────────────
const SOCKS_ERRORS = {
  1: 'general failure', 2: 'connection not allowed', 3: 'network unreachable',
  4: 'host unreachable', 5: 'connection refused', 6: 'ttl expired',
  7: 'command not supported', 8: 'address type not supported',
};

/**
 * Encode one SOCKS5 CONNECT request, choosing the address type by what the
 * target actually is.
 *
 * Why this is not always ATYP=domain: ZoFHub's destination governor resolves
 * the hostname itself and replaces it with the validated IP before dialling
 * (server.js, GuardedTCPSocket) — that is what closes the DNS-rebinding window
 * between the policy check and the connection. So by the time we get here the
 * "hostname" is often a literal address, and announcing an address as a domain
 * name asks the daemon to re-parse it. sing-box tolerates that; RFC 1928 has
 * explicit types for it and other SOCKS servers do not all guess. Sending the
 * right type costs one branch and removes the guess.
 *
 * A real hostname still goes out as ATYP=domain, so remote DNS works wherever
 * the caller has not already resolved.
 */
export function buildConnectRequest(hostname, port) {
  const host = String(hostname);

  // IPv4 literal → ATYP 0x01, four raw octets.
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) {
    const octets = v4.slice(1).map(Number);
    if (octets.every((o) => o <= 255)) {
      const req = Buffer.alloc(10);
      req[0] = 0x05; req[1] = 0x01; req[2] = 0x00; req[3] = 0x01;
      Buffer.from(octets).copy(req, 4);
      req.writeUInt16BE(port, 8);
      return req;
    }
  }

  // IPv6 literal → ATYP 0x04, sixteen raw octets. net.isIPv6 rather than a
  // regex: the ::-compressed forms are not worth hand-parsing.
  if (net.isIPv6(host.replace(/^\[|\]$/g, ''))) {
    const bytes = ipv6Bytes(host.replace(/^\[|\]$/g, ''));
    if (bytes) {
      const req = Buffer.alloc(22);
      req[0] = 0x05; req[1] = 0x01; req[2] = 0x00; req[3] = 0x04;
      bytes.copy(req, 4);
      req.writeUInt16BE(port, 20);
      return req;
    }
  }

  // Otherwise a name: ATYP 0x03, length-prefixed. The length field is one byte,
  // so 255 is a hard protocol ceiling (DNS allows 253 anyway).
  const name = Buffer.from(host, 'utf8');
  if (name.length > 255) throw new Error('socks: hostname too long');
  const req = Buffer.alloc(7 + name.length);
  req[0] = 0x05; req[1] = 0x01; req[2] = 0x00; req[3] = 0x03;
  req[4] = name.length;
  name.copy(req, 5);
  req.writeUInt16BE(port, 5 + name.length);
  return req;
}

/**
 * Expand an IPv6 literal to its 16 bytes, or null if it will not parse.
 *
 * Hand-written because Node exposes no "IPv6 string to bytes" primitive, and
 * the two forms that actually arrive here — a full address from dns.lookup and
 * a ::-compressed one from a config file — need different handling. An embedded
 * IPv4 tail (::ffff:93.184.216.34) is the common shape of a v4-mapped answer,
 * so it is handled rather than rejected.
 */
function ipv6Bytes(ip) {
  if (ip.split('::').length > 2) return null;          // at most one gap
  let [left = '', right = ''] = ip.split('::');
  const hasGap = ip.includes('::');

  const words = [];
  const pushGroups = (s, into) => {
    for (const g of s.split(':').filter(Boolean)) {
      if (g.includes('.')) {                            // IPv4 tail → two words
        const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(g);
        if (!m) return false;
        const o = m.slice(1).map(Number);
        if (!o.every((x) => x <= 255)) return false;
        into.push((o[0] << 8) | o[1], (o[2] << 8) | o[3]);
        continue;
      }
      if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return false;
      into.push(parseInt(g, 16));
    }
    return true;
  };

  const head = [];
  const tail = [];
  if (!pushGroups(left, head)) return null;
  if (!pushGroups(right, tail)) return null;

  if (!hasGap) {
    if (head.length !== 8) return null;
    words.push(...head);
  } else {
    const fill = 8 - head.length - tail.length;
    if (fill < 1) return null;                          // "::" must cover >=1 group
    words.push(...head, ...Array(fill).fill(0), ...tail);
  }
  if (words.length !== 8 || words.some((w) => !Number.isInteger(w) || w < 0 || w > 0xffff)) return null;

  const out = Buffer.alloc(16);
  words.forEach((w, i) => out.writeUInt16BE(w, i * 2));
  return out;
}

/**
 * Perform a SOCKS5 CONNECT on an already-connected socket.
 *
 * Resolves with any bytes that arrived AFTER the handshake reply. That detail
 * is load-bearing: a fast origin's first response bytes can share a TCP segment
 * with the SOCKS reply, and discarding that remainder truncates the very first
 * thing the visitor's browser reads — a bug that looks like a broken site, not
 * a broken proxy.
 */
function socks5Connect(socket, hostname, port) {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    let phase = 'greeting';
    let settled = false;

    const finish = (err, leftover) => {
      if (settled) return;
      settled = true;
      socket.removeListener('data', onData);
      socket.removeListener('error', onErr);
      socket.removeListener('close', onClose);
      if (err) reject(err); else resolve(leftover);
    };
    const onErr = (e) => finish(e);
    const onClose = () => finish(new Error('socks: closed during handshake'));

    function onData(chunk) {
      buf = Buffer.concat([buf, chunk]);

      if (phase === 'greeting') {
        if (buf.length < 2) return;
        if (buf[0] !== 0x05) return finish(new Error('socks: bad version'));
        if (buf[1] !== 0x00) return finish(new Error('socks: auth required (expected none)'));
        buf = buf.subarray(2);
        phase = 'reply';

        let req;
        try { req = buildConnectRequest(hostname, port); }
        catch (e) { return finish(e); }
        socket.write(req);
        if (buf.length === 0) return;
      }

      if (phase === 'reply') {
        if (buf.length < 5) return;
        if (buf[0] !== 0x05) return finish(new Error('socks: bad reply version'));
        if (buf[1] !== 0x00) {
          // The daemon answered and said no to THIS destination (unreachable,
          // refused, not allowed). Tagged so a caller holding several candidate
          // addresses can try the next one — unlike a daemon that never answered.
          const refusal = new Error('socks: ' + (SOCKS_ERRORS[buf[1]] || ('error ' + buf[1])));
          refusal.egressStage = 'upstream';
          refusal.socksReply = buf[1];
          return finish(refusal);
        }
        // Skip BND.ADDR/BND.PORT, whose length depends on the address type.
        let addrLen;
        if (buf[3] === 0x01) addrLen = 4;
        else if (buf[3] === 0x04) addrLen = 16;
        else if (buf[3] === 0x03) addrLen = 1 + buf[4];
        else return finish(new Error('socks: bad address type'));

        const total = 4 + addrLen + 2;
        if (buf.length < total) return;          // wait for the rest
        return finish(null, buf.subarray(total)); // hand back the overflow
      }
    }

    socket.on('data', onData);
    socket.once('error', onErr);
    socket.once('close', onClose);
    socket.write(Buffer.from([0x05, 0x01, 0x00]));  // VER, 1 method, NO AUTH
  });
}

/**
 * Open a TCP tunnel to `hostname:port` THROUGH sing-box.
 *
 * The one place ZoFHub speaks SOCKS5 to the daemon: the Wisp socket class below
 * and the HTTP agent in lib/egress.mjs both come through here, so there is a
 * single handshake to get right and a single path to audit.
 *
 * Resolves `{ socket, leftover }`: an established, tunnelled socket and any bytes
 * that arrived with the handshake reply. Rejects with `err.egressStage`:
 *   'daemon'     the daemon never answered (not running, refused, timed out)
 *   'handshake'  it answered but spoke something other than SOCKS5
 *   'upstream'   it answered SOCKS5 and refused THIS destination
 */
export function openSingboxTunnel(hostname, port, {
  env = process.env, connectImpl = net.connect, timeoutMs = DIAL_TIMEOUT_MS,
} = {}) {
  const { host, port: socksPort } = socksTarget(env);
  return new Promise((resolve, reject) => {
    let done = false;
    let timer = null;
    const s = connectImpl({ host, port: socksPort });
    const fail = (e, stage) => {
      if (done) return;
      done = true; clearTimeout(timer); s.destroy();
      if (!e.egressStage) e.egressStage = stage;
      reject(e);
    };
    timer = setTimeout(() => fail(new Error(`timeout after ${timeoutMs}ms`), 'daemon'), timeoutMs);
    timer.unref?.();

    s.once('error', (e) => fail(e, 'daemon'));
    s.once('connect', async () => {
      if (done) return;
      try {
        const leftover = await socks5Connect(s, hostname, port);
        if (done) return;
        done = true; clearTimeout(timer);
        resolve({ socket: s, leftover });
      } catch (e) {
        fail(e, 'handshake');
      }
    });
  });
}

/**
 * Resolve `true` once the daemon's inbound accepts connections, `false` if it has
 * not by `timeoutMs`. Never rejects.
 *
 * Boot-time work that needs egress (the thumbnail job, the TLS interception
 * probe) waits on this instead of racing the supervisor: the daemon takes a
 * moment to validate its config and bind, and with no direct fallback a request
 * made in that moment is refused rather than quietly sent from this host.
 */
export async function waitForSingbox({
  env = process.env, timeoutMs = 15_000, intervalMs = 250, connectImpl = net.connect,
} = {}) {
  const { host, port } = socksTarget(env);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const up = await new Promise((resolve) => {
      let s;
      try { s = connectImpl({ host, port }); } catch { return resolve(false); }
      s.once('connect', () => { s.destroy(); resolve(true); });
      s.once('error', () => { s.destroy(); resolve(false); });
    });
    if (up) return true;
    if (Date.now() + intervalMs > deadline) return false;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

// ── The injected socket class ──────────────────────────────────────────────

/**
 * Build a wisp-js-compatible TCPSocket class bound to a sing-box SOCKS inbound.
 *
 * Returned as a class (not an instance) because wisp-js constructs one per
 * stream: `new SocketImpl(hostname, port)`.
 */
export function createSingboxTCPSocket({ env = process.env, connectImpl = net.connect } = {}) {
  return class SingboxTCPSocket {
    constructor(hostname, port) {
      this.hostname = hostname;
      this.port = port;
      this.socket = null;
      this.paused = false;
      this.connected = false;
      this.viaSingbox = false;
      this.recv_buffer_size = 128;
      this.data_queue = new ByteQueue(this.recv_buffer_size);
    }

    /** Wire an established socket up to the receive queue. */
    _attach(socket, leftover) {
      this.socket = socket;
      this.connected = true;
      socket.setNoDelay(true);
      if (leftover && leftover.length) this.data_queue.put(leftover);
      socket.on('data', (d) => { this.data_queue.put(d); });
      socket.on('close', () => { this.data_queue.close(); this.socket = null; });
      socket.on('end', () => { this.data_queue.close(); });
      // Terminal for this stream only — never for the server. Without a handler
      // an ECONNRESET from any origin is an unhandled 'error' event, which in
      // Node takes down the whole process.
      socket.on('error', () => { this.data_queue.close(); });
    }

    /**
     * A DIRECT dial, straight out of this process. Reachable only through
     * connect() below, and only when lib/egress-policy.mjs permits it — which is
     * a developer's explicit opt-out outside production, never production.
     */
    _dialDirect(host, port) {
      return new Promise((resolve, reject) => {
        let done = false;
        const s = connectImpl({ host, port });
        const timer = setTimeout(() => {
          if (done) return;
          done = true; s.destroy();
          reject(new Error(`timeout after ${DIAL_TIMEOUT_MS}ms`));
        }, DIAL_TIMEOUT_MS);
        timer.unref?.();
        s.once('error', (e) => { if (!done) { done = true; clearTimeout(timer); s.destroy(); reject(e); } });
        s.once('connect', () => { if (done) return; done = true; clearTimeout(timer); resolve({ socket: s, leftover: null }); });
      });
    }

    async connect() {
      const policy = egressPolicy(env);

      if (policy.singboxEnabled) {
        try {
          const { socket, leftover } = await openSingboxTunnel(this.hostname, this.port, { env, connectImpl });
          this._attach(socket, leftover);
          this.viaSingbox = true;
          stats.viaSingbox++;
          return;
        } catch (e) {
          stats.lastError = `sing-box egress: ${e?.message || e}`;
          if (!policy.directAllowed) {
            // Refuse. A direct dial here would expose this server's own address
            // to the destination at exactly the moment the daemon is unwell.
            stats.refused++;
            stats.lastRefusedAt = new Date().toISOString();
            throw new EgressUnavailableError(
              `sing-box egress unavailable and direct egress is refused: ${e?.message || e}`, { cause: e });
          }
          stats.lastFallbackAt = new Date().toISOString();
        }
      } else if (!policy.directAllowed) {
        // Unreachable by construction (turning the daemon off is itself a
        // developer opt-out), but a refusal here is cheaper than a leak if the
        // policy module is ever changed without this file.
        stats.refused++;
        stats.lastRefusedAt = new Date().toISOString();
        throw new EgressUnavailableError('sing-box egress is disabled and direct egress is refused');
      }

      // Direct — a developer outside production said so, explicitly. wisp-js's
      // filter has already vetted this target.
      const { socket, leftover } = await this._dialDirect(this.hostname, this.port);
      this._attach(socket, leftover);
      stats.viaDirect++;
    }

    async recv() { return await this.data_queue.get(); }

    async send(data) {
      if (!this.socket) return;
      await new Promise((resolve) => this.socket.write(data, resolve));
    }

    async close() {
      this.data_queue.close();
      if (!this.socket) return;
      this.socket.end();
      this.socket = null;
    }

    pause() {
      if (!this.socket) return;
      if (this.data_queue.size >= this.data_queue.maxSize) { this.socket.pause(); this.paused = true; }
    }

    resume() {
      if (!this.socket) return;
      if (this.paused) { this.socket.resume(); this.paused = false; }
    }
  };
}

export default {
  createSingboxTCPSocket, openSingboxTunnel, waitForSingbox, noteFetchEgress, egressStats,
  singboxEgressEnabled, singboxEgressRequired, socksTarget,
};
