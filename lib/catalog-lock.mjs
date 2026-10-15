// lib/catalog-lock.mjs — the catalog is FROZEN at a baseline size, and only a
// deliberate, time-limited, re-authenticated unlock lets a human add past it.
// ---------------------------------------------------------------------------
// WHY THIS EXISTS. The site used to grow itself: a cron job promoted +30
// render-verified games into the catalog every 36 hours, a weekly Y8 sync
// upserted a few thousand more, and a weekly GameDistribution import added
// whatever the feed held. The product decision is now the opposite one — the
// catalog is a CURATED set of a fixed size, and nothing may add to it without a
// person choosing to. Those schedulers are gone (see lib/cron-jobs.mjs and the
// note at startCronJobs), and this module is the rule that keeps them gone: even
// if something tries to insert, the gate says no.
//
// THE SHAPE OF THE RULE. Two independent conditions, both checked server-side:
//
//   1. HEADROOM. Below the baseline, adding is ordinary editorial work and needs
//      no ceremony — the catalog is allowed to reach its intended size. This
//      matters for recovery: if a game is archived, its slot can be refilled
//      without anyone unlocking anything.
//   2. THE UNLOCK. At or above the baseline, adding is refused unless an
//      explicit unlock is in force. The unlock EXPIRES on a wall clock, so the
//      failure mode of forgetting to re-lock is "it re-locks itself", not "the
//      catalog is open indefinitely".
//
// WHAT THIS MODULE IS NOT. It is not the authorisation check and not the
// re-authentication check. Who may unlock (the `catalog.unlock` permission, held
// by owner/super_admin only) and whether they re-entered their password lives in
// lib/admin-rbac.mjs and the settings service, because those apply to every
// privileged setting and not just this one. This module answers only the
// narrower question a caller cannot answer for itself: "given the lock state and
// the current size, may one more game be added right now?"
//
// PURE. No clock of its own, no I/O, no database — `now` is always injected. The
// whole policy is therefore testable as plain data, which is the point: a rule
// about refusing writes is worth nothing if it can only be exercised by
// attempting a real write.
// ---------------------------------------------------------------------------

/**
 * The intended size of the published catalog.
 *
 * 100 is a product decision, not a technical limit, so it is a default rather
 * than a constant the code depends on — server.js reads CATALOG_BASELINE from
 * the environment and passes it in. Every function here takes `baseline`
 * explicitly for that reason.
 */
export const DEFAULT_BASELINE = 100;

/**
 * Bounds on how long an unlock may last.
 *
 * A floor as well as a ceiling: a 30-second unlock sounds safer but is not, it
 * just means the operator unlocks six times in a row and stops reading the
 * warning. An hour is long enough to add a batch of games deliberately and
 * short enough that walking away re-locks it.
 */
export const MIN_UNLOCK_MINUTES = 5;
export const MAX_UNLOCK_MINUTES = 24 * 60;
export const DEFAULT_UNLOCK_MINUTES = 60;

/** Refusal codes, so callers can branch without matching on prose. */
export const LOCK_REASON = Object.freeze({
  AT_BASELINE: 'catalog_at_baseline',
  EXPIRED: 'unlock_expired',
});

/**
 * Coerce any stored or submitted value into a well-formed unlock state.
 *
 * Deliberately total: anything unrecognisable becomes the LOCKED state rather
 * than throwing. This value arrives from a database row that an older build may
 * have written in a different shape, and the safe reading of "I do not
 * understand this" is "the catalog is locked", never "assume it is open".
 */
export function normalizeUnlock(raw) {
  const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const enabled = o.enabled === true;
  const until = typeof o.until === 'string' && Number.isFinite(Date.parse(o.until)) ? o.until : null;
  const minutes = clampMinutes(o.minutes);
  const by = typeof o.by === 'string' ? o.by.slice(0, 80) : null;
  // An "enabled" unlock with no expiry is not a valid state — the time limit is
  // the whole safety property. Treat it as locked rather than as permanent.
  return { enabled: enabled && !!until, until: enabled ? until : null, minutes, by };
}

/**
 * Clamp a requested duration into the permitted window.
 *
 * Only a number or a numeric string counts as a request; anything else is
 * "unspecified" and gets the default. Written this way because Number(null) is 0
 * and Number('') is 0 — passing those through Number() would clamp a missing
 * value to the five-minute FLOOR instead of the sixty-minute default, so
 * omitting the field would silently give the shortest possible unlock.
 */
export function clampMinutes(value) {
  const numeric = typeof value === 'number'
    || (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value)));
  if (!numeric) return DEFAULT_UNLOCK_MINUTES;
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_UNLOCK_MINUTES;
  return Math.min(MAX_UNLOCK_MINUTES, Math.max(MIN_UNLOCK_MINUTES, Math.round(n)));
}

