// lib/egress-guard.mjs — the backstop: nothing leaves this process by accident.
// ---------------------------------------------------------------------------
// lib/singbox-socket.mjs and lib/egress.mjs put the two KNOWN ways a visitor can
// make this server connect out through sing-box. That is a list of the doors we
// remembered to fix. This is the wall: it sits underneath Node's networking and
// refuses every outbound TCP (and UDP) connection that is neither
//
//   · loopback            — sing-box's own inbound, the Clash API, health probes
//   · a named infra host  — the database, the cache, the mail provider… the
//                           hosts the OPERATOR configured, and only those
//
// so a code path nobody has written yet, a dependency that starts making its own
// requests, or a regression in the paths above fails with a clear error and a
// counter instead of quietly exposing this server's address to a destination.
//
// WHY AT net.Socket AND NOT AT fetch. Every outbound TCP connection Node makes —
// node:http, node:https, node:tls, the built-in fetch (undici), ioredis, a
// WebSocket client — bottoms out in net.Socket.prototype.connect. Wrapping the
// one method covers all of them, including code we did not write and cannot
// audit line by line (node_modules is vendored and large). Wrapping fetch would
// cover one client of the many.
//
// WHAT IT CANNOT SEE, SAID PLAINLY. DNS lookups are not TCP connections: a
// hostname resolved by this process is still seen by this host's resolver
// (lib/proxy-control.mjs resolveGuarded and lib/safe-fetch.mjs guardedLookup do
// that on purpose, to close the DNS-rebinding window — docs/proxy/SINGBOX.md).
// And it guards THIS process: a child process is a different process, so each one
// installs its own (tools/fetch-y8-thumbs.mjs does).
//
// IT IS NOT A SANDBOX. Code that can run arbitrary JavaScript in this process can
// restore the original method. The goal is the one that actually occurs —
// accident and regression — not a hostile dependency, which no in-process
// control can stop.

import net from 'node:net';
import dgram from 'node:dgram';
import { egressPolicy, isProduction } from './egress-policy.mjs';

// ── Who may be connected to directly ───────────────────────────────────────
const V4_LOOPBACK = /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

/** Loopback, or the "this host" wildcard addresses that reach it. */
export function isLoopbackHost(host) {
  const h = String(host ?? '').trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!h || h === 'localhost') return true;
  if (h === '::1' || h === '::' || h === '0.0.0.0') return true;
  if (V4_LOOPBACK.test(h)) return true;
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(h);
  if (mapped && V4_LOOPBACK.test(mapped[1])) return true;
  // ::ffff:7f00:1 — the same loopback, spelled in hex groups.
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(h);
  if (hex && (parseInt(hex[1], 16) >> 8) === 127) return true;
  return false;
}

function normaliseEntry(e) {
  return String(e ?? '').trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
}

/**
 * The hosts the OPERATOR configured this server to talk to directly.
 *
 * Derived from the environment rather than written down here, so adding a
 * database or turning on the mail provider needs no code change and a host that
 * was never configured can never be reached. Hostnames only: a connection URL
 * carries credentials (redis://:password@host), and only the host is kept.
 *
 *   EGRESS_DIRECT_ALLOW  extra hosts, comma separated. `host` is exact;
 *                        `*.suffix` is any subdomain of suffix (not the apex).
 */
export function buildInfraAllowlist(env = process.env) {
  const out = new Set();
  const addUrl = (u) => {
    if (!u) return;
    try { const h = normaliseEntry(new URL(String(u).trim()).hostname); if (h) out.add(h); } catch { /* not a URL */ }
  };
  // The resolution lib/supabase.mjs uses: the database client talks to exactly this one.
  addUrl(env.SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL);
  addUrl(env.REDIS_URL);
  addUrl(env.UPSTASH_REDIS_URL);
  // The daemon itself. Loopback by default and then already allowed; named here
  // so an operator who deliberately runs it on another host is not locked out of
  // the one connection that every other connection depends on.
  addUrl(env.SINGBOX_API_URL);
  {
    const socks = String(env.SINGBOX_SOCKS || '').trim();
    const i = socks.lastIndexOf(':');
    if (i > 0) out.add(normaliseEntry(socks.slice(0, i)));
  }
  // Mail provider: only when it is configured at all.
  if (String(env.RESEND_API_KEY || '').trim()) out.add('api.resend.com');
  // Swap provider: only the one that is selected.
  if (/^sideshift$/i.test(String(env.SWAP_PROVIDER || '').trim())) out.add('sideshift.ai');
  // Companion engines and Kasm are operator-hosted services this server only
  // PROBES for reachability; the visitor's browser talks to them itself.
  for (const k of ['PROXY_NAUTILUS_URL', 'PROXY_DAYDREAM_URL', 'PROXY_NEBULA_URL', 'PROXY_INVISI_URL', 'PROXY_KASM_URL']) {
    addUrl(env[k]);
  }
  for (const e of String(env.EGRESS_DIRECT_ALLOW || '').split(',')) {
    const t = normaliseEntry(e);
    if (t) out.add(t);
  }
  return [...out].sort();
}

