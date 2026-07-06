'use strict';

// §4 acceptance — every brand renders to its OWN aesthetic register.
//
// We hold the module constant ('reveal', the only module with a discount
// branch) and vary only the brand, so the single independent variable is the
// resolved aesthetic. Three registers must produce structurally different mail:
//
//   luxury  (Burberry) — serif type, squared geometry, NO loud discount block
//   playful (Zomato)   — sans type, rounded geometry, discount block is fine
//   fintech (Groww)    — clean sans, data-forward, discount fine, never serif
//
// Brand-name (no-dot) inputs exercise the curated-library path so the matrix is
// deterministic. The headline §4 promise this guards: a luxury brand never gets
// a "20% OFF" coupon slab, and a value brand never loses one.

const { resolveAssets } = require('../server/assets');
const { buildProduction } = require('../server/build');

const SERIF = 'Georgia, "Times New Roman", serif';
const SANS_PLAYFUL = 'Arial, Helvetica, sans-serif';
const SANS_NEUE = '"Helvetica Neue", Arial, sans-serif';

// brand -> the register it must render in, and the invariants that prove it
const CASES = [
  {
    name: 'Burberry', aesthetic: 'luxury',
    wantFont: SERIF, serif: true, wantDiscount: false,
    btnRadius: 'border-radius:0', tell: 'The new edit',
  },
  {
    name: 'Zomato', aesthetic: 'playful',
    wantFont: SANS_PLAYFUL, serif: false, wantDiscount: true,
    btnRadius: 'border-radius:8px', tell: '% OFF',
  },
  {
    name: 'Groww', aesthetic: 'fintech',
    wantFont: SANS_NEUE, serif: false, wantDiscount: true,
    btnRadius: 'border-radius:8px', tell: '% OFF',
  },
];

const MODULE = 'reveal'; // the one module that honours showDiscount

function pad(s, n) { s = String(s); return s.length >= n ? s : s + ' '.repeat(n - s.length); }
function yn(b) { return b ? 'yes' : 'no'; }

(async () => {
  let pass = 0, fail = 0;
  const rows = [];
  const htmls = {};

  for (const c of CASES) {
    const resolved = await resolveAssets({ brandName: c.name, need: { logo: true, products: 3 } });
    const built = buildProduction({ moduleId: MODULE, resolved });
    const html = built.ampHtml;
    htmls[c.name] = html;

    const aes = resolved.brand.aesthetic;
    const hasFont = html.includes(c.wantFont);
    const hasSerif = html.includes(SERIF);
    const serifOk = hasSerif === c.serif;
    const hasOff = /\d+% OFF/.test(html);
    const discountOk = hasOff === c.wantDiscount;
    const radiusOk = html.includes(c.btnRadius);
    const tellOk = html.includes(c.tell);
    const aesOk = aes === c.aesthetic;

    const ok = aesOk && hasFont && serifOk && discountOk && radiusOk && tellOk;
    ok ? pass++ : fail++;

    rows.push(
      pad(c.name, 10) + pad(aes, 9) +
      pad(c.serif ? 'serif' : 'sans', 7) + pad(yn(serifOk), 7) +
      pad(c.wantDiscount ? 'shows' : 'hidden', 8) + pad(yn(discountOk), 7) +
      (ok ? 'OK' : 'FAIL')
    );
    if (!ok) {
      if (!aesOk) console.log(`   [${c.name}] aesthetic ${aes} != ${c.aesthetic}`);
      if (!hasFont) console.log(`   [${c.name}] expected font ${c.wantFont} not baked`);
      if (!serifOk) console.log(`   [${c.name}] serif=${hasSerif} but wanted serif=${c.serif}`);
      if (!discountOk) console.log(`   [${c.name}] "% OFF" present=${hasOff} but wanted=${c.wantDiscount}`);
      if (!radiusOk) console.log(`   [${c.name}] button geometry ${c.btnRadius} missing`);
      if (!tellOk) console.log(`   [${c.name}] register tell "${c.tell}" missing`);
    }
  }

  // The three registers must be mutually distinct documents.
  const distinct =
    htmls.Burberry !== htmls.Zomato &&
    htmls.Zomato !== htmls.Groww &&
    htmls.Burberry !== htmls.Groww;
  if (!distinct) { fail++; console.log('   [distinctness] two aesthetics produced identical AMP'); }

  console.log('\n=== §4 AESTHETIC FIDELITY — same module, three registers ===');
  console.log(pad('BRAND', 10) + pad('register', 9) + pad('type', 7) + pad('typeOk', 7) + pad('discount', 8) + pad('discOk', 7) + 'result');
  console.log('-'.repeat(57));
  rows.forEach((r) => console.log(r));
  console.log('-'.repeat(57));
  console.log(`mutually distinct documents: ${distinct ? 'yes' : 'NO'}`);
  console.log(`${pass}/${CASES.length} brands render in their own register (luxury suppresses the discount slab)`);
  process.exit(fail === 0 ? 0 : 1);
})();
