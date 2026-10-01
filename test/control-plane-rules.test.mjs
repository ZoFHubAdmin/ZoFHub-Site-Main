// The control plane's pure rules: content validation, the lifecycle, the
// provider chain, audit redaction, typed settings and CSV export safety.
// No server, no database — these are the decisions every route delegates to.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateGameInput, transitionFor, TRANSITIONS, STATUSES, slugify, validateCategoryInput,
} from '../lib/cms-rules.mjs';
import { createProviderIndex, validateProvider, normalizeOrigin } from '../lib/provider-registry.mjs';
import { redact, diffFields, REDACTED } from '../lib/audit-redact.mjs';
import { resolveSettings, publicSettings, SETTINGS } from '../lib/settings-registry.mjs';
import { csvCell } from '../lib/admin-api.mjs';

const GD = 'https://html5.gamedistribution.com/d48120b598174ba48e3d35e2733fa575/';
const ok = (over = {}) => ({ title: 'Flip Duel', provider_id: 'gamedistribution', category: 'arcade', game_url: GD, ...over });

describe('game input validation (server-side, whatever the browser sent)', () => {
  test('a well-formed game passes and gets a slug from its title', () => {
    const r = validateGameInput(ok());
    assert.equal(r.ok, true, r.errors.join('; '));
    assert.equal(r.value.slug, 'flip-duel');
  });

  test('HTML and script are REJECTED, not silently stripped', () => {
    for (const title of ['<script>alert(1)</script>', '<img src=x onerror=alert(1)>', 'a&#60;b', 'javascript:alert(1)']) {
      const r = validateGameInput(ok({ title }));
      assert.equal(r.ok, false, `${title} was accepted`);
    }
    assert.equal(validateGameInput(ok({ description: 'Nice game <iframe src=//evil>' })).ok, false);
  });

  test('bidi overrides and line separators are refused (display spoofing)', () => {
    for (const cp of [0x202e, 0x2066, 0x2028, 0x0000, 0x001b]) {
      const r = validateGameInput(ok({ title: `Flip${String.fromCodePoint(cp)}Duel` }));
      assert.equal(r.ok, false, `U+${cp.toString(16)} was accepted`);
    }
  });

  test('dangerous embed URLs are refused', () => {
    const bad = [
      'javascript:alert(1)', 'data:text/html,<script>1</script>', 'http://html5.gamedistribution.com/x/',
      'https://user:pw@html5.gamedistribution.com/x/', 'https://127.0.0.1/', 'https://10.0.0.5/game',
      'https://localhost/game', 'https://169.254.169.254/latest/meta-data/', 'https://2130706433/',
      'https://printer.lan/', 'https://html5.gamedistribution.com:8443/x/', 'file:///etc/passwd',
    ];
    for (const game_url of bad) assert.equal(validateGameInput(ok({ game_url })).ok, false, `${game_url} was accepted`);
  });

  test('thumbnails: same-origin /thumbs/ or https, never SVG', () => {
    assert.equal(validateGameInput(ok({ thumbnail_url: '/thumbs/flip-duel.webp' })).ok, true);
    assert.equal(validateGameInput(ok({ thumbnail_url: '/thumbs/../../server.js' })).ok, false);
    assert.equal(validateGameInput(ok({ thumbnail_url: 'https://img.gamedistribution.com/a.svg' })).ok, false);
    assert.equal(validateGameInput(ok({ thumbnail_url: 'data:image/png;base64,AAAA' })).ok, false);
  });

  test('server-owned fields in the body are ignored, never written (mass assignment)', () => {
    const r = validateGameInput(ok({ status: 'published', id: 9, created_by: 'x', is_working: false, published_at: 'now' }));
    assert.equal(r.ok, true);
    for (const k of ['status', 'id', 'created_by', 'is_working', 'published_at']) assert.equal(k in r.value, false, `${k} leaked through`);
  });

  test('bounds: long text, bad slug, bad tags, bad numbers', () => {
    assert.equal(validateGameInput(ok({ title: 'x'.repeat(121) })).ok, false);
    assert.equal(validateGameInput(ok({ slug: 'Bad Slug!' })).ok, false);
    assert.equal(validateGameInput(ok({ tags: Array.from({ length: 31 }, (_, i) => `t${i}`) })).ok, false);
    assert.equal(validateGameInput(ok({ sort_order: 1.5 })).ok, false);
    assert.equal(validateGameInput(ok({ embed_width: 50 })).ok, false);
    assert.equal(validateGameInput(ok({ featured: 'yes' })).ok, false);
  });

  test('slugify folds accents and never yields a leading/trailing hyphen', () => {
    assert.equal(slugify('  Café — Déjà Vu!! '), 'cafe-deja-vu');
  });

  test('new categories must be strict slugs', () => {
    assert.equal(validateCategoryInput({ slug: 'rhythm', label: 'Rhythm' }).ok, true);
    assert.equal(validateCategoryInput({ slug: 'Rhythm Games', label: 'x' }).ok, false);
    assert.equal(validateCategoryInput({ slug: 'ok', label: '<b>x</b>' }).ok, false);
  });
});

