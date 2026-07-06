'use strict';

// ============================================================================
// Remediation Phase 1 — main-path brand-bleed guard acceptance suite.
//
// Proves: on the PRIMARY /build path (buildProduction — the one the web UI uses),
// every chromatic brand colour in the finished email comes from THIS build's
// GenerationContext, and a colour belonging to another client's identity FAILS
// LOUDLY instead of silently shipping. This is the "#2c4152 for everyone" bug
// class, closed at the generator itself.
// ============================================================================

const { test } = require('node:test');
const assert = require('node:assert');
const assets = require('../server/assets');
const build = require('../server/build');
const { assertContextIsSoleSource, assertProductPairing, BrandBleedError, ProductPairingError, ownedColours } = require('../server/guard');
const { enc } = require('../server/generate');

function buildFor(spec, moduleId) {
  return assets.resolveAssets({ brandName: spec.brandName, vertical: spec.vertical, currency: 'INR', user: {}, need: { logo: true, products: 3 } })
    .then((resolved) => ({ resolved, built: build.buildProduction({ moduleId: moduleId || build.chooseModule(resolved.brand.vertical, (resolved.brand.name || '') + 0), resolved, currency: 'INR' }) }));
}

// G1 — buildProduction wires the guard: a legit build passes (the guard runs
//      INSIDE buildProduction, so a returned build already proved sole-source).
test('G1: buildProduction runs the sole-source guard on every module × brand', async () => {
  const brands = [{ brandName: 'AJIO' }, { brandName: 'Nykaa' }, { brandName: 'Taj Hotels' }, { brandName: 'ICICI Prudential' }, { brandName: 'Kirana Fresh Foods', vertical: 'Food' }];
  for (const spec of brands) {
    const resolved = await assets.resolveAssets({ brandName: spec.brandName, vertical: spec.vertical, currency: 'INR', user: {}, need: { logo: true, products: 3 } });
    for (const moduleId of build.PROD_MODULE_IDS) {
      assert.doesNotThrow(() => build.buildProduction({ moduleId, resolved, currency: 'INR' }),
        `${spec.brandName}/${moduleId} should build without a false-positive bleed error`);
    }
  }
});

// G2 — the guard FAILS LOUDLY (throws, never substitutes) when a foreign client's
//      identity colour appears in the output.
test('G2: a foreign brand colour in output throws BrandBleedError', async () => {
  const { built } = await buildFor({ brandName: 'Nykaa' }, 'reveal');
  // AJIO's slate #2c4152 does NOT belong to Nykaa's context — simulate a leak.
  const bled = built.ampHtml.replace('</style>', '.x{color:#2C4152;}</style>');
  assert.throws(() => assertContextIsSoleSource(bled, built.context), BrandBleedError);
  // and the clean output must still pass
  assert.doesNotThrow(() => assertContextIsSoleSource(built.ampHtml, built.context));
});

