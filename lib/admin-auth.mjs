// lib/admin-auth.mjs
// ---------------------------------------------------------------------------
// Administrator authentication: password verification, database-backed
// sessions, brute-force lockout, CSRF tokens, and the audit trail.
//
// ── WHY scrypt AND NOT Argon2id / bcrypt ───────────────────────────────────
// Both of those need a native node-gyp build. This project has NO build step,
// deploys with `npm ci --omit=dev`, and a native module that fails to compile on
// the host is a broken production deploy — a worse outcome than the difference
// between two strong memory-hard KDFs. scrypt is RFC 7914, memory-hard, and
// built into Node, so it costs nothing and cannot fail to install.
//
// The stored hash is VERSIONED (`scrypt$N$r$p$salt$hash`), so moving to Argon2id
// later means adding a branch to verifyPassword() and re-hashing on next login —
// not a migration. If you do want Argon2id, that is the only change needed.
//
// ── WHAT IS AND IS NOT SECRET ──────────────────────────────────────────────
// The session COOKIE holds a 256-bit random token. The database stores only
// sha256(token). A dump of admin_sessions therefore grants nobody a session, for
// the same reason a password table stores hashes. Client IPs are stored only as
// an HMAC keyed by ADMIN_SESSION_SECRET: enough to notice a session moving
// between networks, useless for locating a person, and unusable by anyone who
// does not already hold the secret.
// ---------------------------------------------------------------------------

import {
  randomBytes, scrypt, timingSafeEqual, createHash, createHmac, scryptSync,
} from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt);

// N=2^15 keeps a verify near ~100ms on a small Render instance: slow enough that
// offline cracking is expensive, fast enough that a human login feels instant.
// maxmem must be raised explicitly — Node's 32MB default rejects N this large.
const SCRYPT = { N: 32768, r: 8, p: 1, keylen: 64, maxmem: 128 * 1024 * 1024 };

export const SESSION_COOKIE = 'zh_admin_session';
export const CSRF_COOKIE    = 'zh_admin_csrf';
export const CSRF_HEADER    = 'x-csrf-token';

// Absolute session lifetime, and the shorter idle window. Both are enforced
// server-side on every request; the cookie's own Max-Age is only a hint to the
// browser and is never trusted.
export const SESSION_ABSOLUTE_MS = Number(process.env.ADMIN_SESSION_MAX_MS)  || 8 * 60 * 60 * 1000;  // 8h
export const SESSION_IDLE_MS     = Number(process.env.ADMIN_SESSION_IDLE_MS) || 30 * 60 * 1000;      // 30m

// Lockout: after LOCK_THRESHOLD failures from one IP inside LOCK_WINDOW_MS, that
// IP is refused for LOCK_DURATION_MS regardless of whether the password is right.
export const LOCK_THRESHOLD   = Number(process.env.ADMIN_LOCK_THRESHOLD) || 5;
export const LOCK_WINDOW_MS   = Number(process.env.ADMIN_LOCK_WINDOW_MS) || 15 * 60 * 1000;
export const LOCK_DURATION_MS = Number(process.env.ADMIN_LOCK_MS)        || 15 * 60 * 1000;

// ── Password hashing ───────────────────────────────────────────────────────

/** Produce a versioned hash string for ADMIN_PASSWORD_HASH. */
export async function hashPassword(password) {
  const salt = randomBytes(16);
  const dk = await scryptAsync(String(password), salt, SCRYPT.keylen, SCRYPT);
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p,
          salt.toString('base64'), Buffer.from(dk).toString('base64')].join('$');
}

/** Synchronous variant for the CLI generator. */
export function hashPasswordSync(password) {
  const salt = randomBytes(16);
  const dk = scryptSync(String(password), salt, SCRYPT.keylen, SCRYPT);
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p,
          salt.toString('base64'), dk.toString('base64')].join('$');
}

/**
 * Constant-time password check. Returns false for a malformed or absent hash
 * rather than throwing, so a misconfigured deployment fails CLOSED.
 */
export async function verifyPassword(password, stored) {
  try {
    const s = String(stored || '');
    const parts = s.split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
    const [, N, r, p, saltB64, hashB64] = parts;
    const salt = Buffer.from(saltB64, 'base64');
    const want = Buffer.from(hashB64, 'base64');
    if (!salt.length || !want.length) return false;
    const dk = await scryptAsync(String(password), salt, want.length, {
      N: Number(N), r: Number(r), p: Number(p), maxmem: SCRYPT.maxmem,
    });
    const got = Buffer.from(dk);
    // Lengths are compared first because timingSafeEqual throws on a mismatch;
    // the length of a hash is not a secret.
    return got.length === want.length && timingSafeEqual(got, want);
  } catch {
    return false;
  }
}

