'use strict';

// GENIE 2.0 PHASE 4 — AI block-doc generation for the visual editor.
//
// generateDoc() turns a brand + brief + use-case into a VALIDATED email-doc
// block document (server/email-doc.js's model) the editor can open, edit and
// re-render. The house religion from brief-content.js / usecase-engine.js
// holds verbatim: the FIRST configured LLM provider drafts a doc as
// schema-constrained JSON; that draft is mapped into the doc shape and run
// through validateDoc (the trust boundary — any invalid block is dropped);
// and a zero-key / failure / empty result degrades to a DETERMINISTIC
// fallback doc seeded from the brand + brief, never a crash and never a hang
// past the ~20s budget.
//
// THE ABSOLUTE RULE holds: an LLM never produces markup. email-doc.enc()
// entity-encodes every string at render, and validateDoc's cleanStr strips
// '<'/'>' on the way in — but this module ALSO strips '<'/'>' from every LLM
// string before it enters the doc (defense in depth, same discipline as
// validateUseCase's cleanString).
//
// Runtime-agnostic by charter: fetch/crypto only, no fs/path/process at load,
// so this bundles for Workers untouched. CommonJS like the rest of server/*.

const { validateDoc, BLOCK_TYPES } = require('./email-doc');
const {
  callClaude, callGemini, callGroq, callOllama, withTimeout,
} = require('./llm-providers');

// Same models + opt-in gates as brief-content / usecase-engine, restated here
// (those modules keep them private). Read lazily inside detectProviders so
// nothing touches process at module load — the Workers charter.
const CLAUDE_MODEL = 'claude-haiku-4-5';

// One richer call, same class as usecase-engine's draft (a whole email as an
// ordered block list). 20s: the schema is the union of every block's props
// and schema-constrained decoding needs the headroom, exactly the reasoning
// behind usecase-engine's 30s — trimmed here because the per-field caps are
// tighter and the editor shows a spinner meanwhile. Wall-clock on a fetch,
// no CPU cost on Workers.
const TIMEOUT_MS = 20000;

// Field caps for the strings a block carries. Kept at or under email-doc's own
// per-prop caps (heading 140, body 2000, label 60, alt 120, brandName 80, item
// name 60) so a cap here never contradicts what validateDoc will accept; the
// body cap is pulled well below email-doc's 2000 because a marketing paragraph
// that renders in .tx-b wants ~1-3 sentences, not an essay.
const CAPS = {
  brandName: 80,
  heading: 140,
  body: 600,
  label: 60,
  alt: 120,
  itemName: 60,
  footer: 300,
};

const MAX_LLM_BLOCKS = 12; // a sane email; validateDoc caps at 40 regardless

/* ------------------------------------------------------------------ *
 * small coercers — mirror email-doc.cleanStr / usecase-engine.cleanString
 * ------------------------------------------------------------------ */

// Strip '<'/'>' (the one rule no string may break), trim, cap. Non-strings
// degrade to '' rather than throwing — a bad LLM field costs that field, not
// the doc.
function cleanStr(v, max) {
  const s = String(v == null ? '' : v).replace(/[<>]/g, '').trim();
  return typeof max === 'number' ? s.slice(0, max) : s;
}

// generate.js's hex contract, restated (email-doc keeps it private).
const HEX_ANY = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;
function coerceHex(v) {
  return HEX_ANY.test(String(v || '')) ? String(v) : undefined;
}

