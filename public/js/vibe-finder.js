// ZoFHub · vibe-finder.js — "describe your mood, get your game."
// ---------------------------------------------------------------------------
// Type how you feel ("something chill", "fast and competitive", "a puzzle to
// wake my brain up") and get real games back. ALL the heavy lifting is done by
// the server's /api/vibe endpoint, which maps your mood → game genres (a mood
// map + Pollinations AI) and searches the FULL ~14k-game catalog. The old
// version searched only 400 games client-side and matched mood words against
// game TITLES (which never contain words like "chill"), so it usually found
// nothing and could hang on "Reading your vibe…". This version is server-backed,
// fast, and has a hard request timeout so it can never get stuck.
// ---------------------------------------------------------------------------
import { $, el } from './utils.js';

// Quick one-tap moods (sent to the same endpoint as typed text). A mix of
// feelings and activity-moods so "how you feel" is obvious at a glance.
const VIBES = ['Happy', 'Sad', 'Angry', 'Chill', 'Competitive', 'Brainy', 'Silly', 'Romantic', 'Scary', 'Cars'];

// A recognizable "sparkles" mark (lucide-style) — the Vibe Finder's icon.
const SPARK = `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.94 14.06A2 2 0 0 0 8.5 12.6l-5.4-1.4a.5.5 0 0 1 0-.96l5.4-1.4A2 2 0 0 0 9.94 7.4l1.4-5.4a.5.5 0 0 1 .96 0l1.4 5.4a2 2 0 0 0 1.44 1.44l5.4 1.4a.5.5 0 0 1 0 .96l-5.4 1.4a2 2 0 0 0-1.44 1.44l-1.4 5.4a.5.5 0 0 1-.96 0z"/><path d="M19 3v3M20.5 4.5h-3M5 17v2M6 18H4"/></svg>`;

let modal, lastQuery = '', inFlight = null;

