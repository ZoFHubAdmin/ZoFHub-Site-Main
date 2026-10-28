# The AI system: one request, text only

> **Where the AI runs: in the visitor's browser.** ZoFHub's server performs no
> model inference and has **no AI route at all** — there is nothing left that
> could receive a prompt. Every answer comes from one `GET` the visitor's own
> browser makes to `text.pollinations.ai`, on their own connection and quota
> rather than through one shared server IP.

---

## 1. The whole thing

```
   the composer                      the visitor's browser
   on /ai or the orb  ──prompt──▶  GET https://text.pollinations.ai/<encoded prompt>
                                            │
                                            │  200, text/plain
                                            │  Access-Control-Allow-Origin: *
                                            ▼
   the message list  ◀──response.text()──  the body IS the answer
```

One request. No API key, no login, no model negotiation, no streaming protocol,
no provider choice, and no server of ours anywhere in the path.

`public/js/pollinations.js` is the only place that builds it:

```js
export const ENDPOINT = 'https://text.pollinations.ai/';

export function buildPromptUrl(prompt) {
  const text = fitToUrlBudget(String(prompt ?? '').trim());
  if (!text) throw ...;
  const url = ENDPOINT + encodeURIComponent(text);       // encoded exactly once
  if (new URL(url).origin !== ENDPOINT_ORIGIN) throw ... // the prompt cannot move the host
  return url;
}
```

`encodeURIComponent` escapes `/`, `?`, `#` and `&`, so a prompt cannot add a
path segment, a query string or a fragment; and it leaves the unreserved set
alone, which is legal in a path segment and keeps ordinary prose readable in a
network log. The origin is re-checked on the built URL so that stays true even
if someone later "simplifies" the encoding away.

### Why it looks like this now

The previous version tried **three routes in sequence** and made **two extra
round-trips before the first one could start**:

| # | Step | Problem |
|---|---|---|
| 1 | `await getPublishableKey()` → `fetch('/api/ai/key')` | **our own server**, on the AI path |
| 2 | `await freeModelName()` → `fetch('…/models')` | a second blocking round-trip |
| 3 | `POST /openai` with `Content-Type: application/json` | not a CORS-safelisted content type, so a **preflight OPTIONS** had to complete first |
| 4 | `GET /<prompt>` | the route that actually works |
| 5 | `POST /api/ai/text` (on localhost) | our server **relaying the prompt** |

Each one is a way to fail or stall before reaching the endpoint, and the budgets
made a stall expensive: `CONNECT_MS` 15s + `FIRST_BYTE_MS` 45s on the POST, then
a 45s GET, plus backoff between them. A single message could sit for **over a
minute** and still end up on route 4. That is what "the AI doesn't answer"
looked like from a chair.

Routes 1, 2, 3 and 5 are gone. What is left is route 4, alone, with no preflight
(a GET with no custom headers is a *simple* cross-origin request) and no
same-origin hop to go wrong. One bounded 60s timeout replaces the chain.

### The failure, reproduced

Not inferred from the code — measured in a real browser against both versions,
by driving the actual `/ai` page and recording every network event:

**Before** (the committed code, `http://127.0.0.1` origin):

```
composer ready at  372ms;  answer NEVER ARRIVED (gave up at 120s)
     330ms  GET  /api/ai/key          -> 200     (our own server)
     405ms  POST /api/ai/text         -> (no response in 120s)
rendered: ""
```

**After** (this implementation, same page, same prompt):

```
composer ready at  900ms;  answer at 1593ms   (693ms from submit)
     996ms  GET  https://text.pollinations.ai/<encoded prompt>
    1487ms                            -> 200
rendered: "A prime number is a natural number greater than 1 that can be
           divided only by 1 and itself."
```

So the page really did hang with an empty assistant bubble, and the reason is
visible in the trace: `IS_LOCAL` was true on an `http` origin, so
`buildAttempts()` put the **server hop first**. `POST /api/ai/text` never came
back, and because it was attempt *zero* the browser-direct GET — the request
that works, in under a second — was never reached inside the window.

