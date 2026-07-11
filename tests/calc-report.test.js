'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { generate, MODULE_IDS, VERTICALS, pickModuleId } = require('../server/generate');
const { validate } = require('../server/validator');
const { routeBrief } = require('../server/brief-router');
const { buildFallback } = require('../server/fallback');

const ORIGINAL_SIX = ['reveal', 'search', 'quiz', 'rating', 'spin', 'poll'];

// ---- registry: appended, never reshuffled -----------------------------------

test('calc and report are registered AFTER the original six, in order', () => {
  assert.deepStrictEqual(MODULE_IDS.slice(0, 6), ORIGINAL_SIX);
  assert.deepStrictEqual(MODULE_IDS.slice(6), ['calc', 'report']);
});

test('the seeded random pick never lands on calc/report — existing seeds keep their module', () => {
  const pool = new Set(ORIGINAL_SIX);
  for (const brand of ['Zomato', 'Groww', 'Nykaa', 'Acme', 'Practo']) {
    for (let counter = 0; counter < 40; counter++) {
      const picked = pickModuleId({ brand, counter });
      assert.ok(pool.has(picked), `pickModuleId(${brand}, ${counter}) picked ${picked}`);
      const g = generate({ brand, counter });
      assert.strictEqual(g.moduleId, picked, 'generate() must agree with pickModuleId');
    }
  }
});

// ---- encoding + size discipline ---------------------------------------------

test('calc/report output is pure ASCII end to end and under the Gmail clip budget', () => {
  for (const moduleId of ['calc', 'report']) {
    for (const vertical of VERTICALS) {
      const g = generate({ brand: 'Café Coffee Day', vertical, tone: 'Premium', currency: 'INR', moduleId, counter: 2 });
      for (const ch of g.ampHtml) {
        assert.ok(ch.codePointAt(0) <= 127, `${moduleId}/${vertical} carries raw codepoint ${ch.codePointAt(0)}`);
      }
      assert.ok(Buffer.byteLength(g.ampHtml, 'utf8') < 102400, `${moduleId}/${vertical} must stay under ~102KB`);
    }
  }
});

test('copy overrides land entity-encoded in calc, markup chars neutralised', () => {
  const g = generate({
    brand: 'Zomato', vertical: 'Food', moduleId: 'calc', counter: 0,
    copy: { head: 'Café savings — ₹ tested', promptText: 'Touché & <tags> stay text' },
  });
  assert.ok(g.ampHtml.includes('Caf&#233; savings &#8212; &#8377; tested'), 'head is entity-encoded');
  assert.ok(g.ampHtml.includes('Touch&#233; &amp; &lt;tags&gt; stay text'), 'prompt is entity-encoded');
  assert.ok(!g.ampHtml.includes('é') && !g.ampHtml.includes('₹'), 'no raw glyphs survive');
});

// ---- determinism -------------------------------------------------------------

test('same seed is byte-identical; a reroll changes both new modules', () => {
  for (const moduleId of ['calc', 'report']) {
    const opts = { brand: 'Groww', vertical: 'Finance', tone: 'Playful', currency: 'INR', moduleId };
    const a = generate({ ...opts, counter: 0 });
    const b = generate({ ...opts, counter: 1 });
    const c = generate({ ...opts, counter: 0 });
    assert.strictEqual(a.ampHtml, c.ampHtml, `${moduleId}: same seed must reproduce identical AMP`);
    assert.notStrictEqual(a.ampHtml, b.ampHtml, `${moduleId}: a reroll must change the content`);
  }
});

// ---- calc: the lookup table IS the formula ------------------------------------

test('calc SIP maths is precomputed correctly into the state and previewModel', () => {
  const g = generate({ brand: 'Groww', vertical: 'Finance', moduleId: 'calc', counter: 0 });
  const pm = g.previewModel;
  assert.strictEqual(pm.calcType, 'sip');
  const A = pm.aVals.length;
  const B = pm.bVals.length;
  assert.strictEqual(pm.big.length, A * B, 'one big string per combo');
  assert.strictEqual(pm.sub.length, A * B, 'one working line per combo');
  // a = ₹1,000/mo (index 0), b = 10 yrs (index 3), 12% p.a. compounded monthly
  const fv = Math.round(1000 * (((Math.pow(1.01, 120) - 1) / 0.01) * 1.01));
  const grouped = String(fv).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  assert.strictEqual(pm.big[0 * B + 3], '₹' + grouped, 'previewModel carries the raw-glyph FV');
  assert.ok(g.ampHtml.includes('\\u20b9' + grouped), 'amp-state carries the same FV as a \\u20b9 JSON escape');
  assert.ok(g.ampHtml.includes(`[text]="d.big[s.a * ${B} + s.b]"`), 'bind only does index arithmetic');
  assert.ok(!/toFixed|Math\.|toLocaleString/.test(g.ampHtml), 'no number formatting reaches amp-bind');
});

