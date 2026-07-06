'use strict';

// Stage 2 · Step 1 acceptance: asset-resolution provenance.
// Resolves a logo + 3 product images for 5 real brand URLs and for the
// ZERO-INPUT case (no URL, no assets), then prints a provenance table showing
// which tier filled each slot (user / brand-site / web / generated) and the
// final HTTPS URL. Every slot must end with a reachable HTTPS asset.

const { resolveAssets } = require('../server/assets');

const CASES = [
  { label: 'allbirds.com', spec: { brandUrl: 'https://www.allbirds.com' } },
  { label: 'nykaa.com', spec: { brandUrl: 'https://www.nykaa.com' } },
  { label: 'apple.com', spec: { brandUrl: 'https://www.apple.com' } },
  { label: 'gymshark.com', spec: { brandUrl: 'https://www.gymshark.com' } },
  { label: 'muji.eu', spec: { brandUrl: 'https://www.muji.eu' } },
  { label: 'ZERO-INPUT (generated)', spec: {} },
];

function pad(s, n) { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n - 1) + '…' : s + ' '.repeat(n - s.length); }
function isHttps(u) { return /^https:\/\//i.test(u || ''); }

(async () => {
  let allHttps = true;
  for (const c of CASES) {
    const out = await resolveAssets({ ...c.spec, need: { logo: true, products: 3 } });
    console.log('\n══════════════════════════════════════════════════════════════════════');
    console.log(`BRAND: ${c.label}`);
    console.log(`  name=${out.brand.name}  vertical=${out.brand.vertical}  currency=${out.brand.currency}  source=${out.brand.source}`);
    console.log(`  palette: primary=${out.palette.primary} accent=${out.palette.accent}  | summary=${JSON.stringify(out.summary)}`);
    console.log('  ' + pad('SLOT', 11) + pad('TIER', 12) + pad('SOURCE', 22) + pad('CONF', 7) + 'URL');
    console.log('  ' + '-'.repeat(96));
    for (const r of out.provenance) {
      const https = isHttps(r.url);
      if (!https) allHttps = false;
      console.log('  ' + pad(r.slot, 11) + pad(r.tier, 12) + pad(r.source, 22) + pad(r.confidence, 7) + (https ? '' : '⚠ NON-HTTPS ') + String(r.url).slice(0, 60));
    }
  }
  console.log('\n══════════════════════════════════════════════════════════════════════');
  console.log(allHttps ? '✓ Every resolved asset is HTTPS.' : '✗ Some assets were not HTTPS.');
  process.exit(allHttps ? 0 : 1);
})();
