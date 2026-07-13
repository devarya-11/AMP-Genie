'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { createLocalDb, MIGRATIONS, splitStatements } = require('../server/db');
const repo = require('../server/repo');

// Every test runs against a throwaway ':memory:' node:sqlite database with
// the real 0001 migration applied — the same SQL D1 will run in production,
// so what passes here is the schema, not a mock of it.
async function freshDb() {
  const db = createLocalDb(':memory:');
  await db.applyMigrations();
  return db;
}

async function seedBrand(db, overrides = {}) {
  return repo.upsertBrand(db, {
    name: 'Taj Hotels', primaryHex: '#1c3f4a', accentHex: '#b08d4c',
    vertical: 'Food', site: 'https://www.tajhotels.com', createdBy: 'hriday',
    ...overrides,
  });
}

// ---- environment: node:sqlite --------------------------------------------------

test('node:sqlite is available on this Node with no flag (DatabaseSync)', () => {
  // Verified on Node v24.16.0 (darwin): require('node:sqlite') resolves with
  // no --experimental flag needed (node:sqlite is unflagged since 22.13/23.4;
  // it is still marked Stability 1.1 upstream, which is why createLocalDb
  // requires it lazily and the Workers bundle never sees it).
  const sqlite = require('node:sqlite');
  assert.strictEqual(typeof sqlite.DatabaseSync, 'function');
  const major = Number(process.versions.node.split('.')[0]);
  assert.ok(major >= 22, 'node:sqlite needs Node >= 22.5; found ' + process.version);
});

// ---- migrations -----------------------------------------------------------------

test('server/migrations.js is a byte-identical mirror of migrations/0001_init.sql', () => {
  const onDisk = fs.readFileSync(
    path.join(__dirname, '..', 'migrations', '0001_init.sql'), 'utf8');
  assert.strictEqual(MIGRATIONS.length, 1);
  assert.strictEqual(MIGRATIONS[0].name, '0001_init');
  assert.strictEqual(MIGRATIONS[0].sql, onDisk,
    'the embedded copy drifted from the .sql — regenerate server/migrations.js (edit BOTH files together)');
});

test('splitStatements: end-of-line semicolons split, comment-only pieces dropped', () => {
  const stmts = splitStatements('-- header\nCREATE TABLE a (x TEXT);\n\n-- note\nCREATE TABLE b (y TEXT);\n');
  assert.strictEqual(stmts.length, 2);
  assert.ok(stmts[0].includes('CREATE TABLE a'));
  assert.ok(stmts[1].includes('CREATE TABLE b'), 'a comment between statements attaches forward, never splits');
  assert.deepStrictEqual(splitStatements('-- only comments\n  \n'), []);
  assert.deepStrictEqual(splitStatements(null), []);
  assert.strictEqual(splitStatements(MIGRATIONS[0].sql).length, 17,
    '0001_init carries 8 CREATE TABLE + 9 CREATE INDEX statements');
});

test('applyMigrations applies 0001 once; a second run is a clean no-op', async () => {
  const db = createLocalDb(':memory:');
  assert.deepStrictEqual(await db.applyMigrations(), ['0001_init']);
  assert.deepStrictEqual(await db.applyMigrations(), [],
    'twice must apply nothing and must not throw');
  const names = (await db.all("SELECT name FROM sqlite_master WHERE type = 'table'"))
    .map((t) => t.name);
  for (const t of ['_migrations', 'brands', 'products', 'contacts', 'pitches',
    'examples', 'assets', 'settings', 'activity']) {
    assert.ok(names.includes(t), t + ' table must exist after migration');
  }
  const ledger = await db.all('SELECT name FROM _migrations');
  assert.strictEqual(ledger.length, 1, 'the ledger records 0001 exactly once');
  db.close();
});

// ---- db surface -----------------------------------------------------------------