test('calc plan maths bakes zero-usage, break-even and savings branches into the table', () => {
  const g = generate({
    brand: 'Acme', vertical: 'Generic', moduleId: 'calc', counter: 0,
    copy: { calcType: 'plan', aOptions: [0, 2, 4], bOptions: [1, 2], perUseFee: 100, planPrice: 200 },
  });
  const pm = g.previewModel;
  const B = pm.bVals.length;
  assert.strictEqual(B, 2);
  assert.strictEqual(pm.big[0 * B + 0], '₹200/mo', 'zero usage shows the flat plan price');
  assert.strictEqual(pm.big[1 * B + 0], 'Break-even', '2 uses x ₹100 equals the ₹200 plan');
  assert.strictEqual(pm.big[2 * B + 1], '₹600', '8 uses x ₹100 minus ₹200 plan');
});

test('calc margin override bakes the funding split and validates', async () => {
  const g = generate({
    brand: 'Groww', vertical: 'Finance', moduleId: 'calc', counter: 1,
    copy: { calcType: 'margin', aOptions: [34, 68], bOptions: [1, 2, 4], unitPrice: 434, ratePct: 14.95 },
  });
  const pm = g.previewModel;
  assert.strictEqual(pm.calcType, 'margin');
  assert.strictEqual(pm.bVals[2], '4x');
  assert.strictEqual(pm.big[0 * 3 + 2], '₹3,689', '34 x ₹434 at 4x leverage');
  assert.ok(pm.sub[0 * 3 + 2].includes('14.95% p.a.'), 'the working line carries the funding rate');
  const v = await validate(g.ampHtml);
  assert.strictEqual(v.pass, true, JSON.stringify(v.errors));
});

test('calc: hostile numeric overrides degrade to defaults, never NaN', () => {
  const g = generate({
    brand: 'Groww', vertical: 'Finance', moduleId: 'calc', counter: 0,
    copy: { aOptions: ['a', NaN, {}], bOptions: [1e99], ratePct: 'twelve', perUseFee: -5 },
  });
  const pm = g.previewModel;
  assert.strictEqual(pm.aVals.length, 5, 'falls back to the vertical axis');
  assert.strictEqual(pm.bVals.length, 7, 'falls back to the vertical axis');
  assert.ok(!JSON.stringify(pm).includes('NaN'), 'no NaN anywhere in the model');
  assert.ok(!g.ampHtml.includes('NaN'), 'no NaN anywhere in the document');
});

test('calc: ctaHref renders a deep link instead of the latch; junk hrefs do not', () => {
  const linked = generate({
    brand: 'Groww', vertical: 'Finance', moduleId: 'calc', counter: 0,
    copy: { ctaHref: 'https://groww.in/sip', ctaLabel: 'Continue on Groww' },
  });
  assert.ok(linked.ampHtml.includes('<a class="btn" href="https://groww.in/sip"'), 'http(s) href becomes a link CTA');
  const junk = generate({
    brand: 'Groww', vertical: 'Finance', moduleId: 'calc', counter: 0,
    copy: { ctaHref: 'javascript:alert(1)' },
  });
  assert.ok(!junk.ampHtml.includes('javascript:'), 'non-http(s) URLs never reach the markup');
  assert.ok(junk.ampHtml.includes('AMP.setState({s:{done:true}})'), 'falls back to the latch button');
});

// ---- report: gated state machine ----------------------------------------------

test('report markup carries the single-open accordion, gate and slot-echo machinery', () => {
  const g = generate({ brand: 'Practo', vertical: 'Generic', moduleId: 'report', counter: 0 });
  const html = g.ampHtml;
  assert.ok(html.includes('AMP.setState({s:{open: s.open == 0 ? -1 : 0}})'), 'row 0 toggles single-open');
  assert.match(html, /<div class="rdetail" hidden \[hidden\]="s\.open != 0">/, 'details are server-hidden with a bound override');
  assert.ok(html.includes('s.sel &gt;= 0'), 'the CTA is gated on a picked slot (entity-encoded comparison)');
  assert.ok(html.includes("+ d.slotLabels[s.sel]"), 'the CTA echoes the picked slot back');
  assert.ok(html.includes('<amp-state id="d">'), 'slot labels ride in the data state');
  assert.ok(html.includes('class="btn off"'), 'the CTA server-renders in its disabled look');
});

