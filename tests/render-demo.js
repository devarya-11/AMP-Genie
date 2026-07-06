'use strict';

// Part A checkpoint helper — builds the AJIO and Taj creatives through the REAL
// production pipeline (buildProduction) and writes them, plus a tiny static
// viewer, into web/_demo/ so they can be opened in the browser and screenshotted
// next to the reference creatives. Imagery uses topical stock stand-ins (the same
// web tier the live asset waterfall uses); the art direction, palette, nav,
// product names/prices, mechanic and structure are 100% the real engine output.

const fs = require('fs');
const path = require('path');
const { brandRead } = require('../server/brand');
const { buildProduction } = require('../server/build');

const OUT = path.join(__dirname, '..', 'web', '_demo');
// Curated, license-permissive Unsplash stills (stable CDN IDs) so the demo
// imagery is topical + reliable. In production the asset waterfall supplies
// first-party brand images here; these are representative stand-ins.
const unsplash = (id, w, h) => `https://images.unsplash.com/photo-${id}?w=${w}&h=${h}&fit=crop&crop=entropy&q=72`;

async function fakeResolved(name, { imgs = [], heroImg = null, products: pcount = 4 } = {}) {
  const b = await brandRead(name);
  const prices = [799, 1199, 1599, 1999, 2499, 2999];
  const products = (b.products || []).slice(0, pcount).map((x, i) => ({
    slot: 'product#' + i,
    url: unsplash(imgs[i % imgs.length], 280, 360),
    width: 280, height: 360,
    name: x.name, price: x.price != null ? x.price : prices[i % prices.length],
    tier: 'web', source: 'stock photo', license: 'Stock', rights: 'review',
  }));
  // No logo URL → the engine renders its real brand wordmark fallback (cleaner
  // and more brand-authentic offline than a grey placeholder box; in production
  // the asset waterfall fetches the real logo here).
  const logo = {
    slot: 'logo', url: '', width: 240, height: 80, name: b.name,
    tier: 'generated', source: 'wordmark', license: 'Generated', rights: 'clear',
  };
  const hero = heroImg
    ? { slot: 'hero', url: unsplash(heroImg, 600, 380), width: 600, height: 380, name: b.name + ' hero', tier: 'web', source: 'stock photo', license: 'Stock', rights: 'review' }
    : null;
  return {
    brand: {
      name: b.name, vertical: b.vertical, tone: b.tone, currency: b.currency,
      aesthetic: b.aesthetic, voice: b.voice, nav: b.nav, heroTheme: b.heroTheme,
      tagline: b.tagline, promo: b.promo, footer: b.footer, source: b.source,
    },
    palette: { primary: b.palette.primary, accent: b.palette.accent },
    assets: { logo, products, hero },
    provenance: [logo, ...(hero ? [hero] : []), ...products],
    summary: {},
  };
}

async function build(name, moduleId, opts) {
  const resolved = await fakeResolved(name, opts);
  const built = buildProduction({ moduleId, resolved, currency: resolved.brand.currency, endpoint: 'https://amp.example.com/submit' });
  return {
    ampHtml: built.ampHtml, brand: resolved.brand.name, moduleName: built.moduleName,
    kind: built.kind, palette: built.context.palette, nav: resolved.brand.nav,
  };
}

const VIEW = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>creative preview</title>
<style>
  html,body{margin:0;padding:0;background:#e9ebf0;font-family:Arial,Helvetica,sans-serif;}
  #stage{padding:0;display:flex;justify-content:center;}
  #frame{background:#ffffff;box-shadow:0 8px 34px rgba(20,20,45,.18);overflow:hidden;}
  .amp-preview-root{display:block;}
</style>
</head><body>
<div id="stage"><div id="frame"></div></div>
<script src="/preview.js"></script>
<script>
  var q=new URLSearchParams(location.search);
  var b=q.get('b')||'ajio'; var w=+(q.get('w')||600);
  var frame=document.getElementById('frame');
  frame.style.width=w+'px';
  window.__ready=false;
  fetch('/_demo/'+b+'.json').then(function(r){return r.json();}).then(function(d){
    GeniePreview.renderAmp(d.ampHtml, frame);
    document.title=d.brand+' \\u00b7 '+d.moduleName+' \\u00b7 '+w+'px';
    var imgs=Array.prototype.slice.call(frame.querySelectorAll('img'));
    var pending=imgs.filter(function(i){return !i.complete;}).length;
    function done(){ if(--pending<=0) window.__ready=true; }
    if(!pending){ window.__ready=true; }
    else imgs.forEach(function(i){ if(!i.complete){ i.addEventListener('load',done); i.addEventListener('error',done); } });
    setTimeout(function(){ window.__ready=true; }, 5000);
  });
</script>
</body></html>`;

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  // AJIO → penalty 'game' (mirrors the AJIO World Cup penalty creative).
  const ajio = await build('ajio', 'game', {
    imgs: ['1490481651871-ab68de25d43d', '1539109136881-3be0616acf4b', '1551232864-3f0890e580d9', '1521572163474-6864f9cf17ab'],
  });
  // Taj → editorial 'reveal' (mirrors the Taj editorial dining creative).
  const taj = await build('taj', 'reveal', {
    imgs: ['1559339352-11d035aa65de', '1555939594-58d7cb561ad1', '1424847651672-bf20a4b0982b', '1551218808-94e220e084d2'],
    heroImg: '1414235077428-338989a2e8c0',
  });
  fs.writeFileSync(path.join(OUT, 'ajio.json'), JSON.stringify(ajio));
  fs.writeFileSync(path.join(OUT, 'taj.json'), JSON.stringify(taj));
  fs.writeFileSync(path.join(OUT, 'view.html'), VIEW);
  for (const c of [ajio, taj]) {
    console.log(`${c.brand.padEnd(12)} ${c.moduleName.padEnd(10)} kind=${c.kind.padEnd(8)} primary=${c.palette.primary}  nav=[${(c.nav || []).join(', ')}]  ${c.ampHtml.length}b`);
  }
  console.log('\nwrote web/_demo/{ajio,taj}.json + view.html');
})().catch((e) => { console.error(e); process.exit(1); });
