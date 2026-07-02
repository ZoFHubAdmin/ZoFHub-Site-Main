# 🛠️ ZoFHub — Debugging & "How Do I Fix This?" Guide

A plain-language checklist for when something breaks. You don't need to be an
advanced coder to use this — just go top to bottom.

---

## ⚡ The 30-second rule: 9 times out of 10 it's one of these three
1. **Your browser is showing an OLD version** → not really broken, just cached.
2. **There's a red error message** telling you exactly what's wrong.
3. **The server/deploy didn't restart** with your new code.

Check them in order. You rarely have to "figure it out" from scratch.

---

## Step 1 — Hard refresh, ALWAYS FIRST
`Ctrl + Shift + R` (Windows) — forces the browser to re-download everything.

Before you EVER say "the fix didn't work," do this. Half the time it *is* the fix.

---

## Step 2 — Open the Console and read the red text (most useful skill!)
1. Press **`F12`** (or right-click page → **Inspect**).
2. Click the **Console** tab.
3. Look for text in **red**. It names the file + line, e.g. `pollinations.js:42 — TypeError`.

👉 You don't need to understand it. **Copy the red text and paste it to Claude.**
That one line is worth more than three paragraphs of "it's not working."

Also handy: the **Network** tab → reload with it open → anything **red** = a file
or request that failed to load.

---

## Step 3 — Is it broken for everyone, or just me?
- Open the site in **Incognito** (`Ctrl + Shift + N`), or on your **phone**.
- Works there but not your normal browser? → it was cache/an extension on your end (not a real bug).
- Broken everywhere? → real bug. Tell Claude (with the Step 2 error).

---

## Step 4 — Test on your own computer before blaming the live site
1. Open a terminal in the project folder.
2. Run:  `npm start`
3. Open **http://localhost:8080** in your browser.
4. Press `Ctrl + C` in the terminal to stop it.

- Works locally but not live? → it's a **deploy** problem → Step 5.
- Broken locally too? → it's a **code** problem → tell Claude + paste the Console error.

> If `npm start` errors with "cannot find module," run `npm install` once first.

---

## Step 5 — Live site broken? Check Render (the robot that runs your site)
When you push to GitHub, Render auto-rebuilds and restarts your site.

- **Render dashboard → your service → "Events"** → did the latest deploy
  **succeed or fail**? A failed deploy means the live site is still on OLD code.
- **→ "Logs"** → red lines = the server is crashing. Copy them to Claude.
- ⚠️ **Free plan sleeps** when idle — the first visit takes 20–50s to wake up.
  That's normal, not a bug.

---

## Step 6 — Games / scores / data broken? Check Supabase (the database)
- **Supabase dashboard → Table Editor** → is the data actually there?
- **→ Logs** → are requests failing?
- Games vanished or won't load → usually here.

---

## 🚨 Panic button: roll back (do this FIRST when the whole site is down)
Don't debug under pressure. **Get back to "working," THEN fix the bug.**
- **Render → Deploys** → pick a previous working deploy → **"Redeploy"**.
- Site returns to how it was minutes ago. Now fix calmly.

---

## ❌ Never do these (so you can't cause a disaster)
- Don't commit/push your **`.env`** file (secret keys). It's already ignored — keep it that way.
- Don't delete/rename **database columns or tables** in Supabase without asking Claude first — that can wipe data.
- Don't push straight to live when unsure — test locally (Step 4) first.
- When in doubt, ask **before** doing something you can't undo.

---

## 💬 How to ask Claude so it's fixed in ONE go
Give these four things (rough is fine):
1. **What you did** — "I clicked the Vibe Finder button"
2. **What you expected** — "it should show games"
3. **What actually happened** — "it spins forever"
4. **The red Console error** (Step 2) — paste it, or a screenshot.

A screenshot of the screen with the Console open is the gold standard.

---

## 📌 Your project's quick facts
- **Start locally:** `npm start`  → http://localhost:8080
- **Live host:** Render (auto-deploys when you push to GitHub)
- **Database:** Supabase (`games`, `scores`, `game_stats` tables)
- **GitHub repo:** https://github.com/ZSM1010/ZoFHub-Gaming-AI-Browser-Hub
- **Cache trick:** every CSS/JS link ends in `?v=YYYYMMDD`. When a change won't
  show up even after a hard refresh, that number probably needs bumping — ask Claude.
