// lib/wisp-policy.mjs — ZoFHub's EXPLICIT egress policy for the Wisp tunnel.
// ---------------------------------------------------------------------------
// WHY THIS FILE EXISTS. /wisp/ is the one endpoint on this site that will open
// a TCP connection to an address a stranger chose. Everything else about the
// proxy — Ultraviolet, Scramjet, GUST — is a rewriter sitting in front of that
// one capability. So the rules governing it are the security boundary of the
// whole product, and until this file existed ZoFHub did not state them.
//
// It had them, which is not the same thing. wisp-js ships defaults, and those
// defaults were carrying ZoFHub's SSRF protection:
//
//     allow_private_ips: false      ← the only reason the tunnel is not an
//     allow_loopback_ips: false        internal-network gateway
//
// Verified rather than assumed: five internal destinations (127.0.0.1 by
// address AND by name, 169.254.169.254, 10.0.0.1, and a non-web loopback port)
// were all refused with Wisp close reason 0x48 HostBlocked, with sing-box
// absent — which is also the documented shape of a Render native-Node deploy.
//
// But an inherited default is a promise nobody made. If wisp-js changes it, or
// a future option object is passed without it, the tunnel silently becomes an
// open door to the deployment's private network and nothing in this repository
// would fail. So the values are now set here, deliberately, and pinned by
// tests that assert the live server object rather than the documentation.
//
// ── THE THREE GAPS THE DEFAULTS LEFT OPEN ─────────────────────────────────
// Read directly off the installed wisp-js option object, not from its README:
//
//   port_whitelist: null     → ANY port. A web proxy that will also dial 25,
//                              22, 6667 or 3306 is a spam relay and a port
//                              scanner that happens to render HTML.
//   stream_limit_total: -1   → unlimited concurrent streams PER TUNNEL.
//                              ZoFHub caps tunnels (WISP_MAX_PER_IP, default
//                              32) but not what a single tunnel may open, so
//                              one client could hold thousands of sockets.
//   allow_udp_streams: true  → and UDP is worse than it looks here. wisp-js
//                              picks the socket class per stream type:
//                                SocketImpl = type === TCP ? this.TCPSocket
//                                                          : this.UDPSocket
//                              ZoFHub injects only TCPSocket (the sing-box
//                              dialler). UDP therefore goes out of the Node
//                              process directly, bypassing sing-box entirely —
//                              so SINGBOX_REQUIRE=1, the operator's explicit
//                              "never leak this server's own IP", does not
//                              cover it. Nothing in ZoFHub uses UDP through the
//                              tunnel, so it is closed by default.
//
// ── PROVENANCE OF THE IDEA ────────────────────────────────────────────────
// This posture was adopted after reviewing InvisiProxy (AGPL-3.0,
// github.com/QuiteAFancyEmerald/InvisiProxy, v7.0.2.1), whose Wisp server is
// configured with an explicit port whitelist, allowPrivateIPs: false, allowUDP:
// false and per-connection stream caps. NO CODE WAS COPIED: InvisiProxy runs a
// different Wisp implementation (mrrowisp) behind Fastify, and this file is
// written against wisp-js's own option object. What was taken is the argument
// that these belong in the application's configuration rather than in a
// library's defaults. See docs/proxy/INVISIPROXY.md.

/** Web ports, and nothing else.
 *
 *  80/443 are what every engine here actually asks for. 8080/8443 are included
 *  because sites on alternate HTTP ports are a real, if uncommon, thing and
 *  blocking them would be a visible regression for no security gain — they are
 *  still HTTP. Everything genuinely dangerous (25 SMTP, 22 SSH, 3306, 5432,
 *  6379, 6667) is outside this set. */
export const DEFAULT_ALLOWED_PORTS = [80, 443, 8080, 8443];

/** Streams one tunnel may hold open at once.
 *
 *  A browser opens perhaps a dozen sockets per page and a few more for
 *  subresources. 256 is far above normal use and far below "hold the process's
 *  entire file-descriptor table". */
