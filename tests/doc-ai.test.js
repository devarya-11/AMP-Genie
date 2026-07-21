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
const {
  validateDoc, renderDoc, BLOCK_TYPES, INTERACTIVE_TYPES,
} = require('../server/email-doc');
const { validate } = require('../server/validator');
const { verticalStockImageUrl } = require('../server/brand-research');

// GENIE 2.0 rule under test: EVERY doc generateDoc/buildFallbackDoc yields
// carries EXACTLY ONE interactive block (a module id from INTERACTIVE_TYPES),
// renders validator-clean, and never throws. If email-doc's interactive
// exports have not landed yet, INTERACTIVE_TYPES is empty — the assertions
// below would then be vacuous, so guard once and note it. A non-empty set means
// the exports landed; the exact module count is asserted in calc-report.test.js,
// so this stays drift-proof as modules (calc, report, form, …) are added.
const HAS_INTERACTIVE = INTERACTIVE_TYPES instanceof Set && INTERACTIVE_TYPES.size > 0;
const MODULE_IDS = HAS_INTERACTIVE ? [...INTERACTIVE_TYPES] : [];

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

// The doc shape a well-behaved model emits for the interactive contract: a
// `copy` map for the routed module's fields + optional plain-text framing.
function goodLlmResult() {
  return {
    copy: { head: 'Spin for your welcome-back bonus' },
    before: [{ type: 'text', heading: 'Welcome back', body: 'Your streak is waiting — take one tap.' }],
    after: [{ type: 'footer', text: 'You opted in to Groww updates.' }],
  };
}

// The single interactive block in a doc (there must be exactly one).
function interactiveBlocks(doc) {
  const blocks = (doc && Array.isArray(doc.blocks)) ? doc.blocks : [];
  return blocks.filter((b) => INTERACTIVE_TYPES.has(b.type));
}

// The universal invariant: a valid doc with exactly one interactive block that
// renders and passes the REAL AMP validator.
async function assertOneInteractiveValid(doc, label) {
  assert.ok(validateDoc(doc).ok, `${label}: passes validateDoc`);
  const ints = interactiveBlocks(doc);
  assert.strictEqual(ints.length, 1, `${label}: exactly one interactive block`);
  assert.ok(INTERACTIVE_TYPES.has(ints[0].type), `${label}: it is a real module id`);
  for (const b of doc.blocks) assert.ok(BLOCK_TYPES.includes(b.type), `${label}: known block type ${b.type}`);
  const r = renderDoc(doc);
  assert.ok(/^<!doctype html>/.test(r.ampHtml), `${label}: renders an AMP document`);
  const verdict = await validate(r.ampHtml);
  assert.strictEqual(verdict.pass, true, `${label}: passes the real AMP validator`);
}

test('email-doc interactive exports are present (guard for the assertions below)', () => {
  assert.ok(HAS_INTERACTIVE, 'INTERACTIVE_TYPES is the 8-module Set — the interactive contract is live');
});

// ---- buildFallbackDoc: the deterministic interactive floor -------------------

test('buildFallbackDoc yields a validator-clean doc with EXACTLY ONE interactive block', async (t) => {
  if (!HAS_INTERACTIVE) return t.skip('email-doc interactive exports not landed');
  const doc = buildFallbackDoc({ brand: BRAND, brief: 'Convert dormant users to their first SIP', currency: 'INR' });
  await assertOneInteractiveValid(doc, 'fallback');
  assert.strictEqual(doc.brand.name, 'Groww', 'the brand rides into the doc');
  assert.strictEqual(doc.brand.primaryHex, '#00b386', 'the brand colour rides into the doc');
});

test('buildFallbackDoc respects an explicit moduleId', (t) => {
  if (!HAS_INTERACTIVE) return t.skip('no interactive exports');
  for (const id of MODULE_IDS) {
    const doc = buildFallbackDoc({ brand: BRAND, brief: '', moduleId: id });
    const ints = interactiveBlocks(doc);
    assert.strictEqual(ints.length, 1, `fallback for ${id}: one interactive block`);
    assert.strictEqual(ints[0].type, id, `fallback honours moduleId ${id}`);
  }
});

