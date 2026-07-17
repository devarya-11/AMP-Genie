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
  interactiveDocForModule, fieldsForModule, INTERACTIVE_TYPES,
  sanitizeCustomHtml,
} = require('../server/email-doc');
const { validate } = require('../server/validator');
const {
  MODULE_IDS, hashSeed, hslToHex, derivePalette,
} = require('../server/generate');

// The deterministic per-brand primary a NAMED, colour-less brand should render
// in — the exact hue renderDoc.brandFallbackColor derives, so the assertions
// below are pinned to the real formula, not a hand-copied constant.
function expectedBrandPrimary(name) {
  return derivePalette(hslToHex({ h: hashSeed(name) % 360, s: 0.6, l: 0.47 })).primary;
}

// Every interactive module id — the interactive block `type`s. Sourced from
// generate()'s registry (the source of truth) so a newly added module (e.g.
// form) is exercised automatically instead of silently skipped by a hardcoded
// list, and so the membership check below independently pins email-doc's
// INTERACTIVE_TYPES to that registry.
const INTERACTIVE_IDS = [...MODULE_IDS];

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

const STATIC_TYPES = ['button', 'custom', 'divider', 'footer', 'header', 'hero', 'image', 'products', 'text'];

test('BLOCK_TYPES registers every static type plus every interactive module; each renders valid alone', async () => {
  // The static layout blocks are all present...
  for (const t of STATIC_TYPES) assert.ok(BLOCK_TYPES.includes(t), `static type ${t} is registered`);
  // ...and so are all interactive module ids (so the palette lists them).
  for (const t of INTERACTIVE_IDS) assert.ok(BLOCK_TYPES.includes(t), `interactive type ${t} is registered`);
  assert.strictEqual(BLOCK_TYPES.length, STATIC_TYPES.length + INTERACTIVE_IDS.length, 'no extra/duplicate types');
  // Every registered type renders a validator-clean doc when it is the sole block.
  for (const type of BLOCK_TYPES) {
    const doc = { version: 1, brand: { name: 'Solo', primaryHex: '#0aa' }, blocks: [{ id: 't', type, props: {} }] };
    const { ampHtml } = docToAmp(doc);
    const v = await validate(ampHtml);
    assert.strictEqual(v.pass, true, `${type}-only doc failed: ${JSON.stringify(v.errors, null, 2)}`);
  }
});

// ---- interactive modules inherit the doc brand's real logo + hero ------------
// Regression: renderInteractive used to hand the module only { brand, color,
// currency, copy: block.props } — dropping ctx.logoUrl/heroUrl — so a module's
// OWN header always painted the palette placeholder even when the brand had a
// real logo ("pulled but not displayed"). Exercised through the trust boundary
// (validateDoc → renderDoc), exactly the path /api/docs/render runs.
test('an interactive block inherits the doc brand real logo + hero band (through validateDoc)', () => {
  const LOGO = 'https://cdn.acme.com/real-logo.png';
  const HERO = 'https://cdn.acme.com/real-hero.jpg';
  for (const type of INTERACTIVE_IDS) {
    const v = validateDoc({
      version: 1,
      brand: { name: 'Acme', primaryHex: '#4f46e5', logoUrl: LOGO, heroUrl: HERO },
      blocks: [{ id: 'b', type, props: {} }],
    });
    assert.ok(v.ok, `${type}: asset-bearing doc validates`);
    const amp = renderDoc(v.doc).ampHtml;
    assert.ok(amp.includes(`src="${LOGO}"`), `${type}: the real logo reaches the interactive module header`);
    assert.ok(amp.includes('class="hero"') && amp.includes(`src="${HERO}"`), `${type}: the real hero band renders on the interactive module`);
    assert.ok(!amp.includes('placehold.co/96x32'), `${type}: no placeholder wordmark once a real logo exists`);
  }
});

test('an interactive block with no brand assets keeps the placeholder logo and no hero (unchanged)', () => {
  for (const type of INTERACTIVE_IDS) {
    const v = validateDoc({ version: 1, brand: { name: 'Acme', primaryHex: '#4f46e5' }, blocks: [{ id: 'b', type, props: {} }] });
    const amp = renderDoc(v.doc).ampHtml;
    assert.ok(!amp.includes('class="hero"'), `${type}: no hero band without a brand hero`);
    assert.ok(amp.includes('placehold.co/96x32'), `${type}: placeholder wordmark without a real logo`);
  }
});