function injectStyles() {
  if (document.getElementById('vibe-css')) return;
  const s = document.createElement('style');
  s.id = 'vibe-css';
  s.textContent = `
  /* A clean accent chip docked on the right INSIDE the search bar. Fixed height,
     vertically centered, with a thin divider so it reads as a distinct action.
     min-width:0 on the input lets it shrink instead of shoving the chip out of
     the pill (the old version overflowed and looked broken on narrow screens). */
  .header-search input,#searchForm input{min-width:0}
  .header-search:has(.vibe-trigger){padding-right:5px}     /* breathing room at the rounded edge */
  .vibe-trigger{display:inline-flex;align-items:center;justify-content:center;gap:6px;
    flex:0 0 auto;align-self:center;cursor:pointer;border:0;position:relative;
    height:30px;padding:0 14px;margin-left:12px;
    background:linear-gradient(135deg,#7c4dff,#ff4d8d);color:#fff;
    border-radius:999px;font-size:12.5px;font-weight:700;font-family:inherit;line-height:1;letter-spacing:.01em;
    white-space:nowrap;box-shadow:0 2px 10px rgba(124,77,255,.45),inset 0 1px 0 rgba(255,255,255,.22);
    transition:filter .15s ease,box-shadow .15s ease,transform .1s ease}
  /* thin divider separating the chip from the input */
  .vibe-trigger::before{content:'';position:absolute;left:-7px;top:50%;transform:translateY(-50%);
    width:1px;height:18px;background:rgba(255,255,255,.16)}
  .vibe-trigger:hover{filter:brightness(1.08);box-shadow:0 5px 16px rgba(124,77,255,.6),inset 0 1px 0 rgba(255,255,255,.3)}
  .vibe-trigger:active{transform:translateY(1px)}
  .vibe-trigger:focus-visible{outline:2px solid #ffe000;outline-offset:2px}
  .vibe-trigger svg{width:14px;height:14px;flex:0 0 14px;color:#ffe000;
    filter:drop-shadow(0 0 3px rgba(255,224,0,.65));animation:vibeSparkle 2.6s ease-in-out infinite}
  @keyframes vibeSparkle{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.82;transform:scale(1.14)}}
  /* On small screens collapse to a round icon-only button so it never crowds the input. */
  @media (max-width:760px){.vibe-trigger span{display:none}.vibe-trigger{padding:0;width:30px;gap:0;margin-left:8px}
    .vibe-trigger::before{display:none}}
  .vibe-back{position:fixed;inset:0;z-index:10001;background:rgba(4,7,18,.74);backdrop-filter:blur(6px);
    display:flex;align-items:flex-start;justify-content:center;padding:9vh 16px 16px;animation:vibeIn .18s ease both}
  @keyframes vibeIn{from{opacity:0}to{opacity:1}}
  .vibe-card{width:min(680px,100%);background:#0e2247;border:1px solid rgba(125,170,255,.24);border-radius:18px;
    box-shadow:0 30px 80px rgba(0,0,0,.6);padding:20px;font-family:Inter,system-ui,sans-serif;max-height:82vh;display:flex;flex-direction:column}
  .vibe-head{display:flex;align-items:center;gap:9px;margin:0 0 4px}
  .vibe-head h2{margin:0;font-size:19px;color:#eaf1ff;display:flex;align-items:center;gap:8px}
  .vibe-head h2 svg{color:#ffe000}
  .vibe-card p.sub{margin:0 0 14px;font-size:12.5px;color:#a7bce0}
  .vibe-close{margin-left:auto;cursor:pointer;background:transparent;border:0;color:#8aa2cf;font-size:24px;line-height:1}
  .vibe-form{display:flex;gap:8px}
  .vibe-form input{flex:1;padding:12px 14px;border-radius:12px;background:#0a1a38;border:1px solid rgba(125,170,255,.24);color:#eaf1ff;font-size:14px;outline:0}
  .vibe-form input:focus{border-color:rgba(255,224,0,.55)}
  .vibe-form button{cursor:pointer;border:0;border-radius:12px;padding:0 18px;font-size:14px;font-weight:800;color:#07142b;background:linear-gradient(135deg,#ffe000,#ffb800)}
  .vibe-form button:disabled{opacity:.6;cursor:default}
  .vibe-chips{display:flex;flex-wrap:wrap;gap:7px;margin:12px 0 2px}
  .vibe-chips button{cursor:pointer;border:1px solid rgba(125,170,255,.26);background:transparent;color:#cbd9f4;border-radius:999px;padding:6px 12px;font-size:12px;font-weight:600}
  .vibe-chips button:hover{border-color:rgba(255,224,0,.5);color:#fff}
  .vibe-kw{font-size:11.5px;color:#7f96c2;margin:10px 0 0;min-height:14px}
  .vibe-kw b{color:#a7bce0;font-weight:600}
  .vibe-results{margin-top:10px;overflow:auto;display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:10px}
  .vibe-tile{display:block;text-decoration:none;border-radius:12px;overflow:hidden;background:#0a1a38;border:1px solid rgba(125,170,255,.16);transition:.12s}
  .vibe-tile:hover{border-color:rgba(255,224,0,.5);transform:translateY(-2px)}
  .vibe-tile .vt-img{width:100%;aspect-ratio:4/3;object-fit:cover;display:block;background:linear-gradient(135deg,#1a2f5c,#0f1f44)}
  .vibe-tile .vt-fallback{width:100%;aspect-ratio:4/3;display:grid;place-items:center;font-weight:800;font-size:20px;color:#fff;background:linear-gradient(135deg,#7c4dff,#ff4d8d)}
  .vibe-tile span{display:block;padding:7px 8px;font-size:11.5px;color:#dbe6ff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .vibe-status{margin-top:16px;font-size:13px;color:#a7bce0;text-align:center;padding:12px}
  .vibe-spin{display:inline-block;width:16px;height:16px;border:2px solid rgba(255,255,255,.18);border-top-color:#ffe000;border-radius:50%;animation:vibeSpin .8s linear infinite;vertical-align:-3px;margin-right:8px}
  @keyframes vibeSpin{to{transform:rotate(360deg)}}
  @media (max-width:560px){.vibe-back{padding:5vh 10px 10px}}`;
  document.head.appendChild(s);
}

function tileFor(g) {
  const a = el('a', { class: 'vibe-tile', href: `/play/${g.slug}` });
  const safe = String(g.title || '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  if (g.thumbnail) {
    a.innerHTML = `<img class="vt-img" loading="lazy" src="${g.thumbnail}" alt="${safe}" onerror="this.style.display='none'"/><span>${safe}</span>`;
  } else {
    const initials = String(g.title || '?').split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase();
    a.innerHTML = `<div class="vt-fallback">${initials}</div><span>${safe}</span>`;
  }
  return a;
}

function setStatus(html) {
  const s = $('.vibe-status', modal);
  if (s) s.innerHTML = html || '';
}
function setKw(keywords) {
  const k = $('.vibe-kw', modal);
  if (!k) return;
  k.innerHTML = keywords && keywords.length ? `Matched genres: <b>${keywords.slice(0, 8).join(', ')}</b>` : '';
}

