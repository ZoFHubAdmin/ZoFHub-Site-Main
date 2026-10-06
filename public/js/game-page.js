// ZoFHub · game-page.js
import { $, el, fetchJson, toast, wireThumbFallback } from './utils.js';
import { store } from './storage.js';
import { dwell, skips as skipSignal } from './signals.js?v=20260807';
import { presence, fmtCount, paintCount } from './presence.js';
import { OptimizedIframeLoader } from './iframe-loader-optimized.js';
// The page's shared /api/site-config request (see site-config.js). Same
// specifier as layout.js, so this is the same promise, not a second fetch.
import { siteConfig } from './site-config.js';
import { startVitals } from './telemetry.js';

// Sampled, bucketed page-speed measurement. Identity-free and self-disabling on
// browsers without PerformanceObserver — see public/js/telemetry.js.
startVitals();

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

// ── Dwell ──────────────────────────────────────────────────────────────────
// How long the game was actually open, bucketed into bounce / short / long by
// signals.js before anything is stored. This is the signal that separates "I
// opened it and immediately left" from "I played this for twenty minutes" —
// history alone records both identically, which is why a game you bounced off
// used to keep seeding recommendations as strongly as a favourite.
//
// visibilitychange rather than beforeunload/unload: those are unreliable on
// mobile (Safari in particular never fires unload when the app is backgrounded),
// so a phone session would record nothing at all. `hidden` fires in every case
// that matters, including tab-switch and app-switch.
function bindDwell(id) {
  const started = Date.now();
  let recorded = false;
  const flush = () => {
    if (recorded) return;
    recorded = true;
    dwell.record(id, Math.round((Date.now() - started) / 1000));
  };
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush();
  });
  window.addEventListener('pagehide', flush);
}

if (slug) {
  store.history.push(slug);
  // Opening a game retracts any skip recorded against it — the strongest
  // available correction, and it has to win over "you scrolled past this twice".
  skipSignal.clear(slug);
  bindDwell(slug);
  presence.setSlug(slug);
  recordPlay();
  bindActions();
  startGame();
  bindLiveCount();
  loadRelated();
}

// ── The game frame, behind the optional video pre-roll ─────────────────────
// The frame gets its src only after the pre-roll (preroll.js) settles — it
// completed, was skipped, failed, had no fill, was blocked or hung. Three caps
// keep the player from ever waiting on an ad:
//   • the server says whether a pre-roll exists anywhere (ZOFHUB_GAME.preroll);
//     when it does not, the frame binds immediately, exactly as before;
//   • site-config gets PREROLL_CONFIG_WAIT_MS to say whether THIS visitor gets
//     one — a slow answer means no pre-roll, not a slow game;
//   • PREROLL_HARD_CAP_MS binds the frame whatever preroll.js is doing (it has
//     its own failsafe; this one also covers a module that failed to load).
const PREROLL_CONFIG_WAIT_MS = 2500;
const PREROLL_HARD_CAP_MS = 50000;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function prerollGate() {
  if (window.ZOFHUB_GAME?.preroll !== true) return;
  const cfg = await Promise.race([siteConfig, wait(PREROLL_CONFIG_WAIT_MS).then(() => null)]);
  if (!cfg || cfg.adsAllowed === false || !cfg.preroll || typeof cfg.preroll.vast !== 'string') return;
  const { runPreroll } = await import('./preroll.js');
  await runPreroll({ vast: cfg.preroll.vast, box: $('#frameBox') });
}

async function startGame() {
  try { await Promise.race([prerollGate(), wait(PREROLL_HARD_CAP_MS)]); }
  catch { /* an ad problem is never a game problem */ }
  bindFrameOptimized();
  autoFitFromEmbed();
}

// Shape the frame-box to the game's TRUE aspect ratio. Proxied publishers (Y8
// especially) hard-code the game into a fixed-size inner <iframe>, and games come
// in many shapes — including portrait — while our frame-box defaults to 16:9, so
// those games end up squashed or tiny with big letterbox bars ("not properly
// styled for width and length"). /embed is SAME-ORIGIN, so we can read the inner
// iframe's real pixel size and set the box's aspect-ratio (and portrait flag) to
// match — so every game fills its box at its true proportions, no stretch.
function autoFitFromEmbed() {
  const frame = $('#gameFrame');
  const box = $('#frameBox');
  if (!frame || !box) return;
  if (!(window.ZOFHUB_GAME?.iframeSrc || '').startsWith('/embed/')) return;  // only same-origin proxied pages are readable
  let tries = 0;
  const poll = setInterval(() => {
    if (++tries > 40) { clearInterval(poll); return; }   // ~6s, then give up (keep default)
    let w = 0, h = 0;
    try {
      const doc = frame.contentDocument;
      const inner = doc && doc.querySelector('.container iframe, .container canvas, body > iframe, body > canvas');
      if (inner) {
        const s = inner.getAttribute('style') || '';
        w = parseFloat((s.match(/width:\s*([\d.]+)px/) || [])[1]) || parseFloat(inner.getAttribute('width')) || 0;
        h = parseFloat((s.match(/height:\s*([\d.]+)px/) || [])[1]) || parseFloat(inner.getAttribute('height')) || 0;
      }
    } catch { clearInterval(poll); return; }              // cross-origin → unreadable, leave default
    if (w >= 100 && h >= 100 && w <= 6000 && h <= 6000) {
      clearInterval(poll);
      box.style.aspectRatio = `${Math.round(w)} / ${Math.round(h)}`;
      // Portrait games get the centered, width-capped portrait layout (game-page.css).
      box.dataset.orientation = h > w * 1.1 ? 'portrait' : 'landscape';
    }
  }, 150);
}

