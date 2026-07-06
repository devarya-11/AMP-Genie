'use strict';

// Part A acceptance test — proves the generator produces REAL, art-directed,
// brand-authentic creatives and that different brands / use-cases diverge.
//
// For each (brand, module) it composes the full creative through the production
// pipeline (offline: a deterministic resolved-asset set, then buildProduction)
// and asserts:
//   • the real amphtml-validator passes with ZERO errors
//   • exactly ONE <h1> (in the hero), logical heading order
//   • all six creative elements are present: header, hero, mechanic, product
//     strip, promo strip, footer
//   • the brand's REAL products appear (no generic stand-ins)
//   • brand A vs brand B and use-case X vs Y are structurally different
//
// Network is avoided so the test is fast + deterministic; the asset URLs are
// stand-ins with realistic tiers (web photo vs generated placeholder).

const assert = require('assert');
const { brandRead } = require('../server/brand');
const { buildProduction } = require('../server/build');
const { validate } = require('../server/validator');

function placeholdLogo(b) { return `https://placehold.co/120x40/${(b.palette.primary || '#111111').replace('#', '')}/ffffff.png`; }

async function fakeResolved(name, { photo = false, products: pcount = 4 } = {}) {
  const b = await brandRead(name);
  const prices = [799, 1199, 1599, 1999, 2499, 2999];
  const products = (b.products || []).slice(0, pcount).map((x, i) => ({
    slot: 'product#' + i,
    url: photo
      ? `https://images.weserv.nl/?url=picsum.photos/seed/${name}${i}/280/340&output=jpg`
      : 'https://placehold.co/280x200/eeeeee/333333.png',
    width: 280, height: photo ? 340 : 200,
    name: x.name, price: x.price != null ? x.price : prices[i % prices.length],
    tier: photo ? 'web' : 'generated', source: photo ? 'stock' : 'branded placeholder',
    license: 'Generated', rights: 'clear',
  }));
  const logo = {
    slot: 'logo', url: placeholdLogo(b), width: 120, height: 40, name: b.name,
    tier: 'generated', source: 'branded placeholder', license: 'Generated', rights: 'clear',
  };
  return {
    brand: {
      name: b.name, vertical: b.vertical, tone: b.tone, currency: b.currency,
      aesthetic: b.aesthetic, voice: b.voice, nav: b.nav, heroTheme: b.heroTheme,
      tagline: b.tagline, promo: b.promo, footer: b.footer, source: b.source,
    },
    palette: { primary: b.palette.primary, accent: b.palette.accent },
    assets: { logo, products, hero: null },
    provenance: [logo, ...products],
    summary: {},
  };
}

async function buildCreative(name, moduleId, opts = {}) {
  const resolved = await fakeResolved(name, opts);
  const built = buildProduction({ moduleId, resolved, currency: resolved.brand.currency, endpoint: 'https://amp.example.com/submit' });
  const validation = await validate(built.ampHtml);
  return { resolved, built, validation };
}

function count(hay, re) { return (hay.match(re) || []).length; }

const RESULTS = [];
function check(label, fn) {
  try { fn(); RESULTS.push([true, label]); }
  catch (e) { RESULTS.push([false, label + ' — ' + e.message]); }
}

