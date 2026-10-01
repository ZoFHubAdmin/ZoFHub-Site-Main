// ZoFHub · preroll.js — Clickadu's VAST video pre-roll, in front of the game frame.
// ---------------------------------------------------------------------------
// game-page.js calls runPreroll() BEFORE it gives the game iframe its src, and
// binds the frame when the returned promise settles. So the game loads after
// the pre-roll completes — and, because the promise ALWAYS settles, after it is
// skipped, fails, has no fill, is blocked, or hangs as well.
//
// A small, dependency-free VAST player (IAB VAST 2.0–4.x, Linear creatives):
//   • fetches the tag, following up to MAX_WRAPPERS <Wrapper> hops and
//     collecting every hop's impression, error and tracking URLs;
//   • picks a progressive MP4/WebM the browser can play, sized to the frame;
//   • plays it muted and inline (the only way autoplay is permitted on phones),
//     with an unmute control;
//   • allows Skip at the creative's skipoffset — Clickadu requires
//     00:00:05 — or SKIP_AFTER_S when the creative states none;
//   • fires impression, start, quartile, complete, skip, mute/unmute, click
//     and error pixels.
//
// THE RULES IT CANNOT BREAK
//   1. The player always reaches the game. Every exit settles the promise,
//      and FAILSAFE_MS settles it regardless of what the creative does.
//   2. Nothing is shown until there is a playable ad. No fill, a refused tag or
//      an unplayable file leave the ordinary game loader on screen for the
//      fraction of a second the attempt took — never an empty ad box.
//   3. Never stacked behind the interstitial. If Ad-Maven's between-games unit
//      fired in the last NO_STACK_MS, this visit skips the pre-roll: two
//      full-screen ads back to back is how a games site loses its players.
//   4. Never Google, and https only — the same refusals every other injector
//      makes (lib/ad-providers.mjs refuses them first).
// ---------------------------------------------------------------------------

import { adFrequencyController } from './ad-frequency.js';
import { noteBlockedResource, reachable } from './support-gate.js';

const GOOGLE_AD_RE = /googlesyndication|googleadservices|adsbygoogle|doubleclick/i;

export const SKIP_AFTER_S = 5;               // Clickadu: skipOffset 00:00:05
const MAX_WRAPPERS = 4;
const VAST_TIMEOUT_MS = 4000;                // per hop
const START_TIMEOUT_MS = 6000;               // the video must start within this
const FAILSAFE_MS = 45000;                   // absolute ceiling, whatever happens
export const NO_STACK_MS = 2 * 60 * 1000;

// ── Pure helpers (exported for tests) ──────────────────────────────────────

/** "00:00:05.000" → 5, "10%" of 30 → 3, anything unreadable → null. */
export function parseTimeOffset(value, duration = 0) {
  const s = String(value ?? '').trim();
  if (!s) return null;
  const pct = /^(\d+(?:\.\d+)?)%$/.exec(s);
  if (pct) return duration > 0 ? (Number(pct[1]) / 100) * duration : null;
  const hms = /^(\d{1,2}):(\d{2}):(\d{2}(?:\.\d{1,3})?)$/.exec(s);
  if (!hms) return null;
  return Number(hms[1]) * 3600 + Number(hms[2]) * 60 + Number(hms[3]);
}

/**
 * Choose the media file to play: progressive delivery, a type the browser can
 * play, and the smallest width that still covers the frame (else the largest).
 * @param {{url:string,type:string,width:number,delivery:string}[]} files
 * @param {number} targetWidth
 * @param {(type:string) => boolean} canPlay
 */
export function pickMediaFile(files, targetWidth, canPlay) {
  const ok = (files || []).filter((f) => f && /^https:\/\//i.test(f.url)
    && String(f.delivery || 'progressive').toLowerCase() !== 'streaming'
    && /^video\/(mp4|webm)$/i.test(f.type || '')
    && canPlay(f.type));
  if (!ok.length) return null;
  const covering = ok.filter((f) => (f.width || 0) >= targetWidth).sort((a, b) => (a.width || 0) - (b.width || 0));
  if (covering.length) return covering[0];
  return ok.sort((a, b) => (b.width || 0) - (a.width || 0))[0];
}

