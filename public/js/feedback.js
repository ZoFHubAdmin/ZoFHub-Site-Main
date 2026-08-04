// ZoFHub · feedback.js — "Send feedback" on every page.
//
// Mounted from layout.js, which builds the shared footer. Self-contained: it
// injects its own styles and markup on first use rather than requiring an empty
// container in nine HTML files that would silently rot if one were missed.
//
// The dialog is deliberately small. Every field beyond "what happened" costs
// submissions, and a report that arrives is worth more than a perfectly
// categorised one that does not. The page URL is filled in automatically —
// it is the single most useful field for reproducing a bug and the one people
// always forget.

const MAX = 2000;
let dialog = null;

function injectStyles() {
  if (document.getElementById('fb-css')) return;
  const s = document.createElement('style');
  s.id = 'fb-css';
  s.textContent = `
  .fb-back{position:fixed;inset:0;z-index:10002;background:rgba(4,7,18,.72);
    backdrop-filter:blur(5px);display:flex;align-items:flex-start;justify-content:center;
    padding:8vh 16px 16px;animation:fbIn .16s ease both}
  /* [hidden] alone cannot beat display:flex above — without this the close
     button appears to do nothing. */
  .fb-back[hidden]{display:none!important}
  @keyframes fbIn{from{opacity:0}to{opacity:1}}
  .fb-card{width:min(520px,100%);background:var(--surface,#241a55);
    border:1px solid var(--line-2,rgba(170,140,255,.34));border-radius:16px;
    box-shadow:0 30px 80px rgba(0,0,0,.6);padding:20px;
    font-family:Inter,system-ui,sans-serif;color:var(--text,#f7f4ff)}
  .fb-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:4px}
  .fb-head h2{margin:0;font-size:17px;font-weight:800}
  .fb-sub{margin:0 0 14px;font-size:12.5px;color:var(--text-dim,#c3b6ee)}
  .fb-x{background:none;border:0;color:var(--text-dim,#c3b6ee);font-size:22px;
    line-height:1;cursor:pointer;padding:2px 6px;border-radius:8px}
  .fb-x:hover{color:var(--text,#fff);background:rgba(255,255,255,.08)}
  .fb-kinds{display:flex;gap:8px;margin-bottom:12px}
  .fb-kind{flex:1;padding:8px;border-radius:10px;cursor:pointer;font:inherit;font-size:13px;
    font-weight:700;background:var(--surface-2,#2c2065);color:var(--text-dim,#c3b6ee);
    border:1px solid var(--line,rgba(170,140,255,.18));transition:all .14s ease}
  .fb-kind[aria-pressed="true"]{background:var(--brand,#ffd426);color:var(--brand-ink,#241a00);
    border-color:var(--brand,#ffd426)}
  .fb-kind:focus-visible{outline:2px solid var(--brand,#ffd426);outline-offset:2px}
  .fb-card textarea,.fb-card input[type=email]{width:100%;box-sizing:border-box;font:inherit;
    font-size:14px;padding:10px 12px;border-radius:10px;background:var(--bg,#171034);
    color:var(--text,#f7f4ff);border:1px solid var(--line,rgba(170,140,255,.18));resize:vertical}
  .fb-card textarea{min-height:112px}
  .fb-card textarea:focus,.fb-card input:focus{outline:2px solid var(--brand,#ffd426);
    outline-offset:1px;border-color:transparent}
  .fb-count{display:block;text-align:right;font-size:11.5px;color:var(--text-mute,#8f81c8);margin-top:4px}
  .fb-count.over{color:var(--danger,#ff4d5e);font-weight:700}
  .fb-label{display:block;font-size:12px;color:var(--text-dim,#c3b6ee);margin:10px 0 5px}
  /* The honeypot. Hidden from people, present in the DOM for bots. Not
     display:none — some bots skip those; off-screen with no tab stop. */
  .fb-hp{position:absolute;left:-9999px;width:1px;height:1px;opacity:0}
  .fb-actions{display:flex;gap:10px;align-items:center;margin-top:16px}
  .fb-send{flex:1;padding:11px;border:0;border-radius:10px;cursor:pointer;font:inherit;
    font-weight:800;background:var(--brand,#ffd426);color:var(--brand-ink,#241a00)}
  .fb-send:disabled{opacity:.55;cursor:not-allowed}
  .fb-msg{margin:12px 0 0;font-size:13px}
  .fb-msg.ok{color:var(--ok,#22e06a)}
  .fb-msg.bad{color:var(--danger,#ff4d5e)}
  .fb-priv{margin:12px 0 0;font-size:11.5px;color:var(--text-mute,#8f81c8);line-height:1.5}
  @media (max-width:520px){.fb-back{padding:0;align-items:stretch}
    .fb-card{border-radius:0;min-height:100%}}`;
  document.head.appendChild(s);
}

