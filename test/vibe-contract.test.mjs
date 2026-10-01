// The /api/vibe response contract.
//
// The route has three exits — the empty-query guard, the no-attributes
// fallback, and the main ranker — plus a cache replay. They used to return four
// different shapes: the first omitted `understood`, `personalized` and
// `candidates`, the second omitted `candidates`, only the third was complete.
// Nothing failed on the server; the whole cost landed on the client, which had
// to treat every field as possibly-absent and could not distinguish "the ranker
// considered 0 candidates" from "this exit does not report candidates".
//
// public/js/vibe-finder.js now reads those fields directly. These tests are what
// make that safe.
//
// Pure: vibeResponse() takes a plain object and returns one. No server, no
// catalog, no network.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { vibeResponse, VIBE_SOURCES } from '../lib/vibe-engine.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

// Every field a client is entitled to read. Asserted as a literal rather than
// derived from the function, so silently dropping one fails here.
const FIELDS = [
  'cached', 'candidates', 'count', 'games',
  'keywords', 'personalized', 'source', 'understood',
];

describe('the vibe response contract', () => {
  test('every field is present even for a completely empty input', () => {
    assert.deepEqual(Object.keys(vibeResponse()).sort(), FIELDS);
    assert.deepEqual(Object.keys(vibeResponse({})).sort(), FIELDS);
  });

  test('every exit produces an identical key set', () => {
    const exits = [
      vibeResponse({ source: 'empty' }),
      vibeResponse({ games: [{ slug: 'a' }], keywords: ['puzzle'], source: 'local-keywords' }),
      vibeResponse({ games: [{ slug: 'a' }], source: 'attributes', understood: 'calm', candidates: 12 }),
      vibeResponse({ games: [{ slug: 'a' }], source: 'attributes', cached: true }),
    ];
    const keys = exits.map(e => Object.keys(e).sort().join(','));
    assert.equal(new Set(keys).size, 1, `exits disagree about their shape:\n${keys.join('\n')}`);
  });

  test('count is derived from the array, never trusted from the caller', () => {
    // Each exit used to compute this alongside the array, which is a
    // correctness claim nobody checked. A lie must not survive.
    const r = vibeResponse({ games: [{ slug: 'a' }, { slug: 'b' }], count: 99 });
    assert.equal(r.count, 2);
    assert.equal(vibeResponse({ games: [] }).count, 0);
  });

  test('source is always a member of the published enum', () => {
    for (const s of VIBE_SOURCES) assert.equal(vibeResponse({ source: s }).source, s);
    // Anything outside the enum is the exact thing that breaks a client branch,
    // so it is reported as 'fallback' rather than echoed through.
    for (const bad of ['weird', '', null, 42, undefined, 'AI']) {
      assert.ok(VIBE_SOURCES.includes(vibeResponse({ source: bad }).source),
        `source ${JSON.stringify(bad)} escaped the enum`);
    }
  });

  test('hostile or malformed input still yields a valid response', () => {
    // A cached payload written by an older build, or a corrupted object, must
    // not be able to produce a shape the client will crash on.
    for (const junk of [null, undefined, 'string', 42, [], { games: 'not-an-array' }]) {
      const r = vibeResponse(junk);
      assert.deepEqual(Object.keys(r).sort(), FIELDS);
      assert.ok(Array.isArray(r.games));
      assert.equal(r.count, 0);
    }
    assert.deepEqual(vibeResponse({ keywords: 'puzzle' }).keywords, []);
    assert.deepEqual(vibeResponse({ keywords: [1, null, 'ok', ''] }).keywords, ['ok']);
  });

  test('the optional flags are strictly boolean', () => {
    // 'truthy' is not true: a client writing `if (d.personalized)` and a client
    // writing `d.personalized === true` must agree.
    for (const v of ['yes', 1, {}, 'false']) {
      assert.equal(vibeResponse({ personalized: v }).personalized, false);
      assert.equal(vibeResponse({ cached: v }).cached, false);
    }
    assert.equal(vibeResponse({ personalized: true }).personalized, true);
  });

  test('candidates is a non-negative integer', () => {
    assert.equal(vibeResponse({ candidates: 12.7 }).candidates, 12);
    for (const bad of [-1, NaN, Infinity, 'many', null]) {
      assert.equal(vibeResponse({ candidates: bad }).candidates, 0);
    }
  });

  test('keywords are capped so the payload cannot grow unbounded', () => {
    const many = Array.from({ length: 50 }, (_, i) => `k${i}`);
    assert.equal(vibeResponse({ keywords: many }).keywords.length, 10);
  });
});

describe('the route actually uses the contract', () => {
  // A contract nothing calls is documentation. These assert the wiring, because
  // the failure mode — one exit quietly reverting to a hand-built object — is
  // invisible until a client hits that specific path.
  const server = readFileSync(join(ROOT, 'server.js'), 'utf8');
  const start = server.indexOf('async function handleVibe');
  const end = server.indexOf("app.get('/api/vibe'", start);
  const body = server.slice(start, end);

  test('handleVibe was found and is non-trivial', () => {
    assert.ok(start !== -1 && end > start, 'handleVibe() not found — this test checks nothing');
    assert.ok(body.length > 1000);
  });

  test('no exit hand-builds a response object', () => {
    // Every `res.json(` inside handleVibe must go through vibeResponse().
    const calls = [...body.matchAll(/res\.json\(([^)]*)/g)].map(m => m[1].trim());
    assert.ok(calls.length >= 3, `expected at least 3 exits, found ${calls.length}`);
    for (const c of calls) {
      assert.ok(/^vibeResponse|^payload$/.test(c),
        `an exit returns a hand-built object instead of vibeResponse(): res.json(${c}…`);
    }
  });

  test('the client reads the contract fields it relies on', () => {
    const ui = readFileSync(join(ROOT, 'public', 'js', 'vibe-finder.js'), 'utf8');
    for (const f of ['understood', 'keywords', 'personalized', 'games']) {
      assert.match(ui, new RegExp(`d\\.${f}\\b`), `vibe-finder.js never reads d.${f}`);
    }
    // The bug this replaced: an error body was parsed as a result, so a 500
    // rendered as "no matches" — a search that looked like it had worked.
    assert.match(ui, /if \(!r\.ok\)/, 'vibe-finder.js does not check response.ok');
  });
});
