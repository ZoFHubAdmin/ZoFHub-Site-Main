// tools/gameflare-verify.mjs — run real-browser verification over candidates.
// ---------------------------------------------------------------------------
//   npm run gameflare:verify -- --limit 9            # verify up to 9 candidates
//   npm run gameflare:verify -- --slug angry-birds   # one specific candidate
//   npm run gameflare:verify -- --concurrency 3
//   npm run gameflare:verify -- --resume             # keep earlier results
//
// Boots the site on a private port, launches Chromium, and drives each candidate
// through the SITE'S OWN player route: click Play, sit through the ad, then look
// for a real game behind it. Results go to data/gameflare-verification.json and
// screenshots to verification-evidence/<slug>/.
//
// Candidates come from the supplied dataset plus the embed URLs recovered by
// `npm run gameflare:embeds`. An embed URL means GameFlare published one; it is
// not a verification, and the two are never conflated.
//
// ── Where this runs ────────────────────────────────────────────────────────
// NOT on the deployed web service. Playwright is a devDependency and render.yaml
// builds with `npm ci --omit=dev`, so Chromium does not exist there — by design;
// a 300 MB browser has no business in a request-serving dyno. This runs from an
// operator machine or CI and writes durable state the server reads.
// ---------------------------------------------------------------------------
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const EVIDENCE_DIR = join(ROOT, 'verification-evidence');
const RESULTS_FILE = join(ROOT, 'data', 'gameflare-verification.json');
const DISCOVERY_FILE = join(ROOT, 'data', 'gameflare-embed-discovery.json');

const argv = process.argv.slice(2);
const arg = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
const has = (n) => argv.includes(`--${n}`);

const LIMIT = Number(arg('limit', process.env.MAX_CANDIDATES_PER_REFRESH || 100));
// Default 1, and that is a CORRECTNESS setting rather than a politeness one.
// Every candidate sits through a real pre-roll video, and parallel contexts
// starve each other's video decode: measured on the same nine candidates, ad
// duration went 32s at 1 → 35-55s at 2 → ~70s at 3, and titles that pass alone
// (sprunki-phase-6) time out or report blank when run alongside others. Raising
// this does not just slow the run down, it manufactures false negatives.
const CONCURRENCY = Math.max(1, Number(arg('concurrency', process.env.VERIFICATION_CONCURRENCY || 1)));
const ONLY_SLUG = arg('slug', '');
const PORT = Number(arg('port', 8171));
const RESUME = has('resume');

const { parseCandidates } = await import('../lib/gameflare-catalog.mjs');
const { verifyCandidate, STATUS, TRANSIENT } = await import('../lib/gameflare-verify.mjs');

let chromium;
try { ({ chromium } = await import('playwright')); }
catch {
  console.error('Playwright is not installed. This job requires it:\n'
    + '  npm install --include=dev\n  npx playwright install chromium');
  process.exit(2);
}

// ── Candidates ─────────────────────────────────────────────────────────────
const dataFile = join(ROOT, 'data', 'gameflare_verified_games.json');
if (!existsSync(dataFile)) { console.error('missing data/gameflare_verified_games.json'); process.exit(2); }

const embedOverlay = new Map();
if (existsSync(DISCOVERY_FILE)) {
  const disc = JSON.parse(readFileSync(DISCOVERY_FILE, 'utf8'));
  for (const r of disc.results || []) {
    if (r.status === 'embed_url_found' && r.embedUrl) embedOverlay.set(r.slug, r.embedUrl);
  }
}

const { candidates, counts } = parseCandidates(readFileSync(dataFile, 'utf8'), { embedOverlay });

let queue = candidates;
if (ONLY_SLUG) {
  const wanted = new Set(ONLY_SLUG.split(',').map(s => s.trim()).filter(Boolean));
  queue = queue.filter(c => wanted.has(c.slug));
}

const prior = RESUME && existsSync(RESULTS_FILE)
  ? JSON.parse(readFileSync(RESULTS_FILE, 'utf8')).results || []
  : [];
const priorBySlug = new Map(prior.map(r => [r.slug, r]));
if (RESUME) queue = queue.filter(c => !priorBySlug.has(c.slug));

queue = queue.slice(0, LIMIT);

console.log(`[verify] candidate pool: ${counts.usable} usable of ${counts.considered} records`
  + ` (${counts.fromOverlay} using a recovered embed URL)`);
