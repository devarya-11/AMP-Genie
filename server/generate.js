'use strict';

// The single source of truth for AMP4Email output.
// Each module is a pure function of (brand, vertical, palette, tone, content, rng).
// The web UI, the downloaded file and the validated file are all byte-identical
// because they all come from here.

const { getContent, applyBrand, TONES, VERTICALS } = require('./content');

/* ------------------------------------------------------------------ *
 * Encoding helpers (fix the currency mojibake — emit numeric entities)
 * ------------------------------------------------------------------ */

// Escape HTML-significant ASCII, then convert every non-ASCII codepoint to a
// numeric entity so the markup is byte-for-byte encoding-proof.
function enc(input) {
  let s = String(input)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
  let out = '';
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    out += cp > 127 ? `&#${cp};` : ch;
  }
  return out;
}

const CURRENCIES = { INR: '₹', USD: '$', EUR: '€', GBP: '£' };

function formatPrice(n, currencyCode) {
  const symbol = CURRENCIES[currencyCode] || CURRENCIES.INR;
  const grouped = String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return enc(symbol + grouped); // symbol becomes &#8377; etc.
}

/* ------------------------------------------------------------------ *
 * Colour / palette derivation (everything baked, never var())
 * ------------------------------------------------------------------ */

function hexToRgb(hex) {
  let h = String(hex).replace('#', '').trim();
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const num = parseInt(h, 16);
  return { r: (num >> 16) & 255, g: (num >> 8) & 255, b: num & 255 };
}
function rgbToHex({ r, g, b }) {
  const c = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return '#' + c(r) + c(g) + c(b);
}
function mix(hexA, hexB, t) {
  const a = hexToRgb(hexA), b = hexToRgb(hexB);
  return rgbToHex({ r: a.r + (b.r - a.r) * t, g: a.g + (b.g - a.g) * t, b: a.b + (b.b - a.b) * t });
}
function rgbToHsl({ r, g, b }) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0; const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
  }
  return { h: h * 360, s, l };
}
function hslToHex({ h, s, l }) {
  h = ((h % 360) + 360) % 360 / 360;
  let r, g, b;
  if (s === 0) { r = g = b = l; }
  else {
    const hue2rgb = (p, q, t) => {
      if (t < 0) t += 1; if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hue2rgb(p, q, h + 1 / 3); g = hue2rgb(p, q, h); b = hue2rgb(p, q, h - 1 / 3);
  }
  return rgbToHex({ r: r * 255, g: g * 255, b: b * 255 });
}

function derivePalette(primaryHex) {
  const primary = rgbToHex(hexToRgb(primaryHex)); // normalise
  const hsl = rgbToHsl(hexToRgb(primary));
  const accent = hslToHex({ h: hsl.h + 28, s: Math.min(0.85, Math.max(0.5, hsl.s + 0.15)), l: Math.min(0.6, Math.max(0.45, hsl.l)) });
  return {
    primary,
    primaryDark: mix(primary, '#000000', 0.28),
    accent,
    tint: mix(primary, '#ffffff', 0.9),
    ink: '#1d1d2b',
    line: '#e6e6ec',
  };
}

/* ------------------------------------------------------------------ *
 * Seeded RNG (deterministic: brand + counter)
 * ------------------------------------------------------------------ */

function hashSeed(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return h >>> 0;
}
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ------------------------------------------------------------------ *
 * AMP shell + shared CSS
 * ------------------------------------------------------------------ */

const SCRIPT_BIND = '<script async custom-element="amp-bind" src="https://cdn.ampproject.org/v0/amp-bind-0.1.js"><\/script>';
const SCRIPT_FORM = '<script async custom-element="amp-form" src="https://cdn.ampproject.org/v0/amp-form-0.1.js"><\/script>';

function pick(rng, arr) { return arr[Math.floor(rng() * arr.length)]; }
function shuffle(rng, arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

function ph(w, h, bgHex, fgHex, text) {
  const bg = bgHex.replace('#', '');
  const fg = fgHex.replace('#', '');
  const t = encodeURIComponent(text).replace(/%20/g, '+');
  return `https://placehold.co/${w}x${h}/${bg}/${fg}?text=${t}`;
}

function baseCss(p) {
  return `
body{margin:0;background:#f3f3f6;font-family:'Helvetica Neue',Arial,sans-serif;color:${p.ink};}
.wrap{max-width:600px;margin:0 auto;background:#ffffff;}
.hdr{background:${p.primary};padding:22px 24px;}
.hdr h1{margin:0;color:#ffffff;font-size:21px;line-height:1.3;font-weight:bold;}
.hdr p{margin:6px 0 0;color:#ffffff;font-size:13px;opacity:0.85;}
.pad{padding:24px;}
.btn{display:inline-block;background:${p.primary};color:#ffffff;padding:13px 24px;border-radius:8px;font-size:15px;font-weight:bold;text-align:center;cursor:pointer;border:0;text-decoration:none;}
.btn:hover{background:${p.primaryDark};}
.btn.alt{background:${p.accent};}
.muted{color:#6b6b7b;font-size:13px;line-height:1.5;}
.card{border:1px solid ${p.line};border-radius:10px;overflow:hidden;}
.card .body{padding:12px 14px;}
.card .name{font-size:14px;font-weight:bold;margin:0 0 4px;}
.card .price{font-size:15px;color:${p.primary};font-weight:bold;margin:0;}
.foot{padding:18px 24px;border-top:1px solid ${p.line};}
.foot p{margin:0;color:#9a9aa8;font-size:11px;line-height:1.5;}
.row{font-size:0;}
.col{display:inline-block;width:48%;vertical-align:top;}
.col.gap{margin-left:4%;}
`;
}

function shell({ title, scripts, css, body }) {
  const heads = ['<script async src="https://cdn.ampproject.org/v0.js"><\/script>'].concat(scripts);
  return `<!doctype html>
<html amp4email data-css-strict>
<head>
<meta charset="utf-8">
${heads.join('\n')}
<style amp4email-boilerplate>body{visibility:hidden}</style>
<style amp-custom>${css}</style>
</head>
<body>
<div class="wrap">
${body}
</div>
</body>
</html>`;
}

function ampState(id, data) {
  return `<amp-state id="${id}"><script type="application/json">${JSON.stringify(data)}<\/script></amp-state>`;
}

/* ------------------------------------------------------------------ *
 * Modules
 * ------------------------------------------------------------------ */

function buildReveal(ctx) {
  const { brand, palette: p, content, t, currency, rng } = ctx;
  const head = enc(applyBrand(t.reveal, brand));
  const discount = pick(rng, [10, 15, 20, 25]);
  const code = (brand.replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 6) || 'GENIE') + discount;
  const items = shuffle(rng, content.items).slice(0, 2);
  const img = ph(600, 300, p.primary, '#ffffff', `${brand} OFFER`);

  const css = baseCss(p) + `
.teaser{text-align:center;padding:30px 24px;}
.teaser .big{font-size:34px;font-weight:bold;color:${p.primary};margin:0 0 6px;}
.offer .code{display:inline-block;border:2px dashed ${p.accent};color:${p.primaryDark};font-size:18px;font-weight:bold;letter-spacing:2px;padding:10px 18px;border-radius:8px;margin:14px 0;}
`;
  const body = `
${ampState('s', { r: false })}
<div class="hdr"><h1>${head}</h1></div>
<div class="teaser" [hidden]="s.r">
  <p class="big">${discount}% OFF</p>
  <p class="muted">A hand-picked reward is waiting behind the curtain.</p>
  <div class="pad"><span class="btn" role="button" tabindex="0" on="tap:AMP.setState({s:{r:true}})">Reveal my offer</span></div>
</div>
<div class="offer" hidden [hidden]="!s.r">
  <amp-img src="${img}" width="600" height="300" layout="responsive" alt="${enc(brand)} offer"></amp-img>
  <div class="pad" style="text-align:center">
    <p class="muted">Use this code at checkout</p>
    <span class="code">${enc(code)}</span>
    <div class="row">
      ${items.map((it, i) => `<div class="col${i === 1 ? ' gap' : ''}">
        <div class="card">
          <amp-img src="${ph(300, 200, p.tint, p.primary, it.name)}" width="300" height="200" layout="responsive" alt="${enc(it.name)}"></amp-img>
          <div class="body"><p class="name">${enc(it.name)}</p><p class="price">${formatPrice(it.price, currency)}</p></div>
        </div>
      </div>`).join('')}
    </div>
  </div>
</div>
<div class="foot"><p>${enc(brand)} &#8226; You received this because you opted in to offers.</p></div>`;

  const previewModel = {
    type: 'reveal', head: applyBrand(t.reveal, brand), code, discount,
    items: items.map((it) => ({ name: it.name, price: priceText(it.price, currency) })),
    image: img,
  };
  return { scripts: [SCRIPT_BIND], css, body, previewModel };
}

function buildSearch(ctx) {
  const { brand, palette: p, content, t, currency, rng } = ctx;
  const head = enc(applyBrand(t.search, brand));
  const items = shuffle(rng, content.items.map((it, i) => ({ ...it, cat: content.itemCats[i], key: it.name.toLowerCase() })));
  const cats = content.categories;
  const catKeys = content.catKeys;

  const css = baseCss(p) + `
.search input{width:100%;box-sizing:border-box;padding:13px 14px;font-size:15px;border:1px solid ${p.line};border-radius:8px;outline:none;}
.search input:focus{border-color:${p.primary};}
.pills{font-size:0;margin:14px 0 4px;}
.pill{display:inline-block;font-size:13px;padding:8px 14px;border:1px solid ${p.line};border-radius:20px;margin:0 6px 6px 0;cursor:pointer;color:${p.ink};}
.pill.on{background:${p.primary};color:#ffffff;border-color:${p.primary};}
.grid .col{margin-bottom:12px;}
.empty{text-align:center;color:#9a9aa8;font-size:14px;padding:20px;}
`;

  const pills = ['all'].concat(catKeys).map((k, i) => {
    const label = i === 0 ? 'All' : cats[i - 1];
    return `<span class="pill" role="button" tabindex="0" on="tap:AMP.setState({s:{cat:'${k}'}})" [class]="s.cat == '${k}' ? 'pill on' : 'pill'">${enc(label)}</span>`;
  }).join('');

  const cards = items.map((it, i) => {
    const hideExpr = `(s.cat != 'all' &amp;&amp; s.cat != '${it.cat}') || (s.q != '' &amp;&amp; '${jsStr(it.key)}'.indexOf(s.q) == -1)`;
    return `<div class="col${i % 2 === 1 ? ' gap' : ''}" [hidden]="${hideExpr}">
      <div class="card">
        <amp-img src="${ph(300, 200, p.tint, p.primary, it.name)}" width="300" height="200" layout="responsive" alt="${enc(it.name)}"></amp-img>
        <div class="body"><p class="name">${enc(it.name)}</p><p class="price">${formatPrice(it.price, currency)}</p></div>
      </div>
    </div>`;
  }).join('');

  const body = `
${ampState('s', { q: '', cat: 'all' })}
<div class="hdr"><h1>${head}</h1></div>
<div class="pad search">
  <input type="text" placeholder="Search products" on="input-throttle:AMP.setState({s:{q:event.value.toLowerCase()}})">
  <div class="pills">${pills}</div>
  <div class="grid row">${cards}</div>
</div>
<div class="foot"><p>${enc(brand)} &#8226; Live catalogue search, right inside your inbox.</p></div>`;

  const previewModel = {
    type: 'search', head: applyBrand(t.search, brand),
    cats: ['all'].concat(catKeys), catLabels: ['All'].concat(cats),
    items: items.map((it) => ({ name: it.name, price: priceText(it.price, currency), cat: it.cat, key: it.key, image: ph(300, 200, p.tint, p.primary, it.name) })),
  };
  return { scripts: [SCRIPT_BIND, SCRIPT_FORM], css, body, previewModel };
}

function buildQuiz(ctx) {
  const { brand, palette: p, content, t } = ctx;
  const head = enc(applyBrand(t.quiz, brand));
  const q = enc(applyBrand(content.quiz.q, brand));
  const opts = content.quiz.options;
  const keys = ['a', 'b', 'c'];

  const css = baseCss(p) + `
.opt{display:block;border:1px solid ${p.line};border-radius:10px;padding:15px 16px;margin:0 0 12px;font-size:15px;cursor:pointer;}
.opt:hover{border-color:${p.primary};}
.opt.on{border-color:${p.primary};background:${p.tint};}
.result{background:${p.tint};border-radius:10px;padding:18px;margin-top:6px;}
.result .name{font-size:16px;font-weight:bold;color:${p.primaryDark};margin:0 0 6px;}
.qtitle{font-size:18px;font-weight:bold;margin:0 0 16px;}
`;

  const options = opts.map((o, i) => `<span class="opt" role="button" tabindex="0" on="tap:AMP.setState({s:{sel:'${keys[i]}'}})" [class]="s.sel == '${keys[i]}' ? 'opt on' : 'opt'">${enc(o.label)}</span>`).join('');
  const results = opts.map((o, i) => `<div class="result" hidden [hidden]="s.sel != '${keys[i]}'">
      <p class="name">Your match</p>
      <p class="muted">${enc(applyBrand(o.result, brand))}</p>
    </div>`).join('');

  const body = `
${ampState('s', { sel: '' })}
<div class="hdr"><h1>${head}</h1></div>
<div class="pad">
  <p class="qtitle">${q}</p>
  ${options}
  ${results}
</div>
<div class="foot"><p>${enc(brand)} &#8226; Tap an answer for your personalised pick.</p></div>`;

  const previewModel = {
    type: 'quiz', head: applyBrand(t.quiz, brand), q: applyBrand(content.quiz.q, brand),
    options: opts.map((o, i) => ({ key: keys[i], label: o.label, result: applyBrand(o.result, brand) })),
  };
  return { scripts: [SCRIPT_BIND], css, body, previewModel };
}

function buildRating(ctx) {
  const { brand, palette: p, content, t } = ctx;
  const head = enc(applyBrand(t.rate, brand));
  const prompt = enc(applyBrand(content.rate, brand));

  const css = baseCss(p) + `
.stars{font-size:0;text-align:center;margin:10px 0;}
.star{display:inline-block;font-size:42px;line-height:1;color:${p.line};cursor:pointer;padding:0 4px;}
.star.on{color:${p.accent};}
.conf{text-align:center;font-size:15px;font-weight:bold;color:${p.primaryDark};min-height:20px;margin:8px 0 0;}
.rtitle{font-size:17px;text-align:center;margin:0 0 6px;}
`;

  const stars = [1, 2, 3, 4, 5].map((i) =>
    `<span class="star" role="button" tabindex="0" on="tap:AMP.setState({s:{score:${i}}})" [class]="s.score &gt;= ${i} ? 'star on' : 'star'">&#9733;</span>`
  ).join('');

  const body = `
${ampState('s', { score: 0 })}
<div class="hdr"><h1>${head}</h1></div>
<div class="pad">
  <p class="rtitle">${prompt}</p>
  <div class="stars">${stars}</div>
  <p class="conf" [text]="s.score == 0 ? '' : 'You rated ' + s.score + ' out of 5 — thank you!'"></p>
</div>
<div class="foot"><p>${enc(brand)} &#8226; Your feedback shapes what we do next.</p></div>`;

  const previewModel = { type: 'rating', head: applyBrand(t.rate, brand), prompt: applyBrand(content.rate, brand) };
  return { scripts: [SCRIPT_BIND], css, body, previewModel };
}

function buildSpin(ctx) {
  const { brand, palette: p, t, rng } = ctx;
  const head = enc(applyBrand(t.spin, brand));
  const pct = pick(rng, [15, 20, 25, 30]);
  const reward = (brand.replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 6) || 'GENIE') + pct;
  const img = ph(360, 360, p.primary, '#ffffff', 'SPIN');

  const css = baseCss(p) + `
.spin{text-align:center;padding:24px;}
.wheel{margin:0 auto 16px;max-width:240px;}
.reward{background:${p.tint};border-radius:12px;padding:22px;margin-top:10px;}
.reward .big{font-size:26px;font-weight:bold;color:${p.primaryDark};margin:0 0 6px;}
.reward .code{display:inline-block;border:2px dashed ${p.accent};color:${p.primaryDark};font-size:18px;font-weight:bold;letter-spacing:2px;padding:8px 16px;border-radius:8px;margin-top:8px;}
`;

  const body = `
${ampState('s', { spun: false })}
<div class="hdr"><h1>${head}</h1></div>
<div class="spin">
  <div class="wheel"><amp-img src="${img}" width="360" height="360" layout="responsive" alt="Prize wheel"></amp-img></div>
  <div [hidden]="s.spun">
    <p class="muted">One spin, one reward. Ready?</p>
    <div class="pad"><span class="btn alt" role="button" tabindex="0" on="tap:AMP.setState({s:{spun:true}})">Spin to win</span></div>
  </div>
  <div class="reward" hidden [hidden]="!s.spun">
    <p class="big">You won ${pct}% off! &#127881;</p>
    <p class="muted">Apply this code before it disappears.</p>
    <div><span class="code">${enc(reward)}</span></div>
  </div>
</div>
<div class="foot"><p>${enc(brand)} &#8226; One reward per customer. Terms apply.</p></div>`;

  const previewModel = { type: 'spin', head: applyBrand(t.spin, brand), reward, pct, image: img };
  return { scripts: [SCRIPT_BIND], css, body, previewModel };
}

