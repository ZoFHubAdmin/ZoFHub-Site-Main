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

## Step 3b — `/browser` says "Uh oh! There was an error loading…"? Check your antivirus first

If the proxy fails **locally** with a 500 and the error details say:

```
InvalidCertificate(UnknownIssuer)   ·   invalid peer certificate: UnknownIssuer
```

**this is almost certainly your antivirus, not the site.** Avast, AVG, Kaspersky,
ESET and Bitdefender all offer "HTTPS scanning", which works by intercepting
every secure connection and re-signing it with their own root certificate.

That root is installed in **Windows'** trust store, so `curl`, Chrome and
`npm start` (which runs `node --use-system-ca`) all accept it happily. The proxy
engines cannot: Ultraviolet and Scramjet terminate TLS inside a **WebAssembly**
client that ships its **own** list of trusted authorities and cannot see
Windows' store at all. It meets a certificate signed by an issuer it has never
heard of and refuses it, exactly as it should.

**How to confirm it in ten seconds** — this prints who signed the certificate
your machine actually receives:

```bash
node -e "const t=require('tls');const s=t.connect({host:'example.com',port:443,servername:'example.com',rejectUnauthorized:false},()=>{console.log(s.getPeerCertificate().issuer);s.end()})"
```

A real issuer (DigiCert, Let's Encrypt, Amazon) means the proxy problem is real —
report it. Anything naming your antivirus means **the deployed site is fine** and
only your machine is affected. This was measured here on 2026-08-07: the issuer
came back `Avast Web/Mail Shield Root`, and it had already cost one full
debugging session before anyone thought to look.

To test the proxy properly, either use the live site, or turn off your
antivirus' HTTPS/web-shield scanning for as long as the test takes.

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
  That's normal, not a bug. (If you set up the `/healthz` keep-alive monitor from
  [GO-LIVE.md](GO-LIVE.md), it stays awake.)

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
- **Database:** Supabase (`games`, `scores`, `recommendations`, `game_stats`, `keepalive`)
- **GitHub repo:** https://github.com/ZSM1010/ZoFHub-Gaming-AI-Browser-Hub
- **Cache trick:** every CSS/JS link ends in `?v=YYYYMMDD`. When a change won't
  show up even after a hard refresh, that number probably needs bumping — ask Claude.