test('local db: first() misses as null, params normalise (boolean/undefined), batch is atomic', async () => {
  const db = await freshDb();
  assert.strictEqual(await db.first('SELECT * FROM brands WHERE slug = ?', ['nope']), null);
  const row = await db.first('SELECT ? AS a, ? AS b, ? AS c', [true, false, undefined]);
  assert.deepStrictEqual(row, { a: 1, b: 0, c: null },
    'booleans bind as 1/0 and undefined as NULL on both backends');
  await assert.rejects(db.batch([
    { sql: 'INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)', params: ['k1', '1', 'now'] },
    { sql: 'INSERT INTO no_such_table (x) VALUES (?)', params: [1] },
  ]), 'a bad statement must reject the whole batch');
  assert.strictEqual(await db.first('SELECT * FROM settings WHERE key = ?', ['k1']), null,
    'a failed batch must leave NOTHING behind (rolled back)');
  db.close();
});

// ---- the full walk: brand -> pitch -> example chain -> asset -> activity ---------

test('full CRUD walk across the Genie 2.0 model', async () => {
  const db = await freshDb();

  // brand: create, fetch both ways, upsert-update keeps the id
  const brand = await seedBrand(db);
  assert.ok(brand, 'brand must be created');
  assert.strictEqual(brand.slug, 'tajhotels', 'slug derives from the name via brandSlug');
  assert.strictEqual(brand.primary_hex, '#1c3f4a');
  assert.match(brand.created_at, /^\d{4}-\d{2}-\d{2}T/, 'ISO-8601 timestamps');
  assert.deepStrictEqual(await repo.getBrandBySlug(db, 'tajhotels'),
    await repo.getBrandById(db, brand.id));
  const again = await repo.upsertBrand(db, { slug: 'tajhotels', voiceSample: 'Warm, unhurried luxury.' });
  assert.strictEqual(again.id, brand.id, 'upsert on an existing slug updates, never duplicates');
  assert.strictEqual(again.voice_sample, 'Warm, unhurried luxury.');
  assert.strictEqual(again.name, 'Taj Hotels', 'fields absent from the upsert keep their value');

  // kit fields: '' clears, invalid drops
  const withHero = await repo.setBrandKitFields(db, brand.id,
    { heroUrl: 'https://www.tajhotels.com/rooms.jpg', logoUrl: 'notaurl' });
  assert.strictEqual(withHero.hero_url, 'https://www.tajhotels.com/rooms.jpg');
  assert.strictEqual(withHero.logo_url, null, 'an invalid url is dropped, not stored');
  const cleared = await repo.setBrandKitFields(db, brand.id, { heroUrl: '' });
  assert.strictEqual(cleared.hero_url, null, "'' must clear the column to NULL");

  // products: whole-list replace, ordered, junk dropped
  const products = await repo.replaceProducts(db, brand.id, [
    { name: 'Palace Suite', price: 45000, image: 'https://cdn.tajhotels.com/suite.jpg' },
    { price: 10 },   // nameless -> dropped
    { name: 'High Tea', price: '1200' },
  ]);
  assert.strictEqual(products.length, 2);
  assert.deepStrictEqual(products.map((p) => [p.name, p.price, p.pos]),
    [['Palace Suite', 45000, 0], ['High Tea', 1200, 1]]);
  const replaced = await repo.replaceProducts(db, brand.id, [{ name: 'Only One' }]);
  assert.strictEqual(replaced.length, 1, 'replace means REPLACE — the old list is gone');
  assert.strictEqual((await repo.listProducts(db, brand.id)).length, 1);

  // contact
  const contact = await repo.addContact(db, brand.id,
    { name: 'Priya Rao', role: 'CMO', email: 'priya@tajhotels.com', phone: '+91 98x' });
  assert.ok(contact);
  assert.strictEqual(contact.email, 'priya@tajhotels.com');

  // pitch
  const pitch = await repo.createPitch(db, {
    brandId: brand.id, title: 'Monsoon staycation push', goal: 'bookings', createdBy: 'hriday',
  });
  assert.ok(pitch);
  assert.strictEqual(pitch.status, 'active');
  assert.strictEqual((await repo.listPitchesForBrand(db, brand.id))[0].exampleCount, 0);

  // examples: fresh root, then a two-tweak version chain
  const e1 = await repo.createExample(db, {
    pitchId: pitch.id, title: 'Price-drop reveal', moduleId: 'reveal',
    params: { discount: 20 }, doc: { blocks: [] }, ampHtml: '<html amp4email>v1</html>',
    validationPass: true, createdBy: 'hriday',
  });
  assert.strictEqual(e1.root_id, e1.id, 'a fresh example roots its own chain');
  assert.strictEqual(e1.brand_id, brand.id, 'brand_id is stamped from the pitch');
  assert.strictEqual(e1.validation_pass, 1);
  assert.deepStrictEqual(JSON.parse(e1.params_json), { discount: 20 });
  const e2 = await repo.createExample(db, {
    pitchId: pitch.id, parentId: e1.id, tweakPrompt: 'make it 25% off',
    params: { discount: 25 }, ampHtml: '<html amp4email>v2</html>', validationPass: true,
  });
  const e3 = await repo.createExample(db, {
    pitchId: pitch.id, parentId: e2.id, tweakPrompt: 'more premium',
  });
  assert.strictEqual(e2.parent_id, e1.id);
  assert.strictEqual(e2.root_id, e1.id, 'a tweak inherits the root');
  assert.strictEqual(e3.root_id, e1.id, 'the root survives a chain of tweaks');

  const versions = await repo.listVersions(db, e1.id);
  assert.deepStrictEqual(versions.map((v) => v.id), [e1.id, e2.id, e3.id],
    'versions list oldest -> newest, rowid breaking same-millisecond ties');
  assert.ok(!('amp_html' in versions[0]) && !('doc_json' in versions[0]),
    'list rows must exclude the heavy columns');
  assert.deepStrictEqual(versions.map((v) => v.hasAmp), [1, 1, 0]);

  const list = await repo.listExamplesForPitch(db, pitch.id);
  assert.deepStrictEqual(list.map((v) => v.id), [e3.id, e2.id, e1.id], 'pitch list is newest first');
  const latest = await repo.latestExamplesPerRoot(db, pitch.id);
  assert.deepStrictEqual(latest.map((v) => v.id), [e3.id],
    'one row per chain: tweaks collapse to the latest version');
  assert.strictEqual((await repo.getExample(db, e2.id)).amp_html, '<html amp4email>v2</html>',
    'getExample returns the full row, amp included');

  // asset row (bytes live behind the storage interface; this is the metadata)
  const asset = await repo.insertAsset(db, {
    brandId: brand.id, filename: 'hero.jpg', mime: 'image/jpeg', size: 48213,
    storageKey: 'asset:' + brand.id + ':hero', uploadedBy: 'hriday',
  });
  assert.ok(asset);
  assert.strictEqual(asset.kind, 'image', "kind defaults to 'image'");
  assert.strictEqual((await repo.listAssets(db, brand.id)).length, 1);

  // activity
  assert.strictEqual(await repo.logActivity(db,
    { actor: 'hriday', brandId: brand.id, pitchId: pitch.id, verb: 'built', detail: 'v1 of the reveal' }), true);
  const feed = await repo.listActivity(db, { brandId: brand.id, limit: 10 });
  assert.strictEqual(feed.length, 1);
  assert.strictEqual(feed[0].verb, 'built');
  db.close();
});

