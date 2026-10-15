# The AI system: one provider, text only

> **Where the AI runs: in the visitor's browser.** ZoFHub's server performs no
> model inference. `/api/ai/text` and `/api/ai/echo` return **403
> `client_side_only`** in production, and that is deliberate — the AI is free
> because each request goes out on the visitor's own connection and quota rather
> than through one shared server IP.

---

## 1. One provider, and what was removed

The AI used to host **four** implementations at once: Pollinations text,
Pollinations image generation, Hugging Face (the visitor's own token) and
Puter.js (the visitor's own account, billed to their credits). The AI page
carried a provider picker asking visitors to choose between them.

That is gone. The AI is now **text-only, single-provider**:

| Removed | What went with it |
|---|---|
| **AI image generation** | the `/image` `/img` `/draw` commands, `handleImage()`/`preloadImage()` and the image rendering branch in `public/js/ai.js`, `pollImageUrl()`/`pollImageShieldUrl()` in `public/js/pollinations.js`, the `GET /api/ai/image` route, the image-model lookup in `resolveModels()`, the `image` provider catalogue and the `flux` fallback in `lib/ai-providers.mjs`, and the `/image` suggestion card |
| **Hugging Face** (`@huggingface/inference`) | `public/js/hf-inference.js`, `public/js/hf-models.js`, the `/hf/` same-origin mount, the `huggingface` field on `/api/ai/providers`, the token field in `public/ai.html`, the dependency |
| **Puter.js** | `public/js/puter-ai.js`, `public/js/ai-provider.js`, the `https://js.puter.com` CSP `script-src` allowance, the model picker, the dependency |
| **The provider picker** | `public/js/ai-settings.js` and the whole `<details class="ai-settings">` panel |

**Ordinary site imagery is unrelated and untouched** — game thumbnails, the
preroll and every other `<img>` were never generated.

Two things that look like the above but are **kept**:

- **`@huggingface/transformers`** (Transformers.js) in `public/js/ai.js` — the
  on-device offline fallback. It is a different package from
  `@huggingface/inference`, runs entirely in the browser, and is what answers
  when the device has no working network at all.
- **`huggingface.co` in `lib/ai-hosts.mjs`** — that list is a **denylist** of
  inference endpoints this server must never fetch on a caller's behalf.
  Removing the entry would have *allowed* the proxy to reach Hugging Face, which
  is the opposite of what the file is for.

---

## 2. Which endpoint, and why — verified, not assumed

Checked against the live API on **2026-10-15**, because the documentation and the
deployed service disagree, and the difference decides whether a keyless
browser-direct AI can exist at all.

| Endpoint | Result |
|---|---|
| `POST https://gen.pollinations.ai/v1/chat/completions` | **Requires `Authorization: Bearer sk_…`.** The docs state "All generation requests require an API key." |
| Legacy `pk_` publishable keys | Still accepted, but the docs say *"Do not mint new ones"*; capped at 1 pollen per IP per hour |
| `GET https://text.pollinations.ai/<prompt>` | **200, keyless** |
| `POST https://text.pollinations.ai/openai` | **200, keyless**, OpenAI-compatible, streams |
| `GET https://text.pollinations.ai/models` | **200, keyless** |

An `sk_` key is a **server secret** and may never be shipped in a browser
bundle. So the modern documented endpoint is deliberately **not** used: calling
it from a page would mean either leaking a secret or relaying every prompt
through our server, and the second is the thing this architecture exists to
avoid.

The **anonymous tier on `text.pollinations.ai`** is therefore the only genuinely
free, browser-direct, no-secret option, and it is what the site uses.

If that tier is ever withdrawn, the honest outcome is a visible unavailable
state — not a quiet fallback to a paid model and not a server relay.

### The free-only policy is evidence-based

`GET /models` returns a **`tier`** field per model:

```json
[{"name":"openai-fast","description":"GPT-OSS 20B Reasoning LLM (OVH)",
  "tier":"anonymous","reasoning":true,
  "input_modalities":["text"],"output_modalities":["text"]}]
```

That field is what the policy rests on. `freeTextModels()` in
`public/js/pollinations.js` keeps a model only when:

1. its `tier` is explicitly in `FREE_TIERS` (currently `anonymous`), **and**
2. it actually takes text in and gives text out.

An **unknown or unrecognised tier stays disabled** — "we could not establish
that this is free" is not the same as "free", and must never render as *Free*.
Discovery is cached for 30 minutes and **never blocks a send**: on any failure it
resolves to `[]` and the client falls back to the verified default
(`openai-fast`). If discovery succeeds and the default is no longer in the free
set, the first discovered free model is used instead — which is how this survives
the provider retiring a model without needing a deploy.

---

## 3. One client, every entry point

| Entry point | File |
|---|---|
| The `/ai` page | `public/js/ai.js` |
| The floating bottom-right assistant | `public/js/ai-helper.js` |

Both import **`public/js/pollinations.js`** and nothing else. There is no second
endpoint construction, model selection, timeout policy or error-normalisation
path anywhere in the frontend.

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
npm run eval-ai            # Pollinations is the only provider
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
