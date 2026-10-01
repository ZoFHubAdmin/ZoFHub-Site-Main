# The admin control plane

The console at `/admin` is where the site is **changed**, not only watched:
games and their lifecycle, providers, categories and tags, staff accounts, typed
settings, the proxy's approved destinations and limits, and the audit trail that
records all of it.

| | |
|---|---|
| Schema | [`db/control-plane.sql`](../../db/control-plane.sql) → migration `20260101001080_control_plane` |
| Permissions and roles | [`lib/admin-rbac.mjs`](../../lib/admin-rbac.mjs) |
| HTTP API | [`lib/admin-api.mjs`](../../lib/admin-api.mjs) — every route through one gating helper |
| Content rules | [`lib/cms-rules.mjs`](../../lib/cms-rules.mjs), [`lib/cms-service.mjs`](../../lib/cms-service.mjs) |
| Providers | [`lib/provider-registry.mjs`](../../lib/provider-registry.mjs) |
| Staff | [`lib/staff-service.mjs`](../../lib/staff-service.mjs), [`lib/admin-auth.mjs`](../../lib/admin-auth.mjs) |
| Settings | [`lib/settings-registry.mjs`](../../lib/settings-registry.mjs), [`lib/settings-service.mjs`](../../lib/settings-service.mjs) |
| Proxy governance | [`lib/proxy-control.mjs`](../../lib/proxy-control.mjs), [`lib/proxy-service.mjs`](../../lib/proxy-service.mjs) — see [proxy/GOVERNANCE.md](../proxy/GOVERNANCE.md) |
| Audit redaction | [`lib/audit-redact.mjs`](../../lib/audit-redact.mjs) |
| Console UI | [`admin-ui/assets/admin-control.js`](../../admin-ui/assets/admin-control.js) |
| GameDistribution import | [features/GAMEDISTRIBUTION.md](../features/GAMEDISTRIBUTION.md) |

---

## 1. Before it works: apply the migration

**Nothing in this document is live on a database until
`supabase/migrations/20260101001080_control_plane.sql` has been applied.** It
arrives through the Supabase GitHub integration when committed to `main`, or by
pasting [`db/control-plane.sql`](../../db/control-plane.sql) into the SQL editor.

Until then:

- the **public site is unchanged** — the migration's only effect on it is to make
  the public read path require `status = 'published'`, and every existing game
  defaults to `published`;
- the console's Content, Staff, Settings and Proxy-control sections answer
  **503 with the reason**, and the Overview says so;
- the **proxy refuses every destination** except those in
  `PROXY_APPROVED_TARGETS` — it fails closed, not open (§7);
- the server re-checks every five minutes, so applying the migration later needs
  no restart.

With **no database configured at all** (local development, the test suite) the
control plane runs **in memory**: it works, and nothing is saved. The console
says so on every Content page.

---

## 2. Who can do what

Authorisation is decided **on the server, twice**: the route checks a coarse
permission (`requirePerm`), then the service decides the specific action — may
*this* actor publish *this* game from *this* state. A hidden button is a
courtesy, never a control.

### Principals

| Principal | How it signs in | Role |
|---|---|---|
| The **owner** | `ADMIN_USERNAME` / `ADMIN_PASSWORD_HASH` in the environment | `owner` — everything; cannot be changed or locked out from the console |
| A **staff account** | username + password, created in the console | one of the six staff roles below |
| The **service token** | `Authorization: Bearer $ADMIN_SECRET` | `ADMIN_SERVICE_ROLE` — `operator` by default; **never** `admin` or above |

There are **no visitor accounts** and this work adds none. "Users" in the
console are staff.

### Roles

| Role | Can | Cannot |
|---|---|---|
| `super_admin` | everything | — (only the owner can create one, and two super admins cannot act on each other) |
| `admin` | run the platform: content, review, publish, bulk, import, providers, taxonomy, staff below admin, settings, ads, proxy destinations/limits/engines/sessions | change roles, delete accounts, permanently delete games, revoke other people's sessions |
| `content_manager` | create and edit drafts, submit for review | approve, publish, configure anything |
| `moderator` | approve / reject games, moderate community content | publish, create, configure |
| `analyst` | read metrics, the catalog and proxy health | change anything |
| `support` | answer feedback, moderate community posts | change content or configuration |