Two distinct faults, and it is worth separating them:

- **The architectural one**, which applied everywhere: our server sat in the AI
  path, so its problems became the feature's problems. That is what this change
  removes, permanently, by deleting the routes.
- **The latency one**, which applied on a production origin: with `IS_LOCAL`
  false the client skipped the server hop and led with `POST /openai` instead —
  a preflighted request on a 15s connect + 45s first-byte budget, in front of
  the GET's own 45s. The module's own comment records a measured ~26.6s median
  time-to-first-token against what had been a 25s budget, i.e. the primary path
  was aborting requests that were about to succeed.

### The origin gate is real, and it keys on the SPELLING of the host

The server hop existed for a stated reason: *"Pollinations' TEXT endpoint blocks
BROWSER fetches from http/localhost origins with a Cloudflare Turnstile 403 (it
keys on the Origin header)."*

**That premise is correct.** Measured with the same prompt in the same second,
varying only the `Origin` header:

| `Origin` | Result |
|---|---|
| `http://localhost:8080` | **403** `{"error":"Missing Turnstile token"}` |
| `http://127.0.0.1:8080` | **200** |
| `https://zofhub.com` | **200** |
| *(no Origin header)* | **200** |

So `localhost` is refused and `127.0.0.1` — the very same server — is not.

> **A correction.** An earlier version of this section claimed the premise "did
> not reproduce". That was wrong: the trace it relied on came from
> `http://127.0.0.1`, which is one of the spellings the gate allows. Testing one
> loopback spelling does not test the other.

**It still does not justify the server hop.** Three reasons:

1. The condition is **local development only**. A deployed https origin is
   served normally, so the hop was dead weight in production — which is where
   every real visitor is.
2. The trace showed the hop **hanging anyway**: `POST /api/ai/text` never
   answered inside 120s, so on localhost it did not rescue the feature, it broke
   it worse than the 403 would have.
3. Relaying prompts through our server is the thing this architecture exists to
   remove.

There is also **no client-side workaround**, and it is worth being clear why: a
browser always sends `Origin` on a cross-origin request, and `mode: 'no-cors'`
would make the response unreadable. So the 403 is **detected and named** instead
— `askAI()` reads the failure body, tags a Turnstile 403 as `origin-blocked`,
and `describeFailure()` tells the developer to open the site at
`http://127.0.0.1:<port>`, which is the one action that works.

---

## 2. Which endpoint, and why — verified, not assumed

Checked against the live API, because the documentation and the deployed service
disagree, and the difference decides whether a keyless browser-direct AI can
exist at all.

| Endpoint | Result |
|---|---|
| `POST https://gen.pollinations.ai/v1/chat/completions` | **Requires `Authorization: Bearer sk_…`.** The docs state "All generation requests require an API key." |
| Legacy `pk_` publishable keys | Still accepted, but the docs say *"Do not mint new ones"*; capped at 1 pollen per IP per hour |
| `GET https://text.pollinations.ai/<prompt>` | **200, keyless** — and the one the site uses |

An `sk_` key is a **server secret** and may never be shipped in a browser
bundle. So the modern documented endpoint is deliberately **not** used: calling
it from a page would mean either leaking a secret or relaying every prompt
through our server, and the second is the thing this architecture exists to
avoid. The legacy `pk_` key is not used either — it bought a higher rate limit
at the price of a `fetch('/api/ai/key')` sitting in front of every AI request.

### The part that makes it possible at all

A cross-origin `fetch` can only **read** a response the other origin permits.
Verified with a browser-shaped request carrying `Origin: https://zofhub.com`:

```
HTTP/1.1 200 OK
Content-Type: text/plain; charset=utf-8
Access-Control-Allow-Origin: *          ← this is the part that matters
Access-Control-Allow-Methods: GET, POST, OPTIONS
```

