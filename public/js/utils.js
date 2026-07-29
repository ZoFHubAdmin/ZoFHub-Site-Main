// ZoFHub · utils.js
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export function el(tag, attrs = {}, children = []) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(n.style, v);
    else if (k === 'dataset' && typeof v === 'object') Object.assign(n.dataset, v);
    else if (k === 'html') n.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2).toLowerCase(), v);
    else n.setAttribute(k, v === true ? '' : v);
  }
  for (const c of [].concat(children)) {
    if (c == null) continue;
    n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return n;
}

export function debounce(fn, ms = 200) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

export function escapeHtml(s = '') {
  return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

// ── Thumbnail fallback (shared by catalog / category / game / search) ───────
// Builds a branded gradient + initials tile, used when a thumbnail is missing
// or its URL is dead (e.g. fabricated "Cube Surfer" entries whose GD image 403s).
export function buildFallback(ds) {
  const div = document.createElement('div');
  div.className = 'game-tile-fallback';
  const t = (ds && ds.title) || 'Game';
  let h = 0;
  for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) >>> 0;
  const palette = ['#3a2a7a','#442f8c','#33246b','#4a3596','#382874','#402d84','#2e2160','#4d38a0'];
  div.style.setProperty('--c1', palette[h % palette.length]);
  div.style.setProperty('--c2', palette[(h >> 8) % palette.length]);
  div.textContent = t.split(/\s+/).slice(0, 2).map(s => s[0] || '').join('').toUpperCase() || 'G';
  return div;
}

// CSP-safe broken-image handler. An inline `onerror=` attribute is blocked by
// our Content-Security-Policy (`script-src-attr 'none'`), so it must be wired
// via addEventListener — otherwise dead thumbnails render as a broken-image icon
// instead of falling back. Swaps the failed <img> for a branded fallback tile.
export function wireThumbFallback(img) {
  if (!img) return;
  img.addEventListener('error', function onErr() {
    this.removeEventListener('error', onErr);
    this.replaceWith(buildFallback(this.dataset));
  });
}

// Legacy global alias (in case any markup still references it inline).
if (typeof window !== 'undefined') window.buildFallback = buildFallback;

export async function fetchJson(url, opts) {
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export function toast(msg, kind = '') {
  let stack = $('#toastStack');
  if (!stack) {
    stack = el('div', { class: 'toast-stack', id: 'toastStack' });
    document.body.appendChild(stack);
  }
  const t = el('div', { class: `toast ${kind}` }, msg);
  stack.appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; t.style.transform = 'translateY(8px)'; }, 2800);
  setTimeout(() => t.remove(), 3200);
}

export function isLikelyUrl(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  if (/^https?:\/\//i.test(t)) return true;
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+([\/?#].*)?$/i.test(t)) return true;
  return false;
}

export function normalizeUrl(text) {
  const t = String(text).trim();
  if (/^https?:\/\//i.test(t)) return t;
  return `https://${t}`;
}

export function renderMarkdownLite(src = '') {
  let s = escapeHtml(src);
  s = s.replace(/```([\w-]*)\n([\s\S]*?)```/g, (_, lang, code) => `<pre><code class="lang-${lang}">${code}</code></pre>`);
  s = s.replace(/```([\s\S]*?)```/g, (_, code) => `<pre><code>${code}</code></pre>`);
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  s = s.replace(/^### (.*)$/gm, '<h3>$1</h3>');
  s = s.replace(/^## (.*)$/gm, '<h2>$1</h2>');
  s = s.replace(/^# (.*)$/gm, '<h1>$1</h1>');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
  s = s.replace(/(^|\s)\*([^*]+)\*(?=\s|$)/g, '$1<i>$2</i>');
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  s = s.replace(/^(?:- |\* )(.*)$/gm, '<li>$1</li>');
  s = s.replace(/(<li>[\s\S]*?<\/li>)/g, m => `<ul>${m}</ul>`);
  s = s.replace(/<\/ul>\s*<ul>/g, '');
  const parts = s.split(/(<pre>[\s\S]*?<\/pre>)/g);
  return parts.map(p => p.startsWith('<pre>') ? p : p.replace(/\n/g, '<br>')).join('');
}

export function formatRelative(ts) {
  const diff = (Date.now() - ts) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

// ── Modal focus trapping ────────────────────────────────────────────────────
// Every dialog on the site (community's recommend + play modals, the vibe
// finder, the panic panel) left Tab free to walk into the page BEHIND it. For a
// sighted mouse user that's invisible; for anyone navigating by keyboard the
// focus ring just disappears into content they can't see, and there's no way
// back to the dialog's own close button.
//
// trapFocus(el) keeps Tab and Shift+Tab cycling inside `el`, moves focus to the
// first sensible control on open, and restores focus to whatever was focused
// before on release. It returns a release function; call it when you close.
//
// Deliberately re-queries the focusable set on every Tab rather than caching
// it: these dialogs build their content dynamically (the play modal injects an
// iframe, the vibe finder swaps in results), so a cached list goes stale.
const FOCUSABLE = [
  'a[href]', 'button:not([disabled])', 'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])', 'textarea:not([disabled])', '[tabindex]:not([tabindex="-1"])',
].join(',');

export function trapFocus(root, { initial } = {}) {
  if (!root) return () => {};
  const previouslyFocused = document.activeElement;

  const visible = () => [...root.querySelectorAll(FOCUSABLE)]
    // offsetParent is null for anything display:none'd, which is how these
    // dialogs hide their inactive states.
    .filter(n => n.offsetParent !== null || n === document.activeElement);

  function onKeydown(e) {
    if (e.key !== 'Tab') return;
    const items = visible();
    if (!items.length) { e.preventDefault(); return; }
    const first = items[0], last = items[items.length - 1];
    // document.activeElement can be outside the dialog if focus already escaped
    // (or if the browser put it on <body>), so pull it back rather than assume.
    if (!root.contains(document.activeElement)) { e.preventDefault(); first.focus(); return; }
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }

  document.addEventListener('keydown', onKeydown, true);
  // Defer: callers typically unhide the element in the same tick, and a hidden
  // element can't take focus.
  setTimeout(() => {
    const target = (typeof initial === 'string' ? root.querySelector(initial) : initial) || visible()[0];
    try { target?.focus(); } catch {}
  }, 30);

  return function release() {
    document.removeEventListener('keydown', onKeydown, true);
    try { previouslyFocused?.focus?.(); } catch {}
  };
}
