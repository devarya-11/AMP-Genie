'use strict';
const { test } = require('node:test');
const assert = require('node:assert');

// Deterministic + offline: nothing here touches a provider; assert against the
// REAL amphtml-validator (AMP4EMAIL mode) — no regex approximations.
delete process.env.GEMINI_API_KEY;
delete process.env.GROQ_API_KEY;
delete process.env.OLLAMA_BASE_URL;

const {
  validateDoc, renderDoc, docToAmp, exampleDocForBrand, BLOCK_TYPES,
} = require('../server/email-doc');
const { validate } = require('../server/validator');

// A doc exercising EVERY supported static block type.
function everyBlockDoc(overrides = {}) {
  return {
    version: 1,
    brand: { name: 'Acme', primaryHex: '#4f46e5', logoUrl: 'https://cdn.acme.com/logo.png' },
    currency: 'USD',
    blocks: [
      { id: 'b_header', type: 'header', props: { brandName: 'Acme', link: 'https://acme.com' } },
      { id: 'b_hero', type: 'hero', props: { imageUrl: 'https://cdn.acme.com/hero.jpg', alt: 'Hero', height: 240 } },
      { id: 'b_text', type: 'text', props: { heading: 'Big news', body: 'A plain paragraph of copy.' } },
      { id: 'b_image', type: 'image', props: { imageUrl: 'https://cdn.acme.com/pic.jpg', alt: 'Pic', href: 'https://acme.com/pic' } },
      { id: 'b_button', type: 'button', props: { label: 'Shop now', href: 'https://acme.com/shop', align: 'center' } },
      { id: 'b_products', type: 'products', props: { columns: 3, items: [
        { name: 'Alpha', price: 499, imageUrl: 'https://cdn.acme.com/a.jpg' },
        { name: 'Beta', price: 1299 },
        { name: 'Gamma' },
      ] } },
      { id: 'b_divider', type: 'divider', props: {} },
      { id: 'b_footer', type: 'footer', props: { brandName: 'Acme', text: 'You opted in.' } },
    ],
    ...overrides,
  };
}

// ---- the core promise: the starter doc passes the real validator -------------

test('exampleDocForBrand renders and PASSES the real AMP4EMAIL validator (zero errors)', async () => {
  const doc = exampleDocForBrand({ name: 'Zomato', primaryHex: '#e23744' });
  const { ampHtml, warnings } = renderDoc(doc);
  const v = await validate(ampHtml);
  assert.strictEqual(v.pass, true, `validator errors: ${JSON.stringify(v.errors, null, 2)}`);
  assert.strictEqual(v.errorCount, 0);
  assert.ok(Array.isArray(warnings), 'warnings is an array');
});

test('exampleDocForBrand without a hero image still validates (hero degrades to a placeholder)', async () => {
  const doc = exampleDocForBrand({ name: 'Acme' }); // no logoUrl, no hero image
  const { ampHtml, warnings } = renderDoc(doc);
  const v = await validate(ampHtml);
  assert.strictEqual(v.pass, true, `validator errors: ${JSON.stringify(v.errors, null, 2)}`);
  assert.ok(warnings.some((w) => /hero/.test(w)), 'a hero-placeholder warning is emitted');
});

// ---- every block type in one document validates ------------------------------

test('a doc using EVERY block type renders and passes the validator', async () => {
  const { ampHtml } = docToAmp(everyBlockDoc());
  const v = await validate(ampHtml);
  assert.strictEqual(v.pass, true, `validator errors: ${JSON.stringify(v.errors, null, 2)}`);
  assert.strictEqual(v.errorCount, 0);
});

test('BLOCK_TYPES lists exactly the eight supported static types and each renders valid alone', async () => {
  assert.deepStrictEqual(
    [...BLOCK_TYPES].sort(),
    ['button', 'divider', 'footer', 'header', 'hero', 'image', 'products', 'text'].sort(),
  );
  for (const type of BLOCK_TYPES) {
    const doc = { version: 1, brand: { name: 'Solo', primaryHex: '#0aa' }, blocks: [{ id: 't', type, props: {} }] };
    const { ampHtml } = docToAmp(doc);
    const v = await validate(ampHtml);
    assert.strictEqual(v.pass, true, `${type}-only doc failed: ${JSON.stringify(v.errors, null, 2)}`);
  }
});

// ---- determinism -------------------------------------------------------------