// A plain https image URL, the only protocol amp-img accepts (email-doc's
// validImgUrl contract). null means "no image" — the doc omits the prop and
// email-doc placeholders it at render.
function validImgUrl(v) {
  const s = (typeof v === 'string') ? v.trim() : '';
  return (s.length <= 500 && /^https:\/\/[^\s"'<>]+$/i.test(s)) ? s : null;
}

// A destination link: http(s) both allowed (email-doc's safeHttpUrl).
function safeHttpUrl(v) {
  const s = (typeof v === 'string') ? v.trim() : '';
  return (s.length <= 500 && /^https?:\/\/[^\s"'<>]+$/i.test(s)) ? s : null;
}

// A brand homepage guess for a CTA/header link when the brand carries no site
// — same slug shape generate.js:siteGuess uses.
function siteGuess(name) {
  const slug = String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  return slug ? `https://www.${slug}.com` : undefined;
}

/* ------------------------------------------------------------------ *
 * brand normalization
 * ------------------------------------------------------------------ */

// The brand object the caller hands in is whatever the pitch-api derived from
// a brands ROW (or a test hand-rolled) — every field optional and untrusted-
// shaped. Only well-formed pieces survive; a pathological name degrades to a
// house default so it can never poison the doc it seeds.
function normBrand(brand) {
  const b = (brand && typeof brand === 'object') ? brand : {};
  const name = cleanStr(b.name, CAPS.brandName) || 'Acme';
  const out = { name };
  const hex = coerceHex(b.primaryHex);
  if (hex) out.primaryHex = hex;
  const logo = validImgUrl(b.logoUrl);
  if (logo) out.logoUrl = logo;
  const site = safeHttpUrl(b.site) || siteGuess(name);
  if (site) out.site = site;
  // Voice + items are prompt/fallback grounding, kept in a shape both paths
  // can read. items: [{ name, price?, imageUrl? }] from the brand catalogue.
  const voice = cleanStr(b.voice, 200);
  if (voice) out.voice = voice;
  out.items = normItems(b.items);
  return out;
}

// A product/item list from either the brand or the brief: name required,
// positive-int price, https image — same rules as email-doc's products
// sanitizer, applied early so both the prompt and the fallback see clean data.
function normItems(items) {
  if (!Array.isArray(items)) return [];
  const out = [];
  for (const it of items) {
    if (!it || typeof it !== 'object') continue;
    const name = cleanStr(it.name, CAPS.itemName);
    if (!name) continue;
    const row = { name };
    const price = Math.round(Number(it.price));
    if (Number.isFinite(price) && price > 0) row.price = price;
    const img = validImgUrl(it.imageUrl !== undefined ? it.imageUrl : it.image);
    if (img) row.imageUrl = img;
    out.push(row);
    if (out.length >= 9) break; // email-doc's grid cap
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * the LLM JSON schema — a compact union of block props
 * ------------------------------------------------------------------ */

// ONE schema for every provider: a doc envelope whose blocks are the UNION of
// every block type's props (the model picks a `type` from BLOCK_TYPES and
// fills the props that type needs). additionalProperties:false keeps a
// provider's structured-output honest; the local mapper + validateDoc enforce
// the real per-type shape regardless of what the model actually emits — the
// same defense-in-depth as usecase-engine's planUnionSchema.
function docSchema() {
  const item = {
    type: 'object',
    properties: {
      name: { type: 'string', maxLength: CAPS.itemName },
      price: { type: 'number' },
    },
    required: ['name'],
    additionalProperties: false,
  };
  const block = {
    type: 'object',
    properties: {
      type: { type: 'string', enum: BLOCK_TYPES.slice() },
      // header / footer
      brandName: { type: 'string', maxLength: CAPS.brandName },
      // text
      heading: { type: 'string', maxLength: CAPS.heading },
      body: { type: 'string', maxLength: CAPS.body },
      // hero / image
      alt: { type: 'string', maxLength: CAPS.alt },
      // button
      label: { type: 'string', maxLength: CAPS.label },
      align: { type: 'string', enum: ['left', 'center', 'right'] },
      // products
      columns: { type: 'integer', minimum: 1, maximum: 3 },
      items: { type: 'array', maxItems: 9, items: item },
      // footer
      text: { type: 'string', maxLength: CAPS.footer },
    },
    required: ['type'],
    additionalProperties: false,
  };
  return {
    type: 'object',
    properties: {
      blocks: {
        type: 'array', minItems: 1, maxItems: MAX_LLM_BLOCKS, items: block,
      },
    },
    required: ['blocks'],
    additionalProperties: false,
  };
}

/* ------------------------------------------------------------------ *
 * the prompt
 * ------------------------------------------------------------------ */

function briefLines(brief) {
  const s = cleanStr(brief, 800);
  return s ? ['Campaign brief:', '"""', s, '"""', ''] : [];
}

function itemLines(items) {
  if (!items.length) return [];
  const names = items.map((it) => it.name).slice(0, 8).join(', ');
  return [`Products/items to feature where relevant: ${names}`, ''];
}

function buildPrompt({ brand, brief, useCase }) {
  const uc = cleanStr(useCase, 160);
  const lines = [
    `You are a lifecycle-marketing designer composing ONE marketing email for the brand "${brand.name}" as an ORDERED LIST OF BLOCKS.`,
    '',
    `Available block types (pick and order them to tell the email's story): ${BLOCK_TYPES.join(', ')}.`,
    '- header: the brand bar (brandName).',
    '- hero: a large banner image slot (alt text only — the editor supplies the image).',
    '- text: a headline (heading) and a paragraph (body) of real marketing copy.',
    '- image: an inline image slot (alt).',
    '- button: a call-to-action (label, align).',
    '- products: a grid of items (columns 1-3, items: [{name, price}]).',
    '- divider: a thin visual rule between sections.',
    '- footer: the closing line (brandName, text).',
    '',
    'Rules:',
    '- Output PLAIN TEXT only in every field. No HTML, no markdown, no links, no angle brackets.',
    '- Write realistic, specific marketing copy grounded in the brand and brief. NEVER lorem ipsum or placeholder text.',
    '- A good email usually opens with a header, has a hero or a strong text block, a products or text section, one clear button, and a footer.',
    '- Keep it to a handful of blocks; every block must earn its place.',
    '',
  ];
  if (brand.voice) {
    lines.push('Brand voice — match it, never copy sentences verbatim:', '"""', brand.voice.slice(0, 400), '"""', '');
  }
  if (uc) lines.push(`Use-case / angle for this email: ${uc}`, '');
  lines.push(...briefLines(brief));
  lines.push(...itemLines(brand.items));
  lines.push(`Compose the email now as blocks for "${brand.name}".`);
  return lines.join('\n');
}

/* ------------------------------------------------------------------ *
 * mapping the LLM output -> an email-doc doc
 * ------------------------------------------------------------------ */

// Turn ONE raw LLM block into an email-doc block, reading only the props that
// block type uses and scrubbing each (validateDoc re-sanitizes, but a clean
// props object keeps the two in lock-step). Returns null for an unknown/absent
// type so validateDoc never even sees it; a bad field inside a known type is
// dropped, not fatal — the block still renders with email-doc's defaults.
function mapBlock(raw, brand) {
  if (!raw || typeof raw !== 'object') return null;
  const type = raw.type;
  if (!BLOCK_TYPES.includes(type)) return null;
  switch (type) {
    case 'header':
      return { type, props: { brandName: cleanStr(raw.brandName, CAPS.brandName) || brand.name } };
    case 'hero':
      return { type, props: { alt: cleanStr(raw.alt, CAPS.alt) } };
    case 'text':
      return {
        type,
        props: {
          heading: cleanStr(raw.heading, CAPS.heading),
          body: cleanStr(raw.body, CAPS.body),
        },
      };
    case 'image':
      return { type, props: { alt: cleanStr(raw.alt, CAPS.alt) } };
    case 'button': {
      const align = ['left', 'center', 'right'].includes(raw.align) ? raw.align : 'center';
      return {
        type,
        props: {
          label: cleanStr(raw.label, CAPS.label) || 'Learn more',
          href: brand.site || undefined,
          align,
        },
      };
    }
    case 'products': {
      const columns = Math.max(1, Math.min(3, Math.round(Number(raw.columns)) || 2));
      // Prefer the brand's real catalogue (it carries prices + images); fall
      // back to the names the model chose so the block is never empty.
      const items = brand.items.length ? brand.items : normItems(raw.items);
      return { type, props: { columns, items } };
    }
    case 'divider':
      return { type, props: {} };
    case 'footer':
      return {
        type,
        props: {
          brandName: cleanStr(raw.brandName, CAPS.brandName) || brand.name,
          text: cleanStr(raw.text, CAPS.footer),
        },
      };
    default:
      return null;
  }
}

// Assemble the doc envelope (brand + currency + blocks) the way exampleDocForBrand
// does, then hand it to validateDoc — the single trust boundary — so the
// returned doc is ALWAYS a normalized, render-safe one.
function assembleDoc({ brand, currency, blocks }) {
  const docBrand = { name: brand.name };
  if (brand.primaryHex) docBrand.primaryHex = brand.primaryHex;
  if (brand.logoUrl) docBrand.logoUrl = brand.logoUrl;
  if (brand.site) docBrand.site = brand.site;
  const raw = { brand: docBrand, blocks: Array.isArray(blocks) ? blocks : [] };
  if (currency) raw.currency = currency;
  return raw;
}

/* ------------------------------------------------------------------ *
 * buildFallbackDoc — the deterministic floor
 * ------------------------------------------------------------------ */

// A sensible, BRAND-SPECIFIC real doc for the zero-key / LLM-fail / empty
// path: header + hero (only when a real logo/brand is present, mirroring
// generate's hero-if-logo) + a text block whose headline is derived from the
// brief + a products block when the brand/brief carries items + a button +
// footer. exampleDocForBrand is the ultimate floor (validateDoc guarantees a
// valid doc even if every heuristic below produced nothing).
function buildFallbackDoc(input) {
  const {
    brand, brief, useCase, currency,
  } = (input && typeof input === 'object') ? input : {};
  const b = normBrand(brand);
  const cur = coerceCurrencyLike(currency);
  const headline = headlineFrom({ brief, useCase, brandName: b.name });
  const body = bodyFrom({ brief, brandName: b.name, hasItems: b.items.length > 0 });

  const blocks = [{ type: 'header', props: { brandName: b.name } }];
  // hero-if-logo: a real logo (or at least a real brand identity) earns the
  // banner; without one the email opens straight into copy, same call generate
  // makes about a hero it would only be able to placeholder.
  if (b.logoUrl) blocks.push({ type: 'hero', props: { alt: `${b.name} hero` } });
  blocks.push({ type: 'text', props: { heading: headline, body } });
  if (b.items.length) {
    blocks.push({ type: 'products', props: { columns: b.items.length === 1 ? 1 : 2, items: b.items } });
  }
  blocks.push({
    type: 'button',
    props: { label: b.items.length ? 'Shop now' : 'Learn more', href: b.site || undefined, align: 'center' },
  });
  blocks.push({
    type: 'footer',
    props: { brandName: b.name, text: 'You are receiving this because you opted in to updates.' },
  });

  const v = validateDoc(assembleDoc({ brand: b, currency: cur, blocks }));
  // validateDoc only fails on a fundamentally unusable envelope, which the
  // assembled shape above never is — but honour the never-throw contract: an
  // empty valid doc beats a throw. (Unreachable in practice; a safety net.)
  return v.ok ? v.doc : validateDoc({ brand: { name: b.name }, blocks: [] }).doc;
}

// Only currencies email-doc/generate know survive; anything else is dropped so
// email-doc falls back to its own default. CURRENCIES is generate's, not
// exported through email-doc, so accept a small allowlist by shape instead —
// a 3-letter upper code — and let email-doc's coerceCurrency make the final
// call (an unknown code there simply omits the field).
function coerceCurrencyLike(c) {
  return (typeof c === 'string' && /^[A-Z]{3}$/.test(c)) ? c : undefined;
}

// A headline seeded from the brief/use-case so the fallback is never generic
// "Welcome to X" when the brief actually said something. The brief's first
// meaningful clause becomes the headline; absent a brief, a use-case or the
// brand-name welcome is the floor.
function headlineFrom({ brief, useCase, brandName }) {
  const uc = cleanStr(useCase, CAPS.heading);
  const briefText = cleanStr(brief, 400);
  if (briefText) {
    // First sentence/clause, title-trimmed to the heading cap.
    const first = briefText.split(/[.!?\n]/)[0].trim();
    const h = first || briefText;
    if (h) return h.slice(0, CAPS.heading);
  }
  if (uc) return uc;
  return `Welcome to ${brandName}`;
}

function bodyFrom({ brief, brandName, hasItems }) {
  const briefText = cleanStr(brief, CAPS.body);
  if (briefText && briefText.length > 40) return briefText;
  if (hasItems) {
    return `Discover what is new at ${brandName}. Handpicked for you, ready when you are — tap through to explore the full range.`;
  }
  return `Thanks for being part of ${brandName}. We have something new to share — take a look and let us know what you think.`;
}

/* ------------------------------------------------------------------ *
 * provider auto-detection — descriptor-shaped, usecase-engine's env order
 * ------------------------------------------------------------------ */

// Build { name, call(prompt, schema, timeoutMs) } descriptors from the same
// env keys + opt-in gates brief-content/usecase-engine use, in the SAME order
// (Claude, Gemini, Groq, Ollama). Descriptor shape (not usecase-engine's bare
// functions) because that is the convention pitch-api's llmProviders() /
// opts.providers speak. Env is read HERE (call time), never at module load.
function detectProviders() {
  const providers = [];
  if (process.env.ANTHROPIC_API_KEY) {
    try {
      // eslint-disable-next-line global-require
      const Anthropic = require('@anthropic-ai/sdk');
      const client = new Anthropic();
      providers.push({
        name: 'claude',
        call: (prompt, schema, timeoutMs) => callClaude({
          client, model: CLAUDE_MODEL, prompt, schema, timeoutMs,
        }),
      });
    } catch (e) {
      console.error('[doc-ai] failed to construct Anthropic client:', e && e.message);
    }
  }
  if (process.env.GEMINI_API_KEY) {
    const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
    providers.push({
      name: 'gemini',
      call: (prompt, schema, timeoutMs) => callGemini({
        apiKey: process.env.GEMINI_API_KEY, model, prompt, schema, timeoutMs,
      }),
    });
  }
  if (process.env.GROQ_API_KEY) {
    const model = process.env.GROQ_MODEL || 'llama-3.1-8b-instant';
    providers.push({
      name: 'groq',
      call: (prompt, schema, timeoutMs) => callGroq({
        apiKey: process.env.GROQ_API_KEY, model, prompt, schema, timeoutMs,
      }),
    });
  }
  const ollamaBase = process.env.OLLAMA_BASE_URL || null;
  if (ollamaBase) {
    const model = process.env.OLLAMA_MODEL || 'llama3.2';
    providers.push({
      name: 'ollama',
      call: (prompt, schema, timeoutMs) => callOllama({
        baseUrl: ollamaBase, model, prompt, schema, timeoutMs,
      }),
    });
  }
  return providers;
}

/* ------------------------------------------------------------------ *
 * generateDoc — the public entry
 * ------------------------------------------------------------------ */

// generateDoc({ brand, brief, useCase, currency }, { providers }) -> a
// VALIDATED doc, ALWAYS. Never throws, never hangs past TIMEOUT_MS. The FIRST
// configured provider (opts.providers descriptors, else env auto-detect in
// usecase-engine's order) drafts the doc; its output is mapped + validated;
// any failure/empty result degrades to buildFallbackDoc.
async function generateDoc(input = {}, opts = {}) {
  const {
    brand, brief, useCase, currency,
  } = (input && typeof input === 'object') ? input : {};
  const b = normBrand(brand);
  const cur = coerceCurrencyLike(currency);

  try {
    const providers = Array.isArray(opts.providers) ? opts.providers : detectProviders();
    const provider = providers.find((p) => p && typeof p.call === 'function');
    if (provider) {
      const schema = docSchema();
      const prompt = buildPrompt({ brand: b, brief, useCase });
      // Race the provider ourselves too (defense in depth, exactly as
      // composeContent does): a provider that forgets its own timeout can
      // never keep generateDoc pending past the budget.
      const raw = await withTimeout(
        () => Promise.resolve().then(() => provider.call(prompt, schema, TIMEOUT_MS)),
        TIMEOUT_MS,
      );
      const doc = docFromRaw(raw, b, cur);
      // A doc that survived to at least a header + one content block is a real
      // result; anything thinner (the model returned junk/markup and every
      // block was dropped by validateDoc) falls through to the fallback.
      if (doc && isSubstantial(doc)) return doc;
    }
  } catch (e) {
    // Nothing throws into the caller: a broken provider is a fallback, not a
    // 500. Logged so a misbehaving provider is visible.
    console.error('[doc-ai] generateDoc provider failed:', e && e.message);
  }
  return buildFallbackDoc({
    brand: b, brief, useCase, currency: cur,
  });
}

// Parse (string or object), map each block, assemble + validateDoc. Returns a
// validated doc or null (nothing usable). Never throws.
function docFromRaw(raw, brand, currency) {
  let obj = raw;
  if (typeof obj === 'string') {
    try { obj = JSON.parse(obj); } catch { return null; }
  }
  if (!obj || typeof obj !== 'object') return null;
  const rawBlocks = Array.isArray(obj.blocks) ? obj.blocks : [];
  const blocks = rawBlocks.map((rb) => mapBlock(rb, brand)).filter(Boolean).slice(0, MAX_LLM_BLOCKS);
  if (!blocks.length) return null;
  const v = validateDoc(assembleDoc({ brand, currency, blocks }));
  return v.ok ? v.doc : null;
}

// "Real result" gate: a header alone (or a lone divider) is not an email. Ask
// for at least one substantive content block — text/hero/products/image/button —
// so a degenerate LLM response reliably falls back to the seeded doc.
function isSubstantial(doc) {
  const substantive = new Set(['text', 'hero', 'products', 'image', 'button']);
  const blocks = (doc && Array.isArray(doc.blocks)) ? doc.blocks : [];
  return blocks.some((bl) => substantive.has(bl.type));
}

module.exports = { generateDoc, buildFallbackDoc };