// ---- interactive product modules paint the doc brand's REAL catalogue --------
// Regression ("Take 2"): the user filled in real product names / prices / photos
// but the reveal module still showed the vertical's SYNTHETIC items. The cause:
// renderInteractive dropped the brand catalogue — a block's props can't hold an
// array (sanitizeInteractiveProps strips them), so the DOC brand is the ONLY
// channel that survives the trust boundary, and it was never forwarded into the
// module's copy.items. Exercised through validateDoc → renderDoc, exactly the
// path /api/docs/render runs.
test('a reveal module paints the doc brand REAL products (name + price + photo), not synthetics', () => {
  const IMG_A = 'https://cdn.acme.com/predator.jpg';
  const IMG_B = 'https://cdn.acme.com/copa.jpg';
  const v = validateDoc({
    version: 1,
    currency: 'USD',
    brand: {
      name: 'Acme', primaryHex: '#4f46e5',
      items: [
        { name: 'Predator Elite Boot', price: 275, imageUrl: IMG_A },
        { name: 'Copa Pure Boot', price: 190, imageUrl: IMG_B },
      ],
    },
    blocks: [{ id: 'b', type: 'reveal', props: {} }],
  });
  assert.ok(v.ok, 'catalogue-bearing doc validates');
  assert.ok(v.doc.brand.items && v.doc.brand.items.length === 2, 'validated items survive on the doc brand');
  const amp = renderDoc(v.doc).ampHtml;
  assert.ok(amp.includes('Predator Elite Boot') && amp.includes('Copa Pure Boot'), 'both REAL product names render');
  assert.ok(amp.includes(`src="${IMG_A}"`) && amp.includes(`src="${IMG_B}"`), 'both REAL product photos render');
  assert.ok(amp.includes('$275') && amp.includes('$190'), 'both REAL prices render (USD)');
});

// The catalogue channel must be strictly additive: an absent, empty, or
// all-invalid catalogue forwards NOTHING, so a module without real products is
// byte-identical to before this channel existed (synthetics unchanged).
test('an interactive module with no valid catalogue is byte-identical (channel is inert)', () => {
  const mk = (brand) => renderDoc(validateDoc({ version: 1, brand, blocks: [{ id: 'b', type: 'reveal', props: {} }] }).doc).ampHtml;
  const a = mk({ name: 'Acme', primaryHex: '#4f46e5' });
  const b = mk({ name: 'Acme', primaryHex: '#4f46e5', items: [] });
  // Entries with no usable name are dropped entirely; an empty result is inert.
  const c = mk({ name: 'Acme', primaryHex: '#4f46e5', items: [{ foo: 1 }, { name: '' }, 'nope'] });
  assert.strictEqual(a, b, 'empty items render identically to no items key');
  assert.strictEqual(a, c, 'an all-invalid catalogue is dropped → byte-identical');
});

// Security: a catalogue that survives (valid name) must never leak an unsafe
// image URL into an <amp-img src>. sanitizeBrandItems accepts only https images,
// so a javascript:/data: url is dropped and the item placeholders its photo.
test('a real product with an unsafe image url renders the name but never the url', () => {
  const amp = renderDoc(validateDoc({
    version: 1,
    brand: { name: 'Acme', primaryHex: '#4f46e5', items: [{ name: 'Sneaker', price: 99, imageUrl: 'javascript:alert(1)' }] },
    blocks: [{ id: 'b', type: 'reveal', props: {} }],
  }).doc).ampHtml;
  assert.ok(amp.includes('Sneaker'), 'the valid product name still renders');
  assert.ok(!amp.includes('javascript:alert(1)'), 'the unsafe image url never reaches the render');
});

// ---- brand-specific colour: a NAMED brand with no colour gets its OWN hue -----
// Part B ("Take 2"): a brand whose research could only GUESS a colour (so none
// was stored) rendered in a generic indigo. renderDoc now derives a
// deterministic per-brand hue from the name — the SAME hue its interactive
// module derives — so the mailer looks on-brand. Only a truly nameless doc keeps
// the indigo default.
test('a named brand with no colour renders a deterministic per-brand hue, not indigo', () => {
  const name = 'Zephyr Athletics';
  const amp = renderDoc(validateDoc({
    version: 1,
    brand: { name },
    blocks: [{ id: 'btn', type: 'button', props: { label: 'Shop', href: 'https://example.com' } }],
  }).doc).ampHtml;
  const hue = expectedBrandPrimary(name);
  assert.notStrictEqual(hue, '#4f46e5', 'sanity: the derived per-brand hue is not the indigo default');
  assert.ok(amp.includes(hue), `the per-brand hue ${hue} paints the static blocks`);
  assert.ok(!amp.includes('#4f46e5'), 'no generic indigo once a brand name exists');
});

