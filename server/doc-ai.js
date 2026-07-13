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

const emailDoc = require('./email-doc');
const { validateDoc, BLOCK_TYPES } = emailDoc;
const { routeBrief } = require('./brief-router');
const {
  callClaude, callGemini, callGroq, callOllama, withTimeout,
} = require('./llm-providers');

// The GENIE 2.0 interactive-doc contract from server/email-doc.js. Another
// agent added these three exports (interactiveDocForModule / fieldsForModule /
// INTERACTIVE_TYPES) in the same phase; they are REQUIRED defensively so this
// module still loads (and generateDoc still degrades to the static fallback)
// if it is imported before those exports land. Each call site guards on the
// function's presence rather than assuming it — the never-throw charter.
// Resolved at CALL time from the live email-doc module object, NEVER captured
// into a const at load. On the Workers esbuild bundle, email-doc's exports may
// not be populated when THIS module initializes (module init order differs
// from Node's), which froze INTERACTIVE_TYPES as an empty Set and made every
// interactive check fail — so the deployment produced static docs while local
// (Node's load order) worked. Reading emailDoc.* per call is load-order-proof.
const EMPTY_SET = new Set();
function interactiveDocForModule(args) {
  return typeof emailDoc.interactiveDocForModule === 'function' ? emailDoc.interactiveDocForModule(args) : null;
}
function fieldsForModule(id) {
  return typeof emailDoc.fieldsForModule === 'function' ? emailDoc.fieldsForModule(id) : [];
}
function interactiveTypes() {
  return emailDoc.INTERACTIVE_TYPES instanceof Set ? emailDoc.INTERACTIVE_TYPES : EMPTY_SET;
}

// The module a brief with no interactive signal defaults to. 'quiz' when the
// brief/use-case reads as engagement (a two-way interaction), else 'reveal'
// (the lightest, most universal tap-to-reveal). Kept tiny + deterministic so
// the floor is predictable; the LLM never picks the module, only the copy.
const ENGAGEMENT_RE = /\b(engage|engagement|interact|quiz|game|gamif|play|fun|personal(?:ise|ize|ity)|match|which|discover|find your)\b/i;
const DEFAULT_INTERACTIVE_ID = 'reveal';

// Resolve which interactive module the doc carries: an explicit id (opts or
// arg) wins; else the deterministic brief router (server/brief-router.js);
// else the engagement heuristic's quiz-or-reveal default. Always returns a
// real interactive id from INTERACTIVE_TYPES so the doc can never carry a
// module id the renderer does not know.
function resolveModuleId({ moduleId, brief, useCase } = {}) {
  const explicit = typeof moduleId === 'string' ? moduleId.trim() : '';
  if (explicit && interactiveTypes().has(explicit)) return explicit;
  const routed = routeBrief(brief, undefined);
  if (routed && routed.moduleId && interactiveTypes().has(routed.moduleId)) {
    return routed.moduleId;
  }
  const hay = `${cleanStr(useCase, 200)} ${cleanStr(brief, 400)}`;
  if (ENGAGEMENT_RE.test(hay) && interactiveTypes().has('quiz')) return 'quiz';
  return interactiveTypes().has(DEFAULT_INTERACTIVE_ID)
    ? DEFAULT_INTERACTIVE_ID
    : (interactiveTypes().size ? [...interactiveTypes()][0] : DEFAULT_INTERACTIVE_ID);
}

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
 * the LLM JSON schema — the interactive module's copy + optional framing
 * ------------------------------------------------------------------ */