// ── Identity helpers ───────────────────────────────────────────────────────

const secret = () => String(process.env.ADMIN_SESSION_SECRET || '');

/** HMAC of a client IP. Never store or log the address itself. */
export function hashIp(ip) {
  const k = secret();
  if (!k) return null;
  return createHmac('sha256', k).update(String(ip || '')).digest('base64url').slice(0, 24);
}

export const hashToken = (t) => createHash('sha256').update(String(t)).digest('hex');

/**
 * Is the admin system configured well enough to allow a login at all?
 * Missing or weak configuration means NO login, never a weaker one.
 */
export function adminConfigStatus() {
  const username = String(process.env.ADMIN_USERNAME || '').trim();
  const hash     = String(process.env.ADMIN_PASSWORD_HASH || '').trim();
  const sess     = secret();
  const problems = [];
  if (!username) problems.push('ADMIN_USERNAME is not set');
  if (!hash) problems.push('ADMIN_PASSWORD_HASH is not set');
  else if (!/^scrypt\$/.test(hash)) problems.push('ADMIN_PASSWORD_HASH is not a recognised hash (run: npm run admin-hash)');
  if (!sess) problems.push('ADMIN_SESSION_SECRET is not set');
  else if (sess.length < 32) problems.push('ADMIN_SESSION_SECRET is shorter than 32 characters');
  return { ok: problems.length === 0, problems };
}

// ── Cookies ────────────────────────────────────────────────────────────────
// Written by hand rather than pulling in cookie-parser: this app had no cookies
// at all before the admin console, and one small parser is cheaper than a
// dependency plus its transitive tree.

export function parseCookies(header) {
  const out = Object.create(null);           // null prototype: a cookie named
  if (!header) return out;                   // `constructor` must not read back
  for (const part of String(header).split(';')) {  // as a function
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k) continue;
    try { out[k] = decodeURIComponent(part.slice(i + 1).trim()); }
    catch { out[k] = part.slice(i + 1).trim(); }
  }
  return out;
}

function serializeCookie(name, value, { maxAgeMs, httpOnly = true, secure, sameSite = 'Strict' } = {}) {
  const bits = [`${name}=${encodeURIComponent(value)}`, 'Path=/', `SameSite=${sameSite}`];
  if (httpOnly) bits.push('HttpOnly');
  if (secure) bits.push('Secure');
  bits.push(`Max-Age=${Math.max(0, Math.floor((maxAgeMs ?? 0) / 1000))}`);
  return bits.join('; ');
}

/** Secure only in production: a localhost dev session over http must still work. */
const isSecureEnv = () => process.env.NODE_ENV === 'production';

export function setSessionCookies(res, { token, csrf }) {
  res.append('Set-Cookie', serializeCookie(SESSION_COOKIE, token, {
    maxAgeMs: SESSION_ABSOLUTE_MS, httpOnly: true, secure: isSecureEnv(),
  }));
  // The CSRF cookie is deliberately NOT HttpOnly — the double-submit pattern
  // requires the page's own JavaScript to read it and echo it in a header.
  // Being readable is safe: it is not a credential on its own, and SameSite
  // plus the session cookie are what actually authenticate.
  res.append('Set-Cookie', serializeCookie(CSRF_COOKIE, csrf, {
    maxAgeMs: SESSION_ABSOLUTE_MS, httpOnly: false, secure: isSecureEnv(),
  }));
}

export function clearSessionCookies(res) {
  for (const n of [SESSION_COOKIE, CSRF_COOKIE]) {
    res.append('Set-Cookie', serializeCookie(n, '', { maxAgeMs: 0, httpOnly: n === SESSION_COOKIE, secure: isSecureEnv() }));
  }
}

export const newToken = () => randomBytes(32).toString('base64url');

// ── Storage ────────────────────────────────────────────────────────────────
// Every function takes the caller's Supabase ADMIN client. If it is null the
// operation fails closed: no session is issued, no login succeeds.

export async function recordLoginAttempt(supa, { username, ok, ipHash, userAgent, reason }) {
  if (!supa) return;
  try {
    await supa.from('admin_login_attempts').insert({
      username: username ? String(username).slice(0, 120) : null,
      ok: !!ok, ip_hash: ipHash, user_agent: String(userAgent || '').slice(0, 300), reason,
    });
  } catch { /* never let telemetry break the request */ }
}

