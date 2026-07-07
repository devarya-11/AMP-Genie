'use strict';

// Brief-driven content composer: turns a free-text campaign brief into a
// small, strictly-validated content plan (copy overrides for the chosen
// module). This is the ONLY place an LLM's output can influence generated
// copy — and even then, only as short plain-text strings slotted into the
// existing template pipeline (server/generate.js's copy.* fields), never as
// raw HTML/markup. The plan is schema-constrained by each provider's own
// structured-output feature and then re-validated locally as defense in
// depth.
//
// Multi-provider "best of N": every configured provider (Claude, Gemini,
// Groq, local Ollama) is called in parallel for the same brief/module. Each
// response is independently re-validated against the exact same allowlist,
// scored with a lightweight heuristic (server/llm-providers.js has no
// opinion on quality — that judgment lives here), and only the
// highest-scoring valid plan is returned. Metered free tiers (Gemini, Groq)
// self-throttle via server/llm-providers.js's cooldown mechanism once they
// report a quota/rate-limit error, so an exhausted free tier is skipped
// rather than hammered or silently billed. Local Ollama has no quota and
// costs nothing to try, so it is always attempted once configured.
//
// Contract: composeContent() never throws and never hangs the request past
// TIMEOUT_MS — any failure across ALL providers (no keys configured, every
// call erroring/timing out, every response failing validation) degrades to
// null, so /generate always succeeds using generate()'s own template
// defaults.

const {
  callClaude, callGemini, callGroq, callOllama, withTimeout,
} = require('./llm-providers');

const CLAUDE_MODEL = 'claude-haiku-4-5';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const GROQ_MODEL = process.env.GROQ_MODEL || 'llama-3.1-8b-instant';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'llama3.2';
// Ollama is opt-in: only tried by default once OLLAMA_BASE_URL is set (e.g.
// to http://localhost:11434), so a bare checkout/CI run never reaches out to
// an arbitrary local port. Same pattern as the *_API_KEY gates below.
const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || null;

const TIMEOUT_MS = 8000;
const MAX_LEN = 140;

// Kept for backward compatibility with anything importing the old single-
// provider export name.
const MODEL = CLAUDE_MODEL;

// Per-module allowlist of copy fields an LLM plan may set. Mirrors exactly
// the copy.* fields each build function in server/generate.js accepts, so a
// validated plan can be merged straight into `copy` with no translation step.
const FIELD_SCHEMAS = {
  reveal: ['head', 'teaserText', 'ctaLabel', 'footerText'],
  search: ['head', 'footerText'],
  quiz: ['head', 'question', 'footerText'],
  rating: ['head', 'prompt', 'footerText'],
  spin: ['head', 'teaserText', 'footerText'],
  poll: ['head', 'question', 'optionA', 'optionB', 'footerText'],
};

function schemaFor(moduleId) {
  const fields = FIELD_SCHEMAS[moduleId];
  if (!fields) return null;
  const properties = {};
  for (const key of fields) properties[key] = { type: 'string' };
  return { type: 'object', properties, additionalProperties: false };
}

// Defense-in-depth: re-validate the parsed plan even though each provider's
// own structured-output feature already constrains the JSON shape. Reject
// the ENTIRE plan (-> null) on any unrecognised key, non-string value, empty
// string, over-long string, or any '<'/'>' character (a model going off the
// rails and writing HTML/markup, which must never reach the template).
function validatePlan(moduleId, obj) {
  const fields = FIELD_SCHEMAS[moduleId];
  if (!fields || !obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const allowed = new Set(fields);
  const out = {};
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) return null;
    const val = obj[key];
    if (typeof val !== 'string') return null;
    const trimmed = val.trim();
    if (!trimmed || trimmed.length > MAX_LEN) return null;
    if (/[<>]/.test(trimmed)) return null;
    out[key] = trimmed;
  }
  return Object.keys(out).length ? out : null;
}

// Heuristic quality proxy used to pick the best plan across providers.
// Deliberately NOT another LLM call (that would just add cost/latency/a new
// failure mode to rank outputs) — a cheap, deterministic scorer instead:
// rewards covering more of the module's fields and landing in a natural
// "short sentence" length band, penalises spammy patterns (excess '!',
// SHOUTING, generic filler like "act now"). Higher is better; -Infinity for
// nothing usable.
const FILLER_RE = /click here|amazing offer|don'?t miss out|act now|limited time|shop now/i;
const SHOUT_RE = /\b[A-Z]{5,}\b/;

function scorePlan(plan, fields) {
  if (!plan) return -Infinity;
  const keys = Object.keys(plan);
  if (!keys.length) return -Infinity;
  let score = (keys.length / fields.length) * 10;
  for (const key of keys) {
    const val = plan[key];
    const len = val.length;
    if (len >= 16 && len <= 90) score += 2;
    const bangs = (val.match(/!/g) || []).length;
    if (bangs > 1) score -= (bangs - 1);
    if (SHOUT_RE.test(val)) score -= 2;
    if (FILLER_RE.test(val)) score -= 3;
  }
  return score;
}