`Access-Control-Allow-Origin: *` is what makes the body readable from a page.
Without it the browser would hand back an **opaque** response and no amount of
client code would help. `mode: 'no-cors'` is deliberately **not** used for
exactly that reason: it cannot read the body, so it would convert a visible
failure into a silent blank reply.

If the anonymous tier is ever withdrawn, the honest outcome is a visible error —
not a quiet fallback to a paid model, not a server relay, and not a worse model
pretending to be the same feature.

### The throttle is not always a 429

Measured, and worth knowing before debugging a phantom bug: sending two
requests back to back — the `/ai` page, then the floating assistant — produced
**200 and then 404**. The identical second request returned **200** when spaced
out by ~16s.

So this endpoint sometimes expresses its rate limit as a **404**, which is not
what the status code normally means and not what its docs say. Consequences,
both deliberate:

- `describeFailure()` gives 404 its own wording that advises **waiting**, since
  that is what actually works.
- It does **not** set `rateLimited`. That flag starts a countdown and locks the
  composer, and a genuine 404 (the endpoint moving) is indistinguishable from a
  throttled one from inside the browser. Only a real 429 sets it, so the UI
  never counts down on a guess.
- `npm run verify-ai` deliberately **pauses ~16s** before exercising the second
  entry point. Without the pause it failed on a limit it had caused itself —
  which is exactly the false alarm this note exists to prevent.

---

## 3. One client per provider, every entry point

| Entry point | File | Provider(s) |
|---|---|---|
| The `/ai` page (PolliChat) | `public/pollichat.html` + `public/js/pollichat.js` | PolliChat (default) **or** Puter.js, picked in the sidebar switcher |
| The floating bottom-right assistant | `public/js/ai-helper.js` | PolliChat only |

The `/ai` page and the orb both import **`public/js/pollinations.js`** and
nothing else for PolliChat — there is no second endpoint construction, URL
encoding, timeout policy or error-normalisation path for that provider
anywhere in the frontend. Both import it at the **same `?v=`** — a module
specifier is cache-keyed by its full URL, so two different versions would load
the module twice as two independent instances.

### The second provider: Puter.js

