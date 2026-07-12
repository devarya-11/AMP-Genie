'use strict';
const { test } = require('node:test');
const assert = require('node:assert');

// Deterministic defaults (same discipline as tests/brief-content.test.js):
// nothing in this suite touches a provider, but make sure no ambient key can
// ever activate one if these fixtures grow.
delete process.env.GEMINI_API_KEY;
delete process.env.GROQ_API_KEY;
delete process.env.OLLAMA_BASE_URL;

const { generate, MODULE_IDS } = require('../server/generate');
const { validate } = require('../server/validator');
const { buildFallback } = require('../server/fallback');

const HERO = 'https://cdn.acme.com/hero-banner.jpg';
// The & in the query string proves image srcs land entity-encoded, never raw
// and never truncated.
const IMG_A = 'https://cdn.acme.com/espresso.jpg?v=2&w=600';
const IMG_B = 'https://cdn.acme.com/tumbler.png';

const IMAGED_ITEMS = [
  { name: 'Espresso Kit', price: 4799, image: IMG_A },
  { name: 'Steel Tumbler', image: IMG_B },
];
const MIXED_ITEMS = IMAGED_ITEMS.concat([{ name: 'Filter Papers', price: 249 }]);

function gen(moduleId, copy) {
  return generate({ brand: 'Acme', vertical: 'Generic', tone: 'Playful', currency: 'INR', counter: 0, moduleId, copy });
}

// ---- item tiles: real product images ----------------------------------------

test('reveal: real item images become the tile amp-img srcs, entity-encoded', () => {
  const g = gen('reveal', { items: IMAGED_ITEMS });
  assert.ok(g.ampHtml.includes('src="https://cdn.acme.com/espresso.jpg?v=2&amp;w=600"'), 'query & is entity-encoded in the src');
  assert.ok(g.ampHtml.includes(`src="${IMG_B}"`), 'plain https src lands verbatim');
  assert.ok(!g.ampHtml.includes('placehold.co/300x200'), 'no synthetic tile placeholder remains when every item has a real image');
  const byName = Object.fromEntries(g.previewModel.items.map((it) => [it.name, it]));
  assert.strictEqual(byName['Espresso Kit'].image, IMG_A, 'previewModel carries the raw (unencoded) image URL');
  assert.strictEqual(byName['Steel Tumbler'].image, IMG_B);
});

