// Puter.js sign-in: the window must open from the visitor's own click or keypress, a refused window
// must be noticed at once, and a sign-in problem must give the visitor a way to sign in.
//
// WHY. Puter's SDK opens its sign-in window by itself, but only after our code has downloaded the
// SDK. That is late enough for a browser to stop treating the click as a user gesture and drop the
// window silently, leaving the visitor with a message promising a window that never appears. So
// sign-in is an explicit step (public/js/puter.js) with a panel and a button (public/js/pollichat.js)
// whose own click opens it. The real-browser behaviour is checked by `npm run verify-ai`; these
// tests cover the logic with a fake window, which makes every outcome reproducible.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  puterReady, puterSignInState, startPuterSignIn, askPuterWithContext, describePuterFailure,
  signOutOfPuter, hideNodeGlobal,
} from '../public/js/puter.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
function codeOnly(p) {
  let s = read(p);
  s = s.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  return s.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
}

const realOpen = () => ({ closed: false });      // what a browser returns when it opened the window

/** A fake browser window with a fake Puter SDK. `signIn` decides what the SDK does. */
function installFakeWindow({ signedIn = false, signIn, chat } = {}) {
  const calls = [];
  const win = {
    open: realOpen,
    puter: {
      auth: {
        _in: signedIn,
        isSignedIn() { return this._in; },
        async getUser() { return { username: 'tester' }; },
        async signOut() { this._in = false; calls.push('signOut'); },
        signIn(...a) { calls.push('signIn'); return signIn ? signIn.call(this, win, ...a) : Promise.resolve(); },
      },
      ai: { chat: async (...a) => { calls.push('chat'); return chat ? chat(...a) : 'an answer'; } },
    },
  };
  globalThis.window = win;
  return { win, calls };
}

beforeEach(() => { delete globalThis.window; });
afterEach(() => { delete globalThis.window; });

describe('what the page can tell about Puter', () => {
  test('not ready until the SDK exposes sign-in and chat', () => {
    assert.equal(puterReady(), false);
    globalThis.window = { puter: { auth: {} } };
    assert.equal(puterReady(), false);
    installFakeWindow();
    assert.equal(puterReady(), true);
  });

  test('the sign-in state is signed-in, signed-out, or unknown — never a guess', () => {
    assert.equal(puterSignInState(), 'unknown', 'no SDK');
    globalThis.window = { puter: { auth: {} } };
    assert.equal(puterSignInState(), 'unknown', 'an SDK that cannot say');
    installFakeWindow({ signedIn: true });
    assert.equal(puterSignInState(), 'signed-in');
    installFakeWindow({ signedIn: false });
    assert.equal(puterSignInState(), 'signed-out');
  });

  test('signing out works and never throws', async () => {
    const { win } = installFakeWindow({ signedIn: true });
    assert.equal(await signOutOfPuter(), true);
    assert.equal(win.puter.auth.isSignedIn(), false);
    delete globalThis.window;
    assert.equal(await signOutOfPuter(), false, 'with no SDK nothing was signed out — and nothing threw');
  });
});

