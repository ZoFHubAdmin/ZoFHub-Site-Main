# The AI system: providers, feedback, evaluation

> **Where the AI runs: in the visitor's browser.** ZoFHub's server performs no
> model inference. `/api/ai/text`, `/api/ai/echo` and `/api/ai/image` return
> **403 `client_side_only`** in production, and that is deliberate — the AI is
> "free and unlimited" precisely because each request goes out on the visitor's
> own connection and quota rather than through one shared server IP.
>
> Everything below follows from that. It is why Hugging Face appears here as a
> browser client and a set of offline operator tools, and **not** as a server-side
> inference stack.

---

## 1. Why a second provider exists

The AI had exactly one text backend (Pollinations). Two measurements, taken from
a production origin against the live endpoint, are why that changed:

| Measurement | Result |
|---|---|
| Streaming path, 12 sequential attempts | **6 returned an empty stream** |
| Surviving GET fallback | 100% success, **p50 32.5s**, p95 43.9s |
| Time-to-first-token (streaming) | 16.0s / 26.3s / 27.2s / 27.3s — **median ~26.6s** |
| Eval run, 10 sequential requests | **7 returned HTTP 502** |

Two distinct faults, both now addressed:

**The client was aborting working requests.** `FIRST_BYTE_MS` was `25000`, and
the median time-to-first-token was ~26.6s. The browser gave up roughly a second
before the model spoke, then waited ~32s for the slow fallback. It is now
`45000` — clear of the observed p95 with headroom, and still under `GET_MS` so
a hung stream leaves time for the fallback inside one send.
(`public/js/pollinations.js`)

**One provider is one point of failure.** Hugging Face Inference Providers route
a request across several independent companies, so a single outage is
survivable. It is **opt-in** and changes nothing for a visitor who does not
configure it.

---

## 2. What is actually integrated, and what is not

Integration means the application executes the code. Anything else is a
dependency pretending to be a feature.

### Integrated

| Component | Where | Why |
|---|---|---|
| **`@huggingface/inference`** (huggingface.js) | `public/js/hf-inference.js`, served from `/hf/` | A real second text provider. Called from the browser with the user's own token. |
| **`@huggingface/transformers`** (Transformers.js) | `public/js/ai.js` | Already present: SmolLM2-360M runs on-device when the network fails. Unchanged. |
| **`datasets`** (Python) | `tools/curate-ai-dataset.py` | Dedup, quality filtering, fixed splits and per-split fingerprints for curated feedback. Operator-only. |

### Deliberately NOT integrated

These were evaluated against this codebase and excluded. Adding them would have
produced imports with no execution path.

| Component | Why not |
|---|---|
| **`transformers`** (Python) | There is no server-side inference path to host it. `/api/ai/*` is 403 in production by design, and `lib/vibe-engine.mjs` is a deterministic ranker over `data/game-attributes.json` — it calls no model. |
| **`accelerate`** | Solves distributed/multi-GPU execution and mixed precision. This deploys as a single Node container on Render with no GPU and runs no training. |
| **`optimum`** | Hardware-specific export and quantisation for Python model runtimes. Nothing here runs a Python model, so there is nothing to optimise. The browser path already uses ONNX + q4 via Transformers.js. |
| **OpenEnv** | "An interface library for RL post training with environments." There is no RL loop, no policy, no rollout. |

If server-side inference is ever introduced, `optimum` and `accelerate` become
relevant in that order. Today they would be ceremony.

---

## 3. The Hugging Face provider

**The token is the user's and never reaches this server.** Hugging Face has no
anonymous inference tier — verified, not assumed: a tokenless call fails with
`InferenceClientRoutingError`. So the visitor supplies their own free token in
**AI settings**, it is stored in their browser's `localStorage`, and the request
goes from their browser straight to Hugging Face.

There is no endpoint on this server that accepts an `hf_` token. That is asserted
by a live test which records every request the page makes and fails if the token
appears in any of them.

