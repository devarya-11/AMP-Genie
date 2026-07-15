'use strict';

// Brand research dossier builder (v3 intelligence layer): turns a brand name
// (plus optional pasted team notes) into a structured dossier the ideation
// engine consumes — what the company does, products/categories, audiences,
// voice, current campaigns. Two tiers, same religion as the rest of the
// pipeline:
//   Tier 1 (always works, zero keys): guess the brand's domain the way
//     server/brand.js does, scrape title/meta/headings/nav labels with the
//     same regex-tolerant parsing, and derive a deterministic dossier via
//     server/brief-router.js's inferVertical/inferTone.
//   Tier 2 (optional): ONE schema-constrained LLM call over the scraped
//     facts + notes — first configured provider only, because a dossier is
//     one expensive cached call per brand, not a best-of-N fan-out like
//     brief-content.js's copy composer. The response is re-validated locally
//     by validateDossier() as defense in depth: plain-text JSON strings
//     only, never markup.
// Contract: buildDossier() NEVER throws and ALWAYS returns a dossier —
// zero providers, a dead site, a throwing kv and a broken thunk all degrade
// to the deterministic tier (worst case a minimal name/slug/vertical shell),
// never into the build/request that asked.

const {
  callClaude, callGemini, callGroq, callOllama, withTimeout,
} = require('./llm-providers');
const { inferVertical, inferTone } = require('./brief-router');
const { candidateDomains } = require('./brand');
const { VERTICALS } = require('./content');
const { brandSlug } = require('./store');
const { searchOpenverseImage } = require('./openverse');

const CLAUDE_MODEL = 'claude-haiku-4-5';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const GROQ_MODEL = process.env.GROQ_MODEL || 'llama-3.1-8b-instant';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'llama3.2';
// Ollama is opt-in via OLLAMA_BASE_URL, same *_API_KEY-style gate as
// brief-content.js — a bare checkout never reaches out to a local port.
const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || null;

// Research is a background-ish, cached-once call, so it gets a wider budget
// than the per-request 8s copy composer — but still a hard ceiling.
const SYNTH_TIMEOUT_MS = 15000;
const SITE_TIMEOUT_MS = 6000; // overall scrape budget across both candidates
const REQUEST_TIMEOUT_MS = 4000; // per-request, same as brand.js's logo fetch

// ---- tier 1: site fact extraction ------------------------------------------
// Same UA + attribute-order-tolerant regex parsing as server/brand.js's
// safeFetch/metaContent/attrValue (not exported there, so mirrored locally).
// Real-world <head>s put content= before property= about half the time.

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

async function safeFetch(url, timeout, fetchImpl) {
  return fetchImpl(url, {
    headers: { 'User-Agent': UA, Accept: 'text/html,*/*' },
    redirect: 'follow',
    signal: AbortSignal.timeout(timeout),
  });
}

function attrValue(tag, name) {
  const m = tag.match(new RegExp(`${name}=["']([^"']+)["']`, 'i'));
  return m ? m[1].trim() : null;
}