async function runSearch(text) {
  const q = (text || '').trim();
  if (!q) return;
  lastQuery = q;
  if (inFlight) { try { inFlight.abort(); } catch {} }
  const ctrl = new AbortController();
  inFlight = ctrl;
  // Hard cap so it can never hang on "finding…". 15s is generous enough to ride
  // out a sleeping/cold Render dyno (which can take 10s+ to wake) — the server
  // itself answers in well under 3s once awake.
  const timer = setTimeout(() => ctrl.abort(), 15000);
  const btn = $('.vibe-form button', modal);
  if (btn) btn.disabled = true;
  $('.vibe-results', modal).innerHTML = '';
  setKw([]);
  setStatus(`<span class="vibe-spin"></span>Finding games that match your vibe…`);
  try {
    const r = await fetch(`/api/vibe?q=${encodeURIComponent(q)}`, { signal: ctrl.signal });
    const d = await r.json();
    clearTimeout(timer);
    if (q !== lastQuery) return;                         // a newer search superseded this one
    const games = d.games || [];
    setKw(d.keywords);
    if (!games.length) { setStatus('No matches — try a different vibe or tap a quick mood above.'); return; }
    setStatus('');
    const wrap = $('.vibe-results', modal);
    wrap.innerHTML = '';
    games.forEach(g => wrap.appendChild(tileFor(g)));
  } catch (e) {
    clearTimeout(timer);
    if (q !== lastQuery) return;
    setStatus(ctrl.signal.aborted
      ? 'That took too long — check your connection and try again.'
      : 'Something went wrong finding games. Try again.');
  } finally {
    if (btn) btn.disabled = false;
    if (inFlight === ctrl) inFlight = null;
  }
}

function buildModal() {
  if (modal) return modal;
  injectStyles();
  modal = el('div', { class: 'vibe-back', id: 'vibeFinder', hidden: true });
  modal.innerHTML = `
    <div class="vibe-card" role="dialog" aria-label="Vibe Finder">
      <div class="vibe-head">
        <h2>${SPARK} Vibe Finder</h2>
        <button class="vibe-close" aria-label="Close">&times;</button>
      </div>
      <p class="sub">Tell me how you feel and I'll pick games from all ${'14,000+'} on ZoFHub. Powered by ZoFHub AI.</p>
      <form class="vibe-form">
        <input type="text" placeholder="e.g. something chill to relax after school…" aria-label="Describe your vibe" autocomplete="off" />
        <button type="submit">Find</button>
      </form>
      <div class="vibe-chips">${VIBES.map(v => `<button type="button" data-vibe="${v}">${v}</button>`).join('')}</div>
      <div class="vibe-kw"></div>
      <div class="vibe-status">Type a vibe above, or tap a quick mood.</div>
      <div class="vibe-results"></div>
    </div>`;
  document.body.appendChild(modal);
  modal.addEventListener('click', (e) => { if (e.target === modal || e.target.closest('.vibe-close')) close(); });
  $('.vibe-form', modal).addEventListener('submit', (e) => { e.preventDefault(); runSearch($('.vibe-form input', modal).value); });
  modal.querySelectorAll('.vibe-chips button').forEach(b => b.addEventListener('click', () => {
    const input = $('.vibe-form input', modal);
    input.value = b.dataset.vibe;
    runSearch(b.dataset.vibe);
  }));
  return modal;
}

function open() { buildModal(); modal.hidden = false; setTimeout(() => $('.vibe-form input', modal)?.focus(), 30); }
function close() { if (modal) modal.hidden = true; }

function mountTrigger() {
  if ($('.vibe-trigger')) return;
  const form = $('#searchForm') || document.querySelector('.header-search');
  if (!form) return;
  // Inject the styles NOW (at mount), not lazily on first click. Previously the
  // CSS only loaded inside buildModal()→open(), so until you clicked it the
  // button rendered as a raw unstyled <button> — that's why it "looked no good".
  injectStyles();
  const btn = el('button', { class: 'vibe-trigger', type: 'button', title: 'Vibe Finder — describe your mood, get a game (Ctrl+K)' });
  btn.innerHTML = `${SPARK}<span>Vibe Finder</span>`;
  btn.addEventListener('click', open);
  // Place it as a trailing pill INSIDE the search bar (not crammed between the
  // bar and the nav, which looked broken on smaller screens).
  form.appendChild(btn);
}

// Ctrl/Cmd+K opens it from anywhere.
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.code === 'KeyK')) {
    e.preventDefault();
    modal && !modal.hidden ? close() : open();
  } else if (e.key === 'Escape' && modal && !modal.hidden) {
    close();
  }
});

if (document.readyState !== 'loading') mountTrigger();
else document.addEventListener('DOMContentLoaded', mountTrigger);
