// ZoFHub · search-suggest.js
// Header typeahead: as you type, a dropdown of likely games (thumbnail + name)
// appears directly under the search bar — instead of dumping results down the
// page. Works on every page that has the header search. ↑/↓ to move, Enter or
// click to open the game, Esc/outside-click to close. Submitting with no
// suggestion chosen falls back to the page's normal search behavior.
import { el, fetchJson, escapeHtml, debounce } from './utils.js';

const form  = document.querySelector('.header-search');
const input = form && form.querySelector('input[name="q"], #searchInput');
if (form && input) initSuggest(form, input);

function initSuggest(form, input) {
  form.classList.add('has-suggest');
  const box = el('div', { class: 'search-suggest', role: 'listbox', hidden: true });
  form.appendChild(box);

  let items = [];     // current suggestion games
  let active = -1;    // highlighted row
  let lastQ = '';
  let seq = 0;        // guards against out-of-order async responses

  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-expanded', 'false');

  const close = () => { box.hidden = true; box.innerHTML = ''; items = []; active = -1; input.setAttribute('aria-expanded', 'false'); };
  const open  = () => { if (box.children.length) { box.hidden = false; input.setAttribute('aria-expanded', 'true'); } };

  const escRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  // Rank by relevance so the most likely match sits on top.
  function rank(games, q) {
    const ql = q.toLowerCase();
    const wordStart = new RegExp('\\b' + escRe(ql));
    const score = (t) => {
      const tl = (t || '').toLowerCase();
      if (tl === ql) return 0;
      if (tl.startsWith(ql)) return 1;
      if (wordStart.test(tl)) return 2;
      return 3;
    };
    return games
      .map(g => ({ g, s: score(g.title) }))
      .sort((a, b) => a.s - b.s
        || (a.g.title || '').length - (b.g.title || '').length
        || (a.g.title || '').localeCompare(b.g.title || ''))
      .slice(0, 8)
      .map(x => x.g);
  }

  function highlight(title, q) {
    const ql = q.trim();
    const idx = ql ? title.toLowerCase().indexOf(ql.toLowerCase()) : -1;
    if (idx < 0) return escapeHtml(title);
    return escapeHtml(title.slice(0, idx))
      + '<mark>' + escapeHtml(title.slice(idx, idx + ql.length)) + '</mark>'
      + escapeHtml(title.slice(idx + ql.length));
  }

  function setActive(i) {
    active = i;
    [...box.querySelectorAll('.suggest-row')].forEach((r, idx) => {
      const on = idx === i;
      r.classList.toggle('is-active', on);
      if (on) r.scrollIntoView({ block: 'nearest' });
    });
  }

  function render(games, q) {
    box.innerHTML = '';
    items = games; active = -1;
    if (!games.length) {
      box.appendChild(el('div', { class: 'suggest-empty' }, `No games found for “${q}”`));
      box.hidden = false;
      return;
    }
    games.forEach((g, i) => {
      const slug  = g.slug || g.id || '';
      const thumb = g.thumbnail || g.thumbnail_url || '/default-placeholder.svg';
      const a = el('a', {
        class: 'suggest-row', role: 'option',
        href: `/play/${encodeURIComponent(slug)}`, 'data-i': String(i)
      });
      a.innerHTML =
        `<span class="suggest-thumb"><img loading="lazy" decoding="async" src="${escapeHtml(thumb)}" alt=""></span>` +
        `<span class="suggest-title">${highlight(g.title || 'Game', q)}</span>` +
        (g.category ? `<span class="suggest-cat">${escapeHtml(g.category)}</span>` : '');
      // CSP-safe broken-image fallback (inline onerror is blocked by our CSP).
      const sImg = a.querySelector('img');
      if (sImg) sImg.addEventListener('error', () => { sImg.src = '/default-placeholder.svg'; }, { once: true });
      a.addEventListener('mouseenter', () => setActive(i));
      box.appendChild(a);
    });
    // Footer row → open the FULL results gallery (homepage filtered by ?q=).
    // This is the "hit Enter → gallery of games to pick from" path.
    const all = el('a', { class: 'suggest-all', href: `/?q=${encodeURIComponent(q)}` });
    all.innerHTML = `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg><span>See all results for “${escapeHtml(q)}”</span><span class="suggest-all-arrow" aria-hidden="true">↵</span>`;
    box.appendChild(all);
    open();
  }

  const run = debounce(async () => {
    const q = input.value.trim();
    if (q.length < 1) { close(); lastQ = ''; return; }
    if (q === lastQ) return;
    lastQ = q;
    const my = ++seq;
    try {
      const data = await fetchJson(`/api/games?q=${encodeURIComponent(q)}&limit=24`);
      if (my !== seq) return;            // a newer keystroke already superseded this
      render(rank(data.games || [], q), q);
    } catch { /* network hiccup — leave the box as-is */ }
  }, 110);

  input.addEventListener('input', run);
  input.addEventListener('focus', () => { if (items.length) open(); });

  input.addEventListener('keydown', (e) => {
    if (box.hidden || !items.length) return;   // let the form submit normally
    if (e.key === 'ArrowDown')      { e.preventDefault(); setActive((active + 1) % items.length); }
    else if (e.key === 'ArrowUp')   { e.preventDefault(); setActive((active - 1 + items.length) % items.length); }
    else if (e.key === 'Enter')     {
      // A highlighted suggestion (arrowed/hovered to) → open THAT game directly.
      if (active >= 0 && items[active]) {
        e.preventDefault();
        location.href = `/play/${encodeURIComponent(items[active].slug || items[active].id || '')}`;
      } else {
        // Plain Enter with nothing highlighted → the full results GALLERY
        // (homepage filtered by ?q=), so the user can browse + pick.
        e.preventDefault();
        location.href = `/?q=${encodeURIComponent(input.value.trim())}`;
      }
    } else if (e.key === 'Escape')  { close(); }
  });

  document.addEventListener('click', (e) => { if (!form.contains(e.target)) close(); });
}
