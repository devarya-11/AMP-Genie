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
  composeContent, validatePlan, scorePlan, FIELD_SCHEMAS, fieldsFor,
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

// ---- validatePlan: the richer array-shaped fields (itemNames, quiz options) --

test('validatePlan accepts a well-formed itemNames array', () => {
  const plan = validatePlan('reveal', { itemNames: ['Butter Chicken', 'Paneer Tikka'] });
  assert.deepStrictEqual(plan, { itemNames: ['Butter Chicken', 'Paneer Tikka'] });
});

test('validatePlan rejects itemNames that is empty, too long, or not an array of strings', () => {
  assert.strictEqual(validatePlan('reveal', { itemNames: [] }), null);
  assert.strictEqual(validatePlan('reveal', { itemNames: ['a', 'b', 'c'] }), null); // reveal caps at 2
  assert.strictEqual(validatePlan('reveal', { itemNames: [42] }), null);
  assert.strictEqual(validatePlan('reveal', { itemNames: 'not an array' }), null);
  assert.strictEqual(validatePlan('reveal', { itemNames: ['x'.repeat(60)] }), null); // over the 40-char item cap
});

test('validatePlan accepts a well-formed 3-option quiz plan and applies the label-only default (no result)', () => {
  const plan = validatePlan('quiz', {
    options: [{ label: 'Spicy' }, { label: 'Mild', result: 'A gentle pick, just right.' }, { label: 'Sweet' }],
  });
  assert.deepStrictEqual(plan, {
    options: [{ label: 'Spicy' }, { label: 'Mild', result: 'A gentle pick, just right.' }, { label: 'Sweet' }],
  });
});

test('validatePlan rejects quiz options with the wrong count, missing label, or unknown keys', () => {
  assert.strictEqual(validatePlan('quiz', { options: [{ label: 'A' }, { label: 'B' }] }), null); // needs exactly 3
  assert.strictEqual(validatePlan('quiz', { options: [{ result: 'no label' }, { label: 'B' }, { label: 'C' }] }), null);
  assert.strictEqual(validatePlan('quiz', { options: [{ label: 'A', bogus: 'x' }, { label: 'B' }, { label: 'C' }] }), null);
});

test('every FIELD_SCHEMAS moduleId is a real generate.js module', () => {
  const { MODULE_IDS } = require('../server/generate');
  for (const id of Object.keys(FIELD_SCHEMAS)) {
    assert.ok(MODULE_IDS.includes(id), `${id} should be a real module id`);
  }
});

// ---- validatePlan: per-field widened caps for prose vs tight UI fields -----

test('validatePlan allows a longer prose field (teaserText) up to its own widened cap, past the old 140 default', () => {
  const ok = validatePlan('reveal', { teaserText: 'x'.repeat(200) });
  assert.deepStrictEqual(ok, { teaserText: 'x'.repeat(200) });
  assert.strictEqual(validatePlan('reveal', { teaserText: 'x'.repeat(221) }), null); // over reveal's 220 cap
});

test('validatePlan keeps tight single-line fields (ctaLabel, poll vote labels) capped short even though prose fields were widened', () => {
  assert.strictEqual(validatePlan('reveal', { ctaLabel: 'x'.repeat(41) }), null); // over the 40-char button cap
  assert.deepStrictEqual(validatePlan('reveal', { ctaLabel: 'x'.repeat(40) }), { ctaLabel: 'x'.repeat(40) });
  assert.strictEqual(validatePlan('poll', { optionA: 'x'.repeat(51) }), null); // over the 50-char vote-label cap
});

test('validatePlan applies independent label/result caps to quiz options (short tap target, longer result sentence)', () => {
  const tooLongLabel = validatePlan('quiz', {
    options: [{ label: 'x'.repeat(61) }, { label: 'B' }, { label: 'C' }],
  });
  assert.strictEqual(tooLongLabel, null); // over the 60-char label cap

  const longResultOk = validatePlan('quiz', {
    options: [{ label: 'A', result: 'x'.repeat(180) }, { label: 'B' }, { label: 'C' }],
  });
  assert.ok(longResultOk, 'a 180-char result should fit the widened quiz result cap');

  const tooLongResult = validatePlan('quiz', {
    options: [{ label: 'A', result: 'x'.repeat(181) }, { label: 'B' }, { label: 'C' }],
  });
  assert.strictEqual(tooLongResult, null); // over the 180-char result cap
});

