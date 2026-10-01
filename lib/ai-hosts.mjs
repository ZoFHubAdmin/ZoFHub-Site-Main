// lib/ai-hosts.mjs — inference endpoints this server must never fetch.
// ---------------------------------------------------------------------------
// ZoFHub's AI runs in the visitor's browser. Several routes, though, fetch a URL
// on a caller's behalf: /asset (the general cross-origin GET proxy the game
// shim uses to fix WebGL canvas tainting), /thumb (the thumbnail cache) and
// /api/proxy/diag (the embed self-test). Aimed at an inference endpoint, any of
// them makes THIS server generate and download AI output on its own IP and
// bandwidth — verified before the first guard existed, when /asset relayed a
// Pollinations API response verbatim.
//
// This list used to be one regular expression inside server.js. It moved here
// for three reasons, each a real hole in the old form:
//
//   1. A TRAILING DOT. `api.openai.com.` is the fully-qualified spelling of the
//      same host — DNS resolves it and TLS accepts it — but it did not match a
//      pattern anchored with `$`. Hosts are normalised before comparison now.
//   2. REDIRECTS. Only the caller's URL was checked; a public host answering
//      `302 Location: https://text.pollinations.ai/...` was followed. The same
//      predicate is now enforced on every hop inside lib/safe-fetch.mjs.
//   3. CHAINING. `/asset?u=https://some-cors-relay.example/?url=https://api.openai.com/...`
//      names a harmless host and smuggles the real target in its query string.
//      mentionsAiProvider() looks inside the path and query as well.
//
// A denylist rather than an allowlist on purpose: /asset serves an open-ended
// set of game CDNs, and an allowlist would break games. No legitimate game
// asset lives on an inference endpoint.
//
// COUNTING. The old expression had twenty distinct rules (two of its twenty-two
// alternatives, api.openrouter.ai and api-inference.huggingface.co, were
// already covered by their parent domains). Two rules each spanned two TLDs —
// Cohere on .ai and .com, fal on .ai and .run — so written out as plain domains
// the same twenty rules are the twenty-two entries below. Every entry also
// covers all of its subdomains.
// ---------------------------------------------------------------------------

export const AI_PROVIDER_HOSTS = Object.freeze([
  'pollinations.ai',                    // text., image., gen. — the site's browser-direct provider
  'aihorde.net',
  'stablehorde.net',
  'openai.com',
  'anthropic.com',
  'claude.ai',
  'generativelanguage.googleapis.com',
  'api.groq.com',
  'api.mistral.ai',
  'api.cohere.ai',
  'api.cohere.com',
  'api.deepseek.com',
  'api.together.xyz',
  'api.replicate.com',
  'replicate.delivery',
  'fal.ai',
  'fal.run',
  'openrouter.ai',                      // covers api.openrouter.ai
  'huggingface.co',                     // covers api-inference.huggingface.co
  'api.stability.ai',
  'api.x.ai',
  'api.perplexity.ai',
]);

/**
 * Canonical form of a hostname for comparison: lower case, IPv6 brackets
 * removed, and every trailing dot stripped (`host.` and `host..` both name
 * `host` to a resolver, so both must compare equal to it).
 */
export function normalizeHost(host) {
  return String(host ?? '').trim().toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.+$/, '');
}

/** Is `host` one of the inference providers, or a subdomain of one? */
export function isAiProviderHost(host) {
  const h = normalizeHost(host);
  if (!h) return false;
  for (const d of AI_PROVIDER_HOSTS) {
    if (h === d || h.endsWith('.' + d)) return true;
  }
  return false;
}

// Characters that cannot appear in a hostname. Splitting on them turns a path
// or query string into candidate hostnames without having to parse whatever
// URL-in-a-URL convention the intermediary happens to use.
const NOT_HOST_CHARS = /[^a-z0-9.-]+/;
const MAX_DECODE_ROUNDS = 3;

/**
 * Does this URL target an inference provider — directly, or by carrying one
 * inside its path or query for an intermediary to fetch?
 *
 * Decodes up to three rounds so `https%253A%252F%252Fapi.openai.com` (double
 * encoded) is still seen. A token only counts when the WHOLE token is an AI
 * host, so `openai.com.example.net` and `notopenai.com` are not false hits.
 *
 * What this cannot see: a target that has been ENCRYPTED or base64'd into the
 * path, the way Ultraviolet encodes its URLs. That is an intermediary's private
 * encoding, and no string test can read every one; the per-hop check in
 * lib/safe-fetch.mjs still refuses the moment this server itself is pointed at
 * the provider.
 *
 * @param {string|URL} input
 */
export function mentionsAiProvider(input) {
  let u;
  try { u = input instanceof URL ? input : new URL(String(input)); }
  catch { return false; }
  if (isAiProviderHost(u.hostname)) return true;

  let text = (u.pathname + u.search).toLowerCase();
  for (let round = 0; round < MAX_DECODE_ROUNDS; round++) {
    for (const token of text.split(NOT_HOST_CHARS)) {
      if (token.includes('.') && isAiProviderHost(token)) return true;
    }
    let next;
    try { next = decodeURIComponent(text).toLowerCase(); } catch { break; }
    if (next === text) break;
    text = next;
  }
  return false;
}

export default { AI_PROVIDER_HOSTS, normalizeHost, isAiProviderHost, mentionsAiProvider };
