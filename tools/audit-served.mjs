// tools/audit-served.mjs — offline audit of the catalog AS VISITORS SEE IT.
//
//   npm run audit-served
//
// The gap this closes: every other checker in this repo looks at a source file
// or at the raw `games` table. tools/cleanup-ip.mjs, which owns a curated
// 107-pattern trademark list, only ever ran against master_games.json,
// somethingrandom.json and data/top_games.json. Nothing had ever asked the one
// question that matters — what is actually being SERVED, after
// data/catalog-overrides.json has had its say? The first time that question was
// asked, it found 24 trademark titles live on the site.
//
// Complements tools/verify-catalog.mjs, which answers "does it load?" over the
// network. This one is offline, instant, and answers "should it be there at
// all, and is the row coherent?". Run both.
//
// Writes nothing. Exits 1 if any hard problem is found, so CI can gate on it.

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { applyCatalogOverrides } from '../lib/catalog-overrides.mjs';
import { titleMatches, urlMatches } from './cleanup-ip.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const urlOf = (g) => g.game_url || g.embed_url || g.url || '';
const hostOf = (u) => { try { return new URL(String(u)).host.toLowerCase(); } catch { return ''; } };

/**
 * The publisher's brand label, not the registrable domain.
 *
 * gamemonetize.co and gamemonetize.com are one company; comparing registrable
 * domains called all 9,407 GameMonetize games "hotlinked from a stranger".
 * Likewise cdn2.y8.com is Y8's own CDN, so the numeric suffix has to go too, or
 * every Y8 game reports a foreign thumbnail.
 */
export function brandOf(host) {
  const bare = String(host).toLowerCase()
    .replace(/^(www|img|images|html5|cloud|cdn\d*|static|media|assets|distribution|play|files)\./, '');
  return bare.split('.')[0] || bare;
}

// server.js /play/:gameSlug decides how a game is framed. Mirrored here so the
// audit can spot a host nobody has deliberately routed — that game silently
// takes a fallback path no one chose for it.
const ROUTES = [
  ['proxy (/embed)', /(^|\.)(y8\.com|htmlgames\.com|famobi\.com)$/],
  ['direct (SDK-sensitive)', /(^|\.)(gamedistribution\.com|gamemonetize\.(com|co)|onlinegames\.io)$/],
];

