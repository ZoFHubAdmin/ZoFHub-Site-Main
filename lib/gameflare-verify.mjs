// lib/gameflare-verify.mjs — real-browser verification of one GameFlare candidate.
// ---------------------------------------------------------------------------
// WHAT THIS DOES
// Drives THIS SITE'S OWN player route in Chromium, clicks GameFlare's in-frame
// Play control, sits through whatever advertisement appears, and then decides
// whether a real game came up behind it. It returns a verdict plus every
// observation the verdict rests on.
//
// WHY IT LOOKS LIKE THIS — THE FAILURE IT IS BUILT AGAINST
// The previous version asked one question of one screenshot: are these pixels
// varied? It reported 7 of 9 candidates as verified. Opening the screenshots
// showed LinkedIn and Popeyes video ads counting down 00:02 / 00:30. A video ad
// is the richest possible frame; "not blank" was measuring the ad.
//
// So content richness decides nothing here. The verdict comes from a state
// machine (lib/gameflare-state.mjs) fed by DOM, frame-tree and pixel signals,
// and the ad is a state the run is expected to pass THROUGH rather than a
// failure or a pass.
//
// THE OBSERVED SEQUENCE
//   landing page → click Play → ad container → ~30s video → ad hides → game
// A pass requires a game surface appearing STRICTLY AFTER the last ad sample.
// A canvas that was there all along proves no transition happened.
//
// READING THE CROSS-ORIGIN FRAME
// Playwright drives the browser over CDP, so it reads the child frame's DOM even
// though it is cross-origin and page JavaScript could never touch it. Every such
// call is a read. Nothing is injected, nothing is modified, and the shipped site
// does none of this — it exists only in this harness.
//
// WHAT A PASS IS WORTH
// One browser, one machine, one moment. It is evidence, not a guarantee, and
// `retryable` marks the failures that are conditions rather than properties.
// ---------------------------------------------------------------------------

import { isBlankImage, imageDelta } from './png-stats.mjs';
import { STATE, classifyObservation, summariseTimeline, AD_HOST_RE } from './gameflare-state.mjs';

/**
 * Verification outcomes (spec Phase 10). Failures are NOT collapsed into one
 * "failed" — the difference between "the ad never ended", "the game never came
 * up" and "it opened a tab" is the difference between retry, drop and never
 * touch this title again.
 */
export const STATUS = {
  VERIFIED: 'verified_working',
  AD_TIMEOUT: 'failed_ad_timeout',
  BLANK_AFTER_AD: 'failed_blank_after_ad',
  GAME_INIT: 'failed_game_initialization',
  GAMEPLAY: 'failed_gameplay',
  NEW_TAB: 'failed_new_tab',
  NEW_WINDOW: 'failed_new_window',
  PARENT_NAV: 'failed_parent_navigation',
  RUNTIME: 'failed_runtime',
  NETWORK: 'failed_network',
  LEGACY: 'failed_legacy_technology',
  NOT_TESTABLE: 'not_testable',
};

/** Lifecycle states a record moves through outside a run (spec Phase 10). */
export const LIFECYCLE = {
  CANDIDATE: 'candidate',
  MISSING_EMBED_URL: 'missing_embed_url',
  EMBED_VERIFIED: 'embed_verified',
  TESTING: 'testing',
};

/**
 * Failures worth another run. A timeout or a network fault is a condition of
 * the moment; a game that opens a tab will open one every time.
 */
export const TRANSIENT = new Set([STATUS.AD_TIMEOUT, STATUS.NETWORK, STATUS.NOT_TESTABLE]);

// Timings come from measurement, not preference. On sprunki-phase-5 the ad ran
// to t=40s, the loading splash held until t=60s, and the game was live after
// that; another candidate's ad ran 60s. So the ad allowance covers the longest
// ad seen, and the init allowance covers the splash with room to spare.
export const DEFAULTS = {
  loadTimeoutMs: 30000,
  adMaxWaitMs: 60000,
  gameInitTimeoutMs: 45000,
  interactionTimeoutMs: 15000,
  sampleIntervalMs: 1500,
  viewport: { width: 1280, height: 800 },
};

