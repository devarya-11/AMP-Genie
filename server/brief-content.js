'use strict';

// Brief-driven content composer: turns a free-text campaign brief into a
// small, strictly-validated content plan (copy overrides for the chosen
// module). This is the ONLY place an LLM's output can influence generated
// copy — and even then, only as short plain-text strings slotted into the
// existing template pipeline (server/generate.js's copy.* fields), never as
// raw HTML/markup. The plan is schema-constrained by the API call itself
// (output_config.format) and then re-validated locally as defense in depth.
//
// Contract: composeContent() never throws and never hangs the request past
// TIMEOUT_MS — any failure (missing API key, network error, timeout,
// malformed/unparseable response, an unrecognised field) degrades to null,
// so /generate always succeeds using generate()'s own template defaults.

const MODEL = 'claude-haiku-4-5';
const TIMEOUT_MS = 8000;
const MAX_LEN = 140;

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

// Defense-in-depth: re-validate the parsed plan even though the SDK already
// constrained the JSON schema server-side. Reject the ENTIRE plan (-> null)
// on any unrecognised key, non-string value, empty string, over-long string,
// or any '<'/'>' character (a model going off the rails and writing
// HTML/markup, which must never reach the template).
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

// Returns [timeoutPromise, cancel] so the caller can clear the underlying
// timer as soon as the real call settles — otherwise a dangling setTimeout
// keeps the process (and, in tests, the whole node:test run) alive for the
// full budget even after the race was already won by the API call.
function timeoutAfter(ms) {
  let timer;
  const promise = new Promise((resolve) => { timer = setTimeout(() => resolve(null), ms); });
  return [promise, () => clearTimeout(timer)];
}

// briefText: the free-text campaign brief (already trimmed/normalized by the
// caller; null/empty means "skip"). ctx: { moduleId, vertical, brandName }.
// opts.client: an injectable Anthropic SDK client instance, for tests —
// falls back to a real client built from ANTHROPIC_API_KEY when omitted.
// opts.timeoutMs: override the ~8s default budget (tests only).
async function composeContent(briefText, ctx = {}, opts = {}) {
  const { moduleId, vertical, brandName } = ctx;
  const fields = FIELD_SCHEMAS[moduleId];
  if (!briefText || !fields) return null;

  let client = opts.client;
  if (!client) {
    if (!process.env.ANTHROPIC_API_KEY) return null;
    try {
      const Anthropic = require('@anthropic-ai/sdk');
      client = new Anthropic();
    } catch (e) {
      console.error('[brief-content] failed to construct Anthropic client:', e && e.message);
      return null;
    }
  }

  const schema = schemaFor(moduleId);
  const fieldList = fields.join(', ');
  const prompt = `You are writing short marketing copy fragments for one AMP email module ("${moduleId}") for the brand "${brandName || 'the brand'}"${vertical ? ` in the "${vertical}" vertical` : ''}.

Campaign brief (context for tone/subject only — never quote it verbatim, never include HTML, markdown, or links):
"""
${briefText}
"""

Write plain-text copy for any of these fields you can meaningfully improve on a generic default: ${fieldList}. Each value must be a short single sentence or phrase, under ${MAX_LEN} characters, no HTML, no markdown, no quotation marks. Omit any field you are not confident about.`;

  try {
    const call = client.messages.parse({
      model: MODEL,
      max_tokens: 512,
      thinking: { type: 'disabled' },
      messages: [{ role: 'user', content: prompt }],
      output_config: { format: { type: 'json_schema', schema } },
    });
    const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : TIMEOUT_MS;
    const [timeoutPromise, cancelTimeout] = timeoutAfter(timeoutMs);
    let msg;
    try {
      msg = await Promise.race([call, timeoutPromise]);
    } finally {
      cancelTimeout();
    }
    if (!msg || !msg.parsed_output) return null;
    return validatePlan(moduleId, msg.parsed_output);
  } catch (e) {
    console.error('[brief-content] composeContent failed:', e && e.message);
    return null;
  }
}

module.exports = { composeContent, validatePlan, FIELD_SCHEMAS, MODEL, TIMEOUT_MS };
