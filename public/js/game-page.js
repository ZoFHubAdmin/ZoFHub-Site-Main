// ZoFHub · game-page.js
import { $, el, fetchJson, toast, wireThumbFallback } from './utils.js';
import { store } from './storage.js';
import { presence, fmtCount, paintCount } from './presence.js';
import { getPlayerName } from './identity.js';

const slug = window.ZOFHUB_GAME?.slug || (location.pathname.match(/\/play\/([^/?#]+)/) || [])[1];

// Premium loading backdrop: blur the game's own thumbnail behind the iframe so
// the wait reads as a branded loading state, never a flat black screen. Falls
// back to the frame-box gradient when there's no thumbnail.
(function setLoadBackdrop() {
  const t = (window.ZOFHUB_GAME?.thumbnail || '').trim();
  const bg = document.getElementById('frameThumbBg');
  if (t && t !== 'undefined' && bg) bg.style.backgroundImage = `url("${t.replace(/"/g, '%22')}")`;
})();

// Per-load shuffle seed for the "more games" row (popularity-ranked, varied).
const SEED = Math.random().toString(36).slice(2, 10);

// Tell the server this game was opened — the "how much it's played" signal that
// drives popularity ranking across the whole site. Fire-and-forget; a failure
// here must never affect playing the game.
function recordPlay() {
  try {
    fetch('/api/play', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug }),
      keepalive: true,
    }).catch(() => {});
  } catch {}
}

if (slug) {
  store.history.push(slug);
  presence.setSlug(slug);
  recordPlay();
  bindActions();
  bindFrame();
  bindLiveCount();
  bindScores();
  loadRelated();
}

// Switch the running game over to the server-side /embed proxy. Used by the
// top-right "Proxy" button, the error card, and the extended-loading link —
// for games whose publisher blocks direct embedding (X-Frame-Options / referer).
function loadViaProxy() {
  const f = $('#gameFrame');
  if (!f) return;
  toast('Loading via ZoFHub proxy…', 'ok');
  // Preferred path: hand off to the frame controller (full state reset + the
  // same auto-retry the normal load gets). Falls back to a manual swap only if
  // bindFrame hasn't run yet.
  if (typeof f._loadProxy === 'function') { f._loadProxy(); return; }
  const purl = window.ZOFHUB_GAME?.proxyUrl || `/embed/${encodeURIComponent(window.ZOFHUB_GAME?.slug || slug || '')}`;
  $('#frameBox')?.querySelector('.frame-error')?.remove();
  const loader = $('#gameLoader');
  loader?.classList.remove('hide', 'waiting');
  f.dataset.originalSrc = purl;
  f.src = 'about:blank';
  requestAnimationFrame(() => { f.src = purl; });
}

// ── Leaderboard: per-game player-reported scores ──────────────────────────
function bindScores() {
  const panel = $('#scorePanel');
  const btn   = $('#scoreBtn');
  const form  = $('#scoreForm');
  const list  = $('#scoreList');
  if (!panel || !btn) return;

  // This device's persistent player name + the proof-of-play token from the page.
  const playerName = getPlayerName();
  const token = document.querySelector('meta[name="score-token"]')?.content || '';
  const asEl = $('#scoreAs');
  if (asEl) asEl.textContent = playerName;

  const render = (scores) => {
    if (!list) return;
    if (!scores || !scores.length) { list.innerHTML = '<li class="score-empty">No scores yet — be the first!</li>'; return; }
    list.innerHTML = '';
    scores.forEach((s, i) => {
      const li = el('li', { class: `score-row${i < 3 ? ' top' : ''}` });
      li.innerHTML = `<span class="score-rank">${i + 1}</span><span class="score-pname"></span><span class="score-val">${Number(s.score).toLocaleString()}</span>`;
      li.querySelector('.score-pname').textContent = s.player_name || 'Player';
      list.appendChild(li);
    });
  };
  const load = async () => {
    try { const d = await fetchJson(`/api/scores?slug=${encodeURIComponent(slug)}&limit=15`); render(d.scores || []); }
    catch { /* leave default */ }
  };

  btn.addEventListener('click', () => {
    panel.hidden = !panel.hidden;
    if (!panel.hidden) { load(); panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }
  });

  form?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const score = parseInt($('#scoreValue')?.value, 10);
    if (!Number.isFinite(score) || score < 0) { toast('Enter a valid score', 'err'); return; }
    try {
      const r = await fetch('/api/scores', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug, name: playerName, score, token })
      });
      const j = await r.json();
      if (!j.ok) { toast(j.error || 'Could not submit', 'err'); return; }
      toast(j.updated ? 'New personal best! 🏆' : (j.created ? 'Score submitted! 🏆' : 'Your best score is kept 🏆'), 'ok');
      if ($('#scoreValue')) $('#scoreValue').value = '';
      load();
    } catch { toast('Network error', 'err'); }
  });

  // Best-effort: some embedded games postMessage a score; prefill the input.
  window.addEventListener('message', (ev) => {
    try {
      const d = ev.data;
      const v = (d && (d.score ?? d.points ?? (d.type === 'score' && d.value)));
      if (typeof v === 'number' && v >= 0 && $('#scoreValue') && !$('#scoreValue').value) {
        $('#scoreValue').value = Math.floor(v);
        if (panel.hidden) { panel.hidden = false; }
      }
    } catch {}
  });
}

