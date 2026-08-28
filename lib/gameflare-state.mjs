// lib/gameflare-state.mjs — decide what a GameFlare embed is showing right now.
// ---------------------------------------------------------------------------
// WHY THIS EXISTS, AND WHAT IT REPLACES
// The previous detector asked one question — "does this frame have varied
// pixels?" — and treated yes as "the game is running". It passed 7 of 9
// candidates whose frames were, on inspection, LinkedIn and Popeyes video
// advertisements counting down 00:02 / 00:30. Rich pixels are not a game. That
// heuristic is banned outright (spec Phase 5) and does not appear here.
//
// WHAT REPLACES IT
// A state, derived from several independent observations, where the states that
// matter require agreement between signals that would not fail together. The
// signals come from three different layers of the browser:
//
//   DOM       the ad container, its countdown, the <video> and its currentTime,
//             the game <canvas> and its size, the Ruffle element
//   FRAMES    nested ad frames (the IMA SDK loads one) and their URLs
//   PIXELS    luminance distribution of the frame, and change between samples
//
// The DOM layer is the decisive one and it is available: Playwright speaks CDP,
// so it reads a cross-origin child frame that page JavaScript could never touch.
// That is a READ. Nothing here modifies the frame, and the shipped site does not
// do any of this — it belongs to the test harness alone.
//
// The pixel layer is not redundant. If a future GameFlare change makes the DOM
// unreadable, `domReadable: false` degrades this to pixel-only evidence, which
// is explicitly too weak to reach GAME_PLAYABLE. Losing the ability to observe
// must produce "I cannot tell", never "it is fine".
//
// OBSERVED SEQUENCE (measured 2026-08-15, monopoly-online and sprunki-phase-6)
//   t=0     landing page in-frame, a PLAY GAME control, no canvas, no ad
//   t+4s    #adinplay-container is inserted
//   t+7s    "Loading advertisement", #adinplay-progress-text present but empty
//   t+10s   countdown runs 00:00 / 00:30, <video> from a CDN plays
//   t+40s   the container is hidden — the ad is over
//   then    sprunki-phase-6 shows a live 933x700 canvas   (GAME_PLAYABLE)
//           monopoly-online shows a Ruffle element and no canvas, permanently
//           (GAME_FAILED — a Flash title Ruffle never brings up)
// ---------------------------------------------------------------------------

/** Every state an observation can land in (spec Phase 2 / Phase 10). */
export const STATE = {
  IFRAME_LOADING: 'iframe_loading',
  GAMEFLARE_PAGE: 'gameflare_page',
  AD_PLAYING: 'ad_playing',
  AD_FINISHED: 'ad_finished',
  GAME_LOADING: 'game_loading',
  GAME_INITIALIZED: 'game_initialized',
  GAME_PLAYABLE: 'game_playable',
  GAME_FAILED: 'game_failed',
  UNKNOWN: 'unknown',
};

/**
 * A countdown of the form `M:SS / M:SS` or `MM:SS / MM:SS`.
 * Anchored, so a stray timestamp elsewhere in the page text cannot match.
 */
export const AD_COUNTDOWN_RE = /^\s*(\d{1,2}):(\d{2})\s*\/\s*(\d{1,2}):(\d{2})\s*$/;

/** Hosts that serve the video-ad machinery, used as a corroborating signal. */
export const AD_HOST_RE = /adinplay|aiptag|imasdk\.googleapis|innovid|flashtalking|doubleclick.*videoplayback|2mdn/i;

/** Text the embed shows while an ad is being fetched but is not yet playing. */
const AD_LOADING_RE = /loading advertisement|advertisement will (begin|end)|ad will (begin|end)/i;

/** A canvas this small is a sprite scratchpad or a tracking pixel, not a game. */
const MIN_GAME_CANVAS = 200;

/** Parse `01:23 / 00:30` into seconds. Returns null when it is not a countdown. */
export function parseCountdown(text) {
  if (typeof text !== 'string') return null;
  const m = AD_COUNTDOWN_RE.exec(text);
  if (!m) return null;
  const elapsed = Number(m[1]) * 60 + Number(m[2]);
  const total = Number(m[3]) * 60 + Number(m[4]);
  if (!Number.isFinite(elapsed) || !Number.isFinite(total) || total <= 0) return null;
  return { elapsedSec: elapsed, totalSec: total };
}

/**
 * Name the ad provider ONLY from evidence that identifies it.
 *
 * Spec Phase 3: report a provider only when actually verified. An element
 * literally id'd `adinplay-container` is that evidence. A generic <video> in an
 * ad slot is not — that returns null, and the record then says an ad was
 * detected without claiming to know whose.
 */