// ---- listBrands counters ----------------------------------------------------------

test('listBrands carries correct per-brand counters and lastActivityAt', async () => {
  const db = await freshDb();
  const taj = await seedBrand(db);
  const acme = await seedBrand(db, { name: 'Acme', slug: 'acme' });
  const p1 = await repo.createPitch(db, { brandId: taj.id, title: 'Pitch one' });
  const p2 = await repo.createPitch(db, { brandId: taj.id, title: 'Pitch two' });
  await repo.createExample(db, { pitchId: p1.id, title: 'a' });
  await repo.createExample(db, { pitchId: p1.id, title: 'b' });
  await repo.createExample(db, { pitchId: p2.id, title: 'c' });
  await repo.insertAsset(db, {
    brandId: taj.id, filename: 'x.png', mime: 'image/png', size: 10, storageKey: 'k1',
  });
  await repo.logActivity(db, { brandId: taj.id, verb: 'built' });

  const rows = await repo.listBrands(db);
  assert.strictEqual(rows.length, 2);
  const tajRow = rows.find((r) => r.slug === 'tajhotels');
  const acmeRow = rows.find((r) => r.slug === 'acme');
  assert.deepStrictEqual(
    [tajRow.pitchCount, tajRow.exampleCount, tajRow.assetCount],
    [2, 3, 1]);
  assert.match(tajRow.lastActivityAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepStrictEqual(
    [acmeRow.pitchCount, acmeRow.exampleCount, acmeRow.assetCount, acmeRow.lastActivityAt],
    [0, 0, 0, null], 'a quiet brand counts zeros, not phantom rows');
  assert.ok(!('dossier_json' in tajRow), 'list rows must not ship the dossier');
  assert.ok(acme, 'second brand seeded');
  db.close();
});

// ---- hostile input ---------------------------------------------------------------

test('hostile strings are stripped or refused at every write path', async () => {
  const db = await freshDb();
  const brand = await repo.upsertBrand(db, {
    name: '<script>alert(1)</script>Acme', site: 'javascript:alert(1)',
  });
  assert.ok(!/[<>]/.test(brand.name), 'no angle bracket may reach a brand name');
  assert.strictEqual(brand.site, null, 'a javascript: url must never be stored');

  const pitch = await repo.createPitch(db, { brandId: brand.id, title: '<img onerror=x> Launch' });
  assert.strictEqual(pitch.title, 'img onerror=x Launch');

  const example = await repo.createExample(db, {
    pitchId: pitch.id, tweakPrompt: 'make it <blink>pop</blink>', moduleId: 'reveal',
  });
  assert.ok(!/[<>]/.test(example.tweak_prompt));

  const contact = await repo.addContact(db, brand.id, {
    name: 'Evil <b>Bob</b>', email: 'not-an-email', notes: '<script>x</script>',
  });
  assert.strictEqual(contact.name, 'Evil bBob/b');
  assert.strictEqual(contact.email, null, 'an invalid email is dropped, the contact survives');
  assert.ok(!/[<>]/.test(contact.notes));

  const products = await repo.replaceProducts(db, brand.id, [
    { name: 'Fine', image: 'javascript:alert(1)' },
    { name: 'Data', image: 'data:text/html,x' },
  ]);
  assert.deepStrictEqual(products.map((p) => p.image_url), [null, null],
    'non-http(s) product images are dropped, rows kept');

  await repo.logActivity(db, { verb: '<hack>built', detail: 'a <b>bold</b> move' });
  const feed = await repo.listActivity(db, {});
  assert.ok(!/[<>]/.test(feed[0].verb + feed[0].detail));

  assert.strictEqual(await repo.getBrandBySlug(db, '../etc'), null, 'hostile slug refused before SQL');
  assert.strictEqual(await repo.getPitch(db, "1 OR '1'='1"), null, 'hostile id refused before SQL');
  db.close();
});

// ---- contacts: update semantics ---------------------------------------------------

test("updateContact: '' clears role, invalid email keeps the saved one, delete deletes", async () => {
  const db = await freshDb();
  const brand = await seedBrand(db);
  const contact = await repo.addContact(db, brand.id,
    { name: 'Priya Rao', role: 'CMO', email: 'priya@tajhotels.com' });
  const updated = await repo.updateContact(db, contact.id, { role: '', email: 'oops' });
  assert.strictEqual(updated.role, null, "'' clears");
  assert.strictEqual(updated.email, 'priya@tajhotels.com', 'a typo email must not wipe the saved one');
  assert.strictEqual(await repo.updateContact(db, contact.id, { name: '' }), null,
    'a contact can never lose its name');
  assert.strictEqual((await repo.listContacts(db, brand.id)).length, 1);
  assert.strictEqual(await repo.deleteContact(db, contact.id), true);
  assert.strictEqual(await repo.deleteContact(db, contact.id), false, 'second delete finds nothing');
  assert.strictEqual((await repo.listContacts(db, brand.id)).length, 0);
  db.close();
});

// ---- pitches: status lifecycle ----------------------------------------------------

test('archivePitch flips status; junk statuses and empty patches change nothing', async () => {
  const db = await freshDb();
  const brand = await seedBrand(db);
  const pitch = await repo.createPitch(db, { brandId: brand.id, title: 'Launch' });
  const archived = await repo.archivePitch(db, pitch.id);
  assert.strictEqual(archived.status, 'archived');
  assert.strictEqual(await repo.updatePitch(db, pitch.id, { status: 'exploded' }), null,
    'an unknown status is dropped; with nothing left the update is refused');
  assert.strictEqual((await repo.getPitch(db, pitch.id)).status, 'archived');

  const all = await repo.listAllPitches(db);
  assert.strictEqual(all.length, 1);
  assert.strictEqual(all[0].brandSlug, 'tajhotels', 'cross-brand list joins the brand in');
  assert.strictEqual(all[0].exampleCount, 0);
  db.close();
});

// ---- settings ---------------------------------------------------------------------

test('settings: JSON roundtrip, overwrite, bad keys and unserialisable values refused', async () => {
  const db = await freshDb();
  const pool = { keys: [{ provider: 'gemini', key: 'AQ.x' }, { provider: 'groq', key: 'gsk_y' }] };
  assert.strictEqual(await repo.putSetting(db, 'llm:pool', pool), true);
  assert.deepStrictEqual(await repo.getSetting(db, 'llm:pool'), pool);
  assert.strictEqual(await repo.putSetting(db, 'llm:pool', { keys: [] }), true);
  assert.deepStrictEqual(await repo.getSetting(db, 'llm:pool'), { keys: [] },
    'putSetting on an existing key overwrites');
  assert.strictEqual(await repo.putSetting(db, 'flag', false), true);
  assert.strictEqual(await repo.getSetting(db, 'flag'), false, 'falsy values roundtrip');
  assert.strictEqual(await repo.getSetting(db, 'missing'), null);
  assert.strictEqual(await repo.putSetting(db, '../etc', 1), false, 'hostile key refused');
  assert.strictEqual(await repo.putSetting(db, 'has space', 1), false);
  assert.strictEqual(await repo.putSetting(db, 'fn', undefined), false,
    'undefined does not serialise — refused, not stored as garbage');
  db.close();
});

// ---- activity: best-effort contract ------------------------------------------------

test('logActivity never throws: null db, missing verb, dangling ids all degrade to false/null-fields', async () => {
  const db = await freshDb();
  assert.strictEqual(await repo.logActivity(null, { verb: 'built' }), false);
  assert.strictEqual(await repo.logActivity(db, {}), false, 'no verb, no entry');
  assert.strictEqual(await repo.logActivity(db, { verb: 'built', brandId: '../etc' }), true,
    'a junk brand id logs the event with brand_id NULL rather than failing it');
  const feed = await repo.listActivity(db, { limit: 5 });
  assert.strictEqual(feed.length, 1);
  assert.strictEqual(feed[0].brand_id, null);
  assert.deepStrictEqual(await repo.listActivity(db, { brandId: '../etc' }), [],
    'a hostile brand filter reads as empty, never as SQL');
  db.close();
});
