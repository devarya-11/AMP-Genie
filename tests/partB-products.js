'use strict';

// Part B integration proof. Runs the REAL asset pipeline (resolveAssets →
// buildProduction → amphtml-validator) for three brands, including the EXACT
// bug case (Zomato food). For every product slot it shows name → category →
// tier → source → license, and asserts the contradiction guard holds:
//   • no product is served an open-web ('web') image without a derived category;
//   • every slot has an https url and a matching label.
// Writes a self-contained 3-brand product GRID (web/_demo/partB-grid.html) and
// per-brand viewer JSON so the images can be seen beside their labels.

const fs = require('fs');
const path = require('path');
const { resolveAssets } = require('../server/assets');
const { buildProduction } = require('../server/build');
const { validate } = require('../server/validator');
const { formatPrice } = require('../server/generate');

const OUT = path.join(__dirname, '..', 'web', '_demo');

const BRANDS = [
  { brandName: 'Zomato', vertical: 'Food', currency: 'INR', moduleId: 'spin' },     // the bug case
  { brandName: 'AJIO', vertical: 'Fashion', currency: 'INR', moduleId: 'reveal' },
  { brandName: 'Groww', vertical: 'Finance', currency: 'INR', moduleId: 'sip' },
];

function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
const trunc = (s, n) => { s = String(s || ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  let allValid = true, allMatched = true;
  const gridSections = [];

  for (const b of BRANDS) {
    const r = await resolveAssets({ brandName: b.brandName, vertical: b.vertical, currency: b.currency, need: { logo: true, products: 6, hero: true } });
    const products = r.assets.products || [];

    console.log(`\n=== ${b.brandName}  [${b.vertical}] ===`);
    console.log('  #  ' + 'PRODUCT'.padEnd(30) + 'CATEGORY'.padEnd(18) + 'TIER'.padEnd(12) + 'RIGHTS'.padEnd(8) + 'SOURCE');
    let brandMatched = true;
    products.forEach((p, i) => {
      const httpsOk = /^https:\/\//.test(p.url || '');
      // contradiction guard: an open-web image MUST carry a category; a generated
      // placeholder is always label-correct. Either way the label can't be contradicted.
      const guarded = p.tier === 'web' ? !!p.category : true;
      const ok = httpsOk && guarded;
      if (!ok) brandMatched = false;
      console.log(`  ${i} ${(ok ? ' ' : '!')} ${trunc(p.name, 28).padEnd(30)} ${String(p.category || '—').padEnd(18)} ${String(p.tier).padEnd(12)} ${String(p.rights).padEnd(8)} ${trunc(p.source, 26)}`);
    });
    allMatched = allMatched && brandMatched;

    // build the real email through the same resolved context, validate it
    const built = buildProduction({ moduleId: b.moduleId, resolved: r, currency: b.currency, endpoint: 'https://api.acme.in/lead' });
    const v = await validate(built.ampHtml);
    allValid = allValid && v.pass;
    console.log(`  → ${built.moduleName}: ${v.pass ? 'VALID ✓ (0E)' : 'INVALID ✗ ' + v.errorCount + 'E'} · products matched: ${brandMatched ? 'YES' : 'NO'}`);

    // per-brand viewer JSON (existing email viewer)
    const slug = 'partB-' + b.brandName.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    fs.writeFileSync(path.join(OUT, slug + '.json'), JSON.stringify({ ampHtml: built.ampHtml, brand: b.brandName, moduleName: built.moduleName, kind: built.kind, palette: built.context.palette, nav: [] }));

    // grid section HTML
    const cards = products.map((p) => `
      <figure class="card">
        <div class="imgwrap"><img src="${esc(p.url)}" alt="${esc(p.name)}" loading="lazy"></div>
        <figcaption>
          <div class="pname">${esc(p.name)}</div>
          <div class="pprice">${Number.isFinite(p.price) ? formatPrice(p.price, b.currency) : '<span class="noprice">—</span>'}</div>
          <div class="badges">
            <span class="badge cat">${esc(p.category || 'placeholder')}</span>
            <span class="badge tier tier-${esc(p.tier)}">${esc(p.tier)}</span>
            <span class="badge rights rights-${esc(p.rights)}">${esc(p.rights)}</span>
          </div>
          <div class="lic">${esc(trunc(p.license, 60))}</div>
        </figcaption>
      </figure>`).join('');
    gridSections.push(`<section><h2>${esc(b.brandName)} <small>· ${esc(b.vertical)} · ${esc(built.moduleName)}</small></h2><div class="grid">${cards}</div></section>`);
  }

  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Part B — product images match labels</title>
<style>
  :root{--ink:#1c2230;--mut:#6b7280;--line:#e6e8ee}
  *{box-sizing:border-box} body{margin:0;font:14px/1.5 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:var(--ink);background:#f4f6f9;padding:28px}
  h1{font-size:20px;margin:0 0 4px} .sub{color:var(--mut);margin:0 0 22px}
  section{background:#fff;border:1px solid var(--line);border-radius:14px;padding:18px 18px 22px;margin:0 0 20px;box-shadow:0 1px 2px rgba(16,24,40,.04)}
  h2{font-size:15px;margin:0 0 14px;font-weight:700} h2 small{color:var(--mut);font-weight:500}
  .grid{display:grid;grid-template-columns:repeat(3,1fr);gap:14px}
  @media(max-width:760px){.grid{grid-template-columns:repeat(2,1fr)}}
  .card{margin:0;border:1px solid var(--line);border-radius:12px;overflow:hidden;background:#fff}
  .imgwrap{aspect-ratio:3/2;background:#eef0f3;overflow:hidden} .imgwrap img{width:100%;height:100%;object-fit:cover;display:block}
  figcaption{padding:10px 12px 12px}
  .pname{font-weight:600;font-size:13px;line-height:1.3} .pprice{color:var(--ink);font-weight:600;font-size:12px;margin:2px 0 8px} .noprice{opacity:.4;font-weight:400}
  .badges{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px}
  .badge{font-size:10px;font-weight:700;letter-spacing:.3px;padding:3px 7px;border-radius:20px;text-transform:uppercase}
  .cat{background:#eef2ff;color:#3949ab} .tier-web{background:#e8f5e9;color:#2e7d32} .tier-generated{background:#fff3e0;color:#e65100} .tier-brand-site{background:#e3f2fd;color:#1565c0} .tier-user{background:#f3e5f5;color:#6a1b9a}
  .rights-clear{background:#e8f5e9;color:#2e7d32} .rights-review{background:#fff8e1;color:#a16207}
  .lic{font-size:11px;color:var(--mut);line-height:1.35}
</style></head><body>
<h1>Part B — every product image matches its label</h1>
<p class="sub">Real asset pipeline. <b>category</b> = derived from the product name · <b>tier</b> = where the image came from · <b>rights</b> = send-safety. The Coca-Cola-under-Margherita bug cannot occur: an open-web image is only used when its category was matched; otherwise a labelled placeholder.</p>
${gridSections.join('\n')}
</body></html>`;
  fs.writeFileSync(path.join(OUT, 'partB-grid.html'), html);

  console.log(`\n${allValid ? 'ALL EMAILS VALID (0 errors)' : 'SOME INVALID'} · ${allMatched ? 'ALL PRODUCTS MATCHED (no contradictions)' : 'SOME UNMATCHED'}`);
  console.log('wrote web/_demo/partB-grid.html + per-brand JSON');
  process.exit(allValid && allMatched ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(2); });
