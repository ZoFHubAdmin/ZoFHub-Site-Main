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
- **Every companion app's files** — Interstellar, Nebula, NautilusOS, DayDream, scramjet.
- **metro-dash** — your WebGL game, including your in-progress changes.
- **All data files** — catalogs, audits, caches, state.

## 🔁 The ONE thing that isn't committed: `node_modules`

Dependency folders are the *only* thing excluded, and for a good technical reason:
they can't be restored from git on Windows (Nebula uses pnpm symlinks that check
out as broken stubs), and `npm install` rebuilds them perfectly in seconds. So you
rebuild them, you don't back them up.

---

## 🚀 Setting up on the NEW laptop (step by step)

1. **Install the basics:** [Node.js 18+](https://nodejs.org) and [Git](https://git-scm.com).

2. **Clone your repo** (this brings down everything, including `.env`):
   ```bash
   git clone https://github.com/ZSM1010/ZoFHub-Gaming-AI-Browser-Hub.git
   cd ZoFHub-Gaming-AI-Browser-Hub
   ```

3. **Install the main site's dependencies:**
   ```bash
   npm install
   ```

4. **Run it:**
   ```bash
   npm start
   ```
   Open http://localhost:8080 — your catalog loads straight from Supabase because
   `.env` is already there. No secret-restoring step needed.

5. **(Only if you want the companion browsers locally)** each has its own deps —
   install per folder as needed, e.g. `cd Interstellar && npm install`. The main
   site does **not** need these; it uses the built-in Scramjet/UV/GUST engines.

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
certainly never need those — but if you ever want metro-dash's original history or
to pull upstream updates for a companion, that's where they are. It is **not** part
of this repo and does **not** transfer with `git clone`; copy it to USB only if you
specifically care about those histories.

---

## 🧠 The mental model

- **This private repo = your complete backup.** Clone it and you have everything,
  secrets included.
- **`node_modules` = rebuilt, never backed up.** `npm install`.
- **Keep it PRIVATE.** That's the one rule that keeps committing `.env` safe.
