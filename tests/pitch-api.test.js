'use strict';
const { test } = require('node:test');
const assert = require('node:assert');

// Deterministic defaults: no ambient provider key may enable a real LLM
// provider during this suite (same rule as tests/slate-core.test.js), so
// research degrades to the heuristic dossier and every build exercises the
// template copy path.
delete process.env.ANTHROPIC_API_KEY;
delete process.env.GEMINI_API_KEY;
delete process.env.GROQ_API_KEY;
delete process.env.OLLAMA_BASE_URL;

// Fully offline: the dossier scrape, the colour resolver and the logo
// resolver all try the network for unknown brands — every fetch must fail
// fast instead of waiting out a real timeout budget. All of them treat a
// failed fetch as "fall through", never an error.
globalThis.fetch = async () => { throw new Error('offline test: network disabled'); };

const { createPitchApi } = require('../server/pitch-api');
const { bindLocalRepo } = require('../server/repo-supabase');
const { createLocalDb, MIGRATIONS } = require('../server/db');
const { validate } = require('../server/validator');
const { MODULES } = require('../server/generate');

// In-memory stand-in for the Cloudflare KV binding (copied from
// tests/slate-core.test.js): same { get(key, type), put(key, value) } subset
// store.js targets, Map-backed so tests can assert which keys were written.
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

// Each test gets a throwaway ':memory:' database with the REAL 0001 migration
// applied (the same SQL D1 runs), the bound local repo, a fake kv, the real
// Node validator, and no providers — the exact ctx server/index.js would
// build on a keyless offline checkout.
async function freshApi() {
  const db = createLocalDb(':memory:');
  await db.applyMigrations(MIGRATIONS);
  const repo = bindLocalRepo(db);
  const kv = fakeKv();
  const api = createPitchApi({
    repo, storage: null, kv, validate, llmProviders: async () => undefined,
  });
  return { api, repo, kv };
}

// ---- createBrand: the wizard's research step ---------------------------------

test('createBrand: offline research yields a heuristic dossier; a hash colour never lands in primary_hex', async () => {
  const { api, kv } = await freshApi();
  const res = await api.createBrandH({
    name: 'Zentara <Robotics>', notes: 'sells robot arms to hobbyists', author: 'hriday',
  });
  assert.strictEqual(res.status, 200);
  const { brand, dossier } = res.json;
  assert.strictEqual(brand.name, 'Zentara Robotics', 'markup is stripped from the client name');
  assert.strictEqual(brand.slug, 'zentararobotics');
  assert.strictEqual(brand.primary_hex, null,
    'a hash colour is a deterministic guess, not brand truth — the column stays null');
  assert.strictEqual(brand.created_by, 'hriday');
  assert.ok(brand.dossier && typeof brand.dossier === 'object', 'the row ships a parsed dossier');
  assert.strictEqual(brand.dossier_json, undefined, 'the raw json never reaches the wire');
  assert.strictEqual(brand.vertical, dossier.vertical, 'the researched vertical lands on the row');
  // the top-level dossier is the trimmed public shape, never the cache record
  assert.strictEqual(dossier.confidence, 'heuristic');
  assert.ok(Array.isArray(dossier.products));
  assert.strictEqual(dossier.notesHash, undefined, 'cache bookkeeping stays server-side');
  assert.ok(kv.map.has('dossier:zentararobotics'), 'research is cached under dossier:<slug>');
});

test('createBrand: a library brand freezes its real colour; junk names 400; re-adding merges', async () => {
  const { api } = await freshApi();
  const res = await api.createBrandH({ name: 'Groww', author: 'dev' });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.json.brand.primary_hex, '#00b386', 'library colour is brand truth, stored');
  const again = await api.createBrandH({ name: 'Groww' });
  assert.strictEqual(again.status, 200);
  assert.strictEqual(again.json.brand.id, res.json.brand.id, 're-adding merges, never duplicates');
  assert.strictEqual((await api.createBrandH({ name: '' })).status, 400);
  assert.strictEqual((await api.createBrandH({ name: '<>' })).status, 400, 'markup-only cleans to empty');
  assert.strictEqual((await api.createBrandH({})).status, 400);
  assert.strictEqual((await api.createBrandH({ name: '!!!' })).status, 400,
    'a name with no letter or digit cannot slug');
});

