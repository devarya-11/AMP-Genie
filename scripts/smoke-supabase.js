'use strict';

// Live smoke of server/repo-supabase.js against the real Supabase project:
// one full entity walk (brand -> products -> contact -> pitch -> examples ->
// asset row -> settings -> activity), then cleanup. Run from the repo root:
//   node scripts/smoke-supabase.js
// Exits 0 only if every step passed. Node-only (scripts/ may use dotenv/fs).

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { createSupabaseRepo } = require('../server/repo-supabase');

const SLUG = 'smoketestbrand';
let failures = 0;

function check(name, cond, extra) {
  const ok = !!cond;
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (extra ? '  — ' + extra : ''));
  if (!ok) failures += 1;
  return ok;
}

(async () => {
  const repo = createSupabaseRepo({
    url: process.env.SUPABASE_URL,
    secretKey: process.env.SUPABASE_SECRET_KEY,
  });
  if (!check('createSupabaseRepo', repo)) process.exit(1);

  // cleanup any residue from a previous failed run, then walk
  const stale = await repo.getBrandBySlug(SLUG);
  if (stale) console.log('  (cleaning stale smoke brand from a previous run)');
  const cleanup = async (brandId) => {
    // children first: examples -> pitches -> products/contacts/assets -> brand
    const raw = (p) => fetch(process.env.SUPABASE_URL + '/rest/v1/' + p, {
      method: 'DELETE', headers: { apikey: process.env.SUPABASE_SECRET_KEY },
    });
    await raw('examples?brand_id=eq.' + brandId);
    await raw('pitches?brand_id=eq.' + brandId);
    await raw('products?brand_id=eq.' + brandId);
    await raw('contacts?brand_id=eq.' + brandId);
    await raw('assets?brand_id=eq.' + brandId);
    await raw('activity?brand_id=eq.' + brandId);
    await raw('brands?id=eq.' + brandId);
    await raw('settings?key=eq.smoke_key');
  };
  if (stale) await cleanup(stale.id);

  const brand = await repo.upsertBrand({
    slug: SLUG, name: 'Smoke Test Brand', primaryHex: '#112233', vertical: 'Beauty',
    voiceSample: 'Test voice.', createdBy: 'smoke', dossier: { summary: 'test dossier' },
  });
  check('upsertBrand (insert)', brand && brand.slug === SLUG && brand.primary_hex === '#112233');

  const again = await repo.upsertBrand({ slug: SLUG, name: 'Smoke Test Brand v2' });
  check('upsertBrand (update keeps id, renames)', again && again.id === brand.id && again.name === 'Smoke Test Brand v2');

  const bySlug = await repo.getBrandBySlug(SLUG);
  check('getBrandBySlug', bySlug && bySlug.id === brand.id);

  const products = await repo.replaceProducts(brand.id, [
    { name: 'Serum', price: 899, image: 'https://cdn.example.com/s.jpg' },
    { name: 'Mist', price: 499 },
    { name: '<junk>' , price: -1 }, // name survives cleaning; price dropped
  ]);
  check('replaceProducts', Array.isArray(products) && products.length === 3
    && products[0].name === 'Serum' && products[0].price === 899 && products[1].pos === 1,
  products && products.map((p) => p.name + ':' + p.price).join(','));

  const contact = await repo.addContact(brand.id, { name: 'Priya', role: 'CMO', email: 'priya@example.com' });
  check('addContact', contact && contact.name === 'Priya' && contact.email === 'priya@example.com');

  const updated = await repo.updateContact(contact.id, { email: '', phone: '+91 90000 00000' });
  check('updateContact ("" clears email, sets phone)', updated && updated.email === null && updated.phone === '+91 90000 00000');

  const pitch = await repo.createPitch({
    brandId: brand.id, title: 'Diwali 2026 pitch', goal: 'Retention', createdBy: 'smoke',
  });
  check('createPitch', pitch && pitch.title === 'Diwali 2026 pitch' && pitch.status === 'active');

  const ex1 = await repo.createExample({
    pitchId: pitch.id, title: 'Quiz example', moduleId: 'quiz',
    params: { counter: 0 }, ampHtml: '<!doctype html><html amp4email></html>', validationPass: 1,
    createdBy: 'smoke',
  });
  check('createExample (root)', ex1 && ex1.root_id === ex1.id && ex1.validation_pass === 1);

  const ex2 = await repo.createExample({
    pitchId: pitch.id, title: 'Quiz example v2', moduleId: 'quiz', parentId: ex1.id,
    params: { counter: 0 }, ampHtml: '<!doctype html><html amp4email><!-- v2 --></html>', validationPass: 1,
    tweakPrompt: 'make it 25% off', createdBy: 'smoke',
  });
  check('createExample (tweak child)', ex2 && ex2.parent_id === ex1.id && ex2.root_id === ex1.id);

  const list = await repo.listExamplesForPitch(pitch.id);
  check('listExamplesForPitch (light rows, hasAmp)', list.length === 2
    && list[0].hasAmp === 1 && list[0].amp_html === undefined && list[0].id === ex2.id);

  const versions = await repo.listVersions(ex1.id);
  check('listVersions (oldest first)', versions.length === 2 && versions[0].id === ex1.id);

  const latest = await repo.latestExamplesPerRoot(pitch.id);
  check('latestExamplesPerRoot (chain collapsed to newest)', latest.length === 1 && latest[0].id === ex2.id);

  const asset = await repo.insertAsset({
    brandId: brand.id, filename: 'logo.png', mime: 'image/png', size: 1234,
    storageKey: SLUG + '/x-logo.png', uploadedBy: 'smoke',
  });
  check('insertAsset', asset && asset.filename === 'logo.png');

  const brandsList = await repo.listBrands();
  const mine = brandsList.find((b) => b.slug === SLUG);
  check('listBrands counts', mine && mine.pitchCount === 1 && mine.exampleCount === 2 && mine.assetCount === 1,
    mine && `pitches=${mine.pitchCount} examples=${mine.exampleCount} assets=${mine.assetCount}`);

  check('putSetting', await repo.putSetting('smoke_key', { hello: 'world' }));
  check('putSetting (upsert same key)', await repo.putSetting('smoke_key', { hello: 'again' }));
  const setting = await repo.getSetting('smoke_key');
  check('getSetting roundtrip', setting && setting.hello === 'again');

  check('logActivity', await repo.logActivity({ actor: 'smoke', brandId: brand.id, pitchId: pitch.id, verb: 'smoke-test' }));
  const activity = await repo.listActivity({ brandId: brand.id, limit: 10 });
  check('listActivity', activity.length >= 1 && activity[0].verb === 'smoke-test');

  const pitches = await repo.listAllPitches();
  const p = pitches.find((x) => x.id === pitch.id);
  check('listAllPitches (brand joined)', p && p.brandSlug === SLUG && p.exampleCount === 2);

  await cleanup(brand.id);
  const gone = await repo.getBrandBySlug(SLUG);
  check('cleanup', gone === null);

  console.log(failures ? `\n${failures} FAILURES` : '\nALL PASS');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('SMOKE CRASH:', e); process.exit(1); });
