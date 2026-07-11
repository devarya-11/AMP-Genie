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

// An actual wheel-of-fortune graphic — 8 coloured wedges with callout
// labels — rendered by QuickChart (a URL-parameterised chart-image
// service, same third-party category as ph()'s placehold.co: no fetch at
// generate() time, no local rendering, and critically no `data:` URI,
// which AMP4EMAIL's validator hard-rejects for amp-img src
// (INVALID_URL_PROTOCOL). One wedge always reads the exact reward the
// .reward panel reveals after "Spin to win" is tapped, so the wheel and
// the payoff never disagree; the rest are shuffled filler prizes for
// wheel-like variety. Deterministic per (brand, counter) via the shared
// rng, same as every other seeded choice in this module.
const WHEEL_FILLER = ['FREE SHIP', 'TRY AGAIN', 'BOGO', '10% OFF', '20% OFF', '25% OFF', '5% OFF', 'GOOD LUCK'];
function wheelImg(p, pct, rng) {
  const real = `${pct}% OFF`;
  const filler = shuffle(rng, WHEEL_FILLER.filter((x) => x !== real)).slice(0, 7);
  const labels = shuffle(rng, [real, ...filler]);
  const colors = labels.map((_, i) => (i % 2 === 0 ? p.primary : p.primaryDark));
  const config = {
    type: 'outlabeledPie',
    data: {
      labels,
      datasets: [{ backgroundColor: colors, borderColor: '#ffffff', borderWidth: 3, data: labels.map(() => 1) }],
    },
    options: {
      plugins: {
        legend: false,
        outlabels: { text: '%l', color: '#ffffff', stretch: 20, font: { resizable: true, minSize: 9, maxSize: 14 } },
      },
    },
  };
  return `https://quickchart.io/chart?c=${encodeURIComponent(JSON.stringify(config))}&w=420&h=420&backgroundColor=transparent&format=png`;
}

// A discount/percentage value coming from an untrusted copy override (manual
// or LLM-composed): keep only whole numbers in a sane 1-99 range, else fall
// back to the caller's own default (never throws, never NaN%).
function validPct(n) {
  const v = Math.round(Number(n));
  return Number.isFinite(v) && v >= 1 && v <= 99 ? v : 0;
}

// A brief-driven content plan may rename which items appear (e.g. a
// "restaurants catalogue" brief naming actual dishes instead of the
// vertical's generic placeholders) without touching their price — pure
// display override, positional by index, ignored when absent/invalid so
// omitting copy.itemNames is always a byte-identical no-op.
function overrideItemName(base, itemNames, i) {
  const v = Array.isArray(itemNames) ? itemNames[i] : undefined;
  return (typeof v === 'string' && v.trim()) ? v.trim() : base;
}