// The INTERACTIVE schema (GENIE 2.0): the doc is ALWAYS one routed interactive
// module (its copy fields) plus 0-2 optional PLAIN-TEXT static blocks around it
// (a hero line / a text intro / a footer). The model fills copy for the module
// it is TOLD to use (it never picks the module) and may propose a couple of
// framing blocks; the local merge + validateDoc enforce the real shape. `copy`
// is an open string map (the module's fieldsForModule keys), kept honest by the
// local merge which only reads the keys that module actually declares.
function interactiveDocSchema(fields) {
  const copyProps = {};
  for (const f of (Array.isArray(fields) ? fields : [])) {
    copyProps[f] = { type: 'string', maxLength: CAPS.body };
  }
  const staticBlock = {
    type: 'object',
    properties: {
      type: { type: 'string', enum: ['hero', 'text', 'footer'] },
      heading: { type: 'string', maxLength: CAPS.heading },
      body: { type: 'string', maxLength: CAPS.body },
      alt: { type: 'string', maxLength: CAPS.alt },
      text: { type: 'string', maxLength: CAPS.footer },
      brandName: { type: 'string', maxLength: CAPS.brandName },
    },
    required: ['type'],
    additionalProperties: false,
  };
  return {
    type: 'object',
    properties: {
      copy: {
        type: 'object',
        properties: copyProps,
        additionalProperties: false,
      },
      before: { type: 'array', maxItems: 2, items: staticBlock },
      after: { type: 'array', maxItems: 2, items: staticBlock },
    },
    required: ['copy'],
    additionalProperties: false,
  };
}

// The interactive-doc prompt: tell the model which module it is filling, list
// exactly the copy fields it may set, and invite 0-2 plain-text framing blocks.
// The module choice is OURS (routed deterministically); the model only writes
// copy. Same plain-text-only / no-markup discipline the whole module keeps.
function buildInteractivePrompt({
  brand, brief, useCase, moduleId, fields,
}) {
  const uc = cleanStr(useCase, 160);
  const fieldList = (Array.isArray(fields) ? fields : []).join(', ') || '(none)';
  const lines = [
    `You are a lifecycle-marketing designer writing the COPY for an interactive marketing email for the brand "${brand.name}".`,
    `The email's centrepiece is a "${moduleId}" interactive module. You do NOT choose the module — you write its copy.`,
    '',
    `Fill these copy fields for the "${moduleId}" module (write real, specific marketing copy for each; omit a field only if it truly does not apply): ${fieldList}.`,
    'You MAY also propose up to two short PLAIN-TEXT framing blocks before and/or after the module — a hero line (alt), a text intro (heading + body), or a footer (text). Keep them optional and brief; the module already carries the brand header and CTA.',
    '',
    'Rules:',
    '- Output PLAIN TEXT only in every field. No HTML, no markdown, no links, no angle brackets.',
    '- Write realistic, specific copy grounded in the brand and brief. NEVER lorem ipsum or placeholder text.',
    '- The `copy` object is required; `before` and `after` are optional arrays of framing blocks.',
    '',
  ];
  if (brand.voice) {
    lines.push('Brand voice — match it, never copy sentences verbatim:', '"""', brand.voice.slice(0, 400), '"""', '');
  }
  if (uc) lines.push(`Use-case / angle for this email: ${uc}`, '');
  lines.push(...briefLines(brief));
  lines.push(...itemLines(brand.items));
  lines.push(`Write the "${moduleId}" module's copy now for "${brand.name}".`);
  return lines.join('\n');
}

/* ------------------------------------------------------------------ *
 * prompt helpers (shared by buildInteractivePrompt)
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
 * interactive doc assembly (GENIE 2.0): every doc carries ONE interactive block
 * ------------------------------------------------------------------ */

// The deterministic interactive FLOOR: a validated block doc whose single
// interactive block is the routed module, its `head` seeded from the brief /
// use-case so the floor is never generic. This is what generateDoc ALWAYS
// returns if the LLM tier fails, and what buildFallbackDoc returns as its
// zero-key floor. Guards on interactiveDocForModule's presence (the pinned
// email-doc export) — if it is missing at import time, degrade to an empty
// valid doc rather than throw (the orchestrator's combined suite runs once the
// export lands; a standalone import must still not crash).
function interactiveBase({
  brand, moduleId, brief, useCase, currency,
}) {
  const head = headlineFrom({ brief, useCase, brandName: brand.name });
  const doc = interactiveDocForModule({
    brand: {
      name: brand.name,
      primaryHex: brand.primaryHex,
      logoUrl: brand.logoUrl,
    },
    moduleId,
    copy: head ? { head } : {},
    currency,
  });
  // interactiveDocForModule returns null (or an interactive-less doc) only if
  // email-doc's export is genuinely unavailable — degrade to an empty valid
  // doc rather than fabricating an unrenderable one.
  if (doc && Array.isArray(doc.blocks) && doc.blocks.some((b) => interactiveTypes().has(b.type))) {
    return doc;
  }
  const v = validateDoc(assembleDoc({ brand, currency, blocks: [] }));
  return v.ok ? v.doc : { version: 1, blocks: [] };
}