// Scraped text is untrusted input headed for dossier fields and LLM prompts:
// strip whole tags first, then any stray angle bracket a malformed tag left
// behind, so no path out of this module ever carries markup. Entities are
// deliberately left alone — they're inert as plain text.
function cleanText(s) {
  return String(s || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/[<>]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Site-chrome anchor texts that say nothing about what the brand sells.
const CHROME_LABELS = new Set([
  'home', 'login', 'log in', 'logout', 'log out', 'sign in', 'signin', 'sign up', 'signup', 'register',
  'privacy', 'privacy policy', 'terms', 'terms of service', 'terms & conditions', 'terms and conditions',
  'cookies', 'cookie policy', 'contact', 'contact us', 'about', 'about us', 'careers', 'help', 'support',
  'faq', 'faqs', 'sitemap', 'search', 'cart', 'account', 'my account', 'menu', 'skip to content',
  'skip to main content', 'back to top', 'subscribe', 'newsletter',
]);

const MAX_HEADINGS = 8;
const HEADING_MAX_LEN = 120;
const MAX_NAV_LABELS = 20;

// Pure string parsing — no DOM, no network. Never throws: hostile or
// malformed HTML yields whatever was collected before the failure, and every
// field has a safe empty default.
function extractSiteFacts(html, baseUrl) { // eslint-disable-line no-unused-vars
  const facts = {
    title: null, description: null, siteName: null, headings: [], navLabels: [],
  };
  try {
    const src = String(html || '');

    const t = src.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
    if (t) facts.title = cleanText(t[1]) || null;

    // one pass over every <meta>; name=description beats og:description
    let ogDescription = null;
    const metaRe = /<meta\b[^>]*>/gi;
    let m;
    while ((m = metaRe.exec(src))) {
      const tag = m[0];
      const key = (attrValue(tag, 'property') || attrValue(tag, 'name') || '').toLowerCase();
      const content = attrValue(tag, 'content');
      if (!content) continue;
      if (key === 'description' && !facts.description) facts.description = cleanText(content) || null;
      else if (key === 'og:description' && !ogDescription) ogDescription = cleanText(content) || null;
      else if (key === 'og:site_name' && !facts.siteName) facts.siteName = cleanText(content) || null;
    }
    if (!facts.description) facts.description = ogDescription;

    // an unclosed <h1>/<h2> simply never matches — tolerated, not fatal
    const hRe = /<h[12]\b[^>]*>([\s\S]*?)<\/h[12]>/gi;
    while ((m = hRe.exec(src)) && facts.headings.length < MAX_HEADINGS) {
      const text = cleanText(m[1]).slice(0, HEADING_MAX_LEN).trim();
      if (text) facts.headings.push(text);
    }

    const seen = new Set();
    const aRe = /<a\b[^>]*>([\s\S]*?)<\/a>/gi;
    while ((m = aRe.exec(src)) && facts.navLabels.length < MAX_NAV_LABELS) {
      const text = cleanText(m[1]);
      if (text.length < 2 || text.length > 30) continue;
      const lower = text.toLowerCase();
      if (CHROME_LABELS.has(lower) || seen.has(lower)) continue;
      seen.add(lower);
      facts.navLabels.push(text);
    }
  } catch {
    // regex over hostile input must never take a build down — partial facts
    // are still useful facts
  }
  return facts;
}

// A parked/placeholder domain (comorin.com is a 114-byte empty 200 while the
// real restaurant lives at comorin.in) returns a clean 2xx but carries no
// title, description, headings or nav labels — nothing to ground a dossier on.
// "Usable" means at least one of those signals is present, so fetchBrandSite
// can reject the empty winner and hold out for the candidate that actually
// describes the brand.
function hasUsableFacts(facts) {
  if (!facts) return false;
  return Boolean(
    (facts.title && facts.title.length)
    || (facts.description && facts.description.length)
    || (Array.isArray(facts.headings) && facts.headings.length)
    || (Array.isArray(facts.navLabels) && facts.navLabels.length),
  );
}

// Reuses server/brand.js's candidateDomains (.com AND .in, www + bare) — the
// two modules had drifted, and research trying only .com is exactly why
// groww.in-style brands timed out their whole scrape budget on dead .com
// domains and then had no site facts to ground the LLM synthesis.

// Fetch the brand's homepage and extract facts. Same resilience contract as
// brand.js's fetchBrandColor/fetchBrandLogo: any failure at any stage falls
// through to the next candidate, and a hard OVERALL budget (not just the
// per-request one) means an unreachable/slow site degrades to null well
// before it could make the caller feel stuck. Never throws.
async function fetchBrandSite(brandName, fetchImpl = fetch) {
  const run = async () => {
    const domains = candidateDomains(brandName);
    if (!domains.length) return null;
    // Race every candidate in PARALLEL, not serially: a dead first domain
    // (groww.com times out at REQUEST_TIMEOUT_MS) must not consume the whole
    // SITE_TIMEOUT_MS budget before the real one (groww.in, answers in <1s)
    // is even attempted — the serial version starved the LLM of site facts
    // for every .in-first brand. Each attempt rejects on any failure — a
    // non-2xx, OR a 2xx that yielded no usable facts (a parked .com placeholder
    // that outraces the brand's real .in site) — so Promise.any yields the
    // first candidate carrying REAL content, not merely the first that
    // answered. If all reject it throws (AggregateError) and we degrade to
    // null, exactly like a wholly dead brand.
    const attempts = domains.map(async (url) => {
      const r = await safeFetch(url, REQUEST_TIMEOUT_MS, fetchImpl);
      if (!r.ok) throw new Error('non-2xx');
      const html = await r.text();
      const facts = extractSiteFacts(html, url);
      if (!hasUsableFacts(facts)) throw new Error('parked/empty page');
      return { site: url, facts };
    });
    try {
      return await Promise.any(attempts);
    } catch {
      return null; // every candidate domain failed or was empty
    }
  };
  return withTimeout(run, SITE_TIMEOUT_MS);
}

// ---- tier 1: deterministic dossier ------------------------------------------

// inferTone classifies campaign copy; the dossier wants brand-voice
// adjectives, so each tone maps to a small fixed adjective set.
const TONE_ADJECTIVES = {
  Playful: ['friendly', 'upbeat', 'playful'],
  Urgent: ['direct', 'energetic'],
  Premium: ['refined', 'polished', 'understated'],
  Informative: ['clear', 'helpful', 'practical'],
};

// A heading counts as a live offer/campaign if it carries discount language:
// a literal %, or the words sale/off/free.
const OFFER_RE = /%|\b(?:sale|off|free)\b/i;

const ITEM_MAX_LEN = 60;
function capItem(s) {
  return String(s || '').slice(0, ITEM_MAX_LEN).trim();
}

// Deterministic dossier from scraped facts alone — the floor every build can
// stand on with zero providers configured. facts may be null (site
// unreachable); every field still comes back in its final shape.
function heuristicDossier({ brandName, facts } = {}) {
  const f = facts || {};
  const title = typeof f.title === 'string' ? f.title : '';
  const description = typeof f.description === 'string' ? f.description : '';
  const headings = Array.isArray(f.headings) ? f.headings.filter((h) => typeof h === 'string') : [];
  const navLabels = Array.isArray(f.navLabels) ? f.navLabels.filter((l) => typeof l === 'string') : [];

  // nav labels are the closest scrape-level signal to catalogue categories;
  // non-offer headings (taglines, collection names) stand in for products.
  // Offer-looking headings are campaigns, not catalogue.
  const categories = navLabels.map(capItem).filter(Boolean).slice(0, 10);
  const products = headings.filter((h) => !OFFER_RE.test(h)).map(capItem).filter(Boolean).slice(0, 10);
  const currentCampaigns = headings.filter((h) => OFFER_RE.test(h)).map(capItem).filter(Boolean).slice(0, 3);

  return {
    summary: (description || title || '').slice(0, 300).trim(),
    products,
    categories,
    audiences: [],
    // slice() so callers mutating their dossier can't corrupt the shared map
    voice: { adjectives: (TONE_ADJECTIVES[inferTone(description)] || TONE_ADJECTIVES.Playful).slice(), donts: [] },
    currentCampaigns,
    vertical: inferVertical(brandName, [description, headings.join(' ')].join(' ')),
  };
}

// ---- dossier validation (defense in depth) ----------------------------------
// Follows the validatePlan() pattern in server/brief-content.js, with one
// deliberate difference: per-field DROP semantics instead of whole-object
// rejection. A dossier is a merge SOURCE (LLM wins field-by-field over the
// heuristic tier), so one bad field should cost that field, not the whole
// synthesis. Returns null only when obj isn't an object at all.

const SUMMARY_MAX_LEN = 400;
const FIELD_ITEM_MAX_LEN = 80;
const ARRAY_CAPS = {
  products: 10, categories: 10, audiences: 5, currentCampaigns: 5,
};
const VOICE_CAPS = { adjectives: 5, donts: 5 };
// The priced catalog is what finally replaces generate.js's generic vertical
// placeholders ("Pro Plan", "Annual Saver") with the brand's ACTUAL items at
// realistic prices. Capped to the repo's PRODUCTS_MAX (8); prices are whole
// rupees in a sane window so a hallucinated 0 or 1e30 can never render.
const CATALOG_MAX = 8;
const PRICE_MIN = 1;
const PRICE_MAX = 10000000;
const HERO_PROMPT_MAX = 120;

// Same rules as brief-content.js's validateStringField: trimmed, non-empty,
// under maxLen, and free of '<'/'>' — markup must never leave this module.
function cleanString(val, maxLen) {
  if (typeof val !== 'string') return null;
  const trimmed = val.trim();
  if (!trimmed || trimmed.length > maxLen) return null;
  if (/[<>]/.test(trimmed)) return null;
  return trimmed;
}

function cleanStringArray(val, maxItems) {
  if (!Array.isArray(val)) return null;
  const out = [];
  for (const v of val) {
    if (out.length >= maxItems) break;
    const s = cleanString(v, FIELD_ITEM_MAX_LEN);
    if (s !== null) out.push(s);
  }
  return out.length ? out : null;
}

// The LLM's priced catalog: each item is { name, price? }. A clean, markup-free
// name (<= FIELD_ITEM_MAX_LEN) is required; price is OPTIONAL — a finite
// positive integer inside the sane window survives, anything else drops the
// price but keeps the named item (a name-only announcement still grounds the
// email in a real product). Capped at CATALOG_MAX. Returns null when nothing is
// usable, so the field is simply absent and heuristic products fill in at
// persistence time. Same per-field-DROP religion as the rest of this module.
function cleanCatalog(val) {
  if (!Array.isArray(val)) return null;
  const out = [];
  for (const it of val) {
    if (out.length >= CATALOG_MAX) break;
    if (!it || typeof it !== 'object' || Array.isArray(it)) continue;
    const name = cleanString(it.name, FIELD_ITEM_MAX_LEN);
    if (name === null) continue;
    const item = { name };
    const price = Math.round(Number(it.price));
    if (Number.isFinite(price) && price >= PRICE_MIN && price <= PRICE_MAX) item.price = price;
    out.push(item);
  }
  return out.length ? out : null;
}

function validateDossier(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const out = {};

  const summary = cleanString(obj.summary, SUMMARY_MAX_LEN);
  if (summary !== null) out.summary = summary;

  for (const key of Object.keys(ARRAY_CAPS)) {
    const arr = cleanStringArray(obj[key], ARRAY_CAPS[key]);
    if (arr) out[key] = arr;
  }

  if (obj.voice && typeof obj.voice === 'object' && !Array.isArray(obj.voice)) {
    // sub-keys validate independently so an LLM that only returned donts
    // still contributes them without clobbering heuristic adjectives at merge
    const voice = {};
    const adjectives = cleanStringArray(obj.voice.adjectives, VOICE_CAPS.adjectives);
    const donts = cleanStringArray(obj.voice.donts, VOICE_CAPS.donts);
    if (adjectives) voice.adjectives = adjectives;
    if (donts) voice.donts = donts;
    if (Object.keys(voice).length) out.voice = voice;
  }

  // The priced catalog and the hero image prompt are the v3.3 enrichment: LLM-
  // only fields (the heuristic tier can't price a product or picture a hero), so
  // they're absent unless the model grounded them. Both re-validated here as
  // defense in depth, same as every other field.
  const catalog = cleanCatalog(obj.catalog);
  if (catalog) out.catalog = catalog;

  const heroPrompt = cleanString(obj.heroPrompt, HERO_PROMPT_MAX);
  if (heroPrompt !== null) out.heroPrompt = heroPrompt;

  // an invented vertical must never leak into getContent() — anything
  // outside the real generator list is dropped so the heuristic one is kept
  // at merge time
  const vertical = cleanString(obj.vertical, FIELD_ITEM_MAX_LEN);
  if (vertical !== null && VERTICALS.includes(vertical)) out.vertical = vertical;

  return out;
}

// ---- tier 2: LLM synthesis ---------------------------------------------------

// Mirrors validateDossier's allowlist exactly, so the provider's own
// structured-output feature and the local re-validation enforce one shape.
const DOSSIER_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string', maxLength: SUMMARY_MAX_LEN },
    products: { type: 'array', items: { type: 'string', maxLength: FIELD_ITEM_MAX_LEN }, maxItems: ARRAY_CAPS.products },
    categories: { type: 'array', items: { type: 'string', maxLength: FIELD_ITEM_MAX_LEN }, maxItems: ARRAY_CAPS.categories },
    audiences: { type: 'array', items: { type: 'string', maxLength: FIELD_ITEM_MAX_LEN }, maxItems: ARRAY_CAPS.audiences },
    voice: {
      type: 'object',
      properties: {
        adjectives: { type: 'array', items: { type: 'string', maxLength: FIELD_ITEM_MAX_LEN }, maxItems: VOICE_CAPS.adjectives },
        donts: { type: 'array', items: { type: 'string', maxLength: FIELD_ITEM_MAX_LEN }, maxItems: VOICE_CAPS.donts },
      },
      additionalProperties: false,
    },
    currentCampaigns: { type: 'array', items: { type: 'string', maxLength: FIELD_ITEM_MAX_LEN }, maxItems: ARRAY_CAPS.currentCampaigns },
    catalog: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string', maxLength: FIELD_ITEM_MAX_LEN },
          price: { type: 'number' },
        },
        required: ['name'],
        additionalProperties: false,
      },
      maxItems: CATALOG_MAX,
    },
    heroPrompt: { type: 'string', maxLength: HERO_PROMPT_MAX },
    vertical: { type: 'string', enum: VERTICALS },
  },
  additionalProperties: false,
};

