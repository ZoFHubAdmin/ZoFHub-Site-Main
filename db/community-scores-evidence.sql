-- ============================================================================
--  scores.flag_evidence — why a score was quarantined, in reviewable detail
--  Run AFTER db/community-scores-integrity.sql (which adds status/flag_reason).
--
--  WHY THIS EXISTS
--  Quarantine already worked, but the only thing recorded about a held score was
--  the literal string 'outlier'. An administrator reviewing the queue therefore
--  saw a score and a game and had to decide, from nothing, whether a human could
--  have produced it. The numbers that triggered the flag — the board best at the
--  time, the ratio, how long the session had actually been played, the implied
--  points per second — all existed in the request handler and were thrown away.
--
--  Keeping them turns "approve or reject, on vibes" into a decision with
--  evidence attached, and makes it possible to tune the detector afterwards:
--  you can look at what was flagged, see the distribution of ratios, and move a
--  threshold knowing what it would have caught.
--
--  jsonb, not more columns, because the detector will grow signals over time and
--  each one should not be a migration. Nothing queries inside it in the hot path;
--  it is read by the admin review screen, one row at a time.
--
--  Idempotent: safe to re-run.
-- ============================================================================

alter table public.scores add column if not exists flag_evidence jsonb;

comment on column public.scores.flag_evidence is
  'Anti-cheat detail captured when a score was flagged: the rule that fired, the '
  'board best it was compared against, the ratio, the measured play time, and the '
  'implied points-per-second. Read by the admin review screen. Null for scores '
  'that were never flagged.';

-- Reviewing the queue means "flagged rows, newest first". Without this the
-- review screen sequential-scans a table that grows forever.
create index if not exists scores_flagged_recent_idx
  on public.scores (created_at desc)
  where status = 'flagged';

-- ---------------------------------------------------------------------------
-- Duplicate / replay detection support.
--
-- The keep-best rule already collapses one player's repeated scores in a game to
-- a single row, so floods were bounded — but only per NAME. The same client
-- submitting an identical score under a series of names left no trace, because
-- nothing recorded that the submissions were related.
--
-- ip_tag is the keyed HMAC of the submitter's address (never the address
-- itself — same construction as the admin audit trail), so "these twelve rows
-- came from one place" is answerable without storing anyone's IP.
-- ---------------------------------------------------------------------------
alter table public.scores add column if not exists ip_tag text;

comment on column public.scores.ip_tag is
  'Keyed HMAC of the submitting IP, truncated. NOT an IP address and not '
  'reversible: it exists so repeated submissions from one source can be '
  'correlated during review. Keyed by SCORE_SECRET, so rotating that secret '
  'deliberately breaks correlation with older rows.';

-- "Has this exact score already come from this source for this game recently?"
create index if not exists scores_dupe_probe_idx
  on public.scores (slug, ip_tag, score);

-- The admin review screen and the duplicate probe both read these columns with
-- the service key only. Public reads still go through the existing
-- "Public can read visible scores" policy, which is unchanged and continues to
-- expose status='ok' rows only — flag_evidence and ip_tag are on rows that
-- policy already refuses to return.
