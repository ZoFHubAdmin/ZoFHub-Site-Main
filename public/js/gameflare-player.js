// public/js/gameflare-player.js — the internal GameFlare player.
// ---------------------------------------------------------------------------
// THE RULES THIS FILE EXISTS TO KEEP
//
//   • The iframe src is the EXACT embed_url the server returned. It is never
//     built from a slug, never derived from the canonical page URL, never
//     normalised, and there is no fallback URL. If the game cannot be resolved,
//     the page shows a first-party state — it does not navigate anywhere.
//   • No window.open, no target="_blank", no parent navigation to gameflare.com.
//     A failed load is a message in this page, not an escape hatch to theirs.
//   • Nothing is injected into the frame and nothing is layered over it. The
//     GameFlare bottom bar renders inside the frame and stays visible.
//   • No sandbox attribute. The supplied dataset verified these embeds WITHOUT
//     one ("no iframe sandbox, source modification, proxy, overlay, or
//     self-hosted game files"), so adding one would change the tested
//     configuration into an untested one.
//
// WHAT A LOAD EVENT DOES AND DOES NOT PROVE
// The frame is cross-origin. `load` firing means the browser finished fetching
// a document — it does not mean a game initialised, and this parent cannot look
// inside to find out. So the load event is treated purely as a loading signal,
// and no message here ever claims the game was verified as playable.
// ---------------------------------------------------------------------------
(() => {
  'use strict';

  const stage = document.getElementById('gf-stage');
  const titleEl = document.getElementById('gf-title');
  const metaEl = document.getElementById('gf-meta');
  const statusEl = document.getElementById('gf-player-status');
  const stateEl = document.getElementById('gf-state');
  const stateTitle = document.getElementById('gf-state-title');
  const stateBody = document.getElementById('gf-state-body');
  const retryBtn = document.getElementById('gf-retry');
  const fsBtn = document.getElementById('gf-fullscreen');
  if (!stage) return;

  // How long to wait for the load event before telling the visitor something is
  // wrong. Long enough for a slow connection, short enough not to look frozen.
  const LOAD_TIMEOUT_MS = Number(stage.dataset.timeoutMs) || 15000;

  let timer = 0;
  let currentEmbedUrl = null;

  const setStatus = (t) => { statusEl.textContent = t || ''; };

  function showState(title, body, { retry = false } = {}) {
    stateTitle.textContent = title;
    stateBody.textContent = body;
    retryBtn.hidden = !retry;
    stateEl.hidden = false;
  }
  const clearState = () => { stateEl.hidden = true; };

  /**
   * Build the one iframe.
   *
   * Called on first load and on retry. Retry replaces the frame with a new one
   * pointing at the SAME url rather than poking .src, so a half-loaded document
   * cannot linger — and `replaceChildren` guarantees there is never more than
   * one frame on the page.
   */
  function mount(game) {
    clearTimeout(timer);
    clearState();
    setStatus('Loading the game…');

    const frame = document.createElement('iframe');
    frame.className = 'gf-frame';
    // EXACT value from the validated record. Nothing is appended to it.
    frame.src = game.embedUrl;
    frame.title = `Play ${game.name}`;
    frame.setAttribute('allowfullscreen', '');
    // Only what a game genuinely needs. No camera, microphone, geolocation or
    // payment — an embed that does not ask for them should not be handed them.
    frame.setAttribute('allow', 'autoplay; fullscreen; gamepad');
    frame.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
    frame.loading = 'eager';

    frame.addEventListener('load', () => {
      clearTimeout(timer);
      // Deliberately modest wording. The frame produced a document; whether the
      // game runs is not observable from here.
      setStatus('Game loaded.');
    }, { once: true });

    timer = setTimeout(() => {
      setStatus('');
      showState(
        'This game is currently unavailable.',
        'It did not finish loading. This can be temporary — you can try again.',
        { retry: true },
      );
    }, LOAD_TIMEOUT_MS);

    stage.replaceChildren(frame);
    currentEmbedUrl = game.embedUrl;
    fsBtn.hidden = false;
    return frame;
  }

  // ── Fullscreen ───────────────────────────────────────────────────────────
  // Standard browser fullscreen on the stage. If it is unavailable or refused,
  // say so in the page. Never fall back to opening the game elsewhere.
  fsBtn.addEventListener('click', async () => {
    const target = stage;
    const req = target.requestFullscreen || target.webkitRequestFullscreen;
    if (!req) {
      setStatus('Fullscreen is not supported by this browser.');
      return;
    }
    try { await req.call(target); }
    catch { setStatus('Fullscreen was blocked by the browser.'); }
  });

  retryBtn.addEventListener('click', () => {
    if (!currentEmbedUrl) return;
    // Same URL, same player, same route.
    mount({ embedUrl: currentEmbedUrl, name: titleEl.textContent || 'game' });
  });

  // ── Resolve the game ─────────────────────────────────────────────────────
  (async () => {
    // Read the slug from our own path. The server validates it again before
    // lookup; this is only about forming the request.
    const parts = location.pathname.split('/').filter(Boolean);   // ['gameflare','play','<slug>']
    const slug = parts[2] ? decodeURIComponent(parts[2]) : '';

    if (!slug) {
      titleEl.textContent = 'Game not found';
      showState('Game not found.', 'That address does not point at a game in this catalog.');
      return;
    }

    // Verification preview: the browser worker loads this exact page with a
    // ?verify=<token> parameter so an unverified CANDIDATE resolves. The token
    // is forwarded as a header and never rendered into the DOM. Without it the
    // API returns only verified games, so a normal visitor cannot reach a
    // candidate by editing the URL.
    const verifyToken = new URLSearchParams(location.search).get('verify');
    const headers = { accept: 'application/json' };
    if (verifyToken) headers['x-gameflare-verify'] = verifyToken;

    let data;
    try {
      const r = await fetch(`/api/gameflare/games/${encodeURIComponent(slug)}`, { headers });
      data = await r.json();
      if (!r.ok || !data?.ok) {
        titleEl.textContent = r.status === 404 ? 'Game not found' : 'Catalog unavailable';
        document.title = `${titleEl.textContent} · ZoFHub`;
        showState(
          r.status === 404 ? 'This game is not available.' : 'The game catalog is temporarily unavailable.',
          r.status === 404
            ? 'It is not in the verified catalog. It may never have been, or it may have been withdrawn.'
            : 'Please try again later.',
        );
        return;
      }
    } catch {
      titleEl.textContent = 'Catalog unavailable';
      showState('The game catalog is temporarily unavailable.', 'Please try again later.');
      return;
    }

    const game = data.game;
    titleEl.textContent = game.name;
    document.title = `${game.name} · ZoFHub`;

    const bits = [];
    if (game.categories?.length) bits.push(game.categories.join(' · '));
    if (game.ratingPercent !== null && game.ratingPercent !== undefined) bits.push(`${game.ratingPercent}% rating`);
    if (game.playCountDisplay) bits.push(`${game.playCountDisplay} plays`);
    if (game.developer) bits.push(game.developer);
    metaEl.textContent = bits.join(' — ');

    mount(game);
  })();
})();
