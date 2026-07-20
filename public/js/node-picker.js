// ZoFHub · node-picker.js — honest proxy route/engine picker.
// ---------------------------------------------------------------------------
// Lets a visitor choose which proxy ROUTE to use. Every route is equally and
// freely accessible — there are NO "premium" tiers, NO verification steps, and
// NO offer walls. The routes shown are the REAL engines this site runs
// (GUST / Ultraviolet / Scramjet), plus any optional companion services that are
// actually online right now (fetched live from /api/proxies — we never show a
// route that isn't really up, so the status dots are truthful).
//
// USAGE:
//   import { mountNodePicker } from './node-picker.js';
//   mountNodePicker(document.querySelector('#routeGrid'));
//   // Listen for the choice:
//   window.addEventListener('zofhub:node-selected', e => console.log(e.detail.id));
//
// The chosen route id is saved to localStorage.zofhub_route and broadcast via a
// 'zofhub:node-selected' CustomEvent so your /browser code can act on it.
// ---------------------------------------------------------------------------

const STORE_KEY = 'zofhub_route';

// The built-in engines this server always provides on the proxy build. These are
// REAL, with honest one-line descriptions of their genuine trade-offs.
const BUILTIN_ROUTES = [
  { id: 'gust',        name: 'GUST',        badge: 'default', online: true,
    desc: 'No service worker needed — the most reliable route on locked-down or managed devices.' },
  { id: 'ultraviolet', name: 'Ultraviolet', badge: 'engine',  online: true,
    desc: 'Service-worker engine with broad site support. A fast, well-tested all-rounder.' },
  { id: 'scramjet',    name: 'Scramjet',    badge: 'engine',  online: true,
    desc: 'Newest engine — best for modern, script-heavy sites. Try this if another route struggles.' },
];

function getSaved() {
  try { return localStorage.getItem(STORE_KEY) || 'gust'; } catch { return 'gust'; }
}
function save(id) {
  try { localStorage.setItem(STORE_KEY, id); } catch { /* private mode — fine, in-memory only */ }
}

function cardFor(route, selectedId) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'np-card';
  btn.dataset.routeId = route.id;
  btn.setAttribute('aria-pressed', String(route.id === selectedId));
  const online = route.online !== false;
  btn.innerHTML = `
    <div class="np-card-head">
      <span class="np-dot ${online ? 'is-online' : 'is-offline'}" aria-hidden="true"></span>
      <span class="np-name"></span>
      <span class="np-badge"></span>
    </div>
    <p class="np-desc"></p>
    <span class="np-selected-tag">✓ Selected route</span>`;
  // textContent (not innerHTML) for anything data-derived → no XSS.
  btn.querySelector('.np-name').textContent = route.name;
  btn.querySelector('.np-badge').textContent = route.badge || 'route';
  btn.querySelector('.np-desc').textContent = route.desc || '';
  if (!online) btn.disabled = true;
  return btn;
}

/**
 * Render the picker into `container`. Returns a small controller you can use to
 * read/change the current selection programmatically.
 */
export function mountNodePicker(container, { onSelect } = {}) {
  if (!container) return null;
  let selectedId = getSaved();

  const grid = document.createElement('div');
  grid.className = 'np-grid';
  grid.setAttribute('role', 'group');
  grid.setAttribute('aria-label', 'Choose a proxy route');
  container.innerHTML = '';
  container.appendChild(grid);

  function render(routes) {
    grid.innerHTML = '';
    // Keep the saved choice valid; fall back to the first online route.
    if (!routes.some(r => r.id === selectedId && r.online !== false)) {
      selectedId = (routes.find(r => r.online !== false) || routes[0]).id;
      save(selectedId);
    }
    for (const r of routes) grid.appendChild(cardFor(r, selectedId));
  }

  function select(id) {
    const card = grid.querySelector(`.np-card[data-route-id="${CSS.escape(id)}"]`);
    if (!card || card.disabled) return;
    selectedId = id;
    save(id);
    grid.querySelectorAll('.np-card').forEach(c =>
      c.setAttribute('aria-pressed', String(c.dataset.routeId === id)));
    const detail = { id };
    window.dispatchEvent(new CustomEvent('zofhub:node-selected', { detail }));
    if (typeof onSelect === 'function') onSelect(id);
  }

  grid.addEventListener('click', e => {
    const card = e.target.closest('.np-card');
    if (card && !card.disabled) select(card.dataset.routeId);
  });

  // Initial render with the built-ins (instant, no waiting on the network)…
  render(BUILTIN_ROUTES);

  // …then fold in any optional companion routes that are ACTUALLY online.
  fetch('/api/proxies')
    .then(r => r.ok ? r.json() : null)
    .then(data => {
      const companions = (data && Array.isArray(data.engines) ? data.engines : [])
        .filter(e => e && e.up)                       // only ones truly reachable
        .map(e => ({ id: e.id || e.name, name: e.name || e.id, badge: 'companion',
                     online: true, desc: 'Optional companion route (currently online).' }));
      if (companions.length) render([...BUILTIN_ROUTES, ...companions]);
    })
    .catch(() => { /* offline / no companions → the built-in routes stand alone */ });

  return { get: () => selectedId, select };
}