// Notes are pasted free text and could be arbitrarily long — bound what goes
// into the prompt (the dossier still stores them verbatim, uncut).
const PROMPT_NOTES_MAX = 2000;

function buildResearchPrompt({ brandName, facts, notes }) {
  const f = facts || {};
  const noteText = String(notes || '').trim().slice(0, PROMPT_NOTES_MAX);
  const factLines = [
    `- title: ${f.title || '(none)'}`,
    `- description: ${f.description || '(none)'}`,
    `- site name: ${f.siteName || '(none)'}`,
    `- headings: ${(Array.isArray(f.headings) ? f.headings : []).join(' | ') || '(none)'}`,
    `- nav/category labels: ${(Array.isArray(f.navLabels) ? f.navLabels : []).join(', ') || '(none)'}`,
  ].join('\n');
  const notesBlock = noteText
    ? `\nTeam notes (pasted by the campaign team — HIGHER TRUST than the scraped facts; prefer them on any conflict):\n"""\n${noteText}\n"""\n`
    : '';
  return `You are compiling a brand research dossier on "${brandName || 'the brand'}" for an email campaign ideation engine.

Scraped homepage facts (may be noisy or incomplete):
${factLines}
${notesBlock}
Fill in the dossier as JSON: summary (what the company does and for whom), products (up to 10 short product names), categories (up to 10 catalogue categories), audiences (up to 5 short audience descriptors), voice (adjectives: up to 5 brand-voice adjectives; donts: up to 5 things the copy must avoid), currentCampaigns (up to 5 short descriptions of offers or campaigns visible in the facts or notes), catalog (up to 8 of the brand's REAL flagship products or menu items grounded in the facts/notes, each an object {name, price} where price is a realistic retail price as a plain positive whole number in Indian rupees — a restaurant lists actual dishes at real menu prices, a shop lists real SKUs; NEVER invent generic placeholders like "Starter Plan", "Pro Plan" or "Annual Saver"), heroPrompt (a short 4-to-10-word visual description of the single best hero photograph for this brand's marketing email, e.g. "plated South Indian coastal cuisine on a rustic wooden table"), vertical (exactly one of: ${VERTICALS.join(', ')}). Plain text string values only — no HTML, no markdown, no links; prices are bare numbers. Omit any field you cannot ground in the facts or notes.`;
}

