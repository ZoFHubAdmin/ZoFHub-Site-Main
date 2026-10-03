// lib/game-seo.mjs — per-game SEO content from verified metadata only.
// Pure and deterministic, so it is fully testable without a browser or network.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  tagList, gameDescription, metaDescription, seoTitle, canonicalUrl,
  jsonLdString, detailRows, descriptionSectionHtml, categorySlug, seoPayload,
} from '../lib/game-seo.mjs';

const basketball = { title: 'Basketball Random', slug: 'basketball-random', category: 'sports', tags: '2 Player,Basketball,Ragdoll,Arcade' };
const vex = { title: 'Vex 10', slug: 'vex-10', category: 'skill', tags: ['Platform', 'Parkour', 'Stickman', 'Runner'] };
const bare = { title: 'Mystery Blocks', slug: 'mystery-blocks', category: 'puzzle' };
const stored = { title: 'Deep Game', slug: 'deep-game', category: 'adventure',
  description: 'A hand-written description that is clearly substantive, well over sixty characters, with far more than ten words in it.' };

describe('descriptions are unique, grounded, and honestly sourced', () => {
  test('two different games get materially different descriptions', () => {
    const a = gameDescription(basketball);
    const b = gameDescription(vex);
    assert.equal(a.source, 'generated');
    assert.equal(b.source, 'generated');
    assert.notEqual(a.text, b.text, 'descriptions must differ between games');
    assert.match(a.text, /Basketball Random/);
    assert.match(a.text, /sports/);
    assert.match(a.text, /head-to-head/, 'a 2-player tag should surface the two-player line');
    assert.match(b.text, /Vex 10/);
    assert.doesNotMatch(b.text, /head-to-head/, 'Vex 10 has no 2-player tag, so no two-player claim');
  });

  test('a game with no tags gets a SHORT factual description marked for review, not invented detail', () => {
    const d = gameDescription(bare);
    assert.equal(d.source, 'minimal');
    assert.match(d.text, /Mystery Blocks/);
    assert.match(d.text, /puzzle/);
    // It must not invent mechanics/modes it has no evidence for.
    assert.doesNotMatch(d.text, /head-to-head|built around|themes/);
  });

  test('a substantive stored description wins and is returned verbatim (trimmed)', () => {
    const d = gameDescription(stored);
    assert.equal(d.source, 'stored');
    assert.equal(d.text, stored.description);
  });

  test('a one-word stored stub does NOT count as a real description', () => {
    assert.equal(gameDescription({ ...bare, description: 'Fun!' }).source, 'minimal');
  });

  test('same input → identical output (deterministic, cacheable)', () => {
    assert.equal(gameDescription(vex).text, gameDescription(vex).text);
    assert.equal(metaDescription(basketball), metaDescription(basketball));
  });
});

describe('metadata fields', () => {
  test('meta description: <=160 chars, unique, names the game, no keyword stuffing', () => {
    const m = metaDescription(basketball);
    assert.ok(m.length <= 160, `meta too long: ${m.length}`);
    assert.match(m, /Basketball Random/);
    assert.notEqual(metaDescription(basketball), metaDescription(vex));
    // "free"/"games"/"online" should each appear at most a couple of times.
    assert.ok((m.toLowerCase().match(/free/g) || []).length <= 1);
  });

  test('SEO title adds "Play Online" only when the title is short enough', () => {
    assert.equal(seoTitle(basketball), 'Basketball Random — Play Online | ZoFHub');
    const long = seoTitle({ title: 'Super Ultra Mega Extreme Racing Championship Deluxe Tournament' });
    assert.match(long, /\| ZoFHub$/);
    assert.doesNotMatch(long, /Play Online/);
  });

  test('canonical URL is https origin + /play/<slug>', () => {
    assert.equal(canonicalUrl('basketball-random', 'https://zofhub.com'), 'https://zofhub.com/play/basketball-random');
    assert.equal(canonicalUrl('x', 'https://zofhub.com/'), 'https://zofhub.com/play/x');
  });

  test('tagList accepts a string or an array, dedupes, and bounds', () => {
    assert.deepEqual(tagList({ tags: 'A, b ,A,' }), ['A', 'b']);
    assert.deepEqual(tagList(vex), ['Platform', 'Parkour', 'Stickman', 'Runner']);
    assert.ok(tagList({ tags: Array.from({ length: 50 }, (_, i) => `t${i}`) }).length <= 12);
  });

  test('detail rows only appear when backed by data', () => {
    const b = detailRows(basketball);
    assert.ok(b.some((r) => r.label === 'Category' && /sports/i.test(r.value)));
    assert.ok(b.some((r) => r.label === 'Players'), 'Basketball Random is 2-player');
    assert.ok(detailRows(vex).every((r) => r.label !== 'Players'), 'Vex 10 is not flagged multiplayer');
    assert.ok(b.some((r) => r.label === 'Price' && /free/i.test(r.value)));
    assert.equal(categorySlug('Racing & Driving'), 'racing-and-driving');
  });
});

describe('JSON-LD is valid and script-safe', () => {
  test('parses, carries only verified fields, and prices the game free', () => {
    const s = jsonLdString(basketball, { origin: 'https://zofhub.com', image: 'https://img/x.jpg' });
    assert.doesNotMatch(s, /</, 'raw < would let the payload break out of <script>');
    const o = JSON.parse(s);
    assert.equal(o['@type'], 'VideoGame');
    assert.equal(o.name, 'Basketball Random');
    assert.equal(o.genre, 'sports');
    assert.equal(o.offers.price, '0');
    assert.equal(o.url, 'https://zofhub.com/play/basketball-random');
    assert.equal(o.image, 'https://img/x.jpg');
    // Never fabricated:
    assert.ok(!('author' in o) && !('aggregateRating' in o) && !('datePublished' in o));
  });
});

describe('untrusted metadata can never inject markup', () => {
  const evil = {
    title: '<script>alert(1)</script>', slug: 'x', category: 'action',
    tags: '<img src=x onerror=alert(1)>,Fun',
    description: '<b>pwn</b> yet long enough to be treated as a substantive stored description over sixty chars and ten words.',
  };
  test('the visible section escapes every value', () => {
    const html = descriptionSectionHtml(evil);
    // No raw markup — the onerror text survives only as inert, escaped text
    // inside &lt;img…&gt;, which cannot execute.
    assert.doesNotMatch(html, /<script|<img|<b>|<\/b>/, 'raw tags leaked into the page');
    assert.match(html, /&lt;script&gt;/, 'title should be escaped, not dropped');
    assert.doesNotMatch(html, /<[a-z]+[^>]*onerror/i, 'no executable onerror attribute on a real tag');
  });
  test('JSON-LD stays script-safe even with hostile input', () => {
    const s = jsonLdString(evil, { origin: 'https://zofhub.com' });
    assert.doesNotMatch(s, /</);
    JSON.parse(s); // still valid JSON
  });
});

describe('the bundled payload the /play handler consumes', () => {
  test('has every field the template needs', () => {
    const p = seoPayload(basketball, { origin: 'https://zofhub.com', image: 'https://img/x.jpg' });
    for (const k of ['seoTitle', 'metaDescription', 'canonical', 'descriptionText', 'descriptionSource', 'descriptionHtml', 'jsonLd']) {
      assert.ok(p[k], `payload missing ${k}`);
    }
    assert.match(p.descriptionHtml, /class="game-about"/);
    assert.equal(p.canonical, 'https://zofhub.com/play/basketball-random');
  });
});
