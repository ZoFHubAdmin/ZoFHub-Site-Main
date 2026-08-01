// Unit tests for lib/weather.mjs
//
// Pure-logic only — no network. The functions that call Open-Meteo are covered
// by test/server.test.mjs against a running server, so this file stays fast and
// deterministic and never fails because someone else's API had a bad minute.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  describeCode, placeFromTimezone, summarize, looksLikeWeatherQuestion,
} from '../lib/weather.mjs';

describe('describeCode — WMO 4677 mapping', () => {
  test('maps known codes to text and an icon', () => {
    assert.equal(describeCode(0).text, 'Clear sky');
    assert.equal(describeCode(3).text, 'Overcast');
    assert.equal(describeCode(95).text, 'Thunderstorm');
    for (const code of [0, 3, 45, 61, 75, 95]) {
      assert.ok(describeCode(code).icon.length > 0, `code ${code} needs an icon`);
    }
  });

  test('unknown codes degrade instead of throwing', () => {
    // A weather widget must never crash a page over an unrecognised code.
    const d = describeCode(9999);
    assert.equal(d.text, 'Unknown');
    assert.ok(d.icon.length > 0);
    assert.doesNotThrow(() => describeCode(undefined));
    assert.doesNotThrow(() => describeCode(null));
  });
});

describe('placeFromTimezone — input validation', () => {
  // This value comes from the browser and is interpolated into an outbound URL,
  // so it is untrusted input. These cases exist to keep it that way.
  test('rejects non-timezone junk without any network call', async () => {
    const bad = [
      '', null, undefined, 'not-a-timezone', 'Toronto',
      'http://evil.example/x', '../../etc/passwd', 'A/B?x=1', 'A/B#f',
      'A/B C', 'A//B', 'javascript:alert(1)', '169.254.169.254',
      'a/'.repeat(50) + 'b',
    ];
    for (const tz of bad) {
      assert.equal(await placeFromTimezone(tz), null, `should reject: ${JSON.stringify(tz)}`);
    }
  });

  test('accepts real IANA shapes', () => {
    // Shape check only (no network): the regex must admit these.
    const re = /^[A-Za-z_+\-]+(\/[A-Za-z_+\-0-9]+){1,2}$/;
    for (const tz of [
      'America/Toronto', 'Europe/London', 'Asia/Kolkata',
      'America/Argentina/Buenos_Aires', 'America/New_York', 'Pacific/Auckland',
    ]) {
      assert.ok(re.test(tz), `should accept: ${tz}`);
    }
  });
});

describe('summarize — what the AI is handed', () => {
  const place = { name: 'Toronto', country: 'CA' };
  const wx = {
    // feelsLike is 3.5° below actual so the "feels like" clause is expected to
    // appear; the omission threshold is exercised separately below.
    current: { temperature: 21.9, feelsLike: 18.4, humidity: 62, windSpeed: 11.2, text: 'Overcast', icon: '☁️' },
    daily: [
      { date: '2026-08-01', low: 17, high: 24, precipitationChance: 20, text: 'Overcast', icon: '☁️' },
      { date: '2026-08-02', low: 18, high: 26, precipitationChance: 5, text: 'Clear sky', icon: '☀️' },
    ],
  };

  test('includes place, conditions and real numbers', () => {
    const s = summarize(place, wx);
    assert.match(s, /Toronto/);
    assert.match(s, /overcast/i);
    assert.match(s, /21\.9°C/);
    assert.match(s, /62%/);
    assert.match(s, /17–24°C/);
  });

  test('omits "feels like" when it is within 2° of actual', () => {
    // Noise, not information — repeating the same number annoys the reader.
    const near = { ...wx, current: { ...wx.current, feelsLike: 21.0 } };
    assert.ok(!/feels like/i.test(summarize(place, near)));
    assert.match(summarize(place, wx), /feels like/i);
  });

  test('returns empty string rather than throwing on missing data', () => {
    assert.equal(summarize(place, null), '');
    assert.equal(summarize(place, {}), '');
    assert.equal(summarize(null, wx).length > 0, true);   // falls back to "your area"
    assert.match(summarize(null, wx), /your area/);
  });
});

describe('looksLikeWeatherQuestion — grounding trigger', () => {
  test('fires on genuine weather questions', () => {
    for (const q of [
      "what's the weather", 'is it raining', 'temperature today?',
      'do I need an umbrella', 'how hot is it', 'forecast for tomorrow',
      'is it going to snow', 'how windy is it', 'what is the humidity',
    ]) {
      assert.equal(looksLikeWeatherQuestion(q), true, `should fire: ${q}`);
    }
  });

  test('does NOT fire on unrelated questions', () => {
    // Attaching a weather report to an unrelated question is worse than not
    // attaching one, so the trigger is deliberately tight.
    for (const q of [
      'what games are fun', 'help me with algebra', 'who made this site',
      'recommend a racing game', 'how do I use the proxy', 'write me a poem',
    ]) {
      assert.equal(looksLikeWeatherQuestion(q), false, `should not fire: ${q}`);
    }
  });

  test('handles empty and non-string input', () => {
    assert.equal(looksLikeWeatherQuestion(''), false);
    assert.equal(looksLikeWeatherQuestion(null), false);
    assert.equal(looksLikeWeatherQuestion(undefined), false);
  });
});
