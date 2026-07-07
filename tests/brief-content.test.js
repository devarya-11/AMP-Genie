'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { composeContent, validatePlan, FIELD_SCHEMAS } = require('../server/brief-content');
const { generate } = require('../server/generate');
const { validate } = require('../server/validator');

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

// ---- composeContent: dependency-injected fake client, no real API calls ---

test('composeContent returns null when no brief is given', async () => {
  const client = { messages: { parse: async () => { throw new Error('should not be called'); } } };
  const plan = await composeContent(null, { moduleId: 'quiz' }, { client });
  assert.strictEqual(plan, null);
  const plan2 = await composeContent('', { moduleId: 'quiz' }, { client });
  assert.strictEqual(plan2, null);
});

test('composeContent returns null for an unsupported/unknown moduleId', async () => {
  const client = { messages: { parse: async () => { throw new Error('should not be called'); } } };
  const plan = await composeContent('Summer sale, 20% off everything', { moduleId: 'not-a-module' }, { client });
  assert.strictEqual(plan, null);
});

test('composeContent returns the validated plan on a well-formed mock response', async () => {
  const client = {
    messages: {
      parse: async () => ({ parsed_output: { head: 'Big Summer Drop', question: 'Which look wins?', footerText: 'Handpicked for you' } }),
    },
  };
  const plan = await composeContent('A summer fashion drop, playful tone', { moduleId: 'quiz', vertical: 'Fashion', brandName: 'Acme' }, { client });
  assert.deepStrictEqual(plan, { head: 'Big Summer Drop', question: 'Which look wins?', footerText: 'Handpicked for you' });
});

test('composeContent falls back to null when the mock response is schema-invalid', async () => {
  const client = {
    messages: {
      parse: async () => ({ parsed_output: { head: 'ok', notAllowedField: 'nope' } }),
    },
  };
  const plan = await composeContent('Some brief', { moduleId: 'reveal' }, { client });
  assert.strictEqual(plan, null);
});

test('composeContent falls back to null when parsed_output is missing entirely', async () => {
  const client = { messages: { parse: async () => ({ parsed_output: null }) } };
  const plan = await composeContent('Some brief', { moduleId: 'reveal' }, { client });
  assert.strictEqual(plan, null);
});

test('composeContent never throws — a client error resolves to null', async () => {
  const client = { messages: { parse: async () => { throw new Error('network exploded'); } } };
  await assert.doesNotReject(async () => {
    const plan = await composeContent('Some brief', { moduleId: 'reveal' }, { client });
    assert.strictEqual(plan, null);
  });
});

test('composeContent resolves to null (not hang) once its timeout budget elapses', async () => {
  const client = { messages: { parse: () => new Promise(() => {}) } }; // never resolves
  const start = Date.now();
  const plan = await composeContent('Some brief', { moduleId: 'reveal' }, { client, timeoutMs: 50 });
  assert.strictEqual(plan, null);
  assert.ok(Date.now() - start < 2000, 'must resolve promptly via the timeout race, not hang');
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