describe('startPuterSignIn', () => {
  test('resolves once the visitor has signed in, and leaves window.open as it found it', async () => {
    const { win } = installFakeWindow({
      signIn(w) { w.open('https://puter.com/action/sign-in'); this._in = true; return Promise.resolve({}); },
    });
    const before = win.open;
    assert.equal(await startPuterSignIn(), true);
    assert.equal(win.open, before, 'window.open must be restored');
  });

  test('a window the browser refuses is reported at once as popup-blocked', async () => {
    const { win } = installFakeWindow({
      signIn(w) { w.open('https://puter.com/action/sign-in'); return new Promise(() => {}); },   // the SDK just waits
    });
    win.open = () => null;                                  // the browser refused
    const refusing = win.open;
    await assert.rejects(startPuterSignIn(), (e) => e.code === 'popup-blocked');
    assert.equal(win.open, refusing, 'window.open must be restored even on a refusal');
  });

  test('closing the sign-in window is auth-cancelled, not a generic failure', async () => {
    installFakeWindow({
      signIn(w) { w.open('x'); return Promise.reject({ error: { code: 'auth_canceled', message: 'Authentication canceled' } }); },
    });
    await assert.rejects(startPuterSignIn(), (e) => e.code === 'auth-cancelled');
  });

  test('an unreachable Puter is offline', async () => {
    installFakeWindow({ signIn(w) { w.open('x'); return Promise.reject(new Error('Failed to fetch')); } });
    await assert.rejects(startPuterSignIn(), (e) => e.code === 'offline');
  });

  test('a sign-in the SDK never reports on cannot trap later clicks: after the join window a click starts afresh', async () => {
    let opened = 0;
    const releases = [];
    installFakeWindow({ signIn(w) { opened++; w.open('x'); return new Promise((r) => releases.push(r)); } });
    const first = startPuterSignIn();
    await new Promise((r) => setTimeout(r, 2100));          // past the double-click window
    const second = startPuterSignIn();
    assert.notEqual(first, second, 'a later click must not be handed the stale attempt');
    assert.equal(opened, 2, 'and it must open a window of its own');
    releases.forEach((r) => r({}));
    await Promise.all([first, second]);
  });

  test('a second call while a sign-in is open joins it instead of opening another window', async () => {
    let opened = 0;
    let finish;
    const { win } = installFakeWindow({
      signIn(w) { opened++; w.open('x'); return new Promise((r) => { finish = r; }); },
    });
    const a = startPuterSignIn();
    const b = startPuterSignIn();
    assert.equal(a, b, 'both callers must wait on the same sign-in');
    finish({});
    await a;
    assert.equal(opened, 1);
    assert.equal(typeof win.open, 'function');
  });

  test('without the SDK it says so (offline) rather than throwing a TypeError', async () => {
    await assert.rejects(startPuterSignIn(), (e) => e.code === 'offline');
  });

  describe('when the browser refuses the window but the SDK shows its own "Continue" dialog', () => {
    // The SDK's recovery: a modal whose Continue button is a real click and then opens the window.
    const withDialog = () => {
      globalThis.document = {
        querySelector: (sel) => (sel === 'puter-dialog' ? { shadowRoot: { querySelector: () => ({ open: true }) } } : null),
      };
    };
    afterEach(() => { delete globalThis.document; });

    test('it keeps waiting, tells the caller, and resolves once the visitor continues', async () => {
      withDialog();
      let blockedNotes = 0;
      const { win } = installFakeWindow({
        signIn(w) {
          w.open('x');                                                    // refused: the SDK shows its dialog
          return new Promise((r) => setTimeout(() => { this._in = true; r({}); }, 1500));   // the visitor clicks Continue
        },
      });
      win.open = () => null;
      assert.equal(await startPuterSignIn({ onBlocked: () => { blockedNotes++; } }), true);
      assert.equal(blockedNotes, 1, 'the caller must be told once, so it can say what to click');
    });

    test('Cancel in that dialog is auth-cancelled — the visitor\'s choice, not a blocked window', async () => {
      withDialog();
      const { win } = installFakeWindow({
        signIn(w) {
          w.open('x');
          return new Promise((_, rej) => setTimeout(() => rej({ error: { code: 'auth_canceled' } }), 1400));
        },
      });
      win.open = () => null;
      await assert.rejects(startPuterSignIn(), (e) => e.code === 'auth-cancelled');
    });
  });

  test('a synchronous throw inside the SDK becomes a typed error', async () => {
    installFakeWindow({ signIn() { throw new Error('boom'); } });
    await assert.rejects(startPuterSignIn(), (e) => typeof e.code === 'string' && e.code !== 'unexpected-response');
  });
});

