'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  newId, brandSlug,
  getBuild, putBuild, getSlate, putSlate, getBrandKit, putBrandKit,
} = require('../server/store');
const { createFsKv, DATA_DIR } = require('../server/store-fs');

// In-memory stand-in for the Cloudflare KV binding: same { get(key, type),
// put(key, value) } subset store.js targets, Map-backed so tests can also
// assert which keys were (or were not) touched.
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
// A kv where any access is a test failure — for inputs that must be rejected
// before the store is ever consulted.
function tripwireKv() {
  return {
    get() { throw new Error('kv.get must not be reached for a rejected input'); },
    put() { throw new Error('kv.put must not be reached for a rejected input'); },
  };
}
function sampleKit(overrides = {}) {
  return {
    slug: 'tajhotels', name: 'Taj Hotels', primary: '#1c3f4a', accent: '#b08d4c',
    vertical: 'Food', logoUrl: 'https://www.tajhotels.com/hero.jpg',
    site: 'https://www.tajhotels.com', source: 'library',
    updatedAt: '2026-07-10T00:00:00.000Z', ...overrides,
  };
}

// ---- newId / brandSlug ------------------------------------------------------

test('newId yields 12-char lowercase hex ids, unique across 100 draws', () => {
  const ids = new Set();
  for (let i = 0; i < 100; i++) {
    const id = newId();
    assert.match(id, /^[a-f0-9]{12}$/);
    ids.add(id);
  }
  assert.strictEqual(ids.size, 100, 'ids must not collide within a session');
});

test('brandSlug mirrors the brand library normalisation (lowercase, [a-z0-9] only)', () => {
  assert.strictEqual(brandSlug('Taj Hotels'), 'tajhotels');
  assert.strictEqual(brandSlug('  ICICI Prudential! '), 'iciciprudential');
  assert.strictEqual(brandSlug(''), '');
  assert.strictEqual(brandSlug(null), '');
});

// ---- put/get round-trips against the fake kv --------------------------------

test('putBuild/getBuild round-trip under the build: key', async () => {
  const kv = fakeKv();
  const build = { id: newId(), brand: 'Acme', html: '<div>x</div>' };
  assert.strictEqual(await putBuild(kv, build), true);
  assert.ok(kv.map.has('build:' + build.id), 'must be stored under the build: prefix');
  assert.deepStrictEqual(await getBuild(kv, build.id), build);
});

test('putSlate/getSlate round-trip under the slate: key', async () => {
  const kv = fakeKv();
  const slate = { id: newId(), builds: [newId(), newId()] };
  assert.strictEqual(await putSlate(kv, slate), true);
  assert.ok(kv.map.has('slate:' + slate.id), 'must be stored under the slate: prefix');
  assert.deepStrictEqual(await getSlate(kv, slate.id), slate);
});

test('putBrandKit/getBrandKit round-trip under the brandkit: key', async () => {
  const kv = fakeKv();
  const kit = sampleKit();
  assert.strictEqual(await putBrandKit(kv, kit), true);
  assert.ok(kv.map.has('brandkit:' + kit.slug), 'must be stored under the brandkit: prefix');
  assert.deepStrictEqual(await getBrandKit(kv, kit.slug), kit);
});

// ---- rejection paths ---------------------------------------------------------

test('getBuild refuses a hostile id without ever touching the kv', async () => {
  assert.strictEqual(await getBuild(tripwireKv(), '../etc'), null);
  assert.strictEqual(await getBuild(tripwireKv(), 'build:x/../../y'), null);
  assert.strictEqual(await getBuild(tripwireKv(), 'ABCDEF'), null, 'uppercase is outside the id shape');
  assert.strictEqual(await getBuild(tripwireKv(), 'abc'), null, 'shorter than 6 chars is outside the id shape');
  assert.strictEqual(await getBuild(tripwireKv(), ''), null);
});

test('putBrandKit rejects a kit whose primary is not a #rrggbb hex', async () => {
  assert.strictEqual(await putBrandKit(tripwireKv(), sampleKit({ primary: 'red' })), false);
  assert.strictEqual(await putBrandKit(tripwireKv(), sampleKit({ primary: '#ff00' })), false);
  assert.strictEqual(await putBrandKit(tripwireKv(), sampleKit({ primary: '#ff00gg' })), false);
  assert.strictEqual(await putBrandKit(tripwireKv(), sampleKit({ primary: undefined })), false);
});

test('every put* returns false and every get* returns null when kv is falsy', async () => {
  const build = { id: newId() };
  assert.strictEqual(await putBuild(null, build), false);
  assert.strictEqual(await putSlate(null, { id: newId() }), false);
  assert.strictEqual(await putBrandKit(null, sampleKit()), false);
  assert.strictEqual(await getBuild(null, build.id), null);
  assert.strictEqual(await getSlate(null, newId()), null);
  assert.strictEqual(await getBrandKit(null, 'tajhotels'), null);
});

// ---- store-fs: the filesystem shim -------------------------------------------

test('createFsKv round-trips a build and a brand kit through store.js, lazily creating the dir', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'amp-genie-store-'));
  const kv = createFsKv(path.join(root, 'nested', DATA_DIR));
  const build = { id: newId(), brand: 'Acme' };
  const kit = sampleKit();
  assert.strictEqual(await putBuild(kv, build), true);
  assert.strictEqual(await putBrandKit(kv, kit), true);
  assert.deepStrictEqual(await getBuild(kv, build.id), build);
  assert.deepStrictEqual(await getBrandKit(kv, kit.slug), kit);
});

test('createFsKv returns null for a missing key and for a corrupted file on disk', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amp-genie-store-'));
  const kv = createFsKv(dir);
  const build = { id: newId(), brand: 'Acme' };
  assert.strictEqual(await getBuild(kv, build.id), null, 'nothing written yet');
  assert.strictEqual(await putBuild(kv, build), true);
  const [file] = fs.readdirSync(dir);
  fs.writeFileSync(path.join(dir, file), 'not json {{');
  assert.strictEqual(await getBuild(kv, build.id), null, 'a corrupt file must read as a miss, not a throw');
});

test('createFsKv maps ":"-prefixed keys to distinct, filesystem-safe filenames', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amp-genie-store-'));
  const kv = createFsKv(dir);
  const id = newId();
  assert.strictEqual(await putBuild(kv, { id, kind: 'build' }), true);
  assert.strictEqual(await putSlate(kv, { id, kind: 'slate' }), true);
  const files = fs.readdirSync(dir);
  assert.strictEqual(files.length, 2, 'same id under build: and slate: must not collide on disk');
  for (const f of files) assert.match(f, /^[a-z0-9_-]+\.json$/, 'filenames must stay within the safe alphabet');
  assert.strictEqual((await getBuild(kv, id)).kind, 'build');
  assert.strictEqual((await getSlate(kv, id)).kind, 'slate');
});

test('DATA_DIR suggests the git-ignored .data default', () => {
  assert.strictEqual(DATA_DIR, '.data');
});
