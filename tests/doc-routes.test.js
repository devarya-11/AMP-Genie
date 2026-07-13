'use strict';
const { test } = require('node:test');
const assert = require('node:assert');

// Offline + keyless, same charter as tests/pitch-api.test.js: no ambient key
// enables a provider, every stray fetch fails fast.
delete process.env.ANTHROPIC_API_KEY;
delete process.env.GEMINI_API_KEY;
delete process.env.GROQ_API_KEY;
delete process.env.OLLAMA_BASE_URL;
globalThis.fetch = async () => { throw new Error('offline test: network disabled'); };

const { createPitchApi } = require('../server/pitch-api');
const { bindLocalRepo } = require('../server/repo-supabase');
const { createLocalDb, MIGRATIONS } = require('../server/db');
const { validate } = require('../server/validator');
const {
  validateDoc, renderDoc, INTERACTIVE_TYPES,
} = require('../server/email-doc');

// The interactive contract lands in the same phase; guard so the legacy-
// synthesis assertions are skipped (not failed) if it has not landed yet.
const HAS_INTERACTIVE = INTERACTIVE_TYPES instanceof Set && INTERACTIVE_TYPES.size === 8;

// The in-memory KV stand-in from tests/pitch-api.test.js: Map-backed so we can
// assert which build:<id> share records were written.
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

// createPitchApi with a real ':memory:' DB (the D1 migration), the bound local
// repo, a fake kv, the real Node validator, and NO providers — the exact ctx
// an offline keyless checkout builds.
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

// A pitch to hang doc examples on (Groww is a library brand -> real colour,
// offline-safe research).
async function seedPitch(api) {
  const brandRes = await api.createBrandH({ name: 'Groww', author: 'dev' });
  assert.strictEqual(brandRes.status, 200);
  const brandId = brandRes.json.brand.id;
  const pitchRes = await api.createPitchH({ brandId, title: 'Q3 winback', brief: 'reactivate dormant SIP users', author: 'dev' });
  assert.strictEqual(pitchRes.status, 200);
  return { brandId, pitchId: pitchRes.json.pitch.id };
}

function validStarterDoc() {
  return {
    brand: { name: 'Groww', primaryHex: '#00b386' },
    currency: 'INR',
    blocks: [
      { type: 'header', props: { brandName: 'Groww' } },
      { type: 'text', props: { heading: 'Start your first SIP', body: 'A monthly habit, invested for you.' } },
      { type: 'button', props: { label: 'Open my SIP', href: 'https://groww.in', align: 'center' } },
      { type: 'footer', props: { brandName: 'Groww', text: 'You opted in.' } },
    ],
  };
}

// ---- renderDocH: the pure live-preview endpoint ------------------------------

test('renderDocH: a valid doc renders, passes, and echoes the sanitized doc', async () => {
  const { api } = await freshApi();
  const res = await api.renderDocH({ doc: validStarterDoc() });
  assert.strictEqual(res.status, 200);
  assert.ok(/^<!doctype html>/.test(res.json.ampHtml), 'returns an AMP document');
  assert.strictEqual(res.json.validation.pass, true, 'the email passes the validator');
  assert.strictEqual(res.json.validation.errorCount, 0);
  assert.ok(res.json.doc && Array.isArray(res.json.doc.blocks), 'echoes the sanitized doc');
  assert.ok(Array.isArray(res.json.warnings), 'warnings array present');
  assert.strictEqual(res.json.doc.version, 1, 'the doc is normalized (version stamped)');
});

test('renderDocH: a non-object doc is a 400', async () => {
  const { api } = await freshApi();
  assert.strictEqual((await api.renderDocH({ doc: null })).status, 400);
  assert.strictEqual((await api.renderDocH({ doc: 'nope' })).status, 400);
  assert.strictEqual((await api.renderDocH({ doc: [] })).status, 400);
  assert.strictEqual((await api.renderDocH({})).status, 400);
});

// M6: the editor's Edit/Preview toggle rides the anchors flag. Edit mode wants
// data-bid anchors (click-to-select); Preview mode wants the clean, shippable
// AMP so the interactive module actually plays. Default is anchored (the
// editor preview is the common caller).
test('renderDocH: the anchors flag toggles data-bid, and both stay valid', async () => {
  const { api } = await freshApi();
  const doc = validStarterDoc();
  const anchored = await api.renderDocH({ doc, anchors: true });
  const clean = await api.renderDocH({ doc, anchors: false });
  const def = await api.renderDocH({ doc });
  assert.ok(anchored.json.ampHtml.includes('data-bid'), 'anchors:true carries data-bid');
  assert.ok(!clean.json.ampHtml.includes('data-bid'), 'anchors:false is clean AMP');
  assert.ok(def.json.ampHtml.includes('data-bid'), 'default is anchored (editor preview)');
  // the anchors are editor-only chrome — neither variant may break validity
  assert.strictEqual(anchored.json.validation.pass, true, 'anchored still passes');
  assert.strictEqual(clean.json.validation.pass, true, 'clean still passes');
});

