// tools/verify-thumbnails.mjs — every self-hosted thumbnail a catalog override
// points at must actually exist on disk.
// Run:  npm run verify-thumbs
//
// WHY THIS EXISTS
// data/catalog-overrides.json can set any thumbnail_url it likes, and the app is
// deliberately forgiving: a dead thumbnail is swapped for a styled fallback tile
// by wireThumbFallback(), with no error anywhere. That is right for a CDN that
// went down, but it also means a typo in a local path — or a file that was never
// committed — degrades silently to a coloured square with initials on it, and
// nobody notices for weeks.
//
// This makes the local half of that contract checkable: an override naming
// /thumbs/foo.webp must be backed by public/thumbs/foo.webp. Remote URLs are
// left alone on purpose; whether a third party's CDN answers today is not
// something a build step should have an opinion about.

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export function checkThumbnails() {
  const file = join(ROOT, 'data', 'catalog-overrides.json');
  if (!existsSync(file)) return { checked: 0, missing: [], remote: 0 };

  let raw;
  try { raw = JSON.parse(readFileSync(file, 'utf8')); }
  catch (e) { return { checked: 0, missing: [], remote: 0, parseError: e.message }; }

  const entries = [
    ...(Array.isArray(raw.patch) ? raw.patch : []),
    ...(Array.isArray(raw.add) ? raw.add : []),
  ];

  const missing = [];
  let checked = 0, remote = 0;
  for (const e of entries) {
    const url = e?.set?.thumbnail_url ?? e?.thumbnail_url;
    if (typeof url !== 'string' || !url) continue;
    if (/^https?:\/\//i.test(url)) { remote++; continue; }
    checked++;
    const abs = join(ROOT, 'public', url.replace(/^\//, ''));
    if (!existsSync(abs)) missing.push({ slug: e?.match?.slug ?? e?.slug ?? '(unnamed rule)', url });
  }
  return { checked, missing, remote };
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href) {
  const r = checkThumbnails();
  if (r.parseError) {
    console.error(`[verify-thumbnails] data/catalog-overrides.json does not parse: ${r.parseError}`);
    process.exit(1);
  }
  console.log(`[verify-thumbnails] ${r.checked} self-hosted thumbnail(s) referenced, ${r.remote} left on remote URLs.`);
  if (r.missing.length) {
    console.error(`[verify-thumbnails] ${r.missing.length} reference a file that does not exist:`);
    for (const m of r.missing) console.error(`   ${m.slug.padEnd(34)} ${m.url}`);
    console.error('\nThese render as the fallback tile, silently. Add the file or fix the path.');
    process.exit(1);
  }
  console.log('[verify-thumbnails] every referenced file is present.');
}