// ---- brand detail views --------------------------------------------------------

test('getBrand/getBrandBySlug: full workspace shape, junk ids 400, unknown 404', async () => {
  const { api } = await freshApi();
  const id = (await api.createBrandH({ name: 'Zentara' })).json.brand.id;
  const res = await api.getBrandH({ id });
  assert.strictEqual(res.status, 200);
  assert.ok(res.json.brand.dossier && typeof res.json.brand.dossier === 'object');
  assert.deepStrictEqual(res.json.products, []);
  assert.deepStrictEqual(res.json.contacts, []);
  assert.deepStrictEqual(res.json.assets, []);
  assert.deepStrictEqual(res.json.pitches, []);
  const bySlug = await api.getBrandBySlugH({ slug: 'zentara' });
  assert.strictEqual(bySlug.status, 200);
  assert.strictEqual(bySlug.json.brand.id, id);
  assert.strictEqual((await api.getBrandH({ id: 'zz' })).status, 400);
  assert.strictEqual((await api.getBrandH({ id: 'aaaaaabbbbbb' })).status, 404);
  assert.strictEqual((await api.getBrandBySlugH({ slug: 'No-Slug!' })).status, 400);
  assert.strictEqual((await api.getBrandBySlugH({ slug: 'missing' })).status, 404);
});

// ---- kit + products -------------------------------------------------------------

test('updateBrandKit: valid fields land, invalid fields drop (never clear), products replace whole-list', async () => {
  const { api } = await freshApi();
  const id = (await api.createBrandH({ name: 'Zentara' })).json.brand.id;
  const res = await api.updateBrandKitH({
    id,
    patch: {
      primary: '#112233',
      logoUrl: 'https://cdn.zentara.example/logo.png',
      heroUrl: 'https://cdn.zentara.example/hero.jpg',
      site: 'https://zentara.example',
      voiceSample: 'Calm, precise, a little playful.',
      vertical: 'NotARealVertical', // must be dropped, never stored
    },
    products: [
      { name: 'Arm One', price: 999, image: 'https://cdn.zentara.example/arm1.png' },
      { name: 'Grip Kit', price: 0 }, // invalid price drops, the row survives
      { price: 450 }, // no name -> the row drops
    ],
    author: 'hriday',
  });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.json.brand.primary_hex, '#112233');
  assert.strictEqual(res.json.brand.logo_url, 'https://cdn.zentara.example/logo.png');
  assert.strictEqual(res.json.brand.voice_sample, 'Calm, precise, a little playful.');
  assert.notStrictEqual(res.json.brand.vertical, 'NotARealVertical');
  assert.strictEqual(res.json.products.length, 2);
  assert.strictEqual(res.json.products[0].name, 'Arm One');
  assert.strictEqual(res.json.products[0].price, 999);
  assert.strictEqual(res.json.products[0].image_url, 'https://cdn.zentara.example/arm1.png');
  assert.strictEqual(res.json.products[1].price, null);
  assert.strictEqual((await api.updateBrandKitH({ id })).status, 400, 'no patch, no products -> nothing to update');
  assert.strictEqual((await api.updateBrandKitH({ id, patch: { vertical: 'Nope' } })).status, 400,
    'a patch with nothing valid left is refused, not silently ignored');
  assert.strictEqual((await api.updateBrandKitH({ id: 'aaaaaabbbbbb', patch: { primary: '#112233' } })).status, 404);
  // products-only update: brand row untouched, list replaced
  const prodOnly = await api.updateBrandKitH({ id, products: [{ name: 'Solo' }] });
  assert.strictEqual(prodOnly.status, 200);
  assert.deepStrictEqual(prodOnly.json.products.map((p) => p.name), ['Solo']);
});

// ---- contacts -------------------------------------------------------------------

