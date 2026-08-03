// Catalog quality — the structural half of tools/audit-catalog.mjs.
//
// That tool already finds dead embeds well, but every check lived inline in a
// CLI script, which meant the only way to exercise any of it was to run a live
// network sweep over ~16,000 games. So it had no tests, and the purely
// structural checks — the ones that need no network at all — could not be reused
// by the server or the admin panel.
//
// This file is the extraction. No network, no database, no filesystem: give it
// game objects, get back issues.
//
// WHAT IS AND IS NOT GROUNDS FOR HIDING A GAME
// A missing thumbnail is NOT. wireThumbFallback() renders a styled tile with the
// game's initials, the game plays perfectly, and thousands of catalogue entries
// are in that state — auto-hiding on that basis would empty the site to fix a
// cosmetic problem. Only three things make an entry genuinely unusable: nothing
// to load, nothing to call it, or an identical entry already present. Those are
// marked removable; everything else is reported and left alone.

// Both runtime shapes reach these functions: the in-memory catalog uses
// embed_url/thumbnail, Supabase rows use game_url/thumbnail_url.
const urlOf = (g) => String(g?.game_url || g?.embed_url || g?.url || '').trim();
const thumbOf = (g) => String(g?.thumbnail_url ?? g?.thumbnail ?? '').trim();
const titleOf = (g) => String(g?.title ?? '').trim();
const slugOf = (g) => String(g?.slug ?? '').trim().toLowerCase();

// Titles that exist but say nothing. These come from importers that fell back to
// a variable that was never set, and they render as a real game the player then
// cannot identify.
const PLACEHOLDER_TITLES = new Set([
  '', 'undefined', 'null', 'nan', 'untitled', 'unknown', 'game', 'games',
  'new game', 'test', 'test game', 'index', 'default', 'none', 'n/a', '-', '--',
]);

// Query parameters that identify the referrer rather than the game. Two rows
// pointing at the same GameDistribution hash with different referrer values are
// the same game listed twice, and without stripping these they never compare
// equal. Only a known list is removed — some providers really do select the game
// with a query parameter, and dropping those would merge distinct games.
const TRACKING_PARAMS = new Set([
  'gd_sdk_referrer_url', 'ref', 'referrer', 'referer', 'fbclid', 'gclid', 'msclkid',
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
]);

export const SEVERITY = { BROKEN: 'broken', DUPLICATE: 'duplicate', INCOMPLETE: 'incomplete', COSMETIC: 'cosmetic' };

// Severities that justify hiding a game automatically. Cosmetic never appears
// here, and that is the whole safety argument for letting this run unattended.
export const REMOVABLE_SEVERITIES = new Set([SEVERITY.BROKEN, SEVERITY.DUPLICATE, SEVERITY.INCOMPLETE]);

// When several removable issues apply to one row, this decides which one gets
// reported as THE reason. A nameless duplicate is worth reporting as a
// duplicate: "there is already a copy of this" tells the operator what happened,
// where "no title" only describes a symptom of the same import.
const SEVERITY_RANK = { [SEVERITY.BROKEN]: 3, [SEVERITY.DUPLICATE]: 2, [SEVERITY.INCOMPLETE]: 1, [SEVERITY.COSMETIC]: 0 };

export const ISSUE_LABELS = {
  'no-url':            'No embed URL — nothing to load',
  'bad-url':           'Embed URL is not a usable address',
  'no-title':          'No title',
  'placeholder-title': 'Title is a placeholder, not a name',
  'duplicate-slug':    'Another entry already uses this slug',
  'duplicate-url':     'Another entry already points at this game',
  'no-thumbnail':      'No thumbnail (renders the fallback tile)',
  'no-category':       'No category — will not appear under any browse filter',
};

/**
 * Canonical form of an embed URL for duplicate detection. Returns '' when the
 * URL is unusable, which the caller reads as "cannot be compared", not "empty".
 */
