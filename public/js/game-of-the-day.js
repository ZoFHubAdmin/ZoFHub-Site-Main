// ZoFHub · game-of-the-day.js — one featured game, the same for everyone, all day.
// ---------------------------------------------------------------------------
// Fetches /api/game-of-the-day (a deterministic daily pick) and renders a hero
// banner at the top of the homepage. Self-contained: injects its own CSS so it
// needs no stylesheet change, and stays hidden until it actually has a game
// (so a slow/empty API never leaves an empty box).
// ---------------------------------------------------------------------------
import { $ } from './utils.js';

const CSS = `
.gotd-row{margin:0 0 14px}
.gotd{position:relative;display:grid;grid-template-columns:minmax(0,320px) 1fr;gap:0;
  border-radius:20px;overflow:hidden;text-decoration:none;isolation:isolate;
  background:linear-gradient(135deg,#2c2065 0%,#241a55 60%,#1d1443 100%);
  border:1px solid rgba(255,255,255,.28);box-shadow:0 20px 55px rgba(0,0,0,.5);
  transition:transform .16s ease,box-shadow .16s ease,border-color .16s ease}
.gotd:hover{transform:translateY(-3px);border-color:rgba(255,212,38,.5);box-shadow:0 26px 66px rgba(0,0,0,.62)}
.gotd:focus-visible{outline:2px solid #ffd426;outline-offset:3px}
.gotd-media{position:relative;min-height:190px;background:linear-gradient(135deg,#3a2a7a,#241a55)}
.gotd-media img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;display:block}
.gotd-media::after{content:'';position:absolute;inset:0;
  background:linear-gradient(90deg,rgba(23,16,52,0) 55%,rgba(23,16,52,.9) 100%)}
.gotd-fallback{position:absolute;inset:0;display:grid;place-items:center;
  font-family:'Lilita One',Inter,sans-serif;font-size:52px;color:rgba(255,255,255,.92)}
.gotd-body{display:flex;flex-direction:column;justify-content:center;gap:9px;padding:22px 26px}
.gotd-badge{display:inline-flex;align-items:center;gap:7px;align-self:flex-start;
  padding:5px 12px;border-radius:999px;font-size:11.5px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;
  color:#1a1030;background:linear-gradient(135deg,#ffd426,#ffb800);box-shadow:0 3px 12px rgba(255,184,0,.4)}
.gotd-badge svg{width:13px;height:13px}
.gotd-title{margin:0;font-family:'Lilita One',Inter,sans-serif;font-weight:400;
  font-size:clamp(22px,3.2vw,34px);line-height:1.05;color:#f4f0ff;
  overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
.gotd-meta{display:flex;align-items:center;gap:10px;flex-wrap:wrap;font-size:12.5px;color:#b7c3e8}
.gotd-cat{padding:3px 10px;border-radius:8px;background:rgba(0,0,0,.22);border:1px solid rgba(255,255,255,.32);
  color:#d9ccff;font-weight:700;text-transform:capitalize}
.gotd-play{display:inline-flex;align-items:center;gap:8px;align-self:flex-start;margin-top:4px;
  padding:11px 22px;border-radius:12px;font-size:14px;font-weight:800;color:#241a00;
  background:#ffd426;box-shadow:0 3px 10px rgba(0,0,0,.45),inset 0 1px 0 rgba(255,255,255,.4)}
.gotd-play svg{width:16px;height:16px}
.gotd:hover .gotd-play{filter:brightness(1.06)}
@media (max-width:720px){
  .gotd{grid-template-columns:1fr}
  .gotd-media{min-height:150px}
  .gotd-media::after{background:linear-gradient(180deg,rgba(23,16,52,0) 40%,rgba(23,16,52,.92) 100%)}
  .gotd-body{padding:16px 18px 20px}
}`;

function injectCss() {
  if (document.getElementById('gotd-css')) return;
  const s = document.createElement('style');
  s.id = 'gotd-css';
  s.textContent = CSS;
  document.head.appendChild(s);
}

const esc = (s) => String(s || '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const STAR = `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><polygon points="12 2 15 9 22 10 17 15 18 22 12 19 6 22 7 15 2 10 9 9 12 2"/></svg>`;
const PLAY = `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>`;

async function init() {
  const row = $('#gotdRow');
  const hero = $('#gotdHero');
  if (!row || !hero) return;
  injectCss();
  let data;
  try {
    const r = await fetch('/api/game-of-the-day');
    data = await r.json();
  } catch { return; }                       // network error → leave the row hidden
  const g = data && data.game;
  if (!g || !g.slug) return;

  const title = esc(g.title);
  const initials = String(g.title || '?').split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase();
  // No inline onerror="…" here: our CSP sets script-src-attr 'none', so inline
  // event handlers never execute. The failure handler is wired below with
  // addEventListener instead.
  const media = g.thumbnail
    ? `<img src="${esc(g.thumbnail)}" alt="${title}" loading="eager"/>`
    : `<div class="gotd-fallback">${esc(initials)}</div>`;

  hero.href = `/play/${encodeURIComponent(g.slug)}`;
  hero.innerHTML = `
    <div class="gotd-media">${media}<div class="gotd-fallback" style="opacity:${g.thumbnail ? 0 : 1};z-index:-1">${esc(initials)}</div></div>
    <div class="gotd-body">
      <span class="gotd-badge">${STAR} Game of the Day</span>
      <h2 class="gotd-title">${title}</h2>
      <div class="gotd-meta"><span class="gotd-cat">${esc(g.category_label || g.category || 'Arcade')}</span></div>
      <span class="gotd-play">${PLAY} Play now</span>
    </div>`;

  // If the hero image fails, drop it AND reveal the initials tile sitting behind
  // it. Simply removing the <img> was not enough: that fallback is rendered at
  // opacity:0/z-index:-1 whenever a thumbnail exists, so it stayed invisible and
  // the hero showed an empty box.
  const heroImg = hero.querySelector('.gotd-media img');
  if (heroImg) {
    heroImg.addEventListener('error', () => {
      const fb = hero.querySelector('.gotd-media .gotd-fallback');
      if (fb) { fb.style.opacity = '1'; fb.style.zIndex = 'auto'; }
      heroImg.remove();
    }, { once: true });
  }
  row.hidden = false;
}

if (document.readyState !== 'loading') init();
else document.addEventListener('DOMContentLoaded', init);
