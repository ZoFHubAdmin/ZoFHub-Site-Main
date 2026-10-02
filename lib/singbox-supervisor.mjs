// lib/singbox-supervisor.mjs — ZoFHub owns the sing-box process lifecycle.
// ---------------------------------------------------------------------------
// sing-box (github.com/SagerNet/sing-box) is GPL-3.0 and is a SEPARATE program.
// Its source is not vendored here; the Dockerfile builds a pinned, unmodified
// upstream release into the image. This module spawns that binary as a child
// process, watches it, and stops it — the same relationship an init system has
// with a daemon. Running a program is not deriving from it, so ZoFHub's own
// license is unaffected. ZoFHub is not affiliated with or endorsed by its
// authors.
//
// ── ON BY DEFAULT, AND FAILS SOFT ──────────────────────────────────────────
// The standard deploy BUILDS sing-box (Dockerfile SINGBOX_VERSION defaults to a
// pinned release) and supervises it (SINGBOX_MANAGED defaults to on), because
// it now carries the proxy's egress rather than sitting beside it.
//
// That default is only defensible because every failure here is contained. A
// missing binary, an unparseable template, a config the daemon rejects, or a
// crash loop must all leave ZoFHub serving games — the proxy degrades to direct
// egress and reports that it did (lib/singbox-socket.mjs). Nothing in this file
// is allowed to take the web server down, and a cause that cannot fix itself
// (an absent binary) stops retrying instead of looping forever.
//
// ── WHY `sing-box check` RUNS BEFORE EVERY START ───────────────────────────
// A proxy daemon started with a bad config exits immediately. Supervised
// naively, that is a hot restart loop: hundreds of spawns a second, a filled
// disk from logs, and a CPU pinned at 100%. Validating first turns "crash loop"
// into one clear error message, which is the difference between an outage and a
// typo.

import { spawn, execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';

/**
 * Which binary to run, resolved per call rather than captured at import.
 *
 * It used to be a module constant read from process.env, which quietly made the
 * `env` parameter on startSingbox() a lie: the caller's env chose whether to
 * start, and process.env chose what to execute. Harmless in production, where
 * both are the same object, but it meant none of this could be tested against
 * a fake environment — and an untested supervisor is the thing most likely to
 * be wrong when it finally matters.
 */
const binFor = (env = process.env) => String(env.SINGBOX_BIN || '').trim() || 'sing-box';
// Where the rendered config is written. Deliberately NOT inside the repo: it
// contains a private key and an API secret after substitution.
const RUNTIME_CONFIG = process.env.SINGBOX_CONFIG_PATH || '/tmp/zofhub-singbox/config.json';

const truthy = (v) => /^(1|true|yes|on)$/i.test(String(v ?? '').trim());

/**
 * Managed mode is ON by default and must be switched OFF explicitly.
 *
 * The default flipped deliberately: sing-box now carries the proxy's egress
 * (lib/singbox-socket.mjs), so "off unless configured" would have meant the
 * documented traffic path was the one nobody ran. Everything downstream of this
 * still fails soft — a missing binary degrades to direct egress, it does not
 * take the site down — which is what makes an on-by-default safe to ship.
 */
export const singboxManaged = (env = process.env) =>
  !/^(0|false|no|off)$/i.test(String(env.SINGBOX_MANAGED ?? '1').trim());

/**
 * Make the deploy zero-config.
 *
 * The rendered config needs a management-API secret, and renderConfig refuses
 * to emit a config with an unsubstituted placeholder. Requiring the operator to
 * invent one would make "on by default" a lie — the daemon would refuse to
 * start on every fresh deploy. So one is generated here when absent and written
 * back into the environment, which is also how lib/singbox.mjs picks up the
 * SAME value: a secret that only one side knows authenticates nobody.
 *
 * Loopback-only exposure means the secret is defence in depth rather than the
 * primary control, but a random one still beats an empty string, which some
 * Clash clients treat as "no auth required".
 */
export function ensureApiSecret(env = process.env) {
  if (!String(env.SINGBOX_API_SECRET || '').trim()) {
    env.SINGBOX_API_SECRET = randomBytes(24).toString('base64url');
  }
  // Point the read-only adapter at the daemon we are about to start, unless the
  // operator aimed it somewhere else on purpose.
  if (!String(env.SINGBOX_API_URL || '').trim()) {
    env.SINGBOX_API_URL = 'http://127.0.0.1:9090';
  }
  return env.SINGBOX_API_SECRET;
}

// ── State ──────────────────────────────────────────────────────────────────
// One child at a time. `desired` records whether we WANT it running, so an exit
// can tell a crash (restart) from a deliberate stop (do not restart).
const state = {
  child: null,
  desired: false,
  startedAt: 0,
  restarts: 0,
  lastExit: null,      // { code, signal, at }
  lastError: null,     // human-readable, never contains a secret
  backoffMs: 0,
  timer: null,
  gaveUp: null,        // set when retrying cannot help (e.g. binary absent)
  env: null,           // the environment startSingbox was called with
};

// Crash-restart backoff. Doubles to a ceiling so a persistently broken daemon
// costs one spawn a minute rather than a pinned core.
const BACKOFF_MIN = 1000;
const BACKOFF_MAX = 60_000;

// Recent output, bounded. An unbounded log buffer on a chatty daemon is a slow
// memory leak, and this process already has a 85%-memory health check that
// would start returning 503 because of it.
const LOG_MAX = 200;
const logs = [];
function log(line) {
  const s = String(line).trimEnd();
  if (!s) return;
  logs.push({ at: new Date().toISOString(), line: s.slice(0, 500) });
  if (logs.length > LOG_MAX) logs.splice(0, logs.length - LOG_MAX);
}

// ── Config rendering ───────────────────────────────────────────────────────

/** Strip the `$comment` documentation keys the template carries. */
function stripComments(node) {
  if (Array.isArray(node)) return node.map(stripComments);
  if (node && typeof node === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(node)) {
      if (k === '$comment') continue;
      out[k] = stripComments(v);
    }
    return out;
  }
  return node;
}

