'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { generate, MODULE_IDS, VERTICALS } = require('../server/generate');
const { validate } = require('../server/validator');

test('every module x every vertical validates AMP4EMAIL with zero errors', async () => {
  const colWidth = 8;
  const header = 'MODULE'.padEnd(14) + VERTICALS.map((v) => v.slice(0, 7).padEnd(colWidth)).join('');
  const rule = '-'.repeat(header.length);
  console.log('\n' + header);
  console.log(rule);

  let total = 0;
  let passed = 0;
  const failures = [];

  for (const moduleId of MODULE_IDS) {
    let line = moduleId.padEnd(14);
    for (const vertical of VERTICALS) {
      const g = generate({ brand: 'Zomato', vertical, tone: 'Playful', currency: 'INR', moduleId });
      const v = await validate(g.ampHtml);
      total++;
      if (v.pass) passed++;
      else failures.push({ moduleId, vertical, errors: v.errors });
      line += (v.pass ? 'PASS' : 'FAIL').padEnd(colWidth);
    }
    console.log(line);
  }
  console.log(rule);
  console.log(`${passed}/${total} passed\n`);

  assert.strictEqual(passed, total, `validator matrix had failures: ${JSON.stringify(failures, null, 2)}`);
});

test('same seed reproduces byte-identical output; a reroll changes it', () => {
  const a = generate({ brand: 'Zomato', vertical: 'Food', tone: 'Playful', currency: 'INR', moduleId: 'reveal', counter: 0 });
  const b = generate({ brand: 'Zomato', vertical: 'Food', tone: 'Playful', currency: 'INR', moduleId: 'reveal', counter: 1 });
  const c = generate({ brand: 'Zomato', vertical: 'Food', tone: 'Playful', currency: 'INR', moduleId: 'reveal', counter: 0 });
  assert.strictEqual(a.ampHtml, c.ampHtml, 'same seed must reproduce identical AMP');
  assert.notStrictEqual(a.ampHtml, b.ampHtml, 'a reroll must change the content');
});

test('AMP4EMAIL structural rules are honoured', () => {
  const g = generate({ brand: 'Acme', vertical: 'Generic', tone: 'Informative', currency: 'USD', moduleId: 'quiz' });
  const html = g.ampHtml;
  assert.match(html, /^<!doctype html>\n<html amp4email data-css-strict>/);
  assert.match(html, /<head>\n<meta charset="utf-8">/);
  assert.ok(!/:root/.test(html), 'must not use :root');
  assert.ok(!/var\(--/.test(html), 'must not use var(--...)');
  assert.ok(!/!important/.test(html), 'must not use !important');
  assert.ok(!/@import/.test(html), 'must not use @import');
  assert.ok(!/<amp-state[^>]+src=/.test(html), 'amp-state must not have a runtime src');
  assert.ok(!/\[src\]/.test(html), 'no bound [src]');
  const cssMatch = html.match(/<style amp-custom>([\s\S]*?)<\/style>/);
  assert.ok(cssMatch, 'amp-custom style present');
  assert.ok(Buffer.byteLength(cssMatch[1], 'utf8') < 75 * 1024, 'amp-custom under 75KB');
  assert.ok(Buffer.byteLength(html, 'utf8') < 200 * 1024, 'document under 200KB');
});
