// test/invisiproxy.test.mjs — the InvisiProxy integration is a BOUNDARY, and
// these tests exist to keep it one.
// ---------------------------------------------------------------------------
// ZoFHub ships no InvisiProxy code. That is not a stylistic preference: ZoFHub's
// LICENSE is proprietary and the site is offered over a network, so AGPL-3.0
// source inside the served work would engage §13 for the whole combination.
// The integration is therefore a URL and nothing else.
//
// A future change could erode that quietly — a vendored folder "just to try
// something", a dependency added for one helper. These tests make that loud.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isAdSurface } from '../lib/ad-providers.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const provenance = JSON.parse(read('data/invisiproxy-upstream.json'));

describe('the boundary holds: nothing is vendored or depended on', () => {
  test('InvisiProxy is not a dependency of any kind', () => {
    const pkg = JSON.parse(read('package.json'));
    const all = { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.optionalDependencies };
    for (const name of Object.keys(all)) {
      assert.ok(!/invisi|holyunblocker|holy-unblocker/i.test(name),
        `${name} was added as a dependency — see docs/proxy/INVISIPROXY.md §1`);
    }
  });

  test('no InvisiProxy source tree was vendored', () => {
    // A directory is not a licence boundary. If somebody adds one, this fails
    // before it reaches a deploy that would be serving AGPL source.
    for (const dir of ['vendor', 'proxy-engine', 'lib', 'public']) {
      const p = join(ROOT, dir);
      if (!existsSync(p)) continue;
      for (const entry of readdirSync(p)) {
        assert.ok(!/^(invisiproxy|holy-?unblocker)$/i.test(entry),
          `${dir}/${entry} looks like a vendored copy — the integration must stay a URL`);
      }
    }
  });

  test('upstream is not fetched at build or install time', () => {
    // The other direction of the same rule: pulling the tarball during a build
    // would put AGPL source into the deployed image.
    const pkg = JSON.parse(read('package.json'));
    for (const [name, cmd] of Object.entries(pkg.scripts || {})) {
      assert.ok(!/QuiteAFancyEmerald|InvisiProxy/i.test(cmd),
        `script "${name}" fetches upstream: ${cmd}`);
    }
    assert.ok(!/QuiteAFancyEmerald/i.test(read('Dockerfile')),
      'the Dockerfile fetches InvisiProxy — it must not be built into the image');
  });
});

describe('the provenance record is accurate and complete', () => {
  test('it records an exact upstream version and commit', () => {
    assert.match(provenance.reviewedVersion, /^v\d+\.\d+\.\d+/);
    assert.match(provenance.reviewedCommit, /^[0-9a-f]{40}$/, 'a 40-char commit sha is what makes this reproducible');
    assert.match(provenance.reviewedOn, /^\d{4}-\d{2}-\d{2}$/);
  });

  test('it records the licence and the copyright holder', () => {
    assert.equal(provenance.license, 'AGPL-3.0-only');
    assert.match(provenance.copyright, /TitaniumNetwork/);
    assert.equal(provenance.upstream, 'https://github.com/QuiteAFancyEmerald/InvisiProxy');
  });

  test('it states that nothing was incorporated, and stays consistent with that', () => {
    assert.deepEqual(provenance.incorporated, [],
      'if anything IS incorporated, the AGPL analysis in docs/proxy/INVISIPROXY.md §1 no longer applies');
    assert.equal(provenance.vendored, false);
    assert.equal(provenance.dependencyAdded, false);
  });

  test('every adopted idea names where it lives here and denies copying code', () => {
    assert.ok(provenance.adopted.length > 0, 'the record claims nothing was learned, which is not true');
    for (const a of provenance.adopted) {
      assert.ok(a.upstreamReference, `${a.idea}: no upstream reference`);
      assert.ok(a.zofhubImplementation, `${a.idea}: no local implementation named`);
      assert.equal(a.codeCopied, false, `${a.idea}: claims code was copied — that changes the licence position`);
      // The file it names must exist, or the provenance record is fiction.
      assert.ok(existsSync(join(ROOT, a.zofhubImplementation)),
        `${a.idea}: ${a.zofhubImplementation} does not exist`);
    }
  });

  test('every rejection carries a reason', () => {
    assert.ok(provenance.rejected.length > 0);
    for (const r of provenance.rejected) {
      assert.ok(r.component && r.reason && r.reason.length > 30,
        `${r.component}: "documented why" means a reason someone can evaluate`);
    }
  });
});