test('buildFallbackDoc routes the brief to a module via the deterministic router', (t) => {
  if (!HAS_INTERACTIVE) return t.skip('no interactive exports');
  const spinDoc = buildFallbackDoc({ brand: BRAND, brief: 'Spin the wheel to win a prize this weekend' });
  assert.strictEqual(interactiveBlocks(spinDoc)[0].type, 'spin', 'a spin brief routes to the spin module');
  const quizDoc = buildFallbackDoc({ brand: BRAND, brief: 'Take our quiz to find your perfect fund' });
  assert.strictEqual(interactiveBlocks(quizDoc)[0].type, 'quiz', 'a quiz brief routes to the quiz module');
});

test('buildFallbackDoc without a brief still yields a valid interactive doc (a sensible default)', async (t) => {
  if (!HAS_INTERACTIVE) return t.skip('no interactive exports');
  const doc = buildFallbackDoc({ brand: { name: 'Acme' }, brief: '' });
  await assertOneInteractiveValid(doc, 'no-brief fallback');
});

test('buildFallbackDoc lets the module stand alone: no sibling grid/intro, catalogue rides the doc brand', (t) => {
  if (!HAS_INTERACTIVE) return t.skip('no interactive exports');
  const doc = buildFallbackDoc({ brand: BRAND, brief: 'weekend offer', moduleId: 'reveal' });
  // The module is the WHOLE email: interactiveBase renders its own header,
  // teaser, interactive content + CTA, real product cards and footer in order.
  // A separate text intro used to sit ABOVE the header and a products grid
  // BELOW the module's footer — the "footer missing / nothing formatted" bug.
  assert.ok(!doc.blocks.some((b) => b.type === 'products'), 'no separate products grid dangles below the module footer');
  assert.ok(!doc.blocks.some((b) => b.type === 'text'), 'no separate text intro sits above the module header');
  assert.strictEqual(doc.blocks.length, 1, 'the interactive module is the only block');
  assert.strictEqual(interactiveBlocks(doc).length, 1, 'still exactly one interactive block');
  // the catalogue still reaches the MODULE via the render-time channel (doc brand)
  assert.ok(Array.isArray(doc.brand.items) && doc.brand.items.length === 2, 'the catalogue rides on the doc brand');
  assert.strictEqual(doc.brand.items[0].name, 'Index Fund Starter', 'the real product name rides through');
});

// Regression ("Take 2"): the catalogue must reach the interactive MODULE's own
// product grid. assembleDoc carries brand.items onto the doc brand, and
// email-doc's renderInteractive forwards it into the module's copy.items — so
// the real product renders INSIDE the module. The module is the whole email now
// (no separate static grid below the footer), so the name appears in the module
// itself. Before the fix the module showed the vertical's synthetics.
test('the generated doc carries the catalogue onto the doc brand AND the module paints it', (t) => {
  if (!HAS_INTERACTIVE) return t.skip('no interactive exports');
  const doc = buildFallbackDoc({ brand: BRAND, brief: 'weekend offer', moduleId: 'reveal', currency: 'INR' });
  assert.ok(Array.isArray(doc.brand.items) && doc.brand.items.length === 2, 'the catalogue rides on the doc brand (the render-time channel)');
  assert.strictEqual(doc.brand.items[0].name, 'Index Fund Starter', 'the real product name survives the trust boundary');
  const amp = renderDoc(doc).ampHtml;
  const count = amp.split('Index Fund Starter').length - 1;
  assert.ok(count >= 1, `the real product renders inside the module (found ${count}x, expected >= 1)`);
});

test('buildFallbackDoc never throws on junk input and still returns a valid interactive doc', (t) => {
  if (!HAS_INTERACTIVE) return t.skip('no interactive exports');
  for (const junk of [undefined, null, {}, { brand: 42 }, { brand: { name: '<script>' } }]) {
    const doc = buildFallbackDoc(junk);
    assert.ok(validateDoc(doc).ok, 'a valid doc for junk: ' + JSON.stringify(junk));
    assert.strictEqual(interactiveBlocks(doc).length, 1, 'still exactly one interactive block for junk: ' + JSON.stringify(junk));
  }
  // a markup-only name degrades to the house default, never poisons the doc
  const doc = buildFallbackDoc({ brand: { name: '<>' } });
  assert.strictEqual(doc.brand.name, 'Acme', 'markup-only brand name -> Acme default');
});

// ---- generateDoc: always an interactive doc, all 8 modules -------------------

