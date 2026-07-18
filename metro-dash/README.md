# Metro Dash

An endless-runner built in WebGL 2.0. (Originally a university course project;
renamed and de-branded to **Metro Dash** with clean, original placeholder art
and a synthesized soundtrack so it ships no third-party assets.)

## Run (works in Chrome / Chromium)

The game loads images into WebGL textures, so it **must be served over HTTP** —
opening `game.html` directly via `file://` triggers Chrome's cross-origin
texture security error. Any static server works:

```bash
npm start                 # bundled zero-dependency server -> http://localhost:5500
# or
npx serve .
# or
python -m http.server 8000
```

Then open the printed `http://localhost…` URL.

## Controls

**Desktop**
* Jump: `Space`
* Left: `A` / `←`
* Right: `D` / `→`

**Mobile (touch)**
* Swipe left / right — change lane
* Swipe up or tap — jump

## Assets / licensing

* `assets/player.png`, `assets/police.png` — clean, **self-generated** placeholder
  sprites (regenerate any time with `npm run placeholders`).
* Background music — **synthesized at runtime** with the Web Audio API; no audio
  file is shipped or loaded.
* The remaining textures (ground, track, walls, coins, etc.) are generic. Swap in
  your own art whenever you like.

## What changed from the original

1. **CORS / asset loading** — `src/texture.js` now sets `image.crossOrigin` and
   handles load errors gracefully so it runs in Chrome when served over HTTP;
   added `tools/serve.mjs` for one-command local hosting.
2. **De-branded** — renamed to *Metro Dash* throughout; replaced the
   character/police art and music with original placeholders.
3. **Monetization** — `game.html` + `style.css` center the canvas and add
   left / right / bottom AdSense slots (add your publisher + slot IDs).
4. **Mobile controls** — `src/keyhandler.js` adds touch swipe + tap support.

## Directory structure

```
.
├── assets/            game textures (player/police are placeholders)
├── libs/              gl-matrix, jQuery, webgl-utils
├── src/               game modules (player, police, draw, main, …)
├── tools/
│   ├── serve.mjs            zero-dep static dev server (npm start)
│   └── make-placeholders.mjs  regenerates clean player/police sprites
├── game.html
├── style.css
└── README.md
```