function bindLiveCount() {
  // Add a pulsing "X playing now" pill next to the title.
  const meta = $('.play-meta');
  if (!meta || meta.querySelector('.live-pill')) return;
  const pill = el('span', { class: 'live-pill live-pill-big' });
  meta.appendChild(pill);
  presence.subscribe(snap => {
    const n = snap?.games?.[slug] || 0;
    if (n > 0) {
      paintCount(pill, n, v => `${fmtCount(v)} playing now`);
      pill.classList.add('on');
    } else {
      pill.textContent = 'You’re the first one here';
      pill.classList.remove('on');
    }
  });
}

function bindActions() {
  const favBtn = $('#favBtn');
  if (favBtn) {
    const sync = () => favBtn.classList.toggle('is-fav', store.favorites.has(slug));
    favBtn.addEventListener('click', () => {
      const on = store.favorites.toggle(slug);
      toast(on ? 'Added to favorites' : 'Removed from favorites', 'ok');
      sync();
    });
    sync();
  }
  $('#shareBtn')?.addEventListener('click', async () => {
    const url = location.href;
    const title = window.ZOFHUB_GAME?.title || document.title;
    if (navigator.share) { try { await navigator.share({ title, url }); return; } catch {} }
    try { await navigator.clipboard.writeText(url); toast('Link copied', 'ok'); }
    catch { toast('Copy failed', 'err'); }
  });
  $('#fullscreenBtn')?.addEventListener('click', () => {
    const wrap = $('#frameBox');
    if (!document.fullscreenElement && wrap?.requestFullscreen) wrap.requestFullscreen();
    else document.exitFullscreen?.();
  });
  $('#reloadBtn')?.addEventListener('click', reloadGame);

  // Proxy button — manually route the game through the server-side /embed
  // proxy (bypasses X-Frame-Options / referer blocks) if it won't load direct.
  $('#proxyBtn')?.addEventListener('click', loadViaProxy);

  // "Game not loading?" fallback link — open the publisher URL directly in a new tab.
  const directLink = $('#openDirectLink');
  if (directLink) {
    const up = window.ZOFHUB_GAME?.upstream || '';
    if (up) {
      directLink.href = up;
      directLink.target = '_blank';
      directLink.rel = 'noopener noreferrer';
      directLink.textContent = 'Open directly in new tab';
    }
  }

  // Keyboard shortcuts (outside text inputs)
  window.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    if (e.key === 'r' || e.key === 'R') { e.preventDefault(); reloadGame(); }
  });
}

function reloadGame() {
  const frame = $('#gameFrame');
  const loader = $('#gameLoader');
  if (!frame) return;
  toast('Reloading game…', 'ok');
  // Preferred path: re-run the FULL load cycle (resets the `loaded` flag so the
  // loader can hide again, re-arms auto-retry). The old code only swapped src
  // without resetting state, so after a manual reload the overlay stayed stuck
  // on top of a working game — which is exactly why a hard page-refresh was
  // needed. _restart fixes that.
  if (typeof frame._restart === 'function') { frame._restart(); return; }
  // Fallback only if bindFrame hasn't run yet.
  const src = frame.dataset.originalSrc || frame.getAttribute('src') || frame.src;
  loader?.classList.remove('hide', 'waiting');
  frame.src = 'about:blank';
  requestAnimationFrame(() => { frame.src = src; });
}