test('generateDoc produces a valid one-interactive doc for EVERY module id (offline fallback)', async (t) => {
  if (!HAS_INTERACTIVE) return t.skip('no interactive exports');
  for (const id of MODULE_IDS) {
    const doc = await generateDoc({ brand: BRAND, brief: 'monthly digest', moduleId: id }, { providers: [] });
    await assertOneInteractiveValid(doc, `generateDoc(${id})`);
    assert.strictEqual(interactiveBlocks(doc)[0].type, id, `generateDoc honours moduleId ${id}`);
  }
});

test('generateDoc: opts.moduleId wins over the routed brief', async (t) => {
  if (!HAS_INTERACTIVE) return t.skip('no interactive exports');
  // brief clearly reads "spin", but the explicit poll id must win.
  const doc = await generateDoc({ brand: BRAND, brief: 'spin the wheel to win' }, { providers: [], moduleId: 'poll' });
  assert.strictEqual(interactiveBlocks(doc)[0].type, 'poll', 'explicit opts.moduleId overrides the router');
});

test('generateDoc: the arg moduleId also selects the module', async (t) => {
  if (!HAS_INTERACTIVE) return t.skip('no interactive exports');
  const doc = await generateDoc({ brand: BRAND, brief: 'anything', moduleId: 'rating' }, { providers: [] });
  assert.strictEqual(interactiveBlocks(doc)[0].type, 'rating', 'the arg moduleId selects the module');
});

test('generateDoc: with no module id, the brief router picks the module', async (t) => {
  if (!HAS_INTERACTIVE) return t.skip('no interactive exports');
  const doc = await generateDoc({ brand: BRAND, brief: 'a calculator to estimate your SIP maturity' }, { providers: [] });
  assert.strictEqual(interactiveBlocks(doc)[0].type, 'calc', 'a calculator brief routes to calc');
});

// ---- generateDoc: the LLM tier (interactive copy + framing) ------------------

test('generateDoc merges a GOOD injected LLM result onto the interactive block', async (t) => {
  if (!HAS_INTERACTIVE) return t.skip('no interactive exports');
  const doc = await generateDoc({ brand: BRAND, brief: 'winback', moduleId: 'spin' }, { providers: [fixedProvider(goodLlmResult())] });
  await assertOneInteractiveValid(doc, 'good-llm');
  const spin = interactiveBlocks(doc)[0];
  assert.strictEqual(spin.type, 'spin', 'the routed module is used');
  assert.ok(/welcome-back bonus/i.test(spin.props.head || ''), 'the LLM copy landed on the interactive block');
  // the plain-text framing blocks survived the merge
  assert.ok(doc.blocks.some((b) => b.type === 'text'), 'the LLM text framing block was prepended');
  assert.ok(doc.blocks.some((b) => b.type === 'footer'), 'the LLM footer framing block was appended');
});

test('generateDoc accepts an LLM result returned as a JSON STRING', async (t) => {
  if (!HAS_INTERACTIVE) return t.skip('no interactive exports');
  const doc = await generateDoc({ brand: BRAND, moduleId: 'reveal' }, { providers: [fixedProvider(JSON.stringify({ copy: { head: 'Unlock your reward' } }))] });
  await assertOneInteractiveValid(doc, 'string-llm');
  const reveal = interactiveBlocks(doc)[0];
  assert.ok(/Unlock your reward/i.test(reveal.props.head || ''), 'a stringified LLM result is parsed and merged');
});

test('generateDoc strips markup from LLM copy (defense in depth)', async (t) => {
  if (!HAS_INTERACTIVE) return t.skip('no interactive exports');
  const hostile = { copy: { head: 'Win <script>alert(1)</script> now' }, before: [{ type: 'text', heading: 'Hi <b>x</b>', body: 'Body <img src=x>' }] };
  const doc = await generateDoc({ brand: BRAND, moduleId: 'reveal' }, { providers: [fixedProvider(hostile)] });
  await assertOneInteractiveValid(doc, 'hostile-llm');
  const reveal = interactiveBlocks(doc)[0];
  assert.ok(!/[<>]/.test(reveal.props.head || ''), 'angle brackets stripped from interactive copy');
  const text = doc.blocks.find((b) => b.type === 'text');
  if (text) {
    assert.ok(!/[<>]/.test(text.props.heading || ''), 'angle brackets stripped from framing heading');
    assert.ok(!/[<>]/.test(text.props.body || ''), 'angle brackets stripped from framing body');
  }
  assert.ok(!/<script>alert/.test(renderDoc(doc).ampHtml), 'no raw hostile markup in the rendered AMP');
});

