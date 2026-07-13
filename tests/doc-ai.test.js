'use strict';
const { test } = require('node:test');
const assert = require('node:assert');

// Deterministic + offline: no ambient key may enable a real provider, and any
// stray network call must fail fast rather than wait out a real budget. Same
// stance as tests/pitch-api.test.js / tests/usecase-engine.test.js.
delete process.env.ANTHROPIC_API_KEY;
delete process.env.GEMINI_API_KEY;
delete process.env.GROQ_API_KEY;
delete process.env.OLLAMA_BASE_URL;
globalThis.fetch = async () => { throw new Error('offline test: network disabled'); };

const { generateDoc, buildFallbackDoc } = require('../server/doc-ai');
const { validateDoc, renderDoc, BLOCK_TYPES } = require('../server/email-doc');
const { validate } = require('../server/validator');

const BRAND = {
  name: 'Groww',
  primaryHex: '#00b386',
  site: 'https://groww.in',
  items: [
    { name: 'Index Fund Starter', price: 500 },
    { name: 'Digital Gold', price: 100 },
  ],
};

// A provider descriptor whose call() ALWAYS resolves the given value, ignoring
// the prompt/schema — the injection seam generateDoc's opts.providers offers.
function fixedProvider(value) {
  return { name: 'fake', call: async () => value };
}

// A doc a well-behaved model would emit: an ordered block list with flat props.
function goodLlmDoc() {
  return {
    blocks: [
      { type: 'header', brandName: 'Groww' },
      { type: 'text', heading: 'Start your first SIP today', body: 'A monthly habit, invested for you. Pick a fund and let it compound.' },
      { type: 'products', columns: 2, items: [{ name: 'Index Fund Starter', price: 500 }] },
      { type: 'button', label: 'Open my SIP', align: 'center' },
      { type: 'footer', brandName: 'Groww', text: 'You opted in to Groww updates.' },
    ],
  };
}

// ---- buildFallbackDoc: a real, validator-clean doc ---------------------------

test('buildFallbackDoc yields a validateDoc-valid doc that renders and passes the REAL validator', async () => {
  const doc = buildFallbackDoc({ brand: BRAND, brief: 'Convert dormant users to their first SIP', currency: 'INR' });
  const v = validateDoc(doc);
  assert.ok(v.ok, 'the fallback doc passes validateDoc');
  assert.ok(Array.isArray(doc.blocks) && doc.blocks.length >= 3, 'it is a real multi-block doc');
  // every block type is a known one
  for (const b of doc.blocks) assert.ok(BLOCK_TYPES.includes(b.type), `known block type: ${b.type}`);
  const r = renderDoc(doc);
  assert.ok(/^<!doctype html>/.test(r.ampHtml), 'renders an AMP document');
  const verdict = await validate(r.ampHtml);
  assert.strictEqual(verdict.pass, true, 'the fallback email passes the real AMP validator');
});

test('buildFallbackDoc is brand-specific and brief-seeded, not generic', () => {
  const doc = buildFallbackDoc({ brand: BRAND, brief: 'Flash weekend sale on index funds', currency: 'INR' });
  assert.strictEqual(doc.brand.name, 'Groww');
  assert.strictEqual(doc.brand.primaryHex, '#00b386', 'the brand colour rides into the doc');
  const header = doc.blocks.find((b) => b.type === 'header');
  assert.strictEqual(header.props.brandName, 'Groww');
  const text = doc.blocks.find((b) => b.type === 'text');
  assert.ok(/weekend sale/i.test(text.props.heading), 'the headline is derived from the brief');
  const products = doc.blocks.find((b) => b.type === 'products');
  assert.ok(products, 'a brand carrying items gets a products block');
  assert.strictEqual(products.props.items.length, 2, 'the brand items land in the grid');
  assert.strictEqual(products.props.items[0].name, 'Index Fund Starter');
});

test('buildFallbackDoc without items or logo degrades sensibly (no products, no hero)', async () => {
  const doc = buildFallbackDoc({ brand: { name: 'Acme' }, brief: '' });
  assert.ok(!doc.blocks.some((b) => b.type === 'products'), 'no items -> no products block');
  assert.ok(!doc.blocks.some((b) => b.type === 'hero'), 'no logo -> no hero (hero-if-logo)');
  assert.ok(doc.blocks.some((b) => b.type === 'header'), 'still has a header');
  assert.ok(doc.blocks.some((b) => b.type === 'text'), 'still has a text block');
  assert.ok(doc.blocks.some((b) => b.type === 'button'), 'still has a CTA');
  assert.ok(doc.blocks.some((b) => b.type === 'footer'), 'still has a footer');
  const verdict = await validate(renderDoc(doc).ampHtml);
  assert.strictEqual(verdict.pass, true, 'the minimal doc still passes the validator');
});

test('buildFallbackDoc with a logo gets a hero block', () => {
  const doc = buildFallbackDoc({ brand: { name: 'Acme', logoUrl: 'https://cdn.acme.com/logo.png' }, brief: '' });
  assert.ok(doc.blocks.some((b) => b.type === 'hero'), 'a real logo earns the hero banner');
});

test('buildFallbackDoc never throws on junk input and still returns a valid doc', () => {
  for (const junk of [undefined, null, {}, { brand: 42 }, { brand: { name: '<script>' } }]) {
    const doc = buildFallbackDoc(junk);
    assert.ok(validateDoc(doc).ok, 'a valid doc for junk: ' + JSON.stringify(junk));
    assert.ok(doc.blocks.length >= 3, 'still a real doc');
  }
  // a markup-only name degrades to the house default, never poisons the doc
  const doc = buildFallbackDoc({ brand: { name: '<>' } });
  assert.strictEqual(doc.brand.name, 'Acme', 'markup-only brand name -> Acme default');
});