describe('a stray `process` global must not make the SDK think it is Node.js', () => {
  // The SDK decides its environment ONCE, when it loads, and a global named `process` makes it
  // choose Node.js — after which it never shows a sign-in at all. hideNodeGlobal() moves the
  // global aside for exactly the load.
  const define = (win, value, extra = {}) => Object.defineProperty(win, 'process',
    { value, writable: true, configurable: true, enumerable: true, ...extra });

  test('while hidden the SDK sees no process, and it comes back unchanged afterwards', () => {
    const win = globalThis.window = {};
    const original = { env: { NODE_ENV: 'production' } };
    define(win, original);
    const putBack = hideNodeGlobal();
    assert.equal(win.process, undefined, 'the SDK would read this and choose Node.js');
    assert.ok(!win.process, 'a truthiness test (what the SDK does) must be false');
    putBack();
    assert.equal(win.process, original, 'the very same object must be restored');
  });

  test('a process some other script assigns while it is hidden is what comes back', () => {
    const win = globalThis.window = {};
    define(win, { id: 'first' });
    const putBack = hideNodeGlobal();
    win.process = { id: 'assigned during the load' };
    assert.equal(win.process, undefined, 'still hidden from the SDK');
    putBack();
    assert.equal(win.process.id, 'assigned during the load', 'a later script\'s value must not be lost');
  });

  test('putting it back twice is harmless', () => {
    const win = globalThis.window = {};
    define(win, { id: 1 });
    const putBack = hideNodeGlobal();
    putBack();
    putBack();
    assert.equal(win.process.id, 1);
  });

  test('a page with no process global is left completely alone', () => {
    const win = globalThis.window = {};
    const putBack = hideNodeGlobal();
    assert.equal(Object.getOwnPropertyDescriptor(win, 'process'), undefined, 'nothing may be defined on a page that had nothing');
    putBack();
    assert.equal('process' in win, false);
  });

  test('a global that cannot be redefined is not touched', () => {
    const win = globalThis.window = {};
    define(win, { id: 'fixed' }, { configurable: false, writable: false });
    const putBack = hideNodeGlobal();
    assert.equal(win.process.id, 'fixed', 'we may not alter what the page made permanent');
    putBack();
    assert.equal(win.process.id, 'fixed');
  });

  test('ensurePuter hides it only when it is about to inject the tag, and restores it on every way out', () => {
    const code = codeOnly('public/js/puter.js');
    const ensure = code.slice(code.indexOf('export function ensurePuter'));
    assert.match(ensure, /alreadyInjected \? \(\) => \{\} : hideNodeGlobal\(\)/);
    const failBody = ensure.match(/const fail = \(msg\) => \{[\s\S]*?\n    \};/)?.[0] || '';
    const readyBody = ensure.match(/const ready = \(\) => \{[\s\S]*?\n    \};/)?.[0] || '';
    assert.match(failBody, /putProcessBack\(\)/, 'a failed or timed-out load must restore the global');
    assert.match(readyBody, /putProcessBack\(\)/, 'a successful load must restore the global');
  });
});

describe('askPuterWithContext signs in first', () => {
  const MSGS = [{ role: 'user', content: 'hi' }];

  test('signed in: it chats and never opens a sign-in window', async () => {
    const { calls } = installFakeWindow({ signedIn: true });
    const r = await askPuterWithContext(MSGS);
    assert.equal(r.text, 'an answer');
    assert.deepEqual(calls, ['chat']);
  });

  test('signed out: the sign-in happens BEFORE the chat call', async () => {
    const { calls } = installFakeWindow({
      signIn(w) { w.open('x'); this._in = true; return Promise.resolve({}); },
    });
    const r = await askPuterWithContext(MSGS);
    assert.equal(r.text, 'an answer');
    assert.deepEqual(calls, ['signIn', 'chat']);
  });

  test('signed out and the window is blocked: it fails fast and never calls chat', async () => {
    const { win, calls } = installFakeWindow({ signIn(w) { w.open('x'); return new Promise(() => {}); } });
    win.open = () => null;
    await assert.rejects(askPuterWithContext(MSGS), (e) => e.code === 'popup-blocked');
    assert.deepEqual(calls, ['signIn'], 'chat must not be attempted without a session');
  });

  test('a sign-in the visitor abandons does not leave the request hanging', async () => {
    installFakeWindow({ signIn(w) { w.open('x'); return Promise.reject({ error: { code: 'auth_canceled' } }); } });
    await assert.rejects(askPuterWithContext(MSGS), (e) => e.code === 'auth-cancelled');
  });

  test('cancelling while waiting for the visitor to sign in is "cancelled"', async () => {
    let release;
    installFakeWindow({ signIn(w) { w.open('x'); return new Promise((r) => { release = r; }); } });
    const ctl = new AbortController();
    const pending = askPuterWithContext(MSGS, { signal: ctl.signal });
    setTimeout(() => ctl.abort(), 30);
    await assert.rejects(pending, (e) => e.code === 'cancelled');
    release({});                         // let the abandoned sign-in end, so nothing is left pending
    await new Promise((r) => setTimeout(r, 5));
  });

  test('the sign-in wait does not count against the answer\'s time budget', async () => {
    // timeoutMs is far shorter than the sign-in takes; the answer must still be allowed to arrive.
    installFakeWindow({
      signIn(w) { w.open('x'); return new Promise((r) => setTimeout(() => { this._in = true; r({}); }, 120)); },
    });
    const r = await askPuterWithContext(MSGS, { timeoutMs: 60 });
    assert.equal(r.text, 'an answer');
  });
});