// Map ONE raw LLM framing block — ONLY hero / text / footer are allowed around
// the interactive module (a second header/button/products would double up the
// module's own header + CTA). Returns null for anything else. Reuses mapBlock's
// per-type scrubbing so the two stay in lock-step.
const FRAMING_TYPES = new Set(['hero', 'text', 'footer']);
function mapFramingBlock(raw, brand) {
  if (!raw || typeof raw !== 'object' || !FRAMING_TYPES.has(raw.type)) return null;
  return mapBlock(raw, brand);
}

// Merge an LLM interactive result onto the base interactive doc: overlay the
// model's copy onto the interactive block's props (only the module's declared
// fields survive validateDoc), and prepend/append any valid framing blocks.
// Then re-validate — anything invalid is dropped. Returns a validated doc that
// STILL contains exactly one interactive block, or null if nothing usable
// survived (caller falls back to the base).
function mergeInteractive({
  base, raw, brand, moduleId, currency,
}) {
  let obj = raw;
  if (typeof obj === 'string') {
    try { obj = JSON.parse(obj); } catch { return null; }
  }
  if (!obj || typeof obj !== 'object') return null;

  // The interactive block from the base doc (its props are the deterministic
  // floor's copy, e.g. { head }); overlay the LLM copy for this module's fields.
  const baseBlock = (base.blocks || []).find((b) => interactiveTypes().has(b.type))
    || { type: moduleId, props: {} };
  const fields = fieldsForModule(moduleId);
  const llmCopy = (obj.copy && typeof obj.copy === 'object' && !Array.isArray(obj.copy)) ? obj.copy : {};
  const mergedProps = { ...(baseBlock.props || {}) };
  for (const key of fields) {
    const v = cleanStr(llmCopy[key], CAPS.body);
    if (v) mergedProps[key] = v;
  }
  const interactiveBlock = { type: moduleId, props: mergedProps };

  const before = (Array.isArray(obj.before) ? obj.before : [])
    .map((rb) => mapFramingBlock(rb, brand)).filter(Boolean).slice(0, 2);
  const after = (Array.isArray(obj.after) ? obj.after : [])
    .map((rb) => mapFramingBlock(rb, brand)).filter(Boolean).slice(0, 2);

  const blocks = [...before, interactiveBlock, ...after];
  const v = validateDoc(assembleDoc({ brand, currency, blocks }));
  // Keep the merged doc only if it still holds the interactive block after the
  // trust boundary (validateDoc keeps at most one interactive block; a doc that
  // somehow lost it is not a valid interactive doc — fall back to the base).
  if (!v.ok) return null;
  const hasInteractive = (v.doc.blocks || []).some((b) => interactiveTypes().has(b.type));
  return hasInteractive ? v.doc : null;
}

/* ------------------------------------------------------------------ *
 * buildFallbackDoc — the deterministic floor
 * ------------------------------------------------------------------ */