function matcherFor(allow) {
  const exact = new Set();
  const suffixes = [];
  for (const raw of allow || []) {
    const e = normaliseEntry(raw);
    if (!e) continue;
    if (e.startsWith('*.')) suffixes.push(e.slice(1));   // ".example.com"
    else exact.add(e);
  }
  return (host) => {
    const h = normaliseEntry(host);
    if (exact.has(h)) return true;
    return suffixes.some((s) => h.length > s.length && h.endsWith(s));
  };
}

// ── Reading a destination out of net.Socket.connect's many call shapes ──────
// connect(options[, cb]) · connect(port[, host][, cb]) · connect(path[, cb]) ·
// and the already-normalised [options, cb] pair Node uses internally.
export function connectTarget(args) {
  let a0 = args[0];
  if (Array.isArray(a0)) a0 = a0[0];
  if (a0 && typeof a0 === 'object') {
    if (a0.path) return { local: true };                         // unix socket / named pipe
    const port = Number(a0.port);
    if (!Number.isFinite(port)) return null;
    return { host: a0.host ?? a0.hostname ?? 'localhost', port };
  }
  if (typeof a0 === 'string' && Number.isNaN(Number(a0))) return { local: true };   // a path
  const port = Number(a0);
  if (!Number.isFinite(port)) return null;
  return { host: typeof args[1] === 'string' ? args[1] : 'localhost', port };
}

// dgram.send(msg[, offset, length][, port][, address][, cb]) and connect(port[, address][, cb])
function sendTarget(args) {
  const hasOffsetLength = typeof args[1] === 'number' && typeof args[2] === 'number';
  const port = Number(hasOffsetLength ? args[3] : args[1]);
  const address = hasOffsetLength ? args[4] : args[2];
  if (!Number.isFinite(port)) return null;            // a connected socket: checked at connect()
  return { host: typeof address === 'string' ? address : '127.0.0.1', port };
}

// ── State ──────────────────────────────────────────────────────────────────
const MAX_HOSTS_TRACKED = 50;

/** The first stack frame that is not Node and not this file: who asked. */
function originOf(stack) {
  for (const line of String(stack || '').split('\n').slice(1)) {
    if (line.includes('node:') || line.includes('egress-guard.mjs')) continue;
    const m = /\(?(?:file:\/\/\/)?([^()]+?:\d+):\d+\)?\s*$/.exec(line.trim());
    if (m) return m[1].replace(/^.*[\\/](lib|tools|proxy-engine|node_modules)[\\/]/, '$1/').slice(-160);
  }
  return null;
}

let active = null;     // the installed guard, if any (one per process)

/**
 * Install the guard. Idempotent: a second call returns the first guard.
 *
 * @param {object} [o]
 * @param {object}   [o.env]
 * @param {string[]} [o.allow]        hosts reachable directly (default: from the environment)
 * @param {'enforce'|'warn'|'off'} [o.mode]
 *        enforce: refuse.  warn: allow but count and log (a developer's opt-out).
 *        Production is ALWAYS enforce; `mode` and EGRESS_GUARD are ignored there.
 * @param {(info: object) => void} [o.onBlock]  called once per refusal; must not throw
 * @param {object}   [o.netModule] [o.dgramModule]  test seams
 */