// Best-effort brand homepage guess for the header logo link. Mirrors (does
// not import) brand.js's candidateDomains — this is a display-only link, not
// used for colour resolution, so a single best guess is enough here.
function siteGuess(brand) {
  const slug = String(brand || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  return slug ? `https://www.${slug}.com` : '#';
}

// Shared header: brand logo plus the module's headline. `copy.logoUrl` /
// `copy.site` (real fetched image + the domain that actually answered — see
// brand.js's resolveBrandLogo) win when present; a guessed domain and a
// generated placeholder image are the fallback, never the first choice.
// `head` arrives pre-encoded (callers do enc(applyBrand(...)) before passing
// it in, matching the existing pattern).
function headerBlock({ brand, palette: p, head, copy = {} }) {
  const site = copy.site || siteGuess(brand);
  const logo = copy.logoUrl || ph(96, 32, p.primary, '#ffffff', (brand || 'BRAND').trim().slice(0, 10));
  return `<div class="hdr">
  <a class="brand-link" href="${enc(site)}" target="_blank" rel="noopener noreferrer" aria-label="${enc(brand)}">
    <amp-img class="logo" src="${logo}" width="96" height="32" layout="fixed" alt="${enc(brand)} logo"></amp-img>
  </a>
  <h1>${head}</h1>
</div>`;
}

// Shared footer: brand name plus either an override footer line or the
// module's own default trailing copy.
function footerBlock({ brand, defaultText, copy = {} }) {
  const text = copy.footerText || defaultText;
  return `<div class="foot"><p>${enc(brand)} &#8226; ${enc(text)}</p></div>`;
}

function baseCss(p) {
  return `
body{margin:0;background:#f3f3f6;font-family:'Helvetica Neue',Arial,sans-serif;color:${p.ink};}
.wrap{max-width:600px;margin:0 auto;background:#ffffff;}
.hdr{background:${p.primary};padding:22px 24px;}
.hdr .brand-link{display:inline-block;text-decoration:none;margin:0 0 10px;}
.hdr .logo{display:block;}
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

// JSON destined for an <amp-state> script tag. Script content is raw text —
// the parser never decodes entities there — so enc()'s numeric entities can't
// help; instead every non-ASCII codepoint (and, defensively, <, > and &)
// becomes a \uXXXX JSON escape. Same guarantee as enc(): the document stays
// pure ASCII and byte-encoding-proof, and no state string can ever smuggle a
// literal </script> into the markup. A pure-ASCII payload passes through
// byte-identical, so the six original modules' output is unchanged.
function jsonEnc(data) {
  return JSON.stringify(data).replace(/[<>&\u0080-\uffff]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
}

function ampState(id, data) {
  return `<amp-state id="${id}"><script type="application/json">${jsonEnc(data)}<\/script></amp-state>`;
}

/* ------------------------------------------------------------------ *
 * Modules
 * ------------------------------------------------------------------ */

function buildReveal(ctx) {
  const { brand, palette: p, content, t, currency, rng, copy = {} } = ctx;
  const headSrc = copy.head || t.reveal;
  const head = enc(applyBrand(headSrc, brand));
  const discount = validPct(copy.discount) || pick(rng, [10, 15, 20, 25]);
  const code = (brand.replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 6) || 'GENIE') + discount;
  const items = shuffle(rng, content.items).slice(0, 2)
    .map((it, i) => ({ ...it, name: overrideItemName(it.name, copy.itemNames, i) }));
  const img = ph(600, 300, p.primary, '#ffffff', `${brand} OFFER`);
  const teaserSrc = copy.teaserText || 'A hand-picked reward is waiting behind the curtain.';
  const ctaSrc = copy.ctaLabel || 'Reveal my offer';

  const css = baseCss(p) + `
.teaser{text-align:center;padding:30px 24px;}
.teaser .big{font-size:34px;font-weight:bold;color:${p.primary};margin:0 0 6px;}
.offer .code{display:inline-block;border:2px dashed ${p.accent};color:${p.primaryDark};font-size:18px;font-weight:bold;letter-spacing:2px;padding:10px 18px;border-radius:8px;margin:14px 0;}
`;
  const body = `
${ampState('s', { r: false })}
${headerBlock({ brand, palette: p, head, copy })}
<div class="teaser" [hidden]="s.r">
  <p class="big">${discount}% OFF</p>
  <p class="muted">${enc(teaserSrc)}</p>
  <div class="pad"><span class="btn" role="button" tabindex="0" on="tap:AMP.setState({s:{r:true}})">${enc(ctaSrc)}</span></div>
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
${footerBlock({ brand, defaultText: 'You received this because you opted in to offers.', copy })}`;

  const previewModel = {
    type: 'reveal', head: applyBrand(headSrc, brand), code, discount,
    teaserText: teaserSrc, ctaLabel: ctaSrc,
    items: items.map((it) => ({ name: it.name, price: priceText(it.price, currency) })),
    image: img,
  };
  return { scripts: [SCRIPT_BIND], css, body, previewModel };
}

function buildSearch(ctx) {
  const { brand, palette: p, content, t, currency, rng, copy = {} } = ctx;
  const headSrc = copy.head || t.search;
  const head = enc(applyBrand(headSrc, brand));
  const items = shuffle(rng, content.items.map((it, i) => {
    const name = overrideItemName(it.name, copy.itemNames, i);
    return { ...it, name, cat: content.itemCats[i], key: name.toLowerCase() };
  }));
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
${headerBlock({ brand, palette: p, head, copy })}
<div class="pad search">
  <input type="text" placeholder="Search products" on="input-throttle:AMP.setState({s:{q:event.value.toLowerCase()}})">
  <div class="pills">${pills}</div>
  <div class="grid row">${cards}</div>
</div>
${footerBlock({ brand, defaultText: 'Live catalogue search, right inside your inbox.', copy })}`;

  const previewModel = {
    type: 'search', head: applyBrand(headSrc, brand),
    cats: ['all'].concat(catKeys), catLabels: ['All'].concat(cats),
    items: items.map((it) => ({ name: it.name, price: priceText(it.price, currency), cat: it.cat, key: it.key, image: ph(300, 200, p.tint, p.primary, it.name) })),
  };
  return { scripts: [SCRIPT_BIND, SCRIPT_FORM], css, body, previewModel };
}

function buildQuiz(ctx) {
  const { brand, palette: p, content, t, copy = {} } = ctx;
  const headSrc = copy.head || t.quiz;
  const head = enc(applyBrand(headSrc, brand));
  const qSrc = copy.question || content.quiz.q;
  const q = enc(applyBrand(qSrc, brand));
  // A copy-provided option override must match the template's fixed 3-option
  // shape exactly (label required; result optional, falls back to the
  // library's own result copy) or it is ignored outright.
  const validOverride = Array.isArray(copy.options)
    && copy.options.length === content.quiz.options.length
    && copy.options.every((o) => o && typeof o.label === 'string' && o.label.trim());
  const opts = validOverride
    ? copy.options.map((o, i) => ({ label: o.label, result: (typeof o.result === 'string' && o.result.trim()) || content.quiz.options[i].result }))
    : content.quiz.options;
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
${headerBlock({ brand, palette: p, head, copy })}
<div class="pad">
  <p class="qtitle">${q}</p>
  ${options}
  ${results}
</div>
${footerBlock({ brand, defaultText: 'Tap an answer for your personalised pick.', copy })}`;

  const previewModel = {
    type: 'quiz', head: applyBrand(headSrc, brand), q: applyBrand(qSrc, brand),
    options: opts.map((o, i) => ({ key: keys[i], label: o.label, result: applyBrand(o.result, brand) })),
  };
  return { scripts: [SCRIPT_BIND], css, body, previewModel };
}

function buildRating(ctx) {
  const { brand, palette: p, content, t, copy = {} } = ctx;
  const headSrc = copy.head || t.rate;
  const head = enc(applyBrand(headSrc, brand));
  const promptSrc = copy.prompt || content.rate;
  const prompt = enc(applyBrand(promptSrc, brand));

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
${headerBlock({ brand, palette: p, head, copy })}
<div class="pad">
  <p class="rtitle">${prompt}</p>
  <div class="stars">${stars}</div>
  <p class="conf" [text]="s.score == 0 ? '' : 'You rated ' + s.score + ' out of 5 — thank you!'"></p>
</div>
${footerBlock({ brand, defaultText: 'Your feedback shapes what we do next.', copy })}`;

  const previewModel = { type: 'rating', head: applyBrand(headSrc, brand), prompt: applyBrand(promptSrc, brand) };
  return { scripts: [SCRIPT_BIND], css, body, previewModel };
}

function buildSpin(ctx) {
  const { brand, palette: p, t, rng, copy = {} } = ctx;
  const headSrc = copy.head || t.spin;
  const head = enc(applyBrand(headSrc, brand));
  const pct = validPct(copy.discount) || pick(rng, [15, 20, 25, 30]);
  const reward = (brand.replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 6) || 'GENIE') + pct;
  const img = wheelImg(p, pct, rng);
  const teaserSrc = copy.teaserText || 'One spin, one reward. Ready?';

  const css = baseCss(p) + `
.spin{text-align:center;padding:24px;}
.wheel{margin:0 auto 16px;max-width:240px;position:relative;}
.wheel .pointer{position:absolute;top:-4px;left:50%;margin-left:-10px;width:0;height:0;border-left:10px solid transparent;border-right:10px solid transparent;border-top:16px solid ${p.primaryDark};z-index:2;}
.reward{background:${p.tint};border-radius:12px;padding:22px;margin-top:10px;}
.reward .big{font-size:26px;font-weight:bold;color:${p.primaryDark};margin:0 0 6px;}
.reward .code{display:inline-block;border:2px dashed ${p.accent};color:${p.primaryDark};font-size:18px;font-weight:bold;letter-spacing:2px;padding:8px 16px;border-radius:8px;margin-top:8px;}
`;

  const body = `
${ampState('s', { spun: false })}
${headerBlock({ brand, palette: p, head, copy })}
<div class="spin">
  <div class="wheel"><div class="pointer"></div><amp-img src="${img}" width="360" height="360" layout="responsive" alt="Prize wheel"></amp-img></div>
  <div [hidden]="s.spun">
    <p class="muted">${enc(teaserSrc)}</p>
    <div class="pad"><span class="btn alt" role="button" tabindex="0" on="tap:AMP.setState({s:{spun:true}})">Spin to win</span></div>
  </div>
  <div class="reward" hidden [hidden]="!s.spun">
    <p class="big">You won ${pct}% off! &#127881;</p>
    <p class="muted">Apply this code before it disappears.</p>
    <div><span class="code">${enc(reward)}</span></div>
  </div>
</div>
${footerBlock({ brand, defaultText: 'One reward per customer. Terms apply.', copy })}`;

  const previewModel = { type: 'spin', head: applyBrand(headSrc, brand), reward, pct, image: img };
  return { scripts: [SCRIPT_BIND], css, body, previewModel };
}

