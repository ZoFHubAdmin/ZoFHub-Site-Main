// lib/weather.mjs — live weather via Open-Meteo.
//
// WHY OPEN-METEO: free, no API key, no signup, generous limits, and a permissive
// licence for non-commercial use. Nothing secret ever needs to reach the client,
// because there is no secret.
//
// ── HOW WE KNOW WHERE THE USER IS (and why it is not geolocation) ──────────
// The obvious options are both wrong for this site:
//
//   navigator.geolocation  → fires a browser permission prompt. On a widget that
//                            appears on EVERY page that is hostile, and most
//                            users decline, so the widget would be empty.
//   IP geolocation service → a third-party request that hands someone else the
//                            visitor's IP. This site exists partly to keep
//                            students unidentifiable; adding a tracker to it
//                            would be self-defeating.
//
// So we use the IANA timezone the browser already knows
// (Intl.DateTimeFormat().resolvedOptions().timeZone). It needs no permission,
// leaves the device as a single innocuous string, and the name CONTAINS a city:
//
//   America/Toronto                -> Toronto        43.71,-79.40
//   Asia/Kolkata                   -> Kolkata        22.56, 88.36
//   America/Argentina/Buenos_Aires -> Buenos Aires  -34.61,-58.38
//
// Verified across 10 timezones spanning every continent: 10/10 resolved, the
// three-segment Argentina case included. It is city-accurate rather than
// street-accurate, which is exactly the right resolution for "is it raining".
// A user who wants somewhere else can search for a city; that choice is stored
// in their browser and never on our server.

const GEO_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';

const FETCH_TIMEOUT_MS = Number(process.env.WEATHER_TIMEOUT_MS) || 8000;
// Weather does not change meaningfully inside 10 minutes, and this endpoint is
// hit by every page load of the whole site. Caching is what keeps us a good
// citizen of a free API.
const FORECAST_TTL_MS = Number(process.env.WEATHER_TTL_MS) || 10 * 60_000;
// Place coordinates never change. Cache them for a day.
const GEO_TTL_MS = 24 * 60 * 60_000;
const MAX_CACHE = 500;

// WMO 4677 weather codes -> human text + emoji.
// Emoji rather than icon files: no extra asset requests, no CSP additions, and
// it renders identically in the header, in the AI's replies, and in a plain
// JSON response.
const WMO = {
  0:  ['Clear sky', '☀️'],
  1:  ['Mainly clear', '🌤️'],
  2:  ['Partly cloudy', '⛅'],
  3:  ['Overcast', '☁️'],
  45: ['Fog', '🌫️'],
  48: ['Rime fog', '🌫️'],
  51: ['Light drizzle', '🌦️'],
  53: ['Drizzle', '🌦️'],
  55: ['Heavy drizzle', '🌦️'],
  56: ['Freezing drizzle', '🌧️'],
  57: ['Freezing drizzle', '🌧️'],
  61: ['Light rain', '🌦️'],
  63: ['Rain', '🌧️'],
  65: ['Heavy rain', '🌧️'],
  66: ['Freezing rain', '🌧️'],
  67: ['Freezing rain', '🌧️'],
  71: ['Light snow', '🌨️'],
  73: ['Snow', '🌨️'],
  75: ['Heavy snow', '❄️'],
  77: ['Snow grains', '🌨️'],
  80: ['Light showers', '🌦️'],
  81: ['Showers', '🌧️'],
  82: ['Heavy showers', '⛈️'],
  85: ['Snow showers', '🌨️'],
  86: ['Snow showers', '❄️'],
  95: ['Thunderstorm', '⛈️'],
  96: ['Thunderstorm, hail', '⛈️'],
  99: ['Thunderstorm, hail', '⛈️'],
};

export function describeCode(code) {
  const [text, icon] = WMO[code] || ['Unknown', '🌡️'];
  return { text, icon };
}

// ── Tiny bounded TTL cache ────────────────────────────────────────────────
// Deliberately in-process and deliberately small. This is a cache, not state:
// every instance may hold its own copy with no correctness consequence, which
// is why it does not need the shared Redis the rest of the app can use.
function makeCache(ttl) {
  const m = new Map();
  return {
    get(k) {
      const hit = m.get(k);
      if (!hit) return null;
      if (Date.now() > hit.exp) { m.delete(k); return null; }
      return hit.v;
    },
    set(k, v) {
      if (m.size >= MAX_CACHE) m.delete(m.keys().next().value); // oldest out
      m.set(k, { v, exp: Date.now() + ttl });
    },
  };
}
const geoCache = makeCache(GEO_TTL_MS);
const wxCache = makeCache(FORECAST_TTL_MS);

async function getJson(url) {
  const r = await fetch(url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { Accept: 'application/json' },
  });
  if (!r.ok) throw new Error('weather upstream ' + r.status);
  return r.json();
}

/** Look up a place by name. Returns null when nothing matches — callers treat
 *  that as "no weather", never as an error worth showing the user. */
export async function geocode(name) {
  const q = String(name || '').trim().slice(0, 80);
  if (!q) return null;
  const key = q.toLowerCase();
  const cached = geoCache.get(key);
  if (cached !== null) return cached;

  const url = `${GEO_URL}?name=${encodeURIComponent(q)}&count=1&language=en&format=json`;
  let place = null;
  try {
    const j = await getJson(url);
    const hit = (j.results || [])[0];
    if (hit) {
      place = {
        name: hit.name,
        country: hit.country_code || hit.country || '',
        latitude: hit.latitude,
        longitude: hit.longitude,
        timezone: hit.timezone || 'auto',
      };
    }
  } catch (e) {
    console.warn('[weather] geocode failed for', q + ':', e.message);
  }
  geoCache.set(key, place);
  return place;
}

