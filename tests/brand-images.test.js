'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { createLocalDb } = require('../server/db');
const repo = require('../server/repo');

// brand_images DAOs against a real :memory: node:sqlite db with the true
// 0001 + 0002 migrations applied — the same SQL D1 runs in production, so what
// passes here is the schema, not a mock of it.
async function freshDb() {
  const db = createLocalDb(':memory:');
  await db.applyMigrations();
  return db;
}

async function seedBrand(db) {
  return repo.upsertBrand(db, {
    name: 'Taj Hotels', primaryHex: '#1c3f4a', vertical: 'Food',
    site: 'https://www.tajhotels.com', createdBy: 'hriday',
  });
}

const HERO = 'https://cdn.brand.example/hero.jpg';
const PROD = 'https://cdn.brand.example/serum.png';

// ---- cleanBrandImageRow: the sanitiser -----------------------------------------

test('cleanBrandImageRow requires an http(s) url and files unknown kind/source under the safe default', () => {
  const { cleanBrandImageRow } = repo._pure;
  // a good manual hero
  assert.deepStrictEqual(
    cleanBrandImageRow({ url: HERO, kind: 'hero', alt: 'Front lobby' }),
    { url: HERO, kind: 'hero', source: 'manual', alt: 'Front lobby' });
  // kind/source off the allowlist fall back to the column defaults — a typo
  // files the picture under 'other'/'manual', it never drops the row
  assert.deepStrictEqual(
    cleanBrandImageRow({ url: HERO, kind: 'banner', source: 'ftp' }),
    { url: HERO, kind: 'other', source: 'manual', alt: null });
  // an 'image' alias for the url plus an explicit upload source
  assert.deepStrictEqual(
    cleanBrandImageRow({ image: PROD, kind: 'product', source: 'upload' }),
    { url: PROD, kind: 'product', source: 'upload', alt: null });
  // rejections: no url, non-http url, non-object
  assert.strictEqual(cleanBrandImageRow({ kind: 'hero' }), null);
  assert.strictEqual(cleanBrandImageRow({ url: 'ftp://x/y.jpg' }), null);
  assert.strictEqual(cleanBrandImageRow({ url: 'not a url' }), null);
  assert.strictEqual(cleanBrandImageRow(null), null);
  // alt is stripped of angle brackets and capped
  const row = cleanBrandImageRow({ url: HERO, alt: '<b>' + 'x'.repeat(500) });
  assert.ok(row.alt.length <= 200, 'alt capped at 200');
  assert.ok(!row.alt.includes('<'), 'angle brackets stripped from alt');
});

// ---- CRUD walk -----------------------------------------------------------------

test('replaceBrandImages: whole-list, ordered, junk dropped; listBrandImages reads them back', async () => {
  const db = await freshDb();
  const brand = await seedBrand(db);
  const posted = [
    { url: HERO, kind: 'hero', alt: 'Lobby' },
    { url: 'nope' },                                  // junk -> dropped
    { url: PROD, kind: 'product' },
    { image: 'https://cdn.brand.example/x.jpg', kind: 'other' },
  ];
  const stored = await repo.replaceBrandImages(db, brand.id, posted);
  assert.strictEqual(stored.length, 3, 'the junk row is dropped, the three valid ones kept');
  assert.deepStrictEqual(stored.map((r) => r.kind), ['hero', 'product', 'other']);
  assert.deepStrictEqual(stored.map((r) => r.pos), [0, 1, 2], 'pos follows post order after the junk filter');
  assert.strictEqual(stored[0].url, HERO);
  assert.strictEqual(stored[0].source, 'manual');
  // read back independently
  const listed = await repo.listBrandImages(db, brand.id);
  assert.deepStrictEqual(
    listed.map((r) => r.url),
    [HERO, PROD, 'https://cdn.brand.example/x.jpg']);
  // replace again with fewer -> whole-list semantics, the old set is gone
  const fewer = await repo.replaceBrandImages(db, brand.id, [{ url: HERO, kind: 'hero' }]);
  assert.strictEqual(fewer.length, 1);
  db.close();
});

test('replaceBrandImages caps at BRAND_IMAGES_MAX after the junk filter; unknown brand is null', async () => {
  const db = await freshDb();
  const brand = await seedBrand(db);
  const posted = [];
  for (let i = 0; i < 40; i++) posted.push({ url: 'https://cdn.brand.example/p' + i + '.jpg' });
  const stored = await repo.replaceBrandImages(db, brand.id, posted);
  assert.strictEqual(stored.length, repo._pure.BRAND_IMAGES_MAX);
  assert.strictEqual(await repo.replaceBrandImages(db, 'ghostbrand', [{ url: HERO }]), null);
  db.close();
});

test('addBrandImage appends at the tail; deleteBrandImage removes one; a full library refuses more', async () => {
  const db = await freshDb();
  const brand = await seedBrand(db);
  const a = await repo.addBrandImage(db, brand.id, { url: HERO, kind: 'hero' });
  assert.strictEqual(a.pos, 0);
  const b = await repo.addBrandImage(db, brand.id, { url: PROD, kind: 'product' });
  assert.strictEqual(b.pos, 1, 'the second append lands after the first');
  assert.strictEqual((await repo.listBrandImages(db, brand.id)).length, 2);
  // delete the first, only the second survives
  assert.strictEqual(await repo.deleteBrandImage(db, a.id), true);
  assert.deepStrictEqual((await repo.listBrandImages(db, brand.id)).map((r) => r.id), [b.id]);
  assert.strictEqual(await repo.deleteBrandImage(db, 'ghostimage'), false);
  // a junk row and an unknown brand are null, never a throw
  assert.strictEqual(await repo.addBrandImage(db, brand.id, { url: 'nope' }), null);
  assert.strictEqual(await repo.addBrandImage(db, 'ghostbrand', { url: HERO }), null);
  // fill to the cap, then the next append is refused
  const full = [];
  for (let i = 0; i < repo._pure.BRAND_IMAGES_MAX; i++) full.push({ url: 'https://cdn.brand.example/f' + i + '.jpg' });
  await repo.replaceBrandImages(db, brand.id, full);
  assert.strictEqual(await repo.addBrandImage(db, brand.id, { url: HERO }), null,
    'a full library refuses a new add rather than silently dropping');
  db.close();
});

// ---- the image ladder's safety net ---------------------------------------------

test('listBrandImages degrades to [] when the table is missing and on a bad id, never throwing', async () => {
  // a db with NO migrations applied has no brand_images table at all — this is
  // the "code deployed ahead of the remote migration" case the ladder rides on
  const bare = createLocalDb(':memory:');
  assert.deepStrictEqual(await repo.listBrandImages(bare, 'abcdef'), [],
    'a missing brand_images table reads as empty so the image ladder never crashes');
  bare.close();
  const db = await freshDb();
  assert.deepStrictEqual(await repo.listBrandImages(db, 'BAD ID'), []);
  assert.deepStrictEqual(await repo.listBrandImages(db, ''), []);
  db.close();
});