test('report: copy.rows override drives rows, coerces status, recomputes the verdict, validates', async () => {
  const rows = [
    { name: 'HbA1c', value: '6.1', unit: '%', range: '4.0-5.6%', status: 'attention', detail: 'Slightly above target — a movie, not a snapshot.' },
    { name: 'Vitamin D', value: '34 ng/mL', status: 'weird', detail: 'Comfortably in range.' },
    { name: 'LDL cholesterol', value: '96 mg/dL', status: 'normal' },
  ];
  const g = generate({
    brand: 'Practo', vertical: 'Generic', moduleId: 'report', counter: 0,
    copy: { rows, itemNoun: 'markers', statusLabels: { normal: 'In range', attention: 'Needs a look' } },
  });
  const pm = g.previewModel;
  assert.strictEqual(pm.rows.length, 3);
  assert.strictEqual(pm.rows[1].status, 'normal', 'unknown status coerces to normal');
  assert.strictEqual(pm.attnCount, 1);
  assert.ok(pm.verdictText.startsWith('1 of 3 markers'), 'verdict is recomputed from the override rows');
  assert.ok(g.ampHtml.includes('HbA1c'), 'override rows render');
  assert.ok(g.ampHtml.includes('Needs a look'), 'status labels render');
  const v = await validate(g.ampHtml);
  assert.strictEqual(v.pass, true, JSON.stringify(v.errors));
});

test('report: a malformed rows override is ignored whole, vertical rows render instead', () => {
  const bad = [{ name: 'x', value: 'y' }, { name: '', value: 'z' }, { notARow: true }];
  const g = generate({ brand: 'Practo', vertical: 'Finance', moduleId: 'report', counter: 3, copy: { rows: bad } });
  assert.strictEqual(g.previewModel.rows.length, 4, 'falls back to the sampled vertical rows');
  assert.ok(!g.ampHtml.includes('notARow'));
});

test('report: all-normal rows produce the green all-clear verdict', () => {
  const rows = [
    { name: 'A', value: '1', status: 'normal' },
    { name: 'B', value: '2', status: 'normal' },
    { name: 'C', value: '3', status: 'normal' },
  ];
  const g = generate({ brand: 'Acme', vertical: 'Generic', moduleId: 'report', counter: 0, copy: { rows, itemNoun: 'checks' } });
  assert.strictEqual(g.previewModel.attnCount, 0);
  assert.ok(g.previewModel.verdictText.startsWith('All 3 checks look good'));
  assert.ok(g.ampHtml.includes('background:#e4f0ea'), 'verdict panel bakes the green tint');
});

// ---- brief routing --------------------------------------------------------------

test('calculator/statement briefs route to the new modules; no-signal briefs still return null', () => {
  assert.strictEqual(routeBrief('an EMI calculator for festive carts', 'Generic').moduleId, 'calc');
  assert.strictEqual(routeBrief('how much would a monthly SIP grow? let users estimate savings', 'Finance').moduleId, 'calc');
  assert.strictEqual(routeBrief('monthly portfolio statement email with lab-style results summary', 'Finance').moduleId, 'report');
  assert.strictEqual(routeBrief('an order status report right in the inbox', 'Fashion').moduleId, 'report');
  assert.strictEqual(routeBrief('Just a generic weekend sale announcement', 'Generic'), null);
});

// ---- fallback MIME parts ---------------------------------------------------------

test('fallback: calc collapses to its tier table, report to rows + verdict, in both parts', () => {
  const gc = generate({ brand: 'Groww', vertical: 'Finance', moduleId: 'calc', counter: 0 });
  const fc = buildFallback({
    brand: gc.brand, moduleId: 'calc', moduleName: gc.moduleName,
    palette: gc.palette, previewModel: gc.previewModel, currency: gc.currency,
  });
  assert.ok(fc.html.includes('&#8377;'), 'calc html carries the entity rupee');
  assert.ok(fc.html.indexOf('₹') === -1, 'calc html has no raw glyph');
  for (const label of gc.previewModel.aVals) {
    assert.ok(fc.text.includes(label), `calc text lists tier ${label}`);
  }
  assert.ok(fc.text.includes(gc.previewModel.assumptionText), 'calc text carries the assumption line');

  const gr = generate({ brand: 'Groww', vertical: 'Finance', moduleId: 'report', counter: 0 });
  const fr = buildFallback({
    brand: gr.brand, moduleId: 'report', moduleName: gr.moduleName,
    palette: gr.palette, previewModel: gr.previewModel, currency: gr.currency,
  });
  for (const r of gr.previewModel.rows) {
    assert.ok(fr.text.includes(r.name), `report text lists ${r.name}`);
    assert.ok(fr.text.includes(r.value), `report text carries the value ${r.value}`);
  }
  assert.ok(fr.text.includes(gr.previewModel.verdictText), 'report text carries the verdict');
  assert.ok(fr.html.includes('#fff3dc') || fr.html.includes('#e4f0ea'), 'report html bakes semantic status tints');
});