test('contacts: add/update/delete with the kit-patch stance on fields', async () => {
  const { api } = await freshApi();
  const brandId = (await api.createBrandH({ name: 'Zentara' })).json.brand.id;
  const add = await api.addContactH({
    brandId,
    contact: { name: 'Asha <Rao>', role: 'CMO', email: 'not-an-email' },
    author: 'hriday',
  });
  assert.strictEqual(add.status, 200);
  assert.strictEqual(add.json.contact.name, 'Asha Rao');
  assert.strictEqual(add.json.contact.role, 'CMO');
  assert.strictEqual(add.json.contact.email, null, 'an invalid email is dropped, never stored');
  const cid = add.json.contact.id;
  const upd = await api.updateContactH({ id: cid, contact: { email: 'asha@zentara.example', role: '' } });
  assert.strictEqual(upd.status, 200);
  assert.strictEqual(upd.json.contact.email, 'asha@zentara.example');
  assert.strictEqual(upd.json.contact.role, null, 'an explicit empty string clears');
  assert.strictEqual((await api.getBrandH({ id: brandId })).json.contacts.length, 1);
  assert.strictEqual((await api.addContactH({ brandId, contact: { role: 'CEO' } })).status, 400,
    'a contact needs a name');
  assert.strictEqual((await api.addContactH({ brandId: 'aaaaaabbbbbb', contact: { name: 'X' } })).status, 404);
  assert.strictEqual((await api.updateContactH({ id: 'aaaaaabbbbbb', contact: { name: 'Y' } })).status, 404);
  assert.strictEqual((await api.deleteContactH({ id: cid })).status, 200);
  assert.strictEqual((await api.deleteContactH({ id: cid })).status, 404, 'a second delete finds nothing');
});

// ---- pitches --------------------------------------------------------------------

test('pitches: create/list/get/update with the brand join and the status allowlist', async () => {
  const { api } = await freshApi();
  const brandId = (await api.createBrandH({ name: 'Zentara' })).json.brand.id;
  const res = await api.createPitchH({
    brandId,
    title: 'Diwali <Push>',
    goal: 'win the Q4 budget',
    brief: 'spin the wheel for 20% off robot arms',
    author: 'hriday',
  });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.json.pitch.title, 'Diwali Push');
  assert.strictEqual(res.json.pitch.status, 'active');
  const pid = res.json.pitch.id;
  const list = await api.listPitchesH();
  assert.strictEqual(list.json.items.length, 1);
  assert.strictEqual(list.json.items[0].brandName, 'Zentara');
  assert.strictEqual(list.json.items[0].exampleCount, 0);
  const got = await api.getPitchH({ id: pid });
  assert.strictEqual(got.status, 200);
  assert.strictEqual(got.json.brand.id, brandId);
  assert.ok(got.json.brand.dossier, 'the pitch view carries the parsed dossier');
  assert.deepStrictEqual(got.json.examples, []);
  const upd = await api.updatePitchH({ id: pid, patch: { status: 'archived', junk: 'x' } });
  assert.strictEqual(upd.status, 200);
  assert.strictEqual(upd.json.pitch.status, 'archived');
  assert.strictEqual((await api.updatePitchH({ id: pid, patch: { status: 'exploded' } })).status, 400,
    'an unknown status leaves nothing valid to change');
  assert.strictEqual((await api.createPitchH({ brandId, title: '' })).status, 400);
  assert.strictEqual((await api.createPitchH({ brandId: 'aaaaaabbbbbb', title: 'X' })).status, 404);
  assert.strictEqual((await api.getPitchH({ id: 'aaaaaabbbbbb' })).status, 404);
});

test('deletePitchH hard-deletes the pitch and cascades to its examples', async () => {
  const { api, repo } = await freshApi();
  const brandId = (await api.createBrandH({ name: 'Deletable Co' })).json.brand.id;
  const pitch = (await api.createPitchH({ brandId, title: 'To be deleted' })).json.pitch;
  const ex = await api.createDocExampleH({
    pitchId: pitch.id, title: 'Doomed email',
    doc: { version: 1, blocks: [{ id: 'b1', type: 'text', props: { heading: 'Hi', body: 'x' } }] },
    author: 'tester',
  });
  assert.strictEqual(ex.status, 200);
  assert.strictEqual((await api.getPitchH({ id: pitch.id })).json.examples.length, 1, 'example present before delete');

  const del = await api.deletePitchH({ id: pitch.id, author: 'tester' });
  assert.strictEqual(del.status, 200);
  assert.strictEqual(del.json.ok, true);

  assert.strictEqual((await api.getPitchH({ id: pitch.id })).status, 404, 'the pitch is gone');
  assert.deepStrictEqual(await repo.listExamplesForPitch(pitch.id), [], 'its examples are gone too');
  const list = await api.listPitchesH();
  assert.ok(!(list.json.pitches || list.json.items || []).some((p) => p.id === pitch.id), 'off the pitch list');

  assert.strictEqual((await api.deletePitchH({ id: pitch.id })).status, 404, 'a second delete finds nothing');
  assert.strictEqual((await api.deletePitchH({ id: 'nope' })).status, 400, 'a malformed id is a 400');
});

