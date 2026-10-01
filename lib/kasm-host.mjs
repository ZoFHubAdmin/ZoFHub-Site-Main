// lib/kasm-host.mjs — Kasm Workspaces as a proxy-browser engine option.
// ---------------------------------------------------------------------------
// WHAT THIS IS. github.com/kasmtech/workspaces-images is a collection of
// Dockerfiles. Each builds a container that runs a real Linux desktop or a real
// desktop application, streamed to a browser by KasmVNC. Picked from the engine
// dropdown it is a remote COMPUTER, not a page rewriter — which makes it a
// genuinely different escape hatch from Scramjet/Ultraviolet (which rewrite
// HTML) and from AnuraOS (which emulates x86 inside the visitor's own tab).
//
// ── WHY THIS PROCESS DOES NOT HOST IT ─────────────────────────────────────
// AnuraOS is static files, so lib/anura-host.mjs can simply serve them. Kasm
// cannot work that way, and that is not a matter of effort:
//
//   * upstream ships DOCKERFILES, not a bundle. Using one means `docker build`
//     and `docker run` — a container runtime, at runtime;
//   * the documented command needs `--shm-size=512m`, and a session is a whole
//     desktop, so it costs gigabytes of RAM per concurrent user;
//   * ZoFHub deploys as ONE web service (render.yaml) with no Docker daemon
//     reachable from inside it. Shelling out to `docker` from server.js would
//     fail on every production deploy while appearing to work locally.
//
// So there is exactly one honest integration, and it is the one below: the
// OPERATOR runs the container wherever they have Docker, and points this at it.
// That is the arrangement PROXY_ANURA_URL already offers for a third-party
// AnuraOS, and the one COMPANION_ENGINES uses for NautilusOS and the others.
//
// ── THE FAILURE THIS MODULE EXISTS TO PREVENT ─────────────────────────────
// The standalone container is HTTPS-ONLY with a SELF-SIGNED certificate. Both
// halves are verifiable upstream, in kasmtech/workspaces-core-images:
//
//     src/common/startup_scripts/vnc_startup.sh:215  vncserver … -sslOnly …
//     src/common/startup_scripts/vnc_startup.sh:597  openssl req -x509 -nodes \
//         -days 3650 -newkey rsa:2048 … -subj "/C=US/ST=VA/…/CN=kasm/…"
//
// A browser will not load an origin with an untrusted certificate inside an
// iframe, and it tells the embedding page NOTHING when it refuses. The symptom
// is a blank frame and, 25 seconds later, ZoFHub's generic "this page didn't
// load" — which points at the proxy, which is innocent. The operator then
// debugs the wrong system.
//
// KasmVNC itself does not refuse framing: its source carries no
// X-Frame-Options and no Content-Security-Policy. So the certificate really is
// the whole obstacle. It is therefore DETECTED here and reported in words, so
// the visitor is told to open it in a tab and accept the certificate once,
// rather than watching a frame that is never going to fill.

import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';

/** The default label. Operators run wildly different images (Firefox, Chrome,
 *  an Ubuntu desktop, VS Code, Kali), so KASM_LABEL exists to say which one. */
const DEFAULT_LABEL = 'Kasm Workspace';

// The label reaches the engine dropdown and the note beside it. It comes from
// the environment, which is operator-controlled rather than hostile — but it is
// the only free-form string in that list, so it is constrained to plain text
// here as well as being rendered as a text node client-side. Doing both is
// cheap; discovering later that one of them was missing is not.
function cleanLabel(raw) {
  const s = String(raw || '').replace(/[\u0000-\u001f<>&"'`\\]/g, '').trim().slice(0, 40);
  return s || DEFAULT_LABEL;
}

/**
 * Is this host reachable only from a private network?
 *
 * This matters because the reachability probe runs on the SERVER. A Kasm box at
 * 192.168.1.50 answers happily when ZoFHub runs on the same LAN and is
 * unreachable for every visitor on the internet — so a bare `up: true` would be
 * a true statement about the wrong machine.
 */
export function isPrivateHost(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return true;
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h === '::1' || h === '0:0:0:0:0:0:0:1') return true;
  if (/^fe80:/i.test(h) || /^f[cd][0-9a-f]{2}:/i.test(h)) return true;   // link-local / unique-local v6
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (v4) {
    const a = Number(v4[1]); const b = Number(v4[2]);
    if (a === 127 || a === 10 || a === 0) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 169 && b === 254) return true;                             // link-local
    if (a === 100 && b >= 64 && b <= 127) return true;                   // CGNAT
    return false;
  }
  // Names that never resolve on the public internet.
  if (/\.(local|internal|lan|home|intranet|localdomain)$/.test(h)) return true;
  // A single-label name ("kasmbox") is an intranet name by definition.
  return !h.includes('.');
}