// First configured provider only, fixed priority order (Claude, Gemini,
// Groq, Ollama) — auto-detected from env the way brief-content.js's
// defaultProviders does, including its lazily-constructed Anthropic client
// (opts.client stays the DI seam for tests/back-compat).
function detectProviderCall(opts) {
  let claudeClient = opts.client;
  if (!claudeClient && process.env.ANTHROPIC_API_KEY) {
    try {
      const Anthropic = require('@anthropic-ai/sdk');
      claudeClient = new Anthropic();
    } catch (e) {
      console.error('[brand-research] failed to construct Anthropic client:', e && e.message);
    }
  }
  if (claudeClient) {
    return (prompt, schema, timeoutMs) => callClaude({
      client: claudeClient, model: CLAUDE_MODEL, prompt, schema, timeoutMs,
    });
  }
  if (process.env.GEMINI_API_KEY) {
    return (prompt, schema, timeoutMs) => callGemini({
      apiKey: process.env.GEMINI_API_KEY, model: GEMINI_MODEL, prompt, schema, timeoutMs,
    });
  }
  if (process.env.GROQ_API_KEY) {
    return (prompt, schema, timeoutMs) => callGroq({
      apiKey: process.env.GROQ_API_KEY, model: GROQ_MODEL, prompt, schema, timeoutMs,
    });
  }
  if (OLLAMA_BASE_URL) {
    return (prompt, schema, timeoutMs) => callOllama({
      baseUrl: OLLAMA_BASE_URL, model: OLLAMA_MODEL, prompt, schema, timeoutMs,
    });
  }
  return null;
}

