'use strict';
const { test } = require('node:test');
const assert = require('node:assert');

// Deterministic defaults: no ambient provider key may enable a real LLM
// provider during this suite (same rule as tests/brief-content.test.js) —
// every test that wants a provider active injects it explicitly via
// opts.providers, so proposeEditPlan's zero-key tier is what runs by default.
delete process.env.ANTHROPIC_API_KEY;
delete process.env.GEMINI_API_KEY;
delete process.env.GROQ_API_KEY;
delete process.env.OLLAMA_BASE_URL;

// Fully offline: every seeded build below sets colorOverride, which skips the
// colour resolver's live fetch — but the logo resolver still tries the
// network, so every fetch must fail fast instead of waiting out a real
// timeout budget. Both resolvers treat a failed fetch as "fall through".
globalThis.fetch = async () => { throw new Error('offline test: network disabled'); };

const {
  applyTweak, proposeEditPlan, validateEditPlan, deterministicPlan, readVersions,
} = require('../server/tweak-engine');
const { createBuild } = require('../server/build-pipeline');
const { validate } = require('../server/validator');

// In-memory stand-in for the Cloudflare KV binding: same { get(key, type),
// put(key, value) } subset store.js targets, Map-backed so tests can also
// assert which keys were (or were not) written.
function fakeKv() {
  const map = new Map();
  return {
    map,
    async get(key, type) {
      if (!map.has(key)) return null;
      const raw = map.get(key);
      return type === 'json' ? JSON.parse(raw) : raw;
    },
    async put(key, value) { map.set(key, String(value)); },
  };
}

// One persisted, tweakable build — colorOverride keeps the suite offline and
// an explicit moduleId keeps the assertions module-specific.
async function seedBuild(kv, overrides = {}) {
  const { build } = await createBuild(
    { brand: 'Groww', counter: 3, colorOverride: '#00d09c', moduleId: 'reveal', ...overrides },
    { validate, kv },
  );
  return build;
}

// ---- deterministicPlan: the zero-key floor -----------------------------------

test('deterministicPlan extracts a hex colour (normalised to lowercase)', () => {
  assert.deepStrictEqual(deterministicPlan('paint the header #FF0000', 'reveal'), { colorOverride: '#ff0000' });
});

test("deterministicPlan reads 'make it 25% off' as a discount, folded into copy", () => {
  assert.deepStrictEqual(deterministicPlan('make it 25% off', 'reveal'), { copy: { discount: 25 } });
});

test("deterministicPlan routes 'switch to the quiz' to the quiz module", () => {
  assert.deepStrictEqual(deterministicPlan('switch to the quiz', 'reveal'), { moduleId: 'quiz' });
});

test("deterministicPlan reads 'more premium' as the Premium tone", () => {
  assert.deepStrictEqual(deterministicPlan('more premium', 'reveal'), { tone: 'Premium' });
});

test('deterministicPlan yields null for junk prose and for an empty prompt', () => {
  assert.strictEqual(deterministicPlan('hello there my friend', 'reveal'), null);
  assert.strictEqual(deterministicPlan('   ', 'reveal'), null);
});

// ---- validateEditPlan: the allowlist every edit plan must survive ------------

test('validateEditPlan strips unknown fields and drops a bad moduleId', () => {
  assert.deepStrictEqual(
    validateEditPlan('reveal', { colorOverride: '#112233', bogus: 'x', moduleId: 'not-a-module' }),
    { colorOverride: '#112233' },
  );
});

test('validateEditPlan rejects the whole plan on markup anywhere in it', () => {
  assert.strictEqual(validateEditPlan('reveal', { tone: 'Premium', copy: { head: 'now <b>bold</b>' } }), null);
});

test('validateEditPlan validates copy through the real validatePlan, against the module the plan lands on', () => {
  // question is a quiz field, not a reveal field — valid only because the
  // plan switches the module to quiz in the same breath.
  assert.deepStrictEqual(
    validateEditPlan('reveal', { moduleId: 'quiz', copy: { question: 'Pick your vibe?' } }),
    { moduleId: 'quiz', copy: { question: 'Pick your vibe?' } },
  );
  // The same copy without the module change fails validatePlan, degrades to
  // {}, and leaves nothing usable.
  assert.strictEqual(validateEditPlan('reveal', { copy: { question: 'Pick your vibe?' } }), null);
});

test('validateEditPlan folds a 1..99 integer discount into copy.discount and drops the rest', () => {
  assert.deepStrictEqual(validateEditPlan('reveal', { discount: 30 }), { copy: { discount: 30 } });
  assert.strictEqual(validateEditPlan('reveal', { discount: 0 }), null);
  assert.strictEqual(validateEditPlan('reveal', { discount: 150 }), null);
  assert.strictEqual(validateEditPlan('reveal', {}), null);
});

// ---- applyTweak end-to-end, zero keys ----------------------------------------

test('applyTweak rebuilds with the new colour and discount, persists lineage, leaves the parent untouched', async () => {
  const kv = fakeKv();
  const parent = await seedBuild(kv);
  const parentStored = kv.map.get('build:' + parent.id);

  const res = await applyTweak(
    { buildId: parent.id, prompt: 'make it #112233 and 30% off', kv },
    { validate },
  );
  assert.strictEqual(res.ok, true, res.error);
  assert.strictEqual(res.build.validation.pass, true);
  assert.ok(kv.map.has('build:' + res.build.id), 'the tweaked build must persist');
  assert.strictEqual(res.build.parentId, parent.id);
  assert.strictEqual(res.build.rootId, parent.id);
  assert.strictEqual(res.build.tweakPrompt, 'make it #112233 and 30% off');
  assert.strictEqual(res.build.palette.primary, '#112233');
  assert.ok(res.build.ampHtml.includes('30% OFF'), 'reveal renders the tweaked discount');
  assert.strictEqual(res.response.shareId, res.build.id);

  // Version lineage: one entry under the family root (the parent itself).
  const versions = await readVersions(kv, parent.id);
  assert.strictEqual(versions.length, 1);
  assert.deepStrictEqual(versions[0], {
    id: res.build.id, ts: res.build.ts, tweakPrompt: 'make it #112233 and 30% off', moduleId: 'reveal',
  });

  // The parent record is byte-untouched — a tweak is a NEW build, never an edit.
  assert.strictEqual(kv.map.get('build:' + parent.id), parentStored);
});

