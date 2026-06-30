// public/js/infinite-scroll.js
//
// Drop-in infinite-scroll loader for any page that has:
//
//   <div id="gameGrid"></div>                  ← tiles get appended here
//   <div id="infiniteSentinel"></div>          ← IntersectionObserver target
//   <div id="infiniteStatus" hidden></div>     ← "loading…" / "end" messages
//
// Spec requirements covered:
//   - Uses IntersectionObserver (no scroll listeners, no jank).
//   - `isLoading` gate prevents overlapping requests when the user
//     spam-scrolls past the sentinel.
//   - Each <img> gets an inline onerror that swaps to /default-placeholder.svg
//     so broken thumbnails never show the browser's broken-image icon.
//   - On fetch error → stays silent (no toast spam), just stops requesting
//     until the user scrolls back near the bottom.
//
// Wire it up at the bottom of index.html (or any list page):
//   <script type="module" src="/js/infinite-scroll.js"></script>

const grid     = document.getElementById('gameGrid');
const sentinel = document.getElementById('infiniteSentinel');
const status   = document.getElementById('infiniteStatus');

if (grid && sentinel) {
  initInfiniteScroll();
}

function initInfiniteScroll() {
  const state = {
    page: 1,
    limit: 24,
    isLoading: false,   // ← the gate from spec section 5
    done: false,
    consecutiveErrors: 0
  };

  // Kick off the first page immediately so the grid isn't empty above the fold.
  loadNextPage(state);

  const io = new IntersectionObserver(async (entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      if (state.isLoading || state.done) continue;
      await loadNextPage(state);
    }
  }, {
    // Pre-fetch the next page once the sentinel is within 600px of the viewport
    // — keeps scrolling feeling instant on a fast connection.
    root: null,
    rootMargin: '600px',
    threshold: 0
  });

  io.observe(sentinel);
}

async function loadNextPage(state) {
  if (state.isLoading || state.done) return;
  state.isLoading = true;
  setStatus('Loading more games…');

  try {
    const r = await fetch(`/api/games?page=${state.page}&limit=${state.limit}`, {
      headers: { 'Accept': 'application/json' }
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const data = await r.json();
    const games = Array.isArray(data) ? data : (data.games || []);

    if (!games.length) {
      // True "end of list" if Supabase explicitly returned 0 with a real total,
      // OR if we've already loaded enough that the next page would be past total.
      state.done = true;
      setStatus('You’ve reached the end. Nice work.');
      return;
    }

    appendGames(games);
    state.page += 1;
    state.consecutiveErrors = 0;
    setStatus('');
  } catch (e) {
    // Spec: handle errors silently. We don't show a scary popup — just
    // back off. After 3 in a row, give up entirely.
    state.consecutiveErrors += 1;
    console.warn('[infinite-scroll] page load failed:', e.message);
    if (state.consecutiveErrors >= 3) {
      state.done = true;
      setStatus('Couldn’t load more right now. Try refreshing.');
    } else {
      setStatus('');
    }
  } finally {
    state.isLoading = false;
  }
}

function appendGames(games) {
  const frag = document.createDocumentFragment();
  for (const g of games) frag.appendChild(buildTile(g));
  grid.appendChild(frag);
}

function buildTile(g) {
  const a = document.createElement('a');
  a.className = 'game-tile';
  a.href = `/play/${encodeURIComponent(g.slug || g.id)}`;
  a.setAttribute('data-slug', g.slug || '');

  const safeTitle = String(g.title || 'Game').replace(/[<>&"]/g, c => (
    { '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]
  ));

  const thumb = g.thumbnail_url || g.thumbnail || '/default-placeholder.svg';

  // The onerror handler is the key piece from the spec — if a publisher's
  // CDN starts 404'ing thumbnails, the tile silently swaps to the local
  // placeholder instead of showing the browser's broken-image icon.
  // onerror=null on the swap prevents an infinite loop if the placeholder
  // itself is missing.
  a.innerHTML = `
    <div class="tile-thumb">
      <img
        loading="lazy"
        decoding="async"
        src="${escapeAttr(thumb)}"
        alt="${safeTitle}"
        onerror="this.onerror=null;this.src='/default-placeholder.svg';">
    </div>
    <span class="game-tile-label">${safeTitle}</span>
  `;
  return a;
}

function escapeAttr(s) {
  return String(s).replace(/["'<>&]/g, c => ({ '"':'&quot;', "'":'&#39;', '<':'&lt;', '>':'&gt;', '&':'&amp;' }[c]));
}

function setStatus(text) {
  if (!status) return;
  if (!text) { status.hidden = true; status.textContent = ''; return; }
  status.hidden = false;
  status.textContent = text;
}
