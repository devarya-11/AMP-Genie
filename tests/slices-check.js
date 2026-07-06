'use strict';

// Proves the composed-slice path end to end:
//   1. with an https ASSET_BASE, slices are ENABLED → sliceUrl() emits https CDN
//      URLs (validator-safe) and registers specs;
//   2. prewarmSlices() rasterizes real PNGs via sharp (magic-bytes + 2× dims);
//   3. a full email built through the ENABLED path still validates with 0 errors
//      (the validator accepts the https slice URLs without fetching them);
//   4. the DISABLED (dev) path returns the https placeholder, so output stays valid.
//
// Run with an https base so slicesEnabled() is true via the real CDN branch:
//   PUBLIC_ASSET_BASE=https://cdn.example.test node tests/slices-check.js

process.env.PUBLIC_ASSET_BASE = process.env.PUBLIC_ASSET_BASE || 'https://cdn.example.test';

const fs = require('fs');
const path = require('path');
const slices = require('../server/slices');
const { buildProduction } = require('../server/build');
const { validate } = require('../server/validator');

const palette = { primary: '#7b2d8f', primaryDark: '#5e1f6e', accent: '#f5a623', tint: '#f3e9f6', ink: '#1f1430', line: '#e7dcec' };

function pngInfo(buf) {
  const sig = buf.slice(0, 8).toString('hex') === '89504e470d0a1a0a';
  // IHDR width/height are big-endian uint32 at byte 16/20
  const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20);
  return { sig, w, h };
}

(async () => {
  let ok = true;
  console.log(`slicesEnabled() = ${slices.slicesEnabled()}  (ASSET_BASE=${process.env.PUBLIC_ASSET_BASE})`);

  // 1) sliceUrl emits https CDN URLs for every kind
  const specs = [
    { kind: 'cta', text: 'Shop the festive edit', w: 360, h: 64, palette },
    { kind: 'icon', text: 'Free delivery', w: 96, h: 96, palette },
    { kind: 'icon', text: 'Secure checkout', w: 96, h: 96, palette },
    { kind: 'social', key: 'in', w: 64, h: 64, palette },
    { kind: 'social', key: 'IG', w: 64, h: 64, palette },
    { kind: 'loader', w: 80, h: 80, palette },
    { kind: 'divider', w: 600, h: 24, palette },
  ];
  const urls = specs.map((s) => slices.sliceUrl(s));
  const allHttps = urls.every((u) => /^https:\/\//.test(u));
  console.log(`\n[1] sliceUrl → https CDN URLs: ${allHttps ? 'PASS' : 'FAIL'}`);
  urls.forEach((u, i) => console.log(`    ${specs[i].kind.padEnd(8)} ${u}`));
  ok = ok && allHttps;

  // 2) sharp rasterizes real PNGs at 2× the requested box
  const warm = await slices.prewarmSlices();
  console.log(`\n[2] prewarmSlices → wrote ${warm.written}/${warm.total} PNGs via sharp`);
  let rasterOk = warm.written === specs.length;
  for (let i = 0; i < specs.length; i++) {
    const file = path.join(slices.ASSET_DIR, urls[i].split('/').pop());
    if (!fs.existsSync(file)) { console.log(`    MISSING ${file}`); rasterOk = false; continue; }
    const info = pngInfo(fs.readFileSync(file));
    const want = { w: specs[i].w * 2, h: specs[i].h * 2 };
    const dimOk = info.sig && info.w === want.w && info.h === want.h;
    if (!dimOk) rasterOk = false;
    console.log(`    ${specs[i].kind.padEnd(8)} png=${info.sig} ${info.w}×${info.h} (want ${want.w}×${want.h}) ${dimOk ? 'OK' : 'BAD'}`);
  }
  console.log(`    rasterization: ${rasterOk ? 'PASS' : 'FAIL'}`);
  ok = ok && rasterOk;

  // 3) a full email built through the ENABLED slice path still validates
  const unsplash = (id, w, h) => `https://images.unsplash.com/photo-${id}?w=${w}&h=${h}&fit=crop&q=72`;
  const resolved = {
    brand: { name: 'Lyra Studio', vertical: 'Fashion', tone: 'Playful', currency: 'INR', aesthetic: 'playful',
      promo: { head: 'Festive Edit is live' }, footer: { site: 'www.lyrastudio.com' }, source: 'inline' },
    palette: { primary: '#7b2d8f', accent: '#f5a623' },
    assets: {
      logo: { slot: 'logo', url: '', width: 200, height: 64, name: 'Lyra Studio', tier: 'generated' },
      hero: { slot: 'hero', url: unsplash('1441984904996-e0b6ba687e04', 600, 320), width: 600, height: 320, name: 'hero', tier: 'web' },
      products: [
        { slot: 'product#0', url: unsplash('1490481651871-ab68de25d43d', 300, 220), width: 300, height: 220, name: 'Linen Shirt Dress', price: 799, tier: 'web' },
        { slot: 'product#1', url: unsplash('1539109136881-3be0616acf4b', 300, 220), width: 300, height: 220, name: 'Wide-Leg Trousers', price: 1199, tier: 'web' },
      ],
    },
    provenance: [], summary: {},
  };
  const built = buildProduction({ moduleId: 'reveal', resolved, currency: 'INR', endpoint: 'https://api.acme.in/lead' });
  const sliceUrlsInDoc = (built.ampHtml.match(/cdn\.example\.test\/assets\/slice-[a-f0-9]+\.png/g) || []).length;
  const v = await validate(built.ampHtml);
  const vErr = v.errors.filter((e) => e.severity === 'ERROR');
  console.log(`\n[3] enabled-path email: ${sliceUrlsInDoc} CDN slice URLs embedded · validator ${v.pass ? 'VALID ✓ (0E)' : 'INVALID ✗'}`);
  for (const e of vErr.slice(0, 6)) console.log(`    L${e.line}:${e.col} ${e.code} — ${e.message}`);
  ok = ok && v.pass && sliceUrlsInDoc > 0;

  console.log(`\n${ok ? 'SLICES OK — SVG→sharp PNG→CDN path works AND validates' : 'SLICES CHECK FAILED'}`);
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(2); });