describe('it is wired in as an engine, not as infrastructure', () => {
  const server = read('server.js');

  test('it is a companion engine driven by one env var', () => {
    assert.match(server, /PROXY_INVISI_URL/, 'the engine is not wired up at all');
    assert.match(server, /id:\s*'invisi'/, 'no invisi entry in COMPANION_ENGINES');
  });

  test('its URL goes through the credential stripper like every other engine', () => {
    // /api/proxies is unauthenticated and publishes these URLs verbatim.
    assert.match(server, /publicEngineUrl\(process\.env\.PROXY_INVISI_URL/,
      'PROXY_INVISI_URL is read raw — a password in it would be published');
  });

  test('it carries its own setup hint, because npm run proxies cannot start it', () => {
    const browser = read('public/js/browser.js');
    assert.ok(!/invisi\s*:/.test(browser.split('const SETUP_HINT')[1]?.split('}')[0] || ''),
      'invisi must not be in SETUP_HINT — that block claims `npm run proxies` starts the engine');
    assert.match(server, /pnpm install && pnpm start/, 'no setup instruction is sent for InvisiProxy');
  });

  test('nothing proxies ZoFHub traffic THROUGH it', () => {
    // The whole licence position depends on it being a peer the browser talks
    // to, not a component this server routes requests into.
    assert.ok(!/PROXY_INVISI_URL[^\n]*\b(fetch|request|pipe|createProxy)\b/.test(server),
      'server-side traffic is being sent to InvisiProxy — that is a different architecture');
  });
});

describe('network telemetry and AI training data stay separate systems', () => {
  // The requirement is that proxied traffic — URLs, bodies, headers, cookies,
  // browsing history — can never become model-training data. That must be
  // STRUCTURAL, not a policy promise, because a promise cannot be tested.
  const server = read('server.js');

  test('the feedback pipeline is reachable only from the feedback endpoint', () => {
    // prepareFeedbackRecord() is the single doorway into the AI corpus. If a
    // proxy or tunnel code path ever calls it, proxy activity becomes training
    // input — so the number of call sites is the invariant.
    const calls = [...server.matchAll(/prepareFeedbackRecord\s*\(/g)].length;
    assert.equal(calls, 1, `prepareFeedbackRecord is called ${calls} times — it must have exactly one caller`);

    // And that caller must be the deliberate, user-initiated feedback route.
    const at = server.indexOf('prepareFeedbackRecord({');
    const before = server.slice(Math.max(0, at - 3000), at);
    const lastRoute = before.lastIndexOf("app.post('/api/");
    assert.ok(lastRoute !== -1 && before.slice(lastRoute).startsWith("app.post('/api/ai/feedback'"),
      'prepareFeedbackRecord is no longer inside POST /api/ai/feedback');
  });

  test('no tunnel or engine module imports the feedback pipeline', () => {
    for (const f of ['proxy-engine/mount.mjs', 'lib/wisp-policy.mjs', 'public/js/browser.js']) {
      assert.ok(!/ai-feedback|prepareFeedbackRecord|routeSignal/.test(read(f)),
        `${f} touches the AI feedback pipeline — proxy activity must never reach it`);
    }
  });

  test('tunnel telemetry is counters, never destinations', () => {
    // wispSnapshot() feeds the admin console. If it ever carried hostnames or
    // URLs, proxy browsing history would be retained where nothing says it is.
    const at = server.indexOf('function wispSnapshot');
    assert.notEqual(at, -1, 'wispSnapshot no longer exists — re-check what telemetry replaced it');
    const body = server.slice(at, at + 1400);
    for (const leak of ['hostname', 'destination', 'targetUrl', 'req.url']) {
      assert.ok(!body.includes(leak), `wispSnapshot exposes "${leak}" — that is browsing history`);
    }
  });

  test('the AI provider is NOT routed through the proxy, and that is deliberate', () => {
    // Proxying Hugging Face would put the visitor's own hf_ token inside
    // ZoFHub's tunnel, breaking the guarantee asserted elsewhere that the token
    // never reaches a ZoFHub endpoint. "Use the proxy only where there is a
    // clear architectural reason" cuts against it here.
    const hf = read('public/js/hf-inference.js');
    for (const proxied of ['/wisp/', 'BareMux', 'baremux', '/epoxy/', '__uv$config', 'scramjet']) {
      assert.ok(!hf.includes(proxied),
        `hf-inference.js routes through ${proxied} — the user's token would enter our tunnel`);
    }
  });
});

describe('advertising can never attach to it', () => {
  test('/invisi is classified as a proxy surface', () => {
    assert.equal(isAdSurface('/invisi'), false);
    assert.equal(isAdSurface('/invisi/anything'), false);
  });
});

describe('the documentation matches the implementation', () => {
  const doc = read('docs/proxy/INVISIPROXY.md');

  test('the doc exists and pins the same commit as the provenance record', () => {
    assert.ok(doc.includes(provenance.reviewedCommit.slice(0, 8)),
      'docs/proxy/INVISIPROXY.md and data/invisiproxy-upstream.json disagree about which commit was reviewed');
    assert.ok(doc.includes(provenance.reviewedVersion));
  });

  test('it states the AGPL position rather than implying a folder is enough', () => {
    assert.match(doc, /§13/);
    assert.match(doc, /subdirectory does not change that|subdirectory is not a licence boundary/i);
  });

  test('credit is visible to users, not only to developers', () => {
    // A docs/CREDITS.md nobody opens is not attribution.
    const credits = read('legal/credits.html');
    assert.match(credits, /InvisiProxy/, 'the user-facing credits page does not mention it');
    assert.match(credits, /QuiteAFancyEmerald/, 'the upstream author is not credited on the page');
    assert.match(credits, /AGPL-3\.0/);
    assert.match(read('docs/CREDITS.md'), /InvisiProxy LTS/);
  });

  test('the engine and the egress policy are both documented for operators', () => {
    const envExample = read('.env.example');
    for (const key of ['PROXY_INVISI_URL', 'WISP_ALLOWED_PORTS', 'WISP_ALLOW_UDP',
      'WISP_ALLOW_PRIVATE_IPS', 'WISP_MAX_STREAMS']) {
      assert.ok(envExample.includes(key), `${key} is not documented in .env.example`);
      assert.ok(read('render.yaml').includes(key), `${key} is not declared in render.yaml`);
    }
  });
});
