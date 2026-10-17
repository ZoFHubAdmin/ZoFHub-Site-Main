// lib/tls-interception.mjs — is this machine's outbound TLS being intercepted?
// ---------------------------------------------------------------------------
// WHY THIS EXISTS. The proxy engines tunnel raw TCP and perform TLS END TO END
// from the browser: epoxy (Scramjet, Ultraviolet) and libcurl.js (GUST) are
// WASM TLS clients that carry their OWN compiled-in CA roots and never consult
// the operating system's trust store.
//
// So when a local security product intercepts port 443 — presenting its own
// certificate signed by a root it installed into Windows — the OS trusts it,
// every ordinary browser is happy, and the WASM clients are not: they see a
// certificate from a root they have never heard of. The handshake dies, and the
// engine renders its generic page:
//
//     Uh oh! There was an error loading https://example.com/
//
// MEASURED on the machine this was written for:
//
//     duckduckgo.com  depth 0: CN=*.duckduckgo.com
//                              issuer CN=Avast Web/Mail Shield Root
//                     depth 1: CN=Avast Web/Mail Shield Root (self-signed)
//                     authorized by system roots: true
//
//     npm run verify-proxy  ->  0/6, every https target, ALL THREE engines
//     http:// through the same engine  ->  renders the real page
//
// Three independent engines failing identically on TLS alone, while plain HTTP
// works, is the signature of interception rather than of engine code. That is a
// 30-second settings change, but it reads exactly like a broken proxy — so this
// module turns it into a named, actionable diagnosis instead of a guess.
//
// WHERE IT BITES, AND WHERE IT DOES NOT. The tunnel's outbound TCP is opened by
// THIS SERVER, so it is the SERVER's network that matters, not the visitor's. A
// visitor running antivirus is unaffected; a developer running it locally has a
// broken proxy. In production (a hosting provider, no interception) this detects
// nothing and costs one TLS connection at boot.
// ---------------------------------------------------------------------------

import { connect } from 'node:tls';

/**
 * Root CNs that mean "something is terminating TLS in the middle".
 *
 * A DENYLIST of known products, not a guess about what a real CA looks like.
 * The alternative — "is this root in a public CA bundle?" — needs a bundle to
 * compare against and would report a corporate root as a fault on machines
 * where it is simply policy. Naming the product is also what makes the warning
 * actionable: "Avast is intercepting TLS" tells somebody what to go and switch
 * off, where "unknown root" does not.
 *
 * Matching is case-insensitive and substring-based, because these CNs carry
 * version and hostname suffixes that change between releases.
 */
export const INTERCEPTION_ROOTS = Object.freeze([
  { match: 'avast',                 product: 'Avast' },
  { match: 'avg ',                  product: 'AVG' },
  { match: 'web/mail shield',       product: 'Avast or AVG (Web/Mail Shield)' },
  { match: 'kaspersky',             product: 'Kaspersky' },
  { match: 'eset',                  product: 'ESET' },
  { match: 'bitdefender',           product: 'Bitdefender' },
  { match: 'dr.web',                product: 'Dr.Web' },
  { match: 'sophos',                product: 'Sophos' },
  { match: 'mcafee',                product: 'McAfee' },
  { match: 'malwarebytes',          product: 'Malwarebytes' },
  { match: 'bullguard',             product: 'BullGuard' },
  { match: 'f-secure',              product: 'F-Secure' },
  { match: 'trend micro',           product: 'Trend Micro' },
  { match: 'fortinet',              product: 'Fortinet (FortiGate)' },
  { match: 'fortigate',             product: 'Fortinet (FortiGate)' },
  { match: 'zscaler',               product: 'Zscaler' },
  { match: 'netskope',              product: 'Netskope' },
  { match: 'blue coat',             product: 'Blue Coat' },
  { match: 'bluecoat',              product: 'Blue Coat' },
  { match: 'palo alto',             product: 'Palo Alto Networks' },
  { match: 'cisco umbrella',        product: 'Cisco Umbrella' },
  { match: 'forcepoint',            product: 'Forcepoint' },
  { match: 'barracuda',             product: 'Barracuda' },
  { match: 'sonicwall',             product: 'SonicWall' },
  { match: 'untangle',              product: 'Untangle' },
  { match: 'kerio',                 product: 'Kerio' },
  { match: 'charles proxy',         product: 'Charles Proxy' },
  { match: 'do_not_trust',          product: 'Fiddler' },           // Fiddler's root CN
  { match: 'fiddler',               product: 'Fiddler' },
  { match: 'mitmproxy',             product: 'mitmproxy' },
  { match: 'portswigger',           product: 'Burp Suite' },
  { match: 'proxyman',              product: 'Proxyman' },
]);

/**
 * Which product, if any, a root certificate's CN names.
 *
 * Pure and exported so the classification is testable without a network: the
 * network half below cannot be unit tested honestly, but this half is where
 * every judgement actually happens.
 *
 * @param {string} commonName
 * @returns {string|null} the product name, or null when nothing matches
 */
