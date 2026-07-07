'use strict';
const { test } = require('node:test');
const assert = require('node:assert');

// Deterministic defaults: make sure no ambient env var accidentally enables
// a real provider (Gemini/Groq/Ollama) during this suite — every test that
// wants a provider active injects it explicitly via opts.providers or
// opts.client, so results never depend on the machine running the tests.
delete process.env.GEMINI_API_KEY;
delete process.env.GROQ_API_KEY;
delete process.env.OLLAMA_BASE_URL;

const {
  composeContent, validatePlan, scorePlan, FIELD_SCHEMAS,
} = require('../server/brief-content');
const { generate } = require('../server/generate');
const { validate } = require('../server/validator');

function fail() { throw new Error('should not be called'); }

// ---- validatePlan: defense-in-depth schema allowlist -----------------------

test('validatePlan accepts a well-formed plan matching the module allowlist', () => {
  const plan = validatePlan('quiz', { head: 'New head', question: 'New question?', footerText: 'New footer' });
  assert.deepStrictEqual(plan, { head: 'New head', question: 'New question?', footerText: 'New footer' });
});

test('validatePlan rejects the whole plan on any unrecognised key', () => {
  assert.strictEqual(validatePlan('quiz', { head: 'ok', bogusField: 'nope' }), null);
});

test('validatePlan rejects non-string values, empty strings, and over-long strings', () => {
  assert.strictEqual(validatePlan('reveal', { head: 42 }), null);
  assert.strictEqual(validatePlan('reveal', { head: '   ' }), null);
  assert.strictEqual(validatePlan('reveal', { head: 'x'.repeat(200) }), null);
});

test('validatePlan rejects any value containing < or > (no markup leakage)', () => {
  assert.strictEqual(validatePlan('rating', { prompt: 'Rate us <b>now</b>' }), null);
});

test('validatePlan rejects an unknown moduleId or a non-object payload', () => {
  assert.strictEqual(validatePlan('not-a-module', { head: 'x' }), null);
  assert.strictEqual(validatePlan('quiz', null), null);
  assert.strictEqual(validatePlan('quiz', ['array', 'not', 'object']), null);
});

test('validatePlan rejects an empty object (nothing usable)', () => {
  assert.strictEqual(validatePlan('poll', {}), null);
});

test('every FIELD_SCHEMAS moduleId is a real generate.js module', () => {
  const { MODULE_IDS } = require('../server/generate');
  for (const id of Object.keys(FIELD_SCHEMAS)) {
    assert.ok(MODULE_IDS.includes(id), `${id} should be a real module id`);
  }
});

// ---- scorePlan: heuristic best-of-N quality proxy --------------------------

test('scorePlan returns -Infinity for null or an empty plan', () => {
  assert.strictEqual(scorePlan(null, FIELD_SCHEMAS.quiz), -Infinity);
  assert.strictEqual(scorePlan({}, FIELD_SCHEMAS.quiz), -Infinity);
});

test('scorePlan rewards fuller field coverage over partial coverage', () => {
  const full = scorePlan({ head: 'A tidy little headline', question: 'Which one wins today?', footerText: 'Picked for you' }, FIELD_SCHEMAS.quiz);
  const partial = scorePlan({ head: 'A tidy little headline' }, FIELD_SCHEMAS.quiz);
  assert.ok(full > partial, `expected fuller coverage to score higher: ${full} vs ${partial}`);
});

test('scorePlan penalises spammy filler and shouting over clean copy', () => {
  const clean = scorePlan({ head: 'Discover our summer picks' }, FIELD_SCHEMAS.reveal);
  const spammy = scorePlan({ head: 'ACT NOW!!! AMAZING OFFER!!!' }, FIELD_SCHEMAS.reveal);
  assert.ok(clean > spammy, `expected clean copy to outscore spammy copy: ${clean} vs ${spammy}`);
});

// ---- composeContent: dependency-injected fake providers, no real network --

test('composeContent returns null when no brief is given', async () => {
  const providers = [{ name: 'x', call: fail }];
  const plan = await composeContent(null, { moduleId: 'quiz' }, { providers });
  assert.strictEqual(plan, null);
  const plan2 = await composeContent('', { moduleId: 'quiz' }, { providers });
  assert.strictEqual(plan2, null);
});

test('composeContent returns null for an unsupported/unknown moduleId', async () => {
  const providers = [{ name: 'x', call: fail }];
  const plan = await composeContent('Summer sale, 20% off everything', { moduleId: 'not-a-module' }, { providers });
  assert.strictEqual(plan, null);
});

test('composeContent returns null when no providers are configured at all', async () => {
  const plan = await composeContent('Some brief', { moduleId: 'reveal' }, { providers: [] });
  assert.strictEqual(plan, null);
});

test('composeContent (backward-compat): opts.client alone drives the default Claude provider', async () => {
  const client = {
    messages: {
      parse: async () => ({ parsed_output: { head: 'Big Summer Drop', question: 'Which look wins?', footerText: 'Handpicked for you' } }),
    },
  };
  const plan = await composeContent('A summer fashion drop, playful tone', { moduleId: 'quiz', vertical: 'Fashion', brandName: 'Acme' }, { client });
  assert.deepStrictEqual(plan, { head: 'Big Summer Drop', question: 'Which look wins?', footerText: 'Handpicked for you' });
});

test('composeContent falls back to null when the only provider\'s response is schema-invalid', async () => {
  const providers = [{ name: 'bad', call: async () => ({ head: 'ok', notAllowedField: 'nope' }) }];
  const plan = await composeContent('Some brief', { moduleId: 'reveal' }, { providers });
  assert.strictEqual(plan, null);
});

