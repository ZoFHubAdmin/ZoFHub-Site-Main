// Shared AI system prompt and grounding.
//
// ONE file, imported by all three AI paths — public/js/pollinations.js,
// public/js/ai.js and server.js. It lives under public/js so the browser can
// load it as a static module and the server can import the same file from disk;
// there is deliberately no second copy to drift out of step.
//
// WHY THIS FILE EXISTS
// The three call sites each carried their own copy of this prompt:
//
//   'You are ZoFHub AI, a friendly, concise assistant for students.
//    Reply in clear markdown.'
//
// Nothing in it told the model not to invent facts, and "friendly, concise
// assistant" rewards confident prose over accurate prose. Asked who made a
// game, the model produced named authors, date ranges and a house style of
// backstory, all fabricated.
//
// The "ZoFHub AI" identity made it specifically worse. Told it IS ZoFHub, the
// model invented ZoFHub provenance for third-party games — "developed for
// ZoFHub between 2013-2015", "a ZoFHub classic" — for a game ZoFHub embeds from
// another site and had nothing to do with. That is not a generic hallucination;
// the prompt produced it.
//
// Two layers of defence here, because a prompt alone is not a guarantee:
//   1. Explicit refusal rules for the categories that get fabricated most —
//      people, dates, studios, provenance.
//   2. Retrieval: when the question is about a game we hold metadata for, the
//      VERIFIED fields are put in the prompt and the model is told those are the
//      only facts it has. Grounding beats instruction.

export const AI_DISCLAIMER =
  'AI can make mistakes. Verify anything important — do not treat these answers as fact.';

// Fields we can actually stand behind: they come from the catalog, not the model.
const VERIFIABLE = ['title', 'category', 'provider', 'plays'];

export const SYSTEM_PROMPT = [
  'You are ZoFHub AI, a helpful assistant for students on a browser-games site.',
  'Reply in clear markdown. Be concise unless asked for detail.',
  '',
  'ACCURACY RULES — these override helpfulness. A short honest answer is a good',
  'answer; an invented one is a failure, however well written.',
  '',
  '1. Never state a fact you are not sure of. If you do not know, say so plainly:',
  '   "I do not have verified information about that." Then stop, or offer what',
  '   you can actually support.',
  '2. Never invent people, studios, developers, publishers, dates, version',
  '   histories, sales figures, awards or origin stories. These are the things',
  '   most often fabricated. If asked who made something and you do not have a',
  '   VERIFIED FACTS block confirming it, say you do not know who made it.',
  '3. ZoFHub did not create, develop, publish or commission any game. It is a',
  '   site that lists and embeds games made by other people. Never describe a',
  '   game as made for ZoFHub, built by ZoFHub, or a "ZoFHub classic". If a',
  '   VERIFIED FACTS block names a provider, that is who supplies the game, not',
  '   who wrote it.',
  '4. When a VERIFIED FACTS block is present, those fields are the only facts you',
  '   have about that game. Use them. Do not add biography, history or trivia',
  '   around them, and do not fill gaps by inference.',
  '5. Separate what is known from what is guessed. Phrases like "I think" or',
  '   "typically" are fine for general gameplay description; never use them to',
  '   introduce a specific name, date or number.',
  '6. General knowledge — maths, science, homework, how a genre works — is fine',
  '   to answer normally. These rules are about specific unverifiable claims.',
].join('\n');

// Questions that reach for provenance are exactly the ones that get fabricated.
// Kept deliberately broad: a false positive only adds a grounding block, while a
// false negative lets an invented developer through.
const PROVENANCE_RE =
  /\b(who\s+(made|created|developed|owns|published|designed)|creators?|developers?|publishers?|studios?|authors?|invented|origins?|history|when\s+(was|did).{0,24}(made|created|released|come\s+out)|release\s+dates?|founded)\b/i;

/** Does this question reach for facts the model would otherwise invent? */
export function looksLikeProvenanceQuestion(text) {
  return typeof text === 'string' && PROVENANCE_RE.test(text);
}

/**
 * Find catalog games the question plausibly refers to.
 *
 * Title-substring, longest first, so "Snow Rider 3D" wins over "Snow". Requires
 * three characters to avoid matching every game whose title contains "io".
 */
export function findMentionedGames(text, games, { limit = 3 } = {}) {
  if (typeof text !== 'string' || !text.trim() || !Array.isArray(games)) return [];
  const hay = text.toLowerCase();
  const hits = [];
  for (const g of games) {
    const title = String(g?.title || '').trim();
    if (title.length < 3) continue;
    if (hay.includes(title.toLowerCase())) hits.push(g);
  }
  hits.sort((a, b) => String(b.title).length - String(a.title).length);
  // Drop titles wholly contained in a longer match already found — "Snow Rider"
  // adds nothing once "Snow Rider 3D" is in the block.
  const kept = [];
  for (const g of hits) {
    const t = String(g.title).toLowerCase();
    if (!kept.some((k) => String(k.title).toLowerCase().includes(t))) kept.push(g);
    if (kept.length >= limit) break;
  }
  return kept;
}

/**
 * Render verified catalog metadata as a prompt block.
 *
 * Only fields the catalog actually holds. There is no author or release-date
 * column, and the block says so explicitly — otherwise the model treats the
 * absence as an invitation to supply one.
 */
export function groundingBlock(games) {
  const list = (Array.isArray(games) ? games : []).filter(Boolean);
  if (!list.length) return '';
  const lines = ['VERIFIED FACTS (from the ZoFHub catalog — the ONLY facts you have about these games):'];
  for (const g of list) {
    const parts = [];
    for (const f of VERIFIABLE) {
      const v = g[f];
      if (v === null || v === undefined || v === '') continue;
      parts.push(`${f}: ${String(v).slice(0, 120)}`);
    }
    const where = g.game_url || g.embed_url || '';
    if (where) {
      let host = '';
      try { host = new URL(where, 'https://zofhub.local').host; } catch { /* relative */ }
      parts.push(host && !host.endsWith('zofhub.local')
        ? `served from: ${host} (a third party — NOT made by ZoFHub)`
        : 'served from: this site');
    }
    lines.push(`- ${parts.join(' | ')}`);
  }
  lines.push('');
  lines.push('The catalog holds NO author, developer, studio, release date or version');
  lines.push('history for these games. That information is genuinely unavailable to you.');
  lines.push('If asked for it, say you do not have verified information about who made');
  lines.push('the game — do NOT guess, and do NOT credit ZoFHub.');
  return lines.join('\n');
}

/** The full system prompt, with any grounding appended. */
export function buildSystemPrompt(grounding = '') {
  const g = typeof grounding === 'string' ? grounding.trim() : '';
  return g ? `${SYSTEM_PROMPT}\n\n${g}` : SYSTEM_PROMPT;
}