// LLM tier. opts.providers (or args.providers): array of zero-arg async
// thunks resolving to a raw dossier object — or a JSON string, the way
// Gemini/Groq/Ollama bodies arrive — the DI seam for tests. Only the FIRST
// thunk is ever called. opts.timeoutMs: budget override (tests only).
// Resolves to a validated dossier-part or null; never throws.
async function synthesizeDossier(args = {}, opts = {}) {
  const { brandName, facts, notes } = args;
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : SYNTH_TIMEOUT_MS;
  const injected = Array.isArray(opts.providers) ? opts.providers
    : (Array.isArray(args.providers) ? args.providers : null);

  let thunk = null;
  if (injected) {
    const first = injected.length ? injected[0] : null;
    if (typeof first === 'function') {
      // legacy zero-arg thunk (tests) — called as-is
      thunk = first;
    } else if (first && typeof first.call === 'function') {
      // a key-pool descriptor {name, call(prompt, schema, timeoutMs)} — this
      // module builds its own prompt, so the descriptor is wrapped the same
      // way the env path wraps its caller. The typeof-function check MUST
      // come first: bare functions also expose Function.prototype.call.
      const prompt = buildResearchPrompt({ brandName, facts, notes });
      thunk = () => first.call(prompt, DOSSIER_SCHEMA, timeoutMs);
    }
  } else {
    const call = detectProviderCall(opts);
    if (call) {
      const prompt = buildResearchPrompt({ brandName, facts, notes });
      thunk = () => call(prompt, DOSSIER_SCHEMA, timeoutMs);
    }
  }
  if (typeof thunk !== 'function') return null;

  // Free-tier structured output is intermittently flaky — the same schema'd
  // call that succeeds for one brand returns a 200 with empty/unparseable
  // content for the next. The real-provider path therefore gets ONE retry,
  // which measurably lifts the llm-tier hit rate; an injected test thunk is
  // called exactly once (nothing flaky to retry, and a second call would
  // break call-count assertions).
  const maxAttempts = injected ? 1 : 2;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      // the built-in call*s honour timeoutMs themselves, but race here too so
      // an injected/misbehaving thunk can never hold a build past the budget;
      // Promise.resolve().then() also absorbs synchronous throws
      let raw = await withTimeout(() => Promise.resolve().then(thunk), timeoutMs);
      if (raw) {
        if (typeof raw === 'string') raw = JSON.parse(raw);
        const dossier = validateDossier(raw);
        if (dossier && Object.keys(dossier).length) return dossier;
      }
    } catch {
      // parse/validation/timeout failure — fall through to the retry, then null
    }
  }
  return null;
}