export function identifyAdProvider(sig) {
  const ids = Array.isArray(sig?.adElementIds) ? sig.adElementIds.join(' ') : '';
  if (/adinplay/i.test(ids)) return 'AdInPlay';
  if (/aiptag/i.test(ids)) return 'AdInPlay';
  return null;
}

/**
 * Classify ONE observation.
 *
 * @param {object} sig observed signals for a single sample
 * @param {boolean} sig.domReadable        was the child frame's DOM readable?
 * @param {boolean} sig.adContainerPresent an ad container exists in the DOM
 * @param {boolean} sig.adContainerVisible ...and it is actually displayed
 * @param {string[]} sig.adElementIds      ids/classes of ad-ish elements seen
 * @param {string|null} sig.adProgressText contents of the countdown node
 * @param {object|null} sig.adVideo        {playing, currentTime, duration, host}
 * @param {number} sig.adFrameCount        nested frames on known ad hosts
 * @param {Array<{w:number,h:number}>} sig.visibleCanvases
 * @param {boolean} sig.ruffleElement      a <ruffle-*> element is present
 * @param {boolean} sig.playControlVisible the in-frame PLAY GAME control is up
 * @param {string} sig.frameText           visible text of the frame
 * @param {object|null} sig.pixels         imageStats() of the frame region
 * @param {number|null} sig.motion         imageDelta() vs the previous sample
 * @returns {{state: string, adDetected: boolean, adProvider: string|null,
 *            countdown: object|null, reasons: string[], evidenceCount: number}}
 */
export function classifyObservation(sig) {
  const s = sig && typeof sig === 'object' ? sig : {};
  const reasons = [];

  const countdown = parseCountdown(s.adProgressText);
  const video = s.adVideo && typeof s.adVideo === 'object' ? s.adVideo : null;
  const videoPlaying = !!(video && video.playing && Number(video.duration) > 0);

  // ── Ad evidence, counted independently ────────────────────────────────
  const adEvidence = [];
  if (s.adContainerVisible) adEvidence.push('ad_container_visible');
  if (countdown) adEvidence.push('ad_countdown_text');
  if (videoPlaying) adEvidence.push('ad_video_playing');
  if (Number(s.adFrameCount) > 0) adEvidence.push('ad_frame_present');
  if (AD_LOADING_RE.test(String(s.frameText || ''))) adEvidence.push('ad_loading_text');

  // ── Game evidence ─────────────────────────────────────────────────────
  // STRUCTURAL signals only. A game surface is a rendered canvas — nothing
  // else establishes one.
  //
  // Motion deliberately does NOT appear here. An earlier revision counted
  // "the frame is animating" as game evidence in its own right and passed
  // sprunki-phase-4 on a frame that was solid black with Chrome's broken-content
  // icon, flickering between load states at 0.78 measured motion. That is the
  // banned "rich pixels = game" heuristic wearing a different hat: a frame can
  // change for many reasons and almost none of them are a game.
  //
  // Motion is kept as CORROBORATION below — it can raise a real canvas from
  // "initialized" to "playable", and can never conjure one.
  const canvases = Array.isArray(s.visibleCanvases) ? s.visibleCanvases : [];
  const gameCanvas = canvases.find(c => Number(c.w) >= MIN_GAME_CANVAS && Number(c.h) >= MIN_GAME_CANVAS) || null;
  const gameEvidence = [];
  if (gameCanvas) gameEvidence.push('game_canvas_present');
  if (s.ruffleCanvas) gameEvidence.push('ruffle_canvas_present');
  const animating = Number(s.motion) > 0.005;

  // GameFlare's own loading splash is ITSELF drawn on a full-size canvas, with
  // a progress bar and a display banner on it. So "a canvas is present and it is
  // animating" describes the splash exactly as well as it describes a game —
  // that combination passed sprunki-phase-5 on a screenshot showing a progress
  // bar and a War Thunder advert.
  //
  // The splash carries a visible #loading / .loading element and the game does
  // not. Measured on sprunki-phase-5: the element is up from the ad's end at
  // t=40s until t=60s, and the canvas resizes 933x700 -> 886x665 as it goes.
  // While it is up, nothing here may report a playable game.
  const loading = !!s.loadingIndicatorVisible;

  const adProvider = identifyAdProvider(s);
  const adDetected = adEvidence.length > 0;

  const out = (state, evidenceCount) => ({
    state, adDetected, adProvider, countdown,
    reasons, evidenceCount,
    gameCanvas,
  });

  // Nothing readable and nothing rendered: the frame has not arrived.
  if (!s.domReadable && !s.pixels?.ok) {
    reasons.push('frame_not_observable');
    return out(STATE.IFRAME_LOADING, 0);
  }

  // ── Ad states outrank game states ─────────────────────────────────────
  // An ad and a game surface can be in the DOM at the same time (the canvas is
  // created behind the ad overlay). Reporting "game" while an ad is on screen is
  // precisely the false positive that invalidated the earlier runs, so a live ad
  // wins whenever both are present.
  if (adEvidence.length >= 2 || videoPlaying || countdown) {
    reasons.push(...adEvidence);
    return out(STATE.AD_PLAYING, adEvidence.length);
  }

  // The ad ran and is gone: the container is still in the DOM but hidden.
  const adDismissed = s.adContainerPresent && !s.adContainerVisible;

  if (gameEvidence.length) {
    reasons.push(...gameEvidence);
    if (loading) {
      reasons.push('loading_indicator_visible');
      return out(STATE.GAME_LOADING, gameEvidence.length);
    }
    if (animating) reasons.push('frame_is_animating');
    // "Playable" needs a canvas the DOM confirmed, the splash gone, AND signs of
    // life. Pixels alone can never get here: without domReadable there is no
    // canvas to find in the first place.
    const playable = s.domReadable && animating;
    return out(playable ? STATE.GAME_PLAYABLE : STATE.GAME_INITIALIZED,
      gameEvidence.length + (animating ? 1 : 0));
  }

  // A Ruffle element with no canvas behind it is a Flash title that has been
  // handed to the emulator and has not come up. Distinct from "still loading",
  // and the caller decides which by how long it has been in this state.
  if (s.ruffleElement && !s.ruffleCanvas) {
    reasons.push('ruffle_element_without_canvas');
    return out(STATE.GAME_LOADING, 1);
  }

  if (adDismissed) {
    reasons.push('ad_container_hidden_no_game_surface');
    return out(STATE.AD_FINISHED, 1);
  }

  if (s.playControlVisible || /play game/i.test(String(s.frameText || ''))) {
    reasons.push('play_control_visible');
    return out(STATE.GAMEFLARE_PAGE, 1);
  }

  if (s.domReadable) {
    reasons.push('dom_readable_no_ad_no_game_surface');
    return out(STATE.GAME_LOADING, 0);
  }

  reasons.push('insufficient_signal');
  return out(STATE.UNKNOWN, 0);
}

