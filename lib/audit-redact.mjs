// lib/audit-redact.mjs — what an audit record is allowed to contain.
// ---------------------------------------------------------------------------
// The audit trail is append-only and kept for at least a year (db/admin.sql,
// db/schema-hardening.sql). That is exactly why nothing sensitive may reach it:
// a secret written there cannot be deleted by anyone, so the only defence is to
// never write it.
//
// Two layers, because either alone fails:
//
//   KEY-BASED   a field named password / token / secret / authorization / cookie
//               / key / hash is replaced wholesale, whatever its value looks like.
//
//   VALUE-BASED a string that LOOKS like a credential is replaced wherever it
//               appears — a JWT, a Supabase sb_secret_ key, a bearer header, a
//               PEM block, an scrypt hash, a long random token. This catches the
//               secret that arrives under an innocent key such as `note`.
//
// It also bounds size: an audit row describes an action, it is not a place to
// archive a request body. Deep objects are truncated, long strings clipped.
// Pure and dependency-free; lib/admin-api.mjs routes every `detail` through it.
// ---------------------------------------------------------------------------

const SECRET_KEY_RE = /pass(word)?|secret|token|authori[sz]ation|cookie|api[-_]?key|private[-_]?key|^key$|_key$|hash|credential|session[-_]?id|csrf/i;

// Values that are credentials no matter where they appear.
const SECRET_VALUE_RES = [
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/,       // JWT
  /\bsb_(secret|publishable)_[A-Za-z0-9_-]{10,}/,                        // Supabase keys
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/i,                                // Authorization value
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,                                  // PEM
  /\bscrypt\$\d+\$\d+\$\d+\$/,                                           // our password hashes
  /\b(sk|pk|rk)_(live|test)_[A-Za-z0-9]{10,}/,                           // common API key shapes
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,                                        // GitHub tokens
];

export const REDACTED = '[redacted]';
const MAX_DEPTH = 4;
const MAX_STRING = 500;
const MAX_KEYS = 40;
const MAX_ARRAY = 25;

/** Does this string look like a credential? */
export function looksSecret(v) {
  if (typeof v !== 'string') return false;
  return SECRET_VALUE_RES.some((re) => re.test(v));
}

/**
 * Return a copy of `value` that is safe to write to the audit trail.
 * Never throws; a value it cannot represent becomes a short marker.
 */
export function redact(value, depth = 0) {
  if (value === null || value === undefined) return value ?? null;
  if (typeof value === 'string') {
    if (looksSecret(value)) return REDACTED;
    return value.length > MAX_STRING ? value.slice(0, MAX_STRING) + '…' : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return String(value);
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (depth >= MAX_DEPTH) return '[truncated]';
  if (Array.isArray(value)) {
    const out = value.slice(0, MAX_ARRAY).map((v) => redact(v, depth + 1));
    if (value.length > MAX_ARRAY) out.push(`[+${value.length - MAX_ARRAY} more]`);
    return out;
  }
  if (typeof value === 'object') {
    const out = {};
    let n = 0;
    for (const k of Object.keys(value)) {
      if (n++ >= MAX_KEYS) { out['…'] = `[+${Object.keys(value).length - MAX_KEYS} keys]`; break; }
      out[k] = SECRET_KEY_RE.test(k) ? REDACTED : redact(value[k], depth + 1);
    }
    return out;
  }
  return `[${typeof value}]`;
}

/**
 * Before/after for the fields that changed, restricted to `fields`.
 *
 * An allowlist rather than "everything that differs": a diff over a whole row
 * would faithfully record a password hash change as two hash values. Only the
 * fields a caller names are compared, and both sides still go through redact().
 */
export function diffFields(before, after, fields) {
  const changes = {};
  for (const f of fields) {
    const a = before ? before[f] : undefined;
    const b = after ? after[f] : undefined;
    if (JSON.stringify(a ?? null) !== JSON.stringify(b ?? null)) {
      changes[f] = { from: redact(a ?? null), to: redact(b ?? null) };
    }
  }
  return changes;
}

export default { redact, looksSecret, diffFields, REDACTED };