test('static blocks and the interactive module share ONE per-brand hue (no colour on the doc)', () => {
  const name = 'Zephyr Athletics';
  const hue = expectedBrandPrimary(name);
  const amp = renderDoc(validateDoc({
    version: 1,
    brand: { name },
    blocks: [{ id: 'r', type: 'reveal', props: {} }],
  }).doc).ampHtml;
  // renderInteractive feeds renderDoc's primaryHex into the module as its colour,
  // so the module's palette resolves to the very same brand hue as the statics.
  assert.ok(amp.includes(hue), 'the interactive module paints the same per-brand hue');
  assert.ok(!amp.includes('#4f46e5'), 'the module is not the indigo default either');
});

test('an unbranded doc (no brand name) still renders the indigo default', () => {
  const amp = renderDoc(validateDoc({
    version: 1,
    blocks: [{ id: 'btn', type: 'button', props: { label: 'Go', href: 'https://example.com' } }],
  }).doc).ampHtml;
  assert.ok(amp.includes('#4f46e5'), 'a nameless doc keeps the indigo default (unchanged)');
});

test('two different brand names get two different deterministic hues', () => {
  assert.notStrictEqual(
    expectedBrandPrimary('Aloe Cosmetics'),
    expectedBrandPrimary('Vertex Tools'),
    'different brands resolve to different hues',
  );
});