// A sensible, BRAND-SPECIFIC real doc for the zero-key / LLM-fail / empty path.
// GENIE 2.0 rule: EVERY doc includes exactly ONE interactive block, so the
// floor is the routed interactive module (its `head` seeded from the brief),
// optionally framed by a text intro and — when the brand/brief carries items —
// a products grid. The interactive module renders its own brand header, CTA and
// footer inside its body, so the fallback deliberately does NOT add a static
// header/button/footer (that would double them). interactiveBase (via
// email-doc's interactiveDocForModule) is the guaranteed valid floor even if
// every framing heuristic below produced nothing.
function buildFallbackDoc(input) {
  const {
    brand, brief, useCase, currency, moduleId,
  } = (input && typeof input === 'object') ? input : {};
  const b = normBrand(brand);
  const cur = coerceCurrencyLike(currency);
  const modId = resolveModuleId({ moduleId, brief, useCase });

  const base = interactiveBase({
    brand: b, moduleId: modId, brief, useCase, currency: cur,
  });
  const interactiveBlock = (base.blocks || []).find((bl) => interactiveTypes().has(bl.type));
  // If the interactive export has not landed, base carries no interactive block;
  // return it (an empty valid doc) rather than fabricating an unrenderable one.
  if (!interactiveBlock) return base;

  const body = bodyFrom({ brief, brandName: b.name, hasItems: b.items.length > 0 });
  const framing = [];
  // A short text intro above the module when the brief gave us real body copy.
  if (body) framing.push({ type: 'text', props: { heading: '', body } });
  // The brand's real catalogue, when it has one, rides a products grid below.
  const after = [];
  if (b.items.length) {
    after.push({ type: 'products', props: { columns: b.items.length === 1 ? 1 : 2, items: b.items } });
  }

  const blocks = [...framing, interactiveBlock, ...after];
  const v = validateDoc(assembleDoc({ brand: b, currency: cur, blocks }));
  // validateDoc only fails on a fundamentally unusable envelope, which the
  // assembled shape above never is — but honour the never-throw contract, and
  // ALWAYS keep the interactive block: the base doc (which is already validated
  // and carries the module) is the floor beneath the floor.
  if (v.ok && (v.doc.blocks || []).some((bl) => interactiveTypes().has(bl.type))) return v.doc;
  return base;
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

// generateDoc({ brand, brief, useCase, moduleId, currency }, { providers }) ->
// a VALIDATED doc that ALWAYS carries exactly ONE interactive block. Never
// throws, never hangs past TIMEOUT_MS.
//
// The module is resolved FIRST (explicit id > brief router > engagement
// default) and NEVER chosen by the LLM. interactiveBase is the deterministic
// floor — a validated doc wrapping that module — and is ALWAYS what we return
// if the LLM tier fails. When a provider is configured, the FIRST one fills the
// module's copy fields (and may propose 1-2 plain-text framing blocks); its
// output is merged onto the base and re-validated, so anything invalid is
// dropped. If the merged doc fails to validate, loses the interactive block, or
// the model returned nothing usable, the base is returned unchanged.
async function generateDoc(input = {}, opts = {}) {
  const inp = (input && typeof input === 'object') ? input : {};
  const {
    brand, brief, useCase, currency,
  } = inp;
  const options = (opts && typeof opts === 'object') ? opts : {};
  const b = normBrand(brand);
  const cur = coerceCurrencyLike(currency);
  // Explicit id from opts wins over the arg; both beat the router/default.
  const modId = resolveModuleId({
    moduleId: options.moduleId || inp.moduleId,
    brief,
    useCase,
  });

  // The deterministic floor: ALWAYS a valid interactive doc, returned as-is if
  // anything below fails.
  const base = interactiveBase({
    brand: b, moduleId: modId, brief, useCase, currency: cur,
  });

  try {
    const providers = Array.isArray(options.providers) ? options.providers : detectProviders();
    const provider = providers.find((p) => p && typeof p.call === 'function');
    // Only run the LLM tier when the base actually carries the interactive
    // block (i.e. email-doc's interactive export is present); otherwise there
    // is nothing to enrich and the fallback path owns it.
    const hasInteractive = (base.blocks || []).some((bl) => interactiveTypes().has(bl.type));
    if (provider && hasInteractive) {
      const fields = fieldsForModule(modId);
      const schema = interactiveDocSchema(fields);
      const prompt = buildInteractivePrompt({
        brand: b, brief, useCase, moduleId: modId, fields,
      });
      // Race the provider ourselves too (defense in depth, exactly as
      // composeContent does): a provider that forgets its own timeout can
      // never keep generateDoc pending past the budget.
      const raw = await withTimeout(
        () => Promise.resolve().then(() => provider.call(prompt, schema, TIMEOUT_MS)),
        TIMEOUT_MS,
      );
      const merged = mergeInteractive({
        base, raw, brand: b, moduleId: modId, currency: cur,
      });
      // merged is null unless it validated AND still holds the interactive block.
      if (merged) return merged;
    }
  } catch (e) {
    // Nothing throws into the caller: a broken provider is a fallback, not a
    // 500. Logged so a misbehaving provider is visible.
    console.error('[doc-ai] generateDoc provider failed:', e && e.message);
  }
  // The base is already a validated interactive doc; buildFallbackDoc would add
  // brief-seeded framing, so prefer it (it also guards the no-export case) but
  // keep the same resolved module so the floor is consistent with the base.
  return buildFallbackDoc({
    brand: b, brief, useCase, currency: cur, moduleId: modId,
  });
}

// ---- custom-AMP adapter: pasted HTML/AMP -> a valid AMP4EMAIL body fragment --
// The FIRST configured provider rewrites the paste into a body fragment + the
// list of AMP extensions it needs. NO validation here (runtime-agnostic, no
// validator) — the pitch-api handler renders + validates and feeds errors back
// for a retry. With no provider, the deterministic fallback passes the paste
// through (email-doc sanitizes it) and auto-detects <amp-*> components.
const CUSTOM_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['compiled', 'components'],
  properties: {
    compiled: { type: 'string', description: 'A valid AMP4EMAIL BODY fragment only — no <html>/<head>/<body>, no <style amp-custom>, no <link>, no executable <script>. Inline style="" is allowed.' },
    components: { type: 'array', items: { type: 'string' }, description: 'AMP extension component names used, e.g. amp-carousel, amp-accordion.' },
  },
};
function customComponentsList() {
  const map = emailDoc.AMP_EMAIL_COMPONENTS || {};
  return Object.keys(map).join(', ');
}
function detectComponents(html) {
  const found = new Set();
  const re = /<(amp-[a-z0-9-]+)/gi;
  let m;
  while ((m = re.exec(String(html || '')))) found.add(m[1].toLowerCase());
  return Array.from(found);
}
function buildCustomPrompt({ raw, errors }) {
  let p = 'You convert pasted HTML/AMP into a VALID AMP4EMAIL body fragment for a marketing email.\n'
    + 'RULES:\n'
    + '- Output ONLY the body fragment: no <html>, <head>, <body>, <style amp-custom>, <link>, or executable <script>.\n'
    + '- Use only AMP4EMAIL-allowed tags. Allowed extensions: ' + customComponentsList() + '.\n'
    + '- Replace <img> with <amp-img> (with width, height and layout). Convert CSS-background images to <amp-img> where possible.\n'
    + '- No inline event handlers (onclick, onload, …). No external CSS or JS. Inline style="" IS allowed.\n'
    + '- Do NOT use the amp-state id "s" (it is reserved). List every AMP extension you used in "components".\n\n'
    + 'PASTED SOURCE:\n' + String(raw || '').slice(0, 8000);
  if (errors && errors.length) {
    p += '\n\nYour previous attempt FAILED the AMP4EMAIL validator with these errors:\n'
      + errors.slice(0, 8).map((e) => '- ' + (typeof e === 'string' ? e : e.message)).join('\n')
      + '\nReturn corrected JSON that fixes them.';
  }
  return p;
}
async function adaptCustomAmp(input = {}, opts = {}) {
  const raw = typeof input.raw === 'string' ? input.raw : '';
  const providers = Array.isArray(opts.providers) ? opts.providers : detectProviders();
  const provider = providers.find((p) => p && typeof p.call === 'function');
  if (provider) {
    try {
      const out = await withTimeout(
        () => Promise.resolve().then(() => provider.call(buildCustomPrompt({ raw, errors: input.errors }), CUSTOM_SCHEMA, TIMEOUT_MS)),
        TIMEOUT_MS,
      );
      if (out && typeof out.compiled === 'string' && out.compiled.trim()) {
        return { compiled: out.compiled, components: Array.isArray(out.components) ? out.components : [], usedLlm: true };
      }
    } catch (e) {
      console.error('[doc-ai] adaptCustomAmp provider failed:', e && e.message);
    }
  }
  return { compiled: raw, components: detectComponents(raw), usedLlm: false };
}

module.exports = { generateDoc, buildFallbackDoc, adaptCustomAmp };