describe('what the visitor is told', () => {
  for (const code of ['auth', 'popup-blocked', 'auth-cancelled']) {
    test(`${code} names the button and offers PolliChat, and never points at a browser feature`, () => {
      const msg = describePuterFailure({ code });
      assert.match(msg, /Sign in to Puter/);
      assert.match(msg, /PolliChat/);
      assert.doesNotMatch(msg, /\bthe Browser\b|open the Browser/i);
    });
  }

  test('a blocked window tells the visitor how to allow it', () => {
    assert.match(describePuterFailure({ code: 'popup-blocked' }), /pop-ups/i);
  });

  test('the usage-limit message does not point at a browser feature either', () => {
    assert.doesNotMatch(describePuterFailure({ code: 'usage' }), /Browser/);
  });
});

describe('the page wires it so the click is the gesture', () => {
  const chat = codeOnly('public/js/pollichat.js');
  const html = codeOnly('public/pollichat.html');

  test('the page has the account panel and its button', () => {
    assert.match(html, /id="aiPuterAuth"/);
    assert.match(html, /id="aiPuterAuthBtn"/);
    assert.match(html, /id="aiPuterAuthLine"[^>]*role="status"/, 'the panel text must be announced to screen readers');
  });

  test('the panel button starts the sign-in before anything else in its handler', () => {
    const handler = chat.match(/function bindPuterPanel\(\)[\s\S]*?\n\}/)?.[0] || '';
    const afterGuard = handler.slice(handler.indexOf("if (act !== 'signin') return;"));
    assert.match(afterGuard, /^[^\n]*\n\s*(?:\/\/[^\n]*\n\s*)*const attempt = startPuterSignIn\(/,
      'startPuterSignIn() must be the first statement after the guard, with no await before it');
    assert.doesNotMatch(handler, /await[^\n]*\n[\s\S]*startPuterSignIn\(\)/);
  });

  test('the error card\'s button starts the sign-in before it changes anything', () => {
    const card = chat.match(/go\.addEventListener\('click', \(\) => \{[\s\S]*?\n    \}\);/)?.[0] || '';
    assert.ok(card.indexOf('signIn.start(') > -1, 'the card does not start a sign-in');
    assert.ok(card.indexOf('signIn.start(') < card.indexOf('go.disabled'), 'start() must come first');
    assert.doesNotMatch(card, /await/);
  });

  test('a sign-in problem costs no wait, because nothing was sent', () => {
    assert.match(chat, /function finishTurnWithoutWait\(\)\s*\{\s*composing = false;\s*refreshComposer\(\);\s*\}/);
    assert.match(chat, /if \(signIn\) finishTurnWithoutWait\(\); else finishTurn\(\);/);
  });

  test('the SDK is still only loaded for a visitor who chose Puter', () => {
    const sync = chat.match(/function syncPuterPanel\(\)[\s\S]*?\n\}/)?.[0] || '';
    assert.match(sync, /current\?\.provider !== 'puter'/);
    assert.ok(sync.indexOf("!== 'puter'") < sync.indexOf('preloadPuter()'), 'the provider check must come before the preload');
  });
});