describe('the lifecycle', () => {
  test('every transition names a permission and targets a real state', () => {
    for (const [action, t] of Object.entries(TRANSITIONS)) {
      assert.ok(STATUSES.includes(t.to), `${action} → ${t.to}`);
      assert.match(t.perm, /^games\./);
      for (const f of t.from) assert.ok(STATUSES.includes(f));
    }
  });

  test('a draft cannot jump straight to published', () => {
    assert.equal(transitionFor('publish', 'draft').ok, false);
    assert.equal(transitionFor('approve', 'draft').ok, false);
    assert.equal(transitionFor('submit', 'draft').ok, true);
  });

  test('publishing needs games.publish; reviewing needs games.review', () => {
    assert.equal(transitionFor('publish', 'approved').perm, 'games.publish');
    assert.equal(transitionFor('approve', 'pending_review').perm, 'games.review');
    assert.equal(transitionFor('reject', 'pending_review').needsNote, true);
  });

  test('only archive reaches archived, and only restore leaves it', () => {
    for (const [action, t] of Object.entries(TRANSITIONS)) {
      if (t.to === 'archived') assert.equal(action, 'archive');
      if (t.from.includes('archived')) assert.equal(action, 'restore');
    }
  });
});

describe('the provider chain', () => {
  const idx = createProviderIndex();

  test('an embed must come from the provider\'s own approved origin', () => {
    assert.equal(idx.checkEmbed('gamedistribution', GD), null);
    assert.match(idx.checkEmbed('gamedistribution', 'https://evil.example.org/d48120b598174ba48e3d35e2733fa575/'), /approved origins/);
    assert.match(idx.checkEmbed('gamemonetize', GD), /approved origins/);
  });

  test('a GameDistribution embed is exactly /<32 hex>/', () => {
    assert.match(idx.checkEmbed('gamedistribution', 'https://html5.gamedistribution.com/admin/'), /not a GameDistribution game URL/);
  });

  test('status decides intake and serving', () => {
    assert.equal(idx.acceptsNew('gamedistribution'), true);
    assert.equal(idx.acceptsNew('onlinegames'), false);   // restricted: keeps serving, no new games
    assert.equal(idx.serves('onlinegames'), true);
    assert.equal(idx.serves('gamezop'), false);           // suspended: withheld
    assert.equal(idx.serves('never-heard-of-it'), false, 'an unknown provider id is not a licence');
  });

  test('origins must be real https sites, never IPs or internal names', () => {
    assert.equal(normalizeOrigin('https://img.gamedistribution.com'), 'https://img.gamedistribution.com');
    for (const o of ['http://a.com', 'https://1.2.3.4', 'https://x.internal', 'https://a.com/path', 'https://a.com:8443', 'https://u:p@a.com']) {
      assert.equal(normalizeOrigin(o), null, o);
    }
  });

  test('a sandbox that lets the frame remove its own sandbox is refused', () => {
    const r = validateProvider({ id: 'test-p', name: 'T', sandbox_policy: 'allow-scripts allow-same-origin' });
    assert.equal(r.ok, false);
  });
});