**The model list is an allow-list** (`HF_TEXT_MODELS` in [`public/js/hf-models.js`](../../public/js/hf-models.js)), and every entry was
verified against the live Hub with
`GET /api/models/<id>?expand[]=inferenceProviderMapping`:

| Model | Live providers |
|---|---|
| `meta-llama/Llama-3.1-8B-Instruct` *(default)* | novita, nscale, featherless-ai, deepinfra |
| `meta-llama/Llama-3.3-70B-Instruct` | novita, together, featherless-ai, scaleway, ovhcloud |
| `Qwen/Qwen2.5-Coder-32B-Instruct` | nscale, featherless-ai |
| `Qwen/Qwen2.5-7B-Instruct` | featherless-ai |
| `google/gemma-2-2b-it` | featherless-ai |

`HuggingFaceTB/SmolLM3-3B` is **excluded**: the model exists and looks like an
obvious fit, but no provider serves it, so offering it would put a menu entry in
front of users that fails at request time. It remains a fine *local* model.

Failover orders by **provider count, not parameter count** — a model four
companies serve is worth more for "the user gets an answer" than a larger one
behind a single provider.

The client library is served from **`/hf/`, our own origin**, not a CDN. This
site exists because school networks block things; a filtered `cdn.jsdelivr.net`
must not be able to take the AI down.

### Configuration

Nothing is required. A user who wants the second provider opens **AI settings**
on `/ai` and pastes a token from <https://huggingface.co/settings/tokens>.

For the **operator** evaluation tool only, `HF_TOKEN` may be set in the
environment. It is never read from a user's browser and never written to a file.

---

## 4. The feedback pipeline

The naive design — collect thumbs-down, fine-tune, ship — degrades a working
system. This one routes each signal to the mechanism that can actually fix it.

```
user rates / corrects / reports  →  POST /api/ai/feedback
        │
        ├─ redact()          emails, phones, cards, API tokens, addresses, IPs
        │                    BEFORE insert. No column holds the original.
        ├─ routeSignal()     which mechanism may this influence?
        └─ insert            ai_feedback, RLS deny-by-default
                 │
                 └─ human review  →  approved
                          │
                          └─ curate-ai-dataset.py  →  sft / preference / eval
                                     │                 + manifest (provenance)
                                     └─ eval-ai.mjs  →  promote or refuse
```

### Routing (`lib/ai-feedback.mjs`)

| Signal | Goes to | Never |
|---|---|---|
| Delivery failure, empty answer | `routing` | any training lane |
| Report (unsafe) | `safety`, `eval` | training |
| Correction, no consent | `eval`, `preference` | `sft_candidate` |
| Correction, with consent | `eval`, `preference`, `sft_candidate` | auto-promotion |
| Rating −1 | `eval`, `prompt` | training |
| Rating +1 / accepted | `preference` | training |
| Regenerate | `routing`, `eval` | training |

**The first row is the important one.** ZoFHub's measured failure is a provider
returning an empty stream or a 502 — during one eval run, 7 of 10 requests
502'd. Every one looks to the user like "the AI gave a bad answer". Routed into
a training set, the most common example in the corpus becomes a prompt whose
target output is nothing. `isDeliveryProblem()` catches these *before* any other
rule, including the literal failure text the UI shows.

### Privacy

- **Redaction on arrival**, not on export. A raw copy would outlive it in backups.
- **Consent is per submission** and defaults to false. `consentTraining` must be
  boolean `true` — `'true'`, `1` and `'yes'` all fail closed.
- **No identity**: no user id, no conversation id, no IP. The rate limiter sees
  an IP because it must; it writes it nowhere.
- **A client cannot self-promote**: `training_eligible` is computed server-side
  *and* pinned `false` by the RLS insert policy, so a forged PostgREST insert
  cannot smuggle a row into the training pool.
- **Retention**: `prune_ai_feedback()` deletes unreviewed rows after 180 days.
- **Erasure**: `forget_ai_feedback(text)` deletes by exact submitted text — the
  only honest handle when there is deliberately no user id.

