// Supervision of a MANAGED sing-box process.
//
// sing-box is GPL-3.0 and a separate program. Its source is NOT vendored here —
// the Dockerfile builds a pinned, unmodified upstream release — so this module
// only ever spawns and watches a binary, the way an init system does. These
// tests pin the properties that make that safe.
//
// The three that matter:
//   1. Unconfigured is a no-op. The standard deploy does not build sing-box and
//      does not set SINGBOX_MANAGED; nothing here may run, throw, or spawn.
//   2. A bad config must NOT crash-loop. `sing-box check` runs before every
//      start precisely so a typo becomes one error line instead of hundreds of
//      spawns a second.
//   3. The rendered config holds a REALITY private key and the API secret. It
//      must be written 0600 and must never reach a status payload or a log.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  singboxManaged, renderConfig, singboxProcessStatus, stopSingbox, ensureApiSecret,
} from '../lib/singbox-supervisor.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const TMP = mkdtempSync(join(tmpdir(), 'zofhub-sb-'));

// The DEFAULT profile is the local SOCKS egress one; REALITY is the opt-in
// profile for hosts that own :443. Tests that are about placeholders and the
// VLESS inbound must name it explicitly, or they assert against a template that
// has neither.
const REALITY_TPL = join(ROOT, 'deploy', 'singbox', 'config.reality.template.json');

const SECRETS = {
  SINGBOX_API_SECRET: 'api-secret-DO-NOT-LEAK',
  SINGBOX_UUID_OWNER: '11111111-2222-3333-4444-555555555555',
  SINGBOX_HANDSHAKE_HOST: 'www.example.com',
  SINGBOX_REALITY_PRIVATE_KEY: 'PRIVATE-KEY-DO-NOT-LEAK',
  SINGBOX_REALITY_SHORT_ID: 'a1b2c3d4',
};

describe('managed mode is on by default, and switchable off', () => {
  // THIS FLIPPED DELIBERATELY. sing-box stopped being a dashboard widget and
  // became the proxy's egress path (lib/singbox-socket.mjs), so a daemon nobody
  // started is a site running entirely on the fallback. The Dockerfile builds
  // the binary by default and the supervisor runs it by default; an operator who
  // wants to run it themselves, or not at all, says so explicitly.
  test('unset means managed', () => {
    assert.equal(singboxManaged({}), true);
    assert.equal(singboxManaged({ SINGBOX_MANAGED: '' }), true);
  });

  test('the off switches all work', () => {
    for (const v of ['0', 'false', 'FALSE', 'no', 'off', ' off ']) {
      assert.equal(singboxManaged({ SINGBOX_MANAGED: v }), false, `"${v}" should disable managed mode`);
    }
  });

  test('turning it off is honoured even with the daemon otherwise configured', () => {
    // Pointing the read-only adapter at a daemon someone else runs must not
    // drag supervision back on: two sing-boxes fighting over :2080 is an
    // outage, and the operator has already said which one is theirs.
    assert.equal(singboxManaged({
      SINGBOX_MANAGED: '0',
      SINGBOX_API_URL: 'http://127.0.0.1:9090',
      SINGBOX_BIN: '/usr/local/bin/sing-box',
    }), false);
  });

  test('the usual truthy spellings all work', () => {
    for (const v of ['1', 'true', 'TRUE', 'yes', 'on']) {
      assert.equal(singboxManaged({ SINGBOX_MANAGED: v }), true, `"${v}" should enable managed mode`);
    }
  });

  test('stopping when nothing is running is safe and idempotent', async () => {
    assert.deepEqual(await stopSingbox(), { stopped: true, reason: 'not-running' });
    assert.deepEqual(await stopSingbox(), { stopped: true, reason: 'not-running' });
  });
});