// ---- createExample: the bridge from the engines into the pitch space ------------

test('createExample end-to-end: real generate + real validator, brands-row colour/assets/products/voice carried', async () => {
  const { api, kv } = await freshApi();
  const brandId = (await api.createBrandH({ name: 'Zentara' })).json.brand.id;
  await api.updateBrandKitH({
    id: brandId,
    patch: {
      primary: '#112233',
      logoUrl: 'https://cdn.zentara.example/logo.png',
      heroUrl: 'https://cdn.zentara.example/hero.jpg',
      site: 'https://zentara.example',
      voiceSample: 'Calm, precise, a little playful.',
    },
    products: [
      { name: 'Arm One', price: 999, image: 'https://cdn.zentara.example/arm1.png' },
      { name: 'Grip Kit' },
    ],
  });
  const pitch = (await api.createPitchH({
    brandId, title: 'Diwali Push', brief: 'spin the wheel for 20% off robot arms',
  })).json.pitch;

  const res = await api.createExampleH({
    pitchId: pitch.id, title: 'Spin & Win', moduleId: 'spin', author: 'hriday',
  });
  assert.strictEqual(res.status, 200);
  const { example, build } = res.json;

  // A real AMP4EMAIL document came back through the real validator.
  assert.ok(typeof example.amp_html === 'string' && example.amp_html.includes('amp4email'),
    'the stored payload is a real AMP email');
  assert.strictEqual(example.validation_pass, 1);
  assert.strictEqual(example.module_id, 'spin');
  assert.strictEqual(example.title, 'Spin & Win');
  assert.strictEqual(example.root_id, example.id, 'a fresh example roots its own chain');
  assert.strictEqual(example.parent_id, null);
  assert.strictEqual(build.moduleId, 'spin');
  assert.strictEqual(build.moduleName, MODULES.spin.name);

  // params carry the buildId, and the kv really holds that build.
  const params = JSON.parse(example.params_json);
  assert.ok(/^[a-z0-9-]{6,64}$/.test(params.buildId), 'params_json links the example to its build');
  assert.strictEqual(build.sharePath, '/b/' + params.buildId);
  assert.ok(kv.map.has('build:' + params.buildId), 'the build record persisted — the example is share-able');
  const stored = JSON.parse(kv.map.get('build:' + params.buildId));
  assert.strictEqual(stored.brand, 'Zentara');
  assert.strictEqual(stored.useCase, 'Spin & Win', 'the example title is the build provenance');
  assert.strictEqual(stored.brief, 'spin the wheel for 20% off robot arms',
    'no explicit brief -> the pitch brief drives the build');
  assert.strictEqual(stored.params.colorOverride, '#112233', 'the brands-row colour pins the palette');
  assert.strictEqual(stored.params.copy.logoUrl, 'https://cdn.zentara.example/logo.png');
  assert.strictEqual(stored.params.copy.heroUrl, 'https://cdn.zentara.example/hero.jpg');
  assert.strictEqual(stored.params.copy.site, 'https://zentara.example');
  assert.strictEqual(stored.params.copy.discount, 20, 'the brief-stated % survives deterministically');
  assert.deepStrictEqual(stored.params.copy.items.map((i) => i.name), ['Arm One', 'Grip Kit'],
    'brands-row products ground the email in real items');

  // THE KV-KIT BRIDGE: the brands row projected into the legacy kit before
  // the build, so build-pipeline's kit tier (voiceSample above all) reads the
  // same truth the relational workspace holds.
  const kit = JSON.parse(kv.map.get('brandkit:zentara'));
  assert.strictEqual(kit.source, 'genie2');
  assert.strictEqual(kit.voiceSample, 'Calm, precise, a little playful.');
  assert.strictEqual(kit.primary, '#112233');
  assert.strictEqual(kit.logoUrl, 'https://cdn.zentara.example/logo.png');

  // The pitch gallery sees the one latest row of the chain, payload-free.
  const pitchView = await api.getPitchH({ id: pitch.id });
  assert.strictEqual(pitchView.json.examples.length, 1);
  assert.strictEqual(pitchView.json.examples[0].hasAmp, 1);
  assert.strictEqual(pitchView.json.examples[0].amp_html, undefined, 'list rows never ship the payload');

  assert.strictEqual((await api.createExampleH({ pitchId: 'aaaaaabbbbbb' })).status, 404);
  assert.strictEqual((await api.createExampleH({ pitchId: 'z!' })).status, 400);
});