/**
 * Console noise that must never fail a game.
 *
 * Every real page emits some of this, and an ad stack emits a great deal. The
 * expensive mistake here is retiring a working game because its analytics
 * endpoint 404'd, so the filter is deliberately generous — genuine fatal faults
 * arrive as `pageerror`, which is handled separately.
 */
const NOISE = /favicon|analytics|gtag|googletag|doubleclick|adsbygoogle|adinplay|aiptag|imasdk|flashtalking|2mdn|hotjar|sentry|preload|deprecat|third-party cookie|Tracking Prevention|ERR_BLOCKED_BY_CLIENT|net::ERR_ABORTED/i;

/**
 * Read every signal the state machine needs, from inside the child frame.
 *
 * Serialised into the page, so it must be self-contained. Read-only throughout:
 * it queries and measures, and writes nothing.
 */
const OBSERVE = () => {
  const visible = (el) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 20 && r.height > 20 && s.display !== 'none'
      && s.visibility !== 'hidden' && Number(s.opacity) > 0.05;
  };

  // Several independent spellings, because keying on one id is exactly the
  // brittleness spec Phase 2 forbids.
  const AD_SEL = '[id*="adinplay" i],[class*="adinplay" i],[id*="aiptag" i],[class*="aiptag" i],'
    + '[id*="preroll" i],[class*="preroll" i],[id*="video-ad" i],[class*="video-ad" i],'
    + '[id*="ad-container" i],[class*="ad-container" i]';
  const adEls = [...document.querySelectorAll(AD_SEL)];

  const progressEl = document.querySelector('#adinplay-progress-text,[id*="progress-text" i],[class*="progress-text" i]');

  const videos = [...document.querySelectorAll('video')];
  const live = videos.find(v => (v.currentSrc || v.src) && !v.paused && v.currentTime > 0 && v.duration > 0);

  const canvasOf = (root) => [...root.querySelectorAll('canvas')];
  let canvases = canvasOf(document);

  // Ruffle renders into a shadow root, so its canvas is invisible to a plain
  // document query. Whether that canvas exists is the whole Phase 9 question:
  // a Ruffle element with nothing behind it is a Flash title that never came up.
  const ruffleEls = [...document.querySelectorAll('ruffle-player,ruffle-object,ruffle-embed')];
  let ruffleCanvas = false;
  for (const r of ruffleEls) {
    const inner = r.shadowRoot ? canvasOf(r.shadowRoot) : canvasOf(r);
    for (const c of inner) {
      canvases.push(c);
      if (c.width >= 200 && c.height >= 200 && visible(c)) ruffleCanvas = true;
    }
  }

  const playCtl = document.querySelector('button.play-button,.play-button,[id*="play-game" i]');

  // GameFlare's loading splash. Deliberately narrow: `#loading` and `.loading`
  // are the two elements actually observed, and a looser match like
  // [class*="splash"] would hit `#fullscreen-mode.has-splash-screen` — the game
  // container itself, which is visible the whole time and would jam this on.
  const loadingEl = [...document.querySelectorAll('#loading,.loading')].find(visible) || null;

  return {
    loadingIndicatorVisible: !!loadingEl,
    domReadable: true,
    adContainerPresent: adEls.length > 0,
    adContainerVisible: adEls.some(visible),
    adElementIds: adEls.slice(0, 12).map(e => `${e.id || ''} ${String(e.className || '')}`.trim().slice(0, 60)),
    adProgressText: progressEl ? (progressEl.textContent || '').trim() : null,
    adVideo: live ? {
      playing: true,
      currentTime: Number(live.currentTime.toFixed(2)),
      duration: Number((live.duration || 0).toFixed(2)),
      host: (live.currentSrc || live.src || '').split('/')[2] || null,
    } : null,
    visibleCanvases: canvases.filter(visible).map(c => ({ w: c.width, h: c.height })),
    ruffleElement: ruffleEls.length > 0,
    ruffleCanvas,
    playControlVisible: visible(playCtl),
    frameText: (document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 600),
    frameTitle: document.title || '',
  };
};

