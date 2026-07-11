'use strict';
const { test } = require('node:test');
const assert = require('node:assert');

// Deterministic defaults: no ambient provider key may enable a real LLM
// provider during this suite (same rule as tests/build-pipeline.test.js), so
// composeContent always degrades to null and every build here exercises the
// template copy path.
delete process.env.ANTHROPIC_API_KEY;
delete process.env.GEMINI_API_KEY;
delete process.env.GROQ_API_KEY;
delete process.env.OLLAMA_BASE_URL;

// Fully offline: every body below sets colorOverride, which skips the colour
// resolver's live fetch — but the logo resolver still tries the network, so
// every fetch must fail fast instead of waiting out a real timeout budget.
// Both resolvers treat a failed fetch as "fall through", never an error.
globalThis.fetch = async () => { throw new Error('offline test: network disabled'); };

const { createSlate } = require('../server/slate-core');
const { createBuild } = require('../server/build-pipeline');
const { validate } = require('../server/validator');
const { MODULES, MODULE_IDS } = require('../server/generate');

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

// ---- the pitch deliverable: one brand + one brief -> a full slate -----------

test('a routed brief leads the slate: 6 distinct modules, all pass the real validator, all persisted', async () => {
  const kv = fakeKv();
  const { slate, builds, response } = await createSlate({
    brand: 'Groww', brief: 'spin the wheel for 20% off brokerage', count: 6, colorOverride: '#00d09c',
  }, { validate, kv });

  assert.strictEqual(builds.length, 6);
  assert.strictEqual(new Set(builds.map((b) => b.moduleId)).size, 6, 'every module id must be distinct');
  assert.strictEqual(builds[0].moduleId, 'spin', 'the brief routes to spin, which must lead the slate');
  for (const b of builds) {
    assert.strictEqual(b.validation.pass, true, `${b.moduleId} must pass the real AMP4EMAIL validator`);
    assert.strictEqual(b.slateId, slate.id, 'every build carries its slate id from birth');
    assert.strictEqual(b.useCase, MODULES[b.moduleId].name, 'useCase is the module display name');
  }

  // The slate record persisted with all six build ids, in slate order.
  assert.ok(kv.map.has('slate:' + slate.id), 'must be stored under the slate: prefix');
  const storedSlate = JSON.parse(kv.map.get('slate:' + slate.id));
  assert.deepStrictEqual(storedSlate.buildIds, builds.map((b) => b.id));
  assert.strictEqual(storedSlate.buildIds.length, 6);
  assert.deepStrictEqual(storedSlate.moduleIds, builds.map((b) => b.moduleId));
  assert.strictEqual(storedSlate.title, 'Groww — pitch slate');
  assert.strictEqual(storedSlate.brief, 'spin the wheel for 20% off brokerage');

  // Every build record persisted, byte-carrying the AMP the share page serves.
  for (const b of builds) {
    assert.ok(kv.map.has('build:' + b.id), `build:${b.id} must be stored`);
    const stored = JSON.parse(kv.map.get('build:' + b.id));
    assert.strictEqual(stored.ampHtml, b.ampHtml, 'persisted AMP must be byte-equal to the build record');
  }

  // The wire shape the slate front doors return.
  assert.strictEqual(response.slateId, slate.id);
  assert.strictEqual(response.sharePath, '/s/' + slate.id);
  assert.strictEqual(response.brand, 'Groww');
  assert.strictEqual(response.title, slate.title);
  assert.strictEqual(response.builds.length, 6);
  response.builds.forEach((rb, i) => {
    assert.strictEqual(rb.id, builds[i].id);
    assert.strictEqual(rb.moduleId, builds[i].moduleId);
    assert.strictEqual(rb.moduleName, builds[i].moduleName);
    assert.strictEqual(rb.useCase, builds[i].useCase);
    assert.deepStrictEqual(rb.validation, { pass: true, errorCount: 0 });
    assert.strictEqual(rb.sharePath, '/b/' + builds[i].id);
  });
});

// ---- count clamps to [1, MODULE_IDS.length] ---------------------------------

test('count:2 builds exactly 2; count:99 clamps to one build per module', async () => {
  const two = await createSlate(
    { brand: 'Groww', count: 2, colorOverride: '#00d09c' },
    { validate, kv: fakeKv() },
  );
  assert.strictEqual(two.builds.length, 2);

  const many = await createSlate(
    { brand: 'Groww', count: 99, colorOverride: '#00d09c' },
    { validate, kv: fakeKv() },
  );
  assert.strictEqual(many.builds.length, MODULE_IDS.length, 'a slate never repeats a module');
  assert.strictEqual(new Set(many.builds.map((b) => b.moduleId)).size, MODULE_IDS.length);
});

// ---- no brief: nothing to route, canonical module order ---------------------

test('no brief: no routing, canonical MODULE_IDS order, still all valid', async () => {
  const { slate, builds } = await createSlate(
    { brand: 'Groww', colorOverride: '#00d09c' },
    { validate, kv: fakeKv() },
  );
  assert.deepStrictEqual(builds.map((b) => b.moduleId), MODULE_IDS);
  for (const b of builds) {
    assert.strictEqual(b.validation.pass, true, `${b.moduleId} must pass the real AMP4EMAIL validator`);
    assert.strictEqual(b.brief, null);
    assert.strictEqual(b.routedFromBrief, null);
  }
  assert.strictEqual(slate.brief, null);
});

