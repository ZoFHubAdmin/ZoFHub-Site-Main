// tools/install-singbox.mjs — the build step that makes "everything crosses sing-box"
// deployable on a host that has no Go toolchain.
//
// Everything is injected (the network, the archive extractor, the version probe), so
// these tests run offline and exercise the decisions that matter for safety: a file
// whose hash is not the pinned one is never installed, a failed upgrade never
// destroys a working binary, and a build that cannot get the daemon FAILS.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  platformKey, installPaths, loadManifest, assetFor, downloadVerified, installSingbox, extractArchive,
} from '../tools/install-singbox.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const sha = (b) => createHash('sha256').update(b).digest('hex');

// A tiny "release": the archive bytes, a manifest that pins exactly their digest,
// and an extractor that unpacks a fake binary the way the real tarball lays it out.
function fixture({ version = '1.14.1', platform = 'linux', arch = 'x64', binary = 'FAKE-SING-BOX-BINARY' } = {}) {
  const key = platformKey(platform, arch);
  const name = `sing-box-${version}-${key}.${platform === 'win32' ? 'zip' : 'tar.gz'}`;
  const archive = Buffer.from(`archive-of:${binary}:${version}`);
  const manifest = {
    tag: `v${version}`, version,
    downloadBase: `https://github.com/SagerNet/sing-box/releases/download/v${version}/`,
    assets: { [key]: { name, sha256: sha(archive) } },
  };
  const exe = platform === 'win32' ? 'sing-box.exe' : 'sing-box';
  const extract = (_archivePath, into) => {
    const d = join(into, `sing-box-${version}-${key}`);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, exe), binary);
    writeFileSync(join(d, 'LICENSE'), 'GPL');
  };
  return { manifest, archive, extract, platform, arch, version };
}
const respond = (bytes, init) => async () => new Response(bytes, init);

let root;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'zofhub-install-test-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const base = (f, extra = {}) => ({
  root, platform: f.platform, arch: f.arch, manifest: f.manifest, fetchImpl: respond(f.archive),
  extract: f.extract, versionOf: () => `sing-box version ${f.version}\n`, log: () => {}, ...extra,
});

// ───────────────────────────────────────────────────────────────────────────
describe('which build for which machine', () => {
  for (const [platform, arch, key] of [
    ['linux', 'x64', 'linux-amd64'], ['linux', 'arm64', 'linux-arm64'], ['darwin', 'x64', 'darwin-amd64'],
    ['darwin', 'arm64', 'darwin-arm64'], ['win32', 'x64', 'windows-amd64'],
  ]) test(`${platform}/${arch} -> ${key}`, () => assert.equal(platformKey(platform, arch), key));

  for (const [platform, arch] of [['freebsd', 'x64'], ['linux', 'ia32'], ['linux', 'riscv64'], ['aix', 'ppc64']]) {
    test(`${platform}/${arch} has no pinned build and says so`, () => {
      assert.throws(() => platformKey(platform, arch), /no pinned sing-box build/);
    });
  }

  test('the binary goes where the supervisor looks', () => {
    assert.match(installPaths('/r', 'linux').bin.replace(/\\/g, '/'), /\/r\/\.singbox\/bin\/sing-box$/);
    assert.match(installPaths('/r', 'win32').bin.replace(/\\/g, '/'), /\/r\/\.singbox\/bin\/sing-box\.exe$/);
  });
});

describe('the pin is read defensively', () => {
  const good = { name: 'sing-box-1.14.1-linux-amd64.tar.gz', sha256: 'a'.repeat(64) };
  const manifest = (over = {}) => ({
    downloadBase: 'https://github.com/SagerNet/sing-box/releases/download/v1.14.1/',
    assets: { 'linux-amd64': { ...good, ...over } },
  });

  test('a well-formed asset yields an official-release URL', () => {
    assert.equal(assetFor(manifest(), 'linux-amd64').url,
      'https://github.com/SagerNet/sing-box/releases/download/v1.14.1/sing-box-1.14.1-linux-amd64.tar.gz');
  });
  test('a platform with no asset is an error', () => assert.throws(() => assetFor(manifest(), 'linux-arm64'), /no asset/));
  for (const bad of ['', 'xyz', 'A'.repeat(64), 'a'.repeat(63), 'a'.repeat(65), undefined]) {
    test(`a digest of ${JSON.stringify(bad)} is not accepted`, () => {
      assert.throws(() => assetFor(manifest({ sha256: bad }), 'linux-amd64'), /not a SHA-256/);
    });
  }
  for (const name of ['../evil.tar.gz', 'sing-box.exe', 'sing-box-1.14.1-linux-amd64.sh', 'x/sing-box-1.tar.gz', '']) {
    test(`an asset named ${JSON.stringify(name)} is refused`, () => {
      assert.throws(() => assetFor(manifest({ name }), 'linux-amd64'), /unexpected asset name/);
    });
  }
  for (const downloadBase of ['https://evil.example/', 'http://github.com/SagerNet/sing-box/releases/download/v1/',
    'https://github.com/SomeoneElse/sing-box/releases/download/v1/', 'https://github.com.evil.test/SagerNet/sing-box/releases/download/', '']) {
    test(`a download base of ${JSON.stringify(downloadBase)} is refused`, () => {
      assert.throws(() => assetFor({ ...manifest(), downloadBase }, 'linux-amd64'), /official release path/);
    });
  }
});

