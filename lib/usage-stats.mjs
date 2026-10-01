// ============================================================================
// usage-stats.mjs — the two numbers the console could not previously answer.
//
// WHAT THIS IS FOR. The admin console could show live concurrent visitors and
// lifetime plays, but not "how many people today" or "how much AI is this
// costing me". Both are cheaply measurable and were simply never counted, so
// the panels for them had nothing to show.
//
// WHAT IT DELIBERATELY IS NOT. There is no database table, no cookie, no
// device id and no per-person row. Visitors are counted through the SAME
// HMAC-of-IP the admin log already uses, kept only as a membership set for the
// current UTC day and dropped wholesale at rollover. Nothing here can be walked
// back to a person, an address, or a session, and nothing survives a restart.
//
// HONEST LABELLING IS PART OF THE CONTRACT. These are per-process, in-memory
// counters. On a host running two instances each sees its own slice, and a
// deploy resets them. The console must say "today, this instance" and "since
// restart" — never present them as authoritative totals.
// ============================================================================

const AI_KINDS = ['text', 'image', 'audio', 'video'];
const MAX_VISITORS = 100000;   // hard bound; a flood must not become an OOM

const state = {
  bootedAt: Date.now(),
  ai: Object.create(null),
  aiErrors: 0,
  day: utcDay(),
  visitors: new Set(),
  visitorsTruncated: false,
  peakConcurrent: 0,
  yesterday: null,
};
for (const k of AI_KINDS) state.ai[k] = 0;

function utcDay(now = Date.now()) { return new Date(now).toISOString().slice(0, 10); }

/** Roll the visitor set over at UTC midnight, keeping one day of history. */
function rollIfNeeded(now = Date.now()) {
  const d = utcDay(now);
  if (d === state.day) return;
  state.yesterday = { day: state.day, visitors: state.visitors.size, truncated: state.visitorsTruncated };
  state.day = d;
  state.visitors = new Set();
  state.visitorsTruncated = false;
}

/** One server-side AI request. Browser-direct calls never reach this process. */
export function noteAiRequest(kind, { failed = false } = {}) {
  const k = AI_KINDS.includes(kind) ? kind : 'text';
  state.ai[k] = (state.ai[k] || 0) + 1;
  if (failed) state.aiErrors++;
}

/** One visitor beat. `ipHash` must already be hashed — never pass a raw IP. */
export function noteVisitor(ipHash) {
  if (!ipHash) return;
  rollIfNeeded();
  if (state.visitors.size >= MAX_VISITORS) { state.visitorsTruncated = true; return; }
  state.visitors.add(ipHash);
}

/** Highest simultaneous presence seen since boot. */
export function notePeakConcurrent(n) {
  const v = Number(n) || 0;
  if (v > state.peakConcurrent) state.peakConcurrent = v;
}

export function usageSnapshot() {
  rollIfNeeded();
  const ai = { ...state.ai };
  const aiTotal = AI_KINDS.reduce((s, k) => s + (ai[k] || 0), 0);
  return {
    since: new Date(state.bootedAt).toISOString(),
    uptimeMs: Date.now() - state.bootedAt,
    ai: { ...ai, total: aiTotal, errors: state.aiErrors, scope: 'server-side only, since restart' },
    visitors: {
      day: state.day,
      today: state.visitors.size,
      truncated: state.visitorsTruncated,
      yesterday: state.yesterday,
      scope: 'distinct hashed IPs, today, this instance',
    },
    peakConcurrent: state.peakConcurrent,
  };
}

/** Test seam. */
export function _reset() {
  state.ai = Object.create(null);
  for (const k of AI_KINDS) state.ai[k] = 0;
  state.aiErrors = 0; state.visitors = new Set(); state.visitorsTruncated = false;
  state.peakConcurrent = 0; state.yesterday = null; state.day = utcDay();
}
