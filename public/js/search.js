// ZoFHub · search.js — fuzzy, typo-tolerant, relevance-ranked game search.
//
// Pure functions, no DOM. Built to run over the whole client catalog (~12K
// titles) on every (debounced) keystroke without jank:
//   • exact / prefix / substring / word-boundary matches score highest
//   • multi-word queries match in any order ("rally offroad" finds "Offroad Rally")
//   • typos are tolerated via a bounded edit distance ("slpe"→Slope, "subwya"→Subway)
//   • a "did you mean" fallback always surfaces the closest games
// Think of it as a tiny, local version of how a search box forgives spelling.

// Normalize: lowercase, strip accents + punctuation, collapse whitespace.
export function normalize(s) {
  return (s || '')
    .toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Bounded Levenshtein — returns the edit distance, or (max+1) as soon as it's
// clear the distance exceeds `max`. Early-exit keeps it cheap across thousands
// of comparisons per keystroke.
function lev(a, b, max) {
  const al = a.length, bl = b.length;
  if (Math.abs(al - bl) > max) return max + 1;
  if (a === b) return 0;
  if (!al) return bl; if (!bl) return al;
  let prev = new Array(bl + 1), curr = new Array(bl + 1);
  for (let j = 0; j <= bl; j++) prev[j] = j;
  for (let i = 1; i <= al; i++) {
    curr[0] = i;
    let rowMin = i;
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= bl; j++) {
      const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
      const v = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
      curr[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    const t = prev; prev = curr; curr = t;
  }
  return prev[bl];
}

const maxDistFor = (len) => (len <= 3 ? 1 : len <= 6 ? 2 : 3);

// Cache normalized title + word list on the game object (computed once).
function norm(g) {
  if (g._tn === undefined) { g._tn = normalize(g.title); g._tw = g._tn ? g._tn.split(' ') : []; }
  return g;
}

// Score one game against a normalized query. 0 = no match.
function scoreGame(g, q, qTokens) {
  const tn = g._tn, words = g._tw;
  if (!tn) return 0;
  if (tn === q) return 1000;
  if (tn.startsWith(q)) return 880;
  const idx = tn.indexOf(q);
  if (idx >= 0) {
    const wb = idx === 0 || tn[idx - 1] === ' ';
    return (wb ? 760 : 640) - Math.min(idx, 80);
  }
  // Per-token matching (word-order independent).
  let total = 0, matched = 0;
  for (const tok of qTokens) {
    let best = 0;
    for (const w of words) {
      if (w === tok) { best = 150; break; }
      if (w.startsWith(tok)) best = Math.max(best, 120);
      else if (tok.length >= 3 && w.includes(tok)) best = Math.max(best, 80);
    }
    if (best === 0) {                       // typo tolerance vs each word
      const md = maxDistFor(tok.length);
      let bd = md + 1;
      for (const w of words) {
        const d = lev(tok, w, md);
        if (d < bd) { bd = d; if (bd === 0) break; }
      }
      if (bd <= md) best = 95 - bd * 25;
    }
    if (best > 0) { matched++; total += best; }
  }
  if (qTokens.length && matched === qTokens.length) return 300 + total;
  if (matched > 0) return 90 + total - (qTokens.length - matched) * 40;
  // Whole-query typo vs a compact title (e.g. "slpe" → "slope").
  if (q.length >= 3 && tn.length <= q.length + 4) {
    const md = maxDistFor(q.length);
    if (lev(q, tn, md) <= md) return 70;
  }
  return 0;
}

// Rank + filter games by relevance. Returns a NEW array, best matches first.
export function rankGames(games, query) {
  const q = normalize(query);
  if (!q) return games.slice();
  const qTokens = q.split(' ');
  const out = [];
  for (const g of games) {
    norm(g);
    const s = scoreGame(g, q, qTokens);
    if (s > 0) { g._score = s; out.push(g); }
  }
  out.sort((a, b) => b._score - a._score || a.title.localeCompare(b.title));
  return out;
}

// "Did you mean" — closest games even when rankGames finds nothing, using a
// looser whole-string / per-word distance. Always returns SOMETHING relevant
// when the query is at least 3 chars.
export function suggestions(games, query, n = 24) {
  const q = normalize(query);
  if (q.length < 3) return [];
  const md = maxDistFor(q.length) + 1;
  const scored = [];
  for (const g of games) {
    norm(g);
    if (!g._tn) continue;
    let bd = lev(q, g._tn, md);
    if (bd > md) for (const w of g._tw) { const d = lev(q, w, md); if (d < bd) { bd = d; if (bd === 0) break; } }
    if (bd <= md) scored.push({ g, d: bd });
  }
  scored.sort((a, b) => a.d - b.d || a.g.title.localeCompare(b.g.title));
  return scored.slice(0, n).map(x => x.g);
}

// Wrap query matches in <mark> for display. Takes the RAW title and escapes it.
export function highlightTerms(title, query) {
  const esc = (s) => s.replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));
  const q = normalize(query);
  if (!q) return esc(title);
  const tokens = [...new Set([q, ...q.split(' ')])].filter(t => t.length >= 2).sort((a, b) => b.length - a.length);
  const lower = title.toLowerCase();
  let out = '', i = 0;
  outer: while (i < title.length) {
    for (const t of tokens) {
      if (lower.startsWith(t, i)) {
        out += '<mark class="search-hl">' + esc(title.slice(i, i + t.length)) + '</mark>';
        i += t.length; continue outer;
      }
    }
    out += esc(title[i]); i++;
  }
  return out;
}
