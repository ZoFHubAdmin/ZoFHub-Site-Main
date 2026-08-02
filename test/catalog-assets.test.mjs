// Catalog asset integrity.
//
// A dead thumbnail is handled gracefully at runtime — wireThumbFallback() swaps
// the broken <img> for a styled tile — which is right for a third-party CDN that
// went down, and wrong as a way to discover that a file in our own repo is
// missing. That failure is completely silent: no console error, no 404 anybody
// looks at, just a coloured square with initials where art should be.
//
// These tests close the half of the problem we control.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkThumbnails } from '../tools/verify-thumbnails.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

describe('self-hosted thumbnails exist', () => {
  test('every local thumbnail an override points at is present on disk', () => {
    const r = checkThumbnails();
    assert.equal(r.parseError, undefined, `catalog-overrides.json does not parse: ${r.parseError}`);
    assert.ok(r.checked > 100, `only ${r.checked} local thumbnails checked — the scan is probably broken`);
    assert.deepEqual(
      r.missing, [],
      'these overrides name a file that does not exist, so the tiles silently fall back:\n  '
      + r.missing.map(m => `${m.slug} -> ${m.url}`).join('\n  '),
    );
  });

  test('the 13 games whose upstream CDN assets died are all self-hosted now', () => {
    // REGRESSION: every one of these was pointing at a third-party CDN that had
    // started returning 403, or a 52-byte stub image. The catalog said the
    // thumbnails were fine; the network disagreed. They are pinned to local
    // files so a third party cannot break them again.
    const SLUGS = ['vex-9', 'vex-3', 'vex-x3m', 'run-3d', 'fruit-ninja', 'rooftop-run',
      'magic-tiles-3', 'red-light-green-light', 'attractive', 'purple-clicker-game',
      'green-clicker-game', 'suroi', 'bloxd-io'];

    const raw = JSON.parse(readFileSync(join(root, 'data', 'catalog-overrides.json'), 'utf8'));
    const bySlug = new Map(
      (raw.patch || [])
        .filter(p => p?.match?.slug)
        .map(p => [String(p.match.slug).toLowerCase(), p]),
    );

    const problems = [];
    for (const slug of SLUGS) {
      const p = bySlug.get(slug);
      if (!p) { problems.push(`${slug}: no override`); continue; }
      const url = p.set?.thumbnail_url;
      if (!url) { problems.push(`${slug}: override sets no thumbnail_url`); continue; }
      if (/^https?:\/\//i.test(url)) { problems.push(`${slug}: still remote (${url})`); continue; }
      if (!existsSync(join(root, 'public', url.replace(/^\//, '')))) problems.push(`${slug}: ${url} missing`);
    }
    assert.deepEqual(problems, [], problems.join('; '));
  });
});

describe('the replacement artwork is ours', () => {
  // These five slugs previously carried, or would have carried, third-party
  // material: a televised series' characters, another company's logo, and a
  // screenshot collage lifted from a site with no licence chain to us. They are
  // now original SVGs authored for this repo. If one is ever swapped back for a
  // binary someone downloaded, that is worth failing a build over on a site
  // that runs ads.
  const ORIGINAL = ['vex-x3m', 'purple-clicker-game', 'green-clicker-game', 'suroi',
                    'bloxd-io', 'red-light-green-light', 'magic-tiles-3'];

  test('each is an SVG that parses and carries its provenance note', () => {
    for (const slug of ORIGINAL) {
      const p = join(root, 'public', 'thumbs', `${slug}.svg`);
      assert.ok(existsSync(p), `${slug}.svg is missing`);
      const svg = readFileSync(p, 'utf8');
      assert.match(svg, /^<svg[\s\S]*<\/svg>\s*$/, `${slug}.svg is not a well-formed SVG document`);
      assert.match(svg, /viewBox="0 0 400 400"/, `${slug}.svg is not the square the 1:1 tile expects`);
      assert.match(svg, /Original generic artwork for ZoFHub/,
        `${slug}.svg has lost the comment recording that it is original work`);
      assert.match(svg, /role="img"[\s\S]*?aria-label="[^"]{10,}"/,
        `${slug}.svg needs an aria-label — it is content, not decoration`);
      // An <image> element would mean a raster was embedded inside the SVG,
      // which is exactly the thing these files exist to avoid.
      assert.doesNotMatch(svg, /<image\b/, `${slug}.svg embeds a raster image`);
      assert.doesNotMatch(svg, /<script\b/, `${slug}.svg contains script`);
    }
  });

  test('the superseded raster files are gone from the web root', () => {
    // Deleting the override is not enough: public/thumbs is served statically,
    // so a leftover file stays fetchable at its old URL by anyone who knows it.
    for (const stale of ['red-light-green-light.jpg', 'magic-tiles-3.jpg', 'bloxd-io.jpg']) {
      assert.ok(!existsSync(join(root, 'public', 'thumbs', stale)),
        `public/thumbs/${stale} is still served — it was replaced for a reason`);
    }
  });
});
