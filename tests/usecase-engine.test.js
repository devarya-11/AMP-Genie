'use strict';
const { test } = require('node:test');
const assert = require('node:assert');

// Deterministic defaults: make sure no ambient env var accidentally enables
// a real provider during this suite — every test that wants a provider
// active injects it explicitly via opts.providers, so results never depend
// on the machine running the tests.
delete process.env.GEMINI_API_KEY;
delete process.env.GROQ_API_KEY;
delete process.env.OLLAMA_BASE_URL;
delete process.env.ANTHROPIC_API_KEY;

const {
  proposeUseCases, shapeUserIdea, validateUseCase, USECASE_LIBRARY,
} = require('../server/usecase-engine');
const { validatePlan } = require('../server/brief-content');
const { MODULE_IDS } = require('../server/generate');
const { VERTICALS } = require('../server/content');

function hang() { return new Promise(() => {}); }

// ---- USECASE_LIBRARY: the zero-key tier must be complete and valid ---------

test('USECASE_LIBRARY covers every vertical with at least 6 entries', () => {
  for (const vertical of VERTICALS) {
    assert.ok(Array.isArray(USECASE_LIBRARY[vertical]), `${vertical} should have a library`);
    assert.ok(USECASE_LIBRARY[vertical].length >= 6, `${vertical} should have >= 6 use-cases, has ${USECASE_LIBRARY[vertical].length}`);
  }
});

test('every vertical covers all six modules, and every moduleId is real', () => {
  for (const vertical of VERTICALS) {
    const seen = new Set();
    for (const entry of USECASE_LIBRARY[vertical]) {
      assert.ok(MODULE_IDS.includes(entry.moduleId), `${vertical} "${entry.title}" has unknown moduleId ${entry.moduleId}`);
      seen.add(entry.moduleId);
    }
    for (const id of MODULE_IDS) {
      assert.ok(seen.has(id), `${vertical} is missing a ${id} use-case`);
    }
  }
});

test('every library entry is a complete use-case within caps and free of markup', () => {
  const caps = { title: 80, businessGoal: 160, trigger: 80, kpi: 80 };
  for (const vertical of VERTICALS) {
    for (const entry of USECASE_LIBRARY[vertical]) {
      for (const [key, cap] of Object.entries(caps)) {
        assert.strictEqual(typeof entry[key], 'string', `${vertical} "${entry.title}" ${key} should be a string`);
        assert.ok(entry[key].trim().length >= 1 && entry[key].length <= cap, `${vertical} "${entry.title}" ${key} breaks its ${cap}-char cap`);
      }
      assert.strictEqual(typeof entry.contentPlan, 'object');
      // The one absolute rule, checked over the whole serialized entry.
      assert.ok(!/[<>]/.test(JSON.stringify(entry)), `${vertical} "${entry.title}" contains markup characters`);
    }
  }
});

// THE critical assertion: library contentPlans feed straight into generate()
// via the same copy pipeline as LLM plans, so each one must survive the REAL
// validatePlan for its module — byte-identical (already trimmed, in caps).
test('every non-empty library contentPlan passes the real validatePlan for its module', () => {
  let checked = 0;
  for (const vertical of VERTICALS) {
    for (const entry of USECASE_LIBRARY[vertical]) {
      if (!Object.keys(entry.contentPlan).length) continue;
      const plan = validatePlan(entry.moduleId, entry.contentPlan);
      assert.ok(plan !== null, `${vertical} "${entry.title}" contentPlan fails validatePlan(${entry.moduleId})`);
      assert.deepStrictEqual(plan, entry.contentPlan, `${vertical} "${entry.title}" contentPlan should be returned unchanged (pre-trimmed, in caps)`);
      checked += 1;
    }
  }
  assert.ok(checked >= 7 * 6, `expected every entry to carry a plan, checked only ${checked}`);
});

test('every raw library entry passes validateUseCase as-is ({b} tokens included)', () => {
  for (const vertical of VERTICALS) {
    for (const entry of USECASE_LIBRARY[vertical]) {
      const uc = validateUseCase(entry);
      assert.ok(uc, `${vertical} "${entry.title}" should pass validateUseCase`);
      assert.strictEqual(uc.title, entry.title);
      assert.deepStrictEqual(uc.contentPlan, entry.contentPlan);
    }
  }
});

