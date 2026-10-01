# 💻 Moving ZoFHub to a new laptop

**Read this first — it's short and it's the whole story.**

This is a **private full-backup repository**. Almost **everything** is committed to
GitHub on purpose — code, data, `node_modules` and every companion app's files.
So moving to a new laptop is: **clone, install, restore `.env`, run.** The
**one** thing you carry across by hand is `.env`.

> ⚠️ **`.env` is not in the repository any more.** It is git-ignored and was
> untracked in commit `1dd45a7e`, so a clone does **not** bring it down. Copy it
> from the old machine, or rebuild it from [`.env.example`](../../.env.example)
> (step 4 below).
>
> ⚠️ **Keep this repository private anyway.** Untracking removed `.env` from the
> current tree, not from git history, which still holds older copies. That is
> recorded as an accepted decision in the Credentials note in
> [`.gitignore`](../../.gitignore). If the repository is ever made public, that
> note is the thing to read first.

---

## ✅ What's in the repo (i.e. what you DON'T have to save by hand)

Everything that matters is committed and comes down with `git clone`:

- **All your code** — server, frontend, tools, SQL.
- **`.env.example`** — every variable the server reads, commented. *(The real
  `.env` is **not** committed — see the warning above.)*
- **The companion apps' files** — Interstellar, NautilusOS, DayDream, scramjet.
  *(Nebula is the one exception — see below.)*
- **All data files** — catalogs, audits, caches, state.

## 📦 Everything — including `node_modules` — is committed

This repo now backs up **literally everything**, including every `node_modules`
folder, so nothing at all is left out. After cloning you already have all the
downloaded packages.

**One exception — Nebula is no longer in the tree.** It was 520 MB across 33,360
files for a companion that only ever ran locally (the deployed site serves GUST,
Ultraviolet and Scramjet, and never offers a companion because `render.yaml` sets
no `PROXY_*_URL`). Its pnpm `node_modules` was a symlink store that restored as
broken stubs on a fresh Windows clone anyway. A clone will **not** bring it down.

Nothing was lost — it's still in history:

```bash
git checkout 07a2a6f7 -- Nebula      # restore it exactly as it was
```

`npm run proxies` detects the folder and starts Nebula automatically if it's
present and built; if it's absent it just says so and launches the other three.

