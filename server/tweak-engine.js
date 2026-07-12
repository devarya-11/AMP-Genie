'use strict';

// Prompt-to-tweak engine for v3: turns a free-text edit request ("make it
// #112233", "switch to the quiz", "more premium") against an existing build
// into a small, strictly-validated EDIT PLAN of parameter changes, then
// rebuilds the email through the one shared pipeline (createBuild). The LLM
// never touches markup — it edits parameters (module, tone, vertical,
// currency, colour, discount, copy fields), the engine rebuilds, and the real
// AMP validator gates the result before anything is persisted.
//
// Tiering follows the house religion (see server/brief-content.js): the
// deterministic extractor below is the zero-key floor — hex colours, "N%"
// discounts, module/tone/vertical mentions pulled straight from the prompt —
// so a keyless deployment still tweaks. When a provider is configured it
// drafts the plan instead (one call to the FIRST configured provider, like
// usecase-engine, not brief-content's fan-out), schema-constrained JSON that
// is re-validated locally against the exact same allowlist. applyTweak()
// never throws for a bad request and never hangs past the timeout budget;
// only a missing validate dep throws, same contract as createBuild.

const { MODULES, MODULE_IDS, CURRENCIES } = require('./generate');
const { TONES, VERTICALS } = require('./content');
const { validatePlan, FIELD_SCHEMAS, schemaFor } = require('./brief-content');
const { routeBrief } = require('./brief-router');
const { createBuild } = require('./build-pipeline');
const { getBuild } = require('./store');
const {
  callClaude, callGemini, callGroq, callOllama, withTimeout,
} = require('./llm-providers');

const CLAUDE_MODEL = 'claude-haiku-4-5';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const GROQ_MODEL = process.env.GROQ_MODEL || 'llama-3.1-8b-instant';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'llama3.2';
// Same opt-in gate as brief-content: a bare checkout never reaches out to an
// arbitrary local port unless OLLAMA_BASE_URL was explicitly set.
const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || null;

// A tweak is a single interactive round-trip (the user is waiting on the
// rebuild), so it gets more than composeContent's 8s but less than
// usecase-engine's research-grade 15s.
const TIMEOUT_MS = 12000;

// The prompt is untrusted client text headed into an LLM prompt and the
// persisted build record (tweakPrompt) — capped like usecase-engine's
// feedback, generous enough for a real sentence of direction.
const PROMPT_MAX = 500;

// The strict final '#rrggbb' form, same shape store.js's brand kits demand.
const HEX_RRGGBB = /^#[0-9a-f]{6}$/i;

/* ------------------------------------------------------------------ *
 * validateEditPlan — the local allowlist every edit plan must survive
 * ------------------------------------------------------------------ */

// THE rule (see brief-content's validateStringField): no string anywhere in a
// plan may carry '<' or '>'. validatePlan re-checks copy strings anyway, but
// the whole edit plan is rejected up front so a marked-up value can never
// survive by merely degrading into a smaller, still-tainted plan.
function hasMarkup(value) {
  if (typeof value === 'string') return /[<>]/.test(value);
  if (Array.isArray(value)) return value.some(hasMarkup);
  if (value && typeof value === 'object') return Object.values(value).some(hasMarkup);
  return false;
}

// Case-insensitive membership in a canonical allowlist, returning the
// CANONICAL spelling (a provider answering 'premium' still lands on
// 'Premium') — still an allowlist, never a pass-through.
function canonIn(val, list) {
  if (typeof val !== 'string') return null;
  const needle = val.trim().toLowerCase();
  if (!needle) return null;
  return list.find((item) => item.toLowerCase() === needle) || null;
}

// Allowlist re-validation of one edit plan (LLM output or the deterministic
// extractor's). moduleId is the build's CURRENT module — copy is validated
// against the module the plan LANDS on (plan.moduleId when it changes the
// module, else the current one), because those are the fields the rebuilt
// email will actually accept. Unknown fields are stripped; a copy object
// failing validatePlan degrades to {} (the rest of the plan still applies);
// discount is folded into copy.discount (generate()'s validPct consumes it
// there — it is deliberately NOT a validatePlan field, see brief-router's
// briefSignals). Returns null when nothing usable remains.
function validateEditPlan(moduleId, obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  if (hasMarkup(obj)) return null;
  const out = {};
  if (typeof obj.moduleId === 'string' && MODULE_IDS.includes(obj.moduleId)) out.moduleId = obj.moduleId;
  const tone = canonIn(obj.tone, Object.keys(TONES));
  if (tone) out.tone = tone;
  const vertical = canonIn(obj.vertical, VERTICALS);
  if (vertical) out.vertical = vertical;
  const currency = canonIn(obj.currency, Object.keys(CURRENCIES));
  if (currency) out.currency = currency;
  if (typeof obj.colorOverride === 'string' && HEX_RRGGBB.test(obj.colorOverride.trim())) {
    out.colorOverride = obj.colorOverride.trim().toLowerCase();
  }
  const effModule = out.moduleId || moduleId;
  let copy = {};
  if (obj.copy && typeof obj.copy === 'object' && !Array.isArray(obj.copy)) {
    copy = validatePlan(effModule, obj.copy) || {};
  }
  const discount = Math.round(Number(obj.discount));
  if (Number.isFinite(discount) && discount >= 1 && discount <= 99) copy.discount = discount;
  if (Object.keys(copy).length) out.copy = copy;
  return Object.keys(out).length ? out : null;
}

