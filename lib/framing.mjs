// ============================================================================
// framing.mjs — can this URL actually render inside our iframe?
//
// WHY THIS EXISTS AS ITS OWN MODULE. Two crawlers ask this question and only
// one of them used to. lib/cron-jobs.mjs (the GROW job) checked framing headers
// before promoting a game; lib/link-checker.mjs (the hourly health sweep) did
// not — it marked a row healthy on `status >= 200 && status < 400` alone. So a
// game that starts sending `X-Frame-Options: DENY` keeps its 200 OK, stays
// is_working=true, and black-screens every visitor who clicks it. The catalog
// says healthy; the player sees nothing. Both crawlers now share this file, so
// the rule cannot drift between them again.
//
// THE HONEST LIMIT. Headers are necessary, not sufficient. A page can also
// frame-bust in JavaScript, or render an empty canvas, and no header check sees
// that. This answers exactly one question — "will the browser refuse to frame
// it?" — and the verdict says which header decided, so a false positive can be
// argued with rather than guessed at.
// ============================================================================

export const FRAMING = {
  OK: 'ok',
  XFO_DENY: 'x_frame_options_deny',
  XFO_SAMEORIGIN: 'x_frame_options_sameorigin',
  XFO_ALLOW_FROM: 'x_frame_options_allow_from_other',
  CSP_NONE: 'csp_frame_ancestors_none',
  CSP_RESTRICTED: 'csp_frame_ancestors_excludes_us',
};

/** Read a header from a fetch Headers object or a plain object, case-insensitively. */
function header(headers, name) {
  if (!headers) return '';
  if (typeof headers.get === 'function') return headers.get(name) || '';
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name);
  return key ? String(headers[key] || '') : '';
}

/** Pull the frame-ancestors source list out of a CSP, or null when absent. */
function frameAncestors(csp) {
  for (const directive of String(csp).split(';')) {
    const parts = directive.trim().split(/\s+/);
    if (parts[0] && parts[0].toLowerCase() === 'frame-ancestors') {
      return parts.slice(1).map((s) => s.toLowerCase());
    }
  }
  return null;
}

/**
 * Decide whether a response can be framed by us.
 *
 * @param headers  fetch Headers (or a plain object)
 * @param selfOrigin  our own origin, e.g. "https://zofhub.com". When supplied,
 *        a policy that explicitly names us counts as allowed. Omitted at crawl
 *        time, the check stays conservative and treats a restricted list as a
 *        block — which is the safe direction: a wrongly-hidden game is a
 *        support ticket, a wrongly-shown one is a black screen.
 * @returns {{ blocked: boolean, reason: string, header: string|null, value: string|null }}
 */
export function framingVerdict(headers, { selfOrigin = '' } = {}) {
  const ok = { blocked: false, reason: FRAMING.OK, header: null, value: null };
  const self = String(selfOrigin || '').toLowerCase().replace(/\/+$/, '');

  // CSP frame-ancestors supersedes X-Frame-Options where both are present, so
  // it is evaluated first.
  const csp = header(headers, 'content-security-policy');
  const list = csp ? frameAncestors(csp) : null;
  if (list) {
    const value = 'frame-ancestors ' + list.join(' ');
    if (list.includes("'none'")) {
      return { blocked: true, reason: FRAMING.CSP_NONE, header: 'content-security-policy', value };
    }
    // A wildcard host source, or a bare scheme source, admits anyone.
    const openToAll = list.some((s) => s === '*' || s === 'https:' || s === 'http:' || s === 'https://*');
    const namesUs = !!self && list.some((s) => s.replace(/\/+$/, '') === self);
    if (!openToAll && !namesUs) {
      return { blocked: true, reason: FRAMING.CSP_RESTRICTED, header: 'content-security-policy', value };
    }
    return ok;
  }

  const xfo = header(headers, 'x-frame-options').trim().toLowerCase();
  if (xfo) {
    if (/\bdeny\b/.test(xfo)) {
      return { blocked: true, reason: FRAMING.XFO_DENY, header: 'x-frame-options', value: xfo };
    }
    if (/\bsameorigin\b/.test(xfo)) {
      // SAMEORIGIN means the game's own origin, which is never ours.
      return { blocked: true, reason: FRAMING.XFO_SAMEORIGIN, header: 'x-frame-options', value: xfo };
    }
    const allowFrom = xfo.match(/allow-from\s+(\S+)/);
    if (allowFrom) {
      const target = allowFrom[1].replace(/\/+$/, '');
      if (!self || target !== self) {
        return { blocked: true, reason: FRAMING.XFO_ALLOW_FROM, header: 'x-frame-options', value: xfo };
      }
    }
  }
  return ok;
}

/** Boolean form, for call sites that only need yes/no. */
export function framingBlocked(headers, opts) {
  return framingVerdict(headers, opts).blocked;
}