console.log(`[verify] ${counts.unusable} record(s) have no usable embed URL and cannot be tested`);
if (RESUME && prior.length) console.log(`[verify] resuming — ${prior.length} earlier result(s) kept`);
console.log(`[verify] testing ${queue.length} candidate(s), concurrency ${CONCURRENCY}`);
if (CONCURRENCY > 1) {
  console.warn(`[verify] WARNING: concurrency ${CONCURRENCY} inflates observed ad duration and produces`
    + ' false negatives — games that pass alone time out alongside others. Use 1 for results you intend to trust.');
}
if (!queue.length) { console.log('[verify] nothing to test — exiting without writing results.'); process.exit(0); }

// ── Boot the site under test ───────────────────────────────────────────────
const VERIFY_TOKEN = randomBytes(24).toString('hex');
const BASE = `http://127.0.0.1:${PORT}`;

console.log(`[verify] starting the site on ${BASE} …`);
const server = spawn(process.execPath, ['server.js'], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), NODE_ENV: 'test', NO_OPEN: '1',
         CRON_DISABLED: '1', GAMEFLARE_VERIFY_TOKEN: VERIFY_TOKEN },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stdout.on('data', () => {});
server.stderr.on('data', () => {});
const shutdown = () => { try { server.kill('SIGKILL'); } catch {} };
process.on('exit', shutdown); process.on('SIGINT', () => { shutdown(); process.exit(130); });

const deadline = Date.now() + 90_000;
let up = false;
while (Date.now() < deadline) {
  try { if ((await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(2000) })).ok) { up = true; break; } }
  catch { /* not yet */ }
  await new Promise(r => setTimeout(r, 500));
}
if (!up) { console.error('[verify] the site did not start'); shutdown(); process.exit(2); }
console.log('[verify] site is up.');

// Prove the preview path works before spending a browser on 100 candidates —
// and prove it is still shut to anyone without the token.
{
  const probe = await fetch(`${BASE}/api/gameflare/games/${queue[0].slug}`,
    { headers: { 'x-gameflare-verify': VERIFY_TOKEN } });
  const body = await probe.json().catch(() => ({}));
  if (!probe.ok || !body?.preview) {
    console.error(`[verify] candidate preview is not working (HTTP ${probe.status}) — aborting rather than `
      + 'reporting failures that are the harness\'s fault.');
    shutdown(); process.exit(2);
  }
  const unauth = await fetch(`${BASE}/api/gameflare/games/${queue[0].slug}`);
  if (unauth.status !== 404) {
    console.error(`[verify] SECURITY: candidate reachable without a token (HTTP ${unauth.status}) — aborting.`);
    shutdown(); process.exit(2);
  }
  console.log('[verify] preview gate confirmed: candidate visible WITH token, 404 without.');
}

// ── Verify ─────────────────────────────────────────────────────────────────
await mkdir(EVIDENCE_DIR, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  args: ['--disable-blink-features=AutomationControlled', '--autoplay-policy=no-user-gesture-required'],
});
console.log(`[verify] Chromium ${browser.version()}\n`);

const timeouts = {
  loadTimeoutMs: Number(process.env.GAME_IFRAME_LOAD_TIMEOUT_MS || 30000),
  adMaxWaitMs: Number(process.env.AD_MAX_WAIT_MS || 45000),
  gameInitTimeoutMs: Number(process.env.GAME_INITIALIZATION_TIMEOUT_MS || 30000),
  interactionTimeoutMs: Number(process.env.GAME_INTERACTION_TIMEOUT_MS || 15000),
};

/**
 * Write the results file. Called after every candidate and once at the end, so
 * the file on disk is always a complete, valid document for whatever has run so
 * far rather than existing only after a clean finish.
 */
async function persist(rows) {
  const all = [...prior.filter(p => !rows.some(r => r.slug === p.slug)), ...rows];
  const passed = all.filter(r => r.status === STATUS.VERIFIED);
  await writeFile(RESULTS_FILE, JSON.stringify({
    generated_at: new Date().toISOString(),
    complete: rows.length >= queue.length,
    browser: 'Chromium',
    browser_version: all[0]?.browserVersion ?? null,
    method: 'site player route → in-frame Play control → ad state machine → game surface → interaction',
    tested: all.length,
    passed: passed.length,
    failed: all.length - passed.length,
    ads_detected: all.filter(r => r.adDetected).length,
    games_after_ads: all.filter(r => r.gameAppearedAfterAd).length,
    interaction_succeeded: all.filter(r => r.interactionSucceeded).length,
    candidate_pool: counts,
    results: all.slice().sort((a, b) => a.slug.localeCompare(b.slug)),
  }, null, 2) + '\n');
  return all;
}

