// ZoFHub · Optimized Iframe Loader
// Ultra-fast iframe loading with retry logic, timeout handling, and performance optimization
import { $, el, toast } from './utils.js';
import { reportGameFailure } from './telemetry.js';

// Timeouts tuned so a slow-but-HEALTHY game is never restarted mid-load. A
// game's iframe `load` event can take 5–12s for heavy WebGL titles; the old 4s
// timeout gave up early and reloaded the frame from zero, so slow games cycled
// forever and never appeared (the "keeps trying / won't load" bug). Since the
// proxy strips X-Frame-Options, there is no "blocked" case to fail fast for —
// so we can afford to wait. These are last-resort fallbacks, not the happy path:
// the iframe `load` event reveals the game the instant it's actually ready.
const MAX_RETRIES = 2;              // full-chain restarts before showing the error card
const PROXY_TIMEOUT = 15000;        // default /embed path — generous (games load their own assets)
// GameMonetize / GameDistribution splash pages routinely take 8–12s to fire their
// outer `load` event (they preload the whole game engine first). The old 12s
// budget was a coin-flip on a school/slow connection — when it lost, the loader
// gave up and switched to PROXYING these publishers, which black-screens them
// (their SDK can't pull assets through /embed → stuck at "LOADING 0%"). So the
// direct budget is now a generous last-resort net: the `load` event still reveals
// the game the instant it's genuinely ready, long before this fires.
const DIRECT_TIMEOUT = 25000;       // direct-publisher safety net (was 12000 → caused false-fail → broken proxy fallback)
const PREFLIGHT_TIMEOUT = 3000;     // /api/frame-check HEAD budget
const OPTIMISTIC_REVEAL = 2500;     // fully uncover the frame this early (all paths) — see scheduleReveal
const NET_TIMEOUT = 35000;          // overlay safety net — must exceed any single stage timeout

class OptimizedIframeLoader {
  constructor(options = {}) {
    this.frame = options.frame || $('#gameFrame');
    this.loader = options.loader || $('#gameLoader');
    this.box = options.box || $('#frameBox');
    this.slug = options.slug || window.ZOFHUB_GAME?.slug;
    this.proxyUrl = options.proxyUrl || window.ZOFHUB_GAME?.proxyUrl;
    this.upstream = options.upstream || window.ZOFHUB_GAME?.upstream;
    this.iframeSrc = options.iframeSrc || window.ZOFHUB_GAME?.iframeSrc;
    // directOnly = GameMonetize / GameDistribution. These MUST load direct — the
    // server never proxies them (their SDK breaks behind /embed), so the loader
    // must never fall back to the proxy for them either.
    this.directOnly = options.directOnly ?? window.ZOFHUB_GAME?.directOnly ?? false;
    
    this.loaded = false;
    this.retryCount = 0;
    this.currentStage = -1;
    this.currentTimer = null;
    this.revealTimer = null;
    this.netTimer = null;
    this.revealed = false;
    this.preflightDone = false;
    this.abortController = null;
    
    // Bind ONCE so addEventListener and removeEventListener reference the SAME
    // function object. `this.onLoad.bind(this)` creates a NEW function each call,
    // so the old destroy() removed nothing (a real, if latent, listener leak).
    this._onLoad = this.onLoad.bind(this);
    this._onError = this.onError.bind(this);

    this.stages = this.buildStages();
    this.init();
  }

  buildStages() {
    const stages = [];
    // Proxy stages are the fallback for publishers that block direct embedding
    // (X-Frame-Options / referer). But GameMonetize + GameDistribution BLACK-SCREEN
    // when proxied — for them the proxy is never a valid fallback, so skip it.
    if (this.proxyUrl && !this.directOnly) {
      stages.push({ src: this.proxyUrl, timeout: PROXY_TIMEOUT, name: 'proxy' });
      stages.push({ src: this.proxyUrl + '?ua=1', timeout: PROXY_TIMEOUT, name: 'proxy-ua1' });
      stages.push({ src: this.proxyUrl + '?ua=2', timeout: PROXY_TIMEOUT, name: 'proxy-ua2' });
    }
    if (this.upstream && this.upstream !== this.proxyUrl) {
      stages.push({ src: this.upstream, timeout: DIRECT_TIMEOUT, name: 'direct' });
    }
    return stages;
  }

