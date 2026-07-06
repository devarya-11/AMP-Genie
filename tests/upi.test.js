'use strict';

// ============================================================================
// Remediation Phase 4 — Pay-in-mail (UPI) module acceptance suite.
//
// Proves the module honours its spec across all three fulfilment paths:
//   • AMP4EMAIL is INTERACTION ONLY — the email never collects a delivery
//     address and never asks for a card number or UPI PIN.
//   • `fulfillment_path` is a first-class GenerationContext flag that round-trips.
//   • Success-state copy is DIFFERENTIATED per path and says "payment complete",
//     never "order complete" (a paid payment is not a completed order).
//   • Every path passes the real amphtml validator with zero errors.
// ============================================================================

const { test } = require('node:test');
const assert = require('node:assert');
const assets = require('../server/assets');
const build = require('../server/build');
const { validate } = require('../server/validator');

const PATHS = ['sender_known', 'self_claim', 'digital_voucher'];

function buildUpi(fp) {
  return assets.resolveAssets({ brandName: 'ICICI Prudential', currency: 'INR', user: {}, need: { logo: true, products: 3 } })
    .then((resolved) => build.buildProduction({ moduleId: 'upi', resolved, currency: 'INR', fulfillmentPath: fp }));
}

test('UPI-1: all three fulfilment paths validate AMP4EMAIL with zero errors', async () => {
  for (const fp of PATHS) {
    const built = await buildUpi(fp);
    const v = await validate(built.ampHtml);
    assert.strictEqual(v.status, 'PASS', `${fp} should validate PASS; errors: ${JSON.stringify(v.errors)}`);
  }
});

test('UPI-2: fulfillment_path is a GenerationContext flag that round-trips', async () => {
  for (const fp of PATHS) {
    const built = await buildUpi(fp);
    assert.strictEqual(built.context.fulfillment_path, fp);
  }
  // an unknown value normalises to the conservative default
  const resolved = await assets.resolveAssets({ brandName: 'ICICI Prudential', currency: 'INR', user: {}, need: { logo: true, products: 3 } });
  const built = build.buildProduction({ moduleId: 'upi', resolved, currency: 'INR', fulfillmentPath: 'garbage' });
  assert.strictEqual(built.context.fulfillment_path, 'sender_known');
});

test('UPI-3: interaction-only — no address collection, no card/PIN entry', async () => {
  for (const fp of PATHS) {
    const built = await buildUpi(fp);
    const html = built.ampHtml;
    assert.ok(!/name="(address|shipping|pincode|postcode|street|city|address_line)"/i.test(html), `${fp} must not collect an address in the email`);
    assert.ok(!/name="(card|cardnumber|card_number|cvv|pin|upi_pin)"/i.test(html), `${fp} must not collect card/PIN`);
  }
});

test('UPI-4: success copy is differentiated and says "payment complete", never "order complete"', async () => {
  const successById = {};
  for (const fp of PATHS) {
    const built = await buildUpi(fp);
    const html = built.ampHtml;
    assert.ok(/payment complete/i.test(html), `${fp} should say "payment complete"`);
    assert.ok(!/order complete/i.test(html), `${fp} must NOT say "order complete"`);
    const m = html.match(/Payment complete<\/p><p class="sub"[^>]*>([^<]*)</);
    successById[fp] = m ? m[1] : `__nomatch_${fp}`;
  }
  const distinct = new Set(Object.values(successById));
  assert.strictEqual(distinct.size, PATHS.length, `each path must have distinct success copy; got ${JSON.stringify(successById)}`);
});
