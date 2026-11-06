// Every way this server can open a connection to the outside world, accounted for.
// ---------------------------------------------------------------------------
// lib/egress.mjs, lib/singbox-socket.mjs and lib/egress-guard.mjs make the egress
// policy true AT RUNTIME. This file keeps it true over TIME. It reads the source
// and fails the build when a new code path appears that could connect out — a
// module that imports a socket API, a new HTTP client, a raw fetch(), a flag that
// reopens direct egress — until a person has decided where it belongs and written
// that decision down here.
//
// Static on purpose: it needs no network, no daemon and no credentials, so it
// runs in every environment (including the ones where the TLS tests cannot), and
// it fails on the pull request that introduces the bypass rather than on the day
// somebody notices the server's address in a destination's logs.
//
// COMMENTS ARE STRIPPED FIRST. This repo explains every removal in a comment, so a
// grep that matches the explanation is not a finding. Only code is judged.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const rel = (p) => relative(ROOT, p).split(sep).join('/');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

/**
 * Remove // and block comments. With blankStrings, also replace the CONTENTS of
 * string and template literals with spaces — same length either way, so an index
 * found in one version is valid in the other. Not a parser: good enough to
 * separate code from prose, and from client-side scripts embedded as strings (the
 * embed guard in server.js carries a whole fetch() patch as a template literal,
 * which is text to this server, not a call it makes).
 */
function code(src, blankStrings = false) {
  let out = '';
  let i = 0;
  let quote = null;
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (quote) {
      if (c === '\\') { out += blankStrings ? '  ' : c + (n ?? ''); i += 2; continue; }
      if (c === quote) { out += c; quote = null; i++; continue; }
      out += blankStrings && c !== '\n' ? ' ' : c;
      i++;
      continue;
    }
    if (c === '/' && n === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '/' && n === '*') { i += 2; while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++; i += 2; continue; }
    if (c === '"' || c === "'" || c === '`') quote = c;
    out += c;
    i++;
  }
  return out;
}

// Server-side code: what runs when the website runs. tools/ are operator CLIs, run
// by hand; test/ is excluded by definition. The one tool the SERVER spawns at boot
// is checked separately below.
function walk(dir, acc = []) {
  for (const name of readdirSync(join(ROOT, dir))) {
    const p = join(dir, name);
    const st = statSync(join(ROOT, p));
    if (st.isDirectory()) { if (name !== 'node_modules') walk(p, acc); }
    else if (/\.(mjs|js)$/.test(name)) acc.push(p.split(sep).join('/'));
  }
  return acc;
}
const SERVER_FILES = ['server.js', ...walk('lib')];
const SRC = new Map(SERVER_FILES.map((f) => [f, code(read(f))]));
const NOSTR = new Map(SERVER_FILES.map((f) => [f, code(read(f), true)]));

// ───────────────────────────────────────────────────────────────────────────
describe('the server-side file set is what we think it is', () => {
  test('the scan is not vacuous', () => {
    assert.ok(SERVER_FILES.length > 60, `only ${SERVER_FILES.length} files scanned`);
    assert.ok(SERVER_FILES.includes('server.js'));
    assert.ok(SERVER_FILES.includes('lib/safe-fetch.mjs'));
    assert.ok(SERVER_FILES.includes('lib/egress.mjs'));
  });
});