/**
 * How is Kasm exposed, if at all?
 *
 * Only one mode exists, and that is the point — see the header. `absent` and
 * `disabled` are kept distinct for the same reason ANURA_PORT does: an unset
 * variable is a choice not to use the feature, while an unparseable one is a
 * MISTAKE, and quietly treating the second as the first hides a typo in the one
 * setting the operator would have gone looking for.
 */
export function kasmExposure(env = process.env) {
  const raw = String(env.PROXY_KASM_URL || '').trim();
  if (!raw) return { mode: 'absent' };

  let u;
  try { u = new URL(raw); } catch {
    return { mode: 'disabled', reason: `PROXY_KASM_URL is not a URL: "${raw}"` };
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return { mode: 'disabled', reason: `PROXY_KASM_URL must be http(s), got "${u.protocol}"` };
  }
  if (!u.hostname) {
    return { mode: 'disabled', reason: `PROXY_KASM_URL has no host: "${raw}"` };
  }

  // CREDENTIALS IN THE URL ARE REMOVED, ALWAYS.
  // Putting basic-auth in the URL is a natural thing to do for a private
  // service — and this URL is published, verbatim and unauthenticated, by
  // /api/proxies to every visitor of the site. So a password pasted here would
  // become public the moment the engine list loaded. It is stripped rather than
  // rejected because the address is still the right address; only the secret
  // half is wrong. The operator is told at boot, because auth they thought they
  // had configured is now not being sent.
  const credentialsStripped = Boolean(u.username || u.password);
  u.username = '';
  u.password = '';

  return {
    mode: 'external',
    url: u.href,
    credentialsStripped,
    origin: u.origin,
    hostname: u.hostname,
    secure: u.protocol === 'https:',
    private: isPrivateHost(u.hostname),
    label: cleanLabel(env.KASM_LABEL),
  };
}

/**
 * Is it answering, and is its certificate one a browser will accept?
 *
 * ── ON rejectUnauthorized: false ──────────────────────────────────────────
 * This is deliberate, and it is narrow. The container's certificate is
 * self-signed BY DESIGN (vnc_startup.sh:597), so a verifying probe cannot tell
 * "switched off" apart from "running normally", and the operator would be shown
 * "offline" for a service that is perfectly fine.
 *
 * What makes it safe is what the result is used for. Nothing is sent — no
 * credentials, no cookies, no body. Nothing in the response is parsed or
 * trusted. The outcome decides WHICH SENTENCE the page shows, and nothing else.
 * The visitor's browser still enforces certificate validity for the connection
 * that actually carries their session, so this relaxation applies to one
 * server-side status check and cannot weaken anything the visitor does.
 */
export function kasmProbe(url, { timeoutMs = 2500 } = {}) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(url); } catch { return resolve({ up: false, reason: 'invalid-url' }); }

    const secure = u.protocol === 'https:';
    const send = secure ? httpsRequest : httpRequest;
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };

    let req;
    try {
      req = send({
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || (secure ? 443 : 80),
        path: (u.pathname || '/') + (u.search || ''),
        method: 'GET',
        rejectUnauthorized: false,      // justified above — classification only
        timeout: timeoutMs,
        headers: { 'User-Agent': 'ZoFHub-engine-probe', Connection: 'close' },
      }, (res) => {
        const sock = res.socket;
        let tls = 'none';
        let certCN = null;
        if (secure) {
          tls = sock?.authorized ? 'trusted' : 'untrusted';
          if (tls === 'untrusted') {
            // Just the common name, and only so the stock container certificate
            // can be recognised by name. Never the whole certificate, which is
            // noise in a log and nobody's business in an API response.
            try { certCN = sock.getPeerCertificate()?.subject?.CN || null; } catch { certCN = null; }
          }
        }
        // `< 500` matches probeCompanion() in server.js on purpose: KasmVNC
        // answers 401 until you sign in, and "asking me to log in" is the
        // healthiest possible reply from a service that requires a login.
        done({ up: res.statusCode < 500, status: res.statusCode, tls, certCN });
        res.destroy();
        req.destroy();
      });
    } catch (e) {
      return done({ up: false, reason: e?.code || 'request-failed' });
    }

    req.on('timeout', () => { req.destroy(); done({ up: false, reason: 'timeout' }); });
    req.on('error', (e) => done({ up: false, reason: e?.code || e?.message || 'error' }));
    req.end();
  });
}