(The **main website** uses the root `node_modules`, which restores fine — but
running `npm install` once after cloning is still the safe habit, since it
repairs anything that didn't copy cleanly.)

---

## 🚀 Setting up on the NEW laptop (step by step)

1. **Install the basics:** [Node.js 22+](https://nodejs.org) and [Git](https://git-scm.com).

2. **Clone your repo** (everything except `.env`):
   ```bash
   git clone https://github.com/ZSM1010/ZoFHub-Gaming-AI-Browser-Hub.git
   cd ZoFHub-Gaming-AI-Browser-Hub
   ```

3. **Install the main site's dependencies:**
   ```bash
   npm ci
   ```
   `npm ci` rather than `npm install`: it installs exactly what `package-lock.json`
   pins, which is what CI and the Render deploy install, so a fresh laptop cannot
   quietly end up on different versions from production.

   No compiler, Python or build toolchain is needed for this step. `.npmrc` sets
   `ignore-scripts=true`, so no dependency runs code while installing — which is
   also what makes the install work at all, since one dependency ships a
   `preinstall` that deliberately aborts any non-pnpm install. `bufferutil`'s
   native addon comes from prebuilt binaries, so nothing invokes node-gyp.

4. **Restore `.env`** — the one manual step. Either copy the file from the old
   laptop (USB, password manager — never email or chat), or rebuild it:
   ```bash
   cp .env.example .env
   ```
   then fill in at least `SUPABASE_URL` and `SUPABASE_SECRET_KEY` (Supabase →
   Settings → API Keys) and the `ADMIN_*` values. Production does not depend on
   this file: Render reads its secrets from the dashboard.

5. **Run it:**
   ```bash
   npm start
   ```
   Open http://localhost:8080. Check the log for
   `catalog refreshed from Supabase: … games`. If instead you only see the
   **bundled fallback catalog (~784 games)**, `.env` is missing or its Supabase
   keys are wrong.

6. **(Only if you want the audit and catalog tools)** **16** `npm run` scripts are
   Python-backed. The website itself never touches them, and the deploy installs
   no Python at all — but two groups are worth knowing about:

   | Group | Scripts |
   |---|---|
   | **Audits** (you will want these) | `db:verify`, `db:verify:strict`, `audit:repo`, `audit:repo:json`, `audit:sql`, `audit:ci` |
   | Catalog / AI datasets | `mood-index`, `rec-index`, `feed-rank`, `game-attributes`, `eval-rec`, `curate-ai` |
   | Thumbnails | `scrape-thumbs`, `normalize-thumbs`, `fix-missing-thumbs`, `upgrade-y8-thumbs` |

   ```bash
   pip install -r tools/requirements.txt
   ```
   You do not need to know whether your machine calls it `python`, `python3` or
   `py`: the scripts go through `tools/run-python.mjs`, which finds a real
   Python 3 (and ignores the Windows Store stub that pretends to be one). With no
   interpreter installed it says so and exits, rather than failing as a confusing
   "command not found".

7. **(Only if you want the companion browsers locally)** each has its own deps.
   The main site does **not** need any of these — it uses the built-in
   Scramjet/UV/GUST engines. Per companion:

   | Companion | Setup | Port |
   |---|---|---|
   | **NautilusOS** | none — pure static | 8091 |
   | **Interstellar** | `cd Interstellar && npm install` | 8092 |
   | **DayDream** | `cd DayDream && pnpm install && pnpm run build`, then copy `config.example.js` → `config.js` | 8093 |
   | **Nebula** | *not in the repo* — restore with `git checkout 07a2a6f7 -- Nebula` first, then `cd Nebula && pnpm install && pnpm run build` and copy `config.example.toml` → `config.toml` | 8094 |

   Then `npm run dev:all` starts the site **and** every companion that's ready,
   and points the server at each so they show up in the `/browser` dropdown.
   This is a **local-only** convenience: the deployed site never offers a
   companion, because `render.yaml` sets no `PROXY_*_URL` and `COMPANION_ENGINES`
   filters out any entry without one. Live, you always get exactly the three
   same-origin engines — GUST, Ultraviolet and Scramjet.
   `npm run proxies` prints exactly what it started and, for anything it
   skipped, the precise reason and the command that fixes it.

That's it. Your live site on Render is unaffected by any laptop change — it
deploys from GitHub, not your machine.

---

## 🔁 Keeping both GitHub repos in sync (your backup mirror)

You push to two repos for safety. On the new laptop, after cloning `origin`, re-add
the backup remote once:
```bash
git remote add backup https://github.com/ZoFHubAdmin/ZoFHub-Site.git
```
Then your normal workflow is:
```bash
git add -A
git commit -m "what changed"
git push origin main
git push backup main
```

---

## 🗃️ About the companion `.git` histories (advanced — you can ignore this)

To put the companion apps' files *directly* into this repo, their own inner `.git`
folders were moved out to a sibling folder: **`../ZoFHub-nested-git-backups/`**
(next to this project, not inside it). Their *files* are fully backed up here in
GitHub; only their separate commit histories live in that sibling folder. You almost
certainly never need those — but if you ever want to pull upstream updates for a
companion, that's where they are. It is **not** part
of this repo and does **not** transfer with `git clone`; copy it to USB only if you
specifically care about those histories.

---

## 🧠 The mental model

- **This private repo = your complete backup, minus `.env`.** Clone it and you
  have everything except your local secrets, which you restore by hand.
- **`node_modules` is committed too** — 2,364 files are tracked, so a clone comes
  down ready to run. Running `npm ci` once afterwards is still the safe habit: it
  repairs anything that did not copy cleanly and pins exactly what production
  installs.
- **Keep it PRIVATE.** `.env` is no longer committed, but git history still
  holds older copies — see the Credentials note in `.gitignore`.

> **Corrected 2026-09-26.** This page used to say `.env` was committed and that a
> clone needed "no secret-restoring step". It stopped being true when `.env` was
> untracked; following the old steps gives a site that silently runs on its
> fallback catalog.

> **An earlier version of this page ended with "`node_modules` = rebuilt, never
> backed up."** That contradicted the section above it and is simply wrong for
> this repository — it is a full-backup repo and the packages are tracked. Noted
> here rather than silently deleted, because the wrong version is the intuitive
> one and it will otherwise get re-added.