export const DEFAULT_STREAM_LIMIT = 256;

const truthy = (v) => /^(1|true|yes|on)$/i.test(String(v ?? '').trim());
const isSet = (v) => String(v ?? '').trim() !== '';

/**
 * Parse a port specification: "80,443,8000-8100".
 *
 * Returns wisp-js's own entry shape — a bare number, or a [lo, hi] pair, which
 * is what check_port_range(entry, port) compares against. Anything
 * unparseable is REPORTED rather than dropped: a typo that silently narrows an
 * allowlist looks exactly like the proxy being broken for one site.
 */
export function parsePorts(raw) {
  const ports = [];
  const errors = [];
  for (const piece of String(raw || '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const range = /^(\d{1,5})\s*-\s*(\d{1,5})$/.exec(piece);
    if (range) {
      const lo = Number(range[1]);
      const hi = Number(range[2]);
      if (!validPort(lo) || !validPort(hi)) { errors.push(`port range out of bounds: "${piece}"`); continue; }
      if (lo > hi) { errors.push(`port range is backwards: "${piece}"`); continue; }
      ports.push([lo, hi]);
      continue;
    }
    const n = Number(piece);
    if (!Number.isInteger(n) || !validPort(n)) { errors.push(`not a port: "${piece}"`); continue; }
    ports.push(n);
  }
  return { ports, errors };
}

const validPort = (n) => Number.isInteger(n) && n >= 1 && n <= 65535;

/**
 * Compile hostname patterns.
 *
 * wisp-js calls entry.test(hostname), so entries must be RegExp. Operators
 * should not have to write JavaScript regular expressions in an env var, so the
 * input is a comma-separated list of hostname globs — "*.example.com,
 * ads.evil.net" — anchored so "evil.net.example.org" cannot match "evil.net".
 */
export function parseHostPatterns(raw) {
  const patterns = [];
  const errors = [];
  for (const piece of String(raw || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)) {
    if (!/^[a-z0-9.*-]+$/.test(piece)) { errors.push(`unsupported host pattern: "${piece}"`); continue; }
    const body = piece.split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^.]*');
    try { patterns.push(new RegExp(`^${body}$`, 'i')); }
    catch { errors.push(`could not compile host pattern: "${piece}"`); }
  }
  return { patterns, errors };
}

/**
 * Resolve the policy from the environment.
 *
 * FAILS SAFE, NOT CLOSED. An invalid value falls back to the secure default and
 * is reported — it never widens the policy, and it never takes the site down.
 * Turning a typo in WISP_ALLOWED_PORTS into a boot failure would mean one
 * mistyped character costs every visitor the whole site, which is a worse
 * outcome than running with the default set and saying so loudly.
 *
 * Deliberately widening the policy IS allowed — an operator may have a reason —
 * but each widening is recorded in `warnings` so it appears at boot and in the
 * admin console rather than living silently in a dashboard.
 */