/**
 * Will a browser on THIS page actually be able to put that origin in a frame?
 *
 * Answered before the frame is created, rather than inferred from 25 seconds of
 * silence, because both blockers below are refusals the embedding page is never
 * told about.
 */
export function kasmEmbedAdvice(exposure, probe, { pageSecure = true } = {}) {
  if (!exposure || exposure.mode !== 'external') return { embeddable: false, blockers: ['not-configured'] };
  const blockers = [];

  // An https page may not frame an http one. Nothing at either end can permit
  // it — this is the browser's mixed-content rule, not a header we could set.
  if (pageSecure && !exposure.secure) blockers.push('mixed-content');

  // The stock container certificate. A frame to an untrusted origin is dropped
  // with no event; a top-level visit shows the interstitial the visitor can
  // accept, after which the frame works for as long as that exception lasts.
  if (exposure.secure && probe?.tls === 'untrusted') blockers.push('untrusted-certificate');

  return { embeddable: blockers.length === 0, blockers };
}

/** One sentence the page can show verbatim. Plain text: the client renders it
 *  as a text node, so it must carry no markup of its own. */
export function kasmNotice(exposure, probe, advice) {
  if (!exposure || exposure.mode !== 'external') return '';
  const name = exposure.label;

  if (probe && probe.up === false) {
    return `${name} is not answering (${probe.reason || 'no response'}).`;
  }
  if (advice?.blockers?.includes('mixed-content')) {
    return `${name} is served over plain http, which a secure page cannot embed. `
      + 'Open it in a new tab, or put it behind https.';
  }
  if (advice?.blockers?.includes('untrusted-certificate')) {
    const stock = probe?.certCN === 'kasm';
    return `${name} uses a self-signed certificate${stock ? ' (the one the container generates at startup)' : ''}, `
      + 'so it cannot load inside this page until your browser trusts it. '
      + 'Open it in a new tab once and accept the certificate, then come back.';
  }
  if (exposure.private) {
    // `up: true` here means up FROM THE SERVER. Say so, rather than implying
    // the visitor's own device can reach it too.
    return `${name} is on a private address (${exposure.hostname}), so it works only from that network.`;
  }
  return `${name} runs on its own server. Sign in with the user and password you set for the container.`;
}

/**
 * The /api/proxies entry, or null when there is nothing to offer.
 *
 * `probe` is passed in rather than performed here, so the caller owns the
 * caching and the timeout budget of its own request path.
 */
export function kasmEntry(req, exposure, probe) {
  if (!exposure || exposure.mode !== 'external') return null;

  const proto = String(req?.headers?.['x-forwarded-proto'] || req?.protocol || 'http')
    .split(',')[0].trim();
  const advice = kasmEmbedAdvice(exposure, probe, { pageSecure: proto === 'https' });

  return {
    id: 'kasm',
    label: exposure.label,
    url: exposure.url,
    kind: 'companion',
    up: !!probe?.up,
    // Generic fields, usable by any companion. `embeddable: false` means "do
    // not put this in the frame" — offer the tab instead of a blank rectangle.
    embeddable: advice.embeddable,
    notice: kasmNotice(exposure, probe, advice),
    setup: 'docker run --rm -it --shm-size=512m -p 6901:6901 -e VNC_PW=yourpassword kasmweb/desktop:1.19.0',
  };
}

/** One line for the boot banner, in the shape anuraStatusLine() prints. */
export function kasmStatusLine(exposure) {
  switch (exposure?.mode) {
    case 'external': return `→ kasm:    ${exposure.url}`
      + (exposure.private ? ' (private address)' : '')
      + (exposure.credentialsStripped
        ? ' — credentials removed from PROXY_KASM_URL; this URL is published publicly, sign in at Kasm instead'
        : '');
    case 'disabled': return `→ kasm:    disabled — ${exposure.reason}`;
    default:         return '→ kasm:    not configured (PROXY_KASM_URL)';
  }
}