  init() {
    if (!this.frame || !this.box) return;
    
    // Add preconnect/preload for faster loading
    this.addResourceHints();
    
    // Set up event listeners (stable bound refs — see constructor)
    this.frame.addEventListener('load', this._onLoad);
    this.frame.addEventListener('error', this._onError);
    
    // Start loading
    this.startLoad();
  }

  addResourceHints() {
    // Add preconnect for all stage origins
    const origins = new Set();
    this.stages.forEach(stage => {
      try {
        const url = new URL(stage.src);
        origins.add(url.origin);
      } catch {}
    });
    
    if (this.upstream) {
      try {
        origins.add(new URL(this.upstream).origin);
      } catch {}
    }
    
    // Add preconnect links to head
    origins.forEach(origin => {
      const preconnect = document.createElement('link');
      preconnect.rel = 'preconnect';
      preconnect.href = origin;
      preconnect.crossOrigin = 'anonymous';
      document.head.appendChild(preconnect);
      
      const dnsPrefetch = document.createElement('link');
      dnsPrefetch.rel = 'dns-prefetch';
      dnsPrefetch.href = origin;
      document.head.appendChild(dnsPrefetch);
    });
  }

  setStatus(msg) {
    const p = this.loader?.querySelector('p');
    if (p && msg) p.textContent = msg;
  }

  finish() {
    if (this.loaded) return;
    this.loaded = true;
    this.clearTimers();
    this.loader?.classList.remove('waiting', 'mini');
    this.loader?.classList.add('hide');
    console.log(`[IframeLoader] Game loaded successfully on attempt ${this.retryCount + 1}`);
  }

  // FULL reset of every timer + the preflight abort. Used by finish / startLoad /
  // showError / destroy. NOTE: armTimeout must NOT use this — wiping the reveal +
  // net timers here (via armTimeout) was the bug that left the "Loading…" overlay
  // stuck on top of a game that had already loaded.
  clearTimers() {
    this.clearStageTimer();
    if (this.revealTimer) { clearTimeout(this.revealTimer); this.revealTimer = null; }
    if (this.netTimer) { clearTimeout(this.netTimer); this.netTimer = null; }
    if (this.abortController) { this.abortController.abort(); this.abortController = null; }
  }

  // Clears ONLY the per-stage load timer — never the reveal / net timers.
  clearStageTimer() {
    if (this.currentTimer) { clearTimeout(this.currentTimer); this.currentTimer = null; }
  }

  armTimeout(timeoutMs, callback) {
    this.clearStageTimer();
    this.currentTimer = setTimeout(() => {
      if (!this.loaded) callback();
    }, timeoutMs);
  }

  // Optimistically uncover the frame after a short beat. A cross-origin game (or a
  // same-origin /embed) fires the iframe `load` event LONG after it's actually
  // interactive, so waiting on it leaves the loading overlay sitting on top of an
  // already-playable game — the "it keeps saying loading" bug. We fully hide the
  // overlay here (finish() still fires on the real load); the always-visible notice
  // bar under the frame is what offers Reload if a game is genuinely stuck.
  scheduleReveal() {
    if (this.revealTimer) clearTimeout(this.revealTimer);
    this.revealed = false;
    this.revealTimer = setTimeout(() => {
      this.revealed = true;
      if (!this.loaded) { this.loader?.classList.remove('waiting', 'mini'); this.loader?.classList.add('hide'); }
    }, OPTIMISTIC_REVEAL);
  }

  // A stage TIMEOUT (not a real load error) means the game hasn't fired its load
  // event but hasn't errored either. Once the frame has been optimistically
  // revealed, the game is almost certainly running (cross-origin games routinely
  // never fire our load event), so we must NOT reload it — reloading a working game
  // is the "it restarts / re-shows loading" bug. Just ensure the overlay is gone. A
  // genuine error still fails over via onError; the notice bar covers a stuck game.
  onStageTimeout() {
    if (this.loaded) return;
    if (this.revealed) { this.loader?.classList.add('hide'); return; }
    this.advanceStage();
  }

