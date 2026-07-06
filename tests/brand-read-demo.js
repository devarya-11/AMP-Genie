'use strict';
const { brandRead } = require('../server/brand');

const URLS = [
  'https://www.allbirds.com/',
  'https://www.nykaa.com/',
  'https://www.apple.com/',
  'https://www.gymshark.com/',
  'https://www.muji.eu/',
];

(async () => {
  for (const u of URLS) {
    const t0 = Date.now();
    const p = await brandRead(u);
    const ms = Date.now() - t0;
    const real = p.products.filter((x) => !x.synthetic).length;
    console.log('\n=== ' + u + '  (' + ms + 'ms) ===');
    console.log('  name      :', p.name, '[' + p.confidence.name + ']');
    console.log('  voice     :', p.voice, '[' + p.confidence.voice + ']  -> tone', p.tone);
    console.log('  vertical  :', p.vertical);
    console.log('  palette   :', JSON.stringify(p.palette), '[' + p.confidence.palette + ']');
    console.log('  currency  :', p.currency, '[' + p.confidence.currency + ']');
    console.log('  products  :', p.products.length, '(' + real + ' real)', '[' + p.confidence.products + ']');
    console.log('  source    :', p.source);
    if (p.products[0]) console.log('  sample    :', p.products[0].name, '|', p.products[0].price, '|', (p.products[0].imageUrl || 'placeholder').slice(0, 55));
  }
})();
