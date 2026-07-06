'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { generate, MODULE_IDS, VERTICALS } = require('../server/generate');
const { validate } = require('../server/validator');
const { resolveAssets } = require('../server/assets');
const { buildProduction } = require('../server/build');

test('every module x every vertical validates AMP4EMAIL with zero errors', async () => {
  for (const moduleId of MODULE_IDS) {
    for (const vertical of VERTICALS) {
      const g = generate({ brand: 'Zomato', vertical, tone: 'Playful', currency: 'INR', moduleId });
      const v = await validate(g.ampHtml);
      assert.ok(v.pass, `${moduleId} x ${vertical} failed: ${JSON.stringify(v.errors)}`);
    }
  }
});

test('a production build is a complete, valid AMP4EMAIL with all-HTTPS assets', async () => {
  const resolved = await resolveAssets({ brandName: 'Zomato', need: { logo: true, products: 3 } });
  const built = buildProduction({ moduleId: 'reveal', resolved });
  const v = await validate(built.ampHtml);
  assert.ok(v.pass, `production build failed: ${JSON.stringify(v.errors)}`);

  // No plain-HTTP or data-URI asset may escape into the output; at least one
  // image must be a real HTTPS asset.
  assert.ok(!/src="http:\/\//.test(built.ampHtml), 'a plain-HTTP asset leaked');
  assert.ok(!/src="data:/.test(built.ampHtml), 'a data-URI asset leaked');
  assert.ok(/<amp-img[^>]+src="https:\/\//.test(built.ampHtml), 'expected an HTTPS amp-img');
});

test('the same seed reproduces; a reroll changes the content', async () => {
  const resolved = await resolveAssets({ brandName: 'Zomato', need: { logo: true, products: 3 } });
  const a = buildProduction({ moduleId: 'reveal', resolved, reroll: 0 });
  const b = buildProduction({ moduleId: 'reveal', resolved, reroll: 1 });
  const c = buildProduction({ moduleId: 'reveal', resolved, reroll: 0 });
  assert.strictEqual(a.ampHtml, c.ampHtml, 'same seed must reproduce identical AMP');
  assert.notStrictEqual(a.ampHtml, b.ampHtml, 'a reroll must change the content');
});