describe('a successful install', () => {
  test('puts the verified binary in .singbox/bin, executable, with a record', async () => {
    const f = fixture();
    const r = await installSingbox(base(f));
    assert.equal(r.status, 'installed');
    const p = installPaths(root, 'linux');
    assert.equal(readFileSync(p.bin, 'utf8'), 'FAKE-SING-BOX-BINARY');
    // Windows has no execute bit to check; everywhere else the file must be runnable.
    if (process.platform !== 'win32') assert.equal(statSync(p.bin).mode & 0o111, 0o111, 'the binary is not executable');
    const rec = JSON.parse(readFileSync(p.record, 'utf8'));
    assert.equal(rec.version, '1.14.1');
    assert.equal(rec.sha256, f.manifest.assets['linux-amd64'].sha256);
  });

  test('it leaves only the binary, its record and the verified download behind', async () => {
    await installSingbox(base(fixture()));
    assert.deepEqual(readdirSync(join(root, '.singbox', 'bin')), ['sing-box']);
    assert.deepEqual(readdirSync(join(root, '.singbox')).sort(), ['bin', 'cache', 'installed.json']);
    assert.deepEqual(readdirSync(join(root, '.singbox', 'cache')), ['sing-box-1.14.1-linux-amd64.tar.gz']);
  });

  test('a reinstall reuses the verified download instead of fetching it again', async () => {
    const f = fixture();
    await installSingbox(base(f));
    rmSync(installPaths(root, 'linux').bin);
    let fetched = 0;
    const r = await installSingbox(base(f, { fetchImpl: async () => { fetched++; return new Response(f.archive); } }));
    assert.equal(r.status, 'installed');
    assert.equal(fetched, 0, 'it downloaded again although it already held the verified archive');
  });

  test('a cached archive that no longer matches the pin is NOT trusted', async () => {
    const f = fixture();
    await installSingbox(base(f));
    const cached = join(root, '.singbox', 'cache', 'sing-box-1.14.1-linux-amd64.tar.gz');
    writeFileSync(cached, 'tampered after it was verified');
    rmSync(installPaths(root, 'linux').bin);
    let fetched = 0;
    await installSingbox(base(f, { fetchImpl: async () => { fetched++; return new Response(f.archive); } }));
    assert.equal(fetched, 1, 'a modified cache entry was used without being re-verified');
  });

  test('a cached archive is kept even when a later step fails, so the retry is cheap', async () => {
    const f = fixture();
    await assert.rejects(installSingbox(base(f, { versionOf: () => 'sing-box version 9.9.9' })), /not 1\.14\.1/);
    assert.ok(existsSync(join(root, '.singbox', 'cache', 'sing-box-1.14.1-linux-amd64.tar.gz')));
  });

  test('a second run does nothing and does not touch the network', async () => {
    const f = fixture();
    await installSingbox(base(f));
    let fetched = 0;
    const r = await installSingbox(base(f, { fetchImpl: async () => { fetched++; return new Response(f.archive); } }));
    assert.equal(r.status, 'present');
    assert.equal(fetched, 0);
  });

  test('a missing binary, a changed pin or a damaged record each trigger a reinstall', async () => {
    const f = fixture();
    await installSingbox(base(f));
    const p = installPaths(root, 'linux');

    rmSync(p.bin);
    assert.equal((await installSingbox(base(f))).status, 'installed', 'binary deleted');

    writeFileSync(p.record, '{not json');
    assert.equal((await installSingbox(base(f))).status, 'installed', 'record damaged');

    writeFileSync(p.record, JSON.stringify({ version: '1.14.1', sha256: 'f'.repeat(64) }));
    assert.equal((await installSingbox(base(f))).status, 'installed', 'record names a different build');

    writeFileSync(p.bin, '');
    assert.equal((await installSingbox(base(f))).status, 'installed', 'binary emptied');
  });

  test('on Windows the binary is sing-box.exe', async () => {
    const f = fixture({ platform: 'win32' });
    await installSingbox(base(f));
    assert.ok(existsSync(installPaths(root, 'win32').bin));
  });
});

