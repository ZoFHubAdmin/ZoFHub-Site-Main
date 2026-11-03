// lib/egress.mjs — the HTTP(S) half of "everything crosses sing-box".
// ---------------------------------------------------------------------------
// lib/singbox-socket.mjs carries the Wisp tunnel's TCP streams. This carries the
// OTHER way a visitor or a third party makes this server connect out: fetching a
// URL — a game embed, a thumbnail, an asset, a link check, a catalog import.
// Those all go through lib/safe-fetch.mjs, which used to dial straight from Node.
// It now hands node:http / node:https an Agent whose sockets are tunnels through
// the daemon, so the same single chokepoint carries them.
//
// WHAT STAYS EXACTLY AS IT WAS. The SSRF defence. The address is still resolved
// by the validating resolver (every answer must be public) BEFORE anything is
// dialled, and what is dialled is that validated ADDRESS — never the name — so
// neither the daemon nor a rebinding resolver can be steered to a private target
// between the check and the connection. The destination is also a CONNECT the
// daemon's own routing layer refuses for private ranges: a second, independent
// check. And TLS is still verified, against the original HOSTNAME (SNI and
// certificate name), not the address we dialled.
//
// WHAT CHANGED. If the daemon cannot carry the connection, it FAILS. There is no
// retry-direct. See lib/egress-policy.mjs for the one developer-only exception.
//
// WHY AN AGENT. node:http gives exactly one supported seam for "connect somewhere
// else" — Agent.createConnection — and it is what every well-known proxy agent
// uses. It needs no patching of Node and nothing global: only requests that are
// handed this agent are affected, so nothing else in the process is silently
// rerouted (and nothing else is silently left behind: lib/egress-guard.mjs is
// the backstop for that).

import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { egressPolicy, EgressUnavailableError } from './egress-policy.mjs';
import { openSingboxTunnel, noteFetchEgress } from './singbox-socket.mjs';

// A name can answer with several addresses. If the daemon says THIS one is
// unreachable (an IPv6 address from a host with no IPv6 route is the usual
// case), try the next — but only a few: this is a courtesy, not a scan.
const MAX_ADDRESS_ATTEMPTS = 3;

// TLS options that may be forwarded from the request. `rejectUnauthorized` is
// deliberately NOT here: verification is on, and no caller can turn it off.
const TLS_PASSTHROUGH = [
  'ca', 'cert', 'key', 'passphrase', 'pfx', 'ciphers', 'minVersion', 'maxVersion',
  'ALPNProtocols', 'checkServerIdentity', 'session', 'secureProtocol', 'ecdhCurve',
];

/**
 * An egress for lib/safe-fetch.mjs.
 *
 * @param {object} deps
 * @param {Function} deps.lookup     the VALIDATING resolver (dns.lookup shape, {all:true})
 * @param {Function} deps.isPublic   address predicate; checked again here for literals
 * @param {Function} [deps.openTunnel]  test seam; defaults to the real SOCKS5 dial
 * @param {Function} [deps.connectDirect]  test seam; dev opt-out only
 */
export function createEgress({
  env = process.env, lookup, isPublic, openTunnel = openSingboxTunnel, connectDirect = net.connect,
} = {}) {
  if (typeof lookup !== 'function' || typeof isPublic !== 'function') {
    throw new TypeError('createEgress needs the validating lookup and the address predicate');
  }

  /** Every address `host` may be dialled at, each already checked public. */
  const addressesFor = (host) => new Promise((resolve, reject) => {
    if (net.isIP(host)) {
      // A literal never reaches the resolver; check it here as well as upstream.
      if (!isPublic(host)) return reject(new EgressUnavailableError('refusing a non-public literal address'));
      return resolve([{ address: host, family: net.isIP(host) }]);
    }
    lookup(host, { all: true }, (err, list) => (err ? reject(err) : resolve(list)));
  });

  const dialDirect = (address, port) => new Promise((resolve, reject) => {
    const s = connectDirect({ host: address, port });
    s.once('error', reject);
    s.once('connect', () => { s.removeListener('error', reject); resolve(s); });
  });

  /** A connected TCP socket to host:port that crosses sing-box, or throws. */
  async function dial(host, port) {
    const policy = egressPolicy(env);
    const addresses = (await addressesFor(host)).slice(0, MAX_ADDRESS_ATTEMPTS);
    let last = null;

    if (policy.singboxEnabled) {
      for (const a of addresses) {
        try {
          const { socket, leftover } = await openTunnel(a.address, port, { env });
          // A client speaks first on HTTP, so there should be nothing here — but
          // bytes that did arrive belong to the stream, not the floor.
          if (leftover && leftover.length) socket.unshift(leftover);
          noteFetchEgress('viaSingbox');
          return socket;
        } catch (e) {
          last = e;
          // The daemon refused THIS address: the next one may work. The daemon
          // not answering at all will not be fixed by trying another address.
          if (e?.egressStage !== 'upstream') break;
        }
      }
    }

    if (policy.directAllowed) {
      // A developer outside production opted out. Say so in the counters.
      const socket = await dialDirect(addresses[0].address, port);
      noteFetchEgress('direct');
      return socket;
    }

    noteFetchEgress('refused', last?.message || 'daemon not answering');
    throw new EgressUnavailableError(
      `sing-box egress unavailable and direct egress is refused: ${last?.message || 'daemon not answering'}`,
      { cause: last || undefined });
  }

  function makeAgent(protocol) {
    const secure = protocol === 'https:';
    const Base = secure ? https.Agent : http.Agent;
    return new (class SingboxAgent extends Base {
      createConnection(options, cb) {
        const host = String(options.host || options.hostname || '').replace(/^\[|\]$/g, '');
        const port = Number(options.port) || (secure ? 443 : 80);
        dial(host, port).then((socket) => {
          if (!secure) return cb(null, socket);
          // TLS runs OVER the tunnel, to the original hostname: the daemon sees
          // an opaque stream, and the certificate is checked against the name
          // the caller asked for, not the address we dialled.
          const secureSocket = tls.connect({
            ...Object.fromEntries(TLS_PASSTHROUGH.filter((k) => options[k] !== undefined).map((k) => [k, options[k]])),
            socket,
            servername: options.servername || (net.isIP(host) ? undefined : host),
            rejectUnauthorized: true,
          });
          cb(null, secureSocket);
        }, (err) => cb(err));
      }
    })({
      // One request per tunnel, closed afterwards: a pooled socket was dialled
      // (and its address validated) for some EARLIER request, and reusing it for
      // a different one would skip exactly the check this module exists to make.
      keepAlive: false,
      // Bounds how many tunnels one burst can open against the daemon.
      maxSockets: 64,
    });
  }

  const agents = new Map();
  return {
    mode: 'singbox',
    /** The Agent for requests to `protocol` ('http:' | 'https:'). */
    agentFor(protocol) {
      if (!agents.has(protocol)) agents.set(protocol, makeAgent(protocol));
      return agents.get(protocol);
    },
  };
}

/**
 * An egress that dials directly, for tests that talk to a loopback listener.
 *
 * NAMED AS A WARNING, and pinned: test/egress-inventory.test.mjs fails if any
 * file outside test/ references it. Handing this to safeFetch in production code
 * would be a direct-egress switch, which is the thing this layer exists to end.
 */
export const directEgressForTests = Object.freeze({ mode: 'direct', agentFor: () => false });

export default { createEgress, directEgressForTests };
