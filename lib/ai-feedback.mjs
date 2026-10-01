// lib/ai-feedback.mjs — turning AI feedback into the RIGHT kind of change.
// ---------------------------------------------------------------------------
// The tempting design is a loop: collect thumbs-down, fine-tune, ship. It is
// also the design that degrades a working system, for three reasons this module
// is built to prevent.
//
//   1. MOST NEGATIVE FEEDBACK IS NOT ABOUT THE MODEL. ZoFHub's measured failure
//      mode is an empty stream from a provider (6 of 12 attempts) and a ~32s
//      median fallback. A user thumbs-down on "the AI didn't answer" is a
//      ROUTING fact. Training a model on it teaches nothing and pollutes the
//      corpus with infrastructure noise.
//   2. FEEDBACK IS ADVERSARIAL BY DEFAULT. This is a site whose audience is
//      school-age and whose whole premise is evading filters. An open pipe from
//      "anyone can type" to "model weights" is a prompt-injection and
//      data-poisoning surface, not a feature.
//   3. THE CHEAPEST FIX IS USUALLY NOT TRAINING. A wrong answer about this
//      site's own catalogue is a RETRIEVAL gap. A wrong tone is a PROMPT bug. A
//      wrong model choice is ROUTING. Each is hours of work and instantly
//      reversible; fine-tuning is neither.
//
// So this module classifies a signal and ROUTES it to the mechanism that can
// actually fix it. Fine-tuning is one outcome among several, and the rarest.
//
// It is deliberately pure: no database, no network, no clock of its own. That
// is what makes the routing rules testable, and the rules are the part that
// must not be wrong.

/** What a signal can be. Anything else is rejected rather than guessed at. */
export const SIGNALS = Object.freeze({
  RATING: 'rating',                 // explicit thumbs up/down
  CORRECTION: 'correction',         // the user rewrote the answer
  REGENERATE: 'regenerate',         // asked again — implicit dissatisfaction
  ACCEPTED: 'accepted',             // copied/kept the answer — weak positive
  REPORT: 'report',                 // unsafe, offensive, or policy-breaking
  DELIVERY_FAILURE: 'delivery_failure', // no answer arrived: timeout, empty stream, 429
});

/** Where a signal is allowed to end up. */
export const LANES = Object.freeze({
  ROUTING: 'routing',               // provider/model selection + ops alerting
  PROMPT: 'prompt',                 // system prompt / policy text
  RETRIEVAL: 'retrieval',           // grounding over our own catalogue
  EVAL: 'eval',                     // a regression case, held out of training
  SFT_CANDIDATE: 'sft_candidate',   // supervised example, PENDING REVIEW
  PREFERENCE: 'preference',         // chosen/rejected pair for preference tuning
  SAFETY: 'safety',                 // safety review queue
  DISCARD: 'discard',               // carries no usable information
});

export const MIN_CORRECTION_CHARS = 12;
export const MAX_TEXT_CHARS = 4000;

