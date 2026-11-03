// tools/install-singbox.mjs — put the pinned sing-box binary where ZoFHub looks for it.
// ---------------------------------------------------------------------------
//   npm run singbox:install
//
// WHY THIS EXISTS. Every connection this server makes on a visitor's behalf now
// crosses sing-box, and one that cannot be carried is REFUSED rather than sent
// from this host (lib/egress-policy.mjs). That makes the daemon part of the site,
// not an optional extra — and the deploy in render.yaml is Render's NATIVE Node
// runtime, which has no Go toolchain and never built it. Without this step the
// first deploy after that change would refuse every proxied stream, every game
// embed and every thumbnail. So the binary is now part of the BUILD.
//
// WHAT IT DOES.
//   1. Reads data/singbox-release.json: a version and, per platform, the SHA-256
//      of the official release asset, committed to this repository.
//   2. Downloads that asset from github.com/SagerNet/sing-box/releases over TLS.
//   3. REFUSES it unless its SHA-256 equals the committed digest — so what runs is
//      the exact file that was reviewed when it was pinned, whatever a release page
//      happens to serve on the day of a build.
//   4. Extracts the one binary into .singbox/bin/ (git-ignored; never committed —
//      sing-box is GPL-3.0 and is run as its own process, not vendored), makes it
//      executable, and runs `sing-box version` to prove it is the one asked for.
//
// IT FAILS THE BUILD. On any problem this exits non-zero. That is deliberate: a
// failed build leaves the PREVIOUS deploy running, whereas a build that "succeeds"
// without the daemon would replace a working site with one that refuses traffic.
//
// IDEMPOTENT. A second run with the same pin and an intact binary does nothing.
//
// The Docker image does not use this: its Dockerfile builds the same pinned version
// from source (docs/proxy/SINGBOX.md §0).

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync,
  statSync, writeFileSync, chmodSync, createWriteStream, copyFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { isMain } from './_is-main.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const MAX_ARCHIVE_BYTES = 120 * 1024 * 1024;          // the largest asset is ~33 MB
const DOWNLOAD_TIMEOUT_MS = 180_000;

/** The platform keys data/singbox-release.json is organised by. */
export function platformKey(platform = process.platform, arch = process.arch) {
  const os = { linux: 'linux', darwin: 'darwin', win32: 'windows' }[platform];
  const cpu = { x64: 'amd64', arm64: 'arm64' }[arch];
  if (!os || !cpu) throw new Error(`no pinned sing-box build for ${platform}/${arch}`);
  return `${os}-${cpu}`;
}

/** Where the binary goes, and where ZoFHub (lib/singbox-supervisor.mjs) looks. */
export function installPaths(root = ROOT, platform = process.platform) {
  const base = join(root, '.singbox');
  return {
    base,
    bin: join(base, 'bin', platform === 'win32' ? 'sing-box.exe' : 'sing-box'),
    record: join(base, 'installed.json'),
  };
}

export function loadManifest(root = ROOT) {
  return JSON.parse(readFileSync(join(root, 'data', 'singbox-release.json'), 'utf8'));
}

/** The asset to fetch for this platform, with its URL — refusing anything off github.com. */
export function assetFor(manifest, key) {
  const a = manifest.assets?.[key];
  if (!a) throw new Error(`data/singbox-release.json has no asset for ${key}`);
  if (!/^[0-9a-f]{64}$/.test(a.sha256 || '')) throw new Error(`the pinned digest for ${key} is not a SHA-256`);
  if (!/^sing-box-[\w.\-]+\.(tar\.gz|zip)$/.test(a.name || '')) throw new Error(`unexpected asset name for ${key}: ${a.name}`);
  const base = String(manifest.downloadBase || '');
  if (!base.startsWith('https://github.com/SagerNet/sing-box/releases/download/')) {
    throw new Error(`refusing a download base that is not the official release path: ${base}`);
  }
  return { ...a, url: base + a.name };
}