export function installEgressGuard({
  env = process.env, allow, mode, onBlock, netModule = net, dgramModule = dgram,
  log = (...a) => console.error(...a),
} = {}) {
  if (active) return active;

  const policy = egressPolicy(env);
  const requested = String(mode ?? env.EGRESS_GUARD ?? '').trim().toLowerCase();
  let effective = policy.directAllowed ? 'warn' : 'enforce';
  if (!isProduction(env) && ['enforce', 'warn', 'off'].includes(requested)) effective = requested;
  if (isProduction(env)) effective = 'enforce';

  const allowList = allow ?? buildInfraAllowlist(env);
  const isAllowedHost = matcherFor(allowList);

  const state = {
    mode: effective,
    installedAt: new Date().toISOString(),
    blocked: 0,
    warned: 0,
    unclassified: 0,
    byHost: new Map(),
    lastBlocked: null,
    logged: new Map(),
  };

  function verdict(target, kind) {
    if (!target) { state.unclassified++; return 'allow'; }
    if (target.local || isLoopbackHost(target.host) || isAllowedHost(target.host)) return 'allow';
    const hostKey = normaliseEntry(target.host);
    if (state.byHost.size < MAX_HOSTS_TRACKED || state.byHost.has(hostKey)) {
      state.byHost.set(hostKey, (state.byHost.get(hostKey) || 0) + 1);
    }
    const info = {
      host: String(target.host).slice(0, 253), port: target.port, kind,
      origin: originOf(new Error().stack), at: new Date().toISOString(), enforced: state.mode === 'enforce',
    };
    state.lastBlocked = info;
    if (state.mode === 'enforce') state.blocked++; else state.warned++;
    // Once a minute per host: a loop retrying a refused connection must not turn
    // the log into the outage.
    const last = state.logged.get(hostKey) || 0;
    if (Date.now() - last > 60_000) {
      state.logged.set(hostKey, Date.now());
      if (state.logged.size > 200) state.logged.clear();
      log(`[egress-guard] ${state.mode === 'enforce' ? 'BLOCKED' : 'WOULD BLOCK'} direct ${kind} connection to `
        + `${info.host}:${info.port}${info.origin ? ` (from ${info.origin})` : ''} — outbound traffic must cross sing-box, `
        + 'or the host must be listed in EGRESS_DIRECT_ALLOW');
    }
    try { onBlock?.(info); } catch { /* an observer must never decide the verdict */ }
    return state.mode === 'enforce' ? 'block' : 'allow';
  }

  const original = {
    connect: netModule.Socket.prototype.connect,
    send: dgramModule.Socket.prototype.send,
    dgramConnect: dgramModule.Socket.prototype.connect,
  };

  if (effective !== 'off') {
    netModule.Socket.prototype.connect = function guardedConnect(...args) {
      if (verdict(connectTarget(args), 'tcp') === 'block') {
        const t = connectTarget(args);
        const err = Object.assign(
          new Error(`EGRESS_BLOCKED: direct connection to ${t.host}:${t.port} refused — outbound traffic must cross sing-box`),
          { code: 'EEGRESS_BLOCKED', host: t.host, port: t.port });
        // Asynchronously, like a real refused connect: callers attach their
        // 'error' handler after calling connect(), and would miss a synchronous one.
        process.nextTick(() => this.destroy(err));
        return this;
      }
      return original.connect.apply(this, args);
    };
    dgramModule.Socket.prototype.send = function guardedSend(...args) {
      if (verdict(sendTarget(args), 'udp') === 'block') {
        const t = sendTarget(args);
        const err = Object.assign(new Error(`EGRESS_BLOCKED: direct UDP to ${t.host}:${t.port} refused`),
          { code: 'EEGRESS_BLOCKED', host: t.host, port: t.port });
        const cb = args.find((a) => typeof a === 'function');
        process.nextTick(() => (cb ? cb(err) : this.emit('error', err)));
        return;
      }
      return original.send.apply(this, args);
    };
    dgramModule.Socket.prototype.connect = function guardedDgramConnect(...args) {
      if (verdict(sendTarget([null, ...args]), 'udp') === 'block') {
        const t = sendTarget([null, ...args]);
        const err = Object.assign(new Error(`EGRESS_BLOCKED: direct UDP to ${t.host}:${t.port} refused`),
          { code: 'EEGRESS_BLOCKED', host: t.host, port: t.port });
        process.nextTick(() => this.emit('error', err));
        return;
      }
      return original.dgramConnect.apply(this, args);
    };
  }

  active = {
    mode: effective,
    allow: allowList,
    stats() {
      return {
        installed: effective !== 'off',
        mode: state.mode,
        installedAt: state.installedAt,
        blocked: state.blocked,
        warned: state.warned,
        unclassified: state.unclassified,
        // Hostnames and counts only — never a URL, a path or a credential.
        byHost: Object.fromEntries([...state.byHost.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)),
        lastBlocked: state.lastBlocked,
        directAllowlist: allowList,
      };
    },
    uninstall() {
      netModule.Socket.prototype.connect = original.connect;
      dgramModule.Socket.prototype.send = original.send;
      dgramModule.Socket.prototype.connect = original.dgramConnect;
      active = null;
    },
  };
  return active;
}

/** What /api/admin/proxy reports when the guard was never installed. */
export function egressGuardStats() {
  return active ? active.stats() : { installed: false, mode: 'off', blocked: 0, warned: 0, unclassified: 0, byHost: {}, lastBlocked: null, directAllowlist: [] };
}

export default { installEgressGuard, egressGuardStats, buildInfraAllowlist, isLoopbackHost, connectTarget };
