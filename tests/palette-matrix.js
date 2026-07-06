'use strict';

// §3 acceptance — the brand palette is the brand's REAL palette.
//
// For six real brands we resolve through the full production pipeline
// (resolveAssets -> buildProduction) and assert that the colour BAKED into the
// AMP CSS equals the brand's real primary colour. The headline regression this
// guards is the old "#2c4152 for everyone" bug: that teal may appear ONLY for
// AJIO (whose real brand colour it genuinely is) and for no one else.
//
// Brand-name (no-dot) inputs deliberately exercise the curated-library path so
// the matrix is deterministic and network-independent. The live-URL fetch path
// is proven separately by the Burberry probe + single-source suite.

const { resolveAssets } = require('../server/assets');
const { buildProduction, chooseModule } = require('../server/build');

const AJIO_TEAL = '#2c4152';

// brand -> the real, verifiable brand colour
const BRANDS = [
  { name: 'Burberry', expect: '#000000', aesthetic: 'luxury' },
  { name: 'Zomato', expect: '#e23744', aesthetic: 'playful' },
  { name: 'Swiggy', expect: '#fc8019', aesthetic: 'playful' },
  { name: 'AJIO', expect: '#2c4152', aesthetic: 'playful' },
  { name: 'Groww', expect: '#00b386', aesthetic: 'fintech' },
  { name: 'Nykaa', expect: '#fc2779', aesthetic: 'playful' },
];

const HEADBG = /\.head\{background:(#[0-9a-fA-F]{6})/;

function pad(s, n) { s = String(s); return s.length >= n ? s : s + ' '.repeat(n - s.length); }

(async () => {
  let pass = 0, fail = 0;
  const rows = [];
  for (const b of BRANDS) {
    const resolved = await resolveAssets({ brandName: b.name, need: { logo: true, products: 3 } });
    const moduleId = chooseModule(resolved.brand.vertical, b.name);
    const built = buildProduction({ moduleId, resolved });
    const m = built.ampHtml.match(HEADBG);
    const baked = (m && m[1] || '').toLowerCase();
    const ctx = (resolved.palette.primary || '').toLowerCase();
    const aes = resolved.brand.aesthetic;

    const colourOk = baked === b.expect && ctx === b.expect;
    // #2c4152 may appear ONLY for AJIO
    const tealOk = b.expect === AJIO_TEAL ? baked === AJIO_TEAL : baked !== AJIO_TEAL;
    const aesOk = aes === b.aesthetic;
    const ok = colourOk && tealOk && aesOk;
    ok ? pass++ : fail++;

    rows.push(pad(b.name, 10) + pad(b.expect, 11) + pad(ctx, 11) + pad(baked, 11) + pad(aes, 10) + (ok ? 'OK' : 'FAIL'));
    if (!ok) {
      if (!colourOk) console.log(`   [${b.name}] colour mismatch: ctx=${ctx} baked=${baked} expect=${b.expect}`);
      if (!tealOk) console.log(`   [${b.name}] #2c4152 leaked to a non-AJIO brand`);
      if (!aesOk) console.log(`   [${b.name}] aesthetic ${aes} != ${b.aesthetic}`);
    }
  }

  console.log('\n=== §3 PALETTE MATRIX — baked AMP colour == real brand colour ===');
  console.log(pad('BRAND', 10) + pad('expected', 11) + pad('context', 11) + pad('baked CSS', 11) + pad('aesthetic', 10) + 'result');
  console.log('-'.repeat(63));
  rows.forEach((r) => console.log(r));
  console.log('-'.repeat(63));
  console.log(`${pass}/${pass + fail} brands render their real colour (#2c4152 only for AJIO)`);
  process.exit(fail === 0 ? 0 : 1);
})();
