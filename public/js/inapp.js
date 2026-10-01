// ZoFHub · inapp.js — is this page running inside a social app's web view?
// ---------------------------------------------------------------------------
// TikTok, Instagram, Facebook and friends open links in their OWN browser: a
// bare WKWebView on iOS, an Android System WebView on Android. Those are not
// the browsers ZoFHub's proxy engines are built for. On iOS a WKWebView has no
// Service Workers unless the host app opts in (none of these do), so
// Ultraviolet and Scramjet — which ARE service workers — cannot start at all,
// and GUST's frames render blank. The fix is not in this codebase; it is for
// the visitor to open the page in Safari or Chrome. layout.js shows the banner
// that says so; this file only answers the question.
//
// Pure: no DOM access at import time, so test/inapp.test.mjs imports it in Node.
//
// Detection is by user-agent token, because that is the only signal these
// apps give. Each token below is one the app itself adds to the UA string. A
// generic "is this a web view?" heuristic (Android's `; wv)`, iOS without
// "Safari/") was rejected on purpose: it also matches ordinary browsers built
// on the system web view, which would tell those visitors to leave a browser
// that works.
// ---------------------------------------------------------------------------

const APPS = [
  // TikTok: musical_ly (global iOS), trill (Asia), BytedanceWebview / ByteLocale
  // (Android), plus the Android package ids some builds append.
  ['TikTok', /\bmusical_ly|\btrill_\d|BytedanceWebview|ByteLocale\/|\bTikTok\b|com\.zhiliaoapp\.musically|com\.ss\.android\.ugc/i],
  ['Instagram', /\bInstagram\b/i],
  // Facebook and Messenger both announce themselves with FBAN / FBAV / FB_IAB.
  ['Facebook', /\bFBAN\/|\bFBAV\/|\bFB_IAB\b|\bFBIOS\b|\bFB4A\b/i],
  // Threads ships under its internal codename.
  ['Threads', /\bBarcelona\s+\d/i],
  ['Snapchat', /\bSnapchat\b/i],
  ['LinkedIn', /\bLinkedInApp\b/i],
];

/**
 * @param {string} ua              navigator.userAgent
 * @param {number} [touchPoints]   navigator.maxTouchPoints (tells iPadOS from macOS)
 * @returns {{ app: string, os: 'ios'|'android'|'other' } | null}
 */
export function detectInAppBrowser(ua, touchPoints = 0) {
  const s = String(ua || '');
  if (!s) return null;
  const hit = APPS.find(([, re]) => re.test(s));
  if (!hit) return null;
  let os = 'other';
  if (/\bAndroid\b/i.test(s)) os = 'android';
  else if (/\b(iPhone|iPad|iPod)\b/.test(s) || (/\bMacintosh\b/.test(s) && touchPoints > 1)) os = 'ios';
  return { app: hit[0], os };
}

/**
 * Links that ask the OS to reopen `href` in a real browser. Each is best-effort
 * — an app may refuse to hand the link on — which is why the banner always
 * spells out the manual route too.
 *
 *   Android  an intent: URL naming Chrome, with the page itself as the fallback
 *   iOS      x-safari-https:, which iOS 17+ routes to Safari
 *
 * @returns {{ label: string, url: string } | null}
 */
export function externalBrowserLink(href, os) {
  let u;
  try { u = new URL(String(href)); } catch { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  const scheme = u.protocol.slice(0, -1);
  const rest = `${u.host}${u.pathname}${u.search}${u.hash}`;
  if (os === 'android') {
    return {
      label: 'Open in Chrome',
      url: `intent://${u.host}${u.pathname}${u.search}#Intent;scheme=${scheme};package=com.android.chrome;`
        + `S.browser_fallback_url=${encodeURIComponent(u.href)};end`,
    };
  }
  if (os === 'ios') return { label: 'Open in Safari', url: `x-safari-${scheme}://${rest}` };
  return null;
}

/** The banner's words. One constant, so changing them is one edit. */
export const INAPP_MESSAGE = '⚠️ Proxy Warning: In-app browsers restrict game unblocking. '
  + 'For peak performance, click the options icon (three dots) in the corner and select '
  + '\'Open in External Browser\' (Safari/Chrome) immediately.';

export default { detectInAppBrowser, externalBrowserLink, INAPP_MESSAGE };