### Curation (`tools/curate-ai-dataset.py`)

Four refusals, each verified by fixture:

1. rows not `approved` by a human;
2. `sft` without `consent_training` **and** `training_eligible`;
3. **eval rows never enter training** — otherwise the eval set measures
   memorisation and every later number is meaningless;
4. no dataset without a manifest naming source rows, code version, `datasets`
   version and per-split fingerprints.

Also filtered: duplicates (content-hashed over task+target, so the same
correction through two models counts once), prompt-injection shapes, heavily
redacted rows, and "corrections" identical to the output.

---

## 5. Evaluation and promotion

`npm run eval-ai` runs `data/ai-eval-set.json` — 10 machine-checkable cases
across instruction-following, structured output, correctness, factuality,
safety and token efficiency. Every check is deterministic: a suite scored by a
human or another model cannot gate a deploy.

```bash
npm run eval-ai                                  # against the default provider
npm run eval-ai -- --provider huggingface --model meta-llama/Llama-3.1-8B-Instruct
npm run eval-ai -- --set-baseline                # record a baseline
```

**The gate refuses more than it accepts** (`lib/ai-eval.mjs`):

- any regression in a **critical** category (`safety`, `factuality`) blocks
  outright — no pass-rate improvement buys back a broken safety refusal;
- **any** ordinary regression blocks by default (`maxRegressions: 0`);
- a pass-rate fall beyond tolerance blocks;
- **no baseline never promotes** — the first run establishes a baseline, it does
  not win against nothing.

Two safeguards worth knowing:

- **Provider errors are not model failures.** A 502 is recorded as an error, not
  a wrong answer, so an outage cannot look like a quality regression.
- **A baseline is refused** if more than a quarter of cases hit provider errors.
  A baseline recorded during an outage makes every later run look like progress.

The runner exits non-zero on a blocked promotion, so it can be a CI gate rather
than a report.

**Rollback** is configuration: the model is chosen per request from the
catalogue, with no build step and nothing baked in. Reverting is changing the
selected id, or clearing the token to fall back to the default provider.

---

## 6. Operations

```bash
npm run eval-ai                # evaluate + promotion verdict
npm run curate-ai -- --dry-run # what would be curated, and what is rejected
npm run curate-ai              # write the versioned dataset + manifest
```

**Apply `db/15_ai_feedback.sql`** in the Supabase SQL editor. Until then the
endpoint degrades to `503 "Feedback is not available right now."` rather than
failing — verified.

`datasets` is an **operator-only** Python dependency and must not be installed
in the web container. This repo has a `.venv` and `tools/run-python.mjs`
correctly prefers it, so install into *that* interpreter:

```bash
.venv/Scripts/python.exe -m pip install "datasets>=3.0,<5"   # Windows
.venv/bin/python -m pip install "datasets>=3.0,<5"           # POSIX
```

The tool prints its own `sys.executable` when the import fails, because
installing into the wrong Python is the failure people hit twice.

`data/ai-feedback-export.json` and `data/ai-datasets/` are **gitignored**. They
contain material people typed at the AI — redacted, consented and reviewed, and
still not something to commit to a repository with a remote.

---

## 7. Known limitations

- **Redaction is a harm reducer, not anonymisation.** It cannot find a name, a
  school, or "my teacher Mr X". Consent, not redaction, is what gates training use.
- **No fine-tuning is performed by this repo.** The pipeline produces curated,
  consented, versioned datasets and an evaluation gate. Running a training job
  is a deliberate, separate, human-initiated act — by design.
- **Safety scoring is coarse.** The safety case checks that a refusal is present,
  which is unambiguous but shallow.
- **The eval set is small (10 cases).** It is a regression gate, not a benchmark.
  Feedback-derived eval rows extend it through curation.

---

**Related:** [documentation map](../README.md#-documentation) · [how it all fits together](../guides/HOW-IT-WORKS.md) · [why AI traffic never uses the proxy](../proxy/INVISIPROXY.md#6-privacy) · [commands](../guides/COMMANDS.md)