test('composeContent falls back to null when a provider resolves to null/nothing', async () => {
  const providers = [{ name: 'empty', call: async () => null }];
  const plan = await composeContent('Some brief', { moduleId: 'reveal' }, { providers });
  assert.strictEqual(plan, null);
});

test('composeContent never throws — a throwing provider resolves to null', async () => {
  const providers = [{ name: 'boom', call: async () => { throw new Error('network exploded'); } }];
  await assert.doesNotReject(async () => {
    const plan = await composeContent('Some brief', { moduleId: 'reveal' }, { providers });
    assert.strictEqual(plan, null);
  });
});

test('composeContent never throws even when a provider throws synchronously (not just via rejected promise)', async () => {
  const providers = [{ name: 'sync-boom', call: () => { throw new Error('sync explosion'); } }];
  await assert.doesNotReject(async () => {
    const plan = await composeContent('Some brief', { moduleId: 'reveal' }, { providers });
    assert.strictEqual(plan, null);
  });
});

test('composeContent resolves to null (not hang) once its timeout budget elapses', async () => {
  const providers = [{ name: 'stuck', call: () => new Promise(() => {}) }]; // never resolves
  const start = Date.now();
  const plan = await composeContent('Some brief', { moduleId: 'reveal' }, { providers, timeoutMs: 50 });
  assert.strictEqual(plan, null);
  assert.ok(Date.now() - start < 2000, 'must resolve promptly via the timeout race, not hang');
});

// ---- best-of-N selection across multiple providers -------------------------

test('composeContent picks the higher-scoring plan when multiple providers succeed', async () => {
  const providers = [
    { name: 'spammy', call: async () => ({ head: 'ACT NOW!!! AMAZING OFFER!!!' }) },
    { name: 'clean', call: async () => ({ head: 'A tidy summer refresh', teaserText: 'New arrivals, curated for you', footerText: 'Made just for you' }) },
  ];
  const plan = await composeContent('A summer refresh', { moduleId: 'reveal' }, { providers });
  assert.deepStrictEqual(plan, { head: 'A tidy summer refresh', teaserText: 'New arrivals, curated for you', footerText: 'Made just for you' });
});

test('composeContent uses whichever provider survives when others fail validation or error', async () => {
  const providers = [
    { name: 'invalid', call: async () => ({ head: 'ok', bogus: 'nope' }) },
    { name: 'throws', call: async () => { throw new Error('down'); } },
    { name: 'good', call: async () => ({ head: 'The only usable headline here' }) },
  ];
  const plan = await composeContent('Some brief', { moduleId: 'reveal' }, { providers });
  assert.deepStrictEqual(plan, { head: 'The only usable headline here' });
});

test('composeContent returns null when every provider fails, errors, or is invalid', async () => {
  const providers = [
    { name: 'invalid', call: async () => ({ bogus: 'nope' }) },
    { name: 'throws', call: async () => { throw new Error('down'); } },
    { name: 'empty', call: async () => null },
  ];
  const plan = await composeContent('Some brief', { moduleId: 'reveal' }, { providers });
  assert.strictEqual(plan, null);
});

test('a provider may return a JSON string instead of a parsed object (e.g. Gemini/Groq/Ollama text bodies)', async () => {
  const providers = [{ name: 'stringy', call: async () => JSON.stringify({ head: 'From a stringified provider body' }) }];
  const plan = await composeContent('Some brief', { moduleId: 'reveal' }, { providers });
  assert.deepStrictEqual(plan, { head: 'From a stringified provider body' });
});

// ---- end-to-end: a validated plan flows through generate() unchanged ------

test('a content plan merged into copy shows up verbatim in the generated AMP and still validates', async () => {
  const copy = { head: 'Custom Headline Co', question: 'Pick your favourite?', footerText: 'Made just for you' };
  const g = generate({ brand: 'Acme', vertical: 'Generic', tone: 'Playful', currency: 'INR', moduleId: 'quiz', copy });
  assert.ok(g.ampHtml.includes('Custom Headline Co'), 'overridden head should appear in the AMP output');
  assert.ok(g.ampHtml.includes('Pick your favourite?'), 'overridden question should appear in the AMP output');
  assert.ok(g.ampHtml.includes('Made just for you'), 'overridden footer text should appear in the AMP output');
  const v = await validate(g.ampHtml);
  assert.ok(v.pass, `content-plan-driven build should still validate: ${JSON.stringify(v.errors)}`);
});

test('no brief / no copy: generate() output is unchanged from the pre-feature baseline shape', () => {
  const a = generate({ brand: 'Zomato', vertical: 'Food', tone: 'Playful', currency: 'INR', moduleId: 'reveal', counter: 0 });
  const b = generate({ brand: 'Zomato', vertical: 'Food', tone: 'Playful', currency: 'INR', moduleId: 'reveal', counter: 0, copy: {} });
  assert.strictEqual(a.ampHtml, b.ampHtml, 'passing an empty copy object must be a no-op');
});

test('header now carries a brand logo image and a link to the guessed brand site', () => {
  const g = generate({ brand: 'Acme', vertical: 'Generic', tone: 'Playful', currency: 'INR', moduleId: 'spin' });
  assert.match(g.ampHtml, /<a class="brand-link" href="https:\/\/www\.acme\.com"[^>]*>/);
  assert.match(g.ampHtml, /<amp-img class="logo"[^>]*>/);
});