function build() {
  injectStyles();
  const back = document.createElement('div');
  back.className = 'fb-back';
  back.hidden = true;
  back.innerHTML = `
    <div class="fb-card" role="dialog" aria-modal="true" aria-labelledby="fbTitle">
      <div class="fb-head">
        <h2 id="fbTitle">Send feedback</h2>
        <button class="fb-x" type="button" id="fbClose" aria-label="Close">&times;</button>
      </div>
      <p class="fb-sub">Found a bug or have an idea? Tell us — it goes straight to the team.</p>
      <div class="fb-kinds" role="group" aria-label="Feedback type">
        <button class="fb-kind" type="button" data-kind="bug"   aria-pressed="false">🐞 Bug</button>
        <button class="fb-kind" type="button" data-kind="idea"  aria-pressed="false">💡 Idea</button>
        <button class="fb-kind" type="button" data-kind="other" aria-pressed="true">💬 Other</button>
      </div>
      <form id="fbForm" novalidate>
        <label class="fb-label" for="fbMsg">What happened?</label>
        <textarea id="fbMsg" maxlength="${MAX}" required
          placeholder="Describe the problem or idea…"></textarea>
        <span class="fb-count" id="fbCount">0 / ${MAX}</span>
        <label class="fb-label" for="fbEmail">Email <span style="opacity:.7">(optional — only if you want a reply)</span></label>
        <input id="fbEmail" type="email" autocomplete="email" placeholder="you@example.com" />
        <input class="fb-hp" id="fbWebsite" name="website" tabindex="-1" autocomplete="off" aria-hidden="true" />
        <div class="fb-actions">
          <button class="fb-send" type="submit" id="fbSend">Send feedback</button>
        </div>
        <p class="fb-msg" id="fbMsgOut" hidden></p>
        <p class="fb-priv">We store your message and the page you were on. Your email is
        optional and only used to reply. We never publish feedback.</p>
      </form>
    </div>`;
  document.body.appendChild(back);

  const $ = (s) => back.querySelector(s);
  const msg = $('#fbMsg'), count = $('#fbCount'), out = $('#fbMsgOut'), send = $('#fbSend');
  let kind = 'other';

  back.addEventListener('click', (e) => { if (e.target === back) close(); });
  $('#fbClose').addEventListener('click', close);

  for (const b of back.querySelectorAll('.fb-kind')) {
    b.addEventListener('click', () => {
      kind = b.dataset.kind;
      for (const o of back.querySelectorAll('.fb-kind')) o.setAttribute('aria-pressed', String(o === b));
    });
  }

  msg.addEventListener('input', () => {
    count.textContent = `${msg.value.length} / ${MAX}`;
    count.classList.toggle('over', msg.value.length >= MAX);
  });

  $('#fbForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = msg.value.trim();
    if (text.length < 4) { show('Please write a little more.', 'bad'); msg.focus(); return; }
    send.disabled = true; send.textContent = 'Sending…';
    try {
      const r = await fetch('/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: text, kind,
          email: $('#fbEmail').value.trim(),
          website: $('#fbWebsite').value,        // honeypot; empty for people
          // The field people always forget, and the one that makes a bug report
          // actionable.
          page: location.pathname + location.search,
        }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d.ok) throw new Error(d.error || 'Could not send that.');
      show('Thanks — that reached us.', 'ok');
      msg.value = ''; count.textContent = `0 / ${MAX}`;
      setTimeout(close, 1400);
    } catch (err) {
      show(err.message, 'bad');
    } finally {
      send.disabled = false; send.textContent = 'Send feedback';
    }
  });

  function show(t, cls) { out.textContent = t; out.className = 'fb-msg ' + cls; out.hidden = false; }
  return back;
}

let lastFocus = null;
function close() {
  if (dialog) dialog.hidden = true;
  document.removeEventListener('keydown', onKey);
  // Return focus to whatever opened it, or the keyboard user is dropped at the
  // top of the document.
  if (lastFocus && lastFocus.isConnected) lastFocus.focus();
}
function onKey(e) { if (e.key === 'Escape') close(); }

export function openFeedback() {
  lastFocus = document.activeElement;
  if (!dialog) dialog = build();
  dialog.hidden = false;
  dialog.querySelector('#fbMsgOut').hidden = true;
  document.addEventListener('keydown', onKey);
  dialog.querySelector('#fbMsg').focus();
}

/** Wire any element carrying [data-feedback] to open the dialog. */
export function mountFeedback() {
  document.addEventListener('click', (e) => {
    const t = e.target.closest('[data-feedback]');
    if (!t) return;
    e.preventDefault();
    openFeedback();
  });
}