// ---- validateUseCase: allowlist re-validation -------------------------------

test('validateUseCase accepts a well-formed use-case and strips unknown fields', () => {
  const uc = validateUseCase({
    title: 'Fund-match quiz', businessGoal: 'First SIP', trigger: 'onboarding day 3', moduleId: 'quiz', kpi: 'quiz completion', contentPlan: { head: 'Find your fund' }, id: 'should-be-stripped', score: 9,
  });
  assert.deepStrictEqual(uc, {
    title: 'Fund-match quiz', moduleId: 'quiz', businessGoal: 'First SIP', trigger: 'onboarding day 3', kpi: 'quiz completion', contentPlan: { head: 'Find your fund' },
  });
});

test('validateUseCase returns null for non-objects, missing title, or a bad moduleId', () => {
  assert.strictEqual(validateUseCase(null), null);
  assert.strictEqual(validateUseCase('a string'), null);
  assert.strictEqual(validateUseCase(['array']), null);
  assert.strictEqual(validateUseCase({ moduleId: 'quiz' }), null); // no title
  assert.strictEqual(validateUseCase({ title: '   ', moduleId: 'quiz' }), null);
  assert.strictEqual(validateUseCase({ title: 'ok', moduleId: 'carousel' }), null);
  assert.strictEqual(validateUseCase({ title: 'ok' }), null); // no moduleId
});

test('validateUseCase rejects markup characters in any descriptor field', () => {
  assert.strictEqual(validateUseCase({ title: 'Nice <b>idea</b>', moduleId: 'reveal' }), null);
  assert.strictEqual(validateUseCase({ title: 'ok', moduleId: 'reveal', businessGoal: 'goal > revenue' }), null);
  assert.strictEqual(validateUseCase({ title: 'ok', moduleId: 'reveal', kpi: 'ctr <5%' }), null);
  assert.strictEqual(validateUseCase({ title: 'ok', moduleId: 'reveal', trigger: '<script>' }), null);
});

test('validateUseCase rejects over-long and non-string descriptor values', () => {
  assert.strictEqual(validateUseCase({ title: 'x'.repeat(81), moduleId: 'poll' }), null);
  assert.strictEqual(validateUseCase({ title: 'ok', moduleId: 'poll', businessGoal: 'x'.repeat(161) }), null);
  assert.strictEqual(validateUseCase({ title: 'ok', moduleId: 'poll', trigger: 'x'.repeat(81) }), null);
  assert.strictEqual(validateUseCase({ title: 'ok', moduleId: 'poll', kpi: 'x'.repeat(81) }), null);
  assert.strictEqual(validateUseCase({ title: 'ok', moduleId: 'poll', kpi: 42 }), null);
});

test('validateUseCase degrades an invalid contentPlan to {} instead of rejecting the idea', () => {
  const bogusField = validateUseCase({ title: 'ok', moduleId: 'rating', contentPlan: { notAField: 'x' } });
  assert.deepStrictEqual(bogusField.contentPlan, {});
  const markupInPlan = validateUseCase({ title: 'ok', moduleId: 'rating', contentPlan: { prompt: 'Rate <b>now</b>' } });
  assert.deepStrictEqual(markupInPlan.contentPlan, {});
  const notAnObject = validateUseCase({ title: 'ok', moduleId: 'rating', contentPlan: 'head: x' });
  assert.deepStrictEqual(notAnObject.contentPlan, {});
});

test('validateUseCase passes a valid contentPlan through sanitized (quiz options shape intact)', () => {
  const uc = validateUseCase({
    title: 'ok',
    moduleId: 'quiz',
    contentPlan: {
      question: 'Pick one?',
      options: [{ label: 'A', result: 'ra' }, { label: 'B' }, { label: 'C', result: 'rc' }],
    },
  });
  assert.deepStrictEqual(uc.contentPlan, {
    question: 'Pick one?',
    options: [{ label: 'A', result: 'ra' }, { label: 'B' }, { label: 'C', result: 'rc' }],
  });
});