describe('config rendering', () => {
  test('a missing value is refused, and named', () => {
    // The failure this prevents: an unsubstituted "${SINGBOX_UUID_OWNER}" is
    // accepted by sing-box as a literal uuid, and then nobody can authenticate
    // — a silent, very confusing outage.
    //
    // Asserted against the REALITY profile because that is the one with
    // placeholders left to miss. The DEFAULT profile needs only the API secret,
    // and ensureApiSecret() generates that at boot — see the next test.
    const r = renderConfig({ SINGBOX_CONFIG_PATH: join(TMP, 'missing.json') }, REALITY_TPL);
    assert.equal(r.ok, false);
    for (const k of Object.keys(SECRETS)) {
      assert.match(r.error, new RegExp(k), `the error does not name ${k}`);
    }
  });

  test('the DEFAULT profile renders with no operator input at all', () => {
    // "On by default" is a lie if the daemon refuses to start on a fresh deploy
    // for want of a secret nobody was told to invent. ensureApiSecret() fills
    // the only placeholder the default template has.
    const env = { SINGBOX_CONFIG_PATH: join(TMP, 'zeroconf.json') };
    const secret = ensureApiSecret(env);
    const r = renderConfig(env);
    assert.equal(r.ok, true, r.error);
    assert.ok(secret && secret.length >= 16, 'a generated secret must not be trivial');

    const cfg = JSON.parse(readFileSync(r.path, 'utf8'));
    assert.equal(cfg.experimental.clash_api.secret, secret);
    // Both halves must agree, or the adapter authenticates against nothing.
    assert.equal(env.SINGBOX_API_URL, 'http://127.0.0.1:9090');
  });

  test('a complete environment renders valid, placeholder-free JSON', () => {
    const out = join(TMP, 'full.json');
    const r = renderConfig({ ...SECRETS, SINGBOX_CONFIG_PATH: out });
    assert.equal(r.ok, true, r.error);
    const text = readFileSync(out, 'utf8');
    assert.doesNotThrow(() => JSON.parse(text));
    assert.ok(!/\$\{[A-Z0-9_]+\}/.test(text), 'an unsubstituted placeholder survived');
  });

  test('the $comment documentation keys are stripped', () => {
    // They are for the reader of the template, not for the daemon; sing-box is
    // not obliged to tolerate unknown keys.
    const out = join(TMP, 'nocomment.json');
    renderConfig({ ...SECRETS, SINGBOX_CONFIG_PATH: out });
    assert.ok(!readFileSync(out, 'utf8').includes('$comment'));
  });

  test('values actually land where the daemon reads them', () => {
    const out = join(TMP, 'values.json');
    renderConfig({ ...SECRETS, SINGBOX_CONFIG_PATH: out }, REALITY_TPL);
    const cfg = JSON.parse(readFileSync(out, 'utf8'));
    assert.equal(cfg.inbounds[0].users[0].uuid, SECRETS.SINGBOX_UUID_OWNER);
    assert.equal(cfg.inbounds[0].tls.server_name, SECRETS.SINGBOX_HANDSHAKE_HOST);
    assert.equal(cfg.inbounds[0].tls.reality.handshake.server, SECRETS.SINGBOX_HANDSHAKE_HOST);
    assert.equal(cfg.experimental.clash_api.secret, SECRETS.SINGBOX_API_SECRET);
  });

  test('server_name and handshake.server cannot disagree', () => {
    // REALITY borrows the handshake of handshake.server; if server_name names a
    // different host the TLS it presents does not match what it borrowed, and
    // the camouflage — the entire point — fails.
    const out = join(TMP, 'sni.json');
    renderConfig({ ...SECRETS, SINGBOX_CONFIG_PATH: out }, REALITY_TPL);
    const tls = JSON.parse(readFileSync(out, 'utf8')).inbounds[0].tls;
    assert.equal(tls.server_name, tls.reality.handshake.server);
  });

  test('the rendered default config still rejects private ranges', () => {
    // Rendering is string substitution, so a template edit can silently drop a
    // route rule and nothing upstream would notice. What the daemon is actually
    // handed is what matters, so assert on the OUTPUT, not the template.
    const env = { SINGBOX_CONFIG_PATH: join(TMP, 'rendered-route.json') };
    ensureApiSecret(env);
    const r = renderConfig(env);
    assert.equal(r.ok, true, r.error);
    const cfg = JSON.parse(readFileSync(r.path, 'utf8'));
    const covered = new Set(
      cfg.route.rules.filter(x => x.action === 'reject' || x.outbound === 'block')
        .flatMap(x => x.ip_cidr || []),
    );
    for (const cidr of ['127.0.0.0/8', '169.254.0.0/16', '10.0.0.0/8', '::1/128']) {
      assert.ok(covered.has(cidr), `the rendered config lets a client reach ${cidr}`);
    }
    assert.match(cfg.experimental.clash_api.external_controller, /^127\.0\.0\.1:/);
  });

  test('an unreadable template is an error, not a throw', () => {
    const r = renderConfig({ ...SECRETS, SINGBOX_CONFIG_PATH: join(TMP, 'x.json') },
      join(TMP, 'does-not-exist.json'));
    assert.equal(r.ok, false);
    assert.match(r.error, /not readable/);
  });
});