describe('what it refuses, and what it leaves untouched', () => {
  test('a file whose SHA-256 is not the pinned one is NEVER installed', async () => {
    const f = fixture();
    await assert.rejects(
      installSingbox(base(f, { fetchImpl: respond(Buffer.from('a different file entirely')) })),
      /REFUSING .* its SHA-256 is [0-9a-f]{64}, not the pinned/s);
    assert.ok(!existsSync(installPaths(root, 'linux').bin), 'a binary from an unverified archive was installed');
  });

  test('a one-bit difference is enough to refuse', async () => {
    const f = fixture();
    const tampered = Buffer.from(f.archive); tampered[0] ^= 1;
    await assert.rejects(installSingbox(base(f, { fetchImpl: respond(tampered) })), /REFUSING/);
  });

  test('the extractor is never even run on an unverified archive', async () => {
    const f = fixture();
    let extracted = 0;
    await assert.rejects(installSingbox(base(f, {
      fetchImpl: respond(Buffer.from('nope')), extract: () => { extracted++; },
    })), /REFUSING/);
    assert.equal(extracted, 0, 'an unverified archive was unpacked');
  });

  test('a binary that is not the pinned version is rejected before it replaces anything', async () => {
    const f = fixture();
    await assert.rejects(installSingbox(base(f, { versionOf: () => 'sing-box version 1.2.3\n' })), /not 1\.14\.1/);
    assert.ok(!existsSync(installPaths(root, 'linux').bin));
    assert.ok(!existsSync(installPaths(root, 'linux').bin + '.new'), 'a half-installed file was left behind');
  });

  test('an archive without the binary is an error', async () => {
    const f = fixture();
    await assert.rejects(installSingbox(base(f, { extract: (_a, into) => writeFileSync(join(into, 'README'), 'x') })),
      /did not contain sing-box/);
  });

  test('an HTTP error is an error, not an empty install', async () => {
    const f = fixture();
    await assert.rejects(installSingbox(base(f, { fetchImpl: respond('gone', { status: 404 }) })), /HTTP 404/);
    assert.ok(!existsSync(installPaths(root, 'linux').bin));
  });

  test('a network failure is an error', async () => {
    const f = fixture();
    await assert.rejects(installSingbox(base(f, { fetchImpl: async () => { throw new Error('ENOTFOUND github.com'); } })), /ENOTFOUND/);
  });

  test('a FAILED upgrade leaves the working binary exactly as it was', async () => {
    const v1 = fixture({ binary: 'GOOD-OLD-BINARY' });
    await installSingbox(base(v1));
    const p = installPaths(root, 'linux');

    const v2 = fixture({ version: '1.15.0', binary: 'NEW-BINARY' });
    await assert.rejects(installSingbox(base(v2, { fetchImpl: respond(Buffer.from('tampered')) })), /REFUSING/);
    assert.equal(readFileSync(p.bin, 'utf8'), 'GOOD-OLD-BINARY', 'the working binary was destroyed by a failed upgrade');
    assert.equal(JSON.parse(readFileSync(p.record, 'utf8')).version, '1.14.1');
  });

  test('a SUCCESSFUL upgrade replaces it and updates the record', async () => {
    await installSingbox(base(fixture({ binary: 'OLD' })));
    const v2 = fixture({ version: '1.15.0', binary: 'NEW' });
    const r = await installSingbox(base(v2));
    assert.equal(r.status, 'installed');
    const p = installPaths(root, 'linux');
    assert.equal(readFileSync(p.bin, 'utf8'), 'NEW');
    assert.equal(JSON.parse(readFileSync(p.record, 'utf8')).version, '1.15.0');
  });
});

describe('extraction uses the right tool on each platform', () => {
  test('Windows calls System32\\tar.exe by full path (bsdtar: reads .zip, understands C:\\ paths)', () => {
    const calls = [];
    extractArchive('C:\\t\\a.zip', 'C:\\t\\out', { platform: 'win32', exists: () => true, run: (...a) => calls.push(a) });
    assert.equal(calls.length, 1);
    assert.match(calls[0][0].replace(/\\/g, '/'), /\/System32\/tar\.exe$/i);
    assert.deepEqual(calls[0][1], ['-xf', 'C:\\t\\a.zip', '-C', 'C:\\t\\out']);
  });

  test('Windows without tar.exe falls back to PowerShell Expand-Archive, quoting paths safely', () => {
    const calls = [];
    extractArchive("C:\\it's\\a.zip", 'C:\\out', { platform: 'win32', exists: () => false, run: (...a) => calls.push(a) });
    assert.equal(calls[0][0], 'powershell.exe');
    const cmd = calls[0][1].at(-1);
    assert.match(cmd, /^Expand-Archive -LiteralPath 'C:\\it''s\\a\.zip' -DestinationPath 'C:\\out' -Force$/);
  });

  test('Linux and macOS use tar', () => {
    for (const platform of ['linux', 'darwin']) {
      const calls = [];
      extractArchive('/t/a.tar.gz', '/t/out', { platform, run: (...a) => calls.push(a) });
      assert.deepEqual(calls[0].slice(0, 2), ['tar', ['-xf', '/t/a.tar.gz', '-C', '/t/out']]);
    }
  });
});