The full permission list is `PERMISSIONS` in
[`lib/admin-rbac.mjs`](../../lib/admin-rbac.mjs). A permission the model does not
know is **refused**, and so is a role it does not know — that used to resolve to
`owner`, harmless while nothing set a role and a full escalation once the
database does.

### Rules that hold for every staff action

- **You only act on roles below your own.** Nobody acts on themselves through the
  staff screens.
- **Privilege changes end sessions.** Role change, suspension, password reset and
  deletion revoke every live session of that account; a suspended account's
  session dies on its next request even without that.
- **Step-up confirmation.** Permanent deletion, role changes, approving a proxy
  destination, raising a proxy limit, widening a provider's origins, suspending a
  provider and turning on maintenance mode all require the password to have been
  re-entered on *this* session within five minutes (`POST /api/admin/auth/reauth`).
  A service token can never satisfy it.
- **Temporary passwords are shown once.** Created or reset accounts get a random
  temporary password, returned in that one response, stored only as an scrypt
  hash, never written to a log or audit record. Until it is changed, the account
  can do nothing but change it.

---

## 3. The game lifecycle

```text
 draft ──submit──▶ pending_review ──approve──▶ approved ──publish──▶ published
   ▲                   │  │ reject                                     │ unpublish
   └──── reopen ──── rejected                               unpublished ◀┘
                                                                  │ archive
                                                   archived ◀──────┘   (restore → unpublished)
```

| Move | Permission |
|---|---|
| submit, withdraw, reopen | `games.update` |
| approve, reject (reason required) | `games.review` |
| publish, unpublish | `games.publish` |
| archive, restore | `games.archive` |
| permanent delete (archived only, slug typed back, fresh password) | `games.delete` |

**A game is public only when it is `published` AND `is_working`.** `is_working`
is still the link checker's verdict; `status` is the editorial one. Both the RLS
policy on `games` and the `games_public` view require both, so a draft is not
readable even with the publishable key.

**Re-pointing a reviewed game re-opens review.** Changing the embed URL,
provider or thumbnail of an approved/published/unpublished game sends it back to
`pending_review` — unless the editor holds `games.publish`. Otherwise a content
manager could take an approved game and point it somewhere else.

**Edits are optimistic-concurrency checked.** The editor sends the `updated_at`
it loaded; if someone else saved in between, the edit is refused with 409 rather
than silently overwriting theirs.

**Deletion keeps a record.** The audit entry for a permanent delete stores the
game's slug, title, URLs, provider and category, which is the recovery path.
Archive is the normal "remove"; deletion is for mistakes.

### Bulk operations

Up to 200 games at once. **All-or-nothing**: every target is validated first,
and if any cannot take the change, nothing is written and the response lists
each failure. The status transitions run inside one Postgres function call
(`cms_bulk_transition`), so a concurrent change cannot leave half a batch
applied. Destructive operations (unpublish, archive, remove tag) need the exact
count typed back. Tag operations are per-game and report per game.

### File import and export

Import accepts a JSON array (max 500, 2 MB). It is previewed first, every row
goes through the same validation as the editor, and **imported games arrive as
drafts** — a file never publishes anything. The 2 MB body is parsed only *after*
authentication, authorisation and CSRF have passed.

Export produces JSON or CSV. CSV cells that start with `=`, `+`, `-` or `@` are
prefixed so no spreadsheet evaluates them.

---

## 4. Providers: game → provider → origin → embedding policy

A game must name a provider, and its embed URL must be served from one of **that
provider's approved origins**; its thumbnail from the provider's image origins
or `/thumbs/`. There is no "paste any URL and frame it".

| Status | Existing games | New or re-pointed games |
|---|---|---|
| `approved` | served | accepted |
| `restricted` | served | refused |
| `pending` | withheld | refused |
| `suspended` / `revoked` | **withheld from every public surface at once** | refused |