function bindFrame() {
  const frame  = $('#gameFrame');
  const loader = $('#gameLoader');
  const box    = $('#frameBox');
  if (!frame || !box) return;

  const proxyUrl  = window.ZOFHUB_GAME?.proxyUrl  || '';
  const upstream  = window.ZOFHUB_GAME?.upstream   || '';

  // The iframe ships WITHOUT a src (see game.html) so we attach the load/error
  // listeners FIRST, then start the load ourselves.
  const startSrc  = (window.ZOFHUB_GAME?.iframeSrc || frame.getAttribute('src')
                     || frame.dataset.src || proxyUrl || upstream || '').trim();
  const startedOnProxy = startSrc.startsWith('/embed/');

  // Load chain: proxy (default) → proxy(ua=1) → proxy(ua=2) → direct → error card.
  const stages = [];
  if (proxyUrl) {
    stages.push({ src: proxyUrl,           timeoutMs: 16_000 });
    stages.push({ src: proxyUrl + '?ua=1', timeoutMs: 16_000 });
    stages.push({ src: proxyUrl + '?ua=2', timeoutMs: 16_000 });
  }
  // Last-ditch: if the proxy can't fetch the game at all, try the publisher
  // directly before showing the error card (covers the rare game the proxy
  // can't reach — TLS/DNS/geo issues server-side).
  if (upstream && upstream !== proxyUrl) {
    stages.push({ src: upstream, timeoutMs: 12_000 });
  }

  // Generous per-attempt budgets. We deliberately do NOT blank/restart a load
  // that may still be in flight. The OLD code reset the iframe to about:blank
  // every ~5s, which threw away an 80%-loaded game and bounced perfectly-good
  // games to the proxy — that was the "keeps saying loading through a proxy even
  // when the game works" bug. Now we trust the iframe's own `load` event to
  // reveal the game the instant its document is up, and use these timeouts ONLY
  // as a last-resort fallback to the proxy.
  const DIRECT_TIMEOUT = 12_000;   // direct publisher load (preflight fast-fails blocked games first)
  const PROXY_TIMEOUT  = 16_000;   // server-side /embed (adds one round-trip)

  let loaded        = false;
  let stageIdx      = -1;     // -1 = direct mode, 0+ = into the proxy chain
  let currentTimer  = null;
  let netTimer      = null;
  let preflightDone = false;

  // Status line lives in the loader's <p>. Kept neutral ("Loading…") so a slow
  // load never spams the user with scary "switching to proxy / retrying" text.
  const setStatus = (msg) => { const p = loader?.querySelector('p'); if (p && msg) p.textContent = msg; };

  // ── finish() — reveal the game the instant a real document loads ──────────
  // `.hide` fades the overlay out and sets pointer-events:none (CSS), so the
  // game is immediately playable with NO lingering dark layer on top of it.
  function finish() {
    if (loaded) return;
    loaded = true;
    clearTimeout(currentTimer);
    clearTimeout(netTimer);
    loader?.classList.remove('waiting');
    loader?.classList.add('hide');
  }

  // Arm a SINGLE fallback timer for the current attempt. On expiry we move on to
  // the next stage (or show the error card) — we never blank a load that might
  // still be progressing, so a slow-but-healthy game gets to finish on its own.
  function armTimeout(timeoutMs, onGiveUp) {
    clearTimeout(currentTimer);
    currentTimer = setTimeout(() => { if (!loaded) onGiveUp(); }, timeoutMs);
  }

  // ── advanceStage() — move to the next proxy engine in the chain ───────────
  function advanceStage() {
    if (loaded) return;
    clearTimeout(currentTimer);
    loader?.classList.remove('waiting', 'hide');
    stageIdx += 1;
    if (stageIdx >= stages.length) {
      showError('Game failed to load — try opening it in a new tab.');
      return;
    }
    const stage = stages[stageIdx];
    setStatus(stageIdx === 0 ? 'Loading…' : 'Still working on it…');
    frame.src = stage.src;
    armTimeout(stage.timeoutMs, advanceStage);
  }

  // ── load event ───────────────────────────────────────────────────────────
  // Ignore the empty about:blank flash from the initial src-less iframe. Any
  // REAL document arriving — a cross-origin game (location.href throws) or our
  // same-origin /embed page — means the game is up, so reveal it immediately.
  // Genuinely framing-blocked games are caught up-front by the /api/frame-check
  // preflight (which fast-fails to the proxy), so we can safely trust this.
  frame.addEventListener('load', () => {
    let href = '__cross__';
    try { href = frame.contentWindow?.location?.href || ''; } catch { href = '__cross__'; }
    if (href === 'about:blank' || href === 'about:srcdoc' || href === '') return;
    if (loaded) return;
    finish();
  });
  frame.addEventListener('error', () => { if (!loaded) advanceStage(); });

  // ── Parallel preflight: /api/frame-check ─────────────────────────────────
  // Runs alongside the direct timer. If the server confirms the game is dead or
  // framing-blocked, jump to the proxy immediately instead of waiting out the
  // timer — cuts the dark-screen wait for broken/blocked games to <1 s.
  function runPreflight() {
    if (preflightDone) return;
    if (!(proxyUrl && !startedOnProxy && slug)) return;
    preflightDone = true;
    fetch(`/api/frame-check?slug=${encodeURIComponent(slug)}`)
      .then(r => r.json())
      .then(d => {
        if (loaded || stageIdx !== -1) return;
        if (d.embeddable === false) { clearTimeout(currentTimer); advanceStage(); }
      })
      .catch(() => {}); // ignore preflight errors — proceed with direct mode
  }

  // ── startLoad() — a FULL, re-armable load cycle ──────────────────────────
  // Called once on page load AND every time the user (or the error card) hits
  // Reload/Proxy. Resetting `loaded` here is the fix for the stuck overlay that
  // used to force a whole-page refresh.
  function startLoad(opts = {}) {
    loaded = false;
    clearTimeout(currentTimer);
    clearTimeout(netTimer);
    box.querySelector('.frame-error')?.remove();
    loader?.classList.remove('hide', 'waiting');
    setStatus('Loading…');

    // Last-resort net: never let the overlay intercept taps forever. If we're
    // still loading after this window, stop it blocking input (the game beneath
    // stays usable). Re-armed every cycle so manual reloads get a fresh net.
    netTimer = setTimeout(() => {
      if (!loaded && loader && !loader.classList.contains('hide')) loader.classList.add('hide');
    }, 30_000);

    if (opts.forceProxy && stages.length) {
      stageIdx = -1;
      advanceStage();           // jumps to stages[0] (the proxy)
      return;
    }
    if (startedOnProxy) {
      stageIdx = 0;
      frame.src = startSrc;
      armTimeout(PROXY_TIMEOUT, advanceStage);
    } else {
      stageIdx = -1;
      frame.src = startSrc;
      armTimeout(DIRECT_TIMEOUT, () => {
        if (stages.length) advanceStage();
        else showError('This game is taking too long to start.');
      });
      runPreflight();
    }
  }

  // Expose hooks for the Reload / Proxy buttons + the R shortcut.
  frame._restart   = () => startLoad();
  frame._loadProxy = () => startLoad({ forceProxy: true });

  startLoad();
}