test('createExample defaults: no title names the example after its module; an explicit brief overrides the pitch brief', async () => {
  const { api, kv } = await freshApi();
  const brandId = (await api.createBrandH({ name: 'Zentara' })).json.brand.id;
  const pitch = (await api.createPitchH({
    brandId, title: 'Card push', brief: 'tell people about the new store',
  })).json.pitch;
  const res = await api.createExampleH({
    pitchId: pitch.id, brief: 'rate your last delivery', author: 'dev',
  });
  assert.strictEqual(res.status, 200);
  const { example, build } = res.json;
  assert.strictEqual(example.title, build.moduleName, 'an untitled example is named after its module');
  const stored = JSON.parse(kv.map.get('build:' + JSON.parse(example.params_json).buildId));
  assert.strictEqual(stored.brief, 'rate your last delivery', 'the explicit brief wins over the pitch brief');
  assert.strictEqual(stored.useCase, null, 'no title -> no use-case provenance');
  assert.strictEqual(example.validation_pass, 1, 'hash-colour brands still build valid AMP');
});

// ---- tweak: the zero-key floor makes a new version --------------------------------

test('tweakExample: a deterministic hex tweak creates a new version with full lineage', async () => {
  const { api, kv } = await freshApi();
  const brandId = (await api.createBrandH({ name: 'Zentara' })).json.brand.id;
  await api.updateBrandKitH({ id: brandId, patch: { primary: '#112233' } });
  const pitch = (await api.createPitchH({
    brandId, title: 'Diwali Push', brief: 'spin the wheel for 20% off',
  })).json.pitch;
  const first = (await api.createExampleH({
    pitchId: pitch.id, title: 'Spin & Win', moduleId: 'spin', author: 'hriday',
  })).json.example;
  const firstBuildId = JSON.parse(first.params_json).buildId;

  const res = await api.tweakExampleH({ id: first.id, prompt: 'make it #445566', author: 'dev' });
  assert.strictEqual(res.status, 200);
  const next = res.json.example;
  assert.strictEqual(next.parent_id, first.id);
  assert.strictEqual(next.root_id, first.id, 'the chain roots at the original');
  assert.strictEqual(next.tweak_prompt, 'make it #445566');
  assert.strictEqual(next.validation_pass, 1);
  assert.strictEqual(next.title, first.title, 'a tweak keeps the family title');
  const nextParams = JSON.parse(next.params_json);
  assert.strictEqual(nextParams.tweakOf, firstBuildId);
  assert.notStrictEqual(nextParams.buildId, firstBuildId, 'the rebuild is its own persisted build');
  assert.strictEqual(res.json.build.sharePath, '/b/' + nextParams.buildId);
  const rebuilt = JSON.parse(kv.map.get('build:' + nextParams.buildId));
  assert.strictEqual(rebuilt.params.colorOverride, '#445566', 'the hex in the prompt IS the zero-key edit plan');
  assert.strictEqual(rebuilt.parentId, firstBuildId, 'build-level lineage matches the example rows');

  // versions ride getExample: oldest first, list rows with hasAmp
  const got = await api.getExampleH({ id: next.id });
  assert.strictEqual(got.status, 200);
  assert.deepStrictEqual(got.json.versions.map((v) => v.id), [first.id, next.id]);
  assert.strictEqual(got.json.versions[1].hasAmp, 1);

  // the pitch gallery collapses the chain to its newest row
  const pitchView = await api.getPitchH({ id: pitch.id });
  assert.strictEqual(pitchView.json.examples.length, 1);
  assert.strictEqual(pitchView.json.examples[0].id, next.id);

  // guard rails
  const vague = await api.tweakExampleH({ id: first.id, prompt: 'hmm, nicer somehow?' });
  assert.strictEqual(vague.status, 400);
  assert.strictEqual(vague.json.ok, false, 'the engine explains a plan-less prompt, never throws');
  assert.strictEqual((await api.tweakExampleH({ id: 'aaaaaabbbbbb', prompt: '#112233' })).status, 404);
  assert.strictEqual((await api.getExampleH({ id: 'aaaaaabbbbbb' })).status, 404);
});