export function wispPolicy(env = process.env) {
  const errors = [];
  const warnings = [];

  let allowedPorts = DEFAULT_ALLOWED_PORTS;
  if (isSet(env.WISP_ALLOWED_PORTS)) {
    if (/^(any|all|\*)$/i.test(String(env.WISP_ALLOWED_PORTS).trim())) {
      allowedPorts = null;                       // null = wisp-js applies no port filter
      warnings.push('WISP_ALLOWED_PORTS=any — the tunnel will dial ANY port, including mail and database ports');
    } else {
      const { ports, errors: perr } = parsePorts(env.WISP_ALLOWED_PORTS);
      errors.push(...perr);
      if (ports.length) allowedPorts = ports;
      else errors.push('WISP_ALLOWED_PORTS contained no usable port — keeping the default set');
    }
  }

  const allowUdp = truthy(env.WISP_ALLOW_UDP);
  if (allowUdp) {
    warnings.push('WISP_ALLOW_UDP=1 — UDP streams do NOT pass through sing-box '
      + '(only TCPSocket is injected), so SINGBOX_REQUIRE does not cover them');
  }

  const allowPrivateIps = truthy(env.WISP_ALLOW_PRIVATE_IPS);
  if (allowPrivateIps) {
    warnings.push('WISP_ALLOW_PRIVATE_IPS=1 — the public tunnel can now reach this '
      + "deployment's private network. Do not use this in production.");
  }
  const allowLoopbackIps = truthy(env.WISP_ALLOW_LOOPBACK_IPS);
  if (allowLoopbackIps) {
    warnings.push('WISP_ALLOW_LOOPBACK_IPS=1 — the public tunnel can now reach services '
      + 'bound to this server\'s own loopback interface.');
  }

  let streamLimitPerTunnel = DEFAULT_STREAM_LIMIT;
  if (isSet(env.WISP_MAX_STREAMS)) {
    const n = Number(String(env.WISP_MAX_STREAMS).trim());
    if (Number.isInteger(n) && n > 0) streamLimitPerTunnel = n;
    else if (n === -1) { streamLimitPerTunnel = -1; warnings.push('WISP_MAX_STREAMS=-1 — a single tunnel may open unlimited streams'); }
    else errors.push(`WISP_MAX_STREAMS is not a positive integer: "${env.WISP_MAX_STREAMS}" — keeping ${DEFAULT_STREAM_LIMIT}`);
  }

  const { patterns: blockedHosts, errors: herr } = parseHostPatterns(env.WISP_BLOCKED_HOSTS);
  errors.push(...herr);

  return {
    allowedPorts,
    allowUdp,
    allowPrivateIps,
    allowLoopbackIps,
    streamLimitPerTunnel,
    blockedHosts: blockedHosts.length ? blockedHosts : null,
    errors,
    warnings,
  };
}

/**
 * Write the policy onto the live wisp-js server object.
 *
 * wisp-js keeps ONE module-level options object, so this mutates rather than
 * constructs. Returns what was actually applied, so a caller can log the
 * effective policy instead of the intended one — those differ exactly when
 * something is wrong, which is when the difference matters.
 */
export function applyWispPolicy(wisp, policy) {
  if (!wisp?.options) return { applied: false, reason: 'wisp server has no options object' };
  const o = wisp.options;

  o.port_whitelist = policy.allowedPorts;
  o.allow_udp_streams = policy.allowUdp;
  // Stated explicitly even though these match the library defaults TODAY. That
  // is the point of the file: the guarantee must survive a dependency bump.
  o.allow_private_ips = policy.allowPrivateIps;
  o.allow_loopback_ips = policy.allowLoopbackIps;
  o.stream_limit_total = policy.streamLimitPerTunnel;
  if (policy.blockedHosts) o.hostname_blacklist = policy.blockedHosts;

  return {
    applied: true,
    port_whitelist: o.port_whitelist,
    allow_udp_streams: o.allow_udp_streams,
    allow_private_ips: o.allow_private_ips,
    allow_loopback_ips: o.allow_loopback_ips,
    stream_limit_total: o.stream_limit_total,
    hostname_blacklist: Array.isArray(o.hostname_blacklist) ? o.hostname_blacklist.length : 0,
  };
}

/** Human-readable ports, for the boot banner and the admin console. */
export function describePorts(ports) {
  if (ports === null) return 'any (UNRESTRICTED)';
  return ports.map((p) => (Array.isArray(p) ? `${p[0]}-${p[1]}` : String(p))).join(',');
}

/** One line for the boot banner, in the shape the other status lines print. */
export function wispPolicyLine(policy) {
  const bits = [`ports ${describePorts(policy.allowedPorts)}`];
  bits.push(policy.allowUdp ? 'UDP ON' : 'no UDP');
  bits.push(policy.allowPrivateIps ? 'PRIVATE IPS ALLOWED' : 'private IPs blocked');
  bits.push(`max ${policy.streamLimitPerTunnel === -1 ? '∞' : policy.streamLimitPerTunnel} streams/tunnel`);
  return `→ egress:  ${bits.join(' · ')}`;
}