function buildPrompt({ moduleId, brandName, vertical, briefText, fieldList }) {
  return `You are writing short marketing copy fragments for one AMP email module ("${moduleId}") for the brand "${brandName || 'the brand'}"${vertical ? ` in the "${vertical}" vertical` : ''}.

Campaign brief (context for tone/subject only — never quote it verbatim, never include HTML, markdown, or links):
"""
${briefText}
"""

Write plain-text copy for any of these fields you can meaningfully improve on a generic default: ${fieldList}. Each value must be a short single sentence or phrase, under ${MAX_LEN} characters, no HTML, no markdown, no quotation marks. Omit any field you are not confident about.`;
}

// Builds the default provider list from environment/injected config. Each
// entry is { name, call(prompt, schema, timeoutMs) -> Promise<rawObj|null> }.
// opts.client (test/production Claude client injection) is the one
// exception carried over from the single-provider version for backward
// compatibility — everything else is auto-detected from env vars so a
// deployer only has to set the API key(s) they actually have.
function defaultProviders(opts) {
  const providers = [];

  let claudeClient = opts.client;
  if (!claudeClient && process.env.ANTHROPIC_API_KEY) {
    try {
      const Anthropic = require('@anthropic-ai/sdk');
      claudeClient = new Anthropic();
    } catch (e) {
      console.error('[brief-content] failed to construct Anthropic client:', e && e.message);
    }
  }
  if (claudeClient) {
    providers.push({
      name: 'claude',
      call: (prompt, schema, timeoutMs) => callClaude({
        client: claudeClient, model: CLAUDE_MODEL, prompt, schema, timeoutMs,
      }),
    });
  }

  if (process.env.GEMINI_API_KEY) {
    providers.push({
      name: 'gemini',
      call: (prompt, schema, timeoutMs) => callGemini({
        apiKey: process.env.GEMINI_API_KEY, model: GEMINI_MODEL, prompt, schema, timeoutMs,
      }),
    });
  }

  if (process.env.GROQ_API_KEY) {
    providers.push({
      name: 'groq',
      call: (prompt, schema, timeoutMs) => callGroq({
        apiKey: process.env.GROQ_API_KEY, model: GROQ_MODEL, prompt, schema, timeoutMs,
      }),
    });
  }

  if (OLLAMA_BASE_URL) {
    providers.push({
      name: 'ollama',
      call: (prompt, schema, timeoutMs) => callOllama({
        baseUrl: OLLAMA_BASE_URL, model: OLLAMA_MODEL, prompt, schema, timeoutMs,
      }),
    });
  }

  return providers;
}

// briefText: the free-text campaign brief (already trimmed/normalized by the
// caller; null/empty means "skip"). ctx: { moduleId, vertical, brandName }.
// opts.client: an injectable Anthropic SDK client instance, for tests/back-
// compat — folded into the default Claude provider when present.
// opts.providers: full override — an array of { name, call } descriptors,
// used by tests to exercise multi-provider scoring without any real network
// calls or env-based auto-detection.
// opts.timeoutMs: override the ~8s default budget (tests only), applied
// uniformly to every provider in the fan-out.
async function composeContent(briefText, ctx = {}, opts = {}) {
  const { moduleId, vertical, brandName } = ctx;
  const fields = FIELD_SCHEMAS[moduleId];
  if (!briefText || !fields) return null;

  const providers = Array.isArray(opts.providers) ? opts.providers : defaultProviders(opts);
  if (!providers.length) return null;

  const schema = schemaFor(moduleId);
  const fieldList = fields.join(', ');
  const prompt = buildPrompt({
    moduleId, brandName, vertical, briefText, fieldList,
  });
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : TIMEOUT_MS;

  // Each provider is expected to honour its own timeoutMs internally (every
  // built-in call* in server/llm-providers.js does), but we ALSO race it
  // here — defense in depth so a misbehaving/injected provider (e.g. a test
  // double, or a future provider that forgets its own timeout) can never
  // keep composeContent() itself pending past the budget.
  const settled = await Promise.allSettled(
    providers.map((p) => withTimeout(() => Promise.resolve().then(() => p.call(prompt, schema, timeoutMs)), timeoutMs)),
  );

  let best = null;
  let bestScore = -Infinity;
  for (const outcome of settled) {
    if (outcome.status !== 'fulfilled' || !outcome.value) continue;
    let raw = outcome.value;
    if (typeof raw === 'string') {
      try { raw = JSON.parse(raw); } catch (e) { continue; }
    }
    const plan = validatePlan(moduleId, raw);
    if (!plan) continue;
    const score = scorePlan(plan, fields);
    if (score > bestScore) {
      bestScore = score;
      best = plan;
    }
  }
  return best;
}

module.exports = {
  composeContent, validatePlan, scorePlan, FIELD_SCHEMAS, MODEL, CLAUDE_MODEL, TIMEOUT_MS,
};
