'use strict';
const { test } = require('node:test');
const assert = require('node:assert');

// Deterministic defaults: no ambient provider key may enable a real LLM
// provider during this suite (same rule as tests/brief-content.test.js), so
// composeContent always degrades to null and every build here exercises the
// template copy path.
delete process.env.ANTHROPIC_API_KEY;
delete process.env.GEMINI_API_KEY;
delete process.env.GROQ_API_KEY;
delete process.env.OLLAMA_BASE_URL;

// Fully offline: every live brand fetch (colour or logo) fails fast — and is
// counted, so the brand-kit tests can assert the kit tier really skipped the
// network — instead of waiting out real per-request timeout budgets. Both
// resolvers treat a failed fetch as "fall through", never an error.
let fetchCalls = 0;
globalThis.fetch = async () => {
  fetchCalls += 1;
  throw new Error('offline test: network disabled');
};

const { createBuild, buildHistoryEntry } = require('../server/build-pipeline');
const { validate } = require('../server/validator');
const { derivePalette } = require('../server/generate');
const { brandSlug, putBrandKit } = require('../server/store');

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

function sampleKit(overrides = {}) {
  return {
    slug: brandSlug('Zzyzx Labs'), name: 'Zzyzx Labs', primary: '#123456', accent: '#654321',
    vertical: 'Food', logoUrl: 'https://www.zzyzxlabs.com/logo.png',
    site: 'https://www.zzyzxlabs.com', source: 'fetched',
    updatedAt: '2026-07-10T00:00:00.000Z', ...overrides,
  };
}

// ---- kv=null: a full build with no persistence at all -----------------------

test('kv=null: AMP passes the real validator, fallback parts are present, no share link', async () => {
  const { response, build } = await createBuild(
    { brand: 'Groww', counter: 2 },
    { validate, kv: null },
  );
  assert.strictEqual(response.validation.pass, true,
    `build must pass the real AMP4EMAIL validator: ${JSON.stringify(response.validation.errors)}`);
  assert.ok(response.ampHtml.startsWith('<!doctype html>'));
  assert.ok(response.fallbackHtml.startsWith('<!doctype html>'), 'fallback html part is non-empty');
  assert.ok(response.fallbackHtml.includes('Groww'), 'fallback html carries the brand');
  assert.ok(response.fallbackText.includes('Groww'), 'fallback text carries the brand');
  assert.strictEqual(response.copySource, 'template', 'no brief means template copy');
  assert.ok(!('shareId' in response), 'no kv means no share id');
  assert.ok(!('sharePath' in response), 'no kv means no share path');
  // The build record still exists (callers derive the history entry from it).
  assert.match(build.id, /^[a-f0-9]{12}$/);
  assert.strictEqual(build.ampHtml, response.ampHtml);
});

// ---- fake kv: the build record persists and mints the share link ------------

test('with a kv, the build persists under build:<id> and the response carries the share link', async () => {
  const kv = fakeKv();
  const { response, build } = await createBuild(
    { brand: 'Groww', counter: 1 },
    { validate, kv, author: 'hriday', slateId: null, useCase: 'promo' },
  );
  assert.ok(kv.map.has('build:' + build.id), 'must be stored under the build: prefix');
  assert.strictEqual(response.shareId, build.id);
  assert.strictEqual(response.sharePath, '/b/' + build.id);
  const stored = JSON.parse(kv.map.get('build:' + build.id));
  assert.strictEqual(stored.ampHtml, response.ampHtml, 'persisted AMP must be byte-equal to the response');
  assert.strictEqual(stored.validation.pass, true);
  assert.strictEqual(stored.author, 'hriday');
  assert.strictEqual(stored.useCase, 'promo');
  assert.strictEqual(stored.slateId, null);
  assert.strictEqual(stored.fallbackHtml, response.fallbackHtml);
  assert.strictEqual(stored.fallbackText, response.fallbackText);
});

// ---- brand-kit tier: a saved kit replaces both live fetches -----------------

