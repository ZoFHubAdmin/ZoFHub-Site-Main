// lib/licenses.mjs
// ---------------------------------------------------------------------------
// The compliance layer for the copyleft code ZoFHub serves to visitors.
//
// WHY THIS FILE EXISTS
// ZoFHub serves six AGPL-3.0 proxy engines and one LGPL-3.0 library to every
// visitor who opens /browser or /gust. Both licenses impose obligations that a
// credits PAGE alone does not satisfy:
//
//   AGPL-3.0 §13 — a user interacting with the program over a network must be
//     offered the Corresponding Source of THAT running version.
//   AGPL-3.0 §5  — modified versions must carry prominent notices stating that
//     they were changed, and the date.
//   AGPL-3.0 §4  — the license text itself must travel with the work.
//   LGPL-3.0 §4  — the notice and license must be supplied to recipients.
//
// Before this existed the site named the projects on /credits but shipped no
// license text (every /uv/LICENSE, /scram/LICENSE, … returned 404) and gave no
// machine-readable source offer. This module is the single source of truth that
// server.js uses to serve:
//
//   /licenses            human-readable index
//   /licenses/:id        the verbatim upstream license text
//   /licenses.json       machine-readable manifest (versions + source URLs)
//
// HOW VERSIONS ARE RESOLVED
// Read at boot from the installed packages, never hardcoded. A version string
// that drifts from what is actually running would make the source offer point at
// the wrong code, which is precisely the failure §13 exists to prevent.
// ---------------------------------------------------------------------------

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Every copyleft component ZoFHub serves over the network.
//
// `pkg`      — node_modules path, or null when the code is vendored in-repo.
// `licenseFile` — where the verbatim text lives. Packages that ship no LICENSE
//              (epoxy-transport) fall back to the shared AGPL text in licenses/.
// `modified` — AGPL §5 hinges on this. GUST is the only component ZoFHub
//              changed; everything else runs byte-for-byte as published.
const COMPONENTS = [
  {
    id: 'ultraviolet',
    name: 'Ultraviolet',
    role: 'In-page proxy engine',
    pkg: '@titaniumnetwork-dev/ultraviolet',
    licenseFile: 'node_modules/@titaniumnetwork-dev/ultraviolet/LICENSE',
    spdx: 'AGPL-3.0',
    repo: 'https://github.com/titaniumnetwork-dev/Ultraviolet',
    servedAt: ['/uv/'],
    modified: false,
  },
  {
    id: 'scramjet',
    name: 'Scramjet',
    role: 'In-page proxy engine',
    pkg: '@mercuryworkshop/scramjet',
    licenseFile: 'node_modules/@mercuryworkshop/scramjet/LICENSE',
    spdx: 'AGPL-3.0',
    repo: 'https://github.com/MercuryWorkshop/scramjet',
    servedAt: ['/scram/'],
    modified: false,
  },
  {
    id: 'wisp-js',
    name: 'Wisp (wisp-js)',
    role: 'Tunnel protocol — powers the /wisp/ WebSocket',
    pkg: '@mercuryworkshop/wisp-js',
    licenseFile: 'node_modules/@mercuryworkshop/wisp-js/LICENSE',
    spdx: 'AGPL-3.0',
    repo: 'https://github.com/MercuryWorkshop/wisp-client-js',
    servedAt: ['/wisp/'],
    modified: false,
  },
  {
    id: 'epoxy-transport',
    name: 'Epoxy transport',
    role: 'TLS-over-Wisp transport',
    pkg: '@mercuryworkshop/epoxy-transport',
    // Ships no LICENSE file; its package.json declares AGPL-3.0-only, so we
    // serve the canonical AGPL-3.0 text (licenses/AGPL-3.0.txt) in its place
    // rather than leave a served AGPL component with no license text at all.
    licenseFile: 'node_modules/@mercuryworkshop/epoxy-transport/LICENSE',
    licenseFallback: 'licenses/AGPL-3.0.txt',
    spdx: 'AGPL-3.0-only',
    repo: 'https://github.com/MercuryWorkshop/EpoxyTransport',
    servedAt: ['/epoxy/'],
    modified: false,
  },
  {
    id: 'libcurl-transport',
    name: 'libcurl transport',
    role: 'curl-over-Wisp transport',
    pkg: '@mercuryworkshop/libcurl-transport',
    licenseFile: 'node_modules/@mercuryworkshop/libcurl-transport/LICENSE',
    spdx: 'AGPL-3.0-only',
    repo: 'https://github.com/MercuryWorkshop/libcurl-transport',
    servedAt: ['/gust/'],
    modified: false,
  },
  {
    id: 'gust',
    name: 'GUST',
    role: 'Service-worker-free proxy browser (libcurl.js + Wisp)',
    pkg: null,                                   // vendored, not from npm
    licenseFile: 'licenses/AGPL-3.0.txt',
    spdx: 'AGPL-3.0',
    repo: 'https://github.com/nautilus-os/GUST',
    servedAt: ['/gust', '/proxy'],
    // ── AGPL §5: this is the one component ZoFHub modified. ──────────────────
    modified: true,
    modifiedOn: '2026-07-30',
    modifications: [
      'Default Wisp server changed to this site\'s own same-origin /wisp/ endpoint instead of the upstream public wisp.mercurywork.shop, so proxy traffic never leaves this domain.',
      'Added ZoFHub\'s shared cloak system (Ctrl+` panic key, tab title/favicon cloaking) for parity with the rest of the site.',
    ],
    // §13 requires the Corresponding Source of the RUNNING version. Upstream
    // alone is not sufficient for a modified work, so point at the actual file.
    modifiedSourceAt: '/gust/index.html',
  },
  {
    id: 'anura',
    name: 'AnuraOS',
    role: 'Browser-based web OS with v86 x86 emulation — optional companion engine',
    pkg: null,                                   // not on npm; fetched release
    licenseFile: 'licenses/AGPL-3.0.txt',
    spdx: 'AGPL-3.0',
    repo: 'https://github.com/MercuryWorkshop/anuraOS',
    // SERVED ON ITS OWN ORIGIN, by this process. AnuraOS assumes it owns a site
    // root, so lib/anura-host.mjs gives it one (a second port by default, or a
    // hostname via ANURA_HOST) rather than a subpath. `servedAt` is empty
    // because those paths do not exist on ZoFHub's own origin — the engine is
    // reached at a different authority entirely.
    servedAt: [],
    optional: true,
    // ── AGPL §5: one declared change. ───────────────────────────────────────
    modified: true,
    modifiedOn: '2026-09-20',
    modifications: [
      'config.json is served with a `wisp-url` added to defaultsettings, pointing at this deployment\'s own same-origin /wisp/ tunnel. Upstream ships no wisp-url at all, so lib/Anura.js constructs its Networking with an undefined server and the browser app has no working tunnel. Setting it here also keeps proxy traffic on this deployment instead of a third-party relay, and derives the URL from the incoming request so it stays correct on a mirror domain.',
      'No other file is altered: the rest of the bundle is served byte-for-byte as published.',
    ],
    // §13 wants the Corresponding Source of the RUNNING version. The change is
    // made by this file at serve time, so point at the code that makes it.
    modifiedSourceAt: '/licenses/anura-modifications',
  },
  {
    id: 'libcurl-js',
    name: 'libcurl.js',
    role: 'WebAssembly curl used by GUST',
    // Present BOTH as an npm package (so the version is authoritative) and as a
    // vendored bundle under proxy-engine/assets/gust/vendor/ that GUST actually loads.
    pkg: 'libcurl.js',
    licenseFile: 'node_modules/libcurl.js/LICENSE',
    licenseFallback: 'licenses/LGPL-3.0.txt',
    spdx: 'LGPL-3.0-or-later',
    repo: 'https://github.com/ading2210/libcurl.js',
    servedAt: ['/gust/vendor/libcurl_full.js'],
    modified: false,
  },
  {
    id: 'bare-mux',
    name: 'bare-mux',
    role: 'Transport multiplexer',
    pkg: '@mercuryworkshop/bare-mux',
    licenseFile: 'node_modules/@mercuryworkshop/bare-mux/LICENSE',
    spdx: 'MIT',
    repo: 'https://github.com/MercuryWorkshop/bare-mux',
    servedAt: ['/baremux/'],
    modified: false,
  },
];

