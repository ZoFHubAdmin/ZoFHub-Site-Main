# The catalog freeze

> **The catalog is a curated set of a fixed size, and nothing adds to it
> automatically.** Every scheduler that used to has been removed, and the rule
> that keeps them gone lives at the point of the write, not in the wiring.

---

## 1. Why this exists, and what it reversed

The site used to grow itself. Three jobs added games on a timer:

| Job | Cadence | What it did |
|---|---|---|
| `grow` | every 36 h | upserted +30 render-verified games into Supabase |
| `y8-sync` | weekly | upserted Y8's whole ~2,400-game embed directory |
| `gd-import` | weekly | imported whatever the GameDistribution feed held |

A fourth, an in-process interval in `server.js`, promoted +30 games into the
*displayed* roster on the same 36-hour clock.

**The observable consequence.** `data/active-roster.json` had reached **129
slugs**, so the site was serving 129 games while every surface described it as a
100-game catalog. The cap could not correct it, because `reconcileRoster` treated
the target as a **floor** — deliberately, so the grow job could push past it.

The product decision is now the opposite one, so the floor became a **hard
ceiling** and the growth machinery was deleted.

---

## 2. How "exactly 100" is enforced

Two independent mechanisms, which is the point — neither relies on the other.

### The serve-time cap

`ACTIVE_GAMES_CAP` (default `100`) is applied in `setCatalog()`, the single
chokepoint both catalog build paths already funnel through (the bundled load and
the Supabase refresh). So the cap reaches every public surface — homepage,
categories, search, `/api/games`, the sitemap, `/play` — with no per-endpoint
gating.

It is a **ceiling**: `reconcileRoster` truncates a roster that is over it.

**Which games survive a truncation:** the front of the roster. Growth appended,
so the first 100 entries are exactly the originally-seeded 100 — trimming removes
what the grow job added rather than picking a fresh arbitrary 100 and breaking
every bookmark. The 129 → 100 correction therefore happened by itself on the next
catalog build, with no migration.

`ACTIVE_GAMES_CAP=0` disables the cap and serves the whole catalog. That is the
escape hatch, and it is what the integration suite spawns with, because it
asserts full-catalog behaviour (pagination over thousands of rows).

### The write-time gate

"Nothing calls the importer" is a property of today's wiring, not a rule. So the
rule sits at the write:

- `growCatalogOnce()` and `ingestY8()` **refuse any non-dry-run write** without
  an explicit `confirm`. Only an operator passes one
  (`npm run grow -- --confirm`). Re-adding a schedule would still not add a game.
- A **dry run is always allowed** — it writes nothing, and that is what makes
  discovery possible without changing the catalog.

`test/catalog-frozen.test.mjs` asserts the negative requirement against the real
wiring: it reads the **live cron registry** and fails if `grow`, `y8-sync` or
`gd-import` ever reappear, and pins the remaining eight jobs as maintenance-only.

---

## 3. Adding games on purpose

### The unlock

Beyond the baseline, adding is refused unless **"Allow manual game additions
beyond the baseline"** is in force. It is a typed setting
(`catalog.manual_add_unlocked`) and it requires all three of:

1. the **`catalog.unlock` permission** — held by `owner` and `super_admin`
   **only**. It is absent from the `admin` role's enumerated list and from every
   `SERVICE_ROLE`, so neither an ordinary administrator nor a static bearer token
   can open the catalog;
2. **re-authentication** — the setting carries `reauth: true`, which a bearer
   token can never satisfy because a token in a cron file is not a person who can
   be asked to confirm;
3. a **time limit** — 5 minutes to 24 hours, default 60. Expiry is evaluated on
   every read rather than by a timer, so an unlock written before a deploy is
   already expired after it, with nothing needing to have run in between.

Forgetting to re-lock is therefore self-correcting.

**Unlocking enables no importer.** There is none left to enable, and
`describeLock()` says so explicitly (`affectsSchedulers: false`) so an operator
cannot read the control as "turn the weekly import back on".

### Where the gate bites: publication, not creation

A new game is created as a **draft**, and a draft is not in the approved catalog
— visitors cannot see it. So:

- **`createGame` is not gated.** Refusing draft creation would break the
  draft → review → publish lifecycle while protecting nothing.
- **`transition('publish')` is gated.** Publishing is the act that makes a game
  public, and each publish is judged against the live published count — so "build
  50 drafts, then publish them all" does not get past the baseline.
- **`importFromProvider` is gated on the whole batch**, not row by row, so a
  locked catalog cannot be grown by 400 games because each insert looked like
  "just one more".

Below the baseline there is **headroom** and no ceremony: an archived game's slot
can be refilled as ordinary editorial work. That matters for recovery.

The gate is **injected** into the CMS service and **fails closed** — if the
settings read throws, the answer is 503, not "allow".

---

## 4. Operating it

| Question | Where |
|---|---|
| Is the catalog open right now? | `controlStatus().catalog` — baseline, published count, headroom, whether an unlock is live and how long is left |
| What does the refusal look like? | HTTP **409** with `needsUnlock: true` and the baseline/count, so the console can offer the unlock control. 409 not 403: the caller is authorised; the catalog's state is what refuses them |
| Add games deliberately | Unlock in the console, then publish from the CMS. Or, as an operator, `npm run grow -- --confirm` |
| Inspect candidates without changing anything | `npm run grow -- --dry-run`, or `node lib/y8-ingest.mjs --dry-run` |

### Environment

```text
ACTIVE_GAMES_CAP=100   # how many games the public site shows; 0 disables the cap
CATALOG_BASELINE=100   # the size the freeze is enforced against (defaults to the cap)
GROW_TARGET=30         # games per OPERATOR-RUN grow
```

`GROW_INTERVAL_HOURS` is **gone** — there is no cadence left to tune.

---

## 5. What this does not claim

- It does not stop an operator with the service key writing directly to the
  database. `tools/add-game.mjs` and `tools/restore-games.mjs` use that key by
  design. The freeze governs the application's own write paths and the schedulers;
  it is not a database-level permission boundary against its own administrator.
- The roster file is **local runtime state** (`data/active-roster.json`,
  gitignored). On an ephemeral host it is rebuilt from the pool on boot, which
  yields the first N in pool order — stable across restarts only as long as the
  pool ordering is.

---

## 6. Related

- `lib/catalog-lock.mjs` — the policy (pure, clock-injected)
- `lib/active-roster.mjs` — the serve-time cap and the reversal note
- `lib/cron-jobs.mjs` — the remaining eight maintenance jobs, and what was removed
- `test/catalog-lock.test.mjs`, `test/catalog-frozen.test.mjs`
