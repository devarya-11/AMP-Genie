'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const {
  callClaude, callGemini, callGroq, callOllama,
  isCoolingDown, cooldown, resetCooldowns, withTimeout, looksLikeQuotaExhausted,
} = require('../server/llm-providers');

const SCHEMA = { type: 'object', properties: { head: { type: 'string' } }, additionalProperties: false };

function fakeFetch(handler) {
  return async (url, init) => handler(url, init);
}
function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

// ---- withTimeout ------------------------------------------------------------

test('withTimeout resolves with the real value when it wins the race', async () => {
  const result = await withTimeout(() => Promise.resolve('done'), 1000);
  assert.strictEqual(result, 'done');
});

test('withTimeout resolves to null (not hang) once the budget elapses, and clears its timer', async () => {
  const start = Date.now();
  const result = await withTimeout(() => new Promise(() => {}), 30);
  assert.strictEqual(result, null);
  assert.ok(Date.now() - start < 1000);
});

// ---- looksLikeQuotaExhausted ------------------------------------------------

test('looksLikeQuotaExhausted recognises 429 always, and 403 only when quota/rate-limit is mentioned', () => {
  assert.strictEqual(looksLikeQuotaExhausted(429, ''), true);
  assert.strictEqual(looksLikeQuotaExhausted(403, 'You have exceeded your quota'), true);
  assert.strictEqual(looksLikeQuotaExhausted(403, 'Forbidden: bad API key'), false);
  assert.strictEqual(looksLikeQuotaExhausted(500, 'server error'), false);
});

// ---- callClaude -------------------------------------------------------------

test('callClaude returns null with no client, and never throws on a client error', async () => {
  assert.strictEqual(await callClaude({ client: null, model: 'x', prompt: 'p', schema: SCHEMA, timeoutMs: 100 }), null);
  const client = { messages: { parse: async () => { throw new Error('down'); } } };
  await assert.doesNotReject(async () => {
    assert.strictEqual(await callClaude({
      client, model: 'x', prompt: 'p', schema: SCHEMA, timeoutMs: 100,
    }), null);
  });
});

test('callClaude returns parsed_output on success', async () => {
  const client = { messages: { parse: async () => ({ parsed_output: { head: 'hi' } }) } };
  const out = await callClaude({
    client, model: 'x', prompt: 'p', schema: SCHEMA, timeoutMs: 100,
  });
  assert.deepStrictEqual(out, { head: 'hi' });
});

// ---- callGemini -------------------------------------------------------------

test('callGemini returns null with no API key (never calls fetch)', async () => {
  const out = await callGemini({
    apiKey: null, model: 'gemini-2.5-flash', prompt: 'p', schema: SCHEMA, timeoutMs: 100, fetchImpl: fail,
  });
  assert.strictEqual(out, null);
  function fail() { throw new Error('should not be called'); }
});

test('callGemini parses candidates[0].content.parts[0].text on success', async () => {
  const fetchImpl = fakeFetch(() => jsonResponse(200, { candidates: [{ content: { parts: [{ text: '{"head":"Gemini says hi"}' }] } }] }));
  const out = await callGemini({
    apiKey: 'k', model: 'gemini-2.5-flash', prompt: 'p', schema: SCHEMA, timeoutMs: 100, fetchImpl,
  });
  assert.deepStrictEqual(out, { head: 'Gemini says hi' });
});

test('callGemini strips additionalProperties from nested array/object schemas (quiz-options shape), not just the top level', async () => {
  const nestedSchema = {
    type: 'object',
    properties: {
      options: {
        type: 'array',
        items: {
          type: 'object',
          properties: { label: { type: 'string' }, result: { type: 'string' } },
          required: ['label'],
          additionalProperties: false,
        },
      },
    },
    additionalProperties: false,
  };
  let sentBody;
  const fetchImpl = fakeFetch((url, init) => {
    sentBody = JSON.parse(init.body);
    return jsonResponse(200, { candidates: [{ content: { parts: [{ text: '{"options":[]}' }] } }] });
  });
  await callGemini({
    apiKey: 'k', model: 'gemini-2.5-flash', prompt: 'p', schema: nestedSchema, timeoutMs: 100, fetchImpl,
  });
  const sentSchema = sentBody.generationConfig.responseSchema;
  assert.strictEqual(sentSchema.additionalProperties, undefined);
  assert.strictEqual(sentSchema.properties.options.items.additionalProperties, undefined,
    'a nested additionalProperties inside an array\'s object items must be stripped too, or Gemini 400s on it');
});

test('callGemini trips a cooldown on a 429 and skips subsequent calls until it expires', async () => {
  resetCooldowns();
  let calls = 0;
  const fetchImpl = fakeFetch(() => { calls += 1; return jsonResponse(429, { error: 'rate limited' }); });
  const first = await callGemini({
    apiKey: 'k', model: 'gemini-2.5-flash', prompt: 'p', schema: SCHEMA, timeoutMs: 100, fetchImpl,
  });
  assert.strictEqual(first, null);
  assert.strictEqual(calls, 1);
  assert.strictEqual(isCoolingDown('gemini'), true);
  const second = await callGemini({
    apiKey: 'k', model: 'gemini-2.5-flash', prompt: 'p', schema: SCHEMA, timeoutMs: 100, fetchImpl,
  });
  assert.strictEqual(second, null);
  assert.strictEqual(calls, 1, 'cooled-down provider must not be called again');
  resetCooldowns();
});

// ---- callGroq ---------------------------------------------------------------

test('callGroq parses choices[0].message.content on success', async () => {
  const fetchImpl = fakeFetch(() => jsonResponse(200, { choices: [{ message: { content: '{"head":"Groq says hi"}' } }] }));
  const out = await callGroq({
    apiKey: 'k', model: 'llama-3.1-8b-instant', prompt: 'p', schema: SCHEMA, timeoutMs: 100, fetchImpl,
  });
  assert.deepStrictEqual(out, { head: 'Groq says hi' });
});

test('callGroq returns null and never throws on malformed JSON content', async () => {
  const fetchImpl = fakeFetch(() => jsonResponse(200, { choices: [{ message: { content: 'not json' } }] }));
  await assert.doesNotReject(async () => {
    const out = await callGroq({
      apiKey: 'k', model: 'llama-3.1-8b-instant', prompt: 'p', schema: SCHEMA, timeoutMs: 100, fetchImpl,
    });
    assert.strictEqual(out, null);
  });
});

// ---- callOllama -------------------------------------------------------------

test('callOllama parses message.content on success', async () => {
  const fetchImpl = fakeFetch(() => jsonResponse(200, { message: { content: '{"head":"Local model says hi"}' } }));
  const out = await callOllama({
    baseUrl: 'http://localhost:11434', model: 'llama3.2', prompt: 'p', schema: SCHEMA, timeoutMs: 100, fetchImpl,
  });
  assert.deepStrictEqual(out, { head: 'Local model says hi' });
});

test('callOllama degrades to null (not a throw) when the connection is refused', async () => {
  const fetchImpl = async () => { throw new Error('connect ECONNREFUSED 127.0.0.1:11434'); };
  await assert.doesNotReject(async () => {
    const out = await callOllama({
      baseUrl: 'http://localhost:11434', model: 'llama3.2', prompt: 'p', schema: SCHEMA, timeoutMs: 100, fetchImpl,
    });
    assert.strictEqual(out, null);
  });
});

test('cooldown()/isCoolingDown() honour a custom duration and expire', async () => {
  resetCooldowns();
  cooldown('groq', 20);
  assert.strictEqual(isCoolingDown('groq'), true);
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.strictEqual(isCoolingDown('groq'), false);
});