// G3 — A→B sequential build (the spec's reproduction): build Client A (AJIO,
//      owns #2c4152), then Client B (a different brand). B's output must be free
//      of A's slate, and B's palette must be B's own.
test('G3: A→B sequential build — Client A colour never appears in Client B output', async () => {
  const A = await buildFor({ brandName: 'AJIO' });
  const B = await buildFor({ brandName: 'Kirana Fresh Foods', vertical: 'Food' });
  const aSlate = '#2c4152';
  const bHexes = new Set((B.built.ampHtml.match(/#[0-9a-fA-F]{3,8}\b/g) || []).map((h) => h.toLowerCase()));
  assert.ok(ownedColours(A.built.context).has(aSlate), 'AJIO should own #2c4152');
  assert.ok(!ownedColours(B.built.context).has(aSlate), 'Client B must not own AJIO slate');
  assert.ok(!bHexes.has(aSlate), 'AJIO slate #2c4152 must NOT appear in Client B output');
});

// G4 — grayscale scaffolding and documented semantic constants are allowed
//      (they are brand-neutral, identical for every client, never a fingerprint).
test('G4: grayscale + documented semantic constants do not trip the guard', async () => {
  const { built } = await buildFor({ brandName: 'Nykaa' }, 'game'); // game module uses the pitch greens
  assert.doesNotThrow(() => assertContextIsSoleSource(built.ampHtml, built.context));
  // a made-up chromatic colour that is neither owned nor semantic still throws
  const foreign = built.ampHtml.replace('</style>', '.x{color:#7a1fd0;}</style>');
  assert.throws(() => assertContextIsSoleSource(foreign, built.context), BrandBleedError);
});

// G5 (Phase 3) — every product image's alt matches the label of the SAME
//      GenerationContext product entry (no independent zipping). Legit build passes.
test('G5: product image ↔ label pairing holds on every module × brand', async () => {
  const brands = [{ brandName: 'AJIO' }, { brandName: 'Nykaa' }, { brandName: 'Taj Hotels' }, { brandName: 'Kirana Fresh Foods', vertical: 'Food' }];
  for (const spec of brands) {
    const resolved = await assets.resolveAssets({ brandName: spec.brandName, vertical: spec.vertical, currency: 'INR', user: {}, need: { logo: true, products: 3 } });
    for (const moduleId of build.PROD_MODULE_IDS) {
      const built = build.buildProduction({ moduleId, resolved, currency: 'INR' });
      assert.doesNotThrow(() => assertProductPairing(built.ampHtml, built.context),
        `${spec.brandName}/${moduleId} product image/label pairing should hold`);
    }
  }
});

// G6 (Phase 3) — a cross-record swap (image of product #0 rendered with product
//      #1's label) FAILS LOUDLY.
test('G6: a product image zipped to a different product\'s label throws', async () => {
  const { built } = await buildFor({ brandName: 'AJIO' }, 'reveal');
  const prods = built.context.assets.filter((a) => a.slot && a.slot.startsWith('product') && a.url);
  assert.ok(prods.length >= 2, 'need at least two product records to swap');
  const url0 = prods[0].url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const label1 = enc(prods[1].alt || '');
  const swapped = built.ampHtml.replace(new RegExp(`(<amp-img[^>]*src="${url0}"[^>]*alt=")[^"]*(")`), `$1${label1}$2`);
  assert.notStrictEqual(swapped, built.ampHtml, 'the swap should have changed the html');
  assert.throws(() => assertProductPairing(swapped, built.context), ProductPairingError);
});

// G7 (Phase 7 regression) — HTML numeric/named character references are NOT
//      colours. `&#163;` (£), `&#8377;` (₹), `&#127881;` (🎉) must never be read
//      as hex and trip a phantom bleed. Regression for the GBP (£ → "#163" →
//      normalises to #116633) false-positive that failed every Burberry build.
test('G7: currency/emoji character references do not trigger a phantom bleed', () => {
  const ctx = { palette: { primary: '#000000', accent: '#d5c4a1', tint: '#e6e6e6', ink: '#1d1d2b', line: '#e6e6ec' } };
  assert.doesNotThrow(() => assertContextIsSoleSource(
    '<p>From &#163;799 &#8377;500 &#8364;20 &#127881; today</p>', ctx),
    'currency/emoji entities must not be misread as colours');
  // but a genuine foreign colour written as a 3-digit CSS hex still throws
  assert.throws(() => assertContextIsSoleSource('<div style="color:#163">x</div>', ctx), BrandBleedError,
    'a real 3-digit chrome hex must still be caught');
});

// G8 (Phase 7 regression) — two DISTINCT product records may legitimately share
//      one category-generic fallback image (thin image supply). Each is internally
//      paired (its own label with its own image), so the shared URL is valid for
//      BOTH labels — the guard must not false-fail; a truly foreign label still does.
test('G8: a fallback image shared by two records passes; a foreign label still throws', () => {
  const ctx = { assets: [
    { slot: 'product0', url: 'https://img/x.jpg', alt: 'Mumbai to Pune' },
    { slot: 'product1', url: 'https://img/x.jpg', alt: 'Delhi to Manali' },
  ] };
  const ok = '<amp-img src="https://img/x.jpg" alt="Mumbai to Pune"></amp-img>'
           + '<amp-img src="https://img/x.jpg" alt="Delhi to Manali"></amp-img>';
  assert.doesNotThrow(() => assertProductPairing(ok, ctx), 'shared fallback image with each own label must pass');
  const bad = '<amp-img src="https://img/x.jpg" alt="Bengaluru to Goa"></amp-img>';
  assert.throws(() => assertProductPairing(bad, ctx), ProductPairingError,
    'a label belonging to no record using that image must still throw');
});