const results = [];
let cursor = 0, done = 0;
async function worker() {
  while (cursor < queue.length) {
    const game = queue[cursor++];
    const opts = { baseUrl: BASE, verifyToken: VERIFY_TOKEN, evidenceDir: EVIDENCE_DIR, timeouts };
    let res = await verifyCandidate(browser, game, opts);

    // Retry ONCE on a transient failure, after a pause.
    //
    // A long pass is not a sequence of independent trials: a earlier run put 20
    // consecutive candidates into not_testable and then recovered on its own,
    // including sprunki-phase-4, which passes reliably in isolation. Whatever
    // that window was — upstream throttling, a stalled browser — it was a
    // property of the moment, not of the games, and without a retry a single bad
    // window silently condemns every title that happens to fall inside it.
    //
    // Only TRANSIENT statuses retry. A new tab or a runtime error is a property
    // of the game and will reproduce, so re-running it just costs 75 seconds.
    if (TRANSIENT.has(res.status)) {
      await new Promise(r => setTimeout(r, 5000));
      const retry = await verifyCandidate(browser, game, opts);
      // The retry supersedes: it is the later and better-informed observation,
      // and `retriedAfter` keeps the first verdict visible in the record so a
      // candidate that needed a second attempt is never mistaken for a clean one.
      retry.retriedAfter = res.status;
      res = retry;
    }
    res.embedUrlSource = game.embedUrlSource ?? null;
    results.push(res);
    done++;
    const mark = res.status === STATUS.VERIFIED ? 'PASS' : 'FAIL';
    const ad = res.adDetected
      ? `ad ${res.adProvider || '?'} ${res.adDurationObservedMs ?? '?'}ms` : 'no ad';
    console.log(`  [${mark}] ${String(done).padStart(3)}/${queue.length} ${game.slug.padEnd(36)}`
      + `${res.status.padEnd(30)} ${ad}`
      // The reason belongs on the line. Without it a run that goes wrong shows
      // a column of identical statuses and says nothing about why.
      + `${res.failureReason ? '  · ' + res.failureReason : ''}`);

    // Persist after EVERY candidate. A full pass is ~75s per game and hours
    // long; writing only at the end means a crash, a timeout or a Ctrl-C throws
    // away the entire run, and there is no way to inspect a run in progress.
    await persist(results);
  }
}
await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));
await browser.close();
shutdown();

// ── Persist ────────────────────────────────────────────────────────────────
const all = await persist(results);
const passed = all.filter(r => r.status === STATUS.VERIFIED);
const withAds = all.filter(r => r.adDetected);
const gameAfterAd = all.filter(r => r.gameAppearedAfterAd);
const interacted = all.filter(r => r.interactionSucceeded);

console.log(`\n[verify] tested ${all.length} · passed ${passed.length} · failed ${all.length - passed.length}`);
console.log(`[verify] ads detected ${withAds.length} · game appeared after ad ${gameAfterAd.length}`
  + ` · interaction succeeded ${interacted.length}`);
const byStatus = {};
for (const r of all) byStatus[r.status] = (byStatus[r.status] || 0) + 1;
console.log('\nby status:');
for (const [k, v] of Object.entries(byStatus).sort((a, b) => b[1] - a[1])) {
  console.log(`   ${String(v).padStart(4)}  ${k}`);
}
const adDurations = withAds.map(r => r.adDurationObservedMs).filter(Number.isFinite);
if (adDurations.length) {
  const avg = Math.round(adDurations.reduce((a, b) => a + b, 0) / adDurations.length);
  console.log(`\nobserved ad duration: min ${Math.min(...adDurations)}ms · avg ${avg}ms · max ${Math.max(...adDurations)}ms`);
}
console.log(`\n[verify] results  → ${RESULTS_FILE.replace(ROOT, '.')}`);
console.log(`[verify] evidence → ${EVIDENCE_DIR.replace(ROOT, '.')}`);
if (!passed.length) console.log('\n[verify] ZERO candidates passed. Nothing is eligible for promotion.');