test('validateUseCase tolerates absent optional descriptors (title + moduleId is enough)', () => {
  const uc = validateUseCase({ title: 'Bare idea', moduleId: 'spin' });
  assert.deepStrictEqual(uc, { title: 'Bare idea', moduleId: 'spin', contentPlan: {} });
});

// ---- proposeUseCases: zero-key deterministic tier ---------------------------

test('zero-key propose (no opts at all): library tier, count 6 default, fully branded', async () => {
  const res = await proposeUseCases({ dossier: { name: 'Nykaa', vertical: 'Beauty' } });
  assert.strictEqual(res.source, 'library');
  assert.strictEqual(res.useCases.length, 6);
  const serialized = JSON.stringify(res.useCases);
  assert.ok(!serialized.includes('{b}'), 'no literal {b} token may survive interpolation');
  assert.ok(serialized.includes('Nykaa'), 'brand name should appear in the branded use-cases');
  const ids = new Set(res.useCases.map((u) => u.id));
  assert.strictEqual(ids.size, 6, 'every use-case id must be unique');
  for (const uc of res.useCases) {
    assert.ok(MODULE_IDS.includes(uc.moduleId));
    assert.ok(uc.title && uc.businessGoal && uc.trigger && uc.kpi);
  }
});

test('zero-key propose: interpolated contentPlans still pass the real validatePlan', async () => {
  const res = await proposeUseCases({ dossier: { name: 'Mamaearth', vertical: 'Beauty' }, count: 6 }, { providers: [] });
  for (const uc of res.useCases) {
    if (!Object.keys(uc.contentPlan).length) continue;
    assert.ok(validatePlan(uc.moduleId, uc.contentPlan), `branded plan for "${uc.title}" should still validate`);
  }
});

test('zero-key propose: count is respected and clamped to 1..8', async () => {
  const three = await proposeUseCases({ dossier: { name: 'Ajio', vertical: 'Fashion' }, count: 3 }, { providers: [] });
  assert.strictEqual(three.useCases.length, 3);
  const low = await proposeUseCases({ dossier: { name: 'Ajio', vertical: 'Fashion' }, count: 0 }, { providers: [] });
  assert.strictEqual(low.useCases.length, 1);
  // Fashion tops up from the Generic library past its own six entries.
  const high = await proposeUseCases({ dossier: { name: 'Ajio', vertical: 'Fashion' }, count: 99 }, { providers: [] });
  assert.strictEqual(high.useCases.length, 8);
  assert.strictEqual(new Set(high.useCases.map((u) => u.title)).size, 8, 'top-ups must not duplicate titles');
});

test('zero-key propose: the brief routes its module to the front of the slate', async () => {
  const res = await proposeUseCases({
    dossier: { name: 'Myntra', vertical: 'Fashion' },
    brief: 'spin the wheel for a festive jackpot reward',
    count: 4,
  }, { providers: [] });
  assert.strictEqual(res.useCases[0].moduleId, 'spin');
  assert.strictEqual(res.source, 'library');
});

test('zero-key propose: feedback and prior are accepted and deterministically ignored', async () => {
  const plain = await proposeUseCases({ dossier: { name: 'Groww', vertical: 'Finance' }, count: 5 }, { providers: [] });
  const steered = await proposeUseCases({
    dossier: { name: 'Groww', vertical: 'Finance' },
    count: 5,
    feedback: 'make everything festive',
    prior: [{ title: 'Old idea one' }, 'Old idea two'],
  }, { providers: [] });
  assert.deepStrictEqual(
    steered.useCases.map((u) => u.title),
    plain.useCases.map((u) => u.title),
    'without an LLM there is no dial for feedback to turn',
  );
});

test('zero-key propose: unknown vertical and missing dossier fall back to Generic + Acme', async () => {
  const res = await proposeUseCases({ dossier: { vertical: 'Petcare' }, count: 2 }, { providers: [] });
  assert.strictEqual(res.useCases.length, 2);
  assert.ok(JSON.stringify(res.useCases).includes('Acme'));
  const bare = await proposeUseCases();
  assert.strictEqual(bare.useCases.length, 6);
  assert.strictEqual(bare.source, 'library');
});

