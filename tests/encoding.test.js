'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { generate, formatPrice, enc, CURRENCIES } = require('../server/generate');

// Decode numeric HTML entities back to their unicode characters.
function decodeEntities(s) {
  return s.replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
}

test('formatPrice emits an entity, never raw multibyte or mojibake', () => {
  const out = formatPrice(4799, 'INR');
  assert.strictEqual(out, '&#8377;4,799', 'rupee price should be entity-encoded with grouping');
  assert.ok(out.indexOf('₹') === -1, 'raw output must not contain a literal ₹ byte');
  assert.ok(out.indexOf('â') === -1, 'raw output must not contain mojibake (â)');
  assert.strictEqual(decodeEntities(out), '₹4,799', 'rendered text node equals ₹4,799');
});

test('every currency symbol is entity-encoded when non-ASCII', () => {
  for (const code of Object.keys(CURRENCIES)) {
    const out = formatPrice(1000, code);
    const sym = CURRENCIES[code];
    const cp = sym.codePointAt(0);
    if (cp > 127) {
      assert.ok(out.indexOf('&#' + cp + ';') === 0, `${code} symbol should be entity-encoded`);
      assert.ok(out.indexOf(sym) === -1, `${code} raw symbol must not appear literally`);
    }
    assert.strictEqual(decodeEntities(out).indexOf(sym), 0, `${code} decodes back to its symbol`);
  }
});

test('enc converts any codepoint > 127 to a numeric entity', () => {
  assert.strictEqual(enc('café'), 'caf&#233;');
  assert.strictEqual(enc('₹'), '&#8377;');
  assert.strictEqual(enc('a&b<c>d"e'), 'a&amp;b&lt;c&gt;d&quot;e');
  // round-trips for the rupee
  assert.strictEqual(decodeEntities(enc('₹')), '₹');
});

test('generated INR email carries entities in the raw bytes, no mojibake', () => {
  const g = generate({ brand: 'Zomato', vertical: 'Food', tone: 'Playful', currency: 'INR', moduleId: 'reveal' });
  assert.ok(g.ampHtml.indexOf('&#8377;') !== -1, 'raw AMP should contain &#8377;');
  assert.ok(g.ampHtml.indexOf('₹') === -1, 'raw AMP must not contain a literal ₹');
  assert.ok(g.ampHtml.indexOf('â‚¹') === -1, 'raw AMP must not contain UTF-8 mojibake of ₹');
});