export async function securityEvent(supa, { kind, severity = 'info', username, ipHash, detail }) {
  if (!supa) return;
  try {
    await supa.from('admin_security_events').insert({
      kind, severity, username: username || null, ip_hash: ipHash || null, detail: detail || null,
    });
  } catch { /* ditto */ }
}

export async function audit(supa, { username, action, target, outcome, ipHash, userAgent, detail }) {
  if (!supa) return;
  try {
    await supa.from('admin_audit_logs').insert({
      username: username || null, action, target: target ? String(target).slice(0, 200) : null,
      outcome, ip_hash: ipHash || null, user_agent: String(userAgent || '').slice(0, 300),
      detail: detail || null,
    });
  } catch { /* ditto */ }
}

/**
 * Lockout check, by IP. Counts only FAILURES in the window: a successful login
 * does not clear the counter, because an attacker who finally guesses right
 * should not thereby erase the evidence — the window simply ages out.
 */
export async function isLockedOut(supa, ipHash) {
  if (!supa || !ipHash) return { locked: false, failures: 0 };
  try {
    const since = new Date(Date.now() - LOCK_WINDOW_MS).toISOString();
    const { data, error } = await supa.from('admin_login_attempts')
      .select('at').eq('ip_hash', ipHash).eq('ok', false).gte('at', since)
      .order('at', { ascending: false }).limit(LOCK_THRESHOLD + 1);
    if (error) return { locked: false, failures: 0 };
    const failures = data?.length || 0;
    if (failures < LOCK_THRESHOLD) return { locked: false, failures };
    const newest = new Date(data[0].at).getTime();
    const until = newest + LOCK_DURATION_MS;
    return until > Date.now()
      ? { locked: true, failures, retryAfterSec: Math.ceil((until - Date.now()) / 1000) }
      : { locked: false, failures };
  } catch {
    // A database failure must not become a way to switch lockout OFF.
    return { locked: true, failures: 0, retryAfterSec: 30 };
  }
}

export async function createSession(supa, { username, ipHash, userAgent }) {
  if (!supa) return null;
  const token = newToken();
  const csrf  = newToken();
  const now = Date.now();
  const { error } = await supa.from('admin_sessions').insert({
    token_hash: hashToken(token),
    username,
    ip_hash: ipHash,
    user_agent: String(userAgent || '').slice(0, 300),
    expires_at: new Date(now + SESSION_ABSOLUTE_MS).toISOString(),
  });
  if (error) return null;
  return { token, csrf };
}

/**
 * Validate a cookie token. Enforces revocation, absolute expiry and idle
 * timeout server-side, and flags a session whose IP or user agent changed.
 * Returns null for anything that is not a live session.
 */
export async function validateSession(supa, token, { ipHash, userAgent } = {}) {
  if (!supa || !token) return null;
  let row;
  try {
    const { data, error } = await supa.from('admin_sessions')
      .select('*').eq('token_hash', hashToken(token)).limit(1).maybeSingle();
    if (error || !data) return null;
    row = data;
  } catch { return null; }

  const now = Date.now();
  if (row.revoked_at) return null;
  if (new Date(row.expires_at).getTime() <= now) return null;
  if (now - new Date(row.last_seen_at).getTime() > SESSION_IDLE_MS) {
    // Idle out rather than silently extending — and revoke, so the same cookie
    // cannot be replayed later.
    try {
      await supa.from('admin_sessions')
        .update({ revoked_at: new Date().toISOString(), revoked_reason: 'idle_timeout' })
        .eq('id', row.id);
    } catch {}
    return null;
  }

  // Context drift. Not fatal on its own — mobile networks change addresses
  // constantly — but a user-agent change on a live session is not something a
  // real browser does, so that one forces re-authentication.
  const ipChanged = !!(row.ip_hash && ipHash && row.ip_hash !== ipHash);
  const uaChanged = !!(row.user_agent && userAgent && row.user_agent !== String(userAgent).slice(0, 300));
  if (uaChanged) {
    try {
      await supa.from('admin_sessions')
        .update({ revoked_at: new Date().toISOString(), revoked_reason: 'user_agent_change' })
        .eq('id', row.id);
    } catch {}
    await securityEvent(supa, {
      kind: 'session_user_agent_change', severity: 'critical',
      username: row.username, ipHash, detail: { session: row.id },
    });
    return null;
  }
  if (ipChanged) {
    await securityEvent(supa, {
      kind: 'session_ip_change', severity: 'warn',
      username: row.username, ipHash, detail: { session: row.id },
    });
  }

  try {
    await supa.from('admin_sessions')
      .update({ last_seen_at: new Date().toISOString(), ...(ipChanged ? { ip_hash: ipHash } : {}) })
      .eq('id', row.id);
  } catch {}

  return { id: row.id, username: row.username, ipChanged, createdAt: row.created_at, expiresAt: row.expires_at };
}

