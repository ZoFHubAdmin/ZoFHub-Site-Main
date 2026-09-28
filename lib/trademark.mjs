// lib/trademark.mjs — the ONE list of third-party marks the catalog screens for.
// ---------------------------------------------------------------------------
// Moved out of lib/cron-jobs.mjs so a pure module (the GameDistribution
// importer, the CMS) can use it without importing the scheduler, Supabase and
// the link checker along with it. cron-jobs re-exports isTrademarkTitle, so
// every existing caller keeps working and there is still exactly one list.
//
// A hit is not a finding of infringement — a pattern match cannot be. It is the
// point at which a person must look before the game is shown.
// ---------------------------------------------------------------------------

// IP / trademark blocklist for the grow path.  Comprehensive — mirrors the
// migrator's list so a clone titled with a registered trademark (even on a
// licensed host like GameMonetize) never reaches the catalog.  Trademark
// holders enforce regardless of which host serves the clone.
export const CRON_IP_PATTERNS = [
  /\bgta\b/i, /grand\s*theft\s*auto/i, /counter[\s-]*strike/i, /\bcs[\s:-]?(go|2)\b/i,
  /\bamong[\s-]*us\b/i, /\bamongus\b/i, /\bfive[\s-]*nights[\s-]*at\b/i, /\bfnaf\b/i,
  /poppy[\s-]*playtime/i, /huggy[\s-]*wuggy/i, /garten\s*of\s*ban(ban)?/i,
  /\broblox\b/i, /skibidi[\s-]*toilet/i, /\bgeometry[\s-]*dash\b/i, /\bpok[eé]mon\b/i,
  /\bpikachu\b/i, /\bpixelmon\b/i, /\bsuper[\s-]*mario\b/i, /\bmario[\s-]*(bros|brothers|kart|party|world)\b/i,
  /\bminecraft\b/i, /\bsonic[\s-]*(the[\s-]*hedgehog|dash|exe|forces|frontiers)\b/i,
  /subway[\s-]*surfers?/i, /\bslither[\s.-]?io\b/i, /\bagar[\s.-]?io\b/i,
  /\bcrossy[\s-]*road\b/i, /\bcut[\s-]*the[\s-]*rope\b/i, /\bangry[\s-]*birds?\b/i,
  /\bmagic[\s-]*tiles[\s-]*3\b/i, /\bfortnite\b/i,
  /papa['’s]+\s*(pizzeria|burgeria|donuteria|freezeria|wingeria|cheeseria|sushiria|hot[\s-]*doggeria|cupcakeria|scooperia|pancakeria|taco[\s-]*mia|bakeria|mocharia)/i,
  /\bcookie[\s-]*clicker(\s*pro)?\b/i,
  // Not word-bounded: "Hextetris", "Tetrisphere" and similar compounds trade on
  // the mark just as much, and its owner is known to enforce against them.
  /tetris/i, /\bpubg\b/i,
  /\bdragon[\s-]*ball\b/i, /\bpac[\s-]*man\b/i, /\btekken\b/i, /\bbrawl[\s-]*stars\b/i,
  /\bclash[\s-]*of[\s-]*clans\b/i, /\bclash[\s-]*royale\b/i, /\bmonopoly\b/i, /\bscrabble\b/i,
  /\bresident[\s-]*evil\b/i, /\bstreet[\s-]*fighter\b/i, /\bmega[\s-]*man\b/i,
  /\bhelix[\s-]*jump\b/i, /\btemple[\s-]*run\b/i, /\bfruit[\s-]*ninja\b/i, /\bjetpack[\s-]*joyride\b/i,
  /\btalking[\s-]*tom\b/i, /\bcrazy[\s-]*taxi\b/i, /\bbloons\b/i, /\bbtd[\s-]*[1-7]\b/i,
  /\bdonkey[\s-]*kong\b/i, /\b(zelda|triforce|hyrule)\b/i, /\bsplatoon\b/i, /\banimal[\s-]*crossing\b/i,
  /\bgenshin\b/i, /\bhonkai\b/i, /\bterraria\b/i, /\bstumble[\s-]*guys\b/i,
  /\bstardew[\s-]*valley\b/i, /\bundertale\b/i, /\bdeltarune\b/i, /\bcuphead\b/i,
  /\bwordle\b/i, /\bsupermarket\s*sim/i, /\bsprunki\b/i, /\bblock[\s-]*blast\b/i,
  /\bfriday[\s-]*night[\s-]*funkin\b/i, /\bfnf\b/i, /\brocket[\s-]*league\b/i,
  // Additional well-known marks not in the migrator list but common in dumps:
  /\bkingdom[\s-]*rush\b/i, /\bplants[\s-]*(vs\.?|versus)[\s-]*zombies\b/i, /\bpvz\b/i,
  /\bflappy[\s-]*bird\b/i, /\bdoodle[\s-]*jump\b/i, /\bbad[\s-]*piggies\b/i,
  /\bhill[\s-]*climb[\s-]*racing\b/i, /\bsubway[\s-]*princess\b/i, /\bdisney\b/i,
  /\bspongebob\b/i, /\bbatman\b/i, /\bspider[\s-]*man\b/i, /\bfrozen\b.*\belsa\b/i, /\belsa\b.*\banna\b/i,
  // Film / streaming / kids-TV / toy trademarks that recur in game dumps:
  /\bsquid[\s-]*game\b/i, /\bstranger[\s-]*things\b/i, /\bwednesday[\s-]*addams\b/i,
  /\bbarbie\b/i, /\bhello[\s-]*kitty\b/i, /\bpaw[\s-]*patrol\b/i, /\bpeppa[\s-]*pig\b/i,
  /\bbluey\b/i, /\bnaruto\b/i, /\bone[\s-]*piece\b/i, /\bmarvel\b/i, /\bavengers\b/i,
  /\bharry[\s-]*potter\b/i, /\bstar[\s-]*wars\b/i, /\blego\b/i, /\bhot[\s-]*wheels\b/i,
  /\bsuper[\s-]*mario\b/i, /\bbendy\b/i, /\bgta[\s-]*v?\b/i,
  // Added 2026-09-26 for provider feeds, whose TAGS name the mark on its own:
  // GameDistribution lists 24 games tagged plain "mario", which the
  // "super mario" / "mario bros" forms above did not catch.
  /\bmario\b/i,
];

// Trademark-name check ONLY (no host rules). Used by the recommendations
// endpoint, which validates the host separately against its own embed
// allowlist (which intentionally permits y8.com/embed — a host the bulk
// importer blocks). Keeps the trademark guard without the host conflict.
export function isTrademarkTitle(title) {
  for (const p of CRON_IP_PATTERNS) if (p.test(title)) return true;
  return false;
}