  onLoad() {
    let href = '__cross__';
    try {
      href = this.frame.contentWindow?.location?.href || '';
    } catch {
      href = '__cross__';
    }
    
    // Ignore about:blank loads
    if (href === 'about:blank' || href === 'about:srcdoc' || href === '') return;
    if (this.loaded) return;
    
    this.finish();
  }

  onError() {
    if (!this.loaded) {
      console.warn(`[IframeLoader] Load error on stage ${this.currentStage}, retrying...`);
      // The frame raised a real error rather than just running out of time.
      // Remembered so that if we eventually give up, the report says WHY --
      // 'http_error' and 'timeout' point at different problems.
      this._failKind = 'http_error';
      this.advanceStage();
    }
  }

  advanceStage() {
    if (this.loaded) return;
    this.clearStageTimer();
    if (this.abortController) { this.abortController.abort(); this.abortController = null; }

    this.currentStage++;

    // Check if we've exhausted all stages
    if (this.currentStage >= this.stages.length) {
      this.retryCount++;
      if (this.retryCount < MAX_RETRIES) {
        console.log(`[IframeLoader] Retrying (${this.retryCount + 1}/${MAX_RETRIES})...`);
        this.currentStage = 0;
        this.startLoad();
      } else {
        this.showError('Game failed to load after multiple attempts. Try opening in a new tab.');
      }
      return;
    }

    const stage = this.stages[this.currentStage];
    this.setStatus(this.retryCount > 0
      ? `Retrying (${this.retryCount + 1}/${MAX_RETRIES})…`
      : (this.currentStage === 0 ? 'Loading…' : 'Still working on it…'));

    // Re-show the overlay for this fresh attempt, then let the optimistic reveal
    // uncover it again shortly so a failover isn't stuck behind a spinner either.
    this.loader?.classList.remove('hide');
    this.scheduleReveal();

    console.log(`[IframeLoader] Loading stage ${this.currentStage}: ${stage.name}`);
    this.frame.src = stage.src;
    this.armTimeout(stage.timeout, () => this.onStageTimeout());
  }

  async runPreflight() {
    if (this.preflightDone || !this.slug) return;
    this.preflightDone = true;
    
    if (!this.proxyUrl || this.iframeSrc?.startsWith('/embed/')) return;
    
    try {
      this.abortController = new AbortController();
      const timeoutId = setTimeout(() => this.abortController.abort(), PREFLIGHT_TIMEOUT);
      
      const response = await fetch(`/api/frame-check?slug=${encodeURIComponent(this.slug)}`, {
        signal: this.abortController.signal
      });
      
      clearTimeout(timeoutId);
      const data = await response.json();
      
      if (!this.loaded && this.currentStage === -1 && data.embeddable === false) {
        console.log('[IframeLoader] Preflight detected blocking, jumping to proxy');
        // The publisher refuses to be framed (X-Frame-Options / frame-ancestors).
        // The proxy usually rescues this, so it is NOT a failure yet -- but if
        // every stage still fails, 'refused' is the accurate diagnosis.
        this._failKind = 'refused';
        this.clearTimers();
        this.advanceStage();
      }
    } catch (error) {
      if (error.name !== 'AbortError') {
        console.warn('[IframeLoader] Preflight failed:', error.message);
      }
    }
  }