/** Replace the IAB macros a tag or pixel URL may carry. */
export function expandMacros(url, { errorCode } = {}) {
  const cb = String(Math.floor(Math.random() * 1e8)).padStart(8, '0');
  return String(url)
    .replace(/\[CACHEBUSTING\]/g, cb)
    .replace(/\[TIMESTAMP\]/g, encodeURIComponent(new Date().toISOString()))
    .replace(/\[ERRORCODE\]/g, errorCode != null ? String(errorCode) : '');
}

// ── VAST retrieval ─────────────────────────────────────────────────────────

class VastError extends Error {
  constructor(code, message, blocked = false) { super(message); this.code = code; this.blocked = blocked; }
}

const text = (el) => (el ? String(el.textContent || '').trim() : '');
const all = (root, tag) => Array.from(root.getElementsByTagName(tag));

async function fetchVast(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), VAST_TIMEOUT_MS);
  try {
    const r = await fetch(url, { credentials: 'omit', mode: 'cors', signal: ctrl.signal, referrerPolicy: 'strict-origin-when-cross-origin' });
    if (!r.ok) throw new VastError(301, `tag answered ${r.status}`);
    const doc = new DOMParser().parseFromString(await r.text(), 'text/xml');
    if (doc.getElementsByTagName('parsererror').length) throw new VastError(100, 'tag is not XML');
    return doc;
  } catch (e) {
    if (e instanceof VastError) throw e;
    if (e?.name === 'AbortError') throw new VastError(301, 'tag timed out');
    // A TypeError here is either a CORS refusal or a request the browser would
    // not send. Only the second is a blocker; a HEAD without CORS tells them apart.
    const blocked = (await reachable(url)) === false;
    throw new VastError(301, blocked ? 'tag was blocked' : 'tag unreachable', blocked);
  } finally {
    clearTimeout(timer);
  }
}