// ---- proposeUseCases: LLM tier with injected fake providers ----------------

const GOOD_LLM_ITEM = {
  title: 'Fund-match quiz for first-time investors',
  businessGoal: 'Convert new signups to a first SIP',
  trigger: 'onboarding day 3',
  moduleId: 'quiz',
  kpi: 'quiz completion to fund page CTR',
  contentPlan: { head: 'Find your starter fund' },
};

test('LLM tier: valid items pass through first, library tops up to count, source is llm', async () => {
  const providers = [async () => ({ useCases: [GOOD_LLM_ITEM] })];
  const res = await proposeUseCases({ dossier: { name: 'Groww', vertical: 'Finance' }, count: 3 }, { providers });
  assert.strictEqual(res.source, 'llm');
  assert.strictEqual(res.useCases.length, 3);
  assert.strictEqual(res.useCases[0].title, GOOD_LLM_ITEM.title);
  assert.deepStrictEqual(res.useCases[0].contentPlan, { head: 'Find your starter fund' });
  // the two top-ups come from the Finance library, branded
  assert.ok(JSON.stringify(res.useCases.slice(1)).includes('Groww'));
  assert.strictEqual(new Set(res.useCases.map((u) => u.id)).size, 3);
});

test('LLM tier: {b} tokens in LLM output are interpolated too', async () => {
  const providers = [async () => ({ useCases: [{ ...GOOD_LLM_ITEM, title: 'Deal reveal for {b} regulars', moduleId: 'reveal', contentPlan: { head: 'A treat from {b}' } }] })];
  const res = await proposeUseCases({ dossier: { name: 'Zepto', vertical: 'Food' }, count: 1 }, { providers });
  assert.strictEqual(res.useCases[0].title, 'Deal reveal for Zepto regulars');
  assert.deepStrictEqual(res.useCases[0].contentPlan, { head: 'A treat from Zepto' });
});

test('LLM tier: invalid moduleId and markup-containing items are dropped and topped up', async () => {
  const providers = [async () => ({
    useCases: [
      { ...GOOD_LLM_ITEM, title: 'The one good idea' },
      { ...GOOD_LLM_ITEM, title: 'Bad module idea', moduleId: 'carousel' },
      { ...GOOD_LLM_ITEM, title: 'Markup <script> idea' },
    ],
  })];
  const res = await proposeUseCases({ dossier: { name: 'Groww', vertical: 'Finance' }, count: 3 }, { providers });
  assert.strictEqual(res.source, 'llm');
  assert.strictEqual(res.useCases.length, 3);
  const titles = res.useCases.map((u) => u.title);
  assert.ok(titles.includes('The one good idea'));
  assert.ok(!titles.includes('Bad module idea'));
  assert.ok(!titles.some((t) => t.includes('Markup')));
});

test('LLM tier: a throwing provider degrades to a pure library result', async () => {
  const providers = [async () => { throw new Error('network exploded'); }];
  await assert.doesNotReject(async () => {
    const res = await proposeUseCases({ dossier: { name: 'Croma', vertical: 'Electronics' }, count: 4 }, { providers });
    assert.strictEqual(res.source, 'library');
    assert.strictEqual(res.useCases.length, 4);
  });
});

test('LLM tier: a sync-throwing provider is also folded into the library fallback', async () => {
  const providers = [() => { throw new Error('sync explosion'); }];
  const res = await proposeUseCases({ dossier: { name: 'Croma', vertical: 'Electronics' }, count: 2 }, { providers });
  assert.strictEqual(res.source, 'library');
  assert.strictEqual(res.useCases.length, 2);
});

test('LLM tier: a hanging provider resolves via the timeout budget to library', async () => {
  const providers = [hang];
  const start = Date.now();
  const res = await proposeUseCases({ dossier: { name: 'MakeMyTrip', vertical: 'Travel' }, count: 3 }, { providers, timeoutMs: 50 });
  assert.ok(Date.now() - start < 2000, 'must resolve promptly via the timeout race, not hang');
  assert.strictEqual(res.source, 'library');
  assert.strictEqual(res.useCases.length, 3);
});