describe('only approved modules may import a socket API', () => {
  // `node:net` etc. Each entry says WHY that file is allowed, so the next person
  // to add one has a precedent to compare their reason against.
  const APPROVED = {
    'server.js': 'createServer from node:http — the INBOUND listener, not an outbound client',
    'lib/egress.mjs': 'the HTTP(S) agent whose sockets are tunnels through sing-box',
    'lib/egress-guard.mjs': 'wraps net and dgram so nothing else can connect directly',
    'lib/singbox-socket.mjs': 'the SOCKS5 tunnel to the daemon, on loopback',
    'lib/safe-fetch.mjs': 'the chokepoint for server-side fetches; hands node:http(s) the sing-box agent',
    'lib/ai-guard.mjs': 'isIP only — an address predicate, no socket is opened',
  };
  const RX = /(?:from\s+|require\()\s*['"](?:node:)?(net|tls|http|https|http2|dgram)['"]/g;

  test('no unapproved file imports net, tls, http, https, http2 or dgram', () => {
    const offenders = [];
    for (const [f, s] of SRC) {
      if (APPROVED[f]) continue;
      for (const m of s.matchAll(RX)) offenders.push(`${f} imports ${m[1]}`);
    }
    assert.deepEqual(offenders, [],
      'a new file can open sockets. Route it through lib/safe-fetch.mjs (visitor-driven URLs) or, if it is the '
      + "operator's own infrastructure, add its host to buildInfraAllowlist() and approve it here with a reason.");
  });

  test('every approved file still exists and still uses what it was approved for', () => {
    for (const f of Object.keys(APPROVED)) {
      assert.ok(SRC.has(f), `${f} was approved but is no longer scanned (renamed or deleted?)`);
      assert.ok([...SRC.get(f).matchAll(RX)].length > 0, `${f} no longer imports a socket API — remove its approval`);
    }
  });

  test('an outbound client is never created from the listener module', () => {
    const s = SRC.get('server.js');
    assert.doesNotMatch(s, /\bhttps?\.(request|get)\s*\(/);
    assert.doesNotMatch(s, /\bnet\.(connect|createConnection)\s*\(/);
    assert.doesNotMatch(s, /new\s+WebSocket\s*\(/);
  });
});

describe('only approved modules may import a third-party network client', () => {
  const CLIENTS = /from\s+['"](ws|undici|node-fetch|axios|got|superagent|request|socks|socks-proxy-agent|https-proxy-agent|http-proxy-agent|pg|redis|mqtt|nodemailer|@sendgrid\/mail|resend|@aws-sdk\/[^'"]+|@supabase\/supabase-js|ioredis)['"]/g;
  const APPROVED = {
    'lib/cache.mjs': ['ioredis'],
    'lib/supabase.mjs': ['@supabase/supabase-js'],
  };
  test('the clients in use are exactly the two infrastructure clients', () => {
    const found = {};
    for (const [f, s] of SRC) for (const m of s.matchAll(CLIENTS)) (found[f] ||= []).push(m[1]);
    assert.deepEqual(found, APPROVED,
      'a network client appeared (or one of the two moved). Infrastructure clients connect directly, so their host '
      + 'must be on the allowlist in lib/egress-guard.mjs; anything visitor-driven must use safeFetch.');
  });
});

describe('raw fetch() is allowed only where the destination is the operator\'s own', () => {
  // `fetch(` as a call, or `= fetch` as a default. Not `safeFetch(`, not `.fetch(`.
  const CALL = /(?<![\w.$])fetch\s*\(|=\s*fetch\s*[,)}]/g;
  const APPROVED = {
    'server.js': { count: 1, why: 'the mail-provider call (api.resend.com, allowlisted only when RESEND_API_KEY is set)' },
    'lib/supabase.mjs': { count: 1, why: 'the database client (SUPABASE_URL, allowlisted)' },
    'lib/singbox.mjs': { count: 1, why: "the daemon's own loopback Clash API" },
    'lib/swap.mjs': { count: 1, why: 'the swap provider (allowlisted only when SWAP_PROVIDER names it)' },
  };
  test('exactly the known call sites, and no more', () => {
    const found = {};
    for (const [f, s] of NOSTR) { const n = [...s.matchAll(CALL)].length; if (n) found[f] = n; }
    const expected = Object.fromEntries(Object.entries(APPROVED).map(([f, v]) => [f, v.count]));
    assert.deepEqual(found, expected,
      'a raw fetch() appeared. A URL this server did not choose must go through safeFetch (lib/safe-fetch.mjs); '
      + "the operator's own infrastructure must be on the allowlist and listed here.");
  });

  test('the one raw call in server.js goes only where the allowlist says', () => {
    // Find the calls on the string-blanked text, read their first argument from the
    // real text at the same index (the two are the same length by construction).
    const blank = NOSTR.get('server.js');
    const real = SRC.get('server.js');
    const targets = [...blank.matchAll(/(?<![\w.$])fetch\s*\(\s*/g)]
      .map((m) => real.slice(m.index + m[0].length).split(/,\s*\{/)[0].trim());
    assert.deepEqual(targets, ['`https://api.resend.com/audiences/${encodeURIComponent(audience)}/contacts`']);
  });

  test('every raw-fetch destination is on the infrastructure allowlist when it is configured', async () => {
    const { buildInfraAllowlist } = await import('../lib/egress-guard.mjs');
    const allow = buildInfraAllowlist({
      SUPABASE_URL: 'https://p.supabase.co', RESEND_API_KEY: 'x', SWAP_PROVIDER: 'sideshift',
      SINGBOX_API_URL: 'http://127.0.0.1:9090',
    });
    for (const h of ['p.supabase.co', 'api.resend.com', 'sideshift.ai', '127.0.0.1']) {
      assert.ok(allow.includes(h), `${h} is fetched directly but not allowlisted`);
    }
  });
});

describe('visitor-driven fetches all use safeFetch, and safeFetch never connects directly', () => {
  test('the known callers import it', () => {
    for (const f of ['lib/cron-jobs.mjs', 'lib/link-checker.mjs', 'lib/gamedistribution-import.mjs']) {
      assert.match(SRC.get(f), /safe-fetch\.mjs/, `${f} no longer fetches through safeFetch`);
    }
    assert.match(SRC.get('server.js'), /safeFetch\(/);
  });

  test('safe-fetch hands requests the sing-box egress by default', () => {
    const s = SRC.get('lib/safe-fetch.mjs');
    assert.match(s, /createEgress\(\{\s*lookup:\s*guardedLookup,\s*isPublic:\s*isPublicAddress\s*\}\)/);
    assert.match(s, /egress\s*=\s*DEFAULT_EGRESS/);
    assert.match(s, /agent:\s*egress\.agentFor\(/);
    assert.doesNotMatch(s, /agent:\s*false/, 'safeFetch still asks for an unpooled DIRECT socket');
  });

  test('the test-only direct egress is referenced from nowhere but its definition and tests', () => {
    const users = SERVER_FILES.filter((f) => SRC.get(f).includes('directEgressForTests'));
    assert.deepEqual(users.sort(), ['lib/egress.mjs', 'lib/safe-fetch.mjs']);
    for (const f of ['tools/fetch-y8-thumbs.mjs']) {
      if (existsSync(join(ROOT, f))) assert.ok(!read(f).includes('directEgressForTests'), f);
    }
  });

  test('no production caller passes an egress override to safeFetch', () => {
    for (const [f, s] of SRC) {
      if (f === 'lib/safe-fetch.mjs' || f === 'lib/egress.mjs') continue;
      assert.doesNotMatch(s, /safeFetch\([^)]*\begress\s*:/s, `${f} overrides safeFetch's egress`);
    }
  });
});

describe('the policy flags that reopen direct egress live in exactly one place', () => {
  test('SINGBOX_ALLOW_DIRECT, SINGBOX_REQUIRE and SINGBOX_EGRESS are read by lib/egress-policy.mjs alone', () => {
    const users = [];
    for (const [f, s] of SRC) if (/SINGBOX_(ALLOW_DIRECT|REQUIRE|EGRESS)/.test(s)) users.push(f);
    assert.deepEqual(users, ['lib/egress-policy.mjs'],
      'something else reads an opt-out flag, which means something else can decide to go direct');
  });

  test('production is decided from NODE_ENV first, with no flag that reopens it', () => {
    const s = SRC.get('lib/egress-policy.mjs');
    assert.match(s, /const directAllowed = !production && requested\.length > 0/);
    assert.match(s, /singboxEnabled: production \|\| /);
  });

  test('the deploy configuration does not set any opt-out', () => {
    const render = read('render.yaml');
    for (const flag of ['SINGBOX_ALLOW_DIRECT', 'SINGBOX_REQUIRE', 'SINGBOX_EGRESS']) {
      const m = new RegExp(`- key: ${flag}\\s*\\n\\s*(value:\\s*(\\S+)|sync:\\s*false)`).exec(render);
      if (!m) continue;                                   // declared without a value, or not declared
      assert.ok(m[1].startsWith('sync: false'), `render.yaml sets ${flag} to ${m[2]}`);
    }
    assert.match(read('Dockerfile'), /^ENV NODE_ENV=production$/m,
      'the image must run as production, which is what makes every opt-out inert');
  });

  test('.env.example documents the opt-outs only as comments, never as live settings', () => {
    for (const line of read('.env.example').split('\n')) {
      assert.doesNotMatch(line, /^\s*SINGBOX_(ALLOW_DIRECT|REQUIRE|EGRESS)\s*=/,
        `a live opt-out in .env.example: ${line.trim()}`);
    }
  });
});

describe('the guard is installed before anything can open a socket', () => {
  const server = read('server.js');
  const at = (needle) => server.indexOf(needle);

  test('it is installed from server.js', () => {
    assert.ok(at('installEgressGuard(') > -1);
  });

  test('before the database client, the cache and the supervisor', () => {
    const guard = at('installEgressGuard(');
    // The dynamic-import spellings are assembled, not written out: the repository auditor
    // reads a literal `import('…')` inside a string as a real import and tries to resolve it.
    const dynamicImport = (spec) => `import('${spec}')`;
    const late = ['./lib/supabase.mjs', './lib/cache.mjs', './lib/singbox-supervisor.mjs'].map(dynamicImport);
    for (const needle of [...late, 'new Redis', 'createClient(']) {
      const i = at(needle);
      if (i === -1) continue;
      assert.ok(guard < i, `the guard is installed AFTER ${needle}`);
    }
  });

  test('it is the first thing in the module that can fail closed on env: after the env file, before the first router', () => {
    assert.ok(at('process.loadEnvFile(') < at('installEgressGuard('), 'the allowlist is derived from env, which must be loaded first');
    assert.ok(at('installEgressGuard(') < at('const app = express()'), 'routes were created before the guard existed');
  });

  test('its refusals are reported as security events', () => {
    assert.match(server, /kind:\s*'egress_bypass_blocked'/);
  });

  test('the admin proxy view reports the policy and the guard', () => {
    assert.match(server, /egressGuard:\s*egressGuardStats\(\)/);
    assert.match(server, /singboxEgress:\s*egressStats\(\)/);
  });
});

describe('the one tool the server spawns at boot', () => {
  const tool = code(read('tools/fetch-y8-thumbs.mjs'));
  test('installs its own guard (a child process is not covered by the parent\'s)', () => {
    assert.match(tool, /installEgressGuard\(\)/);
  });
  test('fetches through safeFetch, never a raw fetch()', () => {
    assert.match(tool, /safeFetch\(/);
    assert.doesNotMatch(tool, /(?<![\w.$])fetch\s*\(/);
  });
  test('and server.js waits for the daemon before starting it', () => {
    const s = SRC.get('server.js');
    assert.match(s, /EGRESS_READY\.then\(\(ready\) => \{\s*if \(ready \|\| EGRESS_POLICY\.directAllowed\) kickThumbnailFetch\(\)/);
  });
});

describe('the removed browser left no boot-time probe or reachability check behind', () => {
  test('no file under lib/ still probes a configured companion host or intercepts TLS on its own', () => {
    for (const f of ['lib/tls-interception.mjs', 'lib/kasm-host.mjs', 'lib/proxy-control.mjs', 'lib/wisp-policy.mjs']) {
      assert.ok(!existsSync(join(ROOT, f)), `${f} is part of the removed browser and must not come back`);
    }
  });
});