The migration seeds the providers from the licensing audit
(`tools/audit-licensing.mjs`): GameDistribution, GameMonetize and Y8 `approved`;
OnlineGames.io, HTMLGames, Famobi and GameFlare `restricted`; Gamezop
`suspended` (its embeds carry another publisher's partner id). Suspending a
provider, and adding an origin to one, need a fresh password.

A provider may declare a sandbox policy for its iframes; `allow-scripts`
together with `allow-same-origin` is refused, because that pair lets the framed
document remove its own sandbox.

---

## 5. Settings

Only the keys defined in [`lib/settings-registry.mjs`](../../lib/settings-registry.mjs)
exist. Each has a type, hard bounds and the permission that may change it; a
stored value that fails validation falls back to the default and is reported.

| Key | Effect |
|---|---|
| `site.announcement` | a one-line banner on every public page (plain text, set with `textContent`) |
| `site.maintenance` | public pages and APIs answer **503**; the console, health checks, `/licenses` and the tunnel's refusal stay correct. Needs a fresh password |
| `features.ai` · `community` · `leaderboard` · `donate` · `subscribe` · `feedback` | switching one off makes its **API and page answer 404** — the server stops serving it, the links are removed from pages |
| `catalog.gd_auto_import` | the weekly GameDistribution import |
| `catalog.gd_auto_publish_clean` | publish imported games that pass every licensing check |
| `ads.enabled`, `ads.disabled_networks` | switch advertising, or single networks, **off**. A network can only be switched *on* in the environment, where its tags live; nothing here stores script |

What a setting can **never** be: an environment variable, a secret, code, HTML or
a script URL.

---

## 6. The audit trail

Every privileged action writes a record: actor, actor role, action, resource
type and id, outcome, a request id, and **redacted** before/after values for the
fields that changed. Denials are recorded too (`rbac.denied`), with the role
that was refused.

- **Append-only.** A trigger refuses `UPDATE` and `DELETE` on
  `admin_audit_logs`; the API has no edit path.
- **Tamper-evident.** Each new row stores `sha256(previous hash | its own
  fields)`. **Audit → Verify integrity** (`GET /api/admin/audit/verify`) re-derives
  the chain and names the first record that was altered or inserted outside the
  application — including by someone who disabled the trigger first. Rows written
  before the migration are not chained.
- **No secrets.** [`lib/audit-redact.mjs`](../../lib/audit-redact.mjs) replaces any
  field named like a credential, and any *value* shaped like one (JWTs, Supabase
  keys, bearer headers, PEM blocks, scrypt hashes), whatever key it arrives
  under; it also bounds size.
- **Retention.** Kept at least a year (the floor is in the SQL). Deleting a staff
  account does not delete its audit history — that is the point of the history.
- **Export** is a separate permission (`audit.export`) from reading, and is
  itself audited.

---

## 7. Proxy governance

The proxy engines are kept and served, under explicit control: an
administrator-managed list of **approved destinations** is the only set of hosts
the tunnel will connect to, with access modes, resource limits, engine switches,
live sessions and a record of refusals. The full model is in
**[proxy/GOVERNANCE.md](../proxy/GOVERNANCE.md)**.

---

## 8. Data model and row-level security

Every control-plane table is **RLS deny-by-default with no policy**, and the
migration itself revokes all privileges from `anon` and `authenticated` (on a
live database it runs after `grants.sql`, so it cannot rely on it). Only the
server's secret key can touch them. Verified by executing the migration in
Postgres 17 and switching to each role (`test/control-plane-db.test.mjs`).

| Table | `anon` / `authenticated` | Server (service role) |
|---|---|---|
| `games` | SELECT **published and working rows only** (RLS policy) | all |
| `games_public` (view) | SELECT, same filter (`security_invoker`) | all |
| `admin_users`, `game_providers`, `game_categories`, `game_tags`, `game_tag_links`, `site_settings`, `proxy_providers`, `proxy_targets`, `proxy_policies` | **none** (permission denied) | all |
| `admin_sessions`, `admin_audit_logs`, `admin_login_attempts`, `admin_security_events` | **none** | all; audit is append-only for everyone |

Constraints the database enforces on its own: status values (`CHECK`), category
and provider references (foreign keys; a category holding games or a provider
with games cannot be deleted), one row per provider game, case-insensitive unique
staff usernames, known staff roles, proxy destinations that name a site (never
`*`, a bare TLD or an IP address) on web ports only.

---

## 9. Backup and recovery

The console deliberately has **no restore button**: restoring a production
database is an infrastructure action with its own credentials, not a web form.

- **Backups** are Supabase's (daily on paid plans; point-in-time recovery as an
  add-on). The free tier has no automatic backups — take `pg_dump` exports on a
  schedule if the project is on it.
- **What restores what.** The schema is fully reproducible from
  `supabase/migrations/` (or `db/SCHEMA-ONLY.sql`). Games deleted by mistake can
  be rebuilt from the `game.delete` audit snapshot. Proxy destinations and policy
  live in `proxy_targets` / `proxy_policies`; secrets never do — they stay in the
  host's environment.
