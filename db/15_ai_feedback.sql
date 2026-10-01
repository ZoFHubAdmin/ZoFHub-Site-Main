-- =====================================================================
-- ZoFHub · ai_feedback   (run ONCE in the Supabase SQL editor)
-- =====================================================================
-- Feedback on AI answers, shaped so it can improve the system WITHOUT
-- becoming a pipe from "anyone can type" to "model weights".
--
-- WHAT THIS IS NOT. It is not a conversation log. The AI runs entirely in
-- the visitor's browser (public/js/ai.js talks to providers directly), and
-- this server never sees a chat. A row appears here only when somebody
-- deliberately rates, corrects or reports ONE answer. There is no column
-- for a conversation id, and adding one would turn a feedback table into
-- surveillance of a feature whose whole design is that we cannot see it.
--
-- CONSENT IS PER ROW, NOT PER USER. `consent_training` records what the
-- person agreed to for THIS submission. The default is false, and false
-- means the row may be counted and evaluated but may never enter a
-- training set. lib/ai-feedback.mjs enforces the same rule in code; this
-- is the copy that survives a bug in the application.
--
-- REDACTED ON ARRIVAL. The API redacts emails, phone numbers, card-shaped
-- digits, API tokens, street addresses and IPs BEFORE insert. There is
-- deliberately no column holding the original text: a raw copy would
-- outlive the redaction in backups and replicas.
--
--   Dashboard -> SQL Editor -> New query -> paste -> Run.
-- =====================================================================

create table if not exists public.ai_feedback (
  id           uuid primary key default gen_random_uuid(),
  created_at   timestamptz not null default now(),

  -- One of: rating | correction | regenerate | accepted | report | delivery_failure
  type         text not null check (type in
                 ('rating','correction','regenerate','accepted','report','delivery_failure')),

  -- Redacted text. Bounded here as well as in the API so a direct PostgREST
  -- insert cannot store an essay.
  input        text check (input is null or length(input) <= 4000),
  output       text check (output is null or length(output) <= 4000),
  correction   text check (correction is null or length(correction) <= 4000),
  rating       smallint check (rating is null or rating in (-1, 0, 1)),

  -- PROVENANCE. Which backend and model produced the answer being judged, and
  -- which system-prompt version was in force. Without these a row is unusable:
  -- you cannot tell whether a complaint is about Llama, about Pollinations, or
  -- about a prompt that has since been rewritten.
  provider       text check (provider is null or length(provider) <= 40),
  model          text check (model is null or length(model) <= 120),
  prompt_version text check (prompt_version is null or length(prompt_version) <= 40),

  -- The routing decision from lib/ai-feedback.mjs, stored so a curator can see
  -- why a row landed where it did rather than re-deriving it months later.
  lanes        text[] not null default '{}',
  route_reason text check (route_reason is null or length(route_reason) <= 300),

  -- Consent, and the derived verdict. training_eligible is false unless the
  -- person opted in AND the signal type is one that can carry a training target.
  consent_training  boolean not null default false,
  training_eligible boolean not null default false,

  -- How many redactions fired. A high count is a signal that someone pasted
  -- something personal, and curation should treat the row with suspicion.
  redactions   integer not null default 0,

  -- Curation state. A row is never used for anything until a human moves it.
  --   pending  -> untouched
  --   approved -> may enter a curated dataset
  --   rejected -> excluded permanently
  review_state text not null default 'pending'
                 check (review_state in ('pending','approved','rejected')),

  -- RETENTION. Set on insert by the API. prune_ai_feedback() deletes past it,
  -- so "we keep this for N days" is enforced by a job rather than by intention.
  expires_at   timestamptz not null default (now() + interval '180 days')
);

comment on table public.ai_feedback is
  'Feedback on individual AI answers. Redacted before insert, consent recorded per row, never a conversation log. Training use requires consent_training AND human approval.';

-- Curation reads filter on these three constantly.
create index if not exists ai_feedback_state_idx on public.ai_feedback (review_state, created_at desc);
create index if not exists ai_feedback_training_idx on public.ai_feedback (training_eligible, review_state);
create index if not exists ai_feedback_expiry_idx on public.ai_feedback (expires_at);

-- ── Row-Level Security: deny by default ──────────────────────────────────
alter table public.ai_feedback enable row level security;
alter table public.ai_feedback force row level security;

drop policy if exists "anon can submit ai feedback" on public.ai_feedback;
drop policy if exists "public can read ai feedback"  on public.ai_feedback;

-- INSERT only, and only the shapes the application produces. There is
-- deliberately NO select/update/delete policy: a browser can leave feedback and
-- can never read anyone's back. The server reads with the secret key, which
-- bypasses RLS and never leaves the backend.
create policy "anon can submit ai feedback"
  on public.ai_feedback
  for insert
  to anon, authenticated
  with check (
    type in ('rating','correction','regenerate','accepted','report','delivery_failure')
    and coalesce(length(input), 0) <= 4000
    and coalesce(length(output), 0) <= 4000
    and coalesce(length(correction), 0) <= 4000
    -- A client may NOT declare itself training-eligible. That verdict is the
    -- server's, and pinning it here means a forged PostgREST insert cannot
    -- smuggle a row into the training pool.
    and training_eligible = false
    and review_state = 'pending'
  );

revoke all on table public.ai_feedback from anon, authenticated;
grant insert on table public.ai_feedback to anon, authenticated;
grant all    on table public.ai_feedback to service_role;

-- ── Retention ────────────────────────────────────────────────────────────
-- Approved rows are exempt: they have been reviewed and belong to a dataset
-- whose provenance would break if rows vanished underneath it. Everything else
-- is deleted on schedule, including rows nobody ever looked at.
create or replace function public.prune_ai_feedback()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  removed integer;
begin
  delete from public.ai_feedback
   where expires_at < now()
     and review_state <> 'approved';
  get diagnostics removed = row_count;
  return removed;
end;
$$;

revoke all on function public.prune_ai_feedback() from public, anon, authenticated;
grant execute on function public.prune_ai_feedback() to service_role;

-- ── Right to erasure ─────────────────────────────────────────────────────
-- There is no user id to key on, by design. So deletion is offered the only
-- honest way it can be: by the exact text somebody submitted, which they are
-- the only person likely to still have.
create or replace function public.forget_ai_feedback(p_text text)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  removed integer;
begin
  if p_text is null or length(btrim(p_text)) < 12 then
    return 0;   -- refuse to mass-delete on a short string
  end if;
  delete from public.ai_feedback
   where input = p_text or output = p_text or correction = p_text;
  get diagnostics removed = row_count;
  return removed;
end;
$$;

revoke all on function public.forget_ai_feedback(text) from public, anon, authenticated;
grant execute on function public.forget_ai_feedback(text) to service_role;
