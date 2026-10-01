// lib/proxy-control.mjs — administrative control of the proxy subsystem.
// ---------------------------------------------------------------------------
// The proxy engines (Ultraviolet, Scramjet, GUST, AnuraOS) all leave this
// server through ONE door: the /wisp/ tunnel, which opens a TCP connection to a
// host the visitor's browser names. This module decides, for every one of
// those connections, whether the platform is AUTHORISED to make it.
//
// THE MODEL
//
//   decision = f(access mode, destination host, port, approved targets, limits)
//            ∈ { ALLOW, DENY, REVIEW } with an internal reason code
//
//   · Destinations are an ALLOWLIST managed in the admin console
//     (public.proxy_targets). A host that matches no approved, unexpired target
//     is not reachable. There is no "allow everything" entry: the pattern
//     grammar requires a registrable name, and wildcards over a public suffix
//     (*.com, *.co.uk, *.github.io) or over wildcard-DNS services that map names
//     to arbitrary IPs (*.nip.io) are refused, because each of those would turn
//     one approval into approval of the whole internet.
//   · REVIEW means "not approved yet". At runtime it is refused exactly like
//     DENY; it exists so the console can show what visitors asked for without
//     storing who asked (hostnames and counts only, in memory, bounded).
//   · Every connection is checked TWICE: once by wisp-js through the hostname
//     hook (cheap, before a stream is allocated) and again inside the socket's
//     connect(), which also resolves DNS itself and dials the validated
//     address. That second check closes the DNS-rebinding window where a name
//     resolves to a public address for the filter and a private one for the
//     dial, and the gap where wisp-js skips its private-IP check when its own
//     lookup throws.
//
// WHAT THIS MODULE DOES NOT DO
//   It does not change what the engines are, how they rewrite pages, or how
//   they transport data. It governs WHERE the platform will connect and HOW
//   MUCH, and it records that it did.
//
// Pure apart from DNS resolution in resolveGuarded(); everything else takes
// plain values so the policy is testable without a network.
// ---------------------------------------------------------------------------