/**
 * Reduce a whole timeline of observations to what actually happened.
 *
 * Kept separate from per-sample classification because the interesting facts are
 * transitions, not states: an ad that started and ended, how long it really ran,
 * and whether a game surface appeared AFTER it rather than merely at some point.
 *
 * `gameAppearedAfterAd` is deliberately strict — it requires a game state at an
 * index later than the last ad sample. A canvas that existed before the ad and
 * was still there afterwards does not demonstrate a transition.
 */
export function summariseTimeline(samples) {
  const rows = Array.isArray(samples) ? samples : [];
  const isAd = (r) => r.state === STATE.AD_PLAYING;
  const isGame = (r) => r.state === STATE.GAME_PLAYABLE || r.state === STATE.GAME_INITIALIZED;

  const firstAd = rows.findIndex(isAd);
  let lastAd = -1;
  for (let i = rows.length - 1; i >= 0; i--) if (isAd(rows[i])) { lastAd = i; break; }

  const adDetected = firstAd >= 0;
  let adDurationMs = null;
  if (adDetected && lastAd > firstAd) adDurationMs = rows[lastAd].atMs - rows[firstAd].atMs;

  // The countdown total is the ad's own declaration of its length; the observed
  // window is what was actually sat through. Both are kept — they answer
  // different questions and disagreeing is informative, not an error.
  const declared = rows.map(r => r.countdown?.totalSec).filter(Number.isFinite);

  const gameIdx = rows.findIndex((r, i) => isGame(r) && (!adDetected || i > lastAd));
  const playableIdx = rows.findIndex((r, i) => r.state === STATE.GAME_PLAYABLE && (!adDetected || i > lastAd));

  return {
    samples: rows.length,
    adDetected,
    adProvider: rows.find(r => r.adProvider)?.adProvider ?? null,
    adDeclaredSec: declared.length ? Math.max(...declared) : null,
    adObservedMs: adDurationMs,
    adFinished: adDetected && lastAd >= 0 && lastAd < rows.length - 1,
    gameAppearedAfterAd: gameIdx >= 0,
    gameFirstSeenAtMs: gameIdx >= 0 ? rows[gameIdx].atMs : null,
    playableAtMs: playableIdx >= 0 ? rows[playableIdx].atMs : null,
    finalState: rows.length ? rows[rows.length - 1].state : STATE.UNKNOWN,
    statesSeen: [...new Set(rows.map(r => r.state))],
  };
}
