'use strict';

// Probe: compose every art-direction section (header + hero + products + promo +
// footer) into a full AMP4EMAIL document and run the REAL amphtml-validator over
// each brand/aesthetic/theme. This must show zero ERRORs before artdirect.js is
// wired into build.js — it de-risks the inline-style + CSS-composition approach.

const { brandRead } = require('../server/brand');
const { derivePalette } = require('../server/generate');
const ad = require('../server/artdirect');
const { validate } = require('../server/validator');

const AES = {
  playful: { bodyFont: 'Arial, Helvetica, sans-serif', headFont: 'Arial, Helvetica, sans-serif' },
  bold: { bodyFont: '"Helvetica Neue", Arial, sans-serif', headFont: '"Helvetica Neue", Arial, sans-serif' },
  fintech: { bodyFont: '"Helvetica Neue", Arial, sans-serif', headFont: '"Helvetica Neue", Arial, sans-serif' },
  minimal: { bodyFont: '"Helvetica Neue", Arial, sans-serif', headFont: '"Helvetica Neue", Arial, sans-serif' },
  luxury: { bodyFont: 'Georgia, "Times New Roman", serif', headFont: 'Georgia, "Times New Roman", serif' },
};

async function ctxFor(name, head, opts = {}) {
  const b = await brandRead(name, { noFetch: true });
  const p = derivePalette(b.palette.primary);
  p.accent = b.palette.accent;
  const aesName = b.aesthetic || 'playful';
  const prices = [799, 1199, 1599, 1999];
  const products = (b.products || []).slice(0, 4).map((x, i) => ({
    url: opts.photo
      ? `https://images.weserv.nl/?url=picsum.photos/seed/${i}/280/340&output=jpg`
      : `https://placehold.co/280x340/eeeeee/333333.png`,
    width: 280, height: opts.photo ? 340 : 200,
    name: x.name, price: x.price || prices[i % prices.length],
    tier: opts.photo ? 'web' : 'generated',
  }));
  const logo = {
    url: `https://placehold.co/120x40/${b.palette.primary.replace('#', '')}/ffffff.png`,
    width: 120, height: 40, name: b.name, tier: 'generated',
  };
  return {
    p, brand: b, brandName: b.name, currency: b.currency, vertical: b.vertical,
    tone: b.tone, aes: AES[aesName] || AES.playful, aesName, footer: b.footer,
    products, logo, content: {}, copy: { head }, endpoint: 'https://amp.example.com/submit', rng: Math.random,
  };
}

function shell(css, body) {
  return [
    '<!doctype html>',
    '<html amp4email data-css-strict>',
    '<head>',
    '<meta charset="utf-8">',
    '<script async src="https://cdn.ampproject.org/v0.js"><\/script>',
    '<style amp4email-boilerplate>body{visibility:hidden}</style>',
    `<style amp-custom>body{margin:0;background:#eef0f3;}table{border-collapse:collapse;}img{border:0;display:block;}.w600{width:100%;max-width:600px;background:#ffffff;}${css}</style>`,
    '</head>',
    '<body>',
    body,
    '</body>',
    '</html>',
  ].join('\n');
}

function compose(ctx) {
  const secs = [ad.brandHeader(ctx), ad.heroSection(ctx), ad.productStrip(ctx), ad.promoStrip(ctx), ad.footer(ctx)];
  const css = secs.map((s) => s.css).join('');
  const rows = secs.map((s) => s.html).join('');
  const body = `<table role="presentation" width="100%"><tr><td align="center"><table role="presentation" width="600" class="w600">${rows}</table></td></tr></table>`;
  return shell(css, body);
}

(async () => {
  const cases = [
    ['ajio', 'Take your penalties — win the prize', {}],
    ['redbus', 'Guess the score, win the trip', {}],
    ['zomato', 'Spin for tonight’s dinner reward', {}],
    ['icici', 'Get your free protection quote', {}],
    ['taj', 'An evening crafted by our chefs', { photo: true }],
    ['taj', 'An evening crafted by our chefs', {}], // CSS editorial fallback (no photo)
    ['burberry', 'The new season, previewed', { photo: true }],
    ['someunknownbrand', 'A reward is waiting for you', {}],
  ];
  let allPass = true;
  for (const [name, head, opts] of cases) {
    const ctx = await ctxFor(name, head, opts);
    const doc = compose(ctx);
    const res = await validate(doc);
    const tag = `${ctx.brandName}/${ctx.aesName}/${ctx.brand.heroTheme}${opts.photo ? '/photo' : ''}`;
    if (res.pass) {
      console.log(`PASS  ${tag}  (warnings: ${res.warningCount})`);
    } else {
      allPass = false;
      console.log(`FAIL  ${tag}  — ${res.errorCount} error(s):`);
      res.errors.filter((e) => e.severity === 'ERROR').slice(0, 8).forEach((e) => console.log(`        L${e.line}:${e.col} ${e.code} — ${e.message}`));
    }
  }
  console.log(allPass ? '\nALL THEMES PASS' : '\nSOME THEMES FAILED');
  process.exit(allPass ? 0 : 1);
})();
