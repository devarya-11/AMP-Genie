'use strict';

// ============================================================================
// Remediation Phase 2 — preview ↔ generator parity.
//
// Architecture (verified in web/app.js + web/preview.js): there is exactly ONE
// generation per request. buildProduction() emits a single `ampHtml`; the web UI
// stores it once (e.ampHtml) and EVERY surface — code panel, live preview,
// validate, copy, download, dispatch — reads the same currentCode(). The preview
// does NOT re-generate: web/preview.js `renderAmp` parses that exact ampHtml,
// copies <style amp-custom> and the body verbatim, and only turns amp-* elements
// into their DOM equivalents for interactivity. So preview cannot show a brand
// value the generator didn't produce.
//
// This test PROVES that by running the REAL browser preview interpreter (loaded
// into jsdom) over the generator's output and asserting the rendered DOM carries
// the GenerationContext's identity (palette + products) and no foreign brand's.
// ============================================================================

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { JSDOM } = require('jsdom');
const assets = require('../server/assets');
const build = require('../server/build');

const PREVIEW_SRC = fs.readFileSync(path.join(__dirname, '..', 'web', 'preview.js'), 'utf8');

// Load the real web/preview.js into a jsdom window, exactly as a browser would,
// and return { window, renderInto(ampHtml) -> rootElement }.
function loadPreview() {
  const dom = new JSDOM('<!DOCTYPE html><body><div id="area"></div></body>');
  const { window } = dom;
  const context = vm.createContext(window); // window is the global; assigning window.X persists
  vm.runInContext(PREVIEW_SRC, context);
  assert.ok(window.GeniePreview && typeof window.GeniePreview.renderAmp === 'function', 'preview.js should expose GeniePreview.renderAmp');
  return {
    window,
    renderInto(ampHtml) {
      const area = window.document.getElementById('area');
      window.GeniePreview.renderAmp(ampHtml, area);
      return area;
    },
  };
}

function buildFor(spec, moduleId) {
  return assets.resolveAssets({ brandName: spec.brandName, vertical: spec.vertical, currency: 'INR', user: {}, need: { logo: true, products: 3 } })
    .then((resolved) => ({ resolved, built: build.buildProduction({ moduleId: moduleId || build.chooseModule(resolved.brand.vertical, (resolved.brand.name || '') + 0), resolved, currency: 'INR' }) }));
}

// P1 — the preview of a generated email carries THAT email's palette (from the
//      single GenerationContext) and none of another client's identity colour.
test('Phase2-P1: preview renders the generator\'s palette, not a foreign brand\'s', async () => {
  const { built } = await buildFor({ brandName: 'Nykaa' }, 'reveal');
  const root = loadPreview().renderInto(built.ampHtml);
  const rendered = root.innerHTML.toLowerCase();
  const primary = built.context.palette.primary.toLowerCase();
  assert.ok(rendered.includes(primary), `preview should contain the context primary ${primary}`);
  // AJIO's slate must not appear — it was never in this GenerationContext
  assert.ok(!rendered.includes('#2c4152'), 'a foreign brand colour must never appear in the preview');
});

// P2 — preview shows the SAME products the GenerationContext carries (image +
//      label come from the generated ampHtml, never re-derived).
test('Phase2-P2: preview product labels match the GenerationContext', async () => {
  const { built } = await buildFor({ brandName: 'AJIO' }, 'reveal');
  const root = loadPreview().renderInto(built.ampHtml);
  const html = root.innerHTML;
  assert.ok(html.length > 200, 'preview should render a non-trivial DOM');
  // A product label from THIS build's GenerationContext (context.assets[].alt)
  // must appear in the preview — the preview reflects the single artifact verbatim.
  const productLabels = (built.context.assets || [])
    .filter((a) => a.slot && a.slot.startsWith('product'))
    .map((a) => a.alt)
    .filter(Boolean);
  assert.ok(productLabels.length > 0, 'context should carry product labels');
  const shown = productLabels.filter((label) => html.includes(label));
  assert.ok(shown.length > 0, `at least one context product label should render in preview (labels: ${productLabels.join(' | ')})`);
});

// P3 — determinism: same GenerationContext ⇒ identical ampHtml ⇒ identical
//      preview. (Same seed reproduces; there is no divergent second generation.)
test('Phase2-P3: same GenerationContext yields byte-identical ampHtml for code + preview', async () => {
  const a = await buildFor({ brandName: 'Taj Hotels' }, 'reveal');
  const b = await buildFor({ brandName: 'Taj Hotels' }, 'reveal');
  assert.strictEqual(a.built.ampHtml, b.built.ampHtml, 'a deterministic build must reproduce exactly (no per-surface drift)');
  const r1 = loadPreview().renderInto(a.built.ampHtml).innerHTML;
  const r2 = loadPreview().renderInto(b.built.ampHtml).innerHTML;
  assert.strictEqual(r1, r2, 'preview of the same ampHtml must be identical');
});