/**
 * Verify ONE candidate.
 *
 * @param {import('playwright').Browser} browser
 * @param {object} game  validated candidate ({slug, id, name, embedUrl, …})
 * @param {object} opts
 * @param {string} opts.baseUrl       origin of the running site under test
 * @param {string} opts.verifyToken   grants the player route candidate preview
 * @param {string} [opts.evidenceDir] where screenshots go
 * @param {object} [opts.timeouts]
 * @returns {Promise<object>} verification record — never throws
 */
export async function verifyCandidate(browser, game, opts) {
  const t = { ...DEFAULTS, ...(opts.timeouts || {}) };
  const startedAt = Date.now();

  const ev = {
    slug: game.slug,
    id: game.id ?? null,
    name: game.name ?? null,
    embedUrl: game.embedUrl,
    testedUrl: null,
    status: STATUS.NOT_TESTABLE,
    failureReason: null,
    failureDetail: null,

    // Phase 6 record.
    gameUiDetected: false,
    gameStarted: false,
    interactionAttempted: false,
    interactionSucceeded: false,
    interactionResponseObserved: null,

    // Phase 3 record.
    adDetected: false,
    adProvider: null,
    adDurationObservedMs: null,
    adDeclaredSec: null,
    gameAppearedAfterAd: false,

    // Phase 7 / 8 gates.
    iframeLoaded: false,
    newTabOpened: false,
    newWindowOpened: false,
    parentNavigationDetected: false,
    fatalRuntimeError: null,
    essentialNetworkFailure: false,
    legacyTechnologyDetected: false,
    legacyTechnologyInitialized: null,

    // Measurements.
    loadTimeMs: null,
    gamePlayableAtMs: null,
    durationMs: null,
    domReadable: null,
    idleMotion: null,
    postInputMotion: null,
    finalFrameStats: null,
    timeline: [],
    screenshots: [],
    consoleErrors: [],
    networkFailures: [],
    adHostsSeen: [],

    browser: 'Chromium',
    browserVersion: browser.version?.() ?? null,
    testedAt: new Date().toISOString(),
  };

  let ctx;
  try {
    ctx = await browser.newContext({
      viewport: t.viewport,
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
        + '(KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36',
      locale: 'en-US',
      ignoreHTTPSErrors: false,
    });

    const page = await ctx.newPage();
    const playerUrl = `${opts.baseUrl}/gameflare/play/${encodeURIComponent(game.slug)}`;
    ev.testedUrl = playerUrl;

    // ── Phase 7: escape routes ───────────────────────────────────────────
    // Bound to the CONTEXT so a popup opened from inside the cross-origin frame
    // is caught; a page-level listener alone misses those.
    ctx.on('page', () => { ev.newTabOpened = true; ev.newWindowOpened = true; });
    page.on('popup', () => { ev.newTabOpened = true; });

    // ── Phase 8: runtime and network ─────────────────────────────────────
    page.on('console', (m) => {
      if (m.type() !== 'error') return;
      const text = m.text().slice(0, 300);
      if (!NOISE.test(text)) ev.consoleErrors.push(text);
    });
    page.on('pageerror', (e) => {
      const text = String(e?.message || e).slice(0, 300);
      if (!NOISE.test(text)) { ev.consoleErrors.push(text); ev.fatalRuntimeError ??= text; }
    });
    page.on('request', (r) => {
      const u = r.url();
      if (AD_HOST_RE.test(u)) {
        const host = (() => { try { return new URL(u).host; } catch { return null; } })();
        if (host && !ev.adHostsSeen.includes(host)) ev.adHostsSeen.push(host);
      }
    });
    page.on('requestfailed', (r) => {
      const u = r.url();
      if (NOISE.test(u) || AD_HOST_RE.test(u)) return;
      ev.networkFailures.push(`${r.failure()?.errorText || 'failed'} ${u.slice(0, 160)}`);
    });
    page.on('response', (r) => {
      const u = r.url();
      if (r.status() < 400 || AD_HOST_RE.test(u)) return;
      // Only the embed document itself is essential. A 404 on some optional
      // asset inside a game is the game's business, not a verdict.
      if (u.startsWith(game.embedUrl.split('?')[0])) {
        ev.essentialNetworkFailure = true;
        ev.networkFailures.push(`HTTP ${r.status()} ${u.slice(0, 160)}`);
      }
    });

    // ── Load the real player route ───────────────────────────────────────
    const loadStart = Date.now();
    await page.goto(`${playerUrl}?verify=${encodeURIComponent(opts.verifyToken)}`,
      { waitUntil: 'domcontentloaded', timeout: t.loadTimeoutMs });

    let frameEl;
    try {
      frameEl = await page.waitForSelector('iframe.gf-frame', { timeout: t.loadTimeoutMs, state: 'attached' });
    } catch {
      ev.status = STATUS.NOT_TESTABLE;
      ev.failureReason = 'player_iframe_never_created';
      ev.failureDetail = 'The site player did not create its iframe — the candidate did not resolve.';
      return finish(ev, startedAt, ctx);
    }

    const childFrame = () => page.frames().find(f => f.url().startsWith('https://www.gameflare.com/embed/'));
    for (let i = 0; i < 20 && !childFrame(); i++) await page.waitForTimeout(500);
    ev.iframeLoaded = true;
    ev.loadTimeMs = Date.now() - loadStart;

    const onRoute = () => page.url().startsWith(`${opts.baseUrl}/gameflare/play/`);
    if (!onRoute()) {
      ev.parentNavigationDetected = true;
      ev.status = STATUS.PARENT_NAV;
      ev.failureReason = 'parent_navigated_on_load';
      ev.failureDetail = `Parent left the player route: ${page.url().slice(0, 200)}`;
      await shot(page, opts, game, '06_failure', ev);
      return finish(ev, startedAt, ctx);
    }

    // ── One observation, from all three layers ───────────────────────────
    let lastShot = null;
    const observe = async () => {
      const f = childFrame();
      let dom = { domReadable: false };
      if (f) {
        try { dom = await f.evaluate(OBSERVE); }
        catch { dom = { domReadable: false }; }
      }
      ev.domReadable ??= dom.domReadable;

      let pixels = null, motion = null, buf = null;
      try {
        buf = await frameEl.screenshot({ timeout: 12000 });
        pixels = isBlankImage(buf).stats;
        if (lastShot) {
          const d = imageDelta(lastShot, buf);
          motion = d.ok ? d.changed : null;
        }
        lastShot = buf;
      } catch { /* a capture failure is missing evidence, never a verdict */ }

      const adFrameCount = page.frames().filter(fr => AD_HOST_RE.test(fr.url())).length;
      const sig = { ...dom, adFrameCount, pixels, motion };
      const cls = classifyObservation(sig);
      const row = {
        atMs: Date.now() - startedAt,
        state: cls.state,
        adProvider: cls.adProvider,
        countdown: cls.countdown,
        reasons: cls.reasons,
        canvases: dom.visibleCanvases ?? [],
        motion,
        dominantShare: pixels?.ok ? Number(pixels.dominantShare.toFixed(4)) : null,
        // Kept so a surprising verdict can be diagnosed from the record alone,
        // without re-running the browser and hoping to reproduce it.
        frameTitle: dom.frameTitle ?? null,
        frameText: typeof dom.frameText === 'string' ? dom.frameText.slice(0, 120) : null,
      };
      ev.timeline.push(row);
      return { row, sig, dom, buf, pixels };
    };

    // ── Phase 5 · 01_initial ─────────────────────────────────────────────
    const first = await observe();
    await shot(page, opts, game, '01_initial', ev);

    // ── Start the game the way a visitor does ────────────────────────────
    // GameFlare's own control inside the frame, clicked with real mouse events.
    // Falls back to the frame centre, which is where every click-to-start
    // surface lives, and records which route was taken.
    let clicked = 'none';
    try {
      const f = childFrame();
      if (f) {
        // WAIT for the control rather than testing for it once. The frame needs
        // a couple of seconds to render its landing page, and an immediate
        // probe finds nothing: an earlier revision clicked at 1.2s, missed the
        // button that appeared at 3.3s, and then sat watching an untouched
        // landing page for 77 seconds before reporting the game never started.
        const btn = await f.waitForSelector('button.play-button, .play-button',
          { timeout: 20000, state: 'visible' }).catch(() => null);
        if (btn) {
          await btn.click({ timeout: 8000 });
          clicked = 'in_frame_play_button';
        }
      }
      if (clicked === 'none') {
        // Fallback for a layout with no recognisable control: click the middle
        // of the frame, which is where a click-to-start surface lives.
        const box = await frameEl.boundingBox();
        if (box) {
          await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { delay: 40 });
          clicked = 'frame_centre_fallback';
        }
      }
    } catch (e) {
      ev.failureDetail = `play click failed: ${String(e.message).slice(0, 140)}`;
    }
    ev.playControlUsed = clicked;
    ev.gameStarted = clicked !== 'none';
    void first;

    // ── Phases 3 + 4: sit through the ad, then look for the game ─────────
    // One loop, because the ad and the game are points on one timeline. The
    // budget is the ad allowance plus the init allowance: a title must not fail
    // for being behind a long ad, and must not pass for merely surviving one.
    const budgetMs = t.adMaxWaitMs + t.gameInitTimeoutMs;
    const deadline = Date.now() + budgetMs;
    let sawAd = false, adEndedAt = null, shotAd = false, shotAfterAd = false;
    let gameRow = null;

    while (Date.now() < deadline) {
      await page.waitForTimeout(t.sampleIntervalMs);
      const { row, dom } = await observe();

      if (row.state === STATE.AD_PLAYING) {
        if (!sawAd) { sawAd = true; ev.adDetected = true; }
        if (!shotAd) { await shot(page, opts, game, '02_ad', ev); shotAd = true; }
        adEndedAt = null;
        continue;
      }

      if (sawAd && adEndedAt === null) {
        adEndedAt = Date.now();
        if (!shotAfterAd) { await shot(page, opts, game, '03_after_ad', ev); shotAfterAd = true; }
      }

      // GAME_LOADING is deliberately NOT a stopping point. The splash sits up
      // for ~20s after the ad ends, and breaking here is how a progress bar with
      // a banner advert on it got recorded as a verified game.
      if (row.state === STATE.GAME_PLAYABLE || row.state === STATE.GAME_INITIALIZED) {
        // Phase 4: the transition must be real. A game surface that predates the
        // ad is not evidence that anything happened after it.
        if (!sawAd || adEndedAt !== null) { gameRow = row; break; }
      }

      // A tab or a navigation mid-ad ends the run immediately — no point
      // spending another 40 seconds on a candidate that already disqualified.
      if (ev.newTabOpened || !onRoute()) break;
      void dom;
    }

    const tl = summariseTimeline(ev.timeline);
    ev.adDetected = tl.adDetected;
    ev.adProvider = tl.adProvider;
    ev.adDurationObservedMs = tl.adObservedMs;
    ev.adDeclaredSec = tl.adDeclaredSec;
    ev.gameAppearedAfterAd = tl.gameAppearedAfterAd;
    ev.gameUiDetected = !!gameRow;
    ev.gamePlayableAtMs = tl.playableAtMs;

    if (!onRoute()) ev.parentNavigationDetected = true;

    // ── Phase 9: legacy technology ───────────────────────────────────────
    const lastRow = ev.timeline[ev.timeline.length - 1];
    const ruffleSeen = ev.timeline.some(r => r.reasons.includes('ruffle_element_without_canvas'))
      || ev.timeline.some(r => r.reasons.includes('ruffle_canvas_present'));
    if (ruffleSeen) {
      ev.legacyTechnologyDetected = true;
      ev.legacyTechnologyInitialized = ev.timeline.some(r => r.reasons.includes('ruffle_canvas_present'));
    }

    // ── Phase 6: real interaction, against a measured idle baseline ──────
    // A game that animates on its own is always "changing", so a bare
    // did-anything-change test would report every animated title as responsive.
    // The idle sample is what makes the post-input number mean something.
    if (gameRow) {
      try {
        const before1 = await frameEl.screenshot({ timeout: 12000 });
        await page.waitForTimeout(1200);
        const before2 = await frameEl.screenshot({ timeout: 12000 });
        const idle = imageDelta(before1, before2);
        ev.idleMotion = idle.ok ? Number(idle.changed.toFixed(4)) : null;

        const box = await frameEl.boundingBox();
        if (box) {
          ev.interactionAttempted = true;
          // Mouse first — it is the one input every game accepts — then a
          // keyboard action for titles that are keyboard-driven.
          await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
          await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { delay: 60 });
          await page.waitForTimeout(400);
          await page.keyboard.press('Space').catch(() => {});
          await page.waitForTimeout(400);
          await page.keyboard.press('ArrowRight').catch(() => {});
          await page.waitForTimeout(1200);

          const after = await frameEl.screenshot({ timeout: 12000 });
          const post = imageDelta(before2, after);
          ev.postInputMotion = post.ok ? Number(post.changed.toFixed(4)) : null;
          ev.finalFrameStats = isBlankImage(after).stats;

          // A resized canvas reads as size_changed rather than a number. That IS
          // the frame reacting, so it counts as an observed response.
          ev.interactionResponseObserved = post.ok
            ? post.changed > Math.max((ev.idleMotion ?? 0) * 1.5, 0.01)
            : post.reason === 'size_changed';
        }

        const final = await observe();
        // What `interactionSucceeded` claims, exactly: input was delivered and
        // the game surface was still live and rendering afterwards. It does NOT
        // claim the game reacted to that specific input — a generic click and
        // Space cannot prove that for a title needing some other key. The
        // stronger, narrower claim lives in `interactionResponseObserved`.
        ev.interactionSucceeded = ev.interactionAttempted
          && (final.row.state === STATE.GAME_PLAYABLE || final.row.state === STATE.GAME_INITIALIZED)
          && !ev.newTabOpened && !ev.parentNavigationDetected && !ev.fatalRuntimeError;

        await shot(page, opts, game, '05_gameplay', ev);
      } catch (e) {
        ev.failureDetail = `interaction error: ${String(e.message).slice(0, 160)}`;
      }
      await shot(page, opts, game, '04_game_initialized', ev);
    }

    // ── Phase 11: the hard gate ──────────────────────────────────────────
    // Ordered so the most specific and most disqualifying causes are named
    // first. Everything below is a REQUIREMENT — the pass is the last branch,
    // reachable only when nothing else claimed the record.
    if (ev.newTabOpened) {
      ev.status = STATUS.NEW_TAB; ev.failureReason = 'unexpected_new_tab';
    } else if (ev.newWindowOpened) {
      ev.status = STATUS.NEW_WINDOW; ev.failureReason = 'unexpected_new_window';
    } else if (ev.parentNavigationDetected) {
      ev.status = STATUS.PARENT_NAV; ev.failureReason = 'unexpected_parent_navigation';
    } else if (ev.fatalRuntimeError) {
      ev.status = STATUS.RUNTIME; ev.failureReason = 'fatal_runtime_error';
    } else if (ev.essentialNetworkFailure) {
      ev.status = STATUS.NETWORK; ev.failureReason = 'essential_network_failure';
    } else if (ev.legacyTechnologyDetected && !ev.legacyTechnologyInitialized) {
      ev.status = STATUS.LEGACY; ev.failureReason = 'legacy_technology_failure';
      ev.failureDetail = 'A Ruffle/Flash player was inserted but never produced a rendered canvas.';
    } else if (!ev.gameUiDetected) {
      // Three genuinely different ways to arrive here.
      if (ev.adDetected && tl.finalState === STATE.AD_PLAYING) {
        ev.status = STATUS.AD_TIMEOUT; ev.failureReason = 'ad_did_not_finish_within_budget';
        ev.failureDetail = `Still in ad_playing after ${budgetMs}ms.`;
      } else if (ev.adDetected) {
        ev.status = STATUS.BLANK_AFTER_AD; ev.failureReason = 'no_game_surface_after_ad';
        ev.failureDetail = `Ad completed (${tl.adObservedMs ?? '?'}ms observed) but no game surface appeared. `
          + `Final state ${tl.finalState}.`;
      } else {
        ev.status = STATUS.GAME_INIT; ev.failureReason = 'game_never_initialized';
        ev.failureDetail = `No advertisement and no game surface. Final state ${tl.finalState}.`;
      }
      await shot(page, opts, game, '06_failure', ev);
    } else if (!ev.interactionSucceeded) {
      ev.status = STATUS.GAMEPLAY; ev.failureReason = 'interaction_not_accepted';
      await shot(page, opts, game, '06_failure', ev);
    } else if (ev.finalFrameStats?.ok && ev.finalFrameStats.dominantShare >= 0.97) {
      // Independent pixel cross-check on the DOM's conclusion. If the DOM says
      // there is a game canvas but the rectangle is a flat colour, something is
      // wrong with the reasoning and the honest answer is "not verified".
      //
      // This is the sanity check the earlier revision lacked: it passed a frame
      // that was solid black with Chrome's broken-content icon. A signal saying
      // "game" and a screenshot showing nothing must resolve to a failure.
      ev.status = STATUS.BLANK_AFTER_AD;
      ev.failureReason = 'game_surface_reported_but_frame_is_blank';
      ev.failureDetail = `${(ev.finalFrameStats.dominantShare * 100).toFixed(1)}% of pixels share one `
        + `luminance across ${ev.finalFrameStats.meaningfulTones} tone(s). DOM and pixels disagree.`;
      await shot(page, opts, game, '06_failure', ev);
    } else if (!ev.screenshots.length) {
      // Spec Phase 11 requires screenshot evidence for a pass. No evidence, no
      // pass — the run is inconclusive rather than good.
      ev.status = STATUS.NOT_TESTABLE; ev.failureReason = 'no_screenshot_evidence_captured';
    } else {
      ev.status = STATUS.VERIFIED; ev.failureReason = null;
    }

    void lastRow;
    return finish(ev, startedAt, ctx);

  } catch (e) {
    ev.status = STATUS.NOT_TESTABLE;
    ev.failureReason = 'harness_error';
    ev.failureDetail = String(e?.message || e).slice(0, 300);
    return finish(ev, startedAt, ctx);
  }
}

async function finish(ev, startedAt, ctx) {
  ev.durationMs = Date.now() - startedAt;
  ev.retryable = TRANSIENT.has(ev.status);
  try { await ctx?.close(); } catch { /* closing a dead context is not a result */ }
  return ev;
}

/**
 * Capture one screenshot of the whole viewport, named for its stage.
 *
 * Viewport rather than frame-only on purpose: the parent page is part of the
 * evidence. A screenshot that showed only the frame could not prove the site
 * around it stayed put.
 *
 * Failure to capture is never a verdict — but it does block a pass, which the
 * gate above enforces.
 */
async function shot(page, opts, game, label, ev) {
  if (!opts.evidenceDir) return;
  try {
    const { mkdir } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const dir = join(opts.evidenceDir, game.slug);
    await mkdir(dir, { recursive: true });
    const file = join(dir, `${label}.png`);
    await page.screenshot({ path: file, fullPage: false });
    if (!ev.screenshots.includes(file)) ev.screenshots.push(file);
  } catch { /* evidence is best-effort */ }
}