/** Stream a URL to `dest`, hashing as it goes, bounded in size and time. Resolves the SHA-256. */
export async function downloadVerified(url, dest, { fetchImpl = fetch, maxBytes = MAX_ARCHIVE_BYTES, timeoutMs = DOWNLOAD_TIMEOUT_MS } = {}) {
  const res = await fetchImpl(url, { redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status} for ${url}`);
  const declared = Number(res.headers.get('content-length'));
  if (declared && declared > maxBytes) throw new Error(`download is ${declared} bytes, over the ${maxBytes} byte limit`);
  const hash = createHash('sha256');
  let seen = 0;
  const counting = async function* (src) {
    for await (const chunk of src) {
      seen += chunk.length;
      if (seen > maxBytes) throw new Error(`download exceeded ${maxBytes} bytes`);
      hash.update(chunk);
      yield chunk;
    }
  };
  await pipeline(Readable.fromWeb(res.body), counting, createWriteStream(dest));
  return hash.digest('hex');
}

/**
 * Extract an archive with the system tar.
 *
 * On Windows the one to call is System32\tar.exe, BY FULL PATH. It is bsdtar, which
 * reads both .zip and .tar.gz. A bare `tar` on a developer's PATH is often GNU tar
 * from Git for Windows, which cannot read .zip at all and treats `C:\...` as the
 * remote host "C" — exactly how this failed the first time it ran here.
 */
export function extractArchive(archive, into, { platform = process.platform, run = execFileSync, exists = existsSync } = {}) {
  if (platform === 'win32') {
    // Upper case: Windows environment names are case-insensitive, and it keeps the
    // repository auditor's env scan from reading `SystemRoot` as a variable named `S`.
    const tarExe = join(process.env.SYSTEMROOT || process.env.WINDIR || 'C:\\Windows', 'System32', 'tar.exe');
    if (exists(tarExe)) { run(tarExe, ['-xf', archive, '-C', into], { stdio: 'pipe' }); return; }
    const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
    run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `Expand-Archive -LiteralPath ${q(archive)} -DestinationPath ${q(into)} -Force`], { stdio: 'pipe' });
    return;
  }
  run('tar', ['-xf', archive, '-C', into], { stdio: 'pipe' });
}

function findBinary(dir, name) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) { const hit = findBinary(p, name); if (hit) return hit; }
    else if (entry.name === name) return p;
  }
  return null;
}

function runVersion(bin) {
  return execFileSync(bin, ['version'], { encoding: 'utf8', timeout: 15_000 });
}

/**
 * Install (or confirm) the pinned binary.
 *
 * @returns {Promise<{status: 'present'|'installed', bin: string, version: string}>}
 * Every collaborator is injectable so the whole decision can be tested offline.
 */
export async function installSingbox({
  root = ROOT, platform = process.platform, arch = process.arch, manifest = loadManifest(root),
  fetchImpl = fetch, extract = extractArchive, versionOf = runVersion, log = console.log,
} = {}) {
  const key = platformKey(platform, arch);
  const asset = assetFor(manifest, key);
  const paths = installPaths(root, platform);

  // Already there, and it is the pinned one? Then there is nothing to do.
  if (existsSync(paths.bin) && existsSync(paths.record)) {
    try {
      const rec = JSON.parse(readFileSync(paths.record, 'utf8'));
      if (rec.sha256 === asset.sha256 && rec.version === manifest.version && statSync(paths.bin).size > 0) {
        log(`[singbox] ${manifest.version} already installed at ${paths.bin}`);
        return { status: 'present', bin: paths.bin, version: manifest.version };
      }
    } catch { /* an unreadable record means reinstall */ }
  }

  const work = mkdtempSync(join(tmpdir(), 'zofhub-singbox-'));
  try {
    // A previously downloaded archive is reused ONLY if it still hashes to the pin —
    // the cache is an optimisation, never a source of trust.
    const cached = join(paths.base, 'cache', asset.name);
    let archive = join(work, asset.name);
    let reused = false;
    if (existsSync(cached)) {
      try {
        if (createHash('sha256').update(readFileSync(cached)).digest('hex') === asset.sha256) { archive = cached; reused = true; }
      } catch { /* unreadable cache entry: download again */ }
    }
    if (reused) {
      log(`[singbox] using the verified download in ${cached}`);
    } else {
      log(`[singbox] downloading ${asset.name} …`);
      const got = await downloadVerified(asset.url, archive, { fetchImpl });
      if (got !== asset.sha256) {
        throw new Error(`REFUSING ${asset.name}: its SHA-256 is ${got}, not the pinned ${asset.sha256}. `
          + 'Nothing was installed. If the release was re-published, review it and update data/singbox-release.json.');
      }
      log('[singbox] SHA-256 matches the pin');
      // Keep the verified archive, so a failure further down (or a rebuild) does not re-download it.
      try { mkdirSync(dirname(cached), { recursive: true }); copyFileSync(archive, cached); } catch { /* best effort */ }
    }

    const unpacked = join(work, 'unpacked');
    mkdirSync(unpacked);
    extract(archive, unpacked);
    const found = findBinary(unpacked, basename(paths.bin));
    if (!found) throw new Error(`${asset.name} did not contain ${basename(paths.bin)}`);

    mkdirSync(dirname(paths.bin), { recursive: true });
    const staged = `${paths.bin}.new`;
    rmSync(staged, { force: true });
    renameSync(found, staged);
    if (platform !== 'win32') chmodSync(staged, 0o755);

    // Prove it is the one asked for BEFORE it replaces anything.
    const said = String(versionOf(staged));
    if (!said.includes(manifest.version)) {
      rmSync(staged, { force: true });
      throw new Error(`the binary reports "${said.split('\n')[0]}", not ${manifest.version}`);
    }
    rmSync(paths.bin, { force: true });
    renameSync(staged, paths.bin);
    writeFileSync(paths.record, JSON.stringify({
      version: manifest.version, sha256: asset.sha256, asset: asset.name, installedAt: new Date().toISOString(),
    }, null, 2));
    log(`[singbox] installed ${manifest.version} at ${paths.bin}`);
    return { status: 'installed', bin: paths.bin, version: manifest.version };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (isMain(import.meta.url)) {
  installSingbox().then(
    (r) => { console.log(`[singbox] ${r.status}: ${r.bin}`); },
    (e) => {
      console.error(`[singbox] install FAILED: ${e?.message || e}`);
      console.error('[singbox] failing the build on purpose: without the daemon this server refuses every proxied connection.');
      process.exit(1);
    },
  );
}