export async function revokeSession(supa, token, reason = 'logout') {
  if (!supa || !token) return;
  try {
    await supa.from('admin_sessions')
      .update({ revoked_at: new Date().toISOString(), revoked_reason: reason })
      .eq('token_hash', hashToken(token));
  } catch {}
}

export async function revokeAllSessions(supa, username, reason = 'revoke_all') {
  if (!supa) return 0;
  try {
    const { data } = await supa.from('admin_sessions')
      .update({ revoked_at: new Date().toISOString(), revoked_reason: reason })
      .eq('username', username).is('revoked_at', null).select('id');
    return data?.length || 0;
  } catch { return 0; }
}

export async function listSessions(supa, username, limit = 20) {
  if (!supa) return [];
  try {
    const { data } = await supa.from('admin_sessions')
      .select('id, ip_hash, user_agent, created_at, last_seen_at, expires_at, revoked_at, revoked_reason')
      .eq('username', username).order('created_at', { ascending: false }).limit(limit);
    return data || [];
  } catch { return []; }
}

// ── CSRF ───────────────────────────────────────────────────────────────────

/**
 * Double-submit check for state-changing admin requests, plus origin validation.
 *
 * SameSite=Strict already stops a cross-site form from carrying the session
 * cookie, so this is the second layer rather than the only one: it also covers
 * the case of an attacker who can inject a same-site request but cannot read
 * the CSRF cookie value.
 */
export function csrfOk(req) {
  const cookies = parseCookies(req.headers?.cookie);
  const fromCookie = cookies[CSRF_COOKIE];
  const fromHeader = req.get?.(CSRF_HEADER) || req.headers?.[CSRF_HEADER];
  if (!fromCookie || !fromHeader) return false;
  const a = Buffer.from(String(fromCookie));
  const b = Buffer.from(String(fromHeader));
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Reject a state-changing request whose Origin is not this site. */
export function originOk(req) {
  const origin = req.get?.('origin');
  if (!origin) return true;                 // same-origin fetches may omit it
  try {
    const o = new URL(origin);
    const host = req.get('x-forwarded-host') || req.get('host') || '';
    return o.host === String(host).split(',')[0].trim();
  } catch { return false; }
}

/**
 * Read username + password out of a request body as STRINGS ONLY.
 *
 * REGRESSION: the login route used `String(req.body?.username)`, and
 * `String(["admin"])` is `"admin"` — so `{"username":["admin"],"password":"…"}`
 * coerced straight onto the real username and authenticated. The neighbouring
 * `{"$ne":null}` shape failed for a reason that was pure luck: `String({})`
 * happens to be `"[object Object]"`.
 *
 * Anything that is not a string becomes '' rather than throwing, so a malformed
 * body still travels the normal wrong-password path — lockout counter,
 * progressive delay, one generic 401 — instead of becoming a cheaper oracle.
 */
export function coerceCredentials(body) {
  const u = body?.username;
  const p = body?.password;
  return {
    username: typeof u === 'string' ? u.slice(0, 120) : '',
    password: typeof p === 'string' ? p.slice(0, 512) : '',
    wellFormed: typeof u === 'string' && typeof p === 'string',
  };
}

/**
 * Parse a database row id from a URL parameter, or null if it is not one.
 *
 * REGRESSION: `parseInt(id, 10)` + `Number.isFinite()` accepted
 * "99999999999999999999" as 1e20 and "12abc" as 12. The first reached Postgres
 * as an out-of-range bigint and came back to the caller as a 500 — an
 * unhandled database error where the answer was simply "that is not an id".
 * isSafeInteger is the range the column can actually store.
 */
export function parseRowId(value) {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  }
  if (typeof value !== 'string') return null;
  // Decimal digits and nothing else. Number() alone would also accept "0x10"
  // (16), "0b101", "1e3", "+12" and " 12 " — none of which a database ever
  // produces, all of which give the same row two or more spellings in the audit
  // log. An id parser should accept exactly the shape the column emits.
  if (!/^\d+$/.test(value)) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}
