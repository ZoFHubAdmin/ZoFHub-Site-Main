// lib/categorize.mjs
// ---------------------------------------------------------------------------
// The scraped Y8 feed (y8-games.json) has NO category field — only name, slug,
// embedUrl, thumbnail. Without this, every game fell back to 'arcade', dumping
// all 2,410 games into one bucket. This infers a sensible category from each
// game's title + slug keywords instead.
//
// Used by BOTH the SQL generator (tools/y8-json-to-sql.mjs) and the live ingest
// (lib/y8-ingest.mjs) so the manual SQL load and the automatic refresh always
// agree. Categories returned here are limited to names the catalog ALREADY
// uses (arcade, racing, action, puzzle, sports, shooting, adventure, girls,
// casual, multiplayer, card games) so we never create orphan/empty categories.
// First matching rule wins; unmatched → 'arcade'.
// ---------------------------------------------------------------------------

const RULES = [
  // girls / dress-up / beauty — checked first (very distinctive vocabulary)
  ['girls', /\b(dress|dressup|fashion|makeup|makeover|salon|princess|wedding|bride|bridal|nail|manicure|pedicure|hairstyle|barbie|sofia|elsa|anna|frozen|doll|beauty|spa|pregnan|mommy|babysitter|stylist|model|jewel(?!ry-?match)|tiara|unicorn|pony|fairy)\b/],
  // cooking / food → casual
  ['casual', /\b(cook|cooking|kitchen|cake|bake|bakery|pizza|burger|icecream|food|restaurant|chef|candy|donut|sushi|cupcake|sandwich|waffle|pancake|smoothie|juice)\b/],
  // sports
  ['sports', /\b(soccer|football|basketball|baseball|golf|tennis|pool|billiard|snooker|bowling|hockey|cricket|boxing|dunk|penalty|skate|skateboard|volleyball|rugby|darts|archery|fishing|surf)\b/],
  // racing / driving
  ['racing', /\b(racing|race|racer|moto|motor|motorcycle|car|cars|drift|driver|driving|truck|bike|bmx|atv|quad|traffic|parking|speed|wheels|formula|kart|bus|taxi|highway|rally|stunt|drag)\b/],
  // shooting / war
  ['shooting', /\b(shoot|shooter|shooting|gun|guns|gunner|sniper|fps|war|army|soldier|zombie|zombies|strike|commando|tank|tanks|missile|combat|trooper|airstrike|turret|bazooka)\b/],
  // io / multiplayer arena
  ['multiplayer', /(\.io\b|\bio\b|agar|slither|paperio|holeio|wormszone|\bmultiplayer\b)/],
  // puzzle / match / brain
  ['puzzle', /\b(puzzle|match3?|mahjong|sudoku|jigsaw|block|blocks|bubble|connect|merge|2048|brain|word|words|quiz|hidden|find|hiding|maze|tile|tiles|memory|logic|solitaire|klondike|freecell)\b/],
  // cards (after puzzle so 'solitaire' lands in puzzle-family consistently)
  ['card games', /\b(card|cards|poker|blackjack|uno|rummy|baccarat|solitaire)\b/],
  // adventure / quest / rpg
  ['adventure', /\b(adventure|quest|escape|story|rpg|dungeon|explore|journey|treasure|island|saga|mystery)\b/],
  // action / fighting / platform
  ['action', /\b(fight|fighter|fighting|ninja|hero|heroes|run|runner|jump|jumping|parkour|stickman|clash|smash|slash|sword|warrior|knight|survival|survive|monster|spider|dragon|fury|rage|rampage|arena|battle|platform)\b/],
];

export function guessCategory(title, slug = '') {
  const hay = `${String(title || '').toLowerCase()} ${String(slug || '').toLowerCase().replace(/[-_]/g, ' ')}`;
  for (const [cat, re] of RULES) if (re.test(hay)) return cat;
  return 'arcade';
}