// ---- scorePlan: heuristic best-of-N quality proxy --------------------------

test('scorePlan returns -Infinity for null or an empty plan', () => {
  assert.strictEqual(scorePlan(null, fieldsFor('quiz')), -Infinity);
  assert.strictEqual(scorePlan({}, fieldsFor('quiz')), -Infinity);
});

test('scorePlan rewards fuller field coverage over partial coverage', () => {
  const full = scorePlan({ head: 'A tidy little headline', question: 'Which one wins today?', footerText: 'Picked for you' }, fieldsFor('quiz'));
  const partial = scorePlan({ head: 'A tidy little headline' }, fieldsFor('quiz'));
  assert.ok(full > partial, `expected fuller coverage to score higher: ${full} vs ${partial}`);
});

test('scorePlan penalises spammy filler and shouting over clean copy', () => {
  const clean = scorePlan({ head: 'Discover our summer picks' }, fieldsFor('reveal'));
  const spammy = scorePlan({ head: 'ACT NOW!!! AMAZING OFFER!!!' }, fieldsFor('reveal'));
  assert.ok(clean > spammy, `expected clean copy to outscore spammy copy: ${clean} vs ${spammy}`);
});

test('scorePlan tolerates array-shaped fields (itemNames, quiz options) without crashing', () => {
  const withItems = scorePlan({ head: 'A tidy little headline', itemNames: ['Butter Chicken', 'Paneer Tikka'] }, fieldsFor('reveal'));
  assert.ok(Number.isFinite(withItems));
  const withOptions = scorePlan({ options: [{ label: 'A', result: 'ra' }, { label: 'B', result: 'rb' }, { label: 'C', result: 'rc' }] }, fieldsFor('quiz'));
  assert.ok(Number.isFinite(withOptions));
});

// ---- scorePlan: tone-aware leniency ---------------------------------------
// "!!!"/energetic filler is the brand voice a Playful/Urgent brief actually
// wants, not a spam signal — so the same copy should be penalised less under
// those tones than under a calm Premium/Informative one (or no tone at all).

test('scorePlan is more lenient on exclamation marks and filler for energetic tones (Playful/Urgent) than calm ones', () => {
  const energetic = { head: 'Shop now!!! Limited time only!!!' };
  const noTone = scorePlan(energetic, fieldsFor('reveal'));
  const playful = scorePlan(energetic, fieldsFor('reveal'), 'Playful');
  const urgent = scorePlan(energetic, fieldsFor('reveal'), 'Urgent');
  const premium = scorePlan(energetic, fieldsFor('reveal'), 'Premium');
  const informative = scorePlan(energetic, fieldsFor('reveal'), 'Informative');

  assert.ok(playful > noTone, `Playful should score the same copy higher than no tone: ${playful} vs ${noTone}`);
  assert.ok(urgent > noTone, `Urgent should score the same copy higher than no tone: ${urgent} vs ${noTone}`);
  // Premium/Informative are the calibrated-strict default (leniency 1), same as no tone at all.
  assert.strictEqual(premium, noTone);
  assert.strictEqual(informative, noTone);
});

test('scorePlan still penalises energetic-tone copy for genuinely spammy patterns, just less severely', () => {
  const clean = scorePlan({ head: 'Discover our summer picks' }, fieldsFor('reveal'), 'Playful');
  const spammy = scorePlan({ head: 'ACT NOW!!! AMAZING OFFER!!!' }, fieldsFor('reveal'), 'Playful');
  assert.ok(clean > spammy, `even under a lenient tone, clean copy should still outscore spammy copy: ${clean} vs ${spammy}`);
});