/**
 * Render the shipped template into a runnable config.
 *
 * Substitutes ${VAR} from the environment and then REFUSES anything left over:
 * an unsubstituted placeholder would be handed to the daemon as a literal
 * "${SINGBOX_UUID_OWNER}", which it accepts as a uuid and then silently fails
 * to authenticate anyone against.
 *
 * @returns {{ ok: true, path: string } | { ok: false, error: string }}
 */
export function renderConfig(env = process.env, templatePath) {
  const tpl = templatePath
    || env.SINGBOX_CONFIG_TEMPLATE
    || join(dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')),
            '..', 'deploy', 'singbox', 'config.template.json');
  let raw;
  try { raw = readFileSync(tpl, 'utf8'); }
  catch { return { ok: false, error: `config template not readable: ${tpl}` }; }

  let parsed;
  try { parsed = JSON.parse(raw); }
  catch (e) { return { ok: false, error: `config template is not valid JSON: ${e.message}` }; }

  let text = JSON.stringify(stripComments(parsed), null, 2);
  text = text.replace(/\$\{([A-Z0-9_]+)\}/g, (_m, name) => {
    const v = env[name];
    return (v === undefined || v === '') ? `\${${name}}` : String(v);
  });

  const missing = [...new Set([...text.matchAll(/\$\{([A-Z0-9_]+)\}/g)].map(m => m[1]))];
  if (missing.length) {
    return { ok: false, error: `config is missing required values: ${missing.join(', ')}` };
  }

  const out = env.SINGBOX_CONFIG_PATH || RUNTIME_CONFIG;
  try {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, text, { mode: 0o600 });
    // Re-assert: writeFileSync's mode is ignored when the file already exists.
    // This file holds a REALITY private key and the management API secret.
    chmodSync(out, 0o600);
  } catch (e) {
    return { ok: false, error: `could not write config: ${e.message}` };
  }
  return { ok: true, path: out };
}

/**
 * `sing-box check -c <path>`. Resolves {ok, error} — never rejects.
 *
 * The try/catch is load-bearing, not defensive padding: execFile can throw
 * SYNCHRONOUSLY, before any callback, when the OS refuses the spawn outright
 * (EINVAL, EACCES, and on Windows any non-.exe target). Such a throw escapes
 * the Promise executor entirely and propagates to the caller — which defeats
 * the whole point of this function, since a supervisor whose validation step
 * can throw is a supervisor that dies instead of backing off.
 */
