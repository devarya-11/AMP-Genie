'use strict';

// Stage 2 · Step 2 acceptance: every flagship module, generated with
// (a) full user assets, (b) partial (brand URL only), (c) zero assets,
// validates AMP4EMAIL with zero errors. Prints the matrix.

const { resolveAssets } = require('../server/assets');
const { buildProduction, PROD_MODULE_IDS } = require('../server/build');
const { validate } = require('../server/validator');

function pad(s, n) { s = String(s); return s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length); }

(async () => {
  const modes = {
    full: await resolveAssets({
      brandName: 'Zephyr', vertical: 'Fashion', tone: 'Playful', currency: 'INR',
      user: {
        colors: { primary: '#6C2BD9', accent: '#F59E0B' },
        logo: 'https://placehold.co/200x60/6C2BD9/ffffff?text=Zephyr',
        products: [
          { name: 'Cloud Runner', imageUrl: 'https://placehold.co/600x400/eee/333?text=Runner' },
          { name: 'Trail Knit', imageUrl: 'https://placehold.co/600x400/eee/333?text=Knit' },
          { name: 'Daily Slip-On', imageUrl: 'https://placehold.co/600x400/eee/333?text=SlipOn' },
        ],
      },
      need: { logo: true, products: 3 },
    }),
    partial: await resolveAssets({ brandUrl: 'https://www.allbirds.com', need: { logo: true, products: 3 } }),
    zero: await resolveAssets({ need: { logo: true, products: 3 } }),
  };

  let total = 0, pass = 0;
  const rows = [];
  for (const moduleId of PROD_MODULE_IDS) {
    const cells = [];
    for (const mode of ['full', 'partial', 'zero']) {
      const built = buildProduction({ moduleId, resolved: modes[mode] });
      const v = await validate(built.ampHtml);
      total++; if (v.pass) pass++;
      cells.push(v.pass ? 'PASS' : 'FAIL(' + v.errorCount + ')');
      if (!v.pass) v.errors.slice(0, 4).forEach((e) => console.log(`   [${moduleId}/${mode}] L${e.line}: ${e.message}`));
    }
    rows.push(pad(moduleId, 10) + cells.map((c) => pad(c, 12)).join(''));
  }

  console.log('\n' + pad('MODULE', 10) + pad('full-assets', 12) + pad('partial', 12) + pad('zero-input', 12));
  console.log('-'.repeat(46));
  rows.forEach((r) => console.log(r));
  console.log('-'.repeat(46));
  console.log(`${pass}/${total} combinations PASS with zero errors`);
  process.exit(pass === total ? 0 : 1);
})();