/**
 * Is an unlock in force right now?
 *
 * Expiry is evaluated against the injected clock on EVERY read rather than by a
 * timer that flips the stored value. A timer can be missed by a restart; a
 * comparison cannot. So an unlock written before a deploy is already expired
 * after it, with nothing needing to have run in between.
 */
export function isUnlocked(state, now = Date.now()) {
  const s = normalizeUnlock(state);
  if (!s.enabled || !s.until) return false;
  return Date.parse(s.until) > now;
}

/** Milliseconds of unlock left; 0 when locked or expired. */
export function remainingMs(state, now = Date.now()) {
  const s = normalizeUnlock(state);
  if (!s.enabled || !s.until) return 0;
  return Math.max(0, Date.parse(s.until) - now);
}

/**
 * May one more game be added to the published catalog right now?
 *
 * @param {object}  o
 * @param {object}  o.unlock          the stored unlock state
 * @param {number}  o.publishedCount  how many games are published today
 * @param {number}  o.baseline        the intended catalog size
 * @param {number}  [o.adding]        how many are being added at once (bulk import)
 * @param {number}  [o.now]           injected clock
 * @returns {{ok: boolean, reason: string|null, code: string|null, baseline: number, publishedCount: number, headroom: number}}
 */
export function mayAddGame({ unlock, publishedCount, baseline = DEFAULT_BASELINE, adding = 1, now = Date.now() } = {}) {
  const base = Number.isFinite(baseline) && baseline > 0 ? Math.floor(baseline) : DEFAULT_BASELINE;
  const count = Number.isFinite(publishedCount) && publishedCount > 0 ? Math.floor(publishedCount) : 0;
  const n = Number.isFinite(adding) && adding > 0 ? Math.floor(adding) : 1;
  const headroom = Math.max(0, base - count);

  // The unlock wins outright: an operator who has deliberately opened the gate
  // is allowed past the baseline, which is the entire purpose of the gate.
  if (isUnlocked(unlock, now)) {
    return { ok: true, reason: null, code: null, baseline: base, publishedCount: count, headroom, unlocked: true };
  }
  // Under the baseline there is room, so this is ordinary editorial work.
  if (count + n <= base) {
    return { ok: true, reason: null, code: null, baseline: base, publishedCount: count, headroom, unlocked: false };
  }
  // Locked, and this addition would cross the line.
  const s = normalizeUnlock(unlock);
  const expired = s.enabled && !!s.until;   // was unlocked, but the window has passed
  return {
    ok: false,
    code: expired ? LOCK_REASON.EXPIRED : LOCK_REASON.AT_BASELINE,
    reason: expired
      ? `the manual-addition unlock expired at ${s.until}; the catalog is locked at its ${base}-game baseline`
      : `the catalog is locked at its ${base}-game baseline (${count} published). `
        + 'An authorised administrator must enable "Allow manual game additions beyond the baseline" first.',
    baseline: base,
    publishedCount: count,
    headroom,
    unlocked: false,
  };
}

/**
 * The lock state as the admin console should render it.
 *
 * `remainingMs` is included rather than only `until` so the UI can show a
 * countdown without re-deriving it, and because a countdown is what makes a
 * time-limited unlock legible as time-limited.
 */
export function describeLock({ unlock, publishedCount = 0, baseline = DEFAULT_BASELINE, now = Date.now() } = {}) {
  const s = normalizeUnlock(unlock);
  const live = isUnlocked(s, now);
  const base = Number.isFinite(baseline) && baseline > 0 ? Math.floor(baseline) : DEFAULT_BASELINE;
  return {
    baseline: base,
    publishedCount: Math.max(0, Math.floor(publishedCount) || 0),
    headroom: Math.max(0, base - (Math.floor(publishedCount) || 0)),
    unlocked: live,
    until: live ? s.until : null,
    remainingMs: remainingMs(s, now),
    expiredAt: !live && s.until ? s.until : null,
    unlockedBy: live ? s.by : null,
    // Stated here so the console can say it rather than implying it: the unlock
    // governs MANUAL additions only. There is no scheduled importer left for it
    // to re-enable, and enabling it must never be mistaken for turning one on.
    affectsSchedulers: false,
  };
}

export default {
  DEFAULT_BASELINE, MIN_UNLOCK_MINUTES, MAX_UNLOCK_MINUTES, DEFAULT_UNLOCK_MINUTES,
  LOCK_REASON, normalizeUnlock, clampMinutes, isUnlocked, remainingMs, mayAddGame, describeLock,
};