// ---- custom-AMP sanitizer: the same-origin-iframe safety gate ----------------
test('sanitizeCustomHtml neutralizes every script/handler/url evasion', () => {
  const cases = [
    '<script>evil()</script>', '<SCRIPT>evil()</SCRIPT>', '<script/xss>evil()</script>', '<script >e()</script>',
    '<img src=x onerror=alert(1)>', '<img/onerror=alert(1) src=x>', '<img src=x\nonerror=alert(1)>',
    '<img src="x"onerror="alert(1)">', "<img src='x'onerror='alert(1)'>", // quote-boundary (no space)
    '<svg/onload=alert(1)>', '<div onclick="e()">x</div>',
    '<iframe src="javascript:evil()"></iframe>', '<object data="x"></object>', '<embed src="x">',
    '<meta http-equiv=refresh content="0;url=http://evil">', '<link rel=stylesheet href="http://evil.css">',
    '<a href="javascript:evil()">x</a>', '<a href="  javascript:evil()">x</a>',
    '<div style="background:url(javascript:evil())">x</div>', '<div style="width:expression(alert(1))">x</div>',
  ];
  for (const c of cases) {
    const out = sanitizeCustomHtml(c);
    assert.ok(!/<script(?![^>]*application\/(ld\+)?json)/i.test(out), `executable script survived: ${c} -> ${out}`);
    assert.ok(!/<(iframe|object|embed|meta|link)\b/i.test(out), `embedding tag survived: ${c} -> ${out}`);
    assert.ok(!/[\s/"'=>]on[a-z]+\s*=/i.test(out), `on-handler survived: ${c} -> ${out}`);
    assert.ok(!/(javascript|vbscript)\s*:|expression\s*\(/i.test(out), `active url/expression survived: ${c} -> ${out}`);
  }
});

test('sanitizeCustomHtml preserves AMP’s own on= binding, JSON data and amp-img', () => {
  const src = '<amp-img src="https://x/a.jpg" width="300" height="200" layout="responsive" on="tap:AMP.setState({x:1})"></amp-img>'
    + '<amp-state id="q"><script type="application/json">{"a":1}</script></amp-state>';
  const out = sanitizeCustomHtml(src);
  assert.match(out, /on="tap:AMP\.setState/, 'AMP on= binding kept');
  assert.match(out, /<script type="application\/json">\{"a":1\}<\/script>/, 'JSON data block kept');
  assert.match(out, /<amp-img /, 'amp-img kept');
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

// M8: the editor reorders by permuting blocks[]. Any permutation must still
// render valid AMP (the reorder can never produce a broken email), and a
// permuted order must render byte-identically to itself (dedup is order-safe).
test('M8: a reversed block order still PASSes and stays byte-deterministic', async () => {
  const doc = everyBlockDoc();
  const reversed = { ...doc, blocks: [...doc.blocks].reverse() };
  const out = renderDoc(reversed);
  const v = await validate(out.ampHtml);
  assert.strictEqual(v.pass, true, `reversed order must pass: ${JSON.stringify(v.errors)}`);
  assert.strictEqual(renderDoc(reversed).ampHtml, out.ampHtml, 'permuted order is byte-stable');
});

// ---- M9: per-block spacing + background ----
test('M9: paddingTop/Bottom + backgroundColor render a scoped rule and PASS', async () => {
  const doc = { version: 1, blocks: [
    { id: 'bx', type: 'text', props: { heading: 'H', body: 'x', paddingTop: 32, paddingBottom: 16, backgroundColor: '#e0e0e0' } },
  ] };
  const out = renderDoc(doc);
  assert.match(out.ampHtml, /\.blk-bx\{padding-top:32px;padding-bottom:16px;background:#e0e0e0;\}/, 'scoped instance rule present');
  assert.match(out.ampHtml, /class="blk-bx pad text"/, 'style class tags the wrapper');
  const v = await validate(out.ampHtml);
  assert.strictEqual(v.pass, true, `styled block must pass: ${JSON.stringify(v.errors)}`);
});

test('M9: an un-styled block emits no instance class or rule (byte-identical)', () => {
  const styled = { version: 1, blocks: [{ id: 'b1', type: 'text', props: { heading: 'H', body: 'x' } }] };
  const out = renderDoc(styled).ampHtml;
  assert.ok(!/blk-b1/.test(out), 'no instance class for an un-styled block');
});

test('M9: a hostile backgroundColor never reaches the CSS', () => {
  const doc = { version: 1, blocks: [
    { id: 'b2', type: 'text', props: { heading: 'H', body: 'x', backgroundColor: 'red;} body{display:none' } },
  ] };
  const out = renderDoc(doc).ampHtml;
  assert.ok(!/display:none/.test(out), 'injected CSS must be dropped');
  assert.ok(!/blk-b2/.test(out), 'invalid colour yields no instance rule');
});

test('M9: padding is clamped to 0–80 and non-numeric is dropped', () => {
  const doc = { version: 1, blocks: [
    { id: 'b3', type: 'text', props: { heading: 'H', body: 'x', paddingTop: 9999, paddingBottom: 'abc' } },
  ] };
  const out = renderDoc(doc).ampHtml;
  assert.match(out, /\.blk-b3\{padding-top:80px;\}/, 'over-max padding clamps to 80, junk padding dropped');
});

// ---- M10: text typography ----
test('M10: heading/body font-size, align, colour render scoped rules and PASS', async () => {
  const doc = { version: 1, blocks: [
    { id: 't1', type: 'text', props: { heading: 'Hi', body: 'x', headingFontSize: 28, bodyAlign: 'center', headingColor: '#112233' } },
  ] };
  const out = renderDoc(doc);
  assert.match(out.ampHtml, /\.blk-t1 \.tx-h\{font-size:28px;color:#112233;\}/);
  assert.match(out.ampHtml, /\.blk-t1 \.tx-b\{text-align:center;\}/);
  const v = await validate(out.ampHtml);
  assert.strictEqual(v.pass, true, `styled text must pass: ${JSON.stringify(v.errors)}`);
});

test('M10: an out-of-range size clamps and a non-enum align is dropped', () => {
  const doc = { version: 1, blocks: [
    { id: 't2', type: 'text', props: { heading: 'H', body: 'x', headingFontSize: 999, bodyAlign: 'justify;} x{y:z' } },
  ] };
  const out = renderDoc(doc).ampHtml;
  assert.match(out, /\.blk-t2 \.tx-h\{font-size:48px;\}/, 'font-size clamps to 48');
  assert.ok(!/y:z/.test(out) && !/text-align:justify/.test(out), 'non-enum align never reaches CSS');
});

test('M10: an un-styled text block is byte-identical to before M10', () => {
  const doc = { version: 1, blocks: [{ id: 'tt', type: 'text', props: { heading: 'H', body: 'x' } }] };
  const out = renderDoc(doc).ampHtml;
  assert.ok(!/blk-tt/.test(out), 'no instance class when no styling set');
});

// ---- M11: button styling ----
test('M11: size L, full-width, colour render scoped rules and PASS', async () => {
  const doc = { version: 1, blocks: [
    { id: 'bt', type: 'button', props: { label: 'Go', href: 'https://x.com', size: 'L', fullWidth: true, buttonColor: '#0a7d33' } },
  ] };
  const out = renderDoc(doc);
  assert.match(out.ampHtml, /\.blk-bt \.btn\{padding:18px 32px;font-size:17px;background:#0a7d33;display:block;width:100%;box-sizing:border-box;\}/);
  assert.match(out.ampHtml, /\.blk-bt \.btnwrap\{display:table;width:100%;\}/);
  const v = await validate(out.ampHtml);
  assert.strictEqual(v.pass, true, `styled button must pass: ${JSON.stringify(v.errors)}`);
});

test('M11: the M (default) size emits no instance rule', () => {
  const doc = { version: 1, blocks: [{ id: 'bm', type: 'button', props: { label: 'Go', href: 'https://x.com', size: 'M' } }] };
  assert.ok(!/blk-bm/.test(renderDoc(doc).ampHtml), 'M size is the base default → no override');
});

test('M11: a hostile buttonColor and non-enum size are rejected', () => {
  const doc = { version: 1, blocks: [
    { id: 'bh', type: 'button', props: { label: 'x', href: 'https://x.com', size: 'XL', buttonColor: '#fff;} evil{x:y' } },
  ] };
  const out = renderDoc(doc).ampHtml;
  assert.ok(!/x:y/.test(out) && !/blk-bh/.test(out), 'invalid size + colour yield no instance rule');
});

// ---- M12: global email settings ----
test('M12: settings emit body/.wrap overrides AFTER base and still PASS', async () => {
  const doc = { version: 1, settings: { backgroundColor: '#101014', contentWidth: 640 },
    blocks: [{ id: 'b1', type: 'text', props: { heading: 'H', body: 'x' } }] };
  const out = renderDoc(doc);
  const amp = out.ampHtml;
  assert.ok(amp.indexOf('body{background:#101014;}') > amp.indexOf('body{margin:0;background:#f3f3f6'),
    'global body override comes after the base body rule');
  assert.match(amp, /\.wrap\{max-width:640px;\}/);
  const v = await validate(amp);
  assert.strictEqual(v.pass, true, `settings must pass: ${JSON.stringify(v.errors)}`);
});

test('M12: a doc without settings is unchanged; hostile settings are sanitized', () => {
  const plain = renderDoc({ version: 1, blocks: [{ id: 'b1', type: 'text', props: { heading: 'H', body: 'x' } }] }).ampHtml;
  assert.ok(!/body\{background:#101014/.test(plain), 'no settings → no global override');
  const hostile = renderDoc({ version: 1, settings: { backgroundColor: '#fff;} x{y:z', contentWidth: 99999 },
    blocks: [{ id: 'b1', type: 'text', props: { heading: 'H', body: 'x' } }] }).ampHtml;
  assert.ok(!/y:z/.test(hostile), 'hostile bg dropped');
  assert.match(hostile, /\.wrap\{max-width:700px\}|\.wrap\{max-width:700px;\}/, 'width clamps to 700');
});

test('M12: validateDoc keeps only sanitized settings', () => {
  const v = validateDoc({ version: 1, settings: { backgroundColor: '#abcdef', contentWidth: 500, junk: 'x' }, blocks: [] });
  assert.deepStrictEqual(v.doc.settings, { backgroundColor: '#abcdef', contentWidth: 500 });
  const v2 = validateDoc({ version: 1, settings: { nope: 1 }, blocks: [] });
  assert.strictEqual(v2.doc.settings, undefined, 'empty settings are omitted');
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

/* ================================================================== *
 * INTERACTIVE BLOCKS (Genie 2.0 phase 4): the 8 interactive modules
 * as editable blocks composed into the block document.
 * ================================================================== */

function interactiveBlockDoc(type, props = {}, overrides = {}) {
  return {
    version: 1,
    brand: { name: 'Acme', primaryHex: '#4f46e5' },
    currency: 'INR',
    blocks: [{ id: 'ib_' + type, type, props }],
    ...overrides,
  };
}

// ---- each interactive block ALONE passes the REAL validator ------------------

test('each of the eight interactive blocks renders alone and PASSES the real validator (zero errors)', async () => {
  for (const type of INTERACTIVE_IDS) {
    const { ampHtml } = docToAmp(interactiveBlockDoc(type));
    const v = await validate(ampHtml);
    assert.strictEqual(v.pass, true, `${type} interactive block failed: ${JSON.stringify(v.errors, null, 2)}`);
    assert.strictEqual(v.errorCount, 0, `${type} has zero hard errors`);
    // it is genuinely interactive: carries amp-bind + an amp-state + a handler.
    assert.ok(/amp-bind/.test(ampHtml), `${type} pulls in amp-bind`);
    assert.ok(/<amp-state/.test(ampHtml), `${type} declares an amp-state`);
  }
});

test('an interactive block carries exactly ONE <style amp-custom>, one v0.js and one amp-bind script', () => {
  for (const type of INTERACTIVE_IDS) {
    const { ampHtml } = docToAmp(interactiveBlockDoc(type));
    assert.strictEqual((ampHtml.match(/<style amp-custom>/g) || []).length, 1, `${type}: one amp-custom`);
    assert.strictEqual((ampHtml.match(/cdn\.ampproject\.org\/v0\.js/g) || []).length, 1, `${type}: one v0.js`);
    assert.strictEqual((ampHtml.match(/amp-bind-0\.1\.js/g) || []).length, 1, `${type}: one amp-bind`);
  }
});

test('only the search and form interactive blocks pull in amp-form; the rest do not', () => {
  const NEEDS_FORM = new Set(['search', 'form']);
  for (const type of INTERACTIVE_IDS) {
    const { ampHtml } = docToAmp(interactiveBlockDoc(type));
    const forms = (ampHtml.match(/amp-form-0\.1\.js/g) || []).length;
    if (NEEDS_FORM.has(type)) assert.strictEqual(forms, 1, `${type} carries amp-form exactly once`);
    else assert.strictEqual(forms, 0, `${type} carries no amp-form`);
  }
});

// ---- an interactive block composed with static blocks ------------------------

test('a quiz composed with static header+text+footer renders, passes, and has one amp-custom/v0.js/amp-bind', async () => {
  const doc = {
    version: 1, brand: { name: 'Zomato', primaryHex: '#e23744' }, currency: 'INR',
    blocks: [
      { id: 'h', type: 'header', props: { brandName: 'Zomato', link: 'https://zomato.com' } },
      { id: 't', type: 'text', props: { heading: 'Take our quiz', body: 'Find your match in ten seconds.' } },
      { id: 'q', type: 'quiz', props: { head: 'Find your match', question: 'What are you in the mood for?' } },
      { id: 'f', type: 'footer', props: { brandName: 'Zomato', text: 'You opted in.' } },
    ],
  };
  const { ampHtml, warnings } = renderDoc(doc);
  const v = await validate(ampHtml);
  assert.strictEqual(v.pass, true, `composed quiz doc failed: ${JSON.stringify(v.errors, null, 2)}`);
  assert.strictEqual((ampHtml.match(/<style amp-custom>/g) || []).length, 1, 'exactly one amp-custom');
  assert.strictEqual((ampHtml.match(/cdn\.ampproject\.org\/v0\.js/g) || []).length, 1, 'exactly one v0.js');
  assert.strictEqual((ampHtml.match(/amp-bind-0\.1\.js/g) || []).length, 1, 'exactly one amp-bind');
  assert.strictEqual((ampHtml.match(/amp-form-0\.1\.js/g) || []).length, 0, 'no amp-form (quiz needs none)');
  // the static text block still rendered alongside the interactive one
  assert.ok(ampHtml.includes('Take our quiz'), 'the static text heading is present');
  assert.ok(Array.isArray(warnings), 'warnings is an array');
  // amp-custom still under the 75KB cap with a full interactive module + statics
  const cssMatch = ampHtml.match(/<style amp-custom>([\s\S]*?)<\/style>/);
  assert.ok(Buffer.byteLength(cssMatch[1], 'utf8') < 75 * 1024, 'merged amp-custom under 75KB');
});

test('a search block composed with static blocks carries the amp-form script exactly once', async () => {
  const doc = {
    version: 1, brand: { name: 'Acme', primaryHex: '#0a7' }, currency: 'USD',
    blocks: [
      { id: 'h', type: 'header', props: { brandName: 'Acme' } },
      { id: 's', type: 'search', props: { head: 'Search the catalogue' } },
      { id: 'f', type: 'footer', props: { brandName: 'Acme' } },
    ],
  };
  const { ampHtml } = renderDoc(doc);
  const v = await validate(ampHtml);
  assert.strictEqual(v.pass, true, `composed search doc failed: ${JSON.stringify(v.errors, null, 2)}`);
  assert.strictEqual((ampHtml.match(/amp-form-0\.1\.js/g) || []).length, 1, 'amp-form appears exactly once');
  assert.strictEqual((ampHtml.match(/amp-bind-0\.1\.js/g) || []).length, 1, 'amp-bind appears exactly once');
  assert.strictEqual((ampHtml.match(/<style amp-custom>/g) || []).length, 1, 'exactly one amp-custom');
});

// ---- one interactive block per doc enforced ----------------------------------

test('two interactive blocks: validateDoc keeps the first, drops the rest, and notes it', async () => {
  const v = validateDoc({
    version: 1, brand: { name: 'Acme' },
    blocks: [
      { id: 'q', type: 'quiz', props: { question: 'A?' } },
      { id: 'p', type: 'poll', props: { question: 'B?' } },
      { id: 's', type: 'spin', props: {} },
    ],
  });
  assert.strictEqual(v.ok, true);
  const interactive = v.doc.blocks.filter((b) => INTERACTIVE_TYPES.has(b.type));
  assert.strictEqual(interactive.length, 1, 'only one interactive block survives');
  assert.strictEqual(interactive[0].type, 'quiz', 'the FIRST interactive block is the one kept');
  assert.ok((v.doc.notes || []).some((n) => /only one interactive block/.test(n)), 'a note records the drop');
  const { ampHtml } = renderDoc(v.doc);
  const verdict = await validate(ampHtml);
  assert.strictEqual(verdict.pass, true, 'the surviving single-interactive doc still validates');
  assert.strictEqual((ampHtml.match(/<amp-state id="s"/g) || []).length, 1, "only one amp-state id 's' — no collision");
});

test('an interactive block interleaved with statics still yields at most one interactive after validation', () => {
  const v = validateDoc({
    version: 1, brand: { name: 'Acme' },
    blocks: [
      { id: 'h', type: 'header', props: {} },
      { id: 'r', type: 'reveal', props: {} },
      { id: 't', type: 'text', props: { body: 'between' } },
      { id: 'c', type: 'calc', props: {} },
      { id: 'f', type: 'footer', props: {} },
    ],
  });
  const kinds = v.doc.blocks.map((b) => b.type);
  assert.deepStrictEqual(kinds, ['header', 'reveal', 'text', 'footer'], 'reveal kept, calc dropped, statics untouched');
  assert.ok((v.doc.notes || []).some((n) => /only one interactive block/.test(n)));
});

// ---- interactive props sanitize ----------------------------------------------

test('interactive props sanitize: a quiz question with <script> is stripped/encoded and still validates', async () => {
  const v = validateDoc(interactiveBlockDoc('quiz', {
    question: '<script>alert(1)</script>Which mood?',
    unknownProp: 'must be dropped',
    footerText: 'x'.repeat(500), // over the 200 cap
  }));
  assert.strictEqual(v.ok, true);
  const props = v.doc.blocks[0].props;
  assert.ok(!/[<>]/.test(props.question), "angle brackets stripped from the interactive block's question");
  assert.ok(!('unknownProp' in props), 'an unknown prop key is dropped');
  assert.ok(props.footerText.length <= 200, 'over-long field capped at 200 chars');
  const { ampHtml } = renderDoc(v.doc);
  assert.ok(!ampHtml.includes('<script>alert(1)'), 'no raw <script> reaches the markup');
  const verdict = await validate(ampHtml);
  assert.strictEqual(verdict.pass, true, 'the sanitized interactive doc still validates');
});

test('interactive props keep only the module MODULE_FIELDS keys (poll optionA/optionB survive, junk drops)', () => {
  const v = validateDoc(interactiveBlockDoc('poll', {
    optionA: 'Sweet', optionB: 'Savoury', question: 'Which?',
    head: 'Vote', footerText: 'done', bogus: 'no', discount: 999,
  }));
  const props = v.doc.blocks[0].props;
  assert.deepStrictEqual(
    Object.keys(props).sort(),
    ['footerText', 'head', 'optionA', 'optionB', 'question'].sort(),
    'exactly the poll field keys survive',
  );
  assert.strictEqual(props.optionA, 'Sweet');
  assert.strictEqual(props.optionB, 'Savoury');
});

// ---- interactiveDocForModule + fieldsForModule -------------------------------

test('interactiveDocForModule for every module id validates and passes the real validator', async () => {
  for (const id of INTERACTIVE_IDS) {
    const doc = interactiveDocForModule({ brand: { name: 'Groww', primaryHex: '#00b386' }, moduleId: id, currency: 'INR' });
    const vd = validateDoc(doc);
    assert.strictEqual(vd.ok, true, `${id}: interactiveDocForModule is validateDoc-clean`);
    assert.ok(doc.blocks.length === 1 && doc.blocks[0].type === id, `${id}: doc is the single interactive block`);
    const { ampHtml } = renderDoc(doc);
    const v = await validate(ampHtml);
    assert.strictEqual(v.pass, true, `${id}: interactiveDocForModule render failed: ${JSON.stringify(v.errors, null, 2)}`);
  }
});

test('interactiveDocForModule threads brand colour + copy and falls back on a bad module id', () => {
  const doc = interactiveDocForModule({
    brand: { name: 'Zomato', primaryHex: '#e23744' }, moduleId: 'quiz',
    copy: { head: 'Find your dish', question: 'Spice level?' }, currency: 'USD',
  });
  assert.strictEqual(doc.brand.name, 'Zomato');
  assert.strictEqual(doc.brand.primaryHex, '#e23744', 'brand colour rides into the doc');
  assert.strictEqual(doc.currency, 'USD');
  assert.strictEqual(doc.blocks[0].props.head, 'Find your dish', 'copy lands as the block props');
  // a bogus module id degrades to the first module, never an invalid doc
  const bad = interactiveDocForModule({ brand: { name: 'Acme' }, moduleId: 'nope' });
  assert.ok(INTERACTIVE_TYPES.has(bad.blocks[0].type), 'a bad module id falls back to a real interactive type');
  assert.strictEqual(validateDoc(bad).ok, true, 'the fallback doc validates');
});

test('fieldsForModule returns the editable copy field names for each module (a fresh array)', () => {
  assert.deepStrictEqual(fieldsForModule('quiz'), ['head', 'question', 'footerText']);
  assert.deepStrictEqual(fieldsForModule('poll'), ['head', 'question', 'optionA', 'optionB', 'footerText']);
  assert.deepStrictEqual(fieldsForModule('rating'), ['head', 'prompt', 'footerText']);
  assert.deepStrictEqual(fieldsForModule('nope'), [], 'a non-module id yields an empty list');
  const a = fieldsForModule('quiz');
  a.push('mutated');
  assert.deepStrictEqual(fieldsForModule('quiz'), ['head', 'question', 'footerText'], 'the returned array is a copy, not the internal one');
});

test('INTERACTIVE_TYPES is a Set of exactly the generate() module ids', () => {
  assert.ok(INTERACTIVE_TYPES instanceof Set, 'it is a Set');
  assert.strictEqual(INTERACTIVE_TYPES.size, MODULE_IDS.length);
  for (const id of MODULE_IDS) assert.ok(INTERACTIVE_TYPES.has(id), `${id} is a member`);
  assert.ok(!INTERACTIVE_TYPES.has('header'), 'a static type is not a member');
});

// ---- determinism (interactive) -----------------------------------------------

test('determinism: an interactive doc renders byte-identical ampHtml twice', () => {
  for (const id of INTERACTIVE_IDS) {
    const doc = interactiveDocForModule({ brand: { name: 'Acme', primaryHex: '#4f46e5' }, moduleId: id, currency: 'INR' });
    assert.strictEqual(renderDoc(doc).ampHtml, renderDoc(doc).ampHtml, `${id} is byte-stable`);
  }
});

test('determinism: a composed interactive+static doc is byte-identical across renders', () => {
  const doc = {
    version: 1, brand: { name: 'Acme', primaryHex: '#123456' }, currency: 'INR',
    blocks: [
      { id: 'h', type: 'header', props: { brandName: 'Acme' } },
      { id: 'c', type: 'calc', props: { head: 'Plan it' } },
      { id: 'f', type: 'footer', props: { brandName: 'Acme' } },
    ],
  };
  assert.strictEqual(renderDoc(doc).ampHtml, renderDoc(doc).ampHtml);
});

// ---- M2 canvas: renderDoc anchors option (editor-only addressable blocks) ----

test('renderDoc({anchors}) wraps each block in an addressable data-bid element; clean render has none', async () => {
  const doc = {
    version: 1, brand: { name: 'Practo', primaryHex: '#0a8080' },
    blocks: [
      { id: 'b1', type: 'header', props: { brandName: 'Practo' } },
      { id: 'b2', type: 'text', props: { heading: 'Hi', body: 'One question.' } },
      { id: 'b3', type: 'quiz', props: { head: 'Which plan?' } },
      { id: 'b4', type: 'footer', props: { brandName: 'Practo' } },
    ],
  };
  const { doc: clean } = validateDoc(doc);
  const plain = renderDoc(clean);
  const anchored = renderDoc(clean, { anchors: true });

  // clean render (what gets saved/shared) carries NO editor anchors
  assert.ok(!plain.ampHtml.includes('data-bid'), 'saved render must be anchor-free');

  // anchored render (editor canvas) tags every block, and still validates
  const bids = (anchored.ampHtml.match(/data-bid="[^"]+"/g) || []);
  assert.strictEqual(bids.length, 4, 'one anchor per block');
  assert.ok(anchored.ampHtml.includes('data-bid="b3"') && anchored.ampHtml.includes('data-btype="quiz"'),
    'the interactive block is addressable too');
  const v = await validate(anchored.ampHtml);
  assert.strictEqual(v.pass, true, 'anchored render must still pass the real validator');
});