import dns from 'node:dns';
import { randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import { isPublicAddress } from './safe-fetch.mjs';

export const ENGINES = Object.freeze([
  { id: 'ultraviolet', name: 'Ultraviolet', paths: ['/uv/'] },
  { id: 'scramjet',    name: 'Scramjet',    paths: ['/scram/'] },
  { id: 'gust',        name: 'GUST',        paths: ['/gust', '/proxy'] },
  { id: 'anura',       name: 'AnuraOS',     paths: [] },            // served on its own origin
  // Companion apps (Interstellar, Nebula, …, Kasm) run as SEPARATE servers the
  // operator hosts. Their traffic never passes through this server's tunnel, so
  // the approved-destination policy CANNOT govern them. They are therefore one
  // switch, OFF by default, and the console says plainly that they are ungoverned.
  { id: 'external',    name: 'External companions (not governed)', paths: [], governed: false, defaultEnabled: false },
]);
export const ENGINE_IDS = Object.freeze(ENGINES.map((e) => e.id));

export const ACCESS_MODES = Object.freeze(['public', 'staff', 'disabled']);
export const WEB_PORTS = Object.freeze([80, 443, 8080, 8443]);
export const TARGET_STATUSES = Object.freeze(['pending', 'approved', 'revoked']);

/** Hard bounds. The console can move a limit inside these, never past them. */
export const POLICY_BOUNDS = Object.freeze({
  maxTunnels:        [1, 2000],
  maxPerClient:      [1, 256],
  streamsPerTunnel:  [1, 1024],
  idleMinutes:       [1, 120],
  maxSessionMinutes: [5, 1440],
});

export const DEFAULT_POLICY = Object.freeze({
  accessMode: 'public',
  maxTunnels: 512,
  maxPerClient: 32,
  streamsPerTunnel: 256,
  idleMinutes: 10,
  maxSessionMinutes: 240,
  allowedPorts: [80, 443, 8080, 8443],
});

// Suffixes a wildcard may never sit directly on. Not the whole Public Suffix
// List — the TLDs and the shared-hosting / wildcard-DNS suffixes where one
// approval would cover strangers' sites.
const PUBLIC_SUFFIXES = new Set([
  'com', 'net', 'org', 'edu', 'gov', 'mil', 'int', 'io', 'co', 'app', 'dev', 'ai', 'me', 'tv', 'info', 'biz',
  'us', 'uk', 'ca', 'au', 'de', 'fr', 'jp', 'cn', 'in', 'br', 'ru', 'nl', 'eu', 'xyz', 'site', 'online', 'top',
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'com.au', 'net.au', 'org.au', 'co.jp', 'co.nz', 'co.in', 'com.br', 'co.za',
  'github.io', 'gitlab.io', 'herokuapp.com', 'vercel.app', 'netlify.app', 'pages.dev', 'workers.dev', 'onrender.com',
  'appspot.com', 'cloudfront.net', 'amazonaws.com', 'azurewebsites.net', 'blogspot.com', 'web.app', 'firebaseapp.com',
  'glitch.me', 'repl.co', 'replit.app', 'fly.dev', 'railway.app', 'deno.dev', 'surge.sh', 'neocities.org',
]);
// Names that resolve to whatever address is written into them. Approving any
// name under these approves every address on the internet.
const WILDCARD_DNS = /(^|\.)(nip\.io|sslip\.io|xip\.io|localtest\.me|lvh\.me|traefik\.me|ngrok\.io|ngrok-free\.app|trycloudflare\.com|loca\.lt|serveo\.net)$/;
const INTERNAL = /(^|\.)(localhost|local|internal|lan|home\.arpa|localdomain|intranet|corp|test|invalid|example)$/;
const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/** Lowercased ASCII (punycode) hostname, or null if it is not a DNS name. */
export function normalizeHost(raw) {
  let h = String(raw ?? '').trim().toLowerCase();
  if (!h || h.length > 253) return null;
  if (h.endsWith('.')) h = h.slice(0, -1);
  if (h.startsWith('[') || isIP(h)) return null;
  if (!/^[a-z0-9.-]+$/.test(h)) {
    try { h = new URL(`https://${h}/`).hostname; } catch { return null; }
    if (!/^[a-z0-9.-]+$/.test(h)) return null;
  }
  const labels = h.split('.');
  if (labels.length < 2 || !labels.every((l) => LABEL.test(l))) return null;
  if (labels.every((l) => /^\d+$/.test(l))) return null;
  return h;
}

/** Validate a destination from the console. Returns { ok, value, errors }. */
export function validateTargetInput(input, { partial = false, now = new Date() } = {}) {
  const errors = [];
  const v = {};
  const src = input && typeof input === 'object' ? input : {};
  const has = (k) => Object.prototype.hasOwnProperty.call(src, k);

  if (!partial || has('pattern')) {
    const raw = typeof src.pattern === 'string' ? src.pattern.trim().toLowerCase() : '';
    const wild = raw.startsWith('*.');
    const base = normalizeHost(wild ? raw.slice(2) : raw);
    if (!base) errors.push('pattern must be a hostname like example.org or *.example.org');
    else if (raw.includes('*', wild ? 2 : 0)) errors.push('a wildcard is only allowed as the first label (*.example.org)');
    else if (INTERNAL.test(base)) errors.push('internal and reserved names cannot be proxy destinations');
    else if (WILDCARD_DNS.test(base) || /(^|\.)(nip|sslip|xip)\.io$/.test(base)) errors.push('wildcard-DNS services map names to arbitrary addresses and cannot be approved');
    else if (wild && PUBLIC_SUFFIXES.has(base)) errors.push(`*.${base} would cover every site under a public suffix — approve specific sites instead`);
    else if (!wild && PUBLIC_SUFFIXES.has(base)) errors.push(`${base} is a public suffix, not a site`);
    else v.pattern = wild ? `*.${base}` : base;
  }
  if (!partial || has('ports')) {
    const ports = src.ports === undefined ? [443] : src.ports;
    if (!Array.isArray(ports) || !ports.length || ports.length > 4 || ports.some((p) => !WEB_PORTS.includes(p))) {
      errors.push(`ports must be 1–4 of ${WEB_PORTS.join(', ')}`);
    } else v.ports = [...new Set(ports)].sort((a, b) => a - b);
  }
  const txt = (k, min, max, required) => {
    if (!has(k)) { if (required && !partial) errors.push(`${k} is required`); return; }
    if (src[k] === null || src[k] === '') { if (required) errors.push(`${k} is required`); else v[k] = null; return; }
    if (typeof src[k] !== 'string') { errors.push(`${k} must be text`); return; }
    const t = src[k].trim();
    if (t.length < min || t.length > max) errors.push(`${k} must be ${min}–${max} characters`);
    else if (/[<>]/.test(t)) errors.push(`${k} must be plain text`);
    else v[k] = t;
  };
  txt('purpose', 3, 300, true);
  txt('owner', 1, 80, false);
  if (has('expires_at')) {
    if (src.expires_at === null || src.expires_at === '') v.expires_at = null;
    else {
      const t = Date.parse(src.expires_at);
      const max = now.getTime() + 2 * 366 * 24 * 3600 * 1000;
      if (Number.isNaN(t)) errors.push('expires_at must be a date');
      else if (t <= now.getTime()) errors.push('expires_at must be in the future');
      else if (t > max) errors.push('expires_at may be at most two years ahead');
      else v.expires_at = new Date(t).toISOString();
    }
  }
  return { ok: errors.length === 0, value: v, errors };
}

/** Validate a limits/access policy. Unknown keys are dropped, never applied. */
export function validatePolicy(input) {
  const errors = [];
  const v = { ...DEFAULT_POLICY };
  const src = input && typeof input === 'object' ? input : {};
  if ('accessMode' in src) {
    if (!ACCESS_MODES.includes(src.accessMode)) errors.push(`accessMode must be one of ${ACCESS_MODES.join(', ')}`);
    else v.accessMode = src.accessMode;
  }
  for (const [k, [lo, hi]] of Object.entries(POLICY_BOUNDS)) {
    if (!(k in src)) continue;
    const n = src[k];
    if (!Number.isInteger(n) || n < lo || n > hi) errors.push(`${k} must be a whole number from ${lo} to ${hi}`);
    else v[k] = n;
  }
  if ('allowedPorts' in src) {
    const p = src.allowedPorts;
    if (!Array.isArray(p) || !p.length || p.some((x) => !WEB_PORTS.includes(x))) errors.push(`allowedPorts must be a non-empty subset of ${WEB_PORTS.join(', ')}`);
    else v.allowedPorts = [...new Set(p)].sort((a, b) => a - b);
  }
  if (v.maxPerClient > v.maxTunnels) errors.push('maxPerClient cannot exceed maxTunnels');
  return { ok: errors.length === 0, value: v, errors };
}

/** Parse PROXY_APPROVED_TARGETS ("wikipedia.org, *.khanacademy.org:443") for database-less deployments. */
export function targetsFromEnv(raw, now = new Date()) {
  const rows = [];
  const errors = [];
  for (const piece of String(raw || '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const [pattern, portList] = piece.split(':');
    const ports = portList ? portList.split('/').map(Number) : [443];
    const { ok, value, errors: e } = validateTargetInput({ pattern, ports, purpose: 'configured in PROXY_APPROVED_TARGETS' }, { now });
    if (!ok) { errors.push(`${piece}: ${e.join('; ')}`); continue; }
    rows.push({ id: `env:${rows.length + 1}`, ...value, status: 'approved', source: 'environment' });
  }
  return { rows, errors };
}

/**
 * The decision engine. Rebuilt whenever targets or policy change; evaluation
 * is a map lookup per DNS label, so thousands of targets cost nothing per
 * connection.
 */
export function createProxyGovernor({ now = () => Date.now(), unlistedCap = 200 } = {}) {
  let policy = { ...DEFAULT_POLICY };
  let exact = new Map();
  let wild = new Map();
  const counters = Object.create(null);
  const unlisted = new Map();          // host -> { count, lastSeen }

  const bump = (reason) => { counters[reason] = (counters[reason] || 0) + 1; };

  function lookup(host) {
    const hit = exact.get(host);
    if (hit) return hit;
    const labels = host.split('.');
    for (let i = 1; i < labels.length - 1; i++) {
      const w = wild.get(labels.slice(i).join('.'));
      if (w) return w;
    }
    return null;
  }

  function noteUnlisted(host) {
    const e = unlisted.get(host);
    if (e) { e.count++; e.lastSeen = now(); return; }
    if (unlisted.size >= unlistedCap) {
      let oldest = null;
      for (const [h, r] of unlisted) if (!oldest || r.lastSeen < oldest[1].lastSeen) oldest = [h, r];
      if (oldest) unlisted.delete(oldest[0]);
    }
    unlisted.set(host, { count: 1, lastSeen: now() });
  }

  const gov = {
    setPolicy(p) { policy = { ...DEFAULT_POLICY, ...p }; },
    get policy() { return { ...policy }; },

    setTargets(rows) {
      const e = new Map();
      const w = new Map();
      for (const r of rows || []) {
        if (!r || typeof r.pattern !== 'string') continue;
        const rec = { id: r.id, pattern: r.pattern, ports: r.ports || [443], status: r.status, expiresAt: r.expires_at ? Date.parse(r.expires_at) : null };
        if (r.pattern.startsWith('*.')) w.set(r.pattern.slice(2), rec);
        else e.set(r.pattern, rec);
      }
      exact = e; wild = w;
    },

    /**
     * @param {{host:string, port?:number|null, principal?:object|null}} req
     *        port null = the hostname-only pre-check wisp-js makes.
     */
    evaluate({ host, port = null, staff = false } = {}) {
      const done = (decision, reason, targetId) => { bump(reason); return { decision, reason, targetId: targetId ?? null }; };
      if (policy.accessMode === 'disabled') return done('DENY', 'proxy_disabled');
      if (policy.accessMode === 'staff' && !staff) return done('DENY', 'staff_only');
      if (isIP(String(host || '').replace(/^\[|\]$/g, ''))) return done('DENY', 'ip_literal');
      const h = normalizeHost(host);
      if (!h) return done('DENY', 'invalid_host');
      if (INTERNAL.test(h) || WILDCARD_DNS.test(h)) return done('DENY', 'internal_host');
      if (port !== null && !policy.allowedPorts.includes(Number(port))) return done('DENY', 'port_not_allowed');
      const t = lookup(h);
      if (!t) { noteUnlisted(h); return done('REVIEW', 'unlisted'); }
      if (t.status === 'revoked') return done('DENY', 'revoked_target', t.id);
      if (t.status !== 'approved') return done('REVIEW', 'pending_target', t.id);
      if (t.expiresAt && t.expiresAt <= now()) return done('DENY', 'expired_target', t.id);
      if (port !== null && !t.ports.includes(Number(port))) return done('DENY', 'port_not_approved', t.id);
      return done('ALLOW', 'approved_target', t.id);
    },

    /** The object wisp-js consults: `options.hostname_whitelist = [gov.hostnameHook()]`. */
    hostnameHook({ staffFor = () => false } = {}) {
      return { test: (hostname) => gov.evaluate({ host: hostname, port: null, staff: staffFor(hostname) }).decision === 'ALLOW' };
    },

    stats() {
      return {
        decisions: { ...counters },
        unlisted: [...unlisted.entries()].map(([host, r]) => ({ host, count: r.count, lastSeen: new Date(r.lastSeen).toISOString() }))
          .sort((a, b) => b.count - a.count).slice(0, 50),
        targets: { exact: exact.size, wildcard: wild.size },
      };
    },
    forgetUnlisted() { unlisted.clear(); },
  };
  return gov;
}

export class DestinationRefused extends Error {
  constructor(reason) { super(`destination refused (${reason})`); this.name = 'DestinationRefused'; this.reason = reason; }
}

/**
 * Resolve a host and return an address that is safe to dial. EVERY address the
 * name resolves to must be public — a name that answers with one public and
 * one private address is refused, because the dialler could pick either.
 */
export async function resolveGuarded(host, { lookup = dns.promises.lookup } = {}) {
  let addrs;
  try { addrs = await lookup(host, { all: true, verbatim: false }); }
  catch { throw new DestinationRefused('dns_failure'); }
  if (!Array.isArray(addrs) || !addrs.length) throw new DestinationRefused('dns_failure');
  for (const a of addrs) if (!isPublicAddress(a.address)) throw new DestinationRefused('private_address');
  const v4 = addrs.find((a) => a.family === 4);
  return (v4 || addrs[0]).address;
}

/**
 * Live tunnel sessions. In memory only: a session is an anonymous visitor's
 * connection, and persisting it would create a browsing record the platform
 * has no reason to keep. Holds counts and timestamps — never destinations.
 * Closed sessions are kept in a bounded ring for the operations view.
 */
export function createSessionTracker({ now = () => Date.now(), historySize = 100 } = {}) {
  const live = new Map();
  const history = [];
  const stats = { opened: 0, closed: 0, terminated: 0, streamsOpened: 0, streamsDenied: 0 };

  const tracker = {
    open({ clientTag = null, staff = false, kill = null } = {}) {
      const id = randomBytes(6).toString('hex');
      const t = now();
      live.set(id, { id, openedAt: t, lastActivity: t, streams: 0, activeStreams: 0, denied: 0, clientTag, staff, kill });
      stats.opened++;
      return id;
    },
    touch(id) { const s = live.get(id); if (s) s.lastActivity = now(); },
    streamOpened(id) { const s = live.get(id); if (s) { s.streams++; s.activeStreams++; s.lastActivity = now(); } stats.streamsOpened++; },
    streamClosed(id) { const s = live.get(id); if (s && s.activeStreams > 0) s.activeStreams--; },
    denied(id) { const s = live.get(id); if (s) s.denied++; stats.streamsDenied++; },
    close(id, reason = 'closed') {
      const s = live.get(id);
      if (!s) return;
      live.delete(id);
      stats.closed++;
      const { kill, ...rest } = s;
      history.push({ ...rest, closedAt: now(), reason });
      if (history.length > historySize) history.shift();
    },
    terminate(id, reason = 'terminated_by_admin') {
      const s = live.get(id);
      if (!s) return false;
      stats.terminated++;
      try { s.kill?.(reason); } catch { /* socket already gone */ }
      tracker.close(id, reason);
      return true;
    },
    /** Sessions past the lifetime cap or silent past the idle cap. */
    expired({ maxSessionMs, idleMs }) {
      const t = now();
      const out = [];
      for (const s of live.values()) {
        if (maxSessionMs && t - s.openedAt > maxSessionMs) out.push([s.id, 'max_lifetime']);
        else if (idleMs && t - s.lastActivity > idleMs) out.push([s.id, 'idle_timeout']);
      }
      return out;
    },
    list() {
      const t = now();
      return [...live.values()].map(({ kill, ...s }) => ({ ...s, ageSec: Math.round((t - s.openedAt) / 1000), idleSec: Math.round((t - s.lastActivity) / 1000) }))
        .sort((a, b) => a.openedAt - b.openedAt);
    },
    history: () => history.slice().reverse(),
    stats: () => ({ ...stats, live: live.size }),
    get size() { return live.size; },
  };
  return tracker;
}

export default {
  ENGINES, ENGINE_IDS, ACCESS_MODES, WEB_PORTS, POLICY_BOUNDS, DEFAULT_POLICY, TARGET_STATUSES,
  normalizeHost, validateTargetInput, validatePolicy, targetsFromEnv, createProxyGovernor,
  resolveGuarded, createSessionTracker, DestinationRefused,
};
