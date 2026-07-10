'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { generate, MODULE_IDS } = require('../server/generate');
const { buildFallback } = require('../server/fallback');

// Byte-scan (same guarantee tests/encoding.test.js checks): the html MIME part
// must be pure ASCII — every non-ASCII codepoint entity-encoded — so it can
// never mojibake regardless of transport charset.
function assertAscii(s, label) {
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    assert.ok(cp <= 127, `${label} contains raw codepoint ${cp} (>127): "${ch}"`);
  }
}

// buildFallback consumes generate()'s own outputs, so drive it exactly the way
// dispatch will: real previewModel + real palette, fixed brand/counter for
// determinism, moduleId forced per case.
function fallbackFor(moduleId, vertical) {
  const g = generate({ brand: 'Meesho', vertical, tone: 'Playful', currency: 'INR', counter: 3, moduleId });
  return buildFallback({
    brand: g.brand,
    moduleId: g.moduleId,
    moduleName: g.moduleName,
    palette: g.palette,
    previewModel: g.previewModel,
    site: 'https://www.meesho.com',
    logoUrl: '',
    currency: g.currency,
  });
}

for (const moduleId of MODULE_IDS) {
  for (const vertical of ['Fashion', 'Finance', 'Generic']) {
    test(`${moduleId} x ${vertical}: branded, ASCII-clean, script-free static document`, () => {
      const out = fallbackFor(moduleId, vertical);
      assert.ok(out.html.startsWith('<!doctype html>'), 'html starts with <!doctype html>');
      assert.ok(out.html.includes('Meesho'), 'html carries the brand');
      assertAscii(out.html, `${moduleId}/${vertical} html`);
      assert.ok(!/<script/i.test(out.html), 'static fallback must carry no script');
      assert.ok(out.text.trim().length > 0, 'text part is non-empty');
      assert.ok(out.text.includes('Meesho'), 'text carries the brand');
    });
  }
}

test('priced modules carry the entity-encoded rupee in html and the real glyph in text', () => {
  for (const moduleId of ['reveal', 'search']) {
    const out = fallbackFor(moduleId, 'Fashion');
    assert.ok(out.html.includes('&#8377;'), `${moduleId} html should contain &#8377;`);
    assert.ok(out.html.indexOf('₹') === -1, `${moduleId} html must not contain a literal ₹`);
    assert.ok(out.text.includes('₹'), `${moduleId} text may (and should) use the real glyph`);
  }
});

test('reveal surfaces the offer code from the previewModel in both parts', () => {
  const g = generate({ brand: 'Meesho', vertical: 'Fashion', currency: 'INR', counter: 3, moduleId: 'reveal' });
  const out = buildFallback({
    brand: g.brand, moduleId: g.moduleId, moduleName: g.moduleName,
    palette: g.palette, previewModel: g.previewModel, currency: g.currency,
  });
  assert.ok(out.html.includes(g.previewModel.code), 'html shows the code');
  assert.ok(out.text.includes(g.previewModel.code), 'text shows the code');
  assert.ok(out.html.includes(g.previewModel.discount + '% OFF'), 'html shows the discount');
});

test('rating renders five star entities and points at Gmail', () => {
  const out = fallbackFor('rating', 'Generic');
  assert.ok(out.html.includes('&#9733;'.repeat(5)), 'five star glyphs as entities');
  assert.ok(out.html.includes('Gmail'), 'html mentions opening in Gmail');
  assert.ok(out.text.includes('Gmail'), 'text mentions opening in Gmail');
});

test('poll renders both options statically', () => {
  const g = generate({ brand: 'Meesho', vertical: 'Generic', counter: 3, moduleId: 'poll' });
  const out = buildFallback({
    brand: g.brand, moduleId: g.moduleId, moduleName: g.moduleName,
    palette: g.palette, previewModel: g.previewModel,
  });
  assert.ok(out.html.includes(g.previewModel.a), 'html shows option A');
  assert.ok(out.html.includes(g.previewModel.b), 'html shows option B');
  assert.ok(out.text.includes(g.previewModel.a) && out.text.includes(g.previewModel.b), 'text shows both options');
});

test('every module variant carries the consistent Gmail pointer line', () => {
  for (const moduleId of MODULE_IDS) {
    const out = fallbackFor(moduleId, 'Generic');
    assert.ok(out.html.includes('Open this email in Gmail for the interactive version.'), `${moduleId} html carries the pointer`);
    assert.ok(out.text.includes('Open this email in Gmail for the interactive version.'), `${moduleId} text carries the pointer`);
  }
});

test('a supplied logoUrl becomes the header <img>; without one the brand name renders in palette.primary', () => {
  const g = generate({ brand: 'Meesho', vertical: 'Fashion', counter: 3, moduleId: 'reveal' });
  const base = {
    brand: g.brand, moduleId: g.moduleId, moduleName: g.moduleName,
    palette: g.palette, previewModel: g.previewModel, currency: g.currency,
  };
  const withLogo = buildFallback({ ...base, logoUrl: 'https://www.meesho.com/logo.png' });
  assert.ok(withLogo.html.includes('<img src="https://www.meesho.com/logo.png"'), 'logo img is used when given');
  const without = buildFallback(base);
  assert.ok(without.html.indexOf('<img') === -1, 'no img without a logoUrl');
  assert.ok(without.html.includes(`color:${g.palette.primary};">Meesho</span>`), 'brand text takes palette.primary');
});

test('malformed input degrades to a non-empty branded shell instead of throwing', () => {
  const out = buildFallback({ brand: 'X', moduleId: 'nope', previewModel: null, palette: null });
  assert.ok(out.html.startsWith('<!doctype html>'), 'still a complete document');
  assert.ok(out.html.includes('X'), 'still branded');
  assert.ok(out.text.trim().length > 0, 'text still non-empty');
  assert.ok(out.text.includes('X'), 'text still branded');
  assertAscii(out.html, 'malformed-input html');
});

test('buildFallback never throws, even on no arguments or hostile field types', () => {
  for (const input of [undefined, null, {}, { previewModel: 42, palette: 'red' },
    { brand: 7, moduleId: '__proto__', previewModel: { type: 'constructor' } },
    { moduleId: 'poll', previewModel: { q: null, a: 9, b: {} }, site: 'javascript:alert(1)' }]) {
    const out = buildFallback(input);
    assert.ok(out && out.html.startsWith('<!doctype html>') && out.text.trim().length > 0,
      'always returns a usable html+text pair');
    assert.ok(out.html.indexOf('javascript:') === -1, 'non-http(s) URLs never reach the markup');
  }
});
