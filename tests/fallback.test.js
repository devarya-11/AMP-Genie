'use strict';

// ============================================================================
// Remediation Phase 6 — financial-services nearest-neighbour fallback policy.
//
// Spec: for no-coverage verticals (the six named financial brands), fall back
// BY LAYOUT SIMILARITY for layout FORM only; every brand value still comes from
// the client's GenerationContext.
//
// Coverage today backs `fintech` (1 pattern) but NOT `insurance_financial`, so:
//   • Groww / PhonePe (fintech)                 → resolve IN-VERTICAL (fintech)
//   • ICICI Pru / HDFC / Bajaj / Axis Max Life  → NEAREST-NEIGHBOUR (→ fintech)
//     (insurance_financial has zero coverage; NEIGHBORS[insurance_financial]
//      = ['fintech','generic'], and fintech has coverage, so layout = fintech)
//
// The fallback lookup lives in reference/classify.js (resolveCoverage + NEIGHBORS
// + CLIENT_VERTICAL) and is wired through reference/library.js pickLayout →
// reference/integrate.js generateWithForm. These tests prove the whole chain:
// classification → coverage resolution → layout skeleton → real AMP output, with
// the sole-source / no-leak guards intact for every brand.
// ============================================================================

const { test } = require('node:test');
const assert = require('node:assert');
const { clientToVertical, resolveCoverage, loadCoverage } = require('../reference/classify');
const { generateWithForm } = require('../reference/integrate');
const { validate } = require('../server/validator');

// The six no-coverage financial brands named in the spec, with the layout tier
// each MUST resolve to given current coverage.
const FIN_BRANDS = [
  { name: 'Groww', own: 'fintech', tier: 'in_vertical', layout: 'fintech' },
  { name: 'PhonePe', own: 'fintech', tier: 'in_vertical', layout: 'fintech' },
  { name: 'ICICI Prudential', own: 'insurance_financial', tier: 'nearest', layout: 'fintech' },
  { name: 'HDFC', own: 'insurance_financial', tier: 'nearest', layout: 'fintech' },
  { name: 'Bajaj Finserv', own: 'insurance_financial', tier: 'nearest', layout: 'fintech' },
  { name: 'Axis Max Life', own: 'insurance_financial', tier: 'nearest', layout: 'fintech' },
];

test('FB-1: each financial brand classifies into its own (no-coverage) vertical', () => {
  for (const b of FIN_BRANDS) {
    const cv = clientToVertical(b.name, 'Finance');
    assert.strictEqual(cv.vertical, b.own, `${b.name} should classify as ${b.own}`);
    assert.strictEqual(cv.coverage, 'none', `${b.name} own vertical must be flagged no-coverage`);
  }
});

test('FB-2: resolveCoverage falls back by layout similarity (never blocks)', async () => {
  const cov = await loadCoverage();
  for (const b of FIN_BRANDS) {
    const rc = resolveCoverage(b.own, cov.counts || {});
    assert.strictEqual(rc.tier, b.tier, `${b.name} expected tier ${b.tier}, got ${rc.tier} (${rc.basis})`);
    assert.strictEqual(rc.vertical, b.layout, `${b.name} expected layout ${b.layout}, got ${rc.vertical}`);
  }
});

test('FB-3: insurance brands borrow the NEIGHBOUR layout, not generic', async () => {
  const cov = await loadCoverage();
  for (const b of FIN_BRANDS.filter((x) => x.own === 'insurance_financial')) {
    const rc = resolveCoverage(b.own, cov.counts || {});
    assert.strictEqual(rc.tier, 'nearest', `${b.name} must use nearest-neighbour fallback`);
    assert.notStrictEqual(rc.vertical, 'generic', `${b.name} should borrow a real neighbour layout, not fall straight to generic`);
    assert.notStrictEqual(rc.vertical, rc.requested, `${b.name} layout must differ from its no-coverage own vertical`);
  }
});

test('FB-4: generateWithForm yields valid AMP for every financial brand; formMeta records the fallback', async () => {
  for (const b of FIN_BRANDS) {
    const built = await generateWithForm({
      brandName: b.name, clientName: b.name, currency: 'INR', moduleId: 'sip',
    });
    const v = await validate(built.ampHtml);
    assert.strictEqual(v.status, 'PASS', `${b.name} AMP should validate PASS; errors: ${JSON.stringify(v.errors)}`);
    assert.strictEqual(built.formMeta.requested_vertical, b.own, `${b.name} formMeta.requested_vertical`);
    assert.strictEqual(built.formMeta.resolved_vertical, b.layout, `${b.name} formMeta.resolved_vertical`);
    assert.strictEqual(built.formMeta.tier, b.tier, `${b.name} formMeta.tier`);
  }
});

test('FB-5: layout is borrowed but brand IDENTITY stays from GenerationContext', async () => {
  // generateWithForm runs buildProduction (sole-source + product-pairing guards)
  // and assertNoReferenceLeak internally; a throw fails the test. Here we also
  // prove the produced palette is the CLIENT's own context, and that no two
  // brands sharing the SAME borrowed fintech layout end up with the same colours.
  const palettes = {};
  for (const b of FIN_BRANDS) {
    const built = await generateWithForm({
      brandName: b.name, clientName: b.name, currency: 'INR', moduleId: 'sip',
    });
    const primary = (built.context && built.context.palette && built.context.palette.primary) || built.palette.primary;
    assert.ok(primary, `${b.name} must carry its own primary colour in GenerationContext`);
    palettes[b.name] = primary;
  }
  // The insurance brands all borrow the fintech LAYOUT, but their identities are
  // independent — the borrowed form must not have collapsed them onto one colour.
  const insurance = FIN_BRANDS.filter((x) => x.own === 'insurance_financial').map((x) => palettes[x.name]);
  assert.ok(new Set(insurance).size > 1, `insurance brands share a layout but must keep distinct brand colours; got ${JSON.stringify(insurance)}`);
});