function buildPoll(ctx) {
  const { brand, palette: p, content, t, copy = {} } = ctx;
  const headSrc = copy.head || t.poll;
  const head = enc(applyBrand(headSrc, brand));
  const qSrc = copy.question || content.poll.q;
  const q = enc(applyBrand(qSrc, brand));
  const a = (typeof copy.optionA === 'string' && copy.optionA.trim()) || content.poll.a;
  const b = (typeof copy.optionB === 'string' && copy.optionB.trim()) || content.poll.b;

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
${headerBlock({ brand, palette: p, head, copy })}
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
${footerBlock({ brand, defaultText: 'Tap to vote results update instantly.', copy })}`;

  const previewModel = {
    type: 'poll', head: applyBrand(headSrc, brand), q: applyBrand(qSrc, brand), a, b,
  };
  return { scripts: [SCRIPT_BIND], css, body, previewModel };
}

/* ------------------------------------------------------------------ *
 * calc + report: shared override sanitizers and receipt/divider fragments
 * ------------------------------------------------------------------ */

// buildPoll's "(typeof v === 'string' && v.trim()) || fallback" idiom, named —
// the calc/report builders take a dozen optional copy strings each.
function strOr(v, fallback) {
  return (typeof v === 'string' && v.trim()) ? v.trim() : fallback;
}

// A numeric copy override in validPct's spirit, generalised: finite and inside
// the caller's sane window, else the caller's default — never NaN money.
function validNum(n, min, max, dflt) {
  const v = Number(n);
  return Number.isFinite(v) && v >= min && v <= max ? v : dflt;
}

// A numeric axis override (calc pills / stepper values): only finite in-range
// numbers survive, length-clamped; fewer than two usable values cannot express
// a choice, so the whole override is ignored in favour of the fallback.
function validAxis(arr, { min, max, maxLen }, fallback) {
  if (!Array.isArray(arr)) return fallback;
  const vals = arr.map(Number).filter((v) => Number.isFinite(v) && v >= min && v <= max).slice(0, maxLen);
  return vals.length >= 2 ? vals : fallback;
}

// A k/v meta-row list (calc receipt, report meta): only well-shaped string
// pairs survive, length-clamped — a bad override degrades to "no receipt",
// never to broken markup.
function validKvRows(arr, maxRows = 4) {
  if (!Array.isArray(arr)) return null;
  const out = [];
  for (const r of arr) {
    if (!r || typeof r !== 'object') continue;
    const k = strOr(r.k, '').slice(0, 40);
    const v = strOr(r.v, '').slice(0, 60);
    if (k && v) out.push({ k, v });
    if (out.length >= maxRows) break;
  }
  return out.length ? out : null;
}

// A short list of tap-target labels (report next-step slots): trimmed, capped,
// and at least two long — one option is not a choice.
function validStrList(arr, maxItems, maxLen) {
  if (!Array.isArray(arr)) return null;
  const out = [];
  for (const v of arr) {
    const s = strOr(v, '').slice(0, maxLen);
    if (s) out.push(s);
    if (out.length >= maxItems) break;
  }
  return out.length >= 2 ? out : null;
}

// Mirrors fallback.js's safeUrl: only a plain http(s) URL may become a CTA
// deep link; anything else falls back to the in-email latch button.
function safeHttpUrl(v) {
  const s = (typeof v === 'string') ? v.trim() : '';
  return /^https?:\/\/[^\s"'<>]+$/i.test(s) ? s : null;
}

// The two-layer composition both winning decks lead with: a bordered
// "untouched transactional" receipt card (corner-tagged, optional PDF
// attachment chip — pure CSS/text, amp-img data: URIs are validator-illegal)
// above a labelled dashed divider that marks where the living layer begins.
function receiptCard({ tag, rows, attachment = null }) {
  const kvs = rows.map((r) => `<p class="krow"><span class="kv">${enc(r.v)}</span><span class="kk">${enc(r.k)}</span></p>`).join('\n    ');
  const att = attachment
    ? `\n    <div class="att"><span class="att-ic">PDF</span><span class="att-name">${enc(attachment.name)}</span><span class="att-meta">${enc(attachment.meta)}</span></div>`
    : '';
  return `<div class="receipt">
    <span class="rc-tag">${enc(tag)}</span>
    ${kvs}${att}
  </div>`;
}

function dividerRule(label) {
  return `<div class="divider"><span class="divider-label">${enc(label)}</span></div>`;
}

function receiptCss(p) {
  return `
.rwrap{padding:20px 24px 0;}
.receipt{border:1px solid ${p.line};border-radius:12px;padding:14px 14px 8px;position:relative;}
.rc-tag{position:absolute;top:-9px;right:10px;font-size:9px;font-weight:bold;letter-spacing:0.08em;text-transform:uppercase;background:${p.tint};border:1px solid ${p.line};color:${p.primaryDark};padding:2px 8px;border-radius:9px;}
.krow{margin:0 0 6px;font-size:12px;color:#6b6b7b;overflow:hidden;}
.krow .kv{float:right;font-weight:bold;color:${p.ink};margin-left:10px;}
.att{border-top:1px solid ${p.line};margin-top:8px;padding-top:10px;padding-bottom:4px;overflow:hidden;}
.att .att-ic{float:left;width:36px;height:36px;border-radius:9px;background:#fde8e8;color:#b42318;font-size:10px;font-weight:bold;text-align:center;line-height:36px;letter-spacing:0.04em;}
.att .att-name{display:block;margin-left:46px;font-size:12px;font-weight:bold;color:${p.ink};padding-top:3px;}
.att .att-meta{display:block;margin-left:46px;font-size:11px;color:#9a9aa8;margin-top:2px;}
.divider{border-top:1.5px dashed ${p.line};margin:22px 24px 0;text-align:center;height:0;}
.divider .divider-label{display:inline-block;position:relative;top:-9px;font-size:9px;font-weight:bold;letter-spacing:0.08em;text-transform:uppercase;background:${p.tint};border:1px solid ${p.line};color:${p.primaryDark};padding:2px 10px;border-radius:9px;}
`;
}

/* ------------------------------------------------------------------ *
 * calc: precomputed lookup-table calculator
 * ------------------------------------------------------------------ */

const CALC_TYPES = ['sip', 'emi', 'plan', 'margin'];

// Per-type fallback axes/labels/rates. Used whenever the vertical's own calc
// preset wasn't authored for the requested calcType (a copy.calcType override
// would otherwise feed order counts into SIP maths and bake nonsense).
const CALC_DEFAULTS = {
  sip: {
    aOptions: [1000, 2500, 5000, 10000, 25000], bOptions: [1, 3, 5, 10, 15, 20, 25], ratePct: 12,
    aLabel: 'Monthly amount', bLabel: 'Invested for', resultLabel: 'Estimated corpus',
    promptText: 'Tap an amount and a horizon — the maths updates instantly.',
  },
  emi: {
    aOptions: [25000, 50000, 100000, 200000, 500000], bOptions: [1, 2, 3, 4, 5], ratePct: 9,
    aLabel: 'Amount', bLabel: 'Pay over', resultLabel: 'Your monthly EMI',
    promptText: 'Tap an amount and a tenure — the EMI updates instantly.',
  },
  plan: {
    aOptions: [1, 2, 4, 8, 12], bOptions: [1, 2, 3, 4], perUseFee: 99, planPrice: 299,
    aLabel: 'Uses a month', bLabel: 'People on the plan', resultLabel: 'You would save every month',
    promptText: 'Tap your usage — pay-per-use vs the flat plan, worked out live.',
  },
  margin: {
    aOptions: [10, 25, 50, 100], bOptions: [1, 2, 3, 4], unitPrice: 434, ratePct: 14.95,
    aLabel: 'Order size', bLabel: 'Leverage', resultLabel: 'Margin you pay',
    promptText: 'Tap a quantity and a leverage step — margin and funding, worked out live.',
  },
};

// Sane input windows per axis, so a hostile override can never bake an absurd
// or NaN table (validPct's contract, per calculator).
const CALC_LIMITS = {
  sip: { a: { min: 100, max: 1000000, maxLen: 5 }, b: { min: 1, max: 40, maxLen: 7 } },
  emi: { a: { min: 1000, max: 10000000, maxLen: 5 }, b: { min: 1, max: 30, maxLen: 7 } },
  plan: { a: { min: 0, max: 500, maxLen: 5 }, b: { min: 1, max: 20, maxLen: 7 } },
  margin: { a: { min: 1, max: 100000, maxLen: 5 }, b: { min: 1, max: 10, maxLen: 7 } },
};

// Every displayed number is computed HERE, in Node, at generate time — the
// result is flat string arrays (currency glyph included) that amp-bind only
// ever indexes with `s.a * B + s.b`. The whitelisted bind grammar has no
// toFixed/Math/locale, so bind never formats, rounds or computes money; the
// lookup table IS the formula, edge-case copy (break-even, zero usage)
// included. Raw glyphs here; enc()/jsonEnc() encode per destination.
function calcTables({ calcType, aOptions, bOptions, ratePct, perUseFee, planPrice, unitPrice, currency }) {
  const pt = (n) => priceText(Math.round(n), currency);
  const big = [];
  const sub = [];
  for (const a of aOptions) {
    for (const b of bOptions) {
      if (calcType === 'sip') {
        const r = ratePct / 1200;
        const n = b * 12;
        const fv = a * (((Math.pow(1 + r, n) - 1) / r) * (1 + r));
        const invested = a * n;
        big.push(pt(fv));
        sub.push(`${pt(a)} x ${n} months in = ${pt(invested)} · growth ${pt(fv - invested)}`);
      } else if (calcType === 'emi') {
        const r = ratePct / 1200;
        const n = b * 12;
        const pow = Math.pow(1 + r, n);
        const emi = (a * r * pow) / (pow - 1);
        big.push(`${pt(emi)}/mo`);
        sub.push(`${pt(a)} over ${n} months · total interest ${pt(emi * n - a)}`);
      } else if (calcType === 'plan') {
        const uses = a * b;
        const gross = uses * perUseFee;
        const save = gross - planPrice;
        if (uses === 0) {
          big.push(`${pt(planPrice)}/mo`);
          sub.push(`at zero usage the plan is ${pt(planPrice)} flat — it starts paying back on the first use`);
        } else if (save > 0) {
          big.push(pt(save));
          sub.push(`${uses} uses = ${pt(gross)} pay-per-use · plan is ${pt(planPrice)} flat`);
        } else {
          big.push('Break-even');
          sub.push(`${uses} uses = ${pt(gross)} pay-per-use vs ${pt(planPrice)} flat — about the same either way`);
        }
      } else { // margin
        const value = a * unitPrice;
        const margin = value / b;
        big.push(pt(margin));
        sub.push(`order ${pt(value)} · ${pt(value - margin)} funded at ${ratePct}% p.a.`);
      }
    }
  }
  const aVals = aOptions.map((a) => {
    if (calcType === 'plan') return `${a}/mo`;
    if (calcType === 'margin') return `Qty ${a}`;
    return pt(a);
  });
  const bVals = bOptions.map((b) => {
    if (calcType === 'sip') return `${b} yr${b === 1 ? '' : 's'}`;
    if (calcType === 'emi') return `${b * 12} months`;
    if (calcType === 'plan') return `${b} ${b === 1 ? 'person' : 'people'}`;
    return `${b}x`;
  });
  return { big, sub, aVals, bVals };
}

// Honesty-guardrail assumption line per formula, built from the numbers that
// actually fed the table so copy and maths can never disagree.
function calcAssumption(calcType, { ratePct, perUseFee, planPrice, currency }) {
  const pt = (n) => priceText(n, currency);
  if (calcType === 'sip') return `Assumes ${ratePct}% p.a., compounded monthly. Illustration only, not a promise of returns.`;
  if (calcType === 'emi') return `Assumes ${ratePct}% p.a. on reducing balance. Processing fee and taxes not included.`;
  if (calcType === 'plan') return `Pay-per-use compared at ${pt(perUseFee)} a use vs the ${pt(planPrice)}/month plan. Cancel any time.`;
  return `Assumes ${ratePct}% p.a. funding rate. Leverage amplifies losses too — margin calls apply.`;
}

function buildCalc(ctx) {
  const { brand, palette: p, content, t, currency, rng, copy = {} } = ctx;
  const cc = content.calc || {};
  const headSrc = copy.head || cc.head || t.calc;
  const head = enc(applyBrand(headSrc, brand));

  const calcType = CALC_TYPES.includes(copy.calcType) ? copy.calcType
    : (CALC_TYPES.includes(cc.calcType) ? cc.calcType : 'sip');
  const base = CALC_DEFAULTS[calcType];
  const lim = CALC_LIMITS[calcType];
  // The vertical's preset only applies when it was authored for this calcType.
  const cv = cc.calcType === calcType ? cc : {};

  const aOptions = validAxis(copy.aOptions, lim.a, validAxis(cv.aOptions, lim.a, base.aOptions));
  const bOptions = validAxis(copy.bOptions, lim.b, validAxis(cv.bOptions, lim.b, base.bOptions));
  const ratePct = validNum(copy.ratePct, 0.5, 40, validNum(cv.ratePct, 0.5, 40, base.ratePct || 12));
  const perUseFee = validNum(copy.perUseFee, 1, 1000000, validNum(cv.perUseFee, 1, 1000000, base.perUseFee || 99));
  const planPrice = validNum(copy.planPrice, 1, 1000000, validNum(cv.planPrice, 1, 1000000, base.planPrice || 299));
  const unitPrice = validNum(copy.unitPrice, 1, 10000000, validNum(cv.unitPrice, 1, 10000000, base.unitPrice || 434));

  const tbl = calcTables({ calcType, aOptions, bOptions, ratePct, perUseFee, planPrice, unitPrice, currency });
  const aVals = tbl.aVals.map((v, i) => overrideItemName(v, copy.aLabels, i));
  const { big, sub, bVals } = tbl;
  const A = aOptions.length;
  const B = bOptions.length;
  // Middle-biased seeded defaults: every combo is precomputed and valid, so a
  // reroll may open the email on a different (still sensible) starting combo.
  const defA = A > 2 ? 1 + Math.floor(rng() * (A - 2)) : Math.floor(rng() * A);
  const defB = B > 2 ? 1 + Math.floor(rng() * (B - 2)) : Math.floor(rng() * B);
  const defIdx = defA * B + defB;

  const promptText = applyBrand(strOr(copy.promptText, strOr(cv.promptText, base.promptText)), brand);
  const aLabel = applyBrand(strOr(copy.aLabel, strOr(cv.aLabel, base.aLabel)), brand);
  const bLabel = applyBrand(strOr(copy.bLabel, strOr(cv.bLabel, base.bLabel)), brand);
  const resultLabel = applyBrand(strOr(copy.resultLabel, strOr(cv.resultLabel, base.resultLabel)), brand);
  const assumptionText = applyBrand(strOr(copy.assumptionText, strOr(cv.assumptionText,
    calcAssumption(calcType, { ratePct, perUseFee, planPrice, currency }))), brand);
  // Honest-mechanics CTA: never claims an in-email payment — the latch (or an
  // explicit deep link) hands off to the brand's own app/site.
  const ctaLabel = applyBrand(strOr(copy.ctaLabel, strOr(cv.ctaLabel, 'Continue in the app')), brand);
  const doneLabel = applyBrand(strOr(copy.doneLabel, strOr(cv.doneLabel, 'Request sent — approve in your app')), brand);
  const ctaHref = safeHttpUrl(copy.ctaHref);
  const dividerLabel = applyBrand(strOr(copy.dividerLabel, strOr(cv.dividerLabel, 'Composed for you at open')), brand);
  const receiptTag = applyBrand(strOr(copy.receiptTag, strOr(cv.receiptTag, 'Your account')), brand);
  const receiptRows = (validKvRows(copy.receiptRows) || validKvRows(cv.receiptRows) || [])
    .map((r) => ({ k: applyBrand(r.k, brand), v: applyBrand(r.v, brand) }));
  const footerDefault = applyBrand(strOr(cv.footerText, 'Estimates only. Nothing is ever charged inside this email.'), brand);

  const css = baseCss(p) + receiptCss(p) + `
.pills{font-size:0;margin:0 0 6px;}
.pill{display:inline-block;font-size:13px;padding:8px 14px;border:1px solid ${p.line};border-radius:20px;margin:0 6px 6px 0;cursor:pointer;color:${p.ink};}
.pill.on{background:${p.primary};color:#ffffff;border-color:${p.primary};}
.ctl{font-size:11px;font-weight:bold;letter-spacing:0.08em;text-transform:uppercase;color:#6b6b7b;margin:16px 0 8px;}
.stepper{display:inline-flex;border:1.5px solid ${p.line};border-radius:9px;overflow:hidden;vertical-align:middle;}
.stepper .stp{width:32px;height:32px;background:${p.tint};color:${p.primaryDark};font-size:16px;font-weight:bold;cursor:pointer;text-align:center;line-height:32px;}
.stepper .stp.dim{opacity:0.35;}
.stepper .sv{min-width:72px;text-align:center;font-weight:bold;font-size:14px;line-height:32px;padding:0 8px;}
.calc-out{background:${p.tint};border:1px solid ${p.line};border-radius:12px;padding:16px;text-align:center;margin-top:18px;}
.co-label{font-size:10px;font-weight:bold;letter-spacing:0.08em;text-transform:uppercase;color:${p.primaryDark};margin:0 0 6px;}
.co-big{font-family:'Courier New',Courier,monospace;font-size:26px;font-weight:bold;color:${p.primaryDark};margin:0;}
.co-sub{font-size:12px;color:#6b6b7b;margin:6px 0 0;line-height:1.5;}
.assume{margin:10px 0 0;font-size:11px;}
.ctawrap{text-align:center;margin-top:16px;}
.btn.done{opacity:0.55;}
`;

  const pillsHtml = aVals.map((label, i) =>
    `<span class="pill${i === defA ? ' on' : ''}" role="button" tabindex="0" on="tap:AMP.setState({s:{a:${i}}})" [class]="s.a == ${i} ? 'pill on' : 'pill'">${enc(label)}</span>`).join('\n    ');

  const bMax = B - 1;
  const cta = ctaHref
    ? `<a class="btn" href="${enc(ctaHref)}" target="_blank" rel="noopener noreferrer">${enc(ctaLabel)}</a>`
    : `<span class="btn" role="button" tabindex="0" on="tap:AMP.setState({s:{done:true}})" [class]="s.done ? 'btn done' : 'btn'" [text]="s.done ? '${jsStr(doneLabel)}' : '${jsStr(ctaLabel)}'">${enc(ctaLabel)}</span>`;

  const body = `
${ampState('s', { a: defA, b: defB, done: false })}
${ampState('d', { big, sub, aVals, bVals })}
${headerBlock({ brand, palette: p, head, copy })}
${receiptRows.length ? `<div class="rwrap">${receiptCard({ tag: receiptTag, rows: receiptRows })}</div>\n${dividerRule(dividerLabel)}` : ''}
<div class="pad">
  <p class="muted">${enc(promptText)}</p>
  <p class="ctl">${enc(aLabel)}</p>
  <div class="pills">
    ${pillsHtml}
  </div>
  <p class="ctl">${enc(bLabel)}</p>
  <div class="stepper">
    <span class="stp${defB === 0 ? ' dim' : ''}" role="button" tabindex="0" on="tap:AMP.setState({s:{b: s.b - 1 &lt; 0 ? 0 : s.b - 1}})" [class]="s.b == 0 ? 'stp dim' : 'stp'">&#8722;</span>
    <span class="sv" [text]="d.bVals[s.b]">${enc(bVals[defB])}</span>
    <span class="stp${defB === bMax ? ' dim' : ''}" role="button" tabindex="0" on="tap:AMP.setState({s:{b: s.b + 1 &gt; ${bMax} ? ${bMax} : s.b + 1}})" [class]="s.b == ${bMax} ? 'stp dim' : 'stp'">+</span>
  </div>
  <div class="calc-out">
    <p class="co-label">${enc(resultLabel)}</p>
    <p class="co-big" [text]="d.big[s.a * ${B} + s.b]">${enc(big[defIdx])}</p>
    <p class="co-sub" [text]="d.sub[s.a * ${B} + s.b]">${enc(sub[defIdx])}</p>
  </div>
  <p class="muted assume">${enc(assumptionText)}</p>
  <div class="ctawrap">${cta}</div>
</div>
${footerBlock({ brand, defaultText: footerDefault, copy })}`;

  const previewModel = {
    type: 'calc', head: applyBrand(headSrc, brand), calcType,
    promptText, aLabel, bLabel, aVals, bVals, big, sub,
    defaults: { a: defA, b: defB },
    resultLabel, assumptionText, ctaLabel, doneLabel, ctaHref,
    dividerLabel, receiptTag, receiptRows,
    disclaimer: strOr(copy.footerText, footerDefault),
  };
  return { scripts: [SCRIPT_BIND], css, body, previewModel };
}

/* ------------------------------------------------------------------ *
 * report: personalised report viewer (accordion rows + verdict + slots)
 * ------------------------------------------------------------------ */

// Semantic status colours are FIXED constants, not palette-derived: green must
// stay green and amber amber whatever the brand colour — only chrome brands.
const STATUS_OK = { fg: '#0a6b51', bg: '#e4f0ea' };
const STATUS_ATTN = { fg: '#b45309', bg: '#fff3dc' };

// copy.rows arrives whole or not at all (buildQuiz's validOverride rule):
// every row needs a name and a display value; status is coerced to 'normal'
// unless it is exactly 'attention'; optional strings are trimmed and capped.
function validReportRows(arr) {
  if (!Array.isArray(arr) || arr.length < 3) return null;
  const out = [];
  for (const r of arr.slice(0, 6)) {
    if (!r || typeof r !== 'object') return null;
    const name = strOr(r.name, '').slice(0, 48);
    const value = strOr(r.value, '').slice(0, 28);
    if (!name || !value) return null;
    out.push({
      name,
      value,
      sub: strOr(r.sub, '').slice(0, 60),
      unit: strOr(r.unit, '').slice(0, 12),
      range: strOr(r.range, '').slice(0, 40),
      status: r.status === 'attention' ? 'attention' : 'normal',
      detail: strOr(r.detail, '').slice(0, 260),
    });
  }
  return out;
}

function buildReport(ctx) {
  const { brand, palette: p, content, t, rng, copy = {} } = ctx;
  const rc = content.report || {};
  const headSrc = copy.head || rc.head || t.report;
  const head = enc(applyBrand(headSrc, brand));

  // rng is consumed identically whether or not a rows override lands, so a
  // copy override never perturbs this seed's other draws (the same discipline
  // the pickModuleId comment demands of generate() itself).
  const sampled = validReportRows(shuffle(rng, rc.rows || []).slice(0, 4));
  const rows = (validReportRows(copy.rows) || sampled || []).map((r) => ({
    ...r,
    name: applyBrand(r.name, brand),
    sub: applyBrand(r.sub, brand),
    detail: applyBrand(r.detail || (r.range ? `Typical range: ${r.range}.`
      : (r.status === 'attention' ? 'Worth a quick follow-up — details in the app.'
        : 'Nothing to do here — this one is on track.')), brand),
  }));
  const attnCount = rows.filter((r) => r.status === 'attention').length;

  const slSrc = (copy.statusLabels && typeof copy.statusLabels === 'object' && !Array.isArray(copy.statusLabels)) ? copy.statusLabels : {};
  const rcSl = (rc.statusLabels && typeof rc.statusLabels === 'object') ? rc.statusLabels : {};
  const statusLabels = {
    normal: strOr(slSrc.normal, strOr(rcSl.normal, 'In range')).slice(0, 20),
    attention: strOr(slSrc.attention, strOr(rcSl.attention, 'Needs a look')).slice(0, 20),
  };

  const reportNoun = strOr(copy.reportNoun, strOr(rc.reportNoun, 'report')).slice(0, 24);
  const itemNoun = strOr(copy.itemNoun, strOr(rc.itemNoun, 'items')).slice(0, 20);
  const receiptTag = applyBrand(strOr(copy.receiptTag, strOr(rc.receiptTag, `Your ${reportNoun}`)), brand);
  const metaRows = (validKvRows(copy.metaRows) || validKvRows(rc.metaRows) || [])
    .map((r) => ({ k: applyBrand(r.k, brand), v: applyBrand(r.v, brand) }));
  const attachmentName = strOr(copy.attachmentName, strOr(rc.attachmentName, ''));
  const attachmentMeta = strOr(copy.attachmentMeta, strOr(rc.attachmentMeta, 'secure download'));
  const dividerLabel = applyBrand(strOr(copy.dividerLabel, strOr(rc.dividerLabel, 'Personalised for you · composed at open')), brand);

  // The verdict is a STATIC string composed here from the rows that actually
  // rendered — bind never counts or branches on statuses.
  const verdictAction = strOr(copy.verdictAction, strOr(rc.verdictAction, 'a quick follow-up would sort it.'));
  const verdictText = applyBrand(strOr(copy.verdictText,
    attnCount === 0
      ? `All ${rows.length} ${itemNoun} look good — nothing needs action right now.`
      : `${attnCount} of ${rows.length} ${itemNoun} could use attention — ${verdictAction}`), brand);
  const verdictCta = applyBrand(strOr(copy.verdictCta, strOr(rc.verdictCta, 'See what it means')), brand);

  const nextPrompt = applyBrand(strOr(copy.nextPrompt, strOr(rc.nextPrompt, 'What next?')), brand);
  const slotLabels = (validStrList(copy.slotLabels, 4, 36) || validStrList(rc.slotLabels, 4, 36)
    || ['Book a follow-up', 'Email me the details']).map((s) => applyBrand(s, brand));
  const pickPrompt = applyBrand(strOr(copy.pickPrompt, strOr(rc.pickPrompt, 'Pick an option first')), brand);
  const ctaLabel = applyBrand(strOr(copy.ctaLabel, strOr(rc.ctaLabel, 'Book it')), brand);
  const doneLabel = applyBrand(strOr(copy.doneLabel, strOr(rc.doneLabel, '✓ Booked — confirmation on its way')), brand);
  const footerDefault = applyBrand(strOr(rc.footerText, 'This summary is informational, not advice.'), brand);

  const attn = attnCount > 0;
  const css = baseCss(p) + receiptCss(p) + `
.rrow{border:1px solid ${p.line};border-radius:10px;padding:12px;margin:0 0 8px;cursor:pointer;overflow:hidden;}
.rrow.open{border-color:${p.primary};background:${p.tint};}
.car{float:right;color:#9a9aa8;font-size:12px;margin-left:8px;}
.rright{float:right;text-align:right;margin-left:8px;}
.rval{font-weight:bold;font-size:13px;}
.rval.normal{color:${STATUS_OK.fg};}
.rval.attention{color:${STATUS_ATTN.fg};}
.rstat{display:inline-block;font-size:10px;font-weight:bold;border-radius:8px;padding:2px 8px;margin-left:6px;}
.rstat.normal{background:${STATUS_OK.bg};color:${STATUS_OK.fg};}
.rstat.attention{background:${STATUS_ATTN.bg};color:${STATUS_ATTN.fg};}
.rname{font-size:14px;font-weight:bold;margin:0;}
.rsub{font-size:11px;color:#9a9aa8;margin:2px 0 0;}
.rdetail p{font-size:12px;color:#6b6b7b;line-height:1.5;margin:8px 0 0;}
.rdetail .rrange{color:#9a9aa8;font-size:11px;}
.vwrap{text-align:center;margin:14px 0 0;}
.verdict{border-radius:10px;padding:14px 16px;margin:14px 0 0;background:${attn ? STATUS_ATTN.bg : STATUS_OK.bg};}
.verdict p{margin:0;font-size:13px;line-height:1.5;font-weight:bold;color:${attn ? STATUS_ATTN.fg : STATUS_OK.fg};}
.np{font-size:11px;font-weight:bold;letter-spacing:0.08em;text-transform:uppercase;color:#6b6b7b;margin:20px 0 8px;}
.slots{font-size:0;}
.slot{display:inline-block;font-size:13px;font-weight:bold;text-align:center;border:1.5px solid ${p.line};border-radius:9px;padding:10px 14px;margin:0 8px 8px 0;cursor:pointer;color:${p.ink};}
.slot.on{background:${p.primary};border-color:${p.primary};color:#ffffff;}
.rcta{margin-top:6px;}
.btn.off{opacity:0.5;}
.btn.done{background:${STATUS_OK.fg};}
`;

  const rowsHtml = rows.map((r, i) => `<div class="rrow" role="button" tabindex="0" on="tap:AMP.setState({s:{open: s.open == ${i} ? -1 : ${i}}})" [class]="s.open == ${i} ? 'rrow open' : 'rrow'">
    <span class="car" [text]="s.open == ${i} ? '${jsStr('▴')}' : '${jsStr('▾')}'">${enc('▾')}</span>
    <span class="rright"><span class="rval ${r.status}">${enc(r.value)}${r.unit ? ' ' + enc(r.unit) : ''}</span><span class="rstat ${r.status}">${enc(statusLabels[r.status])}</span></span>
    <p class="rname">${enc(r.name)}</p>${r.sub ? `\n    <p class="rsub">${enc(r.sub)}</p>` : ''}
    <div class="rdetail" hidden [hidden]="s.open != ${i}">
      <p>${enc(r.detail)}</p>${r.range ? `\n      <p class="rrange">Typical: ${enc(r.range)}</p>` : ''}
    </div>
  </div>`).join('\n  ');

  const slotsHtml = slotLabels.map((label, i) =>
    `<span class="slot" role="button" tabindex="0" on="tap:AMP.setState({s:{sel:${i}}})" [class]="s.sel == ${i} ? 'slot on' : 'slot'">${enc(label)}</span>`).join('\n    ');

  // The gated CTA: disabled-look until a slot is picked, then it echoes the
  // pick back ("Book it · 7:30 PM today" — the decks' signature write-back
  // moment), then latches done. All in comparisons against integer literals.
  const gatedCta = `<span class="btn off" role="button" tabindex="0" on="tap:AMP.setState({s:{done: s.sel &gt;= 0 ? true : false}})" [class]="s.done ? 'btn done' : (s.sel &gt;= 0 ? 'btn' : 'btn off')" [text]="s.done ? '${jsStr(doneLabel)}' : (s.sel &gt;= 0 ? '${jsStr(ctaLabel + ' · ')}' + d.slotLabels[s.sel] : '${jsStr(pickPrompt)}')">${enc(pickPrompt)}</span>`;

  const body = `
${ampState('s', { open: -1, rev: false, sel: -1, done: false })}
${ampState('d', { slotLabels })}
${headerBlock({ brand, palette: p, head, copy })}
${(metaRows.length || attachmentName) ? `<div class="rwrap">${receiptCard({ tag: receiptTag, rows: metaRows, attachment: attachmentName ? { name: attachmentName, meta: attachmentMeta } : null })}</div>` : ''}
${dividerRule(dividerLabel)}
<div class="pad">
  ${rowsHtml}
  <div class="vwrap" [hidden]="s.rev">
    <span class="btn" role="button" tabindex="0" on="tap:AMP.setState({s:{rev:true}})">${enc(verdictCta)}</span>
  </div>
  <div class="verdict" hidden [hidden]="!s.rev"><p>${enc(verdictText)}</p></div>
  <p class="np">${enc(nextPrompt)}</p>
  <div class="slots">
    ${slotsHtml}
  </div>
  <div class="rcta">${gatedCta}</div>
</div>
${footerBlock({ brand, defaultText: footerDefault, copy })}`;

  const previewModel = {
    type: 'report', head: applyBrand(headSrc, brand),
    receiptTag, metaRows,
    attachmentName: attachmentName || null,
    attachmentMeta: attachmentName ? attachmentMeta : null,
    dividerLabel,
    rows: rows.map((r) => ({ ...r, statusLabel: statusLabels[r.status] })),
    statusLabels, attnCount,
    verdictCta, verdictText, nextPrompt, slotLabels, pickPrompt, ctaLabel, doneLabel,
    disclaimer: strOr(copy.footerText, footerDefault),
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
  calc: { name: 'Interactive Calculator', kind: 'calculator', build: buildCalc },
  report: { name: 'Personal Report', kind: 'report', build: buildReport },
};
const MODULE_IDS = Object.keys(MODULES);

// The seeded random pick draws over the ORIGINAL six modules only. Both pick
// sites compute `rng() * pool.length`, so growing the pool would silently
// remap every existing brand+counter seed to a different module — exactly the
// drift the RNG-order comments below forbid. calc and report are therefore
// reachable only by an explicit moduleId (UI picker, brief routing, slate
// fan-out), never by the seeded random pick. If a module is ever added to
// this pool deliberately, accept that every stored seed re-rolls.
const RANDOM_POOL_IDS = ['reveal', 'search', 'quiz', 'rating', 'spin', 'poll'];

// Extracted so callers (e.g. the /generate route, to pre-compute a moduleId
// before invoking any brief-driven content composition) can resolve the same
// module a plain generate() call would pick, without duplicating/drifting
// from the selection logic below. Deterministic: same brand+counter always
// picks the same module when none is explicitly given.
function pickModuleId({ brand, counter, moduleId } = {}) {
  if (moduleId && MODULES[moduleId]) return moduleId;
  const b = (brand || 'Acme').trim() || 'Acme';
  const c = Number.isFinite(counter) ? counter : 0;
  const rng = mulberry32(hashSeed(b + ':' + c));
  return RANDOM_POOL_IDS[Math.floor(rng() * RANDOM_POOL_IDS.length)];
}

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

  // Same rule pickModuleId() applies, expressed against this call's own rng
  // instance: consume rng() only when no valid moduleId was supplied, so
  // pre-resolving a moduleId via pickModuleId() before calling generate()
  // never perturbs the rest of this call's random sequence (item shuffles,
  // discount %, etc).
  let moduleId = opts.moduleId;
  if (!moduleId || !MODULES[moduleId]) {
    moduleId = RANDOM_POOL_IDS[Math.floor(rng() * RANDOM_POOL_IDS.length)];
  }
  const mod = MODULES[moduleId];
  const built = mod.build({ brand, vertical, tone, palette, content, t, currency, rng, copy: opts.copy || {} });
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
  generate, derivePalette, MODULES, MODULE_IDS, pickModuleId,
  enc, formatPrice, CURRENCIES, VERTICALS,
};
