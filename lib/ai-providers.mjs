// lib/ai-providers.mjs
//
// Public, no-API-key AI providers — kept in a separate file so the
// existing local-model /ai page (Transformers.js + SmolLM2) can pick
// these up as remote alternatives without me having to refactor ai.js
// in one shot.
//
// Wiring later:
//   - GET /api/ai/providers              → returns this list
//   - POST /api/ai/text  { provider, prompt }  → proxy to a text model
//   - POST /api/ai/image { provider, prompt }  → proxy to an image model
//   (the /api/ai/providers route IS wired now; text/image proxies aren't
//    yet because they'd need rate-limit handling and the existing /ai
//    page works fine for now.)
//
// All listed providers are free, no signup, and have public docs:
//   - aihorde.net          (crowdsourced GPU cluster)
//   - pollinations.ai      (free image/text generation)

export const AI_PROVIDERS = {
  text: [
    {
      id:        'ai-horde-text',
      name:      'AI Horde (Text)',
      provider:  'Crowdsourced GPU Cluster',
      api_url:   'https://aihorde.net/api/v2/generate/text/async',
      api_key:   '0000000000',  // public anonymous key
      method:    'POST',
      limits:    'Unlimited',
      best_for:  'Complex prompts, roleplay, and creative writing.',
      docs:      'https://aihorde.net/api/'
    },
    {
      id:        'pollinations-text',
      name:      'Pollinations.ai (Text)',
      provider:  'Pollinations.ai',
      api_url:   'https://text.pollinations.ai',  // GET /<prompt>
      method:    'GET',
      limits:    'Unlimited',
      best_for:  'Quick prompts, no setup.',
      docs:      'https://pollinations.ai/'
    },
  ],
  image: [
    {
      id:        'ai-horde-image',
      name:      'AI Horde (Image)',
      provider:  'Crowdsourced GPU Cluster',
      api_url:   'https://aihorde.net/api/v2/generate/async',
      api_key:   '0000000000',
      method:    'POST',
      limits:    'Unlimited',
      best_for:  'Stable Diffusion XL with many sampler choices.',
      docs:      'https://aihorde.net/api/'
    },
    {
      id:        'pollinations-image',
      name:      'Pollinations.ai (Image)',
      provider:  'Pollinations.ai',
      api_url:   'https://image.pollinations.ai/prompt',  // GET /<prompt>
      method:    'GET',
      limits:    'Unlimited',
      best_for:  'Inline image URLs, no auth needed.',
      docs:      'https://pollinations.ai/'
    },
  ],
  // Web-search grounding providers (from ai_gaming_hub_final.json). All free
  // tiers but require a (free) API key — set the matching env var to enable:
  //   Brave → BRAVE_API_KEY · Tavily → TAVILY_API_KEY ·
  //   Exa → EXA_API_KEY · Firecrawl → FIRECRAWL_API_KEY
  // /api/ai/search uses whichever key is present; with none it returns a
  // friendly "add a free key" note instead of failing.
  web_search: [
    {
      id:        'brave',
      name:      'Brave Search API',
      provider:  'Brave',
      api_url:   'https://api.search.brave.com/res/v1/web/search',
      signup:    'https://brave.com/search/api/',
      env:       'BRAVE_API_KEY',
      free_tier: '2,000 queries/month',
      requires_key: true,
      best_for:  'Privacy-first grounding; independent index.'
    },
    {
      id:        'tavily',
      name:      'Tavily',
      provider:  'Tavily',
      api_url:   'https://api.tavily.com/search',
      signup:    'https://app.tavily.com/',
      env:       'TAVILY_API_KEY',
      free_tier: '1,000 credits/month',
      requires_key: true,
      best_for:  'LLM-ready results: scored, deduped, summarized.'
    },
    {
      id:        'exa',
      name:      'Exa',
      provider:  'Exa.ai',
      api_url:   'https://api.exa.ai/search',
      signup:    'https://dashboard.exa.ai/',
      env:       'EXA_API_KEY',
      free_tier: '1,000 searches/month',
      requires_key: true,
      best_for:  'Neural / semantic exploratory search.'
    },
    {
      id:        'firecrawl',
      name:      'Firecrawl',
      provider:  'Firecrawl',
      api_url:   'https://api.firecrawl.dev/v1/search',
      signup:    'https://www.firecrawl.dev/',
      env:       'FIRECRAWL_API_KEY',
      free_tier: '500 credits/month',
      requires_key: true,
      best_for:  'Search + scrape in one call.'
    },
  ]
};

// Hardcoded model failsafes. If the dynamic Pollinations model-registry call
// fails or its JSON shape changes, these keep generation working so the site
// never breaks. (text → 'openai', image → 'flux'.)
export const MODEL_FALLBACKS = Object.freeze({ text: 'openai', image: 'flux' });

// Sanitized view safe to ship to the browser (drops api_key fields).
export function publicProviderList() {
  const strip = (m) => {
    const { api_key, ...rest } = m;
    return rest;
  };
  return {
    text:       AI_PROVIDERS.text.map(strip),
    image:      AI_PROVIDERS.image.map(strip),
    web_search: (AI_PROVIDERS.web_search || []).map(strip),
  };
}
