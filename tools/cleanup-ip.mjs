// tools/cleanup-ip.mjs
//
// Conservative IP-clone cleanup.  Removes entries from the three source
// catalogs (master_games.json, somethingrandom.json, data/top_games.json)
// that match a known-trademark pattern, or that point at a host known to
// be a pirate mirror.
//
// We are deliberately STRICT — only remove things that name a registered
// trademark by name.  Generic mechanics ("drift", "stickman", "clicker",
// "battle royale") are kept.  Inspired-by clones that don't say the IP's
// name in the title are kept.
//
// Run:  node tools/cleanup-ip.mjs
// Then: node tools/build-supabase.mjs

import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// ---------- blocklist ----------
// Each entry: [label, pattern].  Patterns match against title (case-insensitive)
// or against tags / source URL.  Word boundaries used to avoid false positives.
const BLOCK = [
  // Rockstar / Take-Two
  ['Rockstar — GTA',          /\bgta\b/i],
  ['Rockstar — GTA',          /grand\s*theft\s*auto/i],

  // Valve
  ['Valve — Counter-Strike',  /counter[\s-]*strike/i],
  ['Valve — CS:GO/CS2',       /\bcs[\s:-]?(go|2)\b/i],
  ['Valve — CS Online',       /^\s*cs[\s-]*online\b/i],

  // Innersloth
  ['Innersloth — Among Us',   /\bamong[\s-]*us\b/i],
  ['Innersloth — Amongus',    /\bamongus\b/i],

  // Scott Cawthon / Steel Wool
  ['FNAF',                    /\bfive[\s-]*nights[\s-]*at\b/i],
  ['FNAF',                    /\bfnaf\b/i],
  ['FNAF — Freddy Fazbear',   /freddy\s*fazbear/i],

  // MOB Games
  ['MOB Games — Poppy Playtime', /poppy[\s-]*playtime/i],
  ['MOB Games — Huggy Wuggy',    /huggy[\s-]*wuggy/i],
  ['MOB Games — Kissy Missy',    /kissy[\s-]*missy/i],

  // Euphoric Brothers
  ['Garten of Banban',        /garten\s*of\s*ban(ban)?/i],

  // Roblox Corp
  ['Roblox',                  /\broblox\b/i],
  ['Roblox — Brookhaven',     /\bbrookhaven\b/i],

  // Invisible Narratives / DaFuq!?Boom!
  ['Skibidi Toilet',          /skibidi[\s-]*toilet/i],

  // RobTop Games — Geometry Dash (the exact franchise name)
  ['RobTop — Geometry Dash',  /\bgeometry[\s-]*dash\b/i],

  // Nintendo / Game Freak
  ['Nintendo — Pokémon',      /\bpok[eé]mon\b/i],
  ['Nintendo — Pikachu',      /\bpikachu\b/i],
  ['Nintendo — Charizard',    /\bcharizard\b/i],
  ['Nintendo — Pixelmon',     /\bpixelmon\b/i],         // uses Pokémon IP via mod
  ['Nintendo — Super Mario',  /\bsuper[\s-]*mario\b/i],
  ['Nintendo — Mario Bros',   /\bmario[\s-]*(bros|brothers|kart|party|world)\b/i],

  // Mojang / Microsoft
  ['Mojang — Minecraft',      /\bminecraft\b/i],

  // SEGA
  ['SEGA — Sonic',            /\bsonic[\s-]*(the[\s-]*hedgehog|dash|exe|forces|frontiers)\b/i],

  // SYBO
  ['SYBO — Subway Surfers',   /subway[\s-]*surfers?/i],

  // Slither.io / Agar.io etc.
  ['Slither.io',              /\bslither[\s.-]?io\b/i],
  ['Agar.io',                 /\bagar[\s.-]?io\b/i],

  // Hipster Whale
  ['Crossy Road',             /\bcrossy[\s-]*road\b/i],

  // ZeptoLab
  ['Cut the Rope',            /\bcut[\s-]*the[\s-]*rope\b/i],

  // Rovio
  ['Angry Birds',             /\bangry[\s-]*birds?\b/i],

  // Amanotes
  ['Amanotes — Magic Tiles',  /\bmagic[\s-]*tiles[\s-]*3\b/i],

  // Epic Games
  ['Epic — Fortnite',         /\bfortnite\b/i],

  // Flipline Studios — Papa Louie series
  ['Flipline — Papa\'s',      /papa['’s]+\s*(pizzeria|burgeria|donuteria|freezeria|wingeria|cheeseria|sushiria|hot[\s-]*doggeria|cupcakeria|scooperia|pancakeria|taco[\s-]*mia|bakeria|mocharia)/i],

  // Orteil — Cookie Clicker (the original, not the generic "clicker" genre)
  ['Orteil — Cookie Clicker', /\bcookie[\s-]*clicker(\s*pro)?\b/i],

  // Playgendary
  ['Playgendary — Tomb of the Mask', /tomb\s*of\s*the\s*mask/i],

  // Psyonix — Rocket League
  ['Psyonix — Rocket League', /\brocket[\s-]*league\b/i],

  // Coffee Stain — Cluster Rush (paid Steam game)
  ['Cluster Rush',            /\bcluster[\s-]*rush\b/i],

  // Tall Team — Smash Karts
  ['Smash Karts',             /\bsmash[\s-]*karts?\b/i],

  // Lowtech / Spil — Hole.io
  ['Hole.io',                 /\bhole[\s.-]?io\b/i],

  // Mattel
  ['Mattel — Barbie',         /\bbarbie\b/i],
  ['Mattel — Uno (specific)', /\buno[\s-]*(super[\s-]*heroes|online|with\s*friends|cards|game)\b/i],

  // MGA Entertainment
  ['MGA — L.O.L. Surprise',   /\blol[\s-]*(surprise|dolls?|beauty|fresh|boutique|football)\b/i],

  // Tetris LLC (heavily enforced)
  ['Tetris LLC',              /\btetris\b/i],

  // Krafton — PUBG / Battlegrounds (only when context clearly maps to PUBG)
  ['Krafton — PUBG',          /\bpubg\b/i],
  ['Krafton — Battlegrounds', /\b(pubg|player\s*unknown)[\s-]*battlegrounds?\b/i],

  // Toei / Bandai Namco — Dragon Ball
  ['Toei — Dragon Ball',      /\bdragon[\s-]*ball\b/i],
  ['Toei — DBZ',              /\bdbz\b/i],

  // Bandai Namco
  ['Bandai — Pac-Man',        /\bpac[\s-]*man\b/i],
  ['Bandai — Tekken',         /\btekken\b/i],

  // Supercell
  ['Supercell — Brawl Stars', /\bbrawl[\s-]*stars\b/i],
  ['Supercell — Clash',       /\bclash[\s-]*of[\s-]*clans\b/i],
  ['Supercell — Clash Royale',/\bclash[\s-]*royale\b/i],

  // Hasbro
  ['Hasbro — Connect 4',      /\bconnect[\s-]*4\b/i],
  ['Hasbro — Monopoly',       /\bmonopoly\b/i],
  ['Hasbro — Scrabble',       /\bscrabble\b/i],

  // Capcom
  ['Capcom — Resident Evil',  /\bresident[\s-]*evil\b/i],
  ['Capcom — Street Fighter', /\bstreet[\s-]*fighter\b/i],
  ['Capcom — Mega Man',       /\bmega[\s-]*man\b/i],

  // Voodoo
  ['Voodoo — Helix Jump',     /\bhelix[\s-]*jump\b/i],

  // Imangi
  ['Imangi — Temple Run',     /\btemple[\s-]*run\b/i],

  // Halfbrick
  ['Halfbrick — Fruit Ninja', /\bfruit[\s-]*ninja\b/i],
  ['Halfbrick — Jetpack',     /\bjetpack[\s-]*joyride\b/i],

  // Outfit7
  ['Outfit7 — Talking Tom',   /\btalking[\s-]*tom\b/i],

  // SEGA — Crazy Taxi
  ['SEGA — Crazy Taxi',       /\bcrazy[\s-]*taxi\b/i],

  // Ninja Kiwi
  ['Ninja Kiwi — Bloons',     /\bbloons\b/i],
  ['Ninja Kiwi — BTD',        /\bbtd[\s-]*[1-7]\b/i],

  // Nintendo (additional)
  ['Nintendo — Donkey Kong',  /\bdonkey[\s-]*kong\b/i],
  ['Nintendo — Zelda',        /\b(zelda|triforce|hyrule)\b/i],
  ['Nintendo — Splatoon',     /\bsplatoon\b/i],
  ['Nintendo — Animal Crossing', /\banimal[\s-]*crossing\b/i],

  // miHoYo / HoYoverse
  ['miHoYo — Genshin',        /\bgenshin\b/i],
  ['miHoYo — Honkai',         /\bhonkai\b/i],

  // Re-Logic — Terraria
  ['Re-Logic — Terraria',     /\bterraria\b/i],

  // Kitka — Stumble Guys
  ['Kitka — Stumble Guys',    /\bstumble[\s-]*guys\b/i],

  // ConcernedApe / Toby Fox / StudioMDHR (paid Steam games — no legit free embed)
  ['ConcernedApe — Stardew',  /\bstardew[\s-]*valley\b/i],
  ['Toby Fox — Undertale',    /\bundertale\b/i],
  ['Toby Fox — Deltarune',    /\bdeltarune\b/i],
  ['StudioMDHR — Cuphead',    /\bcuphead\b/i],

  // tinyBuild — Hello Neighbor
  ['tinyBuild — Hello Neighbor', /\bhello[\s-]*neighbor\b/i],

  // Konami
  ['Konami — Frogger',        /\bfrogger\b/i],
  ['Konami — Metal Gear',     /\bmetal[\s-]*gear\b/i],

  // Riot — League of Legends / Valorant (only in their specific names, not bare "lol")
  ['Riot — LoL',              /\bleague[\s-]*of[\s-]*legends\b/i],
  ['Riot — Valorant',         /\bvalorant\b/i],

  // Activision / Blizzard
  ['Activision — Call of Duty', /\bcall[\s-]*of[\s-]*duty\b/i],
  ['Blizzard — Overwatch',    /\boverwatch\b/i],
  ['Blizzard — Warcraft',     /\bwarcraft\b/i],

  // Bethesda
  ['Bethesda — Skyrim',       /\bskyrim\b/i],
  ['Bethesda — Fallout',      /\bfallout[\s-]*[0-9]+\b/i],

  // Disney
  ['Disney',                  /\b(disney|elsa|frozen\s*ii?|frozen\s*2|mickey\s*mouse)\b/i],

  // NYT — Wordle
  ['NYT — Wordle',            /\bwordle\b/i],

  // ninjamuffin99 / The Funkin' Crew — Friday Night Funkin (community remixes vary,
  // but the unaltered name on a portal site is the safer drop)
  ['Funkin Crew — FNF',       /\b(friday[\s-]*night[\s-]*funkin|\bfnf\b)\b/i],

  // Incredibox — Sprunki is a fan mod and Incredibox has DMCA'd HTML5 hosts
  ['Incredibox — Sprunki',    /\bsprunki\b/i],

  // Halfbrick — Dan the Man (separate from Fruit Ninja above)
  ['Halfbrick — Dan the Man', /\bdan[\s-]*the[\s-]*man\b/i],

  // Nokta Games — Supermarket Simulator (paid Steam game, no HTML5 license)
  ['Nokta — Supermarket Sim', /\bsupermarket[\s-]*simulator\b/i],

  // Crazy Justin's Hot Air — Stick War Saga (mobile game, no HTML5 license)
  ['Crazy Justin — Stick War Saga', /\bstick[\s-]*war[\s-]*saga\b/i],

  // ByteDance / Hungry Studio — Block Blast (recent mobile hit, HTML5 ports unauthorized)
  ['Hungry Studio — Block Blast', /\bblock[\s-]*blast\b/i],

  // Marvel / DC
  ['Marvel',                  /\b(marvel|spider[\s-]*man|iron[\s-]*man|hulk|avengers|deadpool|thor|captain[\s-]*america|wolverine)\b/i],
  ['DC',                      /\b(batman|superman|wonder[\s-]*woman|justice[\s-]*league|aquaman)\b/i],

  // Star Wars (Disney)
  ['Star Wars',               /\bstar[\s-]*wars\b/i],

  // Other major franchises
  ['Hello Kitty (Sanrio)',    /\bhello[\s-]*kitty\b/i],
  ['SpongeBob (Nickelodeon)', /\bspongebob\b/i],
  ['Peppa Pig',               /\bpeppa[\s-]*pig\b/i],
  ['Paw Patrol',              /\bpaw[\s-]*patrol\b/i],
];

// Pirate / unauthorized mirror hosts — remove ANY entry whose URL is on these.
const BLOCK_HOSTS = [
  /\bduckmath\.org\b/i,
  /\bunblockedgames\b/i,
  /\b1v1\.lol\b/i,
  /\bcoolmathgames\.com\b/i,
];

// Bare external game-site URLs.  These point at a competitor's full website
// (e.g. https://smashkarts.io/) rather than a licensed iframe embed.  They
// almost always send X-Frame-Options: DENY, so they show a blank frame on /play.
// Drop any entry whose URL is the bare hostname of a competitor game studio.
const BLOCK_BARE_HOSTS = new Set([
  'smashkarts.io',
  'deadshot.io',
  'lolbeans.io',
  'bloxd.io',
  'suroi.io',
  'krunker.io',
  'shellshock.io',
  'shellshockers.io',
  'agar.io',
  'slither.io',
  'paper-io.com',
  'paperio.com',
  'diep.io',
  'venge.io',
  'bonk.io',
  '1v1.lol',
  'evowarriors.io',
  'evowars.io',
  'sploop.io',
]);

// Suspicious GameDistribution IDs — real IDs are 32-char hex but unique.
// These look like sequential placeholders (e.g. "5b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e",
// "a9b0c1d2e3f4...", repeating ascending hex digits).  They almost certainly
// 404 — drop them.
const SUSPICIOUS_GD_ID = /\/([0-9a-f]{32})\//i;
function looksFakeGdId(id) {
  if (!id || id.length !== 32) return false;
  // ascending or descending hex runs (e.g. "0123456789abcdef" anywhere)
  if (/(0123|1234|2345|3456|4567|5678|6789|789a|89ab|9abc|abcd|bcde|cdef|fedc|edcb|dcba|cba9|ba98|a987|9876|8765|7654|6543|5432|4321)/.test(id)) return true;
  // four-of-a-kind run (e.g. "aaaa", "0000")
  if (/(.)\1{3,}/.test(id)) return true;
  return false;
}

// ---------- helpers ----------
function titleMatches(title) {
  if (!title) return null;
  for (const [label, re] of BLOCK) if (re.test(title)) return label;
  return null;
}
function urlMatches(url) {
  if (!url) return null;
  for (const re of BLOCK_HOSTS) if (re.test(url)) return 'pirate-host: ' + url.match(re)[0];
  // Bare hostname check — strip protocol/path/trailing slash, lowercase host
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    const bare = (u.pathname === '/' || u.pathname === '') && !u.search && !u.hash;
    if (bare && BLOCK_BARE_HOSTS.has(host)) return 'external-site: ' + host;
  } catch {}
  // Suspicious / fabricated GameDistribution ID
  const m = SUSPICIOUS_GD_ID.exec(url);
  if (m && /gamedistribution\.com/i.test(url) && looksFakeGdId(m[1])) {
    return 'fake-gd-id: ' + m[1].slice(0, 8) + '…';
  }
  return null;
}
function tagsMatch(tags) {
  if (!tags) return null;
  const s = Array.isArray(tags) ? tags.join(' ') : String(tags);
  // Only check tags for the most blatant trademarks — the title check already
  // handles the rest, and matching on tags risks false positives.
  const tagOnly = [
    ['Roblox',           /\broblox\b/i],
    ['Minecraft',        /\bminecraft\b/i],
    ['FNAF',             /\bfnaf\b/i],
    ['Among Us',         /\bamong[\s-]*us\b/i],
    ['Geometry Dash',    /\bgeometry[\s-]*dash\b/i],
    ['Pokémon',          /\bpok[eé]mon\b/i],
    ['GTA',              /\bgta\b/i],
    ['Subway Surfers',   /subway[\s-]*surfers?/i],
    ['Counter-Strike',   /counter[\s-]*strike/i],
  ];
  for (const [label, re] of tagOnly) if (re.test(s)) return label;
  return null;
}

function reasonFor(entry) {
  // Match the field set across all three sources.
  const title = entry.title;
  const url   = entry.embed_url || entry.embed || entry.link;
  const tags  = entry.tags;
  return titleMatches(title) || urlMatches(url) || tagsMatch(tags);
}

function cleanArray(arr, label) {
  const kept = [], dropped = [];
  for (const e of arr) {
    const r = reasonFor(e);
    if (r) dropped.push({ title: e.title, reason: r });
    else   kept.push(e);
  }
  console.log(`\n[${label}]  in: ${arr.length}  →  kept: ${kept.length}  dropped: ${dropped.length}`);
  // Show breakdown of drop reasons.
  const byReason = {};
  for (const d of dropped) byReason[d.reason] = (byReason[d.reason] || 0) + 1;
  Object.entries(byReason).sort((a,b)=>b[1]-a[1]).forEach(([k,v]) => console.log(`    ${String(v).padStart(4)}  ${k}`));
  return { kept, dropped };
}

// ---------- run ----------
const files = [
  { path: 'master_games.json',      label: 'master_games.json' },
  { path: 'somethingrandom.json',   label: 'somethingrandom.json' },
  { path: 'data/top_games.json',    label: 'data/top_games.json' },
];

const allDropped = [];
for (const f of files) {
  const fp = join(ROOT, f.path);
  if (!existsSync(fp)) { console.log('skip (missing):', f.path); continue; }
  const arr = JSON.parse(readFileSync(fp, 'utf8'));
  // back up once (don't overwrite an existing backup)
  const bak = fp + '.precleanup.bak';
  if (!existsSync(bak)) { copyFileSync(fp, bak); }
  const { kept, dropped } = cleanArray(arr, f.label);
  writeFileSync(fp, JSON.stringify(kept, null, 2), 'utf8');
  for (const d of dropped) allDropped.push({ file: f.label, ...d });
}

writeFileSync(join(ROOT, 'tools', 'cleanup-ip.report.json'),
              JSON.stringify(allDropped, null, 2), 'utf8');
console.log(`\nFull list of dropped entries → tools/cleanup-ip.report.json (${allDropped.length} rows)`);
console.log('Next:  node tools/build-supabase.mjs');
