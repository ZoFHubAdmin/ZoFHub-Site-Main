// ZoFHub · weather-widget.js
//
// A small live-weather pill in the site header, on every page.
//
// LOCATION WITHOUT A PERMISSION PROMPT
// It sends the browser's IANA timezone (Intl.DateTimeFormat().resolvedOptions()
// .timeZone), not navigator.geolocation. Two reasons:
//   • geolocation fires a permission dialog. On a widget that renders on EVERY
//     page that is hostile, and most people decline — so the widget would sit
//     empty for the majority of visitors.
//   • an IP-geolocation service would mean handing a third party the visitor's
//     IP address. This site exists partly so students are not identifiable;
//     bolting a tracker onto it would defeat the point.
// The timezone is a single innocuous string the browser already knows, and it
// resolves to city accuracy — the right resolution for "do I need a coat".
//
// The whole widget is best-effort: any failure hides it. A missing weather pill
// is a non-event; a broken-looking one is not.

const LS_KEY = 'zofhub:v2:weatherCity';
const REFRESH_MS = 10 * 60 * 1000;   // matches the server-side forecast cache

const read = () => { try { return localStorage.getItem(LS_KEY) || ''; } catch { return ''; } };
const write = (v) => { try { v ? localStorage.setItem(LS_KEY, v) : localStorage.removeItem(LS_KEY); } catch { /* private mode */ } };

function browserTimezone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch { return ''; }
}

async function fetchWeather() {
  const city = read();
  const params = city
    ? 'city=' + encodeURIComponent(city)
    : 'tz=' + encodeURIComponent(browserTimezone());
  if (!params.split('=')[1]) return null;          // no timezone and no city
  const r = await fetch('/api/weather?' + params, { headers: { Accept: 'application/json' } });
  if (!r.ok) return null;
  const j = await r.json();
  return j && j.ok ? j : null;
}

export function mountWeather() {
  const header = document.querySelector('.header-inner');
  if (!header || header.querySelector('.wx-pill')) return;

  const pill = document.createElement('div');
  pill.className = 'wx-pill';
  pill.hidden = true;                               // stays hidden until real data
  pill.innerHTML = `
    <button class="wx-btn" type="button" aria-label="Weather — click to change location">
      <span class="wx-icon" aria-hidden="true"></span>
      <span class="wx-temp"></span>
      <span class="wx-place"></span>
    </button>
    <form class="wx-edit" hidden>
      <input class="wx-input" type="text" placeholder="City…" maxlength="60"
             autocomplete="off" spellcheck="false" aria-label="Weather location" />
    </form>`;

  // Sit next to the online-players pill so the two live indicators read as a set.
  const anchor = header.querySelector('.live-total');
  if (anchor && anchor.nextSibling) header.insertBefore(pill, anchor.nextSibling);
  else if (anchor) header.appendChild(pill);
  else {
    const brand = header.querySelector('.brand');
    if (brand && brand.nextSibling) header.insertBefore(pill, brand.nextSibling);
    else header.appendChild(pill);
  }

  const btn = pill.querySelector('.wx-btn');
  const form = pill.querySelector('.wx-edit');
  const input = pill.querySelector('.wx-input');
  const iconEl = pill.querySelector('.wx-icon');
  const tempEl = pill.querySelector('.wx-temp');
  const placeEl = pill.querySelector('.wx-place');

  async function paint() {
    let data = null;
    try { data = await fetchWeather(); } catch { /* offline → leave hidden */ }
    if (!data) { pill.hidden = true; return; }
    const c = data.current;
    iconEl.textContent = c.icon;
    tempEl.textContent = `${Math.round(c.temperature)}°`;
    placeEl.textContent = data.place.name || '';
    const today = data.daily && data.daily[0];
    btn.title = `${c.text}, feels like ${Math.round(c.feelsLike)}°C`
      + (today ? ` · today ${Math.round(today.low)}–${Math.round(today.high)}°C` : '')
      + (today && today.precipitationChance != null ? ` · ${today.precipitationChance}% precip` : '')
      + '\nClick to change location';
    pill.hidden = false;
  }

  btn.addEventListener('click', () => {
    form.hidden = false;
    btn.hidden = true;
    input.value = read();
    input.focus();
    input.select();
  });

  const closeEdit = () => { form.hidden = true; btn.hidden = false; };

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    write(input.value.trim());
    closeEdit();
    await paint();
  });
  input.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeEdit(); });
  input.addEventListener('blur', closeEdit);

  paint();
  // Refresh on the same cadence as the server cache, and whenever the tab comes
  // back to the foreground — a laptop reopened hours later should not show
  // yesterday's temperature.
  setInterval(paint, REFRESH_MS);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') paint();
  });
}

export default { mountWeather };