test('determinism: the same doc renders byte-identical ampHtml twice', () => {
  const doc = everyBlockDoc();
  const a = renderDoc(doc).ampHtml;
  const b = renderDoc(doc).ampHtml;
  assert.strictEqual(a, b, 'ampHtml must be byte-identical for the same doc');
});

test('determinism: exampleDocForBrand is byte-stable across calls', () => {
  const a = renderDoc(exampleDocForBrand({ name: 'Acme', primaryHex: '#123456' })).ampHtml;
  const b = renderDoc(exampleDocForBrand({ name: 'Acme', primaryHex: '#123456' })).ampHtml;
  assert.strictEqual(a, b);
});

test('determinism: docToAmp on the same input yields identical ampHtml', () => {
  const doc = everyBlockDoc();
  assert.strictEqual(docToAmp(doc).ampHtml, docToAmp(doc).ampHtml);
});

// ---- structural rules (mirrors tests/validator.test.js) ----------------------

test('AMP4EMAIL structural rules are honoured', () => {
  const { ampHtml } = docToAmp(everyBlockDoc());
  assert.match(ampHtml, /^<!doctype html>\n<html amp4email data-css-strict>/, '<html amp4email> preamble');
  assert.match(ampHtml, /<head>\n<meta charset="utf-8">/, 'meta charset first in head');
  assert.ok(!/:root/.test(ampHtml), 'must not use :root');
  assert.ok(!/var\(--/.test(ampHtml), 'must not use var(--...)');
  assert.ok(!/!important/.test(ampHtml), 'must not use !important');
  assert.ok(!/@import/.test(ampHtml), 'must not use @import');

  const styleMatches = ampHtml.match(/<style amp-custom>/g) || [];
  assert.strictEqual(styleMatches.length, 1, 'exactly one <style amp-custom>');
  const cssMatch = ampHtml.match(/<style amp-custom>([\s\S]*?)<\/style>/);
  assert.ok(cssMatch, 'amp-custom style present');
  assert.ok(Buffer.byteLength(cssMatch[1], 'utf8') < 75 * 1024, 'amp-custom under 75KB');
  assert.ok(Buffer.byteLength(ampHtml, 'utf8') < 200 * 1024, 'document under 200KB');
});

test('v1 is STATIC only: no amp-bind script, no amp-state, no on= handlers, no bound attributes', () => {
  const { ampHtml } = docToAmp(everyBlockDoc());
  assert.ok(!/amp-bind/.test(ampHtml), 'no amp-bind runtime');
  assert.ok(!/<amp-state/.test(ampHtml), 'no amp-state');
  assert.ok(!/\son="/.test(ampHtml), 'no on= handlers');
  assert.ok(!/\[(class|text|hidden|src)\]/.test(ampHtml), 'no bound attributes');
  // The only script tag in a static doc is the AMP runtime itself.
  const scripts = ampHtml.match(/<script\b/g) || [];
  assert.strictEqual(scripts.length, 1, 'only the v0.js runtime script is present');
  assert.match(ampHtml, /<script async src="https:\/\/cdn\.ampproject\.org\/v0\.js">/, 'v0.js runtime present');
});

test('every <amp-img> carries width, height, layout and an https src', () => {
  const { ampHtml } = docToAmp(everyBlockDoc());
  const imgs = ampHtml.match(/<amp-img\b[^>]*>/g) || [];
  assert.ok(imgs.length >= 3, 'the doc renders several amp-imgs (header logo, hero, image, product tiles)');
  for (const tag of imgs) {
    assert.match(tag, /\bwidth="\d+"/, `amp-img has width: ${tag}`);
    assert.match(tag, /\bheight="\d+"/, `amp-img has height: ${tag}`);
    assert.match(tag, /\blayout="(responsive|fixed|fill|fixed-height|flex-item|intrinsic)"/, `amp-img has layout: ${tag}`);
    const src = (tag.match(/\bsrc="([^"]*)"/) || [])[1] || '';
    assert.match(src, /^https:\/\//, `amp-img src is https: ${src}`);
  }
});

// ---- sanitation --------------------------------------------------------------

test('a text block with <script> in the body is entity-encoded and the doc still validates', async () => {
  const doc = {
    version: 1, brand: { name: 'Acme', primaryHex: '#333' },
    blocks: [{ id: 'x', type: 'text', props: { heading: 'A <script>alert(1)</script> title', body: 'Body with <b>markup</b> & an ampersand' } }],
  };
  const { ampHtml } = docToAmp(doc);
  assert.ok(!ampHtml.includes('<script>alert(1)'), 'no raw <script> reaches the markup');
  assert.ok(!/<b>markup<\/b>/.test(ampHtml), 'client markup does not survive as tags');
  assert.ok(ampHtml.includes('&amp;'), 'the ampersand is entity-encoded');
  const v = await validate(ampHtml);
  assert.strictEqual(v.pass, true, `sanitized text doc failed: ${JSON.stringify(v.errors, null, 2)}`);
});

test('an http: image url is dropped to a placeholder (validator would reject http) with a warning', async () => {
  const doc = {
    version: 1, brand: { name: 'Acme', primaryHex: '#333' },
    blocks: [{ id: 'img', type: 'image', props: { imageUrl: 'http://cdn.acme.com/x.jpg', alt: 'x' } }],
  };
  const { ampHtml, warnings } = docToAmp(doc);
  assert.ok(!ampHtml.includes('http://cdn.acme.com'), 'the http: url never reaches an amp-img src');
  assert.ok(ampHtml.includes('https://placehold.co/'), 'a placehold.co placeholder took its place');
  assert.ok(warnings.some((w) => /image/.test(w)), 'a warning is emitted for the dropped image');
  const v = await validate(ampHtml);
  assert.strictEqual(v.pass, true, 'placeholdered image doc still validates');
});

test('a javascript: url is refused for both header logo and image href', async () => {
  const doc = {
    version: 1, brand: { name: 'Acme', primaryHex: '#333' },
    blocks: [
      { id: 'h', type: 'header', props: { brandName: 'Acme', logoUrl: 'javascript:alert(1)', link: 'javascript:alert(2)' } },
      { id: 'i', type: 'image', props: { imageUrl: 'https://cdn.acme.com/ok.jpg', href: 'javascript:alert(3)' } },
    ],
  };
  const { ampHtml } = docToAmp(doc);
  assert.ok(!ampHtml.includes('javascript:'), 'no javascript: scheme survives anywhere');
  const v = await validate(ampHtml);
  assert.strictEqual(v.pass, true, 'the doc still validates after refusing the junk urls');
});

test('an unknown block type is dropped with a note; the rest of the doc renders', () => {
  const doc = {
    version: 1, brand: { name: 'Acme', primaryHex: '#333' },
    blocks: [
      { id: 'a', type: 'text', props: { body: 'kept' } },
      { id: 'b', type: 'carousel', props: {} },
      { id: 'c', type: 'accordion', props: {} },
      { id: 'd', type: 'footer', props: { brandName: 'Acme' } },
    ],
  };
  const v = validateDoc(doc);
  assert.strictEqual(v.ok, true);
  assert.deepStrictEqual(v.doc.blocks.map((b) => b.type), ['text', 'footer'], 'only known types survive');
  assert.ok((v.doc.notes || []).some((n) => /carousel/.test(n)), 'a note records the dropped carousel');
  const { ampHtml } = renderDoc(v.doc);
  assert.ok(ampHtml.includes('kept'), 'the surviving text block rendered');
});

test('more than 40 blocks are capped at 40', () => {
  const blocks = [];
  for (let i = 0; i < 55; i++) blocks.push({ id: 'n' + i, type: 'divider', props: {} });
  const v = validateDoc({ version: 1, blocks });
  assert.strictEqual(v.ok, true);
  assert.strictEqual(v.doc.blocks.length, 40, 'block list is capped at 40');
  assert.ok((v.doc.notes || []).some((n) => /capped/.test(n)), 'a cap note is recorded');
});

test('validateDoc rejects a non-object doc and a doc without a blocks array without throwing', () => {
  assert.strictEqual(validateDoc(null).ok, false);
  assert.strictEqual(validateDoc(42).ok, false);
  assert.strictEqual(validateDoc([]).ok, false);
  assert.strictEqual(validateDoc({ version: 1 }).ok, false, 'missing blocks array is rejected');
});

test('validateDoc coerces an unknown currency to absent and a bad hex to absent', () => {
  const v = validateDoc({ version: 1, currency: 'XYZ', brand: { name: 'Acme', primaryHex: 'notahex' }, blocks: [] });
  assert.strictEqual(v.ok, true);
  assert.ok(!('currency' in v.doc), 'unknown currency is dropped');
  assert.ok(!v.doc.brand || !('primaryHex' in (v.doc.brand || {})), 'bad hex is dropped');
});

test('docToAmp on an invalid doc returns ok:false with a warning and an empty valid shell (never throws)', async () => {
  const r = docToAmp({ not: 'a doc' });
  assert.strictEqual(r.ok, false);
  assert.ok(typeof r.error === 'string' && r.error.length > 0, 'an error message is present');
  assert.ok(r.warnings.some((w) => /docToAmp/.test(w)), 'a warning explains the failure');
  const v = await validate(r.ampHtml);
  assert.strictEqual(v.pass, true, 'the fallback empty shell still validates');
});

test('a button with no valid href degrades to a non-link span and still validates', async () => {
  const doc = {
    version: 1, brand: { name: 'Acme', primaryHex: '#333' },
    blocks: [{ id: 'btn', type: 'button', props: { label: 'Go', href: 'ftp://nope' } }],
  };
  const { ampHtml, warnings } = docToAmp(doc);
  assert.ok(!ampHtml.includes('ftp://'), 'the non-http(s) href is refused');
  assert.ok(/<span class="btn">Go<\/span>/.test(ampHtml), 'renders as a non-interactive styled span');
  assert.ok(warnings.some((w) => /button/.test(w)), 'a warning is emitted');
  const v = await validate(ampHtml);
  assert.strictEqual(v.pass, true);
});

// ---- currency ----------------------------------------------------------------

test('a products block in EUR renders formatPrice with the entity-encoded symbol, no raw multibyte', async () => {
  const doc = {
    version: 1, brand: { name: 'Acme', primaryHex: '#333' }, currency: 'EUR',
    blocks: [{ id: 'p', type: 'products', props: { columns: 2, items: [
      { name: 'Widget', price: 1234 },
      { name: 'Gadget', price: 99 },
    ] } }],
  };
  const { ampHtml } = docToAmp(doc);
  assert.ok(ampHtml.includes('&#8364;'), 'the euro sign is the entity &#8364;');
  assert.ok(!ampHtml.includes('€'), 'no raw multibyte euro glyph in the bytes');
  assert.ok(ampHtml.includes('&#8364;1,234'), 'the price is grouped and prefixed with the entity symbol');
  const v = await validate(ampHtml);
  assert.strictEqual(v.pass, true, `EUR products doc failed: ${JSON.stringify(v.errors, null, 2)}`);
});

test('the default currency is INR and its symbol is entity-encoded', () => {
  const doc = {
    version: 1, brand: { name: 'Acme', primaryHex: '#333' }, // no currency
    blocks: [{ id: 'p', type: 'products', props: { items: [{ name: 'Thing', price: 250 }] } }],
  };
  const { ampHtml } = docToAmp(doc);
  assert.ok(ampHtml.includes('&#8377;250'), 'INR rupee entity &#8377; prefixes the price by default');
  assert.ok(!ampHtml.includes('₹'), 'no raw rupee glyph');
});

// ---- css merge / dedupe ------------------------------------------------------

test('shared base CSS is emitted once even with many blocks of the same type', () => {
  const blocks = [];
  for (let i = 0; i < 6; i++) blocks.push({ id: 'h' + i, type: 'hero', props: { imageUrl: 'https://cdn.acme.com/h' + i + '.jpg' } });
  const { css } = renderDoc({ version: 1, brand: { name: 'Acme', primaryHex: '#333' }, blocks });
  const bodyRuleCount = (css.match(/\.wrap\{max-width:600px/g) || []).length;
  assert.strictEqual(bodyRuleCount, 1, 'the base .wrap rule appears exactly once despite six hero blocks');
});

// ---- warnings for placeholdered assets ---------------------------------------

test('renderDoc emits warnings for each placeholdered product image but still validates', async () => {
  const doc = {
    version: 1, brand: { name: 'Acme', primaryHex: '#333' },
    blocks: [{ id: 'p', type: 'products', props: { items: [{ name: 'NoPic1' }, { name: 'NoPic2' }] } }],
  };
  const { ampHtml, warnings } = docToAmp(doc);
  assert.ok(warnings.filter((w) => /products:/.test(w)).length >= 2, 'a warning per image-less product');
  assert.ok(ampHtml.includes('https://placehold.co/300x200/'), 'placeholder tiles are used');
  const v = await validate(ampHtml);
  assert.strictEqual(v.pass, true);
});