// Resolve the installed version from the package itself. Never hardcode: a
// stale version string would make the §13 source offer point at code that is
// not the code actually running.
function installedVersion(pkg) {
  if (!pkg) return null;
  try {
    return JSON.parse(readFileSync(join(ROOT, 'node_modules', pkg, 'package.json'), 'utf8')).version || null;
  } catch { return null; }
}

function resolveLicensePath(c) {
  const primary = join(ROOT, c.licenseFile);
  if (existsSync(primary)) return primary;
  if (c.licenseFallback) {
    const fb = join(ROOT, c.licenseFallback);
    if (existsSync(fb)) return fb;
  }
  return null;
}

let _cache = null;

/** Every served component, with its resolved version and license availability. */
export function getComponents() {
  if (_cache) return _cache;
  _cache = COMPONENTS.map(c => {
    const p = resolveLicensePath(c);
    return {
      ...c,
      version: installedVersion(c.pkg),
      licenseAvailable: !!p,
      _absLicensePath: p,
    };
  });
  const missing = _cache.filter(c => !c.licenseAvailable);
  if (missing.length) {
    console.warn(`[licenses] no license text found for: ${missing.map(m => m.id).join(', ')} — /licenses/<id> will 404. Add the file or a fallback in lib/licenses.mjs.`);
  }
  return _cache;
}

/** Verbatim license text for one component id, or null. */
export function getLicenseText(id) {
  const c = getComponents().find(x => x.id === id);
  if (!c || !c._absLicensePath) return null;
  try { return readFileSync(c._absLicensePath, 'utf8'); } catch { return null; }
}

/**
 * Machine-readable manifest — the AGPL §13 written offer in structured form.
 * Deliberately includes `modified` and `modifications`, because a source offer
 * that hides local changes does not satisfy §13 for a modified work.
 */
export function getManifest(origin = '', contactEmail = '') {
  return {
    project: 'ZoFHub',
    statement:
      'ZoFHub serves the copyleft components below to visitors over a network. '
      + 'Under AGPL-3.0 §13 and LGPL-3.0 §4, the Corresponding Source for each is offered here.',
    generatedAt: new Date().toISOString(),
    contact: contactEmail || null,
    components: getComponents().map(c => ({
      id: c.id,
      name: c.name,
      role: c.role,
      license: c.spdx,
      version: c.version,
      package: c.pkg,
      upstreamSource: c.repo,
      licenseText: origin ? `${origin}/licenses/${c.id}` : `/licenses/${c.id}`,
      servedAt: c.servedAt,
      modified: !!c.modified,
      ...(c.modified ? {
        modifiedOn: c.modifiedOn,
        modifications: c.modifications,
        // For a MODIFIED work the upstream repo is not the Corresponding
        // Source — the running, modified file is.
        modifiedSource: origin ? `${origin}${c.modifiedSourceAt}` : c.modifiedSourceAt,
      } : {}),
    })),
  };
}