// ---- resilience: one failed build must not sink the slate --------------------
// deps.createBuildImpl is the documented test-only seam: the builds run in
// parallel, so injecting the failure through the real pipeline (e.g. a
// validate wrapper that throws "on the 3rd call") would depend on completion
// order, which Promise.allSettled deliberately doesn't fix.

test('one failed build drops out and the other n-1 survive, slate included', async () => {
  const kv = fakeKv();
  const failing = 'quiz';
  const createBuildImpl = async (body, deps) => {
    if (body.moduleId === failing) throw new Error('injected: provider meltdown');
    return createBuild(body, deps);
  };
  const { slate, builds, response } = await createSlate(
    { brand: 'Groww', colorOverride: '#00d09c' },
    { validate, kv, createBuildImpl },
  );
  assert.strictEqual(builds.length, MODULE_IDS.length - 1);
  assert.ok(!builds.some((b) => b.moduleId === failing), 'the failed module must drop out');
  assert.deepStrictEqual(slate.buildIds, builds.map((b) => b.id), 'the slate references only surviving builds');
  assert.strictEqual(response.builds.length, MODULE_IDS.length - 1);
  assert.ok(kv.map.has('slate:' + slate.id), 'the slate still persists with n-1 builds');
});

test('zero surviving builds fails the slate outright', async () => {
  const createBuildImpl = async () => { throw new Error('injected: everything down'); };
  await assert.rejects(
    createSlate({ brand: 'Groww', colorOverride: '#00d09c' }, { validate, kv: fakeKv(), createBuildImpl }),
    /every build failed/,
  );
});

// ---- v3: explicit use-cases replace the module-order fan-out ----------------

test('explicit useCases build in caller order with titles as labels, contentPlan copy landing in the AMP', async () => {
  const kv = fakeKv();
  const useCases = [
    { title: 'Diwali offer reveal for loyalists', moduleId: 'reveal', contentPlan: { head: 'Your Diwali surprise from Groww' } },
    { title: 'Risk-profile quiz', moduleId: 'quiz', contentPlan: {} },
    { title: 'Second reveal play', moduleId: 'reveal', contentPlan: {} },
  ];
  const { slate, builds, response } = await createSlate({
    brand: 'Groww', useCases, colorOverride: '#00d09c',
  }, { validate, kv });

  assert.strictEqual(builds.length, 3);
  assert.deepStrictEqual(builds.map((b) => b.moduleId), ['reveal', 'quiz', 'reveal'], 'caller order, repeats allowed');
  assert.strictEqual(builds[0].useCase, 'Diwali offer reveal for loyalists');
  for (const b of builds) assert.strictEqual(b.validation.pass, true, `${b.moduleId} must pass the real validator`);
  // The plan's head must appear in the AMP bytes (entity-encoding leaves ASCII as-is).
  assert.ok(builds[0].ampHtml.includes('Your Diwali surprise from Groww'), 'contentPlan.head must drive the module copy');
  assert.ok(response.builds[0].useCase, 'response rows carry the use-case label');
  const storedSlate = JSON.parse(kv.map.get('slate:' + slate.id));
  assert.deepStrictEqual(storedSlate.useCases.map((u) => u.moduleId), ['reveal', 'quiz', 'reveal']);
});

test('hostile titles are stripped, unknown moduleIds fall back, caller copy still wins over contentPlan', async () => {
  const kv = fakeKv();
  const { builds } = await createSlate({
    brand: 'Groww',
    colorOverride: '#00d09c',
    copy: { head: 'Caller override wins' },
    useCases: [
      { title: '<img onerror=x>Sneaky', moduleId: 'reveal', contentPlan: { head: 'Plan head loses' } },
      { title: 'No such module', moduleId: 'nope', contentPlan: {} },
    ],
  }, { validate, kv });

  assert.strictEqual(builds.length, 2);
  assert.ok(!builds[0].useCase.includes('<') && !builds[0].useCase.includes('>'), 'markup stripped from titles');
  assert.ok(MODULE_IDS.includes(builds[1].moduleId), 'unknown moduleId falls back to a real module');
  assert.ok(builds[0].ampHtml.includes('Caller override wins'), 'body.copy beats contentPlan field-by-field');
  assert.ok(!builds[0].ampHtml.includes('Plan head loses'));
});

test('slates land newest-first in the slates:index for the Pitches view', async () => {
  const kv = fakeKv();
  await createSlate({ brand: 'First', count: 1, colorOverride: '#112233' }, { validate, kv });
  await createSlate({ brand: 'Second', count: 1, colorOverride: '#445566' }, { validate, kv });
  const index = JSON.parse(kv.map.get('slates:index'));
  assert.strictEqual(index.length, 2);
  assert.strictEqual(index[0].brand, 'Second', 'newest first');
  assert.ok(Array.isArray(index[0].buildIds) && index[0].buildIds.length === 1);
  assert.ok(!index[0].ampHtml, 'index rows are summaries, never full records');
});