// True when any research provider is configured (a Claude DI client counts).
// Drives two things: whether a cached HEURISTIC dossier is worth re-attempting
// (an llm upgrade is only possible with a provider), and the honest UI label
// (heuristic-because-no-key vs heuristic-because-the-call-failed).
function hasResearchProvider(opts = {}) {
  // Injected providers (the test/DI seam) count too, so this stays consistent
  // with synthesizeDossier's own provider selection.
  if (Array.isArray(opts.providers) && opts.providers.length) return true;
  return !!(opts.client
    || process.env.ANTHROPIC_API_KEY
    || process.env.GEMINI_API_KEY
    || process.env.GROQ_API_KEY
    || OLLAMA_BASE_URL);
}

// ---- orchestrator ------------------------------------------------------------

// Local mirrors of store.js's kvGet/kvPut (not exported there): a failed
// read is null, a failed write is swallowed — the kv is a cache, never a
// dependency.
async function cacheGet(kv, key) {
  if (!kv) return null;
  try {
    const value = await kv.get(key, 'json');
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

async function cachePut(kv, key, value) {
  if (!kv) return false;
  try {
    await kv.put(key, JSON.stringify(value));
    return true;
  } catch (e) {
    console.error('[brand-research] failed to persist ' + key + ':', e && e.message);
    return false;
  }
}

// Same 31-multiplier rolling hash as brand.js's hashColor — a collision only
// costs one stale cache hit, so 32 bits is plenty.
function notesHash(text) {
  const s = String(text || '');
  if (!s) return '';
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h.toString(16);
}

// The public entry point: cached dossier if the brand was already researched
// with the same notes (unless force), otherwise scrape -> heuristic ->
// optional LLM synthesis merged over it field-by-field (LLM wins where
// valid, heuristic fills the gaps). ALWAYS returns a dossier object.
async function buildDossier(args = {}, opts = {}) {
  const {
    brandName, notes, kv, force, fetchImpl,
  } = args;
  const name = String(brandName || '').trim();
  const slug = brandSlug(name);
  const notesText = typeof notes === 'string' ? notes : '';
  const hash = notesHash(notesText);

  try {
    const key = 'dossier:' + slug;
    if (!force && slug) {
      const cached = await cacheGet(kv, key);
      // changed notes invalidate the cache: the dossier must reflect what
      // the team pasted now, not what they pasted last time
      if (cached && cached.notesHash === hash) {
        // A cached LLM dossier is authoritative — serve it fast. A cached
        // HEURISTIC one only records that the LLM wasn't available (or failed)
        // when it was made; if a provider is configured NOW, fall through and
        // try to upgrade it. This is what unsticks every brand researched in
        // an earlier keyless session (they'd otherwise serve the stale
        // heuristic forever, which is exactly the "no LLM key" chip bug).
        if (cached.confidence === 'llm' || !hasResearchProvider(opts)) return cached;
      }
    }

    const fetched = await fetchBrandSite(name, fetchImpl || fetch);
    const facts = fetched ? fetched.facts : null;
    const site = fetched ? fetched.site : null;

    const heuristic = heuristicDossier({
      brandName: name, facts, site, notes: notesText,
    });
    const llm = await synthesizeDossier({ brandName: name, facts, notes: notesText }, opts);

    const merged = { ...heuristic };
    if (llm) {
      for (const [k, v] of Object.entries(llm)) {
        // voice merges one level deep so an LLM that only returned donts
        // keeps the heuristic adjectives
        if (k === 'voice' && merged.voice) merged.voice = { ...merged.voice, ...v };
        else merged[k] = v;
      }
    }

    // Resolve the keyless Openverse relevance floor onto the merged dossier
    // (hero + each catalog item) before it is cached, so it is paid once per
    // brand and served from KV thereafter. Same fetchImpl seam as the scrape;
    // offline/rate-limited leaves the fields unset (the loremflickr floor
    // downstream takes over). Never throws.
    await resolveDossierImagery(merged, fetchImpl || fetch);

    const dossier = {
      ...merged,
      name,
      slug,
      site,
      notes: notesText,
      notesHash: hash,
      confidence: llm ? 'llm' : 'heuristic',
      researchedAt: new Date().toISOString(),
    };
    if (slug) await cachePut(kv, key, dossier);
    return dossier;
  } catch (e) {
    // the never-throw floor: even a bug above degrades to the minimal
    // deterministic dossier rather than failing the build that asked
    console.error('[brand-research] dossier build failed:', e && e.message);
    return {
      summary: '',
      products: [],
      categories: [],
      audiences: [],
      voice: { adjectives: [], donts: [] },
      currentCampaigns: [],
      vertical: inferVertical(name, ''),
      name,
      slug,
      site: null,
      notes: notesText,
      notesHash: hash,
      confidence: 'heuristic',
      researchedAt: new Date().toISOString(),
    };
  }
}

// ---- keyword photography -----------------------------------------------------

// A real, keyword-relevant photograph URL for a product tile or a hero band,
// built the SAME URL-parameterised way generate.js builds its placehold.co and
// quickchart.io images: no fetch here, just a deterministic https URL a later
// amp-img can load. loremflickr returns a Creative-Commons Flickr photo whose
// tags match the comma-joined keywords; ?lock=<hash> pins ONE stable photo per
// query so re-renders (and the test suite) stay byte-identical. The output is
// intentionally kept within generate.js's validImgUrl grammar (plain https, no
// whitespace/quotes/brackets) so it survives every downstream sanitiser. An
// empty or unusable query returns null, so callers fall back to their own
// placeholder (a ph() tile or a hero-less header) rather than a broken image.
function stockImageUrl(query, width, height) {
  const words = String(query || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 4);
  if (!words.length) return null;
  const w = Math.max(1, Math.min(2000, Math.round(Number(width) || 600)));
  const h = Math.max(1, Math.min(2000, Math.round(Number(height) || 400)));
  const key = words.join(',');
  // Same 31-multiplier rolling hash as notesHash, kept numeric: loremflickr's
  // lock seed wants a number, and a stable seed is all determinism needs.
  let lock = 0;
  for (let i = 0; i < key.length; i += 1) lock = (lock * 31 + key.charCodeAt(i)) >>> 0;
  return `https://loremflickr.com/${w}/${h}/${key}?lock=${lock || 1}`;
}

// loremflickr matches photo TAGS with AND semantics, so a brand name ("Nykaa")
// or a multi-word product ("Vitamin C Serum") matches NO photo and the service
// silently serves its grey "defaultImage" placeholder — which is exactly the
// bland non-image the team kept seeing. ONE common vertical noun always matches
// a real photo, so this map is the reliable floor: whenever we have no
// brand-specific photo (real og:image or catalogue shot) to show, we key the
// stock image off the vertical, never the brand/product name.
const VERTICAL_STOCK_KEYWORD = {
  Beauty: 'cosmetics',
  Fashion: 'fashion',
  Food: 'food',
  Finance: 'finance',
  Electronics: 'electronics',
  Travel: 'travel',
  Generic: 'shopping',
};

// A guaranteed-real stock photograph for a vertical (never a defaulting
// keyword compound). Unknown/blank verticals fall to the Generic noun so the
// result is always a real image URL, never null for a known caller.
function verticalStockImageUrl(vertical, width, height) {
  const kw = VERTICAL_STOCK_KEYWORD[vertical] || VERTICAL_STOCK_KEYWORD.Generic;
  return stockImageUrl(kw, width, height);
}

// ---- Openverse relevance floor -----------------------------------------------

// Openverse resolution budget: each lookup is already AbortSignal-bounded
// inside searchOpenverseImage and they run in PARALLEL, so this overall race is
// belt-and-braces — a hanging/misbehaving fetch can never hold a dossier build
// past a few seconds. On timeout whatever resolved so far is already written;
// the rest fall to the loremflickr floor downstream.
const IMAGERY_TIMEOUT_MS = 5000;

// Paint REAL, relevant, no-attribution photography onto a dossier via Openverse
// — the keyless relevance floor that sits between the brand's OWN og:image
// (best) and loremflickr's random vertical match (last resort). Mutates the
// dossier in place: sets dossier.heroImage and, for each catalog item, an
// item.image. Keyed ONLY on general signals — the model's own heroPrompt, the
// vertical noun, each item's own name — NEVER a brand literal, so it holds for
// any brand in any vertical (a coffee roaster's launch, a fintech quiz, a
// bookshop's lead form alike). Uses the SAME fetchImpl seam as the site scrape
// (tests control the network; production uses global fetch). Never throws: a
// dead/rate-limited Openverse just leaves the fields unset and the caller
// floors them.
async function resolveDossierImagery(dossier, fetchImpl) {
  if (!dossier || typeof dossier !== 'object') return;
  try {
    const jobs = [];
    // Hero: prefer the model's own visual scene description; with none (the
    // keyless heuristic tier) key off the VERTICAL noun. Never the brand name —
    // a brand-poisoned query is exactly what makes the stock services default
    // to grey.
    const heroQuery = (typeof dossier.heroPrompt === 'string' && dossier.heroPrompt.trim())
      ? dossier.heroPrompt
      : (VERTICAL_STOCK_KEYWORD[dossier.vertical] || '');
    if (heroQuery) {
      jobs.push(
        searchOpenverseImage({ query: heroQuery, fetchImpl })
          .then((u) => { if (u) dossier.heroImage = u; })
          .catch(() => {}),
      );
    }
    // Each priced/named catalogue item gets a photo keyed off its OWN name.
    // Openverse ranks by relevance (unlike loremflickr's all-tags-AND match),
    // so a real product name returns a real product photo, not a grey default.
    const catalog = Array.isArray(dossier.catalog) ? dossier.catalog : [];
    for (const item of catalog) {
      if (!item || typeof item !== 'object') continue;
      if (typeof item.name !== 'string' || !item.name.trim()) continue;
      jobs.push(
        searchOpenverseImage({ query: item.name, fetchImpl })
          .then((u) => { if (u) item.image = u; })
          .catch(() => {}),
      );
    }
    if (!jobs.length) return;
    await withTimeout(() => Promise.all(jobs), IMAGERY_TIMEOUT_MS);
  } catch {
    // imagery is a best-effort enhancement; never let it fail a dossier build
  }
}

module.exports = {
  buildDossier, validateDossier, heuristicDossier, extractSiteFacts, fetchBrandSite, synthesizeDossier,
  hasResearchProvider, stockImageUrl, verticalStockImageUrl, VERTICAL_STOCK_KEYWORD, resolveDossierImagery,
};