`/ai` lists a second option, **Puter.js**, in **`public/js/puter.js`** — a
sibling module to `pollinations.js`, not a branch inside it. Picking it in the
sidebar is the only thing that loads it: `ensurePuter()` injects
`<script src="https://js.puter.com/v2/">` on first use, so a visitor who never
touches the switcher never fetches a byte of it (the CSP allows the origin as
a script source only — see `server.js`'s `scriptSrc`).

The key difference from PolliChat: Puter is **the visitor's own account**.
`puter.ai.chat([...messages], false, { normalize: true, signal })` runs
entirely in that visitor's browser against **their** sign-in and **their**
usage allowance — our server is nowhere in the path, same as PolliChat, but
there is no shared anonymous tier here to rate-limit; a cold session simply
opens Puter's own sign-in popup. `askPuterWithContext()` maps every failure
(no sign-in, usage exhausted, a network fault, a timeout) onto the **same**
typed-`.code` vocabulary `askAI()` uses, so `describePuterFailure()` can reuse
`describeFailure()` for every code the two share and add its own wording only
for the two that are Puter-specific (`auth`, `usage`).

`pollichat.js` keeps a small `PROVIDERS` map — `{ pollichat, puter }`, each
with its own `ask()` and `describe()` — and `respond()` looks up the active
one by `current.provider`. Switching providers never rewrites history or
resends anything; it only decides which client the *next* message uses, and
that choice is remembered per visitor (`localStorage['pollichat:provider:v1']`)
and per saved chat (continuing an old chat continues it on the provider it was
using).

### History is shared, not per-page

Every saved conversation — started on `/ai` or via the floating orb — is one
list: `store.chats` in `public/js/storage.js` (`localStorage['zofhub:v2:chats']`),
bounded to 40 chats of up to 80 messages each. `/ai`'s sidebar reads and writes
that same list, so a chat started from the orb on a game page shows up, and is
deletable, from `/ai`'s History panel, and vice versa. Nothing in it ever
leaves the browser it was written in.

```
askAI(prompt)              one GET, one bounded timeout, typed errors
  ├─ askWithContext(msgs)  folds system prompt + last 8 turns into one string
  └─ askPrompt(prompt)     a standalone question with the system prompt applied
```

### Failure is typed, and never silent

`askAI` throws an `Error` carrying a `.code`, so each caller can say something
specific and true instead of one generic apology:

| `.code` | Shown as |
|---|---|
| `offline` | "Couldn't reach the AI service. Check your connection and try again." |
| `timeout` | "The AI didn't answer in time. The free tier can be slow when it's busy." |
| `http` (429) | the amber rate-limit card with a live countdown and an arming Retry |
| `http` (5xx / 4xx) | the status, and whether it is worth retrying |
| `empty-answer` | "The AI sent back an empty answer. Try rephrasing." |
| `cancelled` | nothing — a newer message superseded this one and owns the UI |

Both entry points pass an `AbortSignal`, so a new message cancels the one it
supersedes (otherwise two overlapping sends resolve in arrival order and the
**older** answer can overwrite the newer one) and `pagehide` cancels in flight.

### What is deliberately not here

| Not present | Why |
|---|---|
| **AI image / audio / video generation** | Not a feature of this site, at any layer. No `image.pollinations.ai` URL builder, no `/image` command, no `/api/ai/image`, `/api/ai/audio` or `/api/ai/video`, no image models. Ordinary site imagery — thumbnails, the preroll, every other `<img>` — was never this and is untouched |
| **Any API key** | The anonymous tier needs none, and an `sk_` secret may never reach a browser |
| **A server fallback** | `/api/ai/text` and `/api/ai/echo` are removed. No same-origin route accepts a prompt |
| **A local inference engine** | The Transformers.js + SmolLM2-360M fallback is gone. It downloaded hundreds of megabytes to answer, in a markedly worse voice, the question the user had just asked the real model — and it ran whenever the network call failed for **any** reason, so an outage looked like the AI had quietly got much worse. A clear, retryable error is the honest outcome |
| **A THIRD provider, or Hugging Face specifically** | Puter.js is the one deliberate second option (§3); Hugging Face is still gone, with the old settings UI and stored token |
| **Model discovery** | `freeTextModels()` / `/models` is gone with the model parameter. The URL API needs no model named, so there is no "is this model free?" question to answer |
| **Fake streaming** | The GET returns the whole answer at once. Splitting finished text into fake chunks would be theatre, so the UI shows typing dots and then the reply |

Two things that look removable but are **kept**:

- **`huggingface.co` in `lib/ai-hosts.mjs`** — that list is a **denylist** of
  inference endpoints this server must never fetch on a caller's behalf.
  Removing the entry would have *allowed* `/asset` and `/thumb` to reach Hugging
  Face, which is the opposite of what the file is for.
- **`aiServerAllowed()` and `AI_FALLBACK_ROUTES`** — a regression guard. The
  routes are gone, but their paths are still refused before routing, so
  re-adding a handler on one of them ships refused rather than open by accident.

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
- **The feedback/eval pipeline (§4–5) covers PolliChat only.** A Puter.js answer
  is generated entirely on the visitor's own account and device; this repo has
  no visibility into it to redact, curate or evaluate, by the same logic that
  makes it browser-direct in the first place.

---

**Related:** [documentation map](../README.md#-documentation) · [how it all fits together](../guides/HOW-IT-WORKS.md) · [why AI traffic never uses the proxy](../proxy/INVISIPROXY.md#6-privacy) · [commands](../guides/COMMANDS.md)