/* ------------------------------------------------------------------ *
 * deterministicPlan — the zero-key floor
 * ------------------------------------------------------------------ */

// Pulls concrete, unambiguous edits straight out of the prompt text: a hex
// colour, a "N%" discount (briefSignals' exact grammar — a literal '%' so
// "top 20 products" is never misread), a module named via routeBrief's
// keywords or its display name, and tone/vertical words. Everything found is
// funnelled through validateEditPlan so both tiers return the same shape.
// null when the prompt names nothing actionable.
function deterministicPlan(prompt, currentModuleId) {
  const text = String(prompt || '').trim();
  if (!text) return null;
  const lower = text.toLowerCase();
  const raw = {};
  const hex = text.match(/#[0-9a-f]{6}\b/i);
  if (hex) raw.colorOverride = hex[0];
  const pct = text.match(/(\d{1,3})\s*%/);
  if (pct) raw.discount = Math.round(Number(pct[1]));
  // routeBrief matches raw substrings — fine for prose briefs, where 'emi'
  // buried in a sentence really means EMI, but loud on a short tweak prompt:
  // 'more premium' contains 'emi' and would route to calc. A module change is
  // the biggest move a tweak can make, so the routed pick is only taken when
  // one of its matched terms stands as a whole word in the prompt.
  const routed = routeBrief(text);
  const wholeWord = (term) => new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(text);
  if (routed && routed.matchedTerms.some(wholeWord)) {
    raw.moduleId = routed.moduleId;
  } else {
    for (const id of MODULE_IDS) {
      if (lower.includes(MODULES[id].name.toLowerCase())) { raw.moduleId = id; break; }
    }
  }
  // Tone/vertical names are all plain alphabetic words, so building a
  // word-boundary regex from them is safe.
  for (const tone of Object.keys(TONES)) {
    if (new RegExp(`\\b${tone}\\b`, 'i').test(text)) { raw.tone = tone; break; }
  }
  for (const vertical of VERTICALS) {
    if (new RegExp(`\\b${vertical}\\b`, 'i').test(text)) { raw.vertical = vertical; break; }
  }
  return validateEditPlan(currentModuleId, raw);
}

/* ------------------------------------------------------------------ *
 * prompt + JSON schema for the LLM tier
 * ------------------------------------------------------------------ */

// One copy schema serves every provider: the union of every module's field
// schema (same construction, same Object.assign last-wins caveat, as
// usecase-engine's planUnionSchema), because the plan may change the module
// in the same breath as the copy. The prompt pins the copy to the landing
// module's fields; validateEditPlan enforces it locally regardless.
function copyUnionSchema() {
  const properties = {};
  for (const id of MODULE_IDS) {
    const moduleSchema = schemaFor(id);
    if (moduleSchema) Object.assign(properties, moduleSchema.properties);
  }
  return { type: 'object', properties, additionalProperties: false };
}

function editSchema() {
  return {
    type: 'object',
    properties: {
      moduleId: { type: 'string', enum: MODULE_IDS.slice() },
      tone: { type: 'string', enum: Object.keys(TONES) },
      vertical: { type: 'string', enum: VERTICALS.slice() },
      currency: { type: 'string', enum: Object.keys(CURRENCIES) },
      colorOverride: { type: 'string', pattern: '^#[0-9a-fA-F]{6}$' },
      discount: { type: 'integer', minimum: 1, maximum: 99 },
      copy: copyUnionSchema(),
    },
    additionalProperties: false,
  };
}

function moduleFieldLines() {
  return MODULE_IDS.map((id) => {
    const fields = Object.keys(FIELD_SCHEMAS[id] || {}).join(', ');
    return `- ${id} ("${MODULES[id].name}"): copy fields ${fields}`;
  }).join('\n');
}

// The build's current PARAMETERS are the whole context — never the ampHtml
// (markup in a prompt invites markup in an answer, and the plan is parameters
// by design). params.copy is the final merged copy the build rendered with,
// so "change the headline" edits what the user actually saw.
function buildEditPrompt({ prompt, build }) {
  const params = build.params || {};
  const copy = (params.copy && typeof params.copy === 'object') ? params.copy : {};
  return `You are editing the PARAMETERS of an existing interactive AMP email for the brand "${build.brand}". A teammate asked for this change:
"""
${prompt}
"""

Current build parameters:
- module: ${build.moduleId} ("${(MODULES[build.moduleId] || {}).name || build.moduleId}")
- vertical: ${build.vertical}
- tone: ${build.tone}
- currency: ${build.currency}
- primary colour: ${(build.palette && build.palette.primary) || 'default'}
- current copy overrides: ${JSON.stringify(copy).slice(0, 1500)}

Available modules and the copy fields each accepts:
${moduleFieldLines()}

Return a JSON object with ONLY the fields that should CHANGE to satisfy the request: moduleId (one of: ${MODULE_IDS.join(', ')}), tone (one of: ${Object.keys(TONES).join(', ')}), vertical (one of: ${VERTICALS.join(', ')}), currency (one of: ${Object.keys(CURRENCIES).join(', ')}), colorOverride (a #rrggbb hex), discount (whole number 1-99), copy (an object using ONLY the landing module's fields listed above). Omit everything that should stay as it is. Plain text everywhere: no HTML, no markdown, no links, never the characters < or >.`;
}

/* ------------------------------------------------------------------ *
 * providers
 * ------------------------------------------------------------------ */

// Environment auto-detection mirrors usecase-engine's defaultProviders: a
// tweak asks only the FIRST configured provider (order below is preference
// order) — one call, and any failure degrades straight to the deterministic
// extractor rather than trying the next key.
function defaultProviders() {
  const providers = [];
  if (process.env.ANTHROPIC_API_KEY) {
    try {
      const Anthropic = require('@anthropic-ai/sdk');
      const client = new Anthropic();
      providers.push((prompt, schema, timeoutMs) => callClaude({
        client, model: CLAUDE_MODEL, prompt, schema, timeoutMs,
      }));
    } catch (e) {
      console.error('[tweak-engine] failed to construct Anthropic client:', e && e.message);
    }
  }
  if (process.env.GEMINI_API_KEY) {
    providers.push((prompt, schema, timeoutMs) => callGemini({
      apiKey: process.env.GEMINI_API_KEY, model: GEMINI_MODEL, prompt, schema, timeoutMs,
    }));
  }
  if (process.env.GROQ_API_KEY) {
    providers.push((prompt, schema, timeoutMs) => callGroq({
      apiKey: process.env.GROQ_API_KEY, model: GROQ_MODEL, prompt, schema, timeoutMs,
    }));
  }
  if (OLLAMA_BASE_URL) {
    providers.push((prompt, schema, timeoutMs) => callOllama({
      baseUrl: OLLAMA_BASE_URL, model: OLLAMA_MODEL, prompt, schema, timeoutMs,
    }));
  }
  return providers;
}

// Single-provider call with the same never-throw / never-hang contract as
// usecase-engine's callFirstProvider: a sync throw is folded into the
// promise, the budget is raced here as defense in depth even though the
// built-in providers time themselves out, and a string body is parsed.
// Accepts a bare thunk (prompt, schema, timeoutMs) or a brief-content-style
// { name, call } descriptor, so either provider convention can be injected.
async function callFirstProvider(providers, prompt, schema, timeoutMs) {
  const first = providers[0];
  const call = typeof first === 'function'
    ? first
    : (first && typeof first.call === 'function' ? first.call.bind(first) : null);
  if (!call) return null;
  try {
    const raw = await withTimeout(() => Promise.resolve().then(() => call(prompt, schema, timeoutMs)), timeoutMs);
    if (raw == null) return null;
    if (typeof raw === 'string') {
      try { return JSON.parse(raw); } catch (e) { return null; }
    }
    return typeof raw === 'object' ? raw : null;
  } catch (e) {
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * proposeEditPlan / applyTweak
 * ------------------------------------------------------------------ */

// input: { prompt, build } — prompt is the free-text edit request, build the
// persisted record being edited (its params/palette/moduleId feed the LLM
// context; the ampHtml never does). opts: { providers (DI array of provider
// thunks), timeoutMs (tests only) }. Returns a validateEditPlan-shaped plan,
// or null when neither the LLM tier nor the deterministic floor found a
// concrete change. Never throws.
async function proposeEditPlan(input = {}, opts = {}) {
  const args = (input && typeof input === 'object') ? input : {};
  const build = (args.build && typeof args.build === 'object') ? args.build : null;
  const prompt = typeof args.prompt === 'string' ? args.prompt.trim().slice(0, PROMPT_MAX) : '';
  if (!prompt || !build) return null;

  const providers = Array.isArray(opts.providers) ? opts.providers : defaultProviders();
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : TIMEOUT_MS;

  if (providers.length) {
    const raw = await callFirstProvider(providers, buildEditPrompt({ prompt, build }), editSchema(), timeoutMs);
    const plan = raw ? validateEditPlan(build.moduleId, raw) : null;
    if (plan) return plan;
  }
  return deterministicPlan(prompt, build.moduleId);
}

/* ------------------------------------------------------------------ *
 * versions — the tweak lineage list
 * ------------------------------------------------------------------ */

// A single newest-first list of version SUMMARIES per tweak family, keyed by
// the family's root build id — the same single-key, capped, read-modify-write
// pattern (and non-atomicity caveat) as store.js's slate index. Lives HERE
// rather than in store.js because the version list is the tweak engine's own
// bookkeeping, not a general store primitive.
const VERSIONS_MAX = 50;

// Mirrors store.js's ID_SHAPE (not exported there): ids become KV key
// suffixes, so junk (or hostile — '../etc') input is refused up front.
const ID_SHAPE = /^[a-z0-9-]{6,64}$/;

async function readVersions(kv, rootId) {
  if (!kv || !ID_SHAPE.test(String(rootId || ''))) return [];
  try {
    const parsed = await kv.get('versions:' + rootId, 'json');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function appendVersion(kv, rootId, entry) {
  if (!kv || !ID_SHAPE.test(String(rootId || ''))) return false;
  const list = await readVersions(kv, rootId);
  list.unshift(entry);
  if (list.length > VERSIONS_MAX) list.length = VERSIONS_MAX;
  try {
    await kv.put('versions:' + rootId, JSON.stringify(list));
    return true;
  } catch (e) {
    console.error('[tweak-engine] failed to persist versions:' + rootId + ':', e && e.message);
    return false;
  }
}

/* ------------------------------------------------------------------ *
 * applyTweak — the whole move: plan, rebuild, gate, persist
 * ------------------------------------------------------------------ */

// input: { buildId, prompt, author, kv } — untrusted client values plus the
// store handle. opts: { validate (REQUIRED, same contract as createBuild's),
// providers/timeoutMs passed through to proposeEditPlan }.
// Returns { ok: true, response, build } (the same wire shape /generate
// returns, plus the persisted record) or { ok: false, error } — every bad
// request degrades to an explanatory error, never a throw; only the missing
// validate dep throws, exactly like createBuild.
async function applyTweak(input = {}, opts = {}) {
  const args = (input && typeof input === 'object') ? input : {};
  const { kv = null } = args;
  const author = typeof args.author === 'string' ? args.author : null;
  const prompt = typeof args.prompt === 'string' ? args.prompt.trim().slice(0, PROMPT_MAX) : '';

  const build = await getBuild(kv, args.buildId);
  if (!build) return { ok: false, error: 'No such build.' };
  if (!build.params || typeof build.params !== 'object') {
    return { ok: false, error: 'This build predates tweak support — regenerate it first.' };
  }

  const plan = await proposeEditPlan({ prompt, build }, opts);
  if (!plan) {
    return { ok: false, error: 'Could not turn that into a concrete change — try naming a colour, discount, module, tone, or copy change.' };
  }

  // The rebuild request: the plan's edits over the build's own persisted
  // parameters, field by field. params.copy is the parent's FINAL merged
  // copy, so plan.copy edits layer on top of exactly what rendered before.
  const body = {
    brand: build.brand,
    brief: build.brief,
    vertical: plan.vertical || build.vertical,
    tone: plan.tone || build.tone,
    currency: plan.currency || build.currency,
    colorOverride: plan.colorOverride || build.params.colorOverride,
    moduleId: plan.moduleId || build.moduleId,
    counter: build.params.counter,
    copy: { ...build.params.copy, ...(plan.copy || {}) },
  };
  const deps = {
    validate: opts.validate,
    author: author || build.author,
    slateId: build.slateId,
    useCase: build.useCase,
    parentId: build.id,
    rootId: build.rootId || build.id,
    tweakPrompt: prompt,
  };

  // Gate before persisting: a failed tweak must leave NOTHING behind, so the
  // validity check runs with kv=null first, and only a passing plan is
  // rebuilt with the real kv — determinism makes the two byte-identical.
  const dry = await createBuild(body, { ...deps, kv: null });
  if (!dry.response.validation.pass) {
    return { ok: false, error: 'That change broke AMP validity — nothing was saved.', validation: dry.response.validation };
  }
  const { response, build: next } = await createBuild(body, { ...deps, kv });

  // Best-effort lineage bookkeeping, same contract as every store write: a
  // failed append loses a listing row, never the tweaked build itself.
  await appendVersion(kv, build.rootId || build.id, {
    id: next.id, ts: next.ts, tweakPrompt: prompt, moduleId: next.moduleId,
  });
  return { ok: true, response, build: next };
}

module.exports = {
  applyTweak, proposeEditPlan, validateEditPlan, deterministicPlan, readVersions,
};
