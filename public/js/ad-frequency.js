// ZoFHub · ad-frequency.js — the local throttle every full-screen ad asks first.
// ---------------------------------------------------------------------------
// Networks that sell interstitial formats will happily fire one on EVERY page
// view. On a games site that means a full-screen ad between a player and the
// game they just clicked — the fastest way to lose the audience that generates
// the traffic in the first place.
//
// So OUR code asks before it shows one, and this says no unless enough time has
// passed. State lives in localStorage so it survives reloads and is shared
// across tabs on the same device.
//
//   import { adFrequencyController } from './ad-frequency.js';
//   if (adFrequencyController.allow('interstitial')) { /* fire it */ }
//
// It CANNOT throttle what a network's own loader does internally (that is the
// network's dashboard setting — set the cap there too). What it guarantees is
// that ZoFHub's code never asks more often than this.
//
// Its own module because two callers need the same state: the between-games
// interstitial (ad-slots.js) records a fire, and the game pre-roll (preroll.js)
// reads it so the two full-screen units never play back to back.
// ---------------------------------------------------------------------------

const FREQ_KEY = 'zofhub.adfreq.v1';

// The between-games interstitial: at most one per visitor every 20 minutes.
// A product decision, hard-coded on purpose — the server sends no value that
// could change it, and no configuration reaches this constant.
export const INTERSTITIAL_COOLDOWN_MS = 20 * 60 * 1000;
// The default for any other slot a caller throttles.
export const DEFAULT_COOLDOWN_MS = 20 * 60 * 1000;

function readState() {
  try {
    const raw = localStorage.getItem(FREQ_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return (parsed && typeof parsed === 'object') ? parsed : {};
  } catch { return {}; }        // private mode / storage disabled / corrupt JSON
}

function writeState(state) {
  try { localStorage.setItem(FREQ_KEY, JSON.stringify(state)); } catch { /* non-fatal */ }
}

export const adFrequencyController = {
  /**
   * May `slot` fire right now? Records the timestamp when it returns true, so a
   * caller cannot ask twice and get two yeses.
   * @param {string} slot        logical name, e.g. 'interstitial'
   * @param {number} cooldownMs  minimum gap between fires (default 20 min)
   */
  allow(slot = 'interstitial', cooldownMs = DEFAULT_COOLDOWN_MS) {
    // If storage is unavailable we cannot throttle, so we deliberately fail
    // CLOSED (return false). An untracked interstitial that fires on every
    // single game launch is far worse than no interstitial at all.
    let store;
    try { store = window.localStorage; } catch { return false; }
    if (!store) return false;

    const now = Date.now();
    const state = readState();
    const last = Number(state[slot]) || 0;

    // A clock that jumped backwards (timezone change, manual set) would leave
    // `last` in the future and block the slot forever — treat that as expired.
    if (last > now) { state[slot] = now; writeState(state); return true; }
    if (now - last < cooldownMs) return false;

    state[slot] = now;
    writeState(state);
    return true;
  },

  /** Seconds until `slot` is allowed again (0 = allowed now). Read-only. */
  cooldownRemaining(slot = 'interstitial', cooldownMs = DEFAULT_COOLDOWN_MS) {
    const last = Number(readState()[slot]) || 0;
    if (!last) return 0;
    const left = cooldownMs - (Date.now() - last);
    return left > 0 ? Math.ceil(left / 1000) : 0;
  },

  /** Epoch ms when `slot` last fired, or 0. Read-only. */
  lastFired(slot = 'interstitial') {
    return Number(readState()[slot]) || 0;
  },

  /** Clear throttle state (testing / "why isn't my ad showing" debugging). */
  reset(slot) {
    if (!slot) { try { localStorage.removeItem(FREQ_KEY); } catch {} return; }
    const state = readState();
    delete state[slot];
    writeState(state);
  },
};

// Expose for console debugging and for any non-module inline script that wants
// to gate its own interstitial call.
if (typeof window !== 'undefined') window.adFrequencyController = adFrequencyController;

export default adFrequencyController;