function showError(msg) {
  const box = $('#frameBox');
  const loader = $('#gameLoader');
  loader?.classList.add('hide');
  if (!box || box.querySelector('.frame-error')) return;
  const frame = $('#gameFrame');
  const upstream = window.ZOFHUB_GAME?.upstream || frame?.getAttribute('src') || '';
  const currentSrc = frame?.getAttribute('src') || '';
  const alreadyProxied = currentSrc.startsWith('/embed/');
  // The "Try via ZoFHub proxy" button only shows when we're not already on
  // the proxy path — i.e. this is a direct-iframe game that probably hit
  // X-Frame-Options or referer blocking.
  const proxyBtn = alreadyProxied ? '' : `
    <button class="btn-primary" data-act="proxy">
      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 12h16M4 12l4-4M4 12l4 4"/><path d="M14 6l4 4-4 4"/></svg>
      Load via ZoFHub proxy
    </button>`;
  const overlay = el('div', { class: 'frame-error', role: 'alert' });
  overlay.innerHTML = `
    <div class="frame-error-card">
      <div class="frame-error-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="36" height="36" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 7v6M12 16.5v.5"/></svg>
      </div>
      <h3>Couldn’t load this game</h3>
      <p>${msg.replace(/[<>]/g, '')}</p>
      <p class="frame-error-hint">${alreadyProxied
        ? 'The game is already routing through our proxy — the publisher may be down. Try again or pick another.'
        : 'Sometimes the publisher blocks direct embedding. Try loading via our server-side proxy — it bypasses most restrictions.'}</p>
      <div class="frame-error-actions">
        ${proxyBtn}
        <button class="btn-ghost" data-act="retry">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 3v6h-6"/></svg>
          Try again
        </button>
        <a class="btn-ghost" href="${upstream}" target="_blank" rel="noopener noreferrer">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 4h6v6"/><path d="M20 4l-9 9"/><path d="M19 13v6H5V5h6"/></svg>
          Open in new tab
        </a>
        <a class="btn-ghost" href="/">Pick another game</a>
      </div>
    </div>`;
  box.appendChild(overlay);
  overlay.querySelector('[data-act="retry"]')?.addEventListener('click', () => {
    overlay.remove();
    reloadGame();
  });
  overlay.querySelector('[data-act="proxy"]')?.addEventListener('click', () => {
    overlay.remove();
    loadViaProxy();
  });
}

