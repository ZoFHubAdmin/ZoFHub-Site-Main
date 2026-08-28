// public/js/gameflare-catalog.js — the GameFlare catalog screen.
// ---------------------------------------------------------------------------
// Renders ONLY what /api/gameflare/games returns, and that endpoint returns only
// games whose iframe_compatibility.status is "verified_working". There is no
// client-side path to an unverified candidate because the data never arrives.
//
// EVERY value from the dataset is written with textContent or setAttribute.
// Nothing is concatenated into innerHTML anywhere in this file. The catalog is
// third-party JSON, and a game title is exactly the kind of field that is
// attacker-controlled in principle even when it looks like "Angry Birds".
//
// As supplied the catalog is empty, so the normal render path here is the empty
// state. That is the correct outcome, and it is why the filter controls stay
// hidden until there is something to filter.
// ---------------------------------------------------------------------------
(() => {
  'use strict';

  const grid = document.getElementById('gf-grid');
  const statusEl = document.getElementById('gf-status');
  const emptyEl = document.getElementById('gf-empty');
  const emptyTitle = document.getElementById('gf-empty-title');
  const emptyBody = document.getElementById('gf-empty-body');
  const controls = document.getElementById('gf-controls');
  const searchEl = document.getElementById('gf-search');
  const categoryEl = document.getElementById('gf-category');
  const developerEl = document.getElementById('gf-developer');
  const developerField = document.getElementById('gf-developer-field');
  const sortEl = document.getElementById('gf-sort');
  if (!grid) return;

  /** Full eligible set, fetched once. Filtering is local — the catalog is small. */
  let ALL = [];

  const setStatus = (text) => { statusEl.textContent = text || ''; };

  function showEmpty(title, body) {
    grid.replaceChildren();
    emptyTitle.textContent = title;
    emptyBody.textContent = body;
    emptyEl.hidden = false;
  }

  // ── Card ─────────────────────────────────────────────────────────────────
  function card(game) {
    const li = document.createElement('li');
    li.className = 'gf-card';

    // The thumbnail is the EXACT thumbnail_url the dataset supplied. It is not
    // rewritten, resized, proxied or mirrored.
    const img = document.createElement('img');
    img.className = 'gf-thumb';
    img.src = game.thumbnailUrl;
    img.alt = `${game.name} cover art`;
    img.loading = 'lazy';
    img.decoding = 'async';
    img.width = 400;
    img.height = 300;
    // One failure, one swap. Retrying a remote URL on error is how a broken
    // image becomes a request loop against someone else's CDN.
    img.addEventListener('error', () => {
      const ph = document.createElement('div');
      ph.className = 'gf-thumb gf-thumb-missing';
      ph.setAttribute('role', 'img');
      ph.setAttribute('aria-label', `${game.name} — cover art unavailable`);
      img.replaceWith(ph);
    }, { once: true });
    li.appendChild(img);

    const body = document.createElement('div');
    body.className = 'gf-card-body';

    const h = document.createElement('h2');
    h.className = 'gf-card-title';
    h.textContent = game.name;
    body.appendChild(h);

    const meta = document.createElement('p');
    meta.className = 'gf-card-meta';
    const bits = [];
    if (game.categories.length) bits.push(game.categories.join(' · '));
    if (game.ratingPercent !== null) bits.push(`${game.ratingPercent}% rating`);
    // The abbreviated display string is shown as-is; it is never parsed.
    if (game.playCountDisplay) bits.push(`${game.playCountDisplay} plays`);
    if (game.developer) bits.push(game.developer);
    meta.textContent = bits.join(' — ');
    body.appendChild(meta);

    // A real link, not a button with a click handler. It navigates internally,
    // has no target, and works with middle-click, keyboard and back button the
    // way the rest of the site does.
    const play = document.createElement('a');
    play.className = 'gf-play';
    play.href = `/gameflare/play/${encodeURIComponent(game.slug)}`;
    play.textContent = 'Play';
    play.setAttribute('aria-label', `Play ${game.name}`);
    body.appendChild(play);

    li.appendChild(body);
    return li;
  }

  // ── Render ───────────────────────────────────────────────────────────────
  function render() {
    const q = (searchEl?.value || '').trim().toLowerCase();
    const cat = categoryEl?.value || '';
    const dev = developerEl?.value || '';
    const sort = sortEl?.value || 'rank';

    let list = ALL;
    if (q) list = list.filter(g => g.name.toLowerCase().includes(q));
    if (cat) list = list.filter(g => g.categories.includes(cat));
    if (dev) list = list.filter(g => g.developer === dev);

    list = list.slice();
    if (sort === 'name') list.sort((a, b) => a.name.localeCompare(b.name));
    else if (sort === 'rating') list.sort((a, b) => (b.ratingPercent ?? -1) - (a.ratingPercent ?? -1) || a.rank - b.rank);
    else if (sort === 'plays') list.sort((a, b) => (b.playCount ?? -1) - (a.playCount ?? -1) || a.rank - b.rank);
    else list.sort((a, b) => a.rank - b.rank);

    if (!list.length) {
      showEmpty(
        q || cat || dev ? 'No games match those filters.' : 'No games are currently available in this catalog.',
        q || cat || dev
          ? 'Try clearing the search or choosing a different category.'
          : 'Entries appear here only after their embed has been verified as working.',
      );
      setStatus('0 games');
      return;
    }

    emptyEl.hidden = true;
    grid.replaceChildren(...list.map(card));
    setStatus(`${list.length} game${list.length === 1 ? '' : 's'}`);
  }

  // Debounced only because typing re-renders the whole grid; at the current
  // catalog size this is imperceptible either way.
  let t = 0;
  const onInput = () => { clearTimeout(t); t = setTimeout(render, 120); };

  function fillSelect(el, values, allLabel) {
    el.replaceChildren();
    const first = document.createElement('option');
    first.value = '';
    first.textContent = allLabel;
    el.appendChild(first);
    for (const v of values) {
      const o = document.createElement('option');
      o.value = v;
      o.textContent = v;
      el.appendChild(o);
    }
  }

  // ── Load ─────────────────────────────────────────────────────────────────
  (async () => {
    setStatus('Loading…');
    let data;
    try {
      const r = await fetch('/api/gameflare/games', { headers: { accept: 'application/json' } });
      data = await r.json();
      if (!r.ok || !data?.ok) throw new Error(data?.message || 'unavailable');
    } catch {
      // Public wording only. The developer-facing reason was logged server-side
      // at boot; repeating it here would leak parser detail to visitors.
      showEmpty('The game catalog is temporarily unavailable.',
        'Please try again later.');
      setStatus('');
      return;
    }

    ALL = Array.isArray(data.games) ? data.games : [];

    if (!ALL.length) {
      // Controls stay hidden. Nothing to search.
      showEmpty('No games are currently available in this catalog.',
        'Entries appear here only after their embed has been verified as working. '
        + 'Nothing in the supplied dataset has passed that check yet.');
      setStatus('0 games');
      return;
    }

    fillSelect(categoryEl, data.categories || [], 'All categories');
    const devs = [...new Set(ALL.map(g => g.developer).filter(Boolean))].sort((a, b) => a.localeCompare(b));
    if (devs.length) { fillSelect(developerEl, devs, 'All developers'); developerField.hidden = false; }

    controls.hidden = false;
    controls.addEventListener('submit', (e) => e.preventDefault());
    searchEl.addEventListener('input', onInput);
    categoryEl.addEventListener('change', render);
    developerEl.addEventListener('change', render);
    sortEl.addEventListener('change', render);
    render();
  })();
})();