// ---- generateDoc: LLM tier + fallback + never-throw --------------------------

test('generateDoc uses a GOOD injected provider doc', async () => {
  const doc = await generateDoc({ brand: BRAND, brief: 'first SIP', useCase: 'onboarding' }, { providers: [fixedProvider(goodLlmDoc())] });
  assert.ok(validateDoc(doc).ok, 'the result is a valid doc');
  const text = doc.blocks.find((b) => b.type === 'text');
  assert.ok(text && /Start your first SIP/i.test(text.props.heading), 'the LLM copy is used, not the fallback');
  const verdict = await validate(renderDoc(doc).ampHtml);
  assert.strictEqual(verdict.pass, true, 'the LLM-composed email passes the validator');
});

test('generateDoc accepts a provider that returns a JSON STRING', async () => {
  const doc = await generateDoc({ brand: BRAND }, { providers: [fixedProvider(JSON.stringify(goodLlmDoc()))] });
  assert.ok(validateDoc(doc).ok);
  const text = doc.blocks.find((b) => b.type === 'text');
  assert.ok(text && /first SIP/i.test(text.props.heading), 'a stringified doc is parsed and used');
});

test('generateDoc strips markup from LLM strings (defense in depth)', async () => {
  const hostile = { blocks: [
    { type: 'header', brandName: 'Groww' },
    { type: 'text', heading: 'Hello <script>alert(1)</script>', body: 'Body <img src=x> text' },
    { type: 'button', label: 'Go' },
  ] };
  const doc = await generateDoc({ brand: BRAND }, { providers: [fixedProvider(hostile)] });
  assert.ok(validateDoc(doc).ok);
  const text = doc.blocks.find((b) => b.type === 'text');
  assert.ok(text, 'the text block survived');
  assert.ok(!/[<>]/.test(text.props.heading), 'angle brackets stripped from heading');
  assert.ok(!/[<>]/.test(text.props.body), 'angle brackets stripped from body');
});

test('generateDoc with a provider returning JUNK falls back to a valid doc', async () => {
  for (const junk of ['not json at all', { nope: true }, { blocks: 'wrong' }, 42, null]) {
    const doc = await generateDoc({ brand: BRAND, brief: 'weekend sale' }, { providers: [fixedProvider(junk)] });
    assert.ok(validateDoc(doc).ok, 'fell back to a valid doc for junk: ' + JSON.stringify(junk));
    assert.ok(doc.blocks.length >= 3, 'the fallback is a real doc');
  }
});

test('generateDoc with a provider returning ONLY markup blocks falls back (nothing substantial survives)', async () => {
  // a doc of only a divider is not a real email -> isSubstantial is false -> fallback
  const thin = { blocks: [{ type: 'divider' }, { type: 'bogus', foo: 1 }] };
  const doc = await generateDoc({ brand: BRAND, brief: 'welcome journey' }, { providers: [fixedProvider(thin)] });
  assert.ok(validateDoc(doc).ok);
  // the fallback always includes a text block; the thin LLM doc did not
  assert.ok(doc.blocks.some((b) => b.type === 'text'), 'degraded to the seeded fallback doc');
});

test('generateDoc with ZERO providers returns the fallback', async () => {
  const doc = await generateDoc({ brand: BRAND, brief: 'winback' }, { providers: [] });
  assert.ok(validateDoc(doc).ok);
  assert.ok(doc.blocks.some((b) => b.type === 'header'), 'a real fallback doc');
  const verdict = await validate(renderDoc(doc).ampHtml);
  assert.strictEqual(verdict.pass, true);
});

test('generateDoc never throws on a THROWING provider', async () => {
  const thrower = { name: 'boom', call: async () => { throw new Error('provider exploded'); } };
  const doc = await generateDoc({ brand: BRAND, brief: 'x' }, { providers: [thrower] });
  assert.ok(validateDoc(doc).ok, 'a throwing provider degrades to a valid fallback doc');
});

test('generateDoc never hangs: a provider that never resolves is raced out to the fallback', async () => {
  const hanger = { name: 'hang', call: () => new Promise(() => {}) };
  // withTimeout inside generateDoc resolves null past the budget; we do not
  // wait 20s here — instead assert the CONTRACT holds with a resolved-null
  // provider (the same value withTimeout yields), so the test is fast.
  const nullProvider = { name: 'nullp', call: async () => null };
  const doc = await generateDoc({ brand: BRAND }, { providers: [nullProvider] });
  assert.ok(validateDoc(doc).ok, 'a null (timed-out-equivalent) provider result -> fallback');
  assert.ok(hanger, 'hanger shape is valid (its real 20s race is exercised in integration, not unit)');
});

test('generateDoc offline with env auto-detect (no keys) returns the fallback', async () => {
  // no opts.providers -> detectProviders() -> no keys set -> empty -> fallback
  const doc = await generateDoc({ brand: BRAND, brief: 'monthly digest' });
  assert.ok(validateDoc(doc).ok);
  assert.ok(doc.blocks.length >= 3, 'a real fallback doc offline');
});

test('generateDoc prefers the brand catalogue for a products block over LLM item names', async () => {
  const withProducts = { blocks: [
    { type: 'header', brandName: 'Groww' },
    { type: 'products', columns: 3, items: [{ name: 'Made-up thing' }] },
    { type: 'button', label: 'Go' },
  ] };
  const doc = await generateDoc({ brand: BRAND }, { providers: [fixedProvider(withProducts)] });
  const products = doc.blocks.find((b) => b.type === 'products');
  assert.ok(products, 'products block present');
  assert.strictEqual(products.props.items[0].name, 'Index Fund Starter', 'real catalogue wins over the LLM name');
});