describe('audit redaction', () => {
  test('secret-named keys are replaced whatever their value', () => {
    const out = redact({ password: 'hunter2hunter2', apiKey: 'x', authorization: 'y', csrf: 'z', note: 'fine' });
    assert.equal(out.password, REDACTED);
    assert.equal(out.apiKey, REDACTED);
    assert.equal(out.authorization, REDACTED);
    assert.equal(out.csrf, REDACTED);
    assert.equal(out.note, 'fine');
  });

  test('credential-shaped values are replaced under innocent keys', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
    const values = [jwt, 'sb_secret_abcdefghijklmnop', 'Bearer abcdefghijklmnopqrstuv', '-----BEGIN PRIVATE KEY-----',
      'scrypt$32768$8$1$c2FsdA==$aGFzaA==', 'ghp_' + 'a'.repeat(36)];
    for (const v of values) assert.equal(redact({ note: v }).note, REDACTED, v.slice(0, 20));
    assert.ok(!JSON.stringify(redact({ deep: { deeper: [{ token: 'x', ok: jwt }] } })).includes('eyJ'));
  });

  test('size is bounded', () => {
    assert.ok(redact('x'.repeat(5000)).length < 600);
    assert.equal(redact({ a: { b: { c: { d: { e: 1 } } } } }).a.b.c.d, '[truncated]');
  });

  test('diffs only the named fields, redacted', () => {
    const d = diffFields({ title: 'A', password_hash: 'scrypt$1$2$3$x$y' }, { title: 'B', password_hash: 'scrypt$9$9$9$x$z' }, ['title']);
    assert.deepEqual(d, { title: { from: 'A', to: 'B' } });
  });
});

describe('typed settings', () => {
  test('unknown keys are dropped and bad values fall back to defaults', () => {
    const r = resolveSettings([
      { key: 'shell.exec', value: 'rm -rf /' },
      { key: 'features.ai', value: 'yes' },
      { key: 'site.announcement', value: { active: true, text: '<script>x</script>', level: 'info' } },
    ]);
    assert.equal('shell.exec' in r.values, false);
    assert.equal(r.values['features.ai'], true);
    assert.equal(r.values['site.announcement'].active, false);
    assert.equal(r.problems.length, 2);
  });

  test('only public keys reach visitors', () => {
    const pub = publicSettings(resolveSettings([]).values);
    for (const k of Object.keys(pub)) assert.equal(SETTINGS[k].public, true, k);
    assert.equal('ads.disabled_networks' in pub, false);
    assert.equal('catalog.gd_auto_publish_clean' in pub, false);
  });

  test('ad networks can only be switched off, by known id', () => {
    assert.deepEqual(SETTINGS['ads.disabled_networks'].validate(['exoclick', 'popads']), [['exoclick', 'popads'], null]);
    assert.notEqual(SETTINGS['ads.disabled_networks'].validate(['<script>'])[1], null);
    assert.notEqual(SETTINGS['ads.disabled_networks'].validate(['not-a-network'])[1], null);
  });

  test('a stored list naming a RETIRED network keeps the rest of the list', () => {
    // resolveSettings discards a whole stored value that fails validation. If a
    // retired id failed it, a console that had switched off Monetag and PopAds
    // would silently switch PopAds back ON the day Monetag was retired.
    assert.deepEqual(SETTINGS['ads.disabled_networks'].validate(['adsterra', 'popads']), [['popads'], null]);
    const { values, problems } = resolveSettings([{ key: 'ads.disabled_networks', value: ['monetag', 'popads'] }]);
    assert.deepEqual(values['ads.disabled_networks'], ['popads']);
    assert.deepEqual(problems, []);
  });

  test('the ad-block gate is a console switch, on by default, and never public', () => {
    assert.equal(SETTINGS['ads.adblock_gate'].default, true);
    assert.equal(SETTINGS['ads.adblock_gate'].perm, 'ads.manage');
    assert.notEqual(SETTINGS['ads.adblock_gate'].public, true);
  });
});

describe('CSV export cannot carry a spreadsheet formula', () => {
  test('cells beginning = + - @ are neutralised; quoting is correct', () => {
    assert.equal(csvCell('=HYPERLINK("http://evil","x")'), `"'=HYPERLINK(""http://evil"",""x"")"`);
    for (const s of ['+1+1', '-2', '@SUM(A1)', '\t=1']) assert.ok(csvCell(s).replace(/^"/, '').startsWith("'"), s);
    assert.equal(csvCell('plain'), 'plain');
    assert.equal(csvCell('a,b'), '"a,b"');
    assert.equal(csvCell(null), '');
  });
});