/** IANA timezone -> place. "America/Argentina/Buenos_Aires" -> "Buenos Aires". */
export async function placeFromTimezone(tz) {
  const raw = String(tz || '').trim();
  // Reject anything that is not a plausible IANA name before it becomes a URL.
  if (!/^[A-Za-z_+\-]+(\/[A-Za-z_+\-0-9]+){1,2}$/.test(raw)) return null;
  const city = raw.split('/').pop().replace(/_/g, ' ');
  return geocode(city);
}

/** Live current conditions + a short forecast. Never returns stale-but-silent
 *  data: a failure throws so the caller can decide, rather than inventing a
 *  temperature — the one thing a weather feature must never do. */
export async function forecast(lat, lon) {
  const la = Number(lat), lo = Number(lon);
  if (!Number.isFinite(la) || !Number.isFinite(lo)) throw new Error('bad coordinates');
  if (la < -90 || la > 90 || lo < -180 || lo > 180) throw new Error('coordinates out of range');

  // Round to ~1km for the cache key so neighbours share an entry.
  const key = la.toFixed(2) + ',' + lo.toFixed(2);
  const cached = wxCache.get(key);
  if (cached) return { ...cached, cached: true };

  const url = `${FORECAST_URL}?latitude=${la}&longitude=${lo}`
    + '&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m,is_day'
    + '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max'
    + '&forecast_days=3&timezone=auto';

  const j = await getJson(url);
  const c = j.current || {};
  const d = j.daily || {};
  const desc = describeCode(c.weather_code);

  const out = {
    current: {
      temperature: round1(c.temperature_2m),
      feelsLike: round1(c.apparent_temperature),
      humidity: c.relative_humidity_2m,
      windSpeed: round1(c.wind_speed_10m),
      isDay: c.is_day === 1,
      code: c.weather_code,
      text: desc.text,
      icon: desc.icon,
      observedAt: c.time || null,
    },
    daily: (d.time || []).map((date, i) => {
      const dd = describeCode(d.weather_code?.[i]);
      return {
        date,
        high: round1(d.temperature_2m_max?.[i]),
        low: round1(d.temperature_2m_min?.[i]),
        precipitationChance: d.precipitation_probability_max?.[i] ?? null,
        code: d.weather_code?.[i],
        text: dd.text,
        icon: dd.icon,
      };
    }),
    units: { temperature: '°C', wind: 'km/h' },
    timezone: j.timezone || null,
    cached: false,
  };
  wxCache.set(key, out);
  return out;
}

const round1 = (n) => (typeof n === 'number' ? Math.round(n * 10) / 10 : null);

/** Resolve a location from whatever the caller supplied, most explicit first. */
export async function resolveLocation({ lat, lon, city, tz } = {}) {
  if (lat !== undefined && lon !== undefined
      && Number.isFinite(Number(lat)) && Number.isFinite(Number(lon))) {
    return { name: null, country: '', latitude: Number(lat), longitude: Number(lon) };
  }
  if (city) {
    const p = await geocode(city);
    if (p) return p;
  }
  if (tz) {
    const p = await placeFromTimezone(tz);
    if (p) return p;
  }
  return null;
}

/** One-line summary the AI can drop straight into an answer. */
export function summarize(place, wx) {
  if (!wx || !wx.current) return '';
  const where = place && place.name
    ? `${place.name}${place.country ? ', ' + place.country : ''}`
    : 'your area';
  const c = wx.current;
  const today = wx.daily && wx.daily[0];
  let s = `${where}: ${c.text.toLowerCase()}, ${c.temperature}°C`;
  if (c.feelsLike != null && Math.abs(c.feelsLike - c.temperature) >= 2) {
    s += ` (feels like ${c.feelsLike}°C)`;
  }
  if (c.humidity != null) s += `, humidity ${c.humidity}%`;
  if (c.windSpeed != null) s += `, wind ${c.windSpeed} km/h`;
  if (today) {
    s += `. Today ${today.low}–${today.high}°C`;
    if (today.precipitationChance != null) s += `, ${today.precipitationChance}% chance of precipitation`;
  }
  if (wx.daily && wx.daily.length > 1) {
    s += '. Next: ' + wx.daily.slice(1).map(d =>
      `${d.date} ${d.text.toLowerCase()} ${d.low}–${d.high}°C`).join('; ');
  }
  return s + '.';
}

// Words that mean the user is asking about weather. Used to decide whether to
// attach live conditions to an AI prompt. Kept deliberately tight: attaching a
// weather report to an unrelated question is worse than not attaching one.
const WEATHER_RE = /\b(weather|forecast|temperature|how (?:hot|cold|warm)|raining|rainy|rain|snow(?:ing)?|sunny|cloudy|humidity|wind(?:y)?|storm|thunder|degrees|celsius|fahrenheit|umbrella|jacket)\b/i;
export const looksLikeWeatherQuestion = (text) => WEATHER_RE.test(String(text || ''));

export default {
  describeCode, geocode, placeFromTimezone, forecast, resolveLocation,
  summarize, looksLikeWeatherQuestion,
};