test('generateDoc drops framing blocks that are not hero/text/footer (no doubled header/button/products)', async (t) => {
  if (!HAS_INTERACTIVE) return t.skip('no interactive exports');
  // The module already renders its own header + CTA; a header/button/products in
  // the framing arrays must be dropped, never doubled.
  const sneaky = {
    copy: { head: 'Take the quiz' },
    before: [{ type: 'header', brandName: 'Groww' }, { type: 'button', label: 'Go' }],
    after: [{ type: 'products', columns: 2, items: [{ name: 'X' }] }, { type: 'text', heading: 'Ok', body: 'Fine text.' }],
  };
  const doc = await generateDoc({ brand: BRAND, moduleId: 'quiz' }, { providers: [fixedProvider(sneaky)] });
  await assertOneInteractiveValid(doc, 'sneaky-framing');
  assert.ok(!doc.blocks.some((b) => b.type === 'header'), 'no doubled header block');
  assert.ok(!doc.blocks.some((b) => b.type === 'button'), 'no doubled button block');
  assert.ok(!doc.blocks.some((b) => b.type === 'products'), 'a framing products block was dropped');
  assert.ok(doc.blocks.some((b) => b.type === 'text'), 'the valid text framing block survived');
});

// ---- hero blocks get a REAL image, never the palette placeholder ------------
// Regression for the "bland rectangles / no brand images" report: an AI-drafted
// hero framing block only supplies alt text, so email-doc placeholdered it (and
// pushed 'hero: missing/invalid https imageUrl — used a placeholder') unless
// doc-ai paints a real image from the brand's OWN assets. Cover the source
// priority: real og:image first, else the guaranteed-real vertical stock floor,
// and prove a loremflickr-valued heroUrl is skipped for the more-reliable floor.
test('generateDoc paints a real image into an AI hero block (never the placeholder)', async (t) => {
  if (!HAS_INTERACTIVE) return t.skip('no interactive exports');
  const withHero = { copy: { head: 'Discover your glow' }, before: [{ type: 'hero', alt: 'Hero banner' }] };
  const heroWarn = 'hero: missing/invalid https imageUrl — used a placeholder';

  // (a) a real og:image on the brand's OWN cdn wins outright.
  {
    const brand = { name: 'Nykaa', vertical: 'Beauty', heroUrl: 'https://images.nykaa.com/hero/glow.jpg' };
    const doc = await generateDoc({ brand, brief: 'beauty winback', moduleId: 'reveal' }, { providers: [fixedProvider(withHero)] });
    await assertOneInteractiveValid(doc, 'hero-cdn');
    const hero = doc.blocks.find((b) => b.type === 'hero');
    assert.ok(hero, 'the hero framing block survived the merge');
    assert.strictEqual(hero.props.imageUrl, 'https://images.nykaa.com/hero/glow.jpg', 'hero uses the real CDN og:image');
    assert.ok(!renderDoc(doc).warnings.includes(heroWarn), 'no hero-placeholder warning is emitted');
  }

  // (b) no real asset, only a vertical -> the guaranteed-real vertical stock floor.
  {
    const brand = { name: 'Nykaa', vertical: 'Beauty' };
    const doc = await generateDoc({ brand, brief: 'beauty winback', moduleId: 'reveal' }, { providers: [fixedProvider(withHero)] });
    const hero = doc.blocks.find((b) => b.type === 'hero');
    assert.strictEqual(hero.props.imageUrl, verticalStockImageUrl('Beauty', 600, 400), 'hero falls to the vertical stock floor');
    assert.match(hero.props.imageUrl, /^https:\/\/loremflickr\.com\/600\/400\/cosmetics\?/, 'the floor keys off the real "cosmetics" noun, not a brand-poisoned query');
    assert.ok(!renderDoc(doc).warnings.includes(heroWarn), 'the stock floor is a real image, so no placeholder warning');
  }

  // (c) a loremflickr-valued heroUrl can 404 to a grey default, so it is skipped
  //     for the strictly-more-reliable vertical floor.
  {
    const brand = { name: 'Nykaa', vertical: 'Beauty', heroUrl: 'https://loremflickr.com/600/240/beauty,nykaa?lock=99' };
    const doc = await generateDoc({ brand, brief: 'beauty winback', moduleId: 'reveal' }, { providers: [fixedProvider(withHero)] });
    const hero = doc.blocks.find((b) => b.type === 'hero');
    assert.strictEqual(hero.props.imageUrl, verticalStockImageUrl('Beauty', 600, 400), 'a loremflickr heroUrl is skipped for the reliable floor');
  }

  // (d) the model may omit alt; the hero alt then defaults to the brand name.
  {
    const brand = { name: 'Nykaa', vertical: 'Beauty' };
    const doc = await generateDoc({ brand, brief: 'beauty winback', moduleId: 'reveal' }, { providers: [fixedProvider({ copy: { head: 'x' }, before: [{ type: 'hero' }] })] });
    const hero = doc.blocks.find((b) => b.type === 'hero');
    assert.strictEqual(hero.props.alt, 'Nykaa', 'hero alt defaults to the brand name when the model omits it');
    assert.ok(hero.props.imageUrl, 'the hero still gets a real image');
  }
});