// ---- custom-AMP block: paste -> validator-clean fragment ----
test('customAmpH: a valid pasted fragment validates and echoes it sanitized', async () => {
  const { api } = await freshApi();
  const res = await api.customAmpH({ raw: '<p style="font-size:20px">Hello <b>custom</b> AMP</p>' });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.json.validation.pass, true, 'a plain fragment validates on the deterministic path');
  assert.ok(res.json.compiled.includes('Hello'), 'the fragment is returned');
});

test('customAmpH: an executable script in the paste is stripped from the result', async () => {
  const { api } = await freshApi();
  const res = await api.customAmpH({ raw: '<div><script>steal(document.cookie)</script><p>ok</p></div>' });
  assert.strictEqual(res.status, 200);
  assert.ok(!res.json.compiled.includes('steal('), 'the executable script is removed');
  assert.ok(res.json.compiled.includes('ok'), 'the safe content survives');
});

test('customAmpH: an empty paste is a 400', async () => {
  const { api } = await freshApi();
  assert.strictEqual((await api.customAmpH({ raw: '   ' })).status, 400);
});

// M12: global email settings flow through the render endpoint and echo back
// sanitized, and the rendered AMP carries the overrides.
test('renderDocH: doc.settings render the global overrides and echo sanitized', async () => {
  const { api } = await freshApi();
  const doc = { version: 1, settings: { backgroundColor: '#0a0a12', contentWidth: 560 },
    blocks: [{ id: 'b1', type: 'text', props: { heading: 'Hi', body: 'x' } }] };
  const res = await api.renderDocH({ doc });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.json.validation.pass, true);
  assert.ok(res.json.ampHtml.includes('body{background:#0a0a12;}'), 'global bg applied');
  assert.ok(res.json.ampHtml.includes('.wrap{max-width:560px;}'), 'content width applied');
  assert.deepStrictEqual(res.json.doc.settings, { backgroundColor: '#0a0a12', contentWidth: 560 });
});

test('renderDocH: hostile text still passes and comes back sanitized', async () => {
  const { api } = await freshApi();
  const hostile = {
    brand: { name: 'Groww' },
    blocks: [
      { type: 'header', props: { brandName: 'Groww' } },
      { type: 'text', props: { heading: 'Deal <script>alert(1)</script>', body: 'Body <b>x</b> & co' } },
      { type: 'button', props: { label: 'Go <x>', href: 'https://groww.in' } },
    ],
  };
  const res = await api.renderDocH({ doc: hostile });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.json.validation.pass, true, 'still a valid email');
  const text = res.json.doc.blocks.find((b) => b.type === 'text');
  assert.ok(!/[<>]/.test(text.props.heading), 'heading is stripped of angle brackets in the sanitized doc');
  assert.ok(!/[<>]/.test(text.props.body), 'body is stripped of angle brackets');
  // and the rendered bytes never carry a raw <script>
  assert.ok(!/<script>alert/.test(res.json.ampHtml), 'no raw hostile markup in the rendered AMP');
});

test('renderDocH: a doc whose blocks are all invalid still renders an empty-but-valid email', async () => {
  const { api } = await freshApi();
  const res = await api.renderDocH({ doc: { blocks: [{ type: 'nonsense' }, 42, null] } });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.json.validation.pass, true, 'an empty doc is still a valid AMP document');
  assert.strictEqual(res.json.doc.blocks.length, 0, 'every unknown block was dropped by validateDoc');
});

// ---- createDocExampleH: save a new doc example -------------------------------

