'use strict';

// Thin, dependency-free (fetch-based) callers for the optional multi-provider
// content generation fan-out in server/brief-content.js. Every exported
// call* function follows the same contract: NEVER throw, resolve to null on
// ANY failure (missing config, network error, timeout, non-2xx response,
// unparseable JSON) — a broken or exhausted provider degrades silently so
// composeContent() can always fall back to whichever providers *did* answer,
// or to null (template defaults) if none did.
//
// Free-tier discipline ("stop before any money is required"): Gemini and
// Groq are metered free tiers that can throttle or, on some account types,
// spill into paid usage once exhausted. When either reports a quota/rate
// error we trip an in-memory cooldown for that provider so subsequent
// requests skip it for a while instead of hammering an exhausted tier.
// Ollama is a fully local, permanently-free model with no quota concept, so
// it never cools down — a connection failure there just means "not
// installed/running right now".

const COOLDOWN_MS = 10 * 60 * 1000; // 10 minutes

const cooldowns = new Map(); // providerName -> ms timestamp when cooldown ends

function isCoolingDown(name) {
  const until = cooldowns.get(name);
  return typeof until === 'number' && Date.now() < until;
}

function cooldown(name, ms = COOLDOWN_MS) {
  cooldowns.set(name, Date.now() + ms);
}

function resetCooldowns() {
  cooldowns.clear();
}

// Runs `startFn()` (which must return a Promise) against a timeout budget.
// Always resolves — never rejects — and always clears its internal timer via
// `finally`, regardless of which side of the race wins. A dangling
// setTimeout otherwise keeps the process (and, in tests, the whole node:test
// run) alive past the real call's resolution — a lesson learned the hard way
// in the single-provider version of this feature.
async function withTimeout(startFn, ms) {
  let timer;
  const timeoutPromise = new Promise((resolve) => { timer = setTimeout(() => resolve(null), ms); });
  try {
    return await Promise.race([startFn(), timeoutPromise]);
  } finally {
    clearTimeout(timer);
  }
}

// A 429 (Too Many Requests), or a 403 whose body mentions quota/rate-limit,
// is treated as "this free tier is exhausted for now".
function looksLikeQuotaExhausted(status, bodyText) {
  if (status === 429) return true;
  if (status === 403 && /quota|rate.?limit/i.test(bodyText || '')) return true;
  return false;
}

// ---- Claude (Anthropic) -----------------------------------------------------
// Uses an injected SDK client (a real client built from ANTHROPIC_API_KEY, or
// a fake test double) — this module never constructs the client itself.
async function callClaude({ client, model, prompt, schema, timeoutMs }) {
  if (!client) return null;
  try {
    const msg = await withTimeout(() => client.messages.parse({
      model,
      max_tokens: 512,
      thinking: { type: 'disabled' },
      messages: [{ role: 'user', content: prompt }],
      output_config: { format: { type: 'json_schema', schema } },
    }), timeoutMs);
    if (!msg || !msg.parsed_output) return null;
    return msg.parsed_output;
  } catch (e) {
    console.error('[llm-providers] Claude call failed:', e && e.message);
    return null;
  }
}

// Gemini's responseSchema is a restricted OpenAPI subset — it rejects plain
// JSON-Schema keys like `additionalProperties` with a 400 ("Cannot find
// field"). Strip anything Gemini doesn't understand rather than passing our
// shared schema object through as-is.
function toGeminiSchema(schema) {
  if (!schema || typeof schema !== 'object') return schema;
  const { additionalProperties, ...rest } = schema;
  if (rest.properties) {
    const properties = {};
    for (const [key, val] of Object.entries(rest.properties)) properties[key] = toGeminiSchema(val);
    rest.properties = properties;
  }
  return rest;
}

// ---- Gemini (Google AI Studio, free tier) ----------------------------------
async function callGemini({ apiKey, model, prompt, schema, timeoutMs, fetchImpl = fetch }) {
  if (!apiKey) return null;
  if (isCoolingDown('gemini')) return null;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  try {
    const res = await withTimeout(() => fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: 'application/json', responseSchema: toGeminiSchema(schema) },
      }),
    }), timeoutMs);
    if (!res) return null;
    if (!res.ok) {
      const bodyText = await res.text().catch(() => '');
      if (looksLikeQuotaExhausted(res.status, bodyText)) cooldown('gemini');
      return null;
    }
    const data = await res.json();
    const text = data && data.candidates && data.candidates[0] && data.candidates[0].content
      && data.candidates[0].content.parts && data.candidates[0].content.parts[0]
      && data.candidates[0].content.parts[0].text;
    if (!text) return null;
    return JSON.parse(text);
  } catch (e) {
    console.error('[llm-providers] Gemini call failed:', e && e.message);
    return null;
  }
}

// ---- Groq (OpenAI-compatible chat completions, free tier) -----------------
async function callGroq({ apiKey, model, prompt, schema, timeoutMs, fetchImpl = fetch }) {
  if (!apiKey) return null;
  if (isCoolingDown('groq')) return null;
  try {
    const res = await withTimeout(() => fetchImpl('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: `Respond with ONLY a single minified JSON object matching this JSON schema, no prose, no markdown fences: ${JSON.stringify(schema)}` },
          { role: 'user', content: prompt },
        ],
        response_format: { type: 'json_object' },
      }),
    }), timeoutMs);
    if (!res) return null;
    if (!res.ok) {
      const bodyText = await res.text().catch(() => '');
      if (looksLikeQuotaExhausted(res.status, bodyText)) cooldown('groq');
      return null;
    }
    const data = await res.json();
    const text = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    if (!text) return null;
    return JSON.parse(text);
  } catch (e) {
    console.error('[llm-providers] Groq call failed:', e && e.message);
    return null;
  }
}

// ---- Ollama (fully local, permanently free) --------------------------------
// No API key, no quota, so no cooldown logic — a connection error just means
// "not installed/running right now", which is an expected, silent null.
async function callOllama({ baseUrl, model, prompt, schema, timeoutMs, fetchImpl = fetch }) {
  try {
    const res = await withTimeout(() => fetchImpl(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        stream: false,
        format: schema,
        messages: [{ role: 'user', content: prompt }],
      }),
    }), timeoutMs);
    if (!res || !res.ok) return null;
    const data = await res.json();
    const text = data && data.message && data.message.content;
    if (!text) return null;
    return JSON.parse(text);
  } catch (e) {
    return null;
  }
}

module.exports = {
  callClaude, callGemini, callGroq, callOllama,
  isCoolingDown, cooldown, resetCooldowns, withTimeout, looksLikeQuotaExhausted, COOLDOWN_MS,
};