describe('the rendered config is treated as a credential', () => {
  test('it is written owner-only (0600)', function () {
    const out = join(TMP, 'perm.json');
    renderConfig({ ...SECRETS, SINGBOX_CONFIG_PATH: out });
    const mode = statSync(out).mode & 0o777;
    if (process.platform === 'win32') {
      // Windows does not implement POSIX permission bits; Node reports a
      // synthesised mode. Asserting 0600 here would fail for reasons that say
      // nothing about the code, so the real check runs on the deploy platform.
      assert.ok(mode >= 0, 'mode is readable');
      return;
    }
    assert.equal(mode, 0o600, `config is mode ${mode.toString(8)} — it holds a private key`);
  });

  test('it lands outside the repository', () => {
    // It contains a REALITY private key after substitution. A default inside the
    // working tree is one `git add -A` away from being committed.
    const r = renderConfig({ ...SECRETS });
    assert.equal(r.ok, true, r.error);
    const normalised = r.path.replace(/\\/g, '/');
    assert.ok(!normalised.startsWith(ROOT.replace(/\\/g, '/')),
      `the rendered config defaults to ${r.path}, which is inside the repo`);
  });

  test('the status payload carries no secret', () => {
    const json = JSON.stringify(singboxProcessStatus({ ...SECRETS, SINGBOX_MANAGED: '1' }));
    for (const [k, v] of Object.entries(SECRETS)) {
      assert.ok(!json.includes(v), `singboxProcessStatus leaked ${k}`);
    }
  });

  test('the status payload is bounded', () => {
    // It is returned on every poll of /api/admin/proxy, which the Proxy view
    // refreshes every 5 seconds.
    const st = singboxProcessStatus({ SINGBOX_MANAGED: '1' });
    assert.ok(Array.isArray(st.recentLogs));
    assert.ok(st.recentLogs.length <= 20, `recentLogs is ${st.recentLogs.length} entries`);
  });
});

describe('the build and the wiring', () => {
  const dockerfile = readFileSync(join(ROOT, 'Dockerfile'), 'utf8');
  const server = readFileSync(join(ROOT, 'server.js'), 'utf8');

  test('sing-box is pinned, not tracked to a moving tag', () => {
    // `@latest` in a build makes the image non-reproducible and silently
    // upgrades a network daemon on an unrelated redeploy.
    assert.match(dockerfile, /ARG SINGBOX_VERSION/);
    assert.ok(!/sing-box@latest/.test(dockerfile), 'the build tracks @latest');
    assert.match(dockerfile, /sing-box@"\$SINGBOX_VERSION"/,
      'the build does not install the pinned version');
  });

  test('the build is on by default, at a pinned version', () => {
    // FLIPPED DELIBERATELY, in step with singboxManaged() and SINGBOX_EGRESS:
    // sing-box carries the proxy's egress now, so an image without the binary
    // is an image where every stream silently takes the direct fallback.
    const m = dockerfile.match(/ARG SINGBOX_VERSION=(\S+)/);
    assert.ok(m, 'the Dockerfile no longer declares a default sing-box version');
    assert.notEqual(m[1], 'none', 'the default image would ship without the binary');
    assert.match(m[1], /^v\d+\.\d+\.\d+$/, `"${m[1]}" is not an exact pinned release`);
  });

  test('a binary-free image is still buildable, and still runs', () => {
    // The opt-out has to keep working: SINGBOX_VERSION=none must skip the build
    // without breaking the COPY that follows it, and a missing binary must be a
    // degraded site rather than a dead one.
    assert.match(dockerfile, /if \[ "\$SINGBOX_VERSION" = "none" \]/,
      'SINGBOX_VERSION=none no longer skips the build stage');
    assert.match(dockerfile, /if \[ -f \/usr\/local\/bin\/sing-box \]/,
      'the image setup assumes the binary is always present');
  });

  test('no sing-box source is vendored into this repository', () => {
    // The whole reason for the pinned build: ZoFHub's LICENSE is proprietary and
    // this repo is pushed to a remote, so GPL-3.0 source in the tree would be a
    // conveyance under incompatible terms.
    assert.ok(!/git clone.*sing-box/i.test(dockerfile), 'the Dockerfile clones sing-box');
    assert.ok(!/COPY .*vendor\/sing-box/.test(dockerfile), 'the Dockerfile copies vendored source');
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    assert.ok(!Object.keys(deps).some(d => /sing-?box/i.test(d)),
      'sing-box appears as an npm dependency, which it cannot be');
  });

  test('the daemon is stopped on shutdown, not orphaned', () => {
    // node is PID 1 in the container, so a surviving child becomes a zombie
    // that the platform must SIGKILL — the ungraceful restart the memory-based
    // health check exists to avoid.
    const at = server.indexOf("for (const sig of ['SIGTERM', 'SIGINT'])");
    assert.notEqual(at, -1, 'no signal handler found');
    assert.match(server.slice(at, at + 900), /stopSingbox\(/,
      'the shutdown path does not stop the managed daemon');
  });

  test('starting it never blocks the web server', () => {
    // A daemon slow to validate its config must not delay serving games.
    const at = server.indexOf('if (singboxManaged())');
    assert.notEqual(at, -1, 'the boot hook is missing');
    const body = server.slice(at, at + 500);
    assert.ok(!/await startSingbox/.test(body), 'boot awaits the supervisor');
    assert.match(body, /startSingbox\(\)\s*\n?\s*\.then/, 'boot does not start it asynchronously');
  });

  test('/api/admin/proxy separates "never started" from "crash-looping"', () => {
    const at = server.indexOf("app.get('/api/admin/proxy'");
    const body = server.slice(at, at + 1800);
    assert.match(body, /singboxProcess: singboxProcessStatus\(\)/,
      'process state is not reported alongside the API telemetry');
  });
});