test('createDocExampleH: stores an example with module_id doc + doc_json + validation_pass 1, and a working share', async () => {
  const { api, repo, kv } = await freshApi();
  const { pitchId } = await seedPitch(api);
  const res = await api.createDocExampleH({ pitchId, title: 'SIP winback', doc: validStarterDoc(), author: 'dev' });
  assert.strictEqual(res.status, 200);
  const { example, build } = res.json;
  assert.strictEqual(example.module_id, 'doc', 'module_id is doc');
  assert.strictEqual(example.validation_pass, 1, 'validation_pass is 1');
  assert.strictEqual(example.title, 'SIP winback');
  assert.ok(example.doc_json, 'doc_json is persisted');
  const storedDoc = JSON.parse(example.doc_json);
  assert.ok(validateDoc(storedDoc).ok, 'the stored doc round-trips through validateDoc');
  assert.ok(example.amp_html && /^<!doctype html>/.test(example.amp_html), 'amp_html is stored');

  // option (a): a KV share record keyed to the example id
  assert.strictEqual(build.moduleId, 'doc');
  assert.strictEqual(build.sharePath, '/b/' + example.id, 'sharePath points at the example id');
  assert.ok(kv.map.has('build:' + example.id), 'a KV build record exists for the share page');
  const record = await kv.get('build:' + example.id, 'json');
  assert.strictEqual(record.brand, 'Groww', 'the share record carries the brand');
  assert.ok(record.ampHtml && record.ampHtml === example.amp_html, 'the share record holds the same AMP');
  assert.strictEqual(record.validation.pass, true);

  // the example is fetchable in full via the existing handler
  const got = await repo.getExample(example.id);
  assert.strictEqual(got.module_id, 'doc');
});

test('createDocExampleH: an activity entry is logged', async () => {
  const { api } = await freshApi();
  const { pitchId, brandId } = await seedPitch(api);
  await api.createDocExampleH({ pitchId, title: 'Doc A', doc: validStarterDoc(), author: 'dev' });
  const activity = await api.brandActivityH({ brandId });
  assert.strictEqual(activity.status, 200);
  assert.ok(activity.json.items.some((a) => a.verb === 'example-created' && a.detail === 'Doc A'),
    'an example-created activity entry was written');
});

test('createDocExampleH: a doc that fails validation is a 400 with the verdict', async () => {
  const { api } = await freshApi();
  const { pitchId } = await seedPitch(api);
  // Monkey-patch validate on a fresh api to force a failing verdict, proving
  // the gate rejects a non-passing email rather than persisting it.
  const db = createLocalDb(':memory:');
  await db.applyMigrations(MIGRATIONS);
  const repo = bindLocalRepo(db);
  const failing = createPitchApi({
    repo, storage: null, kv: fakeKv(), validate: async () => ({ pass: false, errorCount: 3 }), llmProviders: async () => undefined,
  });
  const brandRes = await failing.createBrandH({ name: 'Groww' });
  const pRes = await failing.createPitchH({ brandId: brandRes.json.brand.id, title: 'P' });
  const res = await failing.createDocExampleH({ pitchId: pRes.json.pitch.id, doc: validStarterDoc() });
  assert.strictEqual(res.status, 400);
  assert.strictEqual(res.json.error, 'the email did not pass AMP validation');
  assert.strictEqual(res.json.validation.pass, false);
  assert.strictEqual(res.json.validation.errorCount, 3);
  assert.ok(pitchId, 'the passing-api pitch exists (control)');
});

test('createDocExampleH: bad pitch id -> 400, unknown pitch -> 404, non-object doc -> 400', async () => {
  const { api } = await freshApi();
  const { pitchId } = await seedPitch(api);
  assert.strictEqual((await api.createDocExampleH({ pitchId: 'BAD', doc: validStarterDoc() })).status, 400);
  assert.strictEqual((await api.createDocExampleH({ pitchId: 'aaaaaa-bbbbbb', doc: validStarterDoc() })).status, 404);
  assert.strictEqual((await api.createDocExampleH({ pitchId, doc: null }).then((r) => r.status)), 400);
});

// ---- updateDocExampleH: edit in place ----------------------------------------

test('updateDocExampleH: re-renders and updates the SAME example in place', async () => {
  const { api, repo, kv } = await freshApi();
  const { pitchId } = await seedPitch(api);
  const created = await api.createDocExampleH({ pitchId, title: 'Editable', doc: validStarterDoc(), author: 'dev' });
  const id = created.json.example.id;
  const originalAmp = created.json.example.amp_html;

  const edited = validStarterDoc();
  edited.blocks[1].props.heading = 'A brand new headline';
  const res = await api.updateDocExampleH({ id, doc: edited, author: 'dev' });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.json.example.id, id, 'same example id — an edit, not a new version');
  assert.ok(res.json.example.amp_html !== originalAmp, 'the AMP changed');
  assert.ok(/A brand new headline/.test(JSON.parse(res.json.example.doc_json).blocks[1].props.heading),
    'the new heading is persisted in doc_json');
  assert.strictEqual(res.json.example.validation_pass, 1);
  assert.strictEqual(res.json.build.sharePath, '/b/' + id, 'the share link is stable across the edit');

  // the row really changed in the repo (only one example exists — no new row)
  const versions = await repo.listVersions(id);
  assert.strictEqual(versions.length, 1, 'still exactly one example in the chain');
  // the KV share record was refreshed to the new AMP
  const record = await kv.get('build:' + id, 'json');
  assert.strictEqual(record.ampHtml, res.json.example.amp_html, 'the share record reflects the edit');
});