test('search: imaged tiles use the real src, the rest keep placeholders; filter bindings untouched', () => {
  const g = gen('search', { items: MIXED_ITEMS });
  assert.ok(g.ampHtml.includes('src="https://cdn.acme.com/espresso.jpg?v=2&amp;w=600"'), 'real image renders entity-encoded');
  assert.ok(g.ampHtml.includes(`src="${IMG_B}"`), 'second real image renders');
  assert.ok(g.ampHtml.includes('placehold.co/300x200'), 'the image-less item keeps its ph() tile');
  assert.ok(!/\[src\]/.test(g.ampHtml), 'images are static per tile — never bound');
  assert.match(g.ampHtml, /\[hidden\]="\(s\.cat != 'all' &amp;&amp; s\.cat != 'all'\) \|\| \(s\.q != ''/, 'the tile filter expression is unchanged');
  const byName = Object.fromEntries(g.previewModel.items.map((it) => [it.name, it]));
  assert.strictEqual(byName['Espresso Kit'].image, IMG_A, 'previewModel image is the raw real URL');
  assert.ok(!('image' in byName['Filter Papers']), 'no image key on entries without a real image');
});

test('item images that are not plain https are dropped to the placeholder; the item survives', () => {
  const g = gen('search', {
    items: [
      { name: 'Sneaky', image: 'javascript:alert(1)' },
      { name: 'Plain', price: 99, image: 'http://cdn.acme.com/x.jpg' }, // AMP4EMAIL rejects http: amp-img srcs
      { name: 'Tagged', image: 'https://cdn.acme.com/<img>.jpg' },
    ],
  });
  assert.ok(!g.ampHtml.includes('javascript:'), 'javascript: never reaches the markup');
  assert.ok(!g.ampHtml.includes('http://cdn.acme.com'), 'http: images never reach an amp-img src');
  for (const name of ['Sneaky', 'Plain', 'Tagged']) {
    assert.ok(g.ampHtml.includes(name), `${name} still renders`);
  }
  assert.ok(g.ampHtml.includes('placehold.co/300x200'), 'dropped images fall back to ph() tiles');
  assert.ok(g.previewModel.items.every((it) => !('image' in it)), 'no rejected URL leaks into the previewModel');
});

// ---- hero band ----------------------------------------------------------------

test('a valid heroUrl renders the hero band on every module; absence renders none', () => {
  const band = '<div class="hero"><amp-img src="https://cdn.acme.com/hero-banner.jpg" width="600" height="240" layout="responsive" alt="Acme"></amp-img></div>';
  for (const moduleId of MODULE_IDS) {
    const withHero = gen(moduleId, { heroUrl: HERO });
    assert.ok(withHero.ampHtml.includes(band), `${moduleId}: hero band renders between header and body`);
    assert.ok(withHero.ampHtml.indexOf('</h1>') < withHero.ampHtml.indexOf('class="hero"'), `${moduleId}: hero sits after the header`);
    assert.strictEqual(withHero.previewModel.heroUrl, HERO, `${moduleId}: previewModel carries the raw heroUrl`);

    const without = gen(moduleId, {});
    assert.ok(!without.ampHtml.includes('class="hero"'), `${moduleId}: no hero markup without a heroUrl`);
    assert.strictEqual(without.previewModel.heroUrl, null, `${moduleId}: previewModel heroUrl is null`);
  }
});

test('an invalid heroUrl leaves every module byte-identical to a hero-less render', () => {
  const bad = [
    'javascript:alert(1)',
    'http://cdn.acme.com/hero.jpg',
    'https://cdn.acme.com/<hero>.jpg',
    'https://cdn.acme.com/' + 'a'.repeat(500), // over the 500-char cap
  ];
  for (const moduleId of MODULE_IDS) {
    const plain = gen(moduleId, {});
    for (const heroUrl of bad) {
      const g = gen(moduleId, { heroUrl });
      assert.strictEqual(g.ampHtml, plain.ampHtml, `${moduleId}: "${heroUrl.slice(0, 40)}" must be a byte-identical no-op`);
      assert.deepStrictEqual(g.previewModel, plain.previewModel, `${moduleId}: previewModel unchanged too`);
    }
  }
});

// ---- the real validator stays green with assets in play ------------------------

test('hero + item images validate AMP4EMAIL for every module x Finance/Beauty/Generic', async () => {
  const failures = [];
  for (const moduleId of MODULE_IDS) {
    for (const vertical of ['Finance', 'Beauty', 'Generic']) {
      const g = generate({
        brand: 'Zomato', vertical, tone: 'Playful', currency: 'INR', moduleId, counter: 1,
        copy: { heroUrl: HERO, items: MIXED_ITEMS },
      });
      const v = await validate(g.ampHtml);
      if (!v.pass) failures.push({ moduleId, vertical, errors: v.errors });
    }
  }
  assert.deepStrictEqual(failures, [], `asset renders failed validation: ${JSON.stringify(failures, null, 2)}`);
});

// ---- determinism ----------------------------------------------------------------

test('same seed + same copy with assets is byte-identical; a reroll changes it', () => {
  for (const moduleId of ['reveal', 'search']) {
    const opts = { brand: 'Acme', vertical: 'Generic', tone: 'Playful', currency: 'INR', moduleId, copy: { heroUrl: HERO, items: MIXED_ITEMS } };
    const a = generate({ ...opts, counter: 0 });
    const b = generate({ ...opts, counter: 1 });
    const c = generate({ ...opts, counter: 0 });
    assert.strictEqual(a.ampHtml, c.ampHtml, `${moduleId}: same seed must reproduce identical AMP`);
    assert.deepStrictEqual(a.previewModel, c.previewModel, `${moduleId}: same seed must reproduce the identical model`);
    assert.notStrictEqual(a.ampHtml, b.ampHtml, `${moduleId}: a reroll must change the content`);
  }
});

// ---- fallback MIME part -----------------------------------------------------------

test('fallback: hero band and product thumbs render when present, text-first layout intact', () => {
  const g = gen('search', { heroUrl: HERO, items: MIXED_ITEMS });
  const f = buildFallback({
    brand: g.brand, moduleId: g.moduleId, moduleName: g.moduleName,
    palette: g.palette, previewModel: g.previewModel, currency: g.currency,
  });
  assert.ok(f.html.includes(`<img src="${HERO}" width="600" alt="Acme"`), 'hero renders as a full-width img after the brand header');
  assert.ok(f.html.indexOf('</h1>') < f.html.indexOf(`<img src="${HERO}"`), 'hero sits below the header block');
  assert.ok(f.html.includes('src="https://cdn.acme.com/espresso.jpg?v=2&amp;w=600" width="48" height="48" alt="Espresso Kit"'), 'product thumb is entity-encoded with the item name as alt');
  assert.ok(f.html.includes(`src="${IMG_B}" width="48" height="48" alt="Steel Tumbler"`), 'second thumb renders');
  for (const name of ['Espresso Kit', 'Steel Tumbler', 'Filter Papers']) {
    assert.ok(f.html.includes(name), `html still lists ${name} as text`);
    assert.ok(f.text.includes(name), `plain text still lists ${name}`);
  }
  assert.ok(!f.text.includes('https://cdn.acme.com'), 'the plain-text part stays image-free');
});

test('fallback: no imgs at all when the model carries no assets and no logo', () => {
  const g = gen('search', { items: [{ name: 'Filter Papers', price: 249 }] });
  const f = buildFallback({
    brand: g.brand, moduleId: g.moduleId, moduleName: g.moduleName,
    palette: g.palette, previewModel: g.previewModel, logoUrl: '', currency: g.currency,
  });
  assert.strictEqual(f.html.indexOf('<img'), -1, 'no hero, no thumbs, no logo img');
  assert.ok(f.html.includes('Filter Papers'), 'the item row still renders as text');
});

test('fallback: a caller-assembled model cannot smuggle junk hero/item URLs', () => {
  const f = buildFallback({
    brand: 'Acme', moduleId: 'search', moduleName: 'Search & Filter Catalog',
    previewModel: {
      type: 'search',
      heroUrl: 'javascript:alert(1)',
      items: [{ name: 'Sneaky', price: '₹99', image: 'data:image/png;base64,AAAA' }],
    },
  });
  assert.ok(!f.html.includes('javascript:'), 'junk hero is dropped by safeUrl');
  assert.ok(!f.html.includes('data:image'), 'junk item image is dropped by safeUrl');
  assert.ok(f.html.includes('Sneaky'), 'the row itself survives');
});