test('tweaking a tweak keeps the original rootId and grows the version list newest-first', async () => {
  const kv = fakeKv();
  const parent = await seedBuild(kv);
  const first = await applyTweak(
    { buildId: parent.id, prompt: 'make it #112233 and 30% off', kv },
    { validate },
  );
  assert.strictEqual(first.ok, true, first.error);
  const second = await applyTweak(
    { buildId: first.build.id, prompt: 'switch to the spin wheel', kv },
    { validate },
  );
  assert.strictEqual(second.ok, true, second.error);
  assert.strictEqual(second.build.parentId, first.build.id);
  assert.strictEqual(second.build.rootId, parent.id, 'the root is the ORIGINAL build, not the intermediate tweak');
  assert.strictEqual(second.build.moduleId, 'spin');
  // Parameters carry through the chain: the first tweak's colour and
  // discount survive into the second rebuild via params.
  assert.strictEqual(second.build.palette.primary, '#112233');
  assert.ok(second.build.ampHtml.includes('30% off'), 'spin renders the carried-through discount');

  const versions = await readVersions(kv, parent.id);
  assert.strictEqual(versions.length, 2);
  assert.strictEqual(versions[0].id, second.build.id, 'newest first, like the slate index');
  assert.strictEqual(versions[1].id, first.build.id);
});

// ---- applyTweak error paths (all degrade, none throw) -------------------------

test('applyTweak on an unknown build id fails with No such build', async () => {
  const res = await applyTweak(
    { buildId: 'ffffeeeedddd', prompt: 'make it #112233', kv: fakeKv() },
    { validate },
  );
  assert.deepStrictEqual(res, { ok: false, error: 'No such build.' });
});

test('applyTweak on a params-less legacy record asks for a regenerate', async () => {
  const kv = fakeKv();
  // Hand-seeded pre-params record: valid id shape, no params key.
  const legacy = {
    id: 'aaaabbbbcccc', ts: '2026-07-01T00:00:00.000Z', brand: 'Groww',
    vertical: 'Finance', tone: 'Playful', currency: 'INR', moduleId: 'reveal',
    validation: { pass: true }, ampHtml: '<!doctype html>',
  };
  await kv.put('build:' + legacy.id, JSON.stringify(legacy));
  const res = await applyTweak(
    { buildId: legacy.id, prompt: 'make it #112233', kv },
    { validate },
  );
  assert.strictEqual(res.ok, false);
  assert.match(res.error, /regenerate it first/);
});

test('applyTweak with a prompt that yields no plan explains what it can change', async () => {
  const kv = fakeKv();
  const parent = await seedBuild(kv);
  const res = await applyTweak(
    { buildId: parent.id, prompt: 'hello there my friend', kv },
    { validate },
  );
  assert.strictEqual(res.ok, false);
  assert.match(res.error, /concrete change/);
  assert.strictEqual(await readVersions(kv, parent.id).then((v) => v.length), 0, 'a failed tweak leaves no version entry');
});

// ---- the LLM tier: injected providers, deterministic fallback -----------------

test('proposeEditPlan uses an injected provider plan (revalidated, unknown fields stripped) and never leaks the ampHtml', async () => {
  const kv = fakeKv();
  const build = await seedBuild(kv, { moduleId: 'poll' });
  let seenPrompt = null;
  const provider = async (prompt) => {
    seenPrompt = prompt;
    return { tone: 'Premium', copy: { question: 'Which perk should lead?' }, bogus: 'stripped' };
  };
  const plan = await proposeEditPlan({ prompt: 'make it feel fancier', build }, { providers: [provider] });
  assert.deepStrictEqual(plan, { tone: 'Premium', copy: { question: 'Which perk should lead?' } });
  assert.ok(seenPrompt.includes('Groww'), 'the provider prompt carries the build parameters');
  assert.ok(seenPrompt.includes('make it feel fancier'), 'the provider prompt carries the tweak request');
  assert.ok(!seenPrompt.includes('<!doctype'), 'the ampHtml must never reach the provider');
});

test('a throwing provider degrades to the deterministic plan', async () => {
  const kv = fakeKv();
  const build = await seedBuild(kv);
  const bad = async () => { throw new Error('provider meltdown'); };
  const plan = await proposeEditPlan({ prompt: 'paint it #ff8800', build }, { providers: [bad] });
  assert.deepStrictEqual(plan, { colorOverride: '#ff8800' });
});

test('a provider plan that fails validation also degrades to the deterministic plan', async () => {
  const kv = fakeKv();
  const build = await seedBuild(kv);
  const marked = async () => ({ copy: { head: '<script>alert(1)</script>' } });
  const plan = await proposeEditPlan({ prompt: 'paint it #ff8800', build }, { providers: [marked] });
  assert.deepStrictEqual(plan, { colorOverride: '#ff8800' });
});

test('proposeEditPlan yields null when both tiers come up empty', async () => {
  const kv = fakeKv();
  const build = await seedBuild(kv);
  const empty = async () => null;
  assert.strictEqual(await proposeEditPlan({ prompt: 'hello there my friend', build }, { providers: [empty] }), null);
});