// ---- legacy rows, the activity feed and the brands rail ---------------------------

test('a pre-bridge example refuses tweaks; the activity feed and brand counters tell the whole story', async () => {
  const { api, repo } = await freshApi();
  const brandId = (await api.createBrandH({ name: 'Zentara', author: 'hriday' })).json.brand.id;
  await api.updateBrandKitH({ id: brandId, patch: { primary: '#112233' }, author: 'hriday' });
  const pitch = (await api.createPitchH({
    brandId, title: 'Diwali Push', brief: 'spin the wheel for 20% off', author: 'hriday',
  })).json.pitch;

  // a hand-inserted legacy example: no params, so no buildId to tweak
  const legacy = await repo.createExample({
    pitchId: pitch.id, title: 'legacy', ampHtml: '<html amp4email></html>',
  });
  const refused = await api.tweakExampleH({ id: legacy.id, prompt: '#445566' });
  assert.strictEqual(refused.status, 400);
  assert.match(refused.json.error, /predates tweak support/);

  await api.createExampleH({ pitchId: pitch.id, title: 'Spin & Win', moduleId: 'spin', author: 'hriday' });
  const feed = await api.brandActivityH({ brandId });
  assert.strictEqual(feed.status, 200);
  const verbs = feed.json.items.map((i) => i.verb);
  assert.strictEqual(verbs[0], 'example-created', 'newest first');
  for (const v of ['brand-created', 'kit-updated', 'pitch-created', 'example-created']) {
    assert.ok(verbs.includes(v), 'feed carries ' + v);
  }
  assert.strictEqual(feed.json.items[0].actor, 'hriday');
  assert.strictEqual((await api.brandActivityH({ brandId: 'j!' })).status, 400);

  const brands = await api.listBrandsH();
  assert.strictEqual(brands.json.items.length, 1);
  assert.strictEqual(brands.json.items[0].pitchCount, 1);
  assert.strictEqual(brands.json.items[0].exampleCount, 2, 'legacy + bridged example both count');
  assert.ok(brands.json.items[0].lastActivityAt, 'activity stamps the brands rail');
  assert.strictEqual(brands.json.items[0].dossier_json, undefined, 'list rows exclude the heavy column');
});

// ---- the never-throw contract ------------------------------------------------------

test('nothing throws into a request: junk args everywhere come back as 4xx bodies', async () => {
  const { api } = await freshApi();
  const outs = [
    await api.createBrandH(null),
    await api.getBrandH(),
    await api.getBrandBySlugH({ slug: '../etc' }),
    await api.updateBrandKitH({ id: null }),
    await api.addContactH({}),
    await api.updateContactH({ id: 'x' }),
    await api.deleteContactH({}),
    await api.createPitchH(undefined),
    await api.getPitchH({ id: { evil: true } }),
    await api.updatePitchH({ id: 42 }),
    await api.createExampleH({ pitchId: ['x'] }),
    await api.getExampleH({}),
    await api.tweakExampleH({}),
    await api.brandActivityH({ brandId: 42 }),
  ];
  for (const out of outs) {
    assert.ok(out && (out.status === 400 || out.status === 404),
      'junk -> 4xx, got ' + JSON.stringify(out));
    assert.strictEqual(typeof out.json.error, 'string');
  }
});

test('a missing repo degrades to 503, never a throw', async () => {
  const api = createPitchApi({
    repo: null, storage: null, kv: null, validate, llmProviders: async () => undefined,
  });
  const out = await api.listBrandsH();
  assert.strictEqual(out.status, 503);
  assert.strictEqual(out.json.error, 'database not configured');
});