export function checkConfig(path, env = process.env) {
  const BIN = binFor(env);
  return new Promise((resolve) => {
    try {
      execFile(BIN, ['check', '-c', path], { timeout: 10_000 }, (err, stdout, stderr) => {
        if (!err) return resolve({ ok: true });
        // A MISSING BINARY IS NOT A BAD CONFIG. Both arrive here as an error,
        // but they need opposite handling: a rejected config may be fixed by a
        // redeploy and is worth retrying, while an absent binary will never
        // appear on its own and retrying it forever buries real errors under a
        // 60-second log loop. Reporting them as one thing also produced the
        // actively misleading "config rejected: spawn sing-box ENOENT".
        if (err.code === 'ENOENT') {
          return resolve({ ok: false, missingBinary: true, error: `${BIN} not found on PATH` });
        }
        const detail = String(stderr || stdout || err.message).trim().slice(0, 400);
        resolve({ ok: false, error: detail || 'sing-box check failed' });
      });
    } catch (e) {
      // Synchronous refusal (EINVAL/EACCES, or any non-.exe target on Windows).
      const missingBinary = e.code === 'ENOENT';
      resolve({ ok: false, missingBinary, error: `cannot run ${BIN}: ${e.code || e.message}` });
    }
  });
}

// ── Lifecycle ──────────────────────────────────────────────────────────────

/**
 * Stop trying, permanently, for a cause that cannot resolve itself.
 *
 * Distinct from stopSingbox(): this is not an operator decision, so the reason
 * is kept for the admin panel. The site keeps serving — egress falls back to
 * direct and says so in /api/admin/proxy.
 */
function giveUp(reason) {
  state.desired = false;
  state.gaveUp = reason;
  clearTimeout(state.timer);
  log(`[supervisor] giving up: ${reason} (egress falls back to direct)`);
}

function scheduleRestart() {
  if (!state.desired) return;
  state.backoffMs = state.backoffMs
    ? Math.min(state.backoffMs * 2, BACKOFF_MAX)
    : BACKOFF_MIN;
  log(`[supervisor] restarting in ${state.backoffMs}ms`);
  clearTimeout(state.timer);
  state.timer = setTimeout(() => { spawnChild().catch(() => {}); }, state.backoffMs);
  // unref so a pending restart cannot hold the process open during shutdown.
  state.timer.unref?.();
}

async function spawnChild() {
  if (!state.desired || state.child) return;
  const env = state.env || process.env;
  const BIN = binFor(env);

  const rendered = renderConfig(env);
  if (!rendered.ok) {
    state.lastError = rendered.error;
    log(`[supervisor] ${rendered.error}`);
    return scheduleRestart();          // config may be fixed by a redeploy
  }

  // checkConfig is contracted never to reject, but this is the one call whose
  // failure would take the supervisor down rather than back it off, so the
  // contract is enforced here too rather than trusted.
  const checked = await checkConfig(rendered.path, env).catch((e) => ({
    ok: false, error: `check failed: ${e?.message || e}`,
  }));
  if (!checked.ok) {
    if (checked.missingBinary) {
      // Nothing to retry: the image simply does not carry the binary (the
      // normal case for a non-Docker deploy). Say so once, in those words.
      state.lastError = `sing-box binary not available (${checked.error})`;
      return giveUp('binary not found');
    }
    // The whole reason this step exists: refuse to start rather than crash-loop.
    state.lastError = `config rejected: ${checked.error}`;
    log(`[supervisor] ${state.lastError}`);
    return scheduleRestart();
  }

  let child;
  try {
    child = spawn(BIN, ['run', '-c', rendered.path], {
      stdio: ['ignore', 'pipe', 'pipe'],
      // Detached would survive our own death; we want it to die with us.
      detached: false,
    });
  } catch (e) {
    state.lastError = `spawn failed: ${e.message}`;
    log(`[supervisor] ${state.lastError}`);
    if (e.code === 'ENOENT') return giveUp('binary not found');
    return scheduleRestart();
  }

  state.child = child;
  state.startedAt = Date.now();
  state.lastError = null;
  log(`[supervisor] started (pid ${child.pid})`);

  child.stdout?.on('data', (b) => log(b.toString()));
  child.stderr?.on('data', (b) => log(b.toString()));
  child.on('error', (e) => {
    state.lastError = e.message;
    log(`[supervisor] ${e.message}`);
    // ENOENT arrives here, not as a throw, on most platforms. Retrying it is
    // pointless — the binary will not appear without a redeploy — and a
    // 60s-forever loop would bury real errors in the log.
    if (e.code === 'ENOENT') giveUp('binary not found');
  });

  child.on('exit', (code, signal) => {
    state.child = null;
    state.lastExit = { code, signal, at: new Date().toISOString() };
    log(`[supervisor] exited code=${code} signal=${signal}`);
    if (!state.desired) return;                      // deliberate stop
    state.restarts++;
    // A run that lasted a while was healthy; reset the backoff so one crash
    // after an hour is not punished with a 60-second wait.
    if (Date.now() - state.startedAt > 60_000) state.backoffMs = 0;
    scheduleRestart();
  });
}