test('updateDocExampleH: unknown example -> 404, bad id -> 400, non-object doc -> 400', async () => {
  const { api } = await freshApi();
  const { pitchId } = await seedPitch(api);
  const created = await api.createDocExampleH({ pitchId, doc: validStarterDoc() });
  const id = created.json.example.id;
  assert.strictEqual((await api.updateDocExampleH({ id: 'BAD', doc: validStarterDoc() })).status, 400);
  assert.strictEqual((await api.updateDocExampleH({ id: 'aaaaaa-bbbbbb', doc: validStarterDoc() })).status, 404);
  assert.strictEqual((await api.updateDocExampleH({ id, doc: 'nope' })).status, 400);
});

test('updateDocExampleH: an example-edited activity entry is logged', async () => {
  const { api } = await freshApi();
  const { pitchId, brandId } = await seedPitch(api);
  const created = await api.createDocExampleH({ pitchId, title: 'Logme', doc: validStarterDoc() });
  await api.updateDocExampleH({ id: created.json.example.id, doc: validStarterDoc(), author: 'dev' });
  const activity = await api.brandActivityH({ brandId });
  assert.ok(activity.json.items.some((a) => a.verb === 'example-edited'), 'example-edited was logged');
});

// ---- aiDocH: offline draft -> a valid fallback doc ---------------------------

test('aiDocH: returns a valid doc offline (fallback), NOT saved', async () => {
  const { api, repo } = await freshApi();
  const { pitchId } = await seedPitch(api);
  const res = await api.aiDocH({ pitchId, brief: 'reactivate dormant SIP users', useCase: 'winback' });
  assert.strictEqual(res.status, 200);
  assert.ok(res.json.doc && Array.isArray(res.json.doc.blocks), 'returns a doc');
  assert.ok(validateDoc(res.json.doc).ok, 'the doc is valid');
  // The starting doc always carries the interactive module (that IS the
  // email); interactiveDocForModule bakes the brand header/footer into the
  // module body, so there is no separate 'header' block to assert on.
  assert.ok(res.json.doc.blocks.some((b) => INTERACTIVE_TYPES.has(b.type)), 'the doc carries the interactive module');
  assert.strictEqual(res.json.doc.brand.name, 'Groww', 'the doc is seeded from the pitch brand');
  // NOT saved: the pitch has no examples yet
  const gallery = await repo.latestExamplesPerRoot(pitchId);
  assert.strictEqual(gallery.length, 0, 'aiDoc does not persist — the editor saves later');
});

test('aiDocH: falls back to the pitch brief when no brief is passed', async () => {
  const { api } = await freshApi();
  const { pitchId } = await seedPitch(api);
  const res = await api.aiDocH({ pitchId });
  assert.strictEqual(res.status, 200);
  assert.ok(validateDoc(res.json.doc).ok, 'a valid doc even with no explicit brief');
});

test('aiDocH: bad pitch id -> 400, unknown pitch -> 404', async () => {
  const { api } = await freshApi();
  assert.strictEqual((await api.aiDocH({ pitchId: 'BAD' })).status, 400);
  assert.strictEqual((await api.aiDocH({ pitchId: 'aaaaaa-bbbbbb' })).status, 404);
});

// ---- the render endpoint end-to-end feeds the save endpoint ------------------

test('a doc rendered by renderDocH can be saved by createDocExampleH (editor round-trip)', async () => {
  const { api } = await freshApi();
  const { pitchId } = await seedPitch(api);
  const preview = await api.renderDocH({ doc: validStarterDoc() });
  assert.strictEqual(preview.json.validation.pass, true);
  // the editor saves the same (now sanitized) doc it previewed
  const saved = await api.createDocExampleH({ pitchId, title: 'Round trip', doc: preview.json.doc });
  assert.strictEqual(saved.status, 200);
  assert.strictEqual(saved.json.example.validation_pass, 1);
});
