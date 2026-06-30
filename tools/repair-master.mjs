// tools/repair-master.mjs
// master_games.json is missing the closing `]` for the canonical 12,201-entry
// array.  Two more lists got appended without separators:
//   - a chunk of {title,link,thumbnail,source,category} entries (duplicates of somethingrandom.json)
//   - a {title,embed,image,category,tags} array (the user's onlinegames.io top-game picks)
//
// We recover both and write three clean files:
//   master_games.json       canonical 12,201 entries
//   data/top_games.json     the user's onlinegames.io picks (high-priority "featured")
// The middle somethingrandom-format chunk is discarded — it is already in
// somethingrandom.json verbatim.

import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const PATH = join(ROOT, 'master_games.json');

const raw = readFileSync(PATH, 'utf8');

// ---------- 1. Find the end of the canonical master --------------------
// The canonical master ends at the `}` after the last GameFlare entry — find
// the LAST `"platform": "GameFlare"` and the `}` that closes that object.
// Then we close the array with `]`.
//
// Simpler heuristic: find the first appended object (it has `"link":` instead
// of `"embed_url":`), and truncate before it.
const APPEND_MARK = '\n  {\n        "title":';
const cutAt = raw.indexOf(APPEND_MARK);
if (cutAt < 0) {
  console.error("can't find appended-section marker — file may already be clean");
  process.exit(1);
}

// Walk back from cutAt to find the previous `}` that closes a master entry.
let cut = cutAt;
while (cut > 0 && raw[cut] !== '}') cut--;
if (cut === 0) { console.error('cannot locate previous closing brace'); process.exit(1); }
const masterText = raw.slice(0, cut + 1) + '\n]';
let master;
try { master = JSON.parse(masterText); }
catch (e) { console.error('master parse failed:', e.message); process.exit(1); }
console.log(`canonical master: ${master.length} entries`);

// ---------- 2. Extract the user's onlinegames.io top-games array -------
// It starts with `    [\n  {"title":"Stack Fire Ball"`
const topStartMark = raw.indexOf('[\n  {"title":');
let topGames = null;
if (topStartMark >= 0) {
  // Walk forward, tracking depth, to find the matching `]`.
  let depth = 0, inStr = false, esc = false, end = -1;
  for (let i = topStartMark; i < raw.length; i++) {
    const c = raw[i];
    if (esc) { esc = false; continue; }
    if (inStr) {
      if (c === '\\') { esc = true; continue; }
      if (c === '"')  inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === '[') depth++;
    else if (c === ']') {
      depth--;
      if (depth === 0) { end = i; break; }
    }
  }
  if (end > topStartMark) {
    try {
      topGames = JSON.parse(raw.slice(topStartMark, end + 1));
      console.log(`top_games: ${topGames.length} entries`);
    } catch (e) { console.warn('top_games parse failed:', e.message); }
  }
}

// ---------- 3. Write outputs ------------------------------------------
const backup = PATH + '.broken.bak';
if (!existsSync(backup)) { renameSync(PATH, backup); console.log(`backed up → master_games.json.broken.bak`); }
writeFileSync(PATH, JSON.stringify(master, null, 2), 'utf8');
console.log(`wrote canonical master_games.json (${master.length} entries)`);

if (topGames && topGames.length) {
  mkdirSync(join(ROOT, 'data'), { recursive: true });
  writeFileSync(join(ROOT, 'data', 'top_games.json'), JSON.stringify(topGames, null, 2), 'utf8');
  console.log(`wrote data/top_games.json (${topGames.length} entries)`);
}