- **Migration state** is visible in the console: Overview → Control plane shows
  whether the schema is `ready`, `missing` or running in `memory`.

---

## 10. Going live checklist

1. Apply the migration (§1). Confirm Overview → Control plane says **database**.
2. Sign in as the owner; create staff accounts with the least role that fits.
3. Review **Providers** — the seeded statuses come from an automated audit.
4. Add the **proxy destinations** the site is authorised to reach, or set the
   access mode to `staff` / `disabled` (Proxy control).
5. Decide `catalog.gd_auto_publish_clean`, then run a GameDistribution **dry run**
   before the first real import.
6. Settings → confirm the feature flags and the announcement.

---

## 11. Residual risks

What this work does **not** solve, ranked. Each is stated so it can be decided,
not discovered.

| # | Risk | Severity | Status / what would close it |
|--:|---|---|---|
| 1 | **Proxied games run third-party code on this site's origin.** Y8, HTMLGames and Famobi games (~6,500) are served through `/embed/<slug>`, same-origin, in an iframe with `allow-scripts allow-same-origin` and a permissive CSP. A malicious or compromised game can therefore act with the session of an admin who plays it while signed in. | **High** | *Mitigated:* every credential-minting or irreversible action needs a fresh password, which a script cannot supply (creating accounts, resetting passwords, role changes, deletions, approving proxy destinations, widening providers, maintenance mode); the console refuses to be framed even same-origin. *Not closed:* publishing, settings and moderation remain reachable with a live session. **Fix:** serve `/embed` from a separate origin (e.g. `embed.<domain>`), or add a CSP `sandbox` without `allow-same-origin` after testing game compatibility. **Until then: do not play proxied games in the browser profile you use for `/admin`.** |
| 2 | **The migration is not on the live database yet.** Until it is, the management sections answer 503 and the proxy refuses every destination not in `PROXY_APPROVED_TARGETS`. Deploying this code **changes the proxy's behaviour immediately**: it stops reaching sites until destinations are approved. | High (operational) | Apply the migration, then approve destinations — or set `PROXY_APPROVED_TARGETS` before deploying. |
| 3 | **Licensing screening is pattern-based.** It catches marks by name; it cannot see trade dress (a Minecraft-style block character in a game whose title and tags are clean) and it produces false positives. With auto-publish on, clean games go live without a person looking. | Medium | Human review is the control for flagged games. For zero-trust publishing, turn off `catalog.gd_auto_publish_clean`. |
| 4 | **In-process state.** Proxy sessions, refused-host counts and admin rate limits live in one process's memory. A second instance would not share them. | Medium (only if scaled out) | Move to Redis (already optional in the stack) before running more than one instance. |
| 5 | **Staff-only proxy mode caches session checks for 60 s.** A revoked staff session keeps proxy access for up to a minute. | Low | Shorten the cache, or clear it on revocation (it is cleared on every policy change already). |
| 6 | **External companions are not governed.** They are separate servers the destination policy cannot see. | Low (off by default) | Keep `external` off unless each companion enforces its own allowlist. |
| 7 | **Tamper-evidence, not tamper-proofing.** A database superuser could rewrite rows *and* recompute the chain. | Low | Periodically record the newest `row_hash` somewhere the database cannot write (an issue, a signed commit). |
| 8 | **Automated pipelines publish directly.** The grow job and the Y8 sync insert trusted-host, trademark-filtered games as `published` without a `provider_id` (their code predates the lifecycle). | Low | Route them through `importFromProvider` in a follow-up; the migration's provider backfill can be re-run meanwhile. |
| 9 | **No media uploads.** Thumbnails are URLs on a provider's image origin or `/thumbs/`. Deliberate — the host's disk is ephemeral — but it means no custom art without a provider. | Low | Add Supabase Storage with type/size/signature checks if needed. |
| 10 | **Catalog size.** A first GameDistribution import roughly doubles the served catalog, which is held in memory. | Low | Watch memory after the first `--apply`; import with `--no-auto-publish` to publish in batches. |

---

**Related:** [documentation map](../README.md#-documentation) ·
[proxy governance](../proxy/GOVERNANCE.md) ·
[GameDistribution import](../features/GAMEDISTRIBUTION.md) ·
[migration order](../database/RUN-IN-ORDER.md)
