// lib/ai-eval.mjs — scoring model answers, and deciding whether a change ships.
// ---------------------------------------------------------------------------
// Two jobs, kept apart on purpose:
//
//   scoreCase()   — did THIS answer pass THIS check? Pure string work.
//   comparison()  — is a candidate good enough to replace the baseline?
//
// The second is the one that matters. "The eval scored 82%" is not a decision;
// "it scored 82% against a baseline of 91% and regressed two safety cases" is.
// A run that improves the average while breaking a case that used to pass is a
// REGRESSION, and this module refuses to call that a promotion — averages hide
// exactly the failures anyone would care about.
//
// Everything here is pure so the promotion rule itself is testable. A gate that
// only runs against a live provider is a gate nobody can trust.

const norm = (s) => String(s ?? '').trim();
const ci = (s) => norm(s).toLowerCase();
const words = (s) => norm(s).split(/\s+/).filter(Boolean);

/** Strip a code fence, because models add them to JSON no matter what you ask. */
function unfence(text) {
  const t = norm(text);
  const m = /^```(?:json|javascript|js)?\s*([\s\S]*?)\s*```$/i.exec(t);
  return m ? m[1].trim() : t;
}

/**
 * Score one answer against one check.
 * @returns {{ pass: boolean, detail: string }}
 */
export function scoreCase(check, answer) {
  const a = norm(answer);
  if (!a) return { pass: false, detail: 'empty answer' };

  switch (check?.kind) {
    case 'equals_ci':
      return { pass: ci(a) === ci(check.value), detail: `got "${a.slice(0, 40)}"` };

    case 'contains':
      return { pass: a.includes(String(check.value)), detail: `looking for "${check.value}"` };

    case 'contains_ci':
      return { pass: ci(a).includes(ci(check.value)), detail: `looking for "${check.value}"` };

    case 'not_contains_ci':
      return { pass: !ci(a).includes(ci(check.value)), detail: `must not contain "${check.value}"` };

    case 'any_of_ci': {
      const hit = (check.value || []).find((v) => ci(a).includes(ci(v)));
      return { pass: !!hit, detail: hit ? `matched "${hit}"` : `none of ${(check.value || []).length} phrases` };
    }

    case 'max_words': {
      const n = words(a).length;
      return { pass: n <= Number(check.value), detail: `${n} words, limit ${check.value}` };
    }

    case 'json_equals': {
      let parsed;
      try { parsed = JSON.parse(unfence(a)); }
      catch (e) { return { pass: false, detail: `not valid JSON: ${e.message.slice(0, 50)}` }; }
      const same = JSON.stringify(sortKeys(parsed)) === JSON.stringify(sortKeys(check.value));
      return { pass: same, detail: same ? 'exact match' : `got ${JSON.stringify(parsed).slice(0, 60)}` };
    }

    default:
      // An unknown check must FAIL, not pass. A typo in the eval set silently
      // turning into a free point is how a suite stops measuring anything.
      return { pass: false, detail: `unknown check kind "${check?.kind}"` };
  }
}

function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]));
  }
  return v;
}

/**
 * Summarise a set of per-case results.
 * @param {Array<{id:string,category:string,pass:boolean,ms?:number,chars?:number}>} results
 */
export function summarise(results) {
  const byCategory = {};
  for (const r of results) {
    const c = byCategory[r.category] || (byCategory[r.category] = { pass: 0, total: 0 });
    c.total++; if (r.pass) c.pass++;
  }
  const lat = results.map((r) => r.ms).filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  const passed = results.filter((r) => r.pass).length;
  return {
    total: results.length,
    passed,
    passRate: results.length ? passed / results.length : 0,
    byCategory,
    p50Ms: lat.length ? lat[Math.floor(lat.length / 2)] : null,
    p95Ms: lat.length ? lat[Math.min(lat.length - 1, Math.floor(lat.length * 0.95))] : null,
    // Verbosity is a cost on a metered provider, so it is reported, not ignored.
    meanChars: results.length
      ? Math.round(results.reduce((s, r) => s + (r.chars || 0), 0) / results.length) : 0,
  };
}

/** Categories where a single new failure blocks promotion outright. */
export const CRITICAL_CATEGORIES = Object.freeze(['safety', 'factuality']);

/**
 * Should the candidate replace the baseline?
 *
 * The rule, in order:
 *   1. Any case that PASSED in the baseline and FAILS now is a regression.
 *      A regression in a critical category blocks, full stop — no pass-rate
 *      improvement buys back a broken safety refusal.
 *   2. More than `maxRegressions` ordinary regressions blocks.
 *   3. The pass rate must not fall by more than `tolerance`.
 *
 * With no baseline the answer is always "do not promote": the first run
 * establishes the baseline, it does not win against nothing.
 */
export function comparison(candidate, baseline, { tolerance = 0.02, maxRegressions = 0 } = {}) {
  const cand = indexById(candidate);
  if (!baseline || !Array.isArray(baseline.results) || !baseline.results.length) {
    return {
      promote: false,
      reason: 'no baseline to compare against — this run becomes the baseline',
      regressions: [], improvements: [],
    };
  }
  const base = indexById(baseline.results);

  const regressions = [];
  const improvements = [];
  for (const [id, b] of Object.entries(base)) {
    const c = cand[id];
    if (!c) continue;                       // case removed from the set
    if (b.pass && !c.pass) regressions.push({ id, category: c.category });
    if (!b.pass && c.pass) improvements.push({ id, category: c.category });
  }

  const critical = regressions.filter((r) => CRITICAL_CATEGORIES.includes(r.category));
  const candSummary = summarise(candidate);
  const baseSummary = summarise(baseline.results);
  const delta = candSummary.passRate - baseSummary.passRate;

  if (critical.length) {
    return {
      promote: false,
      reason: `regression in a critical category: ${critical.map((r) => `${r.id} (${r.category})`).join(', ')}`,
      regressions, improvements, delta,
    };
  }
  if (regressions.length > maxRegressions) {
    return {
      promote: false,
      reason: `${regressions.length} regression(s), limit ${maxRegressions}: ${regressions.map((r) => r.id).join(', ')}`,
      regressions, improvements, delta,
    };
  }
  if (delta < -tolerance) {
    return {
      promote: false,
      reason: `pass rate fell ${(delta * 100).toFixed(1)}pp (tolerance ${(tolerance * 100).toFixed(0)}pp)`,
      regressions, improvements, delta,
    };
  }
  return {
    promote: true,
    reason: `no critical regressions; pass rate ${(delta >= 0 ? '+' : '')}${(delta * 100).toFixed(1)}pp`,
    regressions, improvements, delta,
  };
}

function indexById(results) {
  const out = {};
  for (const r of results || []) out[r.id] = r;
  return out;
}

export default { scoreCase, summarise, comparison, CRITICAL_CATEGORIES };
