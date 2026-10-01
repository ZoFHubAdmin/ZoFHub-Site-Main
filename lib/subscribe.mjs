// ============================================================================
// subscribe.mjs — email validation for the mirror-update list.
//
// The homepage promises "no accounts, zero tracking", and db/14_subscriber_emails.sql
// keeps that promise structurally: two columns, no IP, no timestamp. This file
// holds the only other thing worth getting right — deciding what counts as an
// address — kept pure so it can be tested without a database or a mail provider.
//
// DELIBERATELY NOT RFC 5322. A full grammar accepts things no mail server will
// deliver to and is a reliable source of catastrophic-backtracking regexes. The
// job here is to reject obvious rubbish and typos cheaply and never hang; the
// only real proof an address works is mail arriving at it.
// ============================================================================

export const EMAIL_MIN = 6;
export const EMAIL_MAX = 254;        // RFC 5321 practical maximum, matches the CHECK in SQL

/**
 * Normalise for storage and comparison.
 *
 * Lower-cased because the unique index is on lower(email): treating
 * Foo@x.com and foo@x.com as two subscribers would mail the same person twice.
 * Anything that is not a string becomes '' rather than throwing, so a junk body
 * travels the ordinary rejection path instead of a cheaper one.
 */
export function normalizeEmail(value) {
  if (typeof value !== 'string') return '';
  return value.trim().toLowerCase();
}

/**
 * Is this plausibly a deliverable address?
 *
 * Linear-time by construction: each part is checked with bounded character
 * classes and no nested quantifier, so a hostile 254-character input cannot
 * turn this into a CPU denial of service.
 */
export function isPlausibleEmail(value) {
  const s = normalizeEmail(value);
  if (s.length < EMAIL_MIN || s.length > EMAIL_MAX) return false;
  if (/\s/.test(s)) return false;

  const at = s.indexOf('@');
  if (at < 1 || at !== s.lastIndexOf('@')) return false;   // exactly one @, not leading

  const local = s.slice(0, at);
  const domain = s.slice(at + 1);
  if (!local || local.length > 64) return false;
  if (!domain || domain.length > 253) return false;

  // Local part: printable, no leading/trailing dot, no doubled dot.
  if (!/^[a-z0-9!#$%&'*+/=?^_`{|}~.-]+$/.test(local)) return false;
  if (local.startsWith('.') || local.endsWith('.') || local.includes('..')) return false;

  // Domain: dot-separated labels, at least two, TLD alphabetic.
  const labels = domain.split('.');
  if (labels.length < 2) return false;
  for (const label of labels) {
    if (!label || label.length > 63) return false;
    if (!/^[a-z0-9-]+$/.test(label)) return false;
    if (label.startsWith('-') || label.endsWith('-')) return false;
  }
  if (!/^[a-z]{2,}$/.test(labels[labels.length - 1])) return false;

  return true;
}