export function classifyRoot(commonName) {
  const cn = String(commonName || '').toLowerCase();
  if (!cn) return null;
  for (const { match, product } of INTERCEPTION_ROOTS) {
    if (cn.includes(match)) return product;
  }
  return null;
}

/**
 * Walk a peer certificate to its root and return both CNs.
 *
 * Exported for the same reason as classifyRoot: the walk has a termination
 * problem worth testing (a self-signed root's `issuerCertificate` points at
 * ITSELF, so a naive loop never ends) and a depth cap for a pathological chain.
 *
 * @param {object} leaf a certificate object from `getPeerCertificate(true)`
 */
export function walkToRoot(leaf, maxDepth = 12) {
  let cert = leaf;
  const seen = new Set();
  let depth = 0;
  let leafCN = null;
  while (cert && typeof cert === 'object' && depth < maxDepth) {
    const cn = cert.subject?.CN ?? null;
    if (depth === 0) leafCN = cn;
    const fp = cert.fingerprint256 || cert.fingerprint || `${cn}:${depth}`;
    if (seen.has(fp)) break;
    seen.add(fp);
    const next = cert.issuerCertificate;
    // A self-signed root issues itself; that is the end of the chain.
    if (!next || next === cert || seen.has(next.fingerprint256 || next.fingerprint)) break;
    cert = next;
    depth++;
  }
  return {
    leafCN,
    rootCN: cert?.subject?.CN ?? null,
    rootIssuerCN: cert?.issuer?.CN ?? null,
    depth,
  };
}

/**
 * Open one TLS connection and report whether a known interceptor signed it.
 *
 * NEVER throws and never rejects: a detector that can fail a boot is worse than
 * no detector. Everything unexpected resolves to `{ intercepted: false }` with
 * a `reason`, because "we could not tell" must not render as "it is fine" to a
 * caller that only reads `.intercepted` — but it must also not stop the server.
 *
 * `rejectUnauthorized: false` is deliberate and is NOT a security decision: we
 * are inspecting the certificate, not trusting it, and nothing is sent over
 * this socket. A chain that the OS rejects is exactly one of the cases worth
 * reporting, so refusing to look at it would defeat the purpose.
 *
 * @returns {Promise<{intercepted: boolean, product: string|null, rootCN: string|null,
 *                    host: string, reason: string|null, authorized: boolean|null}>}
 */
export function detectInterception({ host = 'example.com', port = 443, timeoutMs = 4000 } = {}) {
  return new Promise((resolve) => {
    const done = (out) => {
      if (settled) return;
      settled = true;
      try { socket?.destroy(); } catch { /* already gone */ }
      clearTimeout(timer);
      resolve({ intercepted: false, product: null, rootCN: null, host, reason: null, authorized: null, ...out });
    };
    let settled = false;
    let socket;
    const timer = setTimeout(() => done({ reason: 'timeout' }), timeoutMs);

    try {
      socket = connect({ host, port, servername: host, rejectUnauthorized: false }, () => {
        let chain;
        try { chain = walkToRoot(socket.getPeerCertificate(true)); }
        catch (e) { return done({ reason: `certificate unreadable: ${e?.message || e}` }); }
        const product = classifyRoot(chain.rootCN) || classifyRoot(chain.rootIssuerCN);
        done({
          intercepted: !!product,
          product,
          rootCN: chain.rootCN,
          authorized: socket.authorized === true,
          reason: product ? null : 'no known interception root in the chain',
        });
      });
      socket.on('error', (e) => done({ reason: `connect failed: ${e?.message || e}` }));
    } catch (e) {
      done({ reason: `connect threw: ${e?.message || e}` });
    }
  });
}

/**
 * The operator-facing explanation, as lines ready to print or render.
 *
 * Kept here rather than at the call sites so the boot banner, the admin console
 * and the proxy page cannot describe the same condition differently — the same
 * reason public/js/pollinations.js owns its own failure wording.
 */
export function describeInterception(result) {
  if (!result?.intercepted) return [];
  const who = result.product || 'a local security product';
  return [
    `outbound TLS on this machine is being intercepted by ${who}`,
    `(the certificate for ${result.host} is signed by "${result.rootCN}").`,
    'The proxy engines perform TLS end to end from the browser using their own',
    'compiled-in CA roots, so they cannot validate an intercepted certificate:',
    'every https site will fail with "Uh oh! There was an error loading...".',
    `Fix: turn off HTTPS/SSL scanning in ${who}, or exclude this machine's`,
    'traffic from it. Plain http:// sites work either way, and a DEPLOYED site is',
    'unaffected — this is the server\'s own network, not the visitor\'s.',
  ];
}

export default { INTERCEPTION_ROOTS, classifyRoot, walkToRoot, detectInterception, describeInterception };
