#!/usr/bin/env node
// tools/fetch-anura.mjs — fetch the pinned AnuraOS release for self-hosting.
// ---------------------------------------------------------------------------
// AnuraOS (github.com/MercuryWorkshop/anuraOS) is AGPL-3.0 and is a WHOLE
// SELF-CONTAINED WEB APP, not a library. It assumes it owns a site root: its
// bundle references /assets, /libs, /apps, /bin, /x86images, /bundle.css and
// /anura-sw.js as root-absolute paths, /assets collides with ZoFHub's own, and
// it registers a root-scoped service worker that would fight Ultraviolet's and
// Scramjet's.
//
// WHY IT IS NOT REWRITTEN ONTO A SUBPATH. The obvious fix — rewrite every "/x"
// to "/anura/x" — is actively harmful here, not just fiddly. The same absolute
// strings in this bundle address TWO different namespaces: URLs on the web
// server, and paths inside the guest filesystem of the emulated x86 machine
// (/usr, /tmp, /boot, /opfs). A rewrite cannot tell them apart, so it fixes the
// URLs and silently corrupts the Linux image. That is a worse failure than not
// shipping it, because it looks like it works until someone opens a terminal.
//
// So AnuraOS runs on its OWN ORIGIN, which is also how this repo already treats
// NautilusOS, Interstellar, DayDream and Nebula. This script gets you the files;
// where you serve them is a deployment decision.
//
//   node tools/fetch-anura.mjs [--out <dir>] [--force]
//
// Then serve <dir> as the ROOT of a static site (its own subdomain, a static
// host, or `npx serve <dir>`), and point ZoFHub at it:
//
//   PROXY_ANURA_URL=https://anura.example.com
//
// ZoFHub probes that URL and shows "AnuraOS" in the /browser engine list only
// while it actually answers. Unset ⇒ the entry never appears. Nothing here is
// required for ZoFHub to run.
//
// NOT VENDORED INTO GIT. The bundle is ~32 MB compressed and ~51 MB across 591
// files. It is fetched on demand and the output directory is gitignored.

import { mkdirSync, rmSync, existsSync, writeFileSync, readFileSync, createWriteStream } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

// PINNED, NOT FLOATING. Upstream publishes a rolling prerelease literally tagged
// "latest", so this URL is not reproducible on its own — the bytes behind it
// change. The digest below is what makes a fetch verifiable: it is recorded on
// first download and checked on every one after, so an upstream that changes
// under you is a loud mismatch rather than a silent new operating system.
const ANURA_TAG = 'latest';
const ANURA_URL = `https://github.com/MercuryWorkshop/anuraOS/releases/download/${ANURA_TAG}/anura.zip`;
const DIGEST_FILE = join(ROOT, 'data', 'anura-release.json');

const args = process.argv.slice(2);
const argVal = (flag, dflt) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const OUT = resolve(argVal('--out', join(ROOT, 'vendor', 'anura')));
const FORCE = args.includes('--force');

if (existsSync(OUT) && !FORCE) {
  console.log(`AnuraOS already present at ${OUT}`);
  console.log('Re-fetch with --force. Serve that directory as a site root, then set');
  console.log('  PROXY_ANURA_URL=<its origin>');
  process.exit(0);
}

console.log(`Fetching AnuraOS (${ANURA_TAG}) …`);
console.log(`  ${ANURA_URL}`);

const tmpZip = join(ROOT, 'data', 'anura-download.zip');
mkdirSync(dirname(tmpZip), { recursive: true });

const res = await fetch(ANURA_URL, { redirect: 'follow' });
if (!res.ok) {
  console.error(`\nDownload failed: HTTP ${res.status} ${res.statusText}`);
  console.error('Check network access, or download anura.zip by hand and unzip it to');
  console.error(`  ${OUT}`);
  process.exit(1);
}

await pipeline(res.body, createWriteStream(tmpZip));

// Verify before unpacking: this is 51 MB of someone else's executable web app,
// and the tag it came from is mutable.
const bytes = readFileSync(tmpZip);
const digest = createHash('sha256').update(bytes).digest('hex');
console.log(`  ${(bytes.length / 1048576).toFixed(1)} MB, sha256 ${digest.slice(0, 16)}…`);

let recorded = null;
try { recorded = JSON.parse(readFileSync(DIGEST_FILE, 'utf8')); } catch { /* first run */ }

if (recorded?.sha256 && recorded.sha256 !== digest) {
  console.error('\nDIGEST MISMATCH — upstream changed behind the "latest" tag.');
  console.error(`  recorded: ${recorded.sha256}`);
  console.error(`  fetched:  ${digest}`);
  console.error(`  recorded on: ${recorded.fetchedAt}`);
  console.error('\nThis is not necessarily an attack: AnuraOS re-publishes this tag. But you');
  console.error('are about to serve a DIFFERENT web OS than the one last reviewed. Review it,');
  console.error(`then delete ${DIGEST_FILE} and re-run to accept the new build.`);
  rmSync(tmpZip, { force: true });
  process.exit(1);
}

// unzip via the platform tool: pulling in an archive dependency for one command
// would add an npm package to a project that deliberately has very few.
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const unzip = process.platform === 'win32'
  ? spawnSync('powershell', ['-NoProfile', '-Command',
      `Expand-Archive -Path "${tmpZip}" -DestinationPath "${OUT}" -Force`], { stdio: 'inherit' })
  : spawnSync('unzip', ['-q', tmpZip, '-d', OUT], { stdio: 'inherit' });

if (unzip.status !== 0) {
  console.error('\nCould not unpack the archive.');
  console.error(`Unzip ${tmpZip} to ${OUT} manually.`);
  process.exit(1);
}

if (!existsSync(join(OUT, 'index.html'))) {
  console.error(`\nUnpacked, but ${join(OUT, 'index.html')} is missing — the archive layout changed.`);
  process.exit(1);
}

mkdirSync(dirname(DIGEST_FILE), { recursive: true });
writeFileSync(DIGEST_FILE, JSON.stringify({
  tag: ANURA_TAG, url: ANURA_URL, sha256: digest,
  bytes: bytes.length, fetchedAt: new Date().toISOString(),
}, null, 2) + '\n');
rmSync(tmpZip, { force: true });

console.log(`\nAnuraOS unpacked to ${OUT}`);
console.log('\nAGPL-3.0. Serving this to other people triggers the network-use clause:');
console.log('the source offer must stay reachable — see docs/CREDITS.md and /licenses.');
console.log('\nNext:');
console.log(`  1. Serve ${OUT} as a SITE ROOT on its own origin (it will not work under a subpath).`);
console.log('  2. Set PROXY_ANURA_URL to that origin.');
console.log('  3. It appears in /browser once it answers a probe.');