test('LLM tier: a JSON-string body carrying a bare array is accepted', async () => {
  const providers = [async () => JSON.stringify([GOOD_LLM_ITEM])];
  const res = await proposeUseCases({ dossier: { name: 'Groww', vertical: 'Finance' }, count: 1 }, { providers });
  assert.strictEqual(res.source, 'llm');
  assert.strictEqual(res.useCases[0].title, GOOD_LLM_ITEM.title);
});

test('LLM tier: modules may repeat across use-cases (two reveal businesses both kept)', async () => {
  const providers = [async () => ({
    useCases: [
      { ...GOOD_LLM_ITEM, title: 'Win-back reveal for lapsed buyers', moduleId: 'reveal' },
      { ...GOOD_LLM_ITEM, title: 'Birthday reveal with a private code', moduleId: 'reveal' },
    ],
  })];
  const res = await proposeUseCases({ dossier: { name: 'Nykaa', vertical: 'Beauty' }, count: 2 }, { providers });
  assert.deepStrictEqual(res.useCases.map((u) => u.moduleId), ['reveal', 'reveal']);
});

test('LLM tier: library top-up skips titles the LLM already produced', async () => {
  // Exactly the branded title of Finance's lead library entry.
  const providers = [async () => ({
    useCases: [{ ...GOOD_LLM_ITEM, title: 'Fee-waiver reveal for dormant Groww accounts', moduleId: 'reveal' }],
  })];
  const res = await proposeUseCases({ dossier: { name: 'Groww', vertical: 'Finance' }, count: 6 }, { providers });
  assert.strictEqual(res.useCases.length, 6);
  const titles = res.useCases.map((u) => u.title.toLowerCase());
  assert.strictEqual(new Set(titles).size, 6, 'no title may appear twice');
});

test('LLM tier: the prompt carries dossier, brief, module vocabulary, feedback and prior titles', async () => {
  let seenPrompt = null;
  let seenSchema = null;
  const providers = [async (prompt, schema) => {
    seenPrompt = prompt;
    seenSchema = schema;
    return { useCases: [GOOD_LLM_ITEM] };
  }];
  await proposeUseCases({
    dossier: {
      name: 'Groww',
      vertical: 'Finance',
      summary: 'Retail investing app for first-time investors',
      products: ['Stocks', 'Mutual funds'],
      voice: 'simple, friendly',
      campaigns: [{ title: 'IPO week' }],
    },
    brief: 'a quiz for onboarding',
    count: 4,
    feedback: 'make them festive',
    prior: [{ title: 'Old idea one' }, 'Old idea two'],
  }, { providers });
  assert.ok(seenPrompt.includes('Retail investing app'), 'dossier summary should reach the prompt');
  assert.ok(seenPrompt.includes('Mutual funds'), 'dossier products should reach the prompt');
  assert.ok(seenPrompt.includes('IPO week'), 'dossier campaigns should reach the prompt');
  assert.ok(seenPrompt.includes('a quiz for onboarding'), 'the brief should reach the prompt');
  assert.ok(seenPrompt.includes('Spin to Win'), 'module vocabulary (names) should reach the prompt');
  for (const id of MODULE_IDS) assert.ok(seenPrompt.includes(`- ${id} (`), `module ${id} should be described`);
  assert.ok(seenPrompt.includes('make them festive'), 'feedback should reach the prompt');
  assert.ok(seenPrompt.includes('Old idea one') && seenPrompt.includes('Old idea two'), 'prior titles should reach the prompt');
  assert.ok(/REPLACE or IMPROVE/.test(seenPrompt), 'the prompt must instruct replacement, not repetition');
  assert.ok(seenSchema && seenSchema.properties && seenSchema.properties.useCases, 'the JSON schema must wrap the array in an object envelope');
});

test('LLM tier: brief-content-style { name, call } provider descriptors also work', async () => {
  const providers = [{ name: 'fake', call: async () => ({ useCases: [GOOD_LLM_ITEM] }) }];
  const res = await proposeUseCases({ dossier: { name: 'Groww', vertical: 'Finance' }, count: 1 }, { providers });
  assert.strictEqual(res.source, 'llm');
});