test('a pre-seeded brand kit wins: colorSource kit, palette from kit.primary, zero fetches', async () => {
  const kv = fakeKv();
  const kit = sampleKit();
  assert.strictEqual(await putBrandKit(kv, kit), true);
  fetchCalls = 0;
  // A nonsense brand that would otherwise live-fetch (miss the library) and
  // land on 'hash' — a kit hit must pre-empt all of that.
  const { response } = await createBuild({ brand: 'Zzyzx Labs', counter: 0 }, { validate, kv });
  assert.strictEqual(response.colorSource, 'kit');
  assert.deepStrictEqual(response.palette, derivePalette(kit.primary), 'palette derives from the kit primary');
  assert.strictEqual(fetchCalls, 0, 'a kit hit must skip the live colour/logo fetches entirely');
  assert.strictEqual(response.vertical, 'Food', 'kit vertical is the inference fallback');
  assert.ok(response.ampHtml.includes(kit.logoUrl), 'kit logo replaces the placeholder image');
  assert.strictEqual(response.validation.pass, true);
});

test('an explicit colorOverride bypasses the kit and resolves as before', async () => {
  const kv = fakeKv();
  assert.strictEqual(await putBrandKit(kv, sampleKit()), true);
  const { response } = await createBuild(
    { brand: 'Zzyzx Labs', counter: 0, colorOverride: '#ff8800' },
    { validate, kv },
  );
  assert.strictEqual(response.colorSource, 'override');
  assert.deepStrictEqual(response.palette, derivePalette('#ff8800'));
});

// ---- determinism: the extraction must not perturb the seeded pipeline -------

test('same brand+counter with kv=null yields byte-identical ampHtml across two calls', async () => {
  const body = { brand: 'Zzyzx Labs', counter: 7 };
  const a = await createBuild(body, { validate, kv: null });
  const b = await createBuild(body, { validate, kv: null });
  assert.strictEqual(a.response.ampHtml, b.response.ampHtml);
  assert.strictEqual(a.response.fallbackHtml, b.response.fallbackHtml);
  assert.strictEqual(a.response.colorSource, 'hash', 'unknown brand, no kit, offline: hash tier');
});

// ---- explicit caller choices always win --------------------------------------

test('explicit body.vertical/tone/moduleId win over kit vertical, inference, and brief routing', async () => {
  const kv = fakeKv();
  assert.strictEqual(await putBrandKit(kv, sampleKit()), true); // kit says Food
  const { response } = await createBuild({
    brand: 'Zzyzx Labs',
    vertical: 'Fashion',
    tone: 'Premium',
    moduleId: 'poll',
    brief: 'Spin the wheel jackpot lucky draw', // routes to spin
    counter: 0,
  }, { validate, kv });
  assert.strictEqual(response.vertical, 'Fashion', 'explicit vertical beats the kit vertical');
  assert.strictEqual(response.tone, 'Premium', 'explicit tone beats inference');
  assert.strictEqual(response.moduleId, 'poll', 'explicit moduleId beats the router');
  assert.strictEqual(response.colorSource, 'kit', 'the kit still supplies the colour');
  // The router's overridden suggestion is kept for audit, marked not applied.
  assert.strictEqual(response.routedFromBrief.moduleId, 'spin');
  assert.strictEqual(response.routedFromBrief.applied, false);
  assert.strictEqual(response.copySource, 'template', 'no providers configured: brief copy degrades to template');
});

// ---- buildHistoryEntry: the legacy Recent-builds panel shape -----------------

test('buildHistoryEntry derives the legacy history entry (plus shareId) from a build record', async () => {
  const { build } = await createBuild({ brand: 'Groww', counter: 4 }, { validate, kv: null });
  const entry = buildHistoryEntry(build);
  assert.deepStrictEqual(entry, {
    id: build.id,
    ts: build.ts,
    brand: 'Groww',
    vertical: 'Finance',
    tone: build.tone,
    moduleId: build.moduleId,
    moduleName: build.moduleName,
    colorSource: 'library',
    palette: build.palette,
    brief: null,
    routedFromBrief: null,
    validationPass: true,
    ampHtml: build.ampHtml,
    shareId: build.id,
  });
});