  startLoad(opts = {}) {
    this.loaded = false;
    this.clearTimers();
    this.box?.querySelector('.frame-error')?.remove();
    this.loader?.classList.remove('hide', 'waiting', 'mini');
    this.setStatus('Loading…');
    
    // Absolute backstop — the overlay can never sit on screen past this, no matter
    // what. (Redundant with the reveal below, but a guaranteed floor.)
    this.netTimer = setTimeout(() => {
      if (!this.loaded && this.loader && !this.loader.classList.contains('hide')) {
        console.warn('[IframeLoader] Net timeout reached, forcing hide');
        this.loader.classList.add('hide');
      }
    }, NET_TIMEOUT);

    // Uncover the frame after a short beat (see scheduleReveal). THIS is what keeps
    // the loading overlay from covering an already-running game — a cross-origin
    // game fires our `load` handler long after it's interactive, so we can't wait
    // for it. The blurred game-art backdrop shows through until the game paints.
    this.scheduleReveal();

    if (opts.forceProxy && this.stages.length > 0) {
      this.currentStage = -1;
      this.advanceStage();
      return;
    }

    if (this.iframeSrc?.startsWith('/embed/')) {
      this.currentStage = 0;
      this.frame.src = this.iframeSrc;
      this.armTimeout(PROXY_TIMEOUT, () => this.onStageTimeout());
    } else {
      this.currentStage = -1;
      const startSrc = this.iframeSrc || this.upstream || '';
      this.frame.src = startSrc;
      this.armTimeout(DIRECT_TIMEOUT, () => this.onStageTimeout());
      // Non-GM/GD direct games CAN be X-Frame-Options-blocked — preflight detects
      // that and jumps to the proxy. GM/GD (directOnly) can't be proxied, so skip.
      if (!this.directOnly) this.runPreflight();
    }
  }

  showError(msg) {
    this.clearTimers();
    this.loader?.classList.add('hide');

    // The one honest place to record a broken game: we have exhausted every
    // stage and the visitor is about to be told it did not load. An aggregate
    // counter only — slug + how it failed, reduced server-side to a browser
    // family. See public/js/telemetry.js and lib/telemetry.mjs.
    reportGameFailure(this._failKind || 'timeout');
    
    if (!this.box || this.box.querySelector('.frame-error')) return;
    
    const currentSrc = this.frame?.getAttribute('src') || '';
    const alreadyProxied = currentSrc.startsWith('/embed/');
    
    const proxyBtn = alreadyProxied ? '' : `
      <button class="btn-primary" data-act="proxy">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M4 12h16M4 12l4-4M4 12l4 4"/>
          <path d="M14 6l4 4-4 4"/>
        </svg>
        Load via ZoFHub proxy
      </button>`;
    
    const overlay = el('div', { class: 'frame-error', role: 'alert' });
    overlay.innerHTML = `
      <div class="frame-error-card">
        <div class="frame-error-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="36" height="36" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="9"/>
            <path d="M12 7v6M12 16.5v.5"/>
          </svg>
        </div>
        <h3>Couldn't load this game</h3>
        <p>${msg.replace(/[<>]/g, '')}</p>
        <p class="frame-error-hint">${alreadyProxied
          ? 'The game is already routing through our proxy. Try again or pick another game.'
          : 'Sometimes publishers block direct embedding. Try loading via our server-side proxy.'}</p>
        <div class="frame-error-actions">
          ${proxyBtn}
          <button class="btn-ghost" data-act="retry">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M21 12a9 9 0 1 1-3-6.7"/>
              <path d="M21 3v6h-6"/>
            </svg>
            Try again
          </button>
          <a class="btn-ghost" href="${this.upstream}" target="_blank" rel="noopener noreferrer">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M14 4h6v6"/>
              <path d="M20 4l-9 9"/>
              <path d="M19 13v6H5V5h6"/>
            </svg>
            Open in new tab
          </a>
          <a class="btn-ghost" href="/">Pick another game</a>
        </div>
      </div>`;
    
    this.box.appendChild(overlay);
    
    overlay.querySelector('[data-act="retry"]')?.addEventListener('click', () => {
      overlay.remove();
      this.retryCount = 0;
      this.startLoad();
    });
    
    overlay.querySelector('[data-act="proxy"]')?.addEventListener('click', () => {
      overlay.remove();
      this.retryCount = 0;
      this.startLoad({ forceProxy: true });
    });
  }

  restart() {
    this.retryCount = 0;
    this.startLoad();
  }

  loadProxy() {
    this.retryCount = 0;
    this.startLoad({ forceProxy: true });
  }

  destroy() {
    this.clearTimers();
    this.frame?.removeEventListener('load', this._onLoad);
    this.frame?.removeEventListener('error', this._onError);
    
    // Clean up resource hints
    document.querySelectorAll('link[rel="preconnect"], link[rel="dns-prefetch"]').forEach(link => {
      link.remove();
    });
  }
}

// Export for use in game-page.js
export { OptimizedIframeLoader };
