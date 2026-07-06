'use strict';

// §7.2 verification — five live brand URLs must each resolve a NON-ZERO number
// of genuinely-sourced assets (tier user/brand-site/web), never an all-grey
// "0/3 real assets" set of generic placeholders.
//
// This hits the network (brand-site fetch + web proxy/favicon probes), so it is
// a verification probe, not part of the deterministic unit suite.

const { resolveAssets } = require('../server/assets');

const SOURCED = new Set(['user', 'brand-site', 'web']);
const URLS = [
  'https://www.burberry.com',
  'https://www.nike.com',
  'https://www.allbirds.com',
  'https://www.glossier.com',
  'https://www.zomato.com',
];

function pad(s, n) { s = String(s); return s.length >= n ? s : s + ' '.repeat(n - s.length); }

(async () => {
  console.log('\n=== §7.2 REAL-ASSET PROBE — five live brand URLs ===');
  console.log(pad('BRAND URL', 30) + pad('slots', 7) + pad('sourced', 9) + pad('generated', 11) + pad('tier breakdown', 28) + 'result');
  console.log('-'.repeat(92));

  let allNonZero = true;
  for (const url of URLS) {
    let line;
    try {
      const r = await resolveAssets({ brandUrl: url, need: { logo: true, products: 3 } });
      const prov = r.provenance || [];
      const sourced = prov.filter((p) => SOURCED.has(p.tier)).length;
      const generated = prov.filter((p) => p.tier === 'generated').length;
      const breakdown = Object.entries(r.summary || {}).map(([t, n]) => `${t}:${n}`).join(' ');
      const ok = sourced > 0;
      if (!ok) allNonZero = false;
      line = pad(url.replace(/^https?:\/\//, ''), 30) + pad(prov.length, 7) +
        pad(`${sourced}/${prov.length}`, 9) + pad(String(generated), 11) +
        pad(breakdown, 28) + (ok ? 'OK' : 'ALL-GENERATED');
      // Show the actual asset hosts so the sourcing is auditable.
      const hosts = prov.map((p) => `${p.slot}:${(p.url || '').replace(/^https?:\/\//, '').split('/')[0]}(${p.tier})`);
      console.log(line);
      console.log('   ' + hosts.join('  '));
    } catch (e) {
      allNonZero = false;
      console.log(pad(url.replace(/^https?:\/\//, ''), 30) + 'ERROR ' + e.message);
    }
  }
  console.log('-'.repeat(92));
  console.log(allNonZero ? 'PASS — every brand resolved at least one genuinely-sourced asset (no all-grey sets)'
                         : 'FAIL — a brand fell back to an all-generated set');
  process.exit(allNonZero ? 0 : 1);
})();