async function loadRelated() {
  const wrap = $('#relatedGrid'); if (!wrap) return;
  try {
    // Fetch only this game's CATEGORY (~60 games ≈ 24 KB) instead of pulling 400
    // games (~160 KB) on every game page just to pick 12.
    const cat = window.ZOFHUB_GAME?.category || '';
    const url = cat ? `/api/games?category=${encodeURIComponent(cat)}&limit=60&seed=${SEED}` : `/api/games?limit=60&seed=${SEED}`;
    const data = await fetchJson(url);
    let pool = (data.games || []).filter(g => g.slug !== slug);
    // Top up from a general sample if the category was small.
    if (pool.length < 12) {
      const more = await fetchJson(`/api/games?limit=60&seed=${SEED}`);
      const seen = new Set(pool.map(g => g.slug).concat(slug));
      pool = pool.concat((more.games || []).filter(g => !seen.has(g.slug)));
    }
    pool.sort(() => Math.random() - .5);
    const picks = pool.slice(0, 12);
    wrap.innerHTML = '';
    picks.forEach(g => wrap.appendChild(buildTile(g)));
  } catch (e) { console.warn('related:', e); }
}

function buildTile(g) {
  const a = el('a', { class: 'game-tile', href: `/play/${g.slug}` });
  const safe = String(g.title).replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));
  if (g.thumbnail) {
    a.innerHTML = `<img loading="lazy" src="${g.thumbnail}" alt="${safe}" data-title="${safe}" />`;
    wireThumbFallback(a.querySelector('img'));
  } else {
    let h = 0; for (let i = 0; i < g.title.length; i++) h = (h * 31 + g.title.charCodeAt(i)) >>> 0;
    const palette = ['#ff4d8d','#7c3aed','#22d3ee','#34d399','#f59e0b','#ef4444','#a855f7'];
    const c1 = palette[h % palette.length], c2 = palette[(h >> 8) % palette.length];
    const initials = g.title.split(/\s+/).slice(0, 2).map(s => s[0]).join('').toUpperCase();
    a.innerHTML = `<div class="game-tile-fallback" style="--c1:${c1};--c2:${c2}">${initials}</div>`;
  }
  a.insertAdjacentHTML('beforeend', `<span class="game-tile-label">${safe}</span>`);
  return a;
}

// buildFallback / wireThumbFallback now come from utils.js (shared everywhere).
