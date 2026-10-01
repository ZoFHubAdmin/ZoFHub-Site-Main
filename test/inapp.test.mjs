// In-app browser detection (public/js/inapp.js) — pure, so it runs in Node.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectInAppBrowser, externalBrowserLink, INAPP_MESSAGE } from '../public/js/inapp.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

// Real-shaped user agents, as each app sends them.
const IN_APP = {
  'TikTok iOS': ['TikTok', 'ios', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 musical_ly_34.1.0 JsSdk/2.0 NetType/WIFI Channel/App Store ByteLocale/en Region/US'],
  'TikTok Android': ['TikTok', 'android', 'Mozilla/5.0 (Linux; Android 14; Pixel 7 Build/UQ1A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/124.0 Mobile Safari/537.36 trill_340103 BytedanceWebview/d8a21c6'],
  'Instagram iOS': ['Instagram', 'ios', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 330.0.0.40.92 (iPhone15,2; iOS 17_4; en_US; en; scale=3.00; 1179x2556; 598516547)'],
  'Instagram Android': ['Instagram', 'android', 'Mozilla/5.0 (Linux; Android 13; SM-S918B Build/TP1A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/124.0 Mobile Safari/537.36 Instagram 330.0.0.40.92 Android'],
  'Facebook iOS': ['Facebook', 'ios', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/460.0.0.35.105;FBBV/1;FBDV/iPhone15,2;FBMD/iPhone;FBSN/iOS;FBSV/17.4]'],
  'Messenger Android': ['Facebook', 'android', 'Mozilla/5.0 (Linux; Android 14; Pixel 8; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/124.0 Mobile Safari/537.36 [FB_IAB/Orca-Android;FBAV/450.0.0.1;]'],
  'Snapchat': ['Snapchat', 'ios', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Snapchat/13.0.0.40 (like Safari/8617.1.17.10.8, panda)'],
  'iPad TikTok (desktop UA)': ['TikTok', 'ios', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) musical_ly_34.1.0', 5],
};

const REAL_BROWSERS = {
  'Safari iOS': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
  'Chrome Android': 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',
  'Chrome iOS': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/124.0 Mobile/15E148 Safari/604.1',
  'Firefox desktop': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0',
  'Samsung Internet': 'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/24.0 Chrome/117.0 Mobile Safari/537.36',
  // A browser built on the system web view: `; wv)` alone must not trip it.
  'WebView-based browser': 'Mozilla/5.0 (Linux; Android 13; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/120.0 Mobile Safari/537.36 Via/5.0',
};

describe('detection', () => {
  for (const [label, [app, os, ua, touch]] of Object.entries(IN_APP)) {
    test(`${label} is detected`, () => {
      assert.deepEqual(detectInAppBrowser(ua, touch || 0), { app, os });
    });
  }
  for (const [label, ua] of Object.entries(REAL_BROWSERS)) {
    test(`${label} is NOT told to leave`, () => {
      assert.equal(detectInAppBrowser(ua), null);
    });
  }
  test('empty input is not an app', () => {
    assert.equal(detectInAppBrowser(''), null);
    assert.equal(detectInAppBrowser(undefined), null);
  });
});

describe('the way out', () => {
  test('Android gets a Chrome intent with the page as its fallback', () => {
    const l = externalBrowserLink('https://zofhub.test/browser?x=1#y', 'android');
    assert.equal(l.label, 'Open in Chrome');
    assert.equal(l.url, 'intent://zofhub.test/browser?x=1#Intent;scheme=https;package=com.android.chrome;'
      + `S.browser_fallback_url=${encodeURIComponent('https://zofhub.test/browser?x=1#y')};end`);
  });

  test('iOS gets Safari\'s own scheme', () => {
    assert.deepEqual(externalBrowserLink('https://zofhub.test/play/x', 'ios'),
      { label: 'Open in Safari', url: 'x-safari-https://zofhub.test/play/x' });
  });

  test('anything else, or a non-web URL, gets no button', () => {
    assert.equal(externalBrowserLink('https://zofhub.test/', 'other'), null);
    assert.equal(externalBrowserLink('javascript:alert(1)', 'ios'), null);
  });

  test('the banner says exactly what was specified', () => {
    assert.equal(INAPP_MESSAGE, '⚠️ Proxy Warning: In-app browsers restrict game unblocking. For peak performance, '
      + 'click the options icon (three dots) in the corner and select \'Open in External Browser\' (Safari/Chrome) immediately.');
  });

  test('layout.js mounts it, and the layout reserves its height instead of being covered', () => {
    const layout = readFileSync(join(ROOT, 'public', 'js', 'layout.js'), 'utf8');
    assert.match(layout, /^mountInAppBanner\(\);$/m);
    assert.match(layout, /setProperty\('--inapp-bar-h'/);
    const main = readFileSync(join(ROOT, 'public', 'css', 'main.css'), 'utf8');
    assert.match(main, /--inapp-bar-h: 0px;/);
    assert.match(main, /html\.zh-inapp \.site-header \{ top: var\(--inapp-bar-h\); \}/);
    for (const f of ['browser.css', 'ai.css']) {
      const css = readFileSync(join(ROOT, 'public', 'css', f), 'utf8');
      assert.match(css, /- var\(--inapp-bar-h, 0px\)\)/, `${f} does not subtract the banner`);
    }
  });
});
