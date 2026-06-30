// ZoFHub · thumbnails.js — themed SVG art per game.
// Every card gets a recognizable image, not a letter on a gradient.

const defs = (g1, g2) => `
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${g1}"/><stop offset="1" stop-color="${g2}"/>
    </linearGradient>
    <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${g1}"/><stop offset="1" stop-color="${g2}"/>
    </linearGradient>
  </defs>`;

const ART = {
  'subway-surfers': (t) => `
    ${defs('#ff8a3d', '#c4310a')}
    <rect width="400" height="300" fill="url(#bg)"/>
    <path d="M0 200 L160 130 L240 130 L400 200 Z" fill="#1a1004" opacity=".55"/>
    <path d="M70 300 L185 130 L215 130 L330 300 Z" fill="#2a160a" opacity=".75"/>
    <g stroke="#fff7e6" stroke-width="4" stroke-linecap="round">
      <line x1="100" y1="280" x2="195" y2="160"/>
      <line x1="200" y1="160" x2="200" y2="280"/>
      <line x1="300" y1="280" x2="205" y2="160"/>
    </g>
    <rect x="180" y="210" width="40" height="55" rx="6" fill="#22d3ee"/>
    <circle cx="200" cy="200" r="10" fill="#ffd28a"/>
    <rect x="0" y="0" width="400" height="300" fill="url(#bg)" opacity="0"/>
    <text x="20" y="278" fill="#fff" font-family="Inter,Arial" font-weight="800" font-size="26">${t}</text>`,

  'slope': (t) => `
    ${defs('#22d3ee', '#0e6175')}
    <rect width="400" height="300" fill="url(#bg)"/>
    <path d="M-10 240 Q120 200 220 230 T410 280 L410 310 L-10 310 Z" fill="#0a1f29" opacity=".7"/>
    <path d="M-10 90 L410 240 L410 310 L-10 310 Z" fill="#0f3744" opacity=".7"/>
    <g stroke="#ff4d8d" stroke-width="3" opacity=".55">
      <line x1="40"  y1="270" x2="60"  y2="120"/>
      <line x1="140" y1="290" x2="160" y2="140"/>
      <line x1="240" y1="290" x2="260" y2="170"/>
      <line x1="340" y1="295" x2="360" y2="200"/>
    </g>
    <circle cx="170" cy="155" r="22" fill="#ff4d8d"/>
    <circle cx="164" cy="148" r="6" fill="#ffd6e4"/>
    <text x="20" y="278" fill="#fff" font-family="Inter,Arial" font-weight="800" font-size="26">${t}</text>`,

  'run-3': (t) => `
    ${defs('#a855f7', '#4a1d80')}
    <rect width="400" height="300" fill="url(#bg)"/>
    <g opacity=".7">
      <polygon points="60,40 340,40 380,260 20,260" fill="#1f0d40"/>
      <polygon points="100,80 300,80 330,220 70,220" fill="#341a66"/>
      <polygon points="140,120 260,120 280,180 120,180" fill="#5128a8"/>
    </g>
    <rect x="186" y="160" width="28" height="38" rx="4" fill="#ffe1f0"/>
    <circle cx="200" cy="150" r="11" fill="#ffd1e0"/>
    <text x="20" y="278" fill="#fff" font-family="Inter,Arial" font-weight="800" font-size="26">${t}</text>`,

  'geometry-dash': (t) => `
    ${defs('#facc15', '#a16207')}
    <rect width="400" height="300" fill="url(#bg)"/>
    <g stroke="#fff" stroke-width="2" opacity=".25">
      <line x1="0" y1="220" x2="400" y2="220"/><line x1="0" y1="245" x2="400" y2="245"/>
      <line x1="0" y1="270" x2="400" y2="270"/>
    </g>
    <g fill="#0a0a0a">
      <polygon points="60,250 80,210 100,250"/>
      <polygon points="120,250 140,210 160,250"/>
      <polygon points="270,250 290,210 310,250"/>
    </g>
    <rect x="180" y="170" width="50" height="50" rx="4" fill="#0a0a0a" transform="rotate(15 205 195)"/>
    <rect x="190" y="180" width="30" height="30" rx="3" fill="#facc15" transform="rotate(15 205 195)"/>
    <text x="20" y="278" fill="#0a0a0a" font-family="Inter,Arial" font-weight="800" font-size="26">${t}</text>`,

  'snow-rider': (t) => `
    ${defs('#60a5fa', '#1e3a8a')}
    <rect width="400" height="300" fill="url(#bg)"/>
    <circle cx="60"  cy="60"  r="3" fill="#fff" opacity=".8"/>
    <circle cx="320" cy="45"  r="2" fill="#fff" opacity=".6"/>
    <circle cx="200" cy="90"  r="3" fill="#fff" opacity=".9"/>
    <circle cx="120" cy="120" r="2" fill="#fff" opacity=".7"/>
    <circle cx="280" cy="150" r="2" fill="#fff" opacity=".8"/>
    <path d="M-10 230 Q200 130 410 250 L410 310 L-10 310 Z" fill="#fff"/>
    <g fill="#0a3a5c">
      <polygon points="80,260 100,200 120,260"/>
      <polygon points="290,250 310,190 330,250"/>
    </g>
    <rect x="180" y="210" width="40" height="14" rx="3" fill="#ef4444"/>
    <circle cx="200" cy="200" r="9" fill="#fff"/>
    <text x="20" y="278" fill="#0a3a5c" font-family="Inter,Arial" font-weight="800" font-size="26">${t}</text>`,

  'hextris': (t) => `
    ${defs('#f43f5e', '#7e0e2b')}
    <rect width="400" height="300" fill="url(#bg)"/>
    <g transform="translate(200 150)">
      <polygon points="0,-60 52,-30 52,30 0,60 -52,30 -52,-30" fill="none" stroke="#fff" stroke-width="2" opacity=".4"/>
      <polygon points="0,-90 78,-45 78,45 0,90 -78,45 -78,-45" fill="none" stroke="#fff" stroke-width="2" opacity=".25"/>
      <polygon points="-30,-50 -10,-50 -10,-30 -30,-30" fill="#22d3ee"/>
      <polygon points="10,-50 30,-50 30,-30 10,-30" fill="#facc15"/>
      <polygon points="30,0 50,0 50,20 30,20" fill="#10b981"/>
      <polygon points="-10,30 10,30 10,50 -10,50" fill="#a855f7"/>
      <polygon points="-50,0 -30,0 -30,20 -50,20" fill="#fb7185"/>
    </g>
    <text x="20" y="278" fill="#fff" font-family="Inter,Arial" font-weight="800" font-size="26">${t}</text>`,

  'xquest': (t) => `
    ${defs('#10b981', '#064e3b')}
    <rect width="400" height="300" fill="url(#bg)"/>
    <g fill="#fff" opacity=".7">
      <circle cx="60" cy="80" r="2"/><circle cx="120" cy="50" r="1.5"/><circle cx="220" cy="90" r="2"/>
      <circle cx="280" cy="40" r="1.5"/><circle cx="340" cy="100" r="2"/><circle cx="80" cy="180" r="1.5"/>
      <circle cx="200" cy="170" r="2"/><circle cx="320" cy="180" r="1.5"/>
    </g>
    <g transform="translate(200 150)">
      <polygon points="0,-20 20,0 0,20 -20,0" fill="#facc15"/>
      <polygon points="0,-30 30,0 0,30 -30,0" fill="none" stroke="#facc15" stroke-width="1.5" opacity=".4"/>
    </g>
    <text x="20" y="278" fill="#fff" font-family="Inter,Arial" font-weight="800" font-size="26">${t}</text>`,

  'agar': (t) => `
    ${defs('#34d399', '#065f46')}
    <rect width="400" height="300" fill="url(#bg)"/>
    <circle cx="120" cy="140" r="60" fill="#f43f5e" opacity=".95"/>
    <circle cx="106" cy="124" r="14" fill="#fff" opacity=".4"/>
    <circle cx="280" cy="190" r="32" fill="#22d3ee" opacity=".85"/>
    <circle cx="320" cy="100" r="18" fill="#facc15" opacity=".85"/>
    <circle cx="80"  cy="220" r="12" fill="#a855f7" opacity=".85"/>
    <circle cx="220" cy="80"  r="14" fill="#fb923c" opacity=".85"/>
    <text x="20" y="278" fill="#fff" font-family="Inter,Arial" font-weight="800" font-size="26">${t}</text>`,

  'endless-runner': (t) => `
    ${defs('#7c3aed', '#3b0764')}
    <rect width="400" height="300" fill="url(#bg)"/>
    <g stroke="#fff" stroke-width="2" opacity=".4">
      <path d="M0 230 L400 230"/>
      <path d="M60 230 L80 230"/><path d="M120 230 L140 230"/><path d="M180 230 L200 230"/>
      <path d="M240 230 L260 230"/><path d="M300 230 L320 230"/>
    </g>
    <g transform="translate(140 170)">
      <rect width="18" height="34" rx="3" fill="#facc15"/>
      <circle cx="9" cy="-6" r="8" fill="#ffd28a"/>
      <line x1="0"  y1="20" x2="-10" y2="34" stroke="#facc15" stroke-width="4" stroke-linecap="round"/>
      <line x1="18" y1="20" x2="28"  y2="14" stroke="#facc15" stroke-width="4" stroke-linecap="round"/>
    </g>
    <text x="20" y="278" fill="#fff" font-family="Inter,Arial" font-weight="800" font-size="26">${t}</text>`,

  'endless-dash': (t) => `
    ${defs('#fb923c', '#9a3412')}
    <rect width="400" height="300" fill="url(#bg)"/>
    <g stroke="#fff" stroke-width="3" stroke-dasharray="14 10" opacity=".5">
      <line x1="0" y1="210" x2="400" y2="210"/>
      <line x1="0" y1="240" x2="400" y2="240"/>
    </g>
    <polygon points="180,170 220,170 230,210 170,210" fill="#fff"/>
    <circle cx="200" cy="180" r="8" fill="#facc15"/>
    <text x="20" y="278" fill="#fff" font-family="Inter,Arial" font-weight="800" font-size="26">${t}</text>`,

  'astray': (t) => `
    ${defs('#06b6d4', '#155e75')}
    <rect width="400" height="300" fill="url(#bg)"/>
    <g stroke="#fff" stroke-width="2" fill="none" opacity=".65">
      <path d="M100 90 L300 90"/><path d="M100 90 L100 210"/>
      <path d="M150 130 L250 130"/><path d="M150 130 L150 170"/>
      <path d="M250 130 L250 170"/><path d="M150 170 L210 170"/>
      <path d="M210 170 L210 210"/><path d="M100 210 L300 210"/>
      <path d="M300 90 L300 210"/>
    </g>
    <circle cx="120" cy="110" r="6" fill="#facc15"/>
    <text x="20" y="278" fill="#fff" font-family="Inter,Arial" font-weight="800" font-size="26">${t}</text>`,

  'pixeldash': (t) => `
    ${defs('#ef4444', '#7f1d1d')}
    <rect width="400" height="300" fill="url(#bg)"/>
    <g shape-rendering="crispEdges" fill="#0a0a0a">
      <rect x="180" y="100" width="20" height="20"/>
      <rect x="200" y="100" width="20" height="20"/>
      <rect x="160" y="120" width="20" height="20"/>
      <rect x="180" y="120" width="20" height="20"/>
      <rect x="200" y="120" width="20" height="20"/>
      <rect x="220" y="120" width="20" height="20"/>
    </g>
    <g fill="#facc15" shape-rendering="crispEdges">
      <rect x="60"  y="240" width="16" height="16"/>
      <rect x="100" y="240" width="16" height="16"/>
      <rect x="140" y="240" width="16" height="16"/>
      <rect x="260" y="240" width="16" height="16"/>
      <rect x="300" y="240" width="16" height="16"/>
      <rect x="340" y="240" width="16" height="16"/>
    </g>
    <text x="20" y="278" fill="#fff" font-family="Inter,Arial" font-weight="800" font-size="26">${t}</text>`,

  '2048': (t) => `
    ${defs('#f59e0b', '#92400e')}
    <rect width="400" height="300" fill="url(#bg)"/>
    <g transform="translate(85 35)">
      <rect width="230" height="230" rx="12" fill="#1a1004" opacity=".4"/>
      <g font-family="Inter,Arial" font-weight="800" text-anchor="middle">
        <rect x="10"  y="10"  width="45" height="45" rx="6" fill="#fbbf24"/>
        <text x="32"  y="40" font-size="18" fill="#1a1004">2</text>
        <rect x="65"  y="10"  width="45" height="45" rx="6" fill="#f59e0b"/>
        <text x="87"  y="40" font-size="18" fill="#fff">4</text>
        <rect x="120" y="10"  width="45" height="45" rx="6" fill="#ea580c"/>
        <text x="142" y="40" font-size="18" fill="#fff">8</text>
        <rect x="175" y="10"  width="45" height="45" rx="6" fill="#dc2626"/>
        <text x="197" y="40" font-size="18" fill="#fff">16</text>
        <rect x="10"  y="65"  width="100" height="55" rx="8" fill="#7c3aed"/>
        <text x="60"  y="100" font-size="20" fill="#fff">128</text>
        <rect x="120" y="65"  width="100" height="55" rx="8" fill="#5b21b6"/>
        <text x="170" y="100" font-size="20" fill="#fff">512</text>
        <rect x="10"  y="130" width="210" height="80" rx="10" fill="#fbbf24"/>
        <text x="115" y="180" font-size="44" fill="#1a1004">2048</text>
      </g>
    </g>
    <text x="20" y="290" fill="#fff" font-family="Inter,Arial" font-weight="800" font-size="20">${t}</text>`,

  'portal': (t) => `
    ${defs('#a78bfa', '#4c1d95')}
    <rect width="400" height="300" fill="url(#bg)"/>
    <g transform="translate(200 150)">
      <ellipse cx="0" cy="0" rx="100" ry="70" fill="none" stroke="#fff" stroke-width="3" opacity=".5"/>
      <ellipse cx="0" cy="0" rx="70"  ry="48" fill="none" stroke="#fff" stroke-width="3" opacity=".7"/>
      <ellipse cx="0" cy="0" rx="40"  ry="28" fill="#fff" opacity=".15"/>
      <circle cx="0" cy="0" r="12" fill="#fff"/>
    </g>
    <text x="20" y="278" fill="#fff" font-family="Inter,Arial" font-weight="800" font-size="26">${t}</text>`,

  'directory': (t) => `
    ${defs('#22c55e', '#14532d')}
    <rect width="400" height="300" fill="url(#bg)"/>
    <g transform="translate(50 50)">
      ${[0,1,2,3].map(c => [0,1,2].map(r => `<rect x="${c*82}" y="${r*60}" width="62" height="42" rx="6" fill="rgba(255,255,255,${.15+r*.05})"/>`).join('')).join('')}
    </g>
    <text x="20" y="278" fill="#fff" font-family="Inter,Arial" font-weight="800" font-size="26">${t}</text>`,

  'open-arcade': (t) => `
    ${defs('#f472b6', '#831843')}
    <rect width="400" height="300" fill="url(#bg)"/>
    <g transform="translate(200 150)">
      <rect x="-90" y="-30" width="180" height="80" rx="14" fill="#0f0a14"/>
      <circle cx="-50" cy="10"  r="14" fill="#22d3ee"/>
      <circle cx="-15" cy="10"  r="10" fill="#facc15"/>
      <circle cx="15"  cy="10"  r="10" fill="#10b981"/>
      <circle cx="50"  cy="10"  r="14" fill="#f43f5e"/>
      <rect x="-6"  y="-65" width="12" height="35" fill="#0f0a14"/>
      <circle cx="0" cy="-65" r="14" fill="#f43f5e"/>
    </g>
    <text x="20" y="278" fill="#fff" font-family="Inter,Arial" font-weight="800" font-size="26">${t}</text>`,
};

function generic(title, color) {
  const initials = title.split(/\s+/).slice(0, 2).map(s => s[0]).join('').toUpperCase();
  const c = color || '#7c3aed';
  return `
    <defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${c}"/><stop offset="1" stop-color="#000"/>
    </linearGradient></defs>
    <rect width="400" height="300" fill="url(#bg)"/>
    <text x="200" y="170" text-anchor="middle" fill="#fff" font-family="Inter,Arial" font-weight="800" font-size="80">${initials}</text>
    <text x="20" y="278" fill="#fff" font-family="Inter,Arial" font-weight="800" font-size="26">${title}</text>`;
}

export function thumbnailSvg(game) {
  const fn = ART[game.thumb];
  const inner = fn ? fn(game.title) : generic(game.title, game.color);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300" preserveAspectRatio="xMidYMid slice" role="img" aria-label="${game.title}">${inner}</svg>`;
}

// Convenience: insert thumbnail SVG into a container, replacing its contents.
export function renderThumbnail(container, game) {
  container.innerHTML = thumbnailSvg(game);
}