/**
 * Start supervising. Safe to call when unconfigured — it simply does nothing.
 * Never throws and never blocks boot.
 */
export async function startSingbox(env = process.env) {
  if (!singboxManaged(env)) return { started: false, reason: 'not-managed' };
  if (state.desired) return { started: true, reason: 'already-running' };
  ensureApiSecret(env);
  // Remember WHICH environment this supervisor was started with, so a restart
  // minutes later renders and executes the same thing the first start did.
  state.env = env;
  state.gaveUp = null;
  state.desired = true;
  state.backoffMs = 0;
  await spawnChild();
  return { started: Boolean(state.child), reason: state.lastError || 'ok' };
}

/**
 * Stop the daemon and stay stopped.
 *
 * SIGTERM first, SIGKILL after a grace period. Without the escalation a daemon
 * that ignores SIGTERM keeps the container alive until the platform SIGKILLs
 * the whole thing — which is the ungraceful restart the health check exists to
 * avoid.
 */
export function stopSingbox({ graceMs = 5000 } = {}) {
  state.desired = false;
  clearTimeout(state.timer);
  const child = state.child;
  if (!child) return Promise.resolve({ stopped: true, reason: 'not-running' });

  return new Promise((resolve) => {
    let done = false;
    const finish = (reason) => { if (!done) { done = true; clearTimeout(t); resolve({ stopped: true, reason }); } };
    child.once('exit', () => finish('exited'));
    try { child.kill('SIGTERM'); } catch { return finish('already-gone'); }
    const t = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      finish('killed');
    }, graceMs);
    t.unref?.();
  });
}

/** Operational state for the admin panel. Carries no secret and no config. */
export function singboxProcessStatus(env = process.env) {
  return {
    managed: singboxManaged(env),
    binary: binFor(env),
    binaryPresent: binaryPresent(env),
    running: Boolean(state.child),
    pid: state.child?.pid ?? null,
    uptimeSec: state.child ? Math.round((Date.now() - state.startedAt) / 1000) : 0,
    restarts: state.restarts,
    lastExit: state.lastExit,
    lastError: state.lastError,
    gaveUp: state.gaveUp,
    // Tail only. The full buffer is bounded at LOG_MAX but is still more than a
    // dashboard should carry on every poll.
    recentLogs: logs.slice(-20),
  };
}

/**
 * Is the binary actually installed?
 *
 * An absolute path is checked on disk; a bare name (the default) means "resolve
 * via PATH", which cannot be answered synchronously — reported as null, i.e.
 * "unknown", rather than a false "missing" that would read as a broken deploy.
 */
function binaryPresent(env = process.env) {
  const BIN = binFor(env);
  if (BIN.includes('/') || BIN.includes('\\')) {
    try { return existsSync(BIN); } catch { return false; }
  }
  return null;
}

export default {
  singboxManaged, renderConfig, checkConfig, ensureApiSecret,
  startSingbox, stopSingbox, singboxProcessStatus,
};