describe('the download is bounded', () => {
  test('a declared size over the cap is refused before reading it', async () => {
    await assert.rejects(
      downloadVerified('https://x/', join(root, 'a'), {
        maxBytes: 100, fetchImpl: respond(Buffer.alloc(10), { headers: { 'content-length': '5000' } }),
      }), /over the 100 byte limit/);
  });

  test('a stream that exceeds the cap without declaring it is cut off', async () => {
    await assert.rejects(
      downloadVerified('https://x/', join(root, 'a'), { maxBytes: 100, fetchImpl: respond(Buffer.alloc(5000)) }),
      /exceeded 100 bytes/);
  });

  test('it returns the SHA-256 of exactly what it wrote', async () => {
    const bytes = Buffer.from('hello world');
    const got = await downloadVerified('https://x/', join(root, 'a'), { fetchImpl: respond(bytes) });
    assert.equal(got, sha(bytes));
    assert.equal(readFileSync(join(root, 'a')).toString(), 'hello world');
  });
});

describe('the committed pin is internally consistent', () => {
  const manifest = loadManifest(ROOT);

  test('every asset has a real digest, an official URL and its own version in its name', () => {
    for (const key of Object.keys(manifest.assets)) {
      const a = assetFor(manifest, key);
      assert.match(a.name, new RegExp(`^sing-box-${manifest.version.replace(/\./g, '\\.')}-${key}\\.(tar\\.gz|zip)$`), key);
      assert.match(a.url, /^https:\/\/github\.com\/SagerNet\/sing-box\/releases\/download\/v[\d.]+\/sing-box-/);
    }
  });

  test('the tag is the version', () => assert.equal(manifest.tag, `v${manifest.version}`));

  test('the platforms Render and a developer laptop actually use are pinned', () => {
    for (const key of ['linux-amd64', 'linux-arm64', 'windows-amd64', 'darwin-arm64', 'darwin-amd64']) {
      assert.ok(manifest.assets[key], `no pinned build for ${key}`);
    }
  });

  test('the Dockerfile builds the SAME version the installer pins', () => {
    const m = /^ARG SINGBOX_VERSION=(\S+)$/m.exec(readFileSync(join(ROOT, 'Dockerfile'), 'utf8'));
    assert.ok(m, 'the Dockerfile no longer pins SINGBOX_VERSION');
    assert.equal(m[1], manifest.tag, 'the Docker image and the native build would run different sing-box versions');
  });

  test('the native Render build runs the installer, and fails the build if it fails', () => {
    const render = readFileSync(join(ROOT, 'render.yaml'), 'utf8');
    const build = /buildCommand:\s*(.+)/.exec(render)?.[1] || '';
    assert.match(build, /npm ci --omit=dev && npm run singbox:install/,
      'the deploy builds without the daemon, so it would refuse every proxied connection');
    assert.doesNotMatch(build, /\|\||;\s*true|--ignore-scripts\s*$/, 'the install step is allowed to fail silently');
    assert.equal(JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).scripts['singbox:install'],
      'node tools/install-singbox.mjs');
  });

  test('the binary is git-ignored and Docker-ignored: sing-box is GPL and is never committed', () => {
    assert.match(readFileSync(join(ROOT, '.gitignore'), 'utf8'), /^\.singbox\/$/m);
    assert.match(readFileSync(join(ROOT, '.dockerignore'), 'utf8'), /^\.singbox$/m);
  });

  test('a failed install exits non-zero (that is what fails the build)', () => {
    const src = readFileSync(join(ROOT, 'tools', 'install-singbox.mjs'), 'utf8');
    assert.match(src, /process\.exit\(1\)/);
  });
});

describe('the supervisor finds the installed binary', () => {
  test('SINGBOX_BIN still wins when set', async () => {
    const { singboxProcessStatus } = await import('../lib/singbox-supervisor.mjs');
    assert.equal(singboxProcessStatus({ SINGBOX_BIN: '/custom/sing-box' }).binary, '/custom/sing-box');
  });

  test('otherwise it prefers the repository-local pinned binary when present, else PATH', async () => {
    const { singboxProcessStatus } = await import('../lib/singbox-supervisor.mjs');
    const got = singboxProcessStatus({}).binary.replace(/\\/g, '/');
    const local = installPaths(ROOT).bin.replace(/\\/g, '/');
    assert.ok(got === 'sing-box' || got === local, `unexpected default binary: ${got}`);
    if (existsSync(installPaths(ROOT).bin)) assert.equal(got, local);
  });
});