export function auditServed(served) {
  const problems = {
    noUrl: [], notHttps: [], noTitle: [], noSlug: [], badSlug: [],
    noThumbnail: [], noCategory: [], duplicateSlug: [], duplicateEmbed: [],
    siteRootEmbed: [], trademark: [], foreignThumbnail: [], unroutedHost: [],
    missingLocalThumbnail: [],
  };
  // Reported, never failed on. See the note at the assignment below.
  const informational = { suspiciousGdId: [] };
  const strategy = new Map();
  const seenSlug = new Map(), seenEmbed = new Map();

  for (const g of served) {
    const u = urlOf(g), h = hostOf(u), slug = String(g.slug || '');
    const thumb = String(g.thumbnail_url || g.thumbnail || '');

    if (!u) { problems.noUrl.push(slug || '(no slug)'); continue; }
    if (!/^https:/i.test(u)) problems.notHttps.push(`${slug} -> ${u.slice(0, 60)}`);
    if (!String(g.title || '').trim()) problems.noTitle.push(slug);
    if (!slug) problems.noSlug.push(u.slice(0, 60));
    else if (!/^[a-z0-9][a-z0-9_-]*$/.test(slug)) problems.badSlug.push(slug);
    if (!thumb) problems.noThumbnail.push(slug);
    if (!String(g.category || '').trim()) problems.noCategory.push(slug);

    // Framing a bare domain root means embedding somebody's entire website.
    // There is no distribution licence behind a URL of that shape.
    try {
      const p = new URL(u);
      if (p.pathname === '/' || p.pathname === '') problems.siteRootEmbed.push(`${slug} -> ${u}`);
    } catch { /* covered by noUrl */ }

    if (seenSlug.has(slug)) problems.duplicateSlug.push(`${slug} (also ${seenSlug.get(slug)})`);
    else seenSlug.set(slug, u);
    const key = u.split('?')[0].replace(/\/+$/, '').toLowerCase();
    if (seenEmbed.has(key)) problems.duplicateEmbed.push(`${slug} == ${seenEmbed.get(key)}`);
    else seenEmbed.set(key, slug);

    const tm = titleMatches(g.title) || urlMatches(u);
    if (tm) {
      // cleanup-ip's "fabricated GameDistribution id" rule is a GUESS about
      // whether a URL resolves, and tools/verify-catalog.mjs MEASURES that, so
      // it is reported rather than failed on. It is also weak: it fires on any
      // 4-char ascending or descending hex run, which turns up in a genuinely
      // random 32-char id often enough to be unremarkable. Worked example --
      // arrowtix-train-your-brain, id 9afeb29876304d269c28d8ca7869b714, flagged
      // for the "9876" at index 6, returns HTTP 200 with its real <title> in
      // the body. A trademark in the NAME is a different kind of claim and
      // stays a hard finding.
      if (/^fake-gd-id:/.test(tm)) informational.suspiciousGdId.push(`${slug.padEnd(38)} ${tm} - confirm with: npm run verify-catalog`);
      else problems.trademark.push(`${slug.padEnd(38)} ${String(g.title).slice(0, 34).padEnd(36)} ${tm}`);
    }

    // Someone else's image file, on someone else's bandwidth.
    if (/^https?:/i.test(thumb)) {
      const tb = brandOf(hostOf(thumb)), gb = brandOf(h);
      if (tb && gb && tb !== gb) problems.foreignThumbnail.push(`${slug.padEnd(36)} game=${h} thumb=${hostOf(thumb)}`);
    } else if (thumb.startsWith('/')) {
      // A self-hosted thumbnail that isn't on disk renders a broken image.
      if (!existsSync(join(ROOT, 'public', thumb.split('?')[0]))) {
        problems.missingLocalThumbnail.push(`${slug} -> ${thumb}`);
      }
    }

    const route = ROUTES.find(([, re]) => re.test(h));
    strategy.set(route ? route[0] : 'UNROUTED (fallback)', (strategy.get(route ? route[0] : 'UNROUTED (fallback)') || 0) + 1);
    if (!route) problems.unroutedHost.push(`${slug} -> ${h}`);
  }

  return { problems, informational, strategy, total: served.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const p = join(ROOT, 'data', 'games-export.json');
  if (!existsSync(p)) { console.error('x data/games-export.json not found. Run: npm run export-games'); process.exit(1); }
  const raw = JSON.parse(readFileSync(p, 'utf8'));
  const served = applyCatalogOverrides(raw.map(g => ({ ...g })));
  const { problems, informational, strategy, total } = auditServed(served);

  console.log('-------- SERVED CATALOG AUDIT --------');
  console.log(`catalogued ${raw.length}  ->  served ${total}\n`);
  console.log('embed strategy (mirrors server.js /play):');
  for (const [k, v] of [...strategy].sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(28)} ${v}`);

  console.log('\nfindings:');
  let hard = 0;
  for (const [name, list] of Object.entries(problems)) {
    console.log(`  ${name.padEnd(24)} ${list.length}`);
    if (!list.length) continue;
    hard += list.length;
    for (const x of list.slice(0, 10)) console.log(`       ${x}`);
    if (list.length > 10) console.log(`       ...and ${list.length - 10} more`);
  }

  const info = Object.entries(informational).filter(([, l]) => l.length);
  if (info.length) {
    console.log('\ninformational (not failures):');
    for (const [name, list] of info) {
      console.log(`  ${name.padEnd(24)} ${list.length}`);
      for (const x of list.slice(0, 10)) console.log(`       ${x}`);
    }
  }

  if (hard === 0) {
    console.log('\nok - the served catalog is clean.');
  } else {
    console.log(`\nx ${hard} finding(s). Hide a game by adding a rule to data/catalog-overrides.json.`);
    process.exit(1);
  }
}