function buildPoll(ctx) {
  const { brand, palette: p, content, t } = ctx;
  const head = enc(applyBrand(t.poll, brand));
  const q = enc(applyBrand(content.poll.q, brand));
  const a = content.poll.a, b = content.poll.b;

  const css = baseCss(p) + `
.poll{padding:24px;}
.ptitle{font-size:18px;font-weight:bold;text-align:center;margin:0 0 18px;}
.vote{display:inline-block;width:46%;text-align:center;border:2px solid ${p.line};border-radius:12px;padding:22px 8px;cursor:pointer;vertical-align:top;font-size:16px;font-weight:bold;}
.vote.gap{margin-left:4%;}
.vote.on{border-color:${p.primary};background:${p.tint};color:${p.primaryDark};}
.result{text-align:center;background:${p.tint};border-radius:10px;padding:18px;margin-top:18px;}
`;

  const body = `
${ampState('s', { v: '' })}
<div class="hdr"><h1>${head}</h1></div>
<div class="poll">
  <p class="ptitle">${q}</p>
  <div class="row" style="text-align:center">
    <span class="vote" role="button" tabindex="0" on="tap:AMP.setState({s:{v:'a'}})" [class]="s.v == 'a' ? 'vote on' : 'vote'">${enc(a)}</span>
    <span class="vote gap" role="button" tabindex="0" on="tap:AMP.setState({s:{v:'b'}})" [class]="s.v == 'b' ? 'vote on' : 'vote'">${enc(b)}</span>
  </div>
  <div class="result" hidden [hidden]="s.v == ''">
    <p class="muted" [text]="s.v == 'a' ? 'You are with the 64% who chose ${jsStr(a)}. Great pick!' : 'You joined the 36% backing ${jsStr(b)}. Bold!'"></p>
  </div>
</div>
<div class="foot"><p>${enc(brand)} &#8226; Tap to vote results update instantly.</p></div>`;

  const previewModel = {
    type: 'poll', head: applyBrand(t.poll, brand), q: applyBrand(content.poll.q, brand), a, b,
  };
  return { scripts: [SCRIPT_BIND], css, body, previewModel };
}

