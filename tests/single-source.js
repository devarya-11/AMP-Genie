'use strict';

// Single-source verification (Phase 2).
//
// Proves the asset/brand engine and the email generator are ONE system: the
// GenerationContext returned by buildProduction is the sole input, and the
// generated AMP references exactly the same assets, module and palette that the
// context (and therefore the provenance list and the live preview, which renders
// that same AMP) report. Also prints the use-case fidelity and palette-accuracy
// matrices, and validates every email with the real amphtml-validator.

const assert = require('assert');
const { resolveAssets } = require('../server/assets');
const { buildProduction } = require('../server/build');
const { validate } = require('../server/validator');

function pad(s, n) { s = String(s); return s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length); }
function srcsIn(html) { const out = []; const re = /src="([^"]+)"/g; let m; while ((m = re.exec(html))) out.push(m[1]); return out; }
function headBg(html) { const m = /\.head\{background:(#[0-9a-fA-F]{6})/.exec(html); return m ? m[1].toUpperCase() : null; }
function uniq(a) { return Array.from(new Set(a)); }
function eqColor(a, b) { return String(a).toUpperCase() === String(b).toUpperCase(); }

let failures = 0;
function ok(cond, msg) { if (!cond) { failures++; console.log('  ✗ ' + msg); } else { console.log('  ✓ ' + msg); } }

// ---- 1) SINGLE-SOURCE PROOF (zomato.com) -----------------------------------
async function singleSource() {
  console.log('\n=== 1) SINGLE-SOURCE TEST — zomato.com ===');
  const resolved = await resolveAssets({ brandUrl: 'https://www.zomato.com', vertical: 'Food', need: { logo: true, products: 3 } });
  // Carousel renders the logo + all three products, so every asset must appear.
  const built = buildProduction({ moduleId: 'carousel', resolved });
  const v = await validate(built.ampHtml);
  const ctx = built.context;

  const logoUrl = (resolved.assets.logo || {}).url;
  const provProd = resolved.assets.products.map((p) => p.url);
  const ctxAssetUrls = ctx.assets.map((a) => a.url);
  const ampSrcs = srcsIn(built.ampHtml);
  const ampProd = uniq(ampSrcs.filter((s) => provProd.includes(s)));

  // The three sets the spec asks to print "identical".
  const setProvenance = { logo: logoUrl, products: provProd, module: ctx.module, primary: ctx.palette.primary.toUpperCase() };
  const setContext = { logo: ctxAssetUrls.find((u) => u === logoUrl) || null, products: ctx.assets.filter((a) => a.slot.startsWith('product')).map((a) => a.url), module: ctx.module, primary: ctx.palette.primary.toUpperCase() };
  const setAmp = { logo: ampSrcs.includes(logoUrl) ? logoUrl : null, products: ampProd, module: built.moduleId, primary: headBg(built.ampHtml) };

  console.log('  provenance :', JSON.stringify(setProvenance));
  console.log('  context    :', JSON.stringify(setContext));
  console.log('  AMP code   :', JSON.stringify(setAmp));

  ok(eqColor(ctx.palette.primary, '#E23744'), "palette.primary is Zomato red #E23744");
  ok(eqColor(headBg(built.ampHtml), '#E23744'), "baked .head background == brand primary");
  ok(ctx.module === 'carousel' && built.moduleId === 'carousel', "module is the requested 'carousel'");
  ok(logoUrl && ampSrcs.includes(logoUrl), "resolved logo URL is rendered in the AMP header");
  ok(ctx.assets.some((a) => a.url === logoUrl), "logo URL is present in context.assets");
  ok(JSON.stringify(setProvenance) === JSON.stringify(setContext), "provenance set === context set");
  assert.deepStrictEqual(setAmp.products, setProvenance.products); // throws if order/URLs diverge
  ok(true, "rendered product URLs === provenance product URLs (same order)");
  ok(v.pass, "AMP4EMAIL validates with zero errors (" + v.errorCount + ')');
}

// ---- 2) USE-CASE FIDELITY MATRIX -------------------------------------------
// The selected use case must be exactly what renders. Each module carries a
// signature string that only its renderer emits.
const SIGNATURES = {
  poll: ['class="po"'],
  spin: ['Spin to win'],
  scratch: ['Tap to scratch'],
  reveal: ['Reveal my offer'],
  quiz: ['class="opt"'],
  carousel: ['<amp-carousel'],
};
async function fidelity() {
  console.log('\n=== 2) USE-CASE FIDELITY MATRIX (Food / Zomato) ===');
  const resolved = await resolveAssets({ brandName: 'Zomato', vertical: 'Food', need: { logo: true, products: 3 } });
  console.log(pad('MODULE', 12) + pad('rendered', 12) + pad('signature', 11) + 'valid');
  console.log('-'.repeat(42));
  for (const id of Object.keys(SIGNATURES)) {
    const built = buildProduction({ moduleId: id, resolved });
    const v = await validate(built.ampHtml);
    const sigOk = SIGNATURES[id].every((s) => built.ampHtml.includes(s));
    const idOk = built.moduleId === id && built.context.module === id;
    ok(idOk, `module '${id}' renders as '${built.moduleId}'`);
    ok(sigOk, `module '${id}' emits its unique signature`);
    ok(v.pass, `module '${id}' validates`);
    console.log(pad(id, 12) + pad(built.moduleId, 12) + pad(sigOk ? 'yes' : 'NO', 11) + (v.pass ? 'PASS' : 'FAIL'));
  }

  // Brand/vertical-appropriate content (no more hardcoded "Sneakers vs Boots").
  console.log('  -- brand-appropriate content --');
  const poll = buildProduction({ moduleId: 'poll', resolved }).ampHtml;
  ok(poll.includes('Spicy ramen') && poll.includes('Loaded fries'), "Food poll uses food options (Spicy ramen / Loaded fries)");
  ok(!/Sneakers|Boots/.test(poll), "Food poll does NOT show the old Sneakers/Boots default");
  ok(/menu next/.test(poll), "Food poll asks a food question");
  const quiz = buildProduction({ moduleId: 'quiz', resolved }).ampHtml;
  ok(/Light &amp; fresh|Comfort cravings|Feed the squad/.test(quiz), "Food quiz uses food answers");

  // Provenance product NAMES must be vertical-appropriate even on the name-only
  // path. Regression guard: the name-only brandRead synthesises Generic products
  // ("Starter Plan"/"Pro Plan"/"Team Bundle") — those must NOT override the Food
  // content fallback (the bug that made a Food carousel show SaaS tiers).
  const prodNames = resolved.assets.products.map((p) => p.name).join(' | ');
  ok(/Margherita|Risotto|Chicken|Burger|Rice|Brew/i.test(prodNames), 'name-only Food products use food names (' + prodNames + ')');
  ok(!/Starter Plan|Pro Plan|Team Bundle/.test(prodNames), 'name-only Food products are NOT the Generic SaaS defaults');
}

// ---- 3) PALETTE ACCURACY MATRIX --------------------------------------------
const PALETTES = [
  { brand: 'Zomato', expect: '#E23744' },
  { brand: 'AJIO', expect: '#2C4152' },
  { brand: 'Groww', expect: '#00B386' },
];
async function palettes() {
  console.log('\n=== 3) PALETTE ACCURACY MATRIX (no cross-wiring) ===');
  console.log(pad('BRAND', 10) + pad('expected', 11) + pad('context', 11) + pad('baked CSS', 11) + 'match');
  console.log('-'.repeat(48));
  const seen = {};
  for (const row of PALETTES) {
    const resolved = await resolveAssets({ brandName: row.brand, need: { logo: true, products: 3 } });
    const built = buildProduction({ moduleId: 'reveal', resolved });
    const ctxPrim = built.context.palette.primary.toUpperCase();
    const bakedPrim = headBg(built.ampHtml);
    const match = eqColor(ctxPrim, row.expect) && eqColor(bakedPrim, row.expect);
    ok(match, `${row.brand} resolves to ${row.expect} in context + baked CSS`);
    seen[row.brand] = ctxPrim;
    console.log(pad(row.brand, 10) + pad(row.expect, 11) + pad(ctxPrim, 11) + pad(bakedPrim || '—', 11) + (match ? 'yes' : 'NO'));
  }
  ok(seen.Zomato !== seen.AJIO && seen.AJIO !== seen.Groww, 'no two brands share a colour (no cross-wiring)');
}

(async () => {
  await singleSource();
  await fidelity();
  await palettes();
  console.log('\n' + (failures ? `FAILED — ${failures} assertion(s) failed` : 'ALL CHECKS PASSED'));
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
