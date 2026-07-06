'use strict';

// ============================================================================
// Remediation Phase 7 — pre-re-host validation.
//
// Generate ONE campaign per named vertical through the SAME path the app uses
// (reference/integrate.generateWithForm → server/build.buildProduction), and for
// each assert:
//   • real amphtml-validator → PASS (zero errors)
//   • assertContextIsSoleSource → no brand-colour bleed (every chrome colour from
//     this build's GenerationContext)
//   • assertProductPairing → every product image carries its own record's label
//
// generateWithForm already runs the two main-path guards internally (a bleed or
// mismatch throws before it returns) plus reference/assert's no-leak guard; we
// re-run the two colour/pairing guards here as belt-and-braces so a failure is
// attributed to the exact vertical. Run directly:  node tests/phase7-verticals.js
// ============================================================================

const { generateWithForm } = require('../reference/integrate');
const { validate } = require('../server/validator');
const { assertContextIsSoleSource, assertProductPairing } = require('../server/guard');

// One representative brand per vertical the spec enumerates.
const CAMPAIGNS = [
  { vertical: 'fashion/beauty',   brandName: 'AJIO',             currency: 'INR' },
  { vertical: 'fashion/beauty',   brandName: 'Nykaa',            currency: 'INR' },
  { vertical: 'luxury',           brandName: 'Burberry',         currency: 'GBP' },
  { vertical: 'hospitality',      brandName: 'Taj Hotels',       currency: 'INR' },
  { vertical: 'food delivery',    brandName: 'Zomato',           currency: 'INR' },
  { vertical: 'travel',           brandName: 'RedBus',           currency: 'INR' },
  { vertical: 'financial svcs',   brandName: 'ICICI Prudential', currency: 'INR' },
];

async function run() {
  let allPass = true;
  const rows = [];
  for (const c of CAMPAIGNS) {
    let status = 'PASS', detail = '';
    try {
      const b = await generateWithForm({ brandName: c.brandName, clientName: c.brandName, currency: c.currency, moduleId: 'auto' });
      const v = await validate(b.ampHtml);
      assertContextIsSoleSource(b.ampHtml, b.context); // redundant belt-and-braces
      assertProductPairing(b.ampHtml, b.context);
      if (v.status !== 'PASS') { status = 'FAIL'; detail = `AMP errors: ${JSON.stringify(v.errors)}`; }
      else detail = `mod=${b.moduleId} layout=${b.formMeta.resolved_vertical} tier=${b.formMeta.tier}`;
    } catch (e) {
      status = 'FAIL'; detail = `${e.name}: ${e.message}`;
    }
    if (status !== 'PASS') allPass = false;
    rows.push({ vertical: c.vertical, brand: c.brandName, status, detail });
  }
  for (const r of rows) {
    console.log(r.status.padEnd(5), r.vertical.padEnd(15), r.brand.padEnd(17), r.detail);
  }
  console.log('\n' + (allPass
    ? 'PHASE 7 PASS — every vertical validates AMP with zero bleed / divergence / mismatch'
    : 'PHASE 7 FAIL — see rows above'));
  return allPass;
}

if (require.main === module) {
  run().then((ok) => process.exit(ok ? 0 : 1)).catch((e) => { console.error(e); process.exit(1); });
}

module.exports = { run, CAMPAIGNS };