/* ------------------------------------------------------------------ *
 * small string helpers for safe embedding inside amp-bind expressions
 * ------------------------------------------------------------------ */
function jsStr(s) {
  // Embedded inside a single-quoted amp-bind/JS string; escape quotes/backslash
  // and entity-encode non-ASCII so the markup stays encoding-proof.
  return enc(String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'"));
}
function priceText(n, currencyCode) {
  const symbol = CURRENCIES[currencyCode] || CURRENCIES.INR;
  const grouped = String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return symbol + grouped; // raw glyph for the JS preview model (not the AMP file)
}

/* ------------------------------------------------------------------ */

const MODULES = {
  reveal: { name: 'Tap to Reveal Offer', kind: 'tap-to-reveal', build: buildReveal },
  search: { name: 'Search & Filter Catalog', kind: 'live-search', build: buildSearch },
  quiz: { name: 'Quiz & Match', kind: 'quiz', build: buildQuiz },
  rating: { name: 'Star Rating / NPS', kind: 'rating', build: buildRating },
  spin: { name: 'Spin to Win', kind: 'spin', build: buildSpin },
  poll: { name: 'This or That Poll', kind: 'poll', build: buildPoll },
};
const MODULE_IDS = Object.keys(MODULES);

function generate(opts = {}) {
  const brand = (opts.brand || 'Acme').trim() || 'Acme';
  const vertical = VERTICALS.includes(opts.vertical) ? opts.vertical : 'Generic';
  const tone = TONES[opts.tone] ? opts.tone : 'Playful';
  const currency = CURRENCIES[opts.currency] ? opts.currency : 'INR';
  const counter = Number.isFinite(opts.counter) ? opts.counter : 0;
  // No fixed default colour: when neither a palette nor an explicit colour is
  // given, derive a deterministic, brandable hue from the brand name so the
  // legacy path never paints every brand the same teal (the old #2c4152 bug).
  const fallbackColor = hslToHex({ h: hashSeed(brand) % 360, s: 0.6, l: 0.47 });
  const palette = opts.palette || derivePalette(opts.color || fallbackColor);
  const content = getContent(vertical);
  const t = TONES[tone];
  const rng = mulberry32(hashSeed(brand + ':' + counter));

  let moduleId = opts.moduleId;
  if (!moduleId || !MODULES[moduleId]) {
    moduleId = MODULE_IDS[Math.floor(rng() * MODULE_IDS.length)];
  }
  const mod = MODULES[moduleId];
  const built = mod.build({ brand, vertical, tone, palette, content, t, currency, rng });
  const title = `${brand} — ${mod.name}`;
  const ampHtml = shell({ title, scripts: built.scripts, css: built.css, body: built.body });

  return {
    moduleId,
    moduleName: mod.name,
    kind: mod.kind,
    brand, vertical, tone, currency,
    palette,
    ampHtml,
    previewModel: built.previewModel,
  };
}

module.exports = {
  generate, derivePalette, MODULES, MODULE_IDS,
  enc, formatPrice, CURRENCIES, VERTICALS,
};