/** Resolve the tag to one playable linear ad, following wrappers. */
async function resolveAd(tagUrl) {
  const acc = { impressions: [], errors: [], tracking: {}, clickTracking: [] };
  const collect = (ad) => {
    for (const el of all(ad, 'Impression')) if (text(el)) acc.impressions.push(text(el));
    for (const el of all(ad, 'Error')) if (text(el)) acc.errors.push(text(el));
    for (const el of all(ad, 'Tracking')) {
      const ev = String(el.getAttribute('event') || '');
      if (ev && text(el)) (acc.tracking[ev] ||= []).push(text(el));
    }
    for (const el of all(ad, 'ClickTracking')) if (text(el)) acc.clickTracking.push(text(el));
  };

  let url = tagUrl;
  for (let hop = 0; hop <= MAX_WRAPPERS; hop++) {
    const doc = await fetchVast(expandMacros(url));
    const root = doc.documentElement;
    const ad = root && all(root, 'Ad')[0];
    if (!ad) {
      // No <Ad>: no fill. The tag's own <Error> URLs want to hear about it.
      for (const el of all(root || doc, 'Error')) if (text(el)) acc.errors.push(text(el));
      throw Object.assign(new VastError(303, 'no ad'), { acc });
    }
    collect(ad);
    const wrapper = all(ad, 'Wrapper')[0];
    if (wrapper) {
      const next = text(all(wrapper, 'VASTAdTagURI')[0]);
      if (!next || !/^https:\/\//i.test(next) || GOOGLE_AD_RE.test(next)) throw Object.assign(new VastError(301, 'bad wrapper'), { acc });
      url = next;
      continue;
    }
    const inline = all(ad, 'InLine')[0];
    const linear = inline && all(inline, 'Linear')[0];
    if (!linear) throw Object.assign(new VastError(201, 'no linear creative'), { acc });
    const duration = parseTimeOffset(text(all(linear, 'Duration')[0])) || 0;
    const files = all(linear, 'MediaFile').map((m) => ({
      url: text(m),
      type: m.getAttribute('type') || '',
      width: Number(m.getAttribute('width')) || 0,
      delivery: m.getAttribute('delivery') || 'progressive',
    }));
    return {
      acc,
      duration,
      skipAfter: parseTimeOffset(linear.getAttribute('skipoffset'), duration),
      files,
      clickThrough: text(all(linear, 'ClickThrough')[0]),
    };
  }
  throw new VastError(302, 'too many wrappers');
}

function pixel(url, opts) {
  try {
    const u = expandMacros(url, opts);
    if (!/^https:\/\//i.test(u)) return;
    const img = new Image();
    img.referrerPolicy = 'strict-origin-when-cross-origin';
    img.src = u;
  } catch { /* a tracking pixel must never break playback */ }
}

// ── Player UI ──────────────────────────────────────────────────────────────

const CSS = `
.zpr{position:absolute;inset:0;z-index:30;display:flex;align-items:center;justify-content:center;
  background:#000;border-radius:inherit;overflow:hidden}
.zpr video{width:100%;height:100%;object-fit:contain;background:#000;cursor:pointer}
.zpr-bar{position:absolute;left:0;right:0;bottom:0;display:flex;align-items:center;gap:10px;
  padding:10px 12px;background:linear-gradient(transparent,rgba(0,0,0,.72));pointer-events:none}
.zpr-bar > *{pointer-events:auto}
.zpr-label{font:600 12px/1.2 system-ui,sans-serif;color:rgba(255,255,255,.85);letter-spacing:.02em;margin-right:auto}
.zpr-btn{appearance:none;border:1px solid rgba(255,255,255,.35);background:rgba(0,0,0,.55);color:#fff;
  border-radius:999px;padding:8px 14px;font:700 13px/1 system-ui,sans-serif;cursor:pointer}
.zpr-btn[disabled]{opacity:.6;cursor:default}
.zpr-btn:focus-visible{outline:3px solid #22d3ee;outline-offset:2px}
.zpr-more{font:600 12px/1 system-ui,sans-serif;color:#fff;text-decoration:underline;text-underline-offset:3px}
`;

function injectCss() {
  if (document.getElementById('zpr-css')) return;
  const st = document.createElement('style');
  st.id = 'zpr-css';
  st.textContent = CSS;
  document.head.appendChild(st);
}

/**
 * Play one pre-roll into `box` (the game's frame container).
 * @param {object} o
 * @param {string} o.vast            the VAST tag URL
 * @param {HTMLElement} o.box
 * @returns {Promise<{outcome:string}>} settles exactly once, always
 */
export function runPreroll({ vast, box }) {
  return new Promise((resolve) => {
    let settled = false;
    let cleanup = () => {};
    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(failsafe);
      try { cleanup(); } catch { /* the game loads regardless */ }
      resolve({ outcome });
    };
    const failsafe = setTimeout(() => finish('timeout'), FAILSAFE_MS);

    // Rule 4.
    if (!box || typeof vast !== 'string' || !/^https:\/\//i.test(vast) || GOOGLE_AD_RE.test(vast)) {
      finish('unconfigured');
      return;
    }
    // Rule 3.
    const lastInterstitial = adFrequencyController.lastFired('interstitial');
    if (lastInterstitial && Date.now() - lastInterstitial < NO_STACK_MS) {
      finish('stacked');
      return;
    }

    resolveAd(vast).then((ad) => {
      if (settled) return;
      const probe = document.createElement('video');
      const width = Math.max(320, Math.round(box.getBoundingClientRect().width || 640));
      const file = pickMediaFile(ad.files, width, (t) => Boolean(probe.canPlayType(t)));
      if (!file) {
        for (const u of ad.acc.errors) pixel(u, { errorCode: 403 });
        finish('unplayable');
        return;
      }
      play(ad, file);
    }).catch((e) => {
      if (e?.blocked) noteBlockedResource(vast);
      for (const u of e?.acc?.errors || []) pixel(u, { errorCode: e.code || 900 });
      finish(e?.blocked ? 'blocked' : e?.code === 303 ? 'no-fill' : 'error');
    });

    function play(ad, file) {
      injectCss();
      const skipAfter = ad.skipAfter != null ? ad.skipAfter : SKIP_AFTER_S;
      const fired = new Set();
      const track = (ev) => {
        if (fired.has(ev)) return;
        fired.add(ev);
        for (const u of ad.acc.tracking[ev] || []) pixel(u);
      };

      const overlay = document.createElement('div');
      overlay.className = 'zpr';
      overlay.setAttribute('role', 'region');
      overlay.setAttribute('aria-label', 'Advertisement — your game starts after this');

      const video = document.createElement('video');
      video.muted = true;
      video.playsInline = true;
      video.setAttribute('playsinline', '');
      video.setAttribute('webkit-playsinline', '');
      video.preload = 'auto';
      video.src = file.url;

      const bar = document.createElement('div');
      bar.className = 'zpr-bar';
      const label = document.createElement('span');
      label.className = 'zpr-label';
      label.textContent = 'Ad · your game starts after this';
      const mute = document.createElement('button');
      mute.type = 'button';
      mute.className = 'zpr-btn';
      mute.textContent = 'Unmute';
      const skip = document.createElement('button');
      skip.type = 'button';
      skip.className = 'zpr-btn';
      skip.disabled = true;
      skip.textContent = `Skip in ${Math.ceil(skipAfter)}`;
      bar.append(label);
      if (/^https:\/\//i.test(ad.clickThrough)) {
        const more = document.createElement('a');
        more.className = 'zpr-more';
        more.href = ad.clickThrough;
        more.target = '_blank';
        more.rel = 'noopener noreferrer sponsored';
        more.textContent = 'Learn more';
        more.addEventListener('click', () => { for (const u of ad.acc.clickTracking) pixel(u); });
        bar.append(more);
      }
      bar.append(mute, skip);
      overlay.append(video, bar);
      box.appendChild(overlay);

      const startTimer = setTimeout(() => { if (!fired.has('start')) finish('timeout'); }, START_TIMEOUT_MS);

      const onPlaying = () => {
        if (fired.has('start')) return;
        // Impression on the first frame actually shown — never on page load.
        for (const u of ad.acc.impressions) pixel(u);
        track('creativeView');
        track('start');
      };
      const onTime = () => {
        const t = video.currentTime;
        const d = video.duration || ad.duration || 0;
        if (d > 0) {
          if (t >= d * 0.25) track('firstQuartile');
          if (t >= d * 0.5) track('midpoint');
          if (t >= d * 0.75) track('thirdQuartile');
        }
        const left = Math.ceil(skipAfter - t);
        if (left > 0) { skip.textContent = `Skip in ${left}`; return; }
        if (skip.disabled) {
          skip.disabled = false;
          skip.textContent = 'Skip ad ›';
        }
      };
      const onEnded = () => { track('complete'); finish('completed'); };
      const onError = () => {
        for (const u of ad.acc.errors) pixel(u, { errorCode: 405 });
        finish('error');
      };
      const onClickVideo = () => {
        if (!/^https:\/\//i.test(ad.clickThrough)) return;
        for (const u of ad.acc.clickTracking) pixel(u);
        window.open(ad.clickThrough, '_blank', 'noopener');
      };
      const onMute = () => {
        video.muted = !video.muted;
        mute.textContent = video.muted ? 'Unmute' : 'Mute';
        track(video.muted ? 'mute' : 'unmute');
        fired.delete(video.muted ? 'unmute' : 'mute');
      };
      const onSkip = () => { if (!skip.disabled) { track('skip'); finish('skipped'); } };

      video.addEventListener('playing', onPlaying);
      video.addEventListener('timeupdate', onTime);
      video.addEventListener('ended', onEnded);
      video.addEventListener('error', onError);
      video.addEventListener('click', onClickVideo);
      mute.addEventListener('click', onMute);
      skip.addEventListener('click', onSkip);

      cleanup = () => {
        clearTimeout(startTimer);
        video.removeEventListener('playing', onPlaying);
        video.removeEventListener('timeupdate', onTime);
        video.removeEventListener('ended', onEnded);
        video.removeEventListener('error', onError);
        try { video.pause(); } catch { /* ignore */ }
        video.removeAttribute('src');
        try { video.load(); } catch { /* releases the network connection */ }
        overlay.remove();
      };

      const p = video.play();
      if (p && typeof p.catch === 'function') {
        // Autoplay refused even muted (iOS Low Power Mode, some in-app views):
        // the game is not held hostage to a tap on an ad.
        p.catch(() => finish('autoplay-refused'));
      }
    }
  });
}

export default { runPreroll, parseTimeOffset, pickMediaFile, expandMacros, SKIP_AFTER_S, NO_STACK_MS };