// Switch the running game over to the server-side /embed proxy. Used by the
// top-right "Proxy" button, the error card, and the extended-loading link —
// for games whose publisher blocks direct embedding (X-Frame-Options / referer).
function loadViaProxy() {
  const f = $('#gameFrame');
  if (!f) return;
  // Before the frame is bound (the pre-roll is still playing) there is nothing
  // to switch; startGame() binds it moments later.
  if (!f._loader) return;
  toast('Loading via ZoFHub proxy…', 'ok');
  
  // Use the optimized loader's proxy method
  if (typeof f._loadProxy === 'function') {
    f._loadProxy();
    return;
  }
  
  // Fallback for older code
  const purl = window.ZOFHUB_GAME?.proxyUrl || `/embed/${encodeURIComponent(window.ZOFHUB_GAME?.slug || slug || '')}`;
  $('#frameBox')?.querySelector('.frame-error')?.remove();
  const loader = $('#gameLoader');
  loader?.classList.remove('hide', 'waiting');
  f.dataset.originalSrc = purl;
  f.src = 'about:blank';
  requestAnimationFrame(() => { f.src = purl; });
}

// The per-game leaderboard lived here (bindScores). It was retired server-side
// when db/feedback.sql dropped the `scores` table and its routes, but the client
// was left wired: ensureSession() fired POST /api/scores/session on EVERY game
// page open — a guaranteed 404 on every one of the ~12,300 game pages — and the
// panel it filled could only ever read back "No scores yet". Removed with the
// markup in game.html rather than left to fail quietly.

function bindLiveCount() {
  // Add a pulsing "X playing now" pill next to the title.
  const meta = $('.play-meta');
  if (!meta || meta.querySelector('.live-pill')) return;
  const pill = el('span', { class: 'live-pill live-pill-big' });
  meta.appendChild(pill);
  presence.subscribe(snap => {
    // Number() first — an absent slug reads back an inherited prototype
    // function, which is truthy and would defeat a bare `|| 0`. See catalog.js.
    const n = Number(snap?.games?.[slug]) || 0;
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

  // The always-visible notice bar's Reload button — same one-tap recovery as the
  // top Reload button / the R key, but right where a stuck frame draws the eye.
  $('#noticeReloadBtn')?.addEventListener('click', reloadGame);

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
  if (!frame) return;
  // Nothing to reload while the pre-roll is still in front of the frame.
  if (!frame._loader) return;
  toast('Reloading game…', 'ok');
  
  // Use the optimized loader's restart method
  if (typeof frame._restart === 'function') {
    frame._restart();
    return;
  }
  
  // Fallback for older code
  const loader = $('#gameLoader');
  const src = frame.dataset.originalSrc || frame.getAttribute('src') || frame.src;
  loader?.classList.remove('hide', 'waiting');
  frame.src = 'about:blank';
  requestAnimationFrame(() => { frame.src = src; });
}

function bindFrameOptimized() {
  const frame  = $('#gameFrame');
  const loader = $('#gameLoader');
  const box    = $('#frameBox');
  if (!frame || !box) return;

  // Use the optimized iframe loader
  const iframeLoader = new OptimizedIframeLoader({
    frame,
    loader,
    box,
    slug,
    proxyUrl: window.ZOFHUB_GAME?.proxyUrl,
    upstream: window.ZOFHUB_GAME?.upstream,
    iframeSrc: window.ZOFHUB_GAME?.iframeSrc,
    // GameMonetize / GameDistribution: never fall back to the proxy (their SDK
    // black-screens behind /embed). Passed explicitly so the loader doesn't have
    // to rely on the global.
    directOnly: window.ZOFHUB_GAME?.directOnly
  });

  // Expose hooks for the Reload / Proxy buttons + the R shortcut
  frame._restart   = () => iframeLoader.restart();
  frame._loadProxy = () => iframeLoader.loadProxy();
  
  // Store loader instance for cleanup
  frame._loader = iframeLoader;
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
  // Every catalog field is third-party data. The thumbnail was interpolated RAW
  // into src="…", so a feed row whose URL contained a quote could add its own
  // attributes (an onerror handler) to this tile. Escaped like the title now,
  // including the single quote.
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
  const safe = esc(g.title);
  if (g.thumbnail) {
    a.innerHTML = `<img loading="lazy" src="${esc(g.thumbnail)}" alt="${safe}" data-title="${safe}" />`;
    wireThumbFallback(a.querySelector('img'));
  } else {
    let h = 0; for (let i = 0; i < g.title.length; i++) h = (h * 31 + g.title.charCodeAt(i)) >>> 0;
    const palette = ['#3a2a7a','#442f8c','#33246b','#4a3596','#382874','#402d84','#2e2160'];
    const c1 = palette[h % palette.length], c2 = palette[(h >> 8) % palette.length];
    const initials = g.title.split(/\s+/).slice(0, 2).map(s => s[0]).join('').toUpperCase();
    a.innerHTML = `<div class="game-tile-fallback" style="--c1:${c1};--c2:${c2}">${esc(initials)}</div>`;
  }
  a.insertAdjacentHTML('beforeend', `<span class="game-tile-label">${safe}</span>`);
  return a;
}

// buildFallback / wireThumbFallback now come from utils.js (shared everywhere).