test('scorePlan treats an unrecognised/omitted tone as the original tone-blind default (full-strength penalties)', () => {
  const spammy = { head: 'ACT NOW!!! AMAZING OFFER!!!' };
  assert.strictEqual(scorePlan(spammy, fieldsFor('reveal'), 'not-a-real-tone'), scorePlan(spammy, fieldsFor('reveal')));
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

test('composeContent threads ctx.tone into the prompt sent to providers', async () => {
  let seenPrompt = null;
  const providers = [{
    name: 'spy',
    call: async (prompt) => { seenPrompt = prompt; return { head: 'A tidy headline here' }; },
  }];
  await composeContent('A summer drop', {
    moduleId: 'reveal', vertical: 'Fashion', brandName: 'Acme', tone: 'Urgent',
  }, { providers });
  assert.ok(seenPrompt && seenPrompt.includes('Urgent'), 'the prompt should mention the requested tone');
});

// composeContent's best-of-N picks whichever candidate scores higher — and
// since scorePlan's leniency is tone-dependent, the SAME two competing
// candidates can end up with a different winner depending on ctx.tone. This
// is deliberately constructed so a fuller-coverage-but-energetic candidate
// (bangs + shouting + "act now") loses to a leaner, fully clean one under a
// calm tone, but overtakes it once the energetic tone's leniency shrinks its
// penalty enough — proving the tone threading actually changes the outcome
// end to end, not just in scorePlan isolation.
test('composeContent lets ctx.tone flip which of two competing candidates wins', async () => {
  const providers = [
    {
      name: 'clean-but-leaner',
      call: async () => ({ head: 'Discover our summer picks', ctaLabel: 'Shop' }),
    },
    {
      name: 'energetic-fuller-coverage',
      call: async () => ({
        head: 'ACT NOW!!! AMAZING deal',
        teaserText: 'Your reward is ready and waiting',
        footerText: 'Enjoy!',
      }),
    },
  ];
  const premiumPlan = await composeContent('Flash sale', { moduleId: 'reveal', tone: 'Premium' }, { providers });
  assert.deepStrictEqual(premiumPlan, { head: 'Discover our summer picks', ctaLabel: 'Shop' });

  const urgentPlan = await composeContent('Flash sale', { moduleId: 'reveal', tone: 'Urgent' }, { providers });
  assert.deepStrictEqual(urgentPlan, {
    head: 'ACT NOW!!! AMAZING deal', teaserText: 'Your reward is ready and waiting', footerText: 'Enjoy!',
  });
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

test('copy.itemNames renames the items actually shown in reveal and search, not just headline copy', async () => {
  const revealPlan = { itemNames: ['Butter Chicken', 'Paneer Tikka'] };
  const g1 = generate({
    brand: 'Zomato', vertical: 'Food', tone: 'Playful', currency: 'INR', moduleId: 'reveal', copy: revealPlan,
  });
  assert.ok(g1.ampHtml.includes('Butter Chicken') && g1.ampHtml.includes('Paneer Tikka'));
  const v1 = await validate(g1.ampHtml);
  assert.ok(v1.pass, `reveal with itemNames should still validate: ${JSON.stringify(v1.errors)}`);

  const searchPlan = { itemNames: ['Butter Chicken', 'Paneer Tikka', 'Chicken Biryani', 'Dal Makhani', 'Naan Basket', 'Mango Lassi'] };
  const g2 = generate({
    brand: 'Zomato', vertical: 'Food', tone: 'Playful', currency: 'INR', moduleId: 'search', copy: searchPlan,
  });
  assert.ok(g2.ampHtml.includes('Chicken Biryani'));
  const v2 = await validate(g2.ampHtml);
  assert.ok(v2.pass, `search with itemNames should still validate: ${JSON.stringify(v2.errors)}`);
});

test('copy.options replaces the quiz question/answers actually shown, not just the question text', async () => {
  const plan = {
    question: 'How hungry are we tonight?',
    options: [
      { label: 'Just a snack', result: 'A light bite is calling your name.' },
      { label: 'Feed the table', result: 'Time for the sharing platters.' },
      { label: 'Somewhere in between', result: 'A little of everything, coming right up.' },
    ],
  };
  const g = generate({
    brand: 'Zomato', vertical: 'Food', tone: 'Playful', currency: 'INR', moduleId: 'quiz', copy: plan,
  });
  assert.ok(g.ampHtml.includes('Just a snack'));
  assert.ok(g.ampHtml.includes('Feed the table'));
  assert.ok(g.ampHtml.includes('A light bite is calling your name.'));
  const v = await validate(g.ampHtml);
  assert.ok(v.pass, `quiz with custom options should still validate: ${JSON.stringify(v.errors)}`);
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
