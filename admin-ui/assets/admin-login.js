// public/admin/assets/admin-login.js
// ---------------------------------------------------------------------------
// The login form, and nothing else.
//
// This file contains NO credential, NO hash, and NO check that decides whether
// the user is an admin. It collects two fields, posts them, and reacts to what
// the server says. Every decision is made server-side — a copy of this file
// edited in the browser's console gets exactly nowhere, because it never held
// the authority to begin with.
// ---------------------------------------------------------------------------

const form = document.getElementById('loginForm');
const msg  = document.getElementById('msg');
const btn  = document.getElementById('submit');

function show(text, kind = 'error') {
  msg.textContent = text;                       // textContent, never innerHTML
  msg.className = 'msg ' + kind;
  msg.hidden = false;
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  msg.hidden = true;
  btn.disabled = true;
  btn.textContent = 'Signing in…';

  try {
    const r = await fetch('/api/admin/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // Same-origin only: the session cookie must never be sent anywhere else.
      credentials: 'same-origin',
      body: JSON.stringify({
        username: document.getElementById('username').value,
        password: document.getElementById('password').value,
      }),
    });

    let data = {};
    try { data = await r.json(); } catch { /* non-JSON error page */ }

    if (r.ok && data.ok) {
      // Deliberately a full navigation rather than rendering the dashboard here:
      // the server must be the thing that decides /admin is allowed, and a
      // navigation makes it re-check the session it just issued.
      window.location.replace('/admin');
      return;
    }

    if (r.status === 429) {
      const wait = r.headers.get('retry-after');
      show(wait ? `Too many attempts. Try again in about ${wait}s.` : 'Too many attempts. Try again later.');
    } else if (r.status === 503 && Array.isArray(data.problems)) {
      // Configuration guidance is for the operator standing at their own server.
      // It names which variables are missing — never any value.
      show('Admin login is not configured: ' + data.problems.join('; '), 'warn');
    } else {
      // The server returns one generic message for every credential failure, and
      // this passes it through unchanged. Distinguishing "no such user" from
      // "wrong password" would tell an attacker which half to keep working on.
      show(data.error || 'Invalid credentials.');
    }
  } catch {
    show('Could not reach the server. Check your connection and try again.');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Sign in';
    document.getElementById('password').value = '';
  }
});