export function normalizeUrl(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  // Site-relative embeds (/games/foo/index.html) are legitimate and are not URLs
  // the URL parser will take without a base.
  if (s.startsWith('/')) return s.toLowerCase().replace(/\/+$/, '');
  let u;
  try { u = new URL(s); } catch { return ''; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
  for (const key of [...u.searchParams.keys()]) {
    if (TRACKING_PARAMS.has(key.toLowerCase())) u.searchParams.delete(key);
  }
  u.hash = '';
  u.protocol = 'https:';                        // http/https of the same game is one game
  u.host = u.host.toLowerCase();
  const path = u.pathname.replace(/\/+$/, '');
  const qs = u.searchParams.toString();
  return `${u.host}${path}${qs ? '?' + qs : ''}`.toLowerCase();
}

/** Structural issues visible from a single row, with no view of the catalog. */
export function inspectGame(game) {
  const issues = [];
  const url = urlOf(game);
  const title = titleOf(game);

  if (!url) {
    issues.push({ kind: 'no-url', severity: SEVERITY.BROKEN });
  } else if (!normalizeUrl(url)) {
    // Reached only for a non-empty URL that will not parse or uses a scheme a
    // browser will not put in an iframe (javascript:, data:, ftp:).
    issues.push({ kind: 'bad-url', severity: SEVERITY.BROKEN, detail: url.slice(0, 120) });
  }

  if (!title) {
    issues.push({ kind: 'no-title', severity: SEVERITY.INCOMPLETE });
  } else if (PLACEHOLDER_TITLES.has(title.toLowerCase())) {
    // An explicit list only. A "titles that look like junk" heuristic was tried
    // and rejected: the first rule written — numeric-only titles — hides 2048,
    // and 1010!, 99 Balls and 8 Ball Pool are the same shape. The cost of
    // hiding a real game is far higher than leaving one bad title visible.
    issues.push({ kind: 'placeholder-title', severity: SEVERITY.INCOMPLETE, detail: title.slice(0, 60) });
  }

  if (!thumbOf(game) || /default-placeholder/i.test(thumbOf(game))) {
    issues.push({ kind: 'no-thumbnail', severity: SEVERITY.COSMETIC });
  }
  if (!String(game?.category ?? '').trim()) {
    issues.push({ kind: 'no-category', severity: SEVERITY.COSMETIC });
  }
  return issues;
}

// Which of two duplicate rows to keep. Completeness first — a row with a title
// and a thumbnail is more useful than a bare one — then the lower id, so the
// choice is stable across runs and does not churn the catalog every sweep.
function completeness(g) {
  let n = 0;
  if (titleOf(g) && !PLACEHOLDER_TITLES.has(titleOf(g).toLowerCase())) n += 4;
  if (thumbOf(g) && !/default-placeholder/i.test(thumbOf(g))) n += 2;
  if (String(g?.category ?? '').trim()) n += 1;
  return n;
}

function preferred(a, b) {
  const ca = completeness(a), cb = completeness(b);
  if (ca !== cb) return ca > cb ? a : b;
  const ia = Number(a?.id), ib = Number(b?.id);
  if (Number.isFinite(ia) && Number.isFinite(ib) && ia !== ib) return ia < ib ? a : b;
  return a;
}

/**
 * Audit a whole catalog.
 *
 * Returns every issue found, plus `removable` — the entries that are genuinely
 * unusable and can be hidden without a judgement call. The caller decides
 * whether to act on it; nothing here writes anything.
 */
export function auditGames(games, { maxExamples = 25 } = {}) {
  const list = Array.isArray(games) ? games.filter((g) => g && typeof g === 'object') : [];
  const found = new Map();          // index -> { game, issues[] }
  const note = (i, game, issue) => {
    if (!found.has(i)) found.set(i, { game, issues: [] });
    found.get(i).issues.push(issue);
  };

  list.forEach((g, i) => {
    for (const issue of inspectGame(g)) note(i, g, issue);
  });

  // ── Duplicates ───────────────────────────────────────────────────────────
  // Grouped, then every member except the preferred one is marked. Marking both
  // sides would hide the game entirely, which is the opposite of the intent.
  const groupBy = (keyFn) => {
    const groups = new Map();
    list.forEach((g, i) => {
      const k = keyFn(g);
      if (!k) return;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push({ g, i });
    });
    return groups;
  };

  const dupeCounts = { slug: 0, url: 0 };
  for (const [kind, keyFn] of [['duplicate-slug', slugOf], ['duplicate-url', (g) => normalizeUrl(urlOf(g))]]) {
    for (const [key, members] of groupBy(keyFn)) {
      if (members.length < 2) continue;
      dupeCounts[kind === 'duplicate-slug' ? 'slug' : 'url']++;
      const keep = members.reduce((best, m) => (preferred(best.g, m.g) === best.g ? best : m));
      for (const m of members) {
        if (m === keep) continue;
        note(m.i, m.g, {
          kind, severity: SEVERITY.DUPLICATE,
          detail: `${key.slice(0, 90)} — keeping ${slugOf(keep.g) || 'the other entry'}`,
        });
      }
    }
  }

  // ── Roll up ──────────────────────────────────────────────────────────────
  const byKind = {};
  const bySeverity = { broken: 0, duplicate: 0, incomplete: 0, cosmetic: 0 };
  const examples = {};
  const removable = [];

  for (const { game, issues } of found.values()) {
    let worst = null;
    for (const issue of issues) {
      byKind[issue.kind] = (byKind[issue.kind] || 0) + 1;
      bySeverity[issue.severity]++;
      if (!examples[issue.kind]) examples[issue.kind] = [];
      if (examples[issue.kind].length < maxExamples) {
        examples[issue.kind].push({
          slug: slugOf(game) || null, title: titleOf(game) || null,
          id: game.id ?? null, detail: issue.detail ?? null,
        });
      }
      if (REMOVABLE_SEVERITIES.has(issue.severity) &&
          (!worst || SEVERITY_RANK[issue.severity] > SEVERITY_RANK[worst.severity])) {
        worst = issue;
      }
    }
    if (worst) {
      removable.push({
        id: game.id ?? null, slug: slugOf(game) || null, title: titleOf(game) || null,
        reason: worst.kind, severity: worst.severity,
      });
    }
  }

  return {
    total: list.length,
    affected: found.size,
    healthy: list.length - found.size,
    byKind, bySeverity, examples, removable,
    duplicateGroups: dupeCounts,
    // A single number for the admin overview. Cosmetic issues are excluded on
    // purpose: a thumbnail-less game is a fully playable game.
    score: list.length ? Math.round(((list.length - removable.length) / list.length) * 1000) / 10 : 100,
  };
}
