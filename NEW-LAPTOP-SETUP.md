# 💻 Moving ZoFHub to a new laptop

**Read this first — it's short and it's the whole story.**

This is a **private full-backup repository**. Almost **everything** is committed to
GitHub on purpose — including your `.env` secrets and every companion app's files.
So moving to a new laptop is basically just: **clone, install, run.** There is
almost nothing to save by hand.

> ⚠️ **KEEP THIS REPOSITORY PRIVATE.** It contains your real Supabase
> **service-role key** (in `.env`). Anyone who can see this repo can read/write
> your whole database. If it is *ever* made public — even by accident — go to
> **Supabase → Project Settings → API → rotate the service-role key** immediately,
> then update `.env` and your Render env vars. That single action fully neutralises
> the exposure.

---

## ✅ What's in the repo (i.e. what you DON'T have to save by hand)

Everything that matters is committed and comes down with `git clone`:

- **All your code** — server, frontend, tools, SQL.
- **`.env`** — your real Supabase + Pollinations keys. *(Committed on purpose because this repo is private.)*
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

2. **Clone your repo** (this brings down everything, including `.env`):
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

4. **Run it:**
   ```bash
   npm start
   ```
   Open http://localhost:8080 — your catalog loads straight from Supabase because
   `.env` is already there. No secret-restoring step needed.

5. **(Only if you want the catalog/thumbnail tools)** seven `npm run` scripts —
   `mood-index`, `rec-index`, `feed-rank`, `scrape-thumbs`, `normalize-thumbs`,
   `fix-missing-thumbs`, `upgrade-y8-thumbs` — are Python. The website itself
   never touches them, and the deploy installs no Python at all.
   ```bash
   pip install -r tools/requirements.txt
   ```
   You do not need to know whether your machine calls it `python`, `python3` or
   `py`: the scripts go through `tools/run-python.mjs`, which finds a real
   Python 3 (and ignores the Windows Store stub that pretends to be one). With no
   interpreter installed it says so and exits, rather than failing as a confusing
   "command not found".

6. **(Only if you want the companion browsers locally)** each has its own deps.
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

- **This private repo = your complete backup.** Clone it and you have everything,
  secrets included.
- **`node_modules` = rebuilt, never backed up.** `npm install`.
- **Keep it PRIVATE.** That's the one rule that keeps committing `.env` safe.