// ---- shapeUserIdea ----------------------------------------------------------

test('shapeUserIdea zero-key: routes the idea to its module and fills deterministic fields', async () => {
  const uc = await shapeUserIdea({ idea: 'a quiz that matches patients to a health plan', dossier: { name: 'Practo' } }, { providers: [] });
  assert.ok(uc.id);
  assert.strictEqual(uc.moduleId, 'quiz');
  assert.strictEqual(uc.title, 'a quiz that matches patients to a health plan');
  assert.strictEqual(uc.businessGoal, 'Team-supplied use-case');
  assert.strictEqual(uc.trigger, 'custom');
  assert.strictEqual(uc.kpi, 'engagement');
  assert.deepStrictEqual(uc.contentPlan, {});
});

test('shapeUserIdea zero-key: the Practo-style lab-report idea now routes to the report module', async () => {
  const uc = await shapeUserIdea({ idea: 'lab report opener like Practo' }, { providers: [] });
  assert.strictEqual(uc.moduleId, 'report');
  assert.strictEqual(uc.title, 'lab report opener like Practo');
});

test('shapeUserIdea zero-key: a genuinely unrouteable idea falls back to reveal', async () => {
  const uc = await shapeUserIdea({ idea: 'a fun little inbox moment for loyal fans' }, { providers: [] });
  assert.strictEqual(uc.moduleId, 'reveal');
  assert.strictEqual(uc.title, 'a fun little inbox moment for loyal fans');
});

test('shapeUserIdea zero-key: over-long ideas are capped at the 80-char title budget', async () => {
  const idea = 'x'.repeat(200);
  const uc = await shapeUserIdea({ idea }, { providers: [] });
  assert.strictEqual(uc.title.length, 80);
});

test('shapeUserIdea returns null only for an empty or whitespace idea', async () => {
  assert.strictEqual(await shapeUserIdea({ idea: '' }, { providers: [] }), null);
  assert.strictEqual(await shapeUserIdea({ idea: '   ' }, { providers: [] }), null);
  assert.strictEqual(await shapeUserIdea({}, { providers: [] }), null);
  assert.strictEqual(await shapeUserIdea(undefined, { providers: [] }), null);
});

test('shapeUserIdea LLM tier: a valid shaped use-case passes through with an id', async () => {
  const providers = [async () => ({
    title: 'Lab-report opener with tap-to-reveal results summary',
    businessGoal: 'Lift report-open rates and drive follow-up bookings',
    trigger: 'lab report ready',
    moduleId: 'reveal',
    kpi: 'reveal rate to booking CTR',
    contentPlan: { head: 'Your {b} report is ready' },
  })];
  const uc = await shapeUserIdea({ idea: 'lab report opener like Practo', dossier: { name: 'Practo' } }, { providers });
  assert.ok(uc.id);
  assert.strictEqual(uc.title, 'Lab-report opener with tap-to-reveal results summary');
  assert.strictEqual(uc.moduleId, 'reveal');
  assert.deepStrictEqual(uc.contentPlan, { head: 'Your Practo report is ready' });
});

test('shapeUserIdea LLM tier: an invalid LLM shape degrades to the deterministic shape', async () => {
  const providers = [async () => ({ title: 'Bad <b>markup</b> title', moduleId: 'quiz' })];
  const uc = await shapeUserIdea({ idea: 'poll our users on the new feature' }, { providers });
  assert.strictEqual(uc.moduleId, 'poll'); // deterministic route, not the LLM's quiz
  assert.strictEqual(uc.businessGoal, 'Team-supplied use-case');
});

test('shapeUserIdea LLM tier: a throwing or hanging provider degrades without throwing', async () => {
  await assert.doesNotReject(async () => {
    const thrown = await shapeUserIdea({ idea: 'rate our support' }, { providers: [async () => { throw new Error('down'); }] });
    assert.strictEqual(thrown.moduleId, 'rating');
    const start = Date.now();
    const hung = await shapeUserIdea({ idea: 'rate our support' }, { providers: [hang], timeoutMs: 50 });
    assert.ok(Date.now() - start < 2000);
    assert.strictEqual(hung.moduleId, 'rating');
  });
});