// ── Redaction ──────────────────────────────────────────────────────────────
// Applied BEFORE anything is stored, not before it is exported. Storing raw and
// cleaning later means the raw copy exists in backups, in replicas, and in
// whatever someone queried in the meantime.
//
// This is a reducer of obvious harm, not an anonymiser. It cannot find a name,
// a school, or "my teacher Mr X" — which is exactly why consent, and not
// redaction, is what actually gates training use below.
const REDACTORS = [
  [/\b[\w.%+-]+@[\w.-]+\.[A-Za-z]{2,}\b/g, '[email]'],
  [/\b(?:\+?\d[\d\s().-]{7,}\d)\b/g, '[phone]'],
  [/\b(?:\d[ -]*?){13,19}\b/g, '[card]'],
  // Credentials people paste into chat windows without thinking.
  [/\b(?:hf_[A-Za-z0-9]{16,}|sk-[A-Za-z0-9]{20,}|pk_[A-Za-z0-9]{10,}|gh[pousr]_[A-Za-z0-9]{20,})\b/g, '[token]'],
  [/\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/gi, '[token]'],
  // Addresses that identify a household.
  [/\b\d{1,5}\s+[A-Z][a-z]+\s+(?:Street|St|Road|Rd|Avenue|Ave|Lane|Ln|Drive|Dr|Boulevard|Blvd)\b/g, '[address]'],
  [/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[ip]'],
];

/** @returns {{ text: string, redactions: number }} */
export function redact(input) {
  let text = String(input ?? '').slice(0, MAX_TEXT_CHARS);
  let redactions = 0;
  for (const [re, replacement] of REDACTORS) {
    text = text.replace(re, () => { redactions++; return replacement; });
  }
  return { text, redactions };
}

/**
 * Did the answer actually reach the user?
 *
 * The single most important question, and the one a naive pipeline never asks.
 * A rating attached to an answer that never arrived is evidence about our
 * infrastructure and NOTHING about the model. Letting it through would fill a
 * training set with prompts whose "bad output" is an empty string.
 */
export function isDeliveryProblem(signal) {
  if (signal?.type === SIGNALS.DELIVERY_FAILURE) return true;
  const out = String(signal?.output ?? '');
  if (!out.trim()) return true;
  // The literal strings the UI shows when a provider fails. A user rating one of
  // these is rating our plumbing.
  return /didn’t come through|didn't come through|no response|AI is busy|try again/i.test(out)
    && out.length < 200;
}

/**
 * Decide what a signal is allowed to influence.
 *
 * Returns one or more lanes with a reason. Multiple lanes are normal: a good
 * correction is both a regression test and a training candidate, and it should
 * become the test even if it is never used for training.
 *
 * @param {object} signal
 * @param {string} signal.type        one of SIGNALS
 * @param {string} [signal.input]     what the user asked
 * @param {string} [signal.output]    what the model said
 * @param {string} [signal.correction] what the user says it should have said
 * @param {number} [signal.rating]    -1 | 0 | 1
 * @param {boolean} [signal.consentTraining] explicit, per-submission
 * @param {string} [signal.provider]  which backend answered
 * @param {string} [signal.model]     which model answered
 * @returns {{ lanes: string[], reason: string, trainingEligible: boolean }}
 */
export function routeSignal(signal = {}) {
  const type = String(signal.type || '');
  if (!Object.values(SIGNALS).includes(type)) {
    return { lanes: [LANES.DISCARD], reason: 'unknown signal type', trainingEligible: false };
  }

  // 1. Infrastructure first. Nothing about a failed delivery is model evidence.
  if (isDeliveryProblem(signal)) {
    return {
      lanes: [LANES.ROUTING],
      reason: 'no answer was delivered — this is provider/routing evidence, not model quality',
      trainingEligible: false,
    };
  }

  // 2. Safety outranks everything that survives. A reported answer must reach a
  //    human even when the same submission would otherwise be a nice example.
  if (type === SIGNALS.REPORT) {
    return {
      lanes: [LANES.SAFETY, LANES.EVAL],
      reason: 'reported content — human review, and a permanent regression case',
      trainingEligible: false,
    };
  }

  // 3. A correction is the highest-value signal there is: it carries the target
  //    output, not just a complaint. It still does not go straight to training.
  if (type === SIGNALS.CORRECTION) {
    const corrected = String(signal.correction || '').trim();
    if (corrected.length < MIN_CORRECTION_CHARS) {
      return { lanes: [LANES.DISCARD], reason: 'correction too short to carry information', trainingEligible: false };
    }
    const lanes = [LANES.EVAL, LANES.PREFERENCE];
    // Only an EXPLICIT, per-submission consent makes it a training candidate,
    // and "candidate" means queued for review — never auto-promoted.
    if (signal.consentTraining === true) lanes.push(LANES.SFT_CANDIDATE);
    return {
      lanes,
      reason: signal.consentTraining === true
        ? 'correction with consent — regression case, preference pair, and a reviewable training candidate'
        : 'correction without training consent — regression case and preference pair only',
      trainingEligible: signal.consentTraining === true,
    };
  }

  // 4. Ratings are cheap and noisy. They are evaluation and preference data;
  //    they are never, on their own, a reason to change weights.
  if (type === SIGNALS.RATING) {
    const r = Number(signal.rating);
    if (r === 0 || Number.isNaN(r)) {
      return { lanes: [LANES.DISCARD], reason: 'neutral rating carries no direction', trainingEligible: false };
    }
    return {
      lanes: r < 0 ? [LANES.EVAL, LANES.PROMPT] : [LANES.PREFERENCE],
      reason: r < 0
        ? 'negative rating — worth a regression case and a prompt review, not a weight change'
        : 'positive rating — weak preference evidence',
      trainingEligible: false,
    };
  }

  // 5. A regenerate is dissatisfaction the user did not bother to explain. It is
  //    a good ROUTING signal (this model/provider is underperforming for this
  //    kind of prompt) and a weak quality signal.
  if (type === SIGNALS.REGENERATE) {
    return {
      lanes: [LANES.ROUTING, LANES.EVAL],
      reason: 'implicit dissatisfaction — informs model routing and is worth a regression case',
      trainingEligible: false,
    };
  }

  // 6. Acceptance is the weakest positive. Useful in aggregate for preference
  //    data; meaningless individually, because people copy wrong answers too.
  if (type === SIGNALS.ACCEPTED) {
    return { lanes: [LANES.PREFERENCE], reason: 'accepted answer — weak positive', trainingEligible: false };
  }

  return { lanes: [LANES.DISCARD], reason: 'unhandled', trainingEligible: false };
}

/**
 * Normalise a raw submission into the record that gets stored.
 *
 * Redaction happens HERE, so the caller cannot accidentally persist the raw
 * text. Returns { ok: false } for anything unusable rather than storing junk.
 */
export function prepareFeedbackRecord(raw = {}, { now = () => new Date() } = {}) {
  const type = String(raw.type || '');
  if (!Object.values(SIGNALS).includes(type)) {
    return { ok: false, error: 'unknown feedback type' };
  }

  const input = redact(raw.input);
  const output = redact(raw.output);
  const correction = redact(raw.correction);

  const routed = routeSignal({
    type,
    input: input.text,
    output: output.text,
    correction: correction.text,
    rating: raw.rating,
    consentTraining: raw.consentTraining === true,
    provider: raw.provider,
    model: raw.model,
  });

  if (routed.lanes.length === 1 && routed.lanes[0] === LANES.DISCARD) {
    return { ok: false, error: routed.reason, discarded: true };
  }

  return {
    ok: true,
    record: {
      type,
      // Redacted text only. There is no column for the original.
      input: input.text,
      output: output.text,
      correction: correction.text || null,
      rating: Number.isFinite(Number(raw.rating)) ? Math.sign(Number(raw.rating)) : null,
      // PROVENANCE. Which backend and model produced the answer being judged.
      // Without it, a rating cannot be attributed, and a dataset built from
      // these rows would mix models and teach the average of all of them.
      provider: raw.provider ? String(raw.provider).slice(0, 40) : null,
      model: raw.model ? String(raw.model).slice(0, 120) : null,
      prompt_version: raw.promptVersion ? String(raw.promptVersion).slice(0, 40) : null,
      // Routing decision, stored so a curator can see WHY a row is where it is.
      lanes: routed.lanes,
      route_reason: routed.reason,
      // Consent is recorded as a fact about this submission, not a global flag.
      consent_training: raw.consentTraining === true,
      training_eligible: routed.trainingEligible,
      redactions: input.redactions + output.redactions + correction.redactions,
      created_at: now().toISOString(),
    },
  };
}

export default {
  SIGNALS, LANES, redact, routeSignal, isDeliveryProblem, prepareFeedbackRecord,
  MIN_CORRECTION_CHARS, MAX_TEXT_CHARS,
};