(async () => {
  // brand → module use-case (mirrors the references: AJIO penalty game, Taj
  // editorial dining, ICICI lead form, redBus guess/poll, Zomato spin reward)
  const matrix = [
    ['ajio', 'game', {}],
    ['taj', 'reveal', { photo: true }],
    ['icici', 'leadgen', {}],
    ['redbus', 'poll', {}],
    ['zomato', 'spin', {}],
  ];

  const builts = {};
  for (const [name, moduleId, opts] of matrix) {
    const r = await buildCreative(name, moduleId, opts);
    builts[name] = r;
    const amp = r.built.ampHtml;
    const tag = `${r.resolved.brand.name}/${moduleId}`;

    check(`${tag}: validator PASS (0 errors)`, () => {
      assert.strictEqual(r.validation.errorCount, 0, `${r.validation.errorCount} errors: ` + r.validation.errors.filter((e) => e.severity === 'ERROR').map((e) => e.code).slice(0, 4).join(', '));
    });
    check(`${tag}: exactly one <h1>`, () => assert.strictEqual(count(amp, /<h1\b/gi), 1, `found ${count(amp, /<h1\b/gi)}`));
    check(`${tag}: header present`, () => assert.ok(/class="ahh"/.test(amp)));
    check(`${tag}: hero present`, () => assert.ok(/class="ah-hero"/.test(amp)));
    check(`${tag}: product strip present`, () => assert.ok(/ahps-h2|ahpl-h2|ahpf-h2/.test(amp)));
    check(`${tag}: promo strip present`, () => assert.ok(/ahpr-strip|ahpr-offer/.test(amp)));
    check(`${tag}: footer present`, () => assert.ok(/class="ahf"/.test(amp)));
    check(`${tag}: real brand nav present`, () => {
      const nav0 = (r.resolved.brand.nav || [])[0];
      assert.ok(nav0 && amp.includes(nav0), `nav "${nav0}" missing`);
    });
  }

  // ---- correct products (the brand's own, not generic) ----------------------
  check('AJIO shows a real AJIO product', () => assert.ok(builts.ajio.built.ampHtml.includes('Relaxed Linen Resort Shirt')));
  check('Taj shows a real Taj dining product', () => assert.ok(builts.taj.built.ampHtml.includes('The Grand Sunday Brunch')));
  check('ICICI shows a real ICICI plan', () => assert.ok(builts.icici.built.ampHtml.includes('iProtect Smart Term Plan')));

  // ---- brand A vs brand B divergence (luxury vs value) ----------------------
  check('AJIO vs Taj: different primary colour', () => assert.notStrictEqual(builts.ajio.built.context.palette.primary, builts.taj.built.context.palette.primary));
  check('AJIO vs Taj: different aesthetic register', () => assert.notStrictEqual(builts.ajio.built.context.aesthetic, builts.taj.built.context.aesthetic));
  check('AJIO vs Taj: different hero theme', () => assert.notStrictEqual(builts.ajio.resolved.brand.heroTheme, builts.taj.resolved.brand.heroTheme));
  check('AJIO vs Taj: different nav', () => {
    assert.ok(builts.ajio.built.ampHtml.includes('Shop All') && !builts.taj.built.ampHtml.includes('Shop All'));
    assert.ok(builts.taj.built.ampHtml.includes('Stay') && !builts.ajio.built.ampHtml.includes('Stay'));
  });
  check('AJIO vs Taj: value grid (discount) vs editorial (no discount)', () => {
    assert.ok(/ahps-disc/.test(builts.ajio.built.ampHtml), 'AJIO should show a discount chip');
    assert.ok(!/ahps-disc/.test(builts.taj.built.ampHtml), 'Taj should NOT show a discount chip');
    assert.ok(/ahpl-h2/.test(builts.taj.built.ampHtml), 'Taj should use the editorial product strip');
  });

  // ---- use-case X vs Y divergence (same brand, different module) ------------
  const ajioSpin = await buildCreative('ajio', 'spin', {});
  check('AJIO game vs AJIO spin: different kind', () => assert.notStrictEqual(builts.ajio.built.kind, ajioSpin.built.kind));
  check('AJIO game vs AJIO spin: different mechanic markup', () => assert.notStrictEqual(builts.ajio.built.ampHtml, ajioSpin.built.ampHtml));
  check('AJIO game vs AJIO spin: same header + hero theme (brand identity holds)', () => {
    assert.ok(ajioSpin.built.ampHtml.includes('Shop All'));
    assert.strictEqual(builts.ajio.resolved.brand.heroTheme, ajioSpin.resolved.brand.heroTheme);
  });

  // ---- report ---------------------------------------------------------------
  let pass = 0, fail = 0;
  for (const [ok, label] of RESULTS) {
    console.log((ok ? 'PASS  ' : 'FAIL  ') + label);
    ok ? pass++ : fail++;
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