test('generateDoc with a provider returning JUNK still yields a valid interactive doc (fallback)', async (t) => {
  if (!HAS_INTERACTIVE) return t.skip('no interactive exports');
  for (const junk of ['not json at all', { nope: true }, { copy: 'wrong' }, 42, null, { blocks: 'wrong' }]) {
    const doc = await generateDoc({ brand: BRAND, brief: 'weekend sale', moduleId: 'reveal' }, { providers: [fixedProvider(junk)] });
    await assertOneInteractiveValid(doc, 'junk-' + JSON.stringify(junk));
  }
});

test('generateDoc with ZERO providers returns the interactive fallback', async (t) => {
  if (!HAS_INTERACTIVE) return t.skip('no interactive exports');
  const doc = await generateDoc({ brand: BRAND, brief: 'winback', moduleId: 'poll' }, { providers: [] });
  await assertOneInteractiveValid(doc, 'zero-providers');
  assert.strictEqual(interactiveBlocks(doc)[0].type, 'poll');
});

test('generateDoc never throws on a THROWING provider (degrades to the interactive fallback)', async (t) => {
  if (!HAS_INTERACTIVE) return t.skip('no interactive exports');
  const thrower = { name: 'boom', call: async () => { throw new Error('provider exploded'); } };
  const doc = await generateDoc({ brand: BRAND, brief: 'x', moduleId: 'search' }, { providers: [thrower] });
  await assertOneInteractiveValid(doc, 'throwing-provider');
});

test('generateDoc: a null (timed-out-equivalent) provider result -> the interactive fallback', async (t) => {
  if (!HAS_INTERACTIVE) return t.skip('no interactive exports');
  const nullProvider = { name: 'nullp', call: async () => null };
  const doc = await generateDoc({ brand: BRAND, moduleId: 'report' }, { providers: [nullProvider] });
  await assertOneInteractiveValid(doc, 'null-provider');
  assert.strictEqual(interactiveBlocks(doc)[0].type, 'report');
});

test('generateDoc offline with env auto-detect (no keys) returns the interactive fallback', async (t) => {
  if (!HAS_INTERACTIVE) return t.skip('no interactive exports');
  // no opts.providers -> detectProviders() -> no keys set -> empty -> fallback
  const doc = await generateDoc({ brand: BRAND, brief: 'monthly digest', moduleId: 'rating' });
  await assertOneInteractiveValid(doc, 'env-autodetect');
});

test('generateDoc never throws on junk input entirely', async (t) => {
  if (!HAS_INTERACTIVE) return t.skip('no interactive exports');
  for (const junk of [undefined, null, {}, { brand: 42 }, 'nonsense', 7]) {
    const doc = await generateDoc(junk, { providers: [] });
    assert.ok(validateDoc(doc).ok, 'a valid doc for generateDoc junk: ' + JSON.stringify(junk));
    assert.strictEqual(interactiveBlocks(doc).length, 1, 'still exactly one interactive block');
  }
});

test('generateDoc folds a brand voiceSample into the run without breaking the contract', async (t) => {
  if (!HAS_INTERACTIVE) return t.skip('no interactive exports');
  const brandWithVoice = { ...BRAND, voice: 'Calm, confident, jargon-free. Talk to first-time investors like a friend.' };
  const doc = await generateDoc({ brand: brandWithVoice, brief: 'onboarding', moduleId: 'quiz' }, { providers: [fixedProvider(goodLlmResult())] });
  await assertOneInteractiveValid(doc, 'voice-sample');
});
