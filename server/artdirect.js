'use strict';

// Part A — the art-direction engine. Composes a complete, brand-authentic
// creative AROUND the interactive mechanic:
//
//   brandHeader  →  heroSection  →  [ mechanic ]  →  productStrip  →  promoStrip  →  footer
//
// Every section returns { html, css }. `html` is one or more <tr> rows that slot
// straight into build.js's 600px <table class="w600">. All CSS is AMP4EMAIL
// data-css-strict-safe (validator-confirmed): gradients + real <div> layers +
// transform/skew + absolute top/left/right/bottom + box-shadow/text-shadow.
// NEVER: ::before/::after content, clip-path, inset shorthand, backdrop-filter,
// -webkit-text-stroke, background-clip:text, data: URIs, or inline SVG — every
// one of those is rejected by the real amphtml-validator.
//
// Inline style="" attributes ARE permitted in AMP4EMAIL (the existing modules
// rely on them and pass), so per-instance colour/position is set inline while
// shared structure lives in the returned amp-custom CSS.

const { enc, formatPrice, CURRENCIES } = require('./generate');

// ---- colour helpers ---------------------------------------------------------
function _rgb(hex) { const h = String(hex || '').replace('#', ''); const s = h.length === 3 ? h.split('').map((c) => c + c).join('') : h; const n = parseInt(s, 16); return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 }; }
function mix(a, b, t) { const x = _rgb(a), y = _rgb(b); const c = (k) => Math.round(x[k] + (y[k] - x[k]) * t).toString(16).padStart(2, '0'); return '#' + c('r') + c('g') + c('b'); }
function lumOf(hex) {
  const h = String(hex || '').replace('#', '');
  if (h.length < 6) return 0.5;
  const ch = (i) => { const c = parseInt(h.slice(i, i + 2), 16) / 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  return 0.2126 * ch(0) + 0.7152 * ch(2) + 0.0722 * ch(4);
}
function onColor(hex) { return lumOf(hex) > 0.55 ? '#1a1a1a' : '#ffffff'; }
function rgba(hex, a) {
  const h = String(hex || '').replace('#', '');
  if (h.length < 6) return `rgba(0,0,0,${a})`;
  const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${a})`;
}
function softInk(ink) { return ink === '#ffffff' ? 'rgba(255,255,255,0.86)' : 'rgba(26,26,26,0.74)'; }

// ---- currency + escaping ----------------------------------------------------
function symbolFor(currency) { return CURRENCIES[currency] || CURRENCIES.INR; }
// raw {c} substitution (caller will enc) — for values passed through enc later
function subc(text, currency) { return String(text == null ? '' : text).replace(/\{c\}/g, symbolFor(currency)); }
// {c} substitution + entity-encode — for direct HTML insertion
function tok(text, currency) { return enc(subc(text, currency)); }
// inline-style-safe font (no double quotes inside a style="" attribute)
function q(font) { return String(font || '').replace(/"/g, "'"); }

// ---- decorative primitives (absolute <div> layers) --------------------------
const L = (s) => `<div style="${s}"></div>`;
const ring = (pos, color, bw) => L(`position:absolute;border-radius:50%;border:${bw || '2px'} solid ${color};${pos}`);
const disc = (pos, color) => L(`position:absolute;border-radius:50%;background:${color};${pos}`);
const band = (pos, color) => L(`position:absolute;background:${color};${pos}`);

// ---- amp-img ----------------------------------------------------------------
function ampImg(a, o = {}) {
  if (!a || !a.url) return '';
  const w = o.width || a.width, h = o.height || a.height;
  return `<amp-img src="${a.url}" width="${w}" height="${h}" layout="${o.layout || 'responsive'}" alt="${enc(o.alt || a.name || '')}"${o.cls ? ` class="${o.cls}"` : ''}></amp-img>`;
}

// A "photographic" asset is a real image (brand-site / web stock / user), never
// a generated flat-colour placeholder. Used to decide editorial photo vs CSS.
function isPhoto(a) {
  if (!a || !a.url || !/^https:/i.test(a.url)) return false;
  if (a.tier === 'generated') return false;
  if (/placehold\.co/i.test(a.url)) return false;
  return true;
}
function photoAsset(ctx) {
  const prods = ((ctx && ctx.products) || []).filter(isPhoto);
  if (prods.length) return prods[0];
  if (isPhoto(ctx && ctx.hero)) return ctx.hero;
  return null;
}

module.exports = {
  brandHeader, heroSection, productStrip, promoStrip, footer,
  // exported for tests / reuse
  onColor, rgba, isPhoto, photoAsset, ampImg, tok,
};

// (section builders are defined below; hoisted function declarations)

// ===========================================================================
//  BRAND HEADER  — logo + the brand's real nav
// ===========================================================================
function logoBlock(ctx, h) {
  const { logo, brandName } = ctx;
  if (logo && logo.url) {
    const ratio = (logo.width && logo.height) ? (logo.width / logo.height) : 2.4;
    let w = Math.round(ratio * h); w = Math.max(h, Math.min(190, w));
    return `<amp-img class="ahh-logo" src="${logo.url}" width="${w}" height="${h}" layout="fixed" alt="${enc(brandName + ' logo')}"></amp-img>`;
  }
  return `<span class="ahh-word">${enc(brandName)}</span>`;
}

function brandHeader(ctx) {
  const { p, brand, aesName, aes } = ctx;
  const lux = (aesName === 'luxury' || aesName === 'minimal');
  const navItems = ((brand && brand.nav) || []).slice(0, 6);
  const css = [
    `.ahh{background:#ffffff;border-bottom:1px solid ${p.line};}`,
    '.ahh-pad{padding:15px 24px;}',
    `.ahh-word{font-family:${q(aes.headFont)};font-weight:bold;font-size:19px;color:${p.primary};letter-spacing:0.01em;}`,
    // inline-block keeps each item atomic (never breaks mid-word) while letting
    // the row wrap between items on a narrow phone instead of overflowing.
    `.ahh-navi{display:inline-block;color:${p.ink};font-size:12.5px;font-weight:bold;font-family:${q(aes.bodyFont)};margin-left:18px;white-space:nowrap;}`,
    // luxury centred variant
    '.ahh-cpad{padding:22px 24px 18px;text-align:center;}',
    '.ahh-cnav{margin-top:13px;}',
    `.ahh-cnav .ahh-navi{margin:0 11px;font-weight:normal;font-size:11.5px;letter-spacing:0.16em;text-transform:uppercase;color:${p.ink};}`,
    // small-screen header: tighter padding + nav so it never clips at ~375px
    '@media (max-width:479px){.ahh-pad{padding:13px 16px;}.ahh-navi{margin-left:13px;font-size:11px;}.ahh-cpad{padding:18px 16px 15px;}.ahh-cnav .ahh-navi{margin:0 7px;font-size:10.5px;letter-spacing:0.1em;}}',
  ].join('');
  let html;
  if (lux) {
    const nav = navItems.map((n) => `<span class="ahh-navi">${enc(n)}</span>`).join('');
    html = '<tr><td class="ahh"><div class="ahh-cpad">' +
      logoBlock(ctx, 30) +
      (nav ? `<div class="ahh-cnav">${nav}</div>` : '') +
      '</div></td></tr>';
  } else {
    const nav = navItems.map((n) => `<span class="ahh-navi">${enc(n)}</span>`).join('');
    html = '<tr><td class="ahh"><div class="ahh-pad">' +
      '<table role="presentation" width="100%"><tr>' +
      `<td align="left" valign="middle">${logoBlock(ctx, 30)}</td>` +
      `<td align="right" valign="middle">${nav}</td>` +
      '</tr></table></div></td></tr>';
  }
  return { html, css };
}

// ===========================================================================
//  HERO  — shared structure + per-theme composition
// ===========================================================================
function heroCss(ctx) {
  const SANS = q(ctx.aes.bodyFont);
  return [
    '.ah-hero{position:relative;overflow:hidden;}',
    '.ah-hero-tx{position:absolute;left:0;right:0;bottom:0;}',
    '.ah-ed-tx{position:relative;}',
    `.ah-eyebrow{margin:0 0 11px;font-weight:bold;text-transform:uppercase;font-family:${SANS};}`,
    `.ah-h1{margin:0;line-height:1.08;font-weight:bold;font-family:${SANS};}`,
    `.ah-hsub{margin:13px 0 0;line-height:1.5;font-family:${SANS};}`,
    ".ah-serif{font-family:Georgia,'Times New Roman',serif;}",
    '.ah-photo img{object-fit:cover;}',
  ].join('');
}

function heroText(t) {
  const sc = t.serif ? ' ah-serif' : '';
  const eLs = t.serif ? '0.26em' : '0.16em';
  const wrap = t.flow ? 'ah-ed-tx' : 'ah-hero-tx';
  const centerSub = t.align === 'center' ? 'margin-left:auto;margin-right:auto;' : '';
  return `<div class="${wrap}" style="text-align:${t.align};padding:${t.pad};">` +
    (t.eyebrow ? `<p class="ah-eyebrow${sc}" style="color:${t.eColor};font-size:12px;letter-spacing:${eLs};">${enc(t.eyebrow)}</p>` : '') +
    `<h1 class="ah-h1${sc}" style="color:${t.tColor};font-size:${t.tSize};${t.serif ? 'font-weight:normal;' : ''}">${enc(t.title)}</h1>` +
    (t.rule ? `<div style="width:54px;height:${t.serif ? '1px' : '3px'};background:${t.rule};margin:16px ${t.align === 'center' ? 'auto' : '0'} 0;"></div>` : '') +
    (t.sub ? `<p class="ah-hsub${sc}" style="color:${t.sColor};font-size:14px;max-width:90%;${centerSub}">${enc(t.sub)}</p>` : '') +
    '</div>';
}

const HERO_KICKER = { Fashion: 'New Season', Food: 'Chef’s Selection', Finance: 'Plan Ahead', Beauty: 'New Arrivals', Electronics: 'Just Launched', Travel: 'Now Boarding', Generic: 'Featured' };
const HERO_SUB = {
  Fashion: 'Discover the pieces everyone is talking about this season.',
  Food: 'Crafted to be remembered, course by course.',
  Finance: 'A few minutes today secures their tomorrow.',
  Beauty: 'The edit our experts are reaching for right now.',
  Electronics: 'Smarter tech, picked and priced for you.',
  Travel: 'Your next escape is one tap away.',
  Generic: 'Something special, chosen just for you.',
};

function heroSection(ctx) {
  const { brand, brandName, vertical, currency, copy } = ctx;
  const theme = (brand && brand.heroTheme) || 'generic';
  const offer = brand && brand.promo && brand.promo.offer;
  const eyebrow = subc(copy.heroEyebrow || (brand && brand.tagline) || HERO_KICKER[vertical] || HERO_KICKER.Generic, currency);
  const title = subc(copy.head || `${brandName}, just for you`, currency);
  const sub = subc(copy.heroSub || (offer ? offer.text : (HERO_SUB[vertical] || HERO_SUB.Generic)), currency);
  const t0 = { eyebrow, title, sub };

  if (theme === 'editorial') return editorialHero(ctx, t0);
  return graphicHero(theme, ctx, t0);
}

// ---- photographic / CSS editorial (luxury) ---------------------------------
function editorialHero(ctx, t0) {
  const { p } = ctx;
  const css = heroCss(ctx);
  const photo = photoAsset(ctx);
  if (photo) {
    const img = ampImg(photo, { width: 600, height: 380, layout: 'responsive', alt: t0.title, cls: 'ah-photo' });
    const scrim = band('left:0;right:0;top:0;bottom:0;', `linear-gradient(180deg, ${rgba('#000000', 0.04)} 0%, ${rgba('#000000', 0.14)} 44%, ${rgba('#000000', 0.74)} 100%)`);
    const edge = band('left:0;right:0;bottom:0;height:4px;', p.accent);
    const tx = heroText({ ...t0, align: 'left', eColor: p.accent, tColor: '#ffffff', sColor: 'rgba(255,255,255,0.88)', tSize: '30px', pad: '32px 34px 34px', serif: true });
    return { html: `<tr><td><div class="ah-hero">${img}${scrim}${edge}${tx}</div></td></tr>`, css };
  }
  // CSS editorial fallback — deep brand gradient, thin gold frame, centred serif
  const ink = onColor(p.primary);
  const bg = `background:linear-gradient(160deg, ${p.primary} 0%, ${p.primaryDark} 100%);`;
  const frame = band('left:18px;right:18px;top:18px;bottom:18px;border:1px solid ' + rgba(p.accent, 0.55) + ';', 'transparent');
  const tx = heroText({ ...t0, align: 'center', eColor: p.accent, tColor: ink, sColor: softInk(ink), tSize: '28px', pad: '52px 44px', serif: true, rule: p.accent, flow: true });
  return { html: `<tr><td><div class="ah-hero" style="${bg}">${frame}${tx}</div></td></tr>`, css };
}

// ---- CSS graphic heroes -----------------------------------------------------
function graphicHero(theme, ctx, t0) {
  const { p } = ctx;
  const css = heroCss(ctx);
  const A = p.primary, D = p.primaryDark, C = p.accent, INKW = '#ffffff';
  let bg, decor, tx;

  if (theme === 'fintech') {
    // clean / trustworthy: light field, brand-coloured angled panel on the right
    bg = `background:linear-gradient(180deg, #ffffff 0%, ${p.tint} 100%);`;
    decor =
      band('top:-34px;bottom:-34px;right:-70px;width:300px;transform:skewX(-10deg);', `linear-gradient(160deg, ${A}, ${D})`) +
      ring('top:54px;right:46px;width:118px;height:118px;', rgba('#ffffff', 0.20), '7px') +
      disc('top:88px;right:80px;width:50px;height:50px;', rgba(C, 0.92)) +
      band('left:34px;bottom:38px;width:48px;height:3px;', C);
    tx = heroText({ ...t0, align: 'left', eColor: A, tColor: p.ink, sColor: '#6b6b7b', tSize: '29px', pad: '34px 200px 40px 34px' });
  } else if (theme === 'food') {
    bg = `background:linear-gradient(135deg, ${A} 0%, ${mix(A, '#ff7a3d', 0.34)} 100%);`;
    decor =
      disc('bottom:-90px;right:-50px;width:230px;height:230px;', rgba('#ffffff', 0.12)) +
      disc('top:-40px;left:-30px;width:140px;height:140px;', rgba(C, 0.85)) +
      ring('top:34px;right:60px;width:120px;height:120px;', rgba('#ffffff', 0.18), '2px') +
      band('left:-50px;right:-50px;bottom:-26px;height:96px;transform:skewY(-4deg);', rgba('#ffffff', 0.10));
    tx = heroText({ ...t0, align: 'left', eColor: rgba('#ffffff', 0.92), tColor: INKW, sColor: 'rgba(255,255,255,0.88)', tSize: '32px', pad: '32px 34px 34px' });
  } else if (theme === 'beauty') {
    bg = `background:linear-gradient(135deg, ${p.tint} 0%, ${mix(A, '#ffffff', 0.42)} 100%);`;
    const ink = onColor(p.tint);
    decor =
      disc('top:-50px;right:-30px;width:180px;height:180px;', rgba(C, 0.30)) +
      ring('bottom:-60px;left:30px;width:170px;height:170px;', rgba(A, 0.30), '2px') +
      disc('top:60px;left:-40px;width:120px;height:120px;', rgba('#ffffff', 0.5));
    tx = heroText({ ...t0, align: 'left', eColor: A, tColor: ink, sColor: softInk(ink), tSize: '30px', pad: '34px 34px 36px', serif: true });
  } else if (theme === 'tech') {
    bg = `background:linear-gradient(135deg, ${mix(D, '#0b0d14', 0.5)} 0%, ${D} 100%);`;
    decor =
      band('top:0;bottom:0;left:18%;width:2px;transform:skewX(-14deg);', rgba(C, 0.55)) +
      band('top:0;bottom:0;left:32%;width:1px;transform:skewX(-14deg);', rgba('#ffffff', 0.18)) +
      ring('top:-50px;right:-40px;width:200px;height:200px;', rgba(C, 0.35), '2px') +
      disc('bottom:30px;right:40px;width:14px;height:14px;', C);
    tx = heroText({ ...t0, align: 'left', eColor: C, tColor: INKW, sColor: 'rgba(255,255,255,0.82)', tSize: '31px', pad: '34px 34px 36px' });
  } else if (theme === 'sport') {
    bg = `background:linear-gradient(120deg, ${A} 0%, ${A} 52%, ${D} 52%, ${D} 100%);`;
    decor =
      band('top:-40px;bottom:-40px;left:46%;width:60px;transform:skewX(-12deg);', rgba('#ffffff', 0.14)) +
      band('top:-40px;bottom:-40px;left:54%;width:18px;transform:skewX(-12deg);', rgba(C, 0.9)) +
      ring('top:30px;right:40px;width:120px;height:120px;', rgba('#ffffff', 0.25), '3px') +
      disc('top:58px;right:68px;width:64px;height:64px;', rgba(C, 0.95));
    tx = heroText({ ...t0, align: 'left', eColor: rgba('#ffffff', 0.92), tColor: INKW, sColor: 'rgba(255,255,255,0.85)', tSize: '33px', pad: '32px 34px 34px' });
  } else {
    // festive (energetic, illustrated) — also the generic default
    bg = `background:linear-gradient(135deg, ${A} 0%, ${D} 100%);`;
    decor =
      ring('top:-80px;right:-70px;width:280px;height:280px;', rgba(C, 0.55), '2px') +
      ring('top:20px;right:64px;width:166px;height:166px;', rgba('#ffffff', 0.16), '2px') +
      disc('top:-20px;right:140px;width:118px;height:118px;', rgba(C, 0.85)) +
      band('left:-50px;right:-50px;bottom:-28px;height:104px;transform:skewY(-5deg);', rgba(C, 0.14)) +
      disc('left:32px;top:42px;width:12px;height:12px;', rgba('#ffffff', 0.5)) +
      disc('left:62px;top:72px;width:8px;height:8px;', rgba(C, 0.9)) +
      disc('left:46px;top:98px;width:6px;height:6px;', rgba('#ffffff', 0.4));
    tx = heroText({ ...t0, align: 'left', eColor: rgba('#ffffff', 0.92), tColor: INKW, sColor: 'rgba(255,255,255,0.86)', tSize: '33px', pad: '32px 34px 34px' });
  }
  const html = `<tr><td><div class="ah-hero" style="${bg}height:288px;">${decor}${tx}</div></td></tr>`;
  return { html, css };
}

// ===========================================================================
//  PRODUCT STRIP  — aesthetic-aware: luxury editorial · value grid · plan cards
// ===========================================================================
const STRIP_HEAD = {
  value: 'Picked for you', luxury: 'The Edit', fintech: 'Plans for every milestone',
};

function productStrip(ctx) {
  const { p, products, currency, aesName } = ctx;
  const items = (products || []).filter((x) => x && (x.url || x.name));
  if (items.length < 2) return { html: '', css: '' };
  if (aesName === 'fintech') return planCards(ctx, items);
  if (aesName === 'luxury' || aesName === 'minimal') return editorialProducts(ctx, items);
  return valueGrid(ctx, items);
}

// value / playful / bold — 2×2 grid cards with strike price + discount chip
function valueGrid(ctx, items) {
  const { p, currency } = ctx;
  const four = items.slice(0, 4);
  const css = [
    '.ahps{background:#ffffff;}',
    '.ahps-pad{padding:26px 18px 14px;}',
    `.ahps-h2{margin:0 0 16px;font-size:13px;letter-spacing:0.14em;text-transform:uppercase;font-weight:bold;color:${p.ink};font-family:${q(ctx.aes.headFont)};}`,
    '.ahps-cell{padding:7px;}',
    `.ahps-img{border-radius:12px;overflow:hidden;border:1px solid ${p.line};}`,
    `.ahps-name{margin:11px 0 3px;font-size:13px;font-weight:bold;line-height:1.3;color:${p.ink};font-family:${q(ctx.aes.bodyFont)};}`,
    `.ahps-price{font-size:15px;font-weight:bold;color:${p.primary};font-family:${q(ctx.aes.bodyFont)};}`,
    '.ahps-mrp{font-size:12px;text-decoration:line-through;color:#9aa0a6;margin-left:6px;font-weight:normal;}',
    `.ahps-disc{font-size:11px;font-weight:bold;margin-left:6px;color:${p.accent};}`,
    `.ahps-cta{display:inline-block;margin:12px 0 2px;text-decoration:none;font-size:12px;font-weight:bold;padding:9px 18px;border-radius:8px;background:${p.accent};color:${onColor(p.accent)};font-family:${q(ctx.aes.bodyFont)};}`,
  ].join('');
  const card = (prod) => {
    const priceN = prod.price || 0;
    const hasPrice = priceN > 0;
    const mrp = Math.round((priceN * 1.6) / 10) * 10;
    const discPct = hasPrice ? Math.round((1 - priceN / mrp) * 100) : 0;
    const img = prod.url ? `<div class="ahps-img">${ampImg(prod, { width: 280, height: 200, alt: prod.name })}</div>` : '';
    const price = hasPrice
      ? `<div class="ahps-price">${formatPrice(priceN, currency)}<span class="ahps-mrp">${formatPrice(mrp, currency)}</span><span class="ahps-disc">${discPct}% off</span></div>`
      : '';
    return `<td width="50%" valign="top" class="ahps-cell"><table role="presentation" width="100%">` +
      `<tr><td>${img}</td></tr>` +
      `<tr><td><div class="ahps-name">${enc(prod.name)}</div>${price}</td></tr>` +
      '</table></td>';
  };
  const rows = [];
  for (let i = 0; i < four.length; i += 2) {
    rows.push('<tr>' + four.slice(i, i + 2).map(card).join('') + '</tr>');
  }
  const html = '<tr><td class="ahps"><div class="ahps-pad">' +
    `<h2 class="ahps-h2">${enc(STRIP_HEAD.value)}</h2>` +
    `<table role="presentation" width="100%">${rows.join('')}</table>` +
    `<div style="text-align:center;margin-top:10px;"><span class="ahps-cta">Shop the collection</span></div>` +
    '</div></td></tr>';
  return { html, css };
}

// luxury / minimal — two large editorial cards, serif, no discount
function editorialProducts(ctx, items) {
  const { p, currency } = ctx;
  const two = items.slice(0, 2);
  const css = [
    '.ahpl{background:#ffffff;}',
    '.ahpl-pad{padding:34px 26px 22px;}',
    `.ahpl-h2{margin:0 0 22px;font-size:13px;letter-spacing:0.24em;text-transform:uppercase;font-weight:normal;text-align:center;color:${p.ink};font-family:Georgia,'Times New Roman',serif;}`,
    '.ahpl-cell{padding:0 12px;}',
    '.ahpl-img{overflow:hidden;}',
    `.ahpl-name{margin:14px 0 4px;font-size:16px;font-weight:normal;line-height:1.3;text-align:center;color:${p.ink};font-family:Georgia,'Times New Roman',serif;}`,
    `.ahpl-price{font-size:13px;text-align:center;color:${p.primary};letter-spacing:0.04em;}`,
    `.ahpl-link{display:inline-block;margin-top:12px;font-size:11px;font-weight:bold;letter-spacing:0.18em;text-transform:uppercase;text-decoration:none;color:${p.primary};border-bottom:1px solid ${p.accent};padding-bottom:3px;}`,
  ].join('');
  const card = (prod) => {
    const img = prod.url ? `<div class="ahpl-img">${ampImg(prod, { width: 280, height: 340, alt: prod.name })}</div>` : '';
    const price = prod.price > 0 ? `<div class="ahpl-price">${formatPrice(prod.price, currency)}</div>` : '';
    return `<td width="50%" valign="top" class="ahpl-cell"><table role="presentation" width="100%">` +
      `<tr><td>${img}</td></tr>` +
      `<tr><td align="center"><div class="ahpl-name">${enc(prod.name)}</div>${price}</td></tr>` +
      '</table></td>';
  };
  const html = '<tr><td class="ahpl"><div class="ahpl-pad">' +
    `<h2 class="ahpl-h2">${enc(STRIP_HEAD.luxury)}</h2>` +
    `<table role="presentation" width="100%"><tr>${two.map(card).join('')}</tr></table>` +
    `<div style="text-align:center;margin-top:22px;"><span class="ahpl-link">Discover the collection</span></div>` +
    '</div></td></tr>';
  return { html, css };
}

// fintech — plan cards: name, "from {price}", two ticks, a primary CTA
function planCards(ctx, items) {
  const { p, currency, brand } = ctx;
  const two = items.slice(0, 2);
  const feats = ((brand && brand.promo && brand.promo.strip) || ['Tax benefits u/s 80C', 'Cover your whole family', 'Settled fast when it matters']).slice(0, 3);
  const css = [
    '.ahpf{background:#ffffff;}',
    '.ahpf-pad{padding:26px 18px 16px;}',
    `.ahpf-h2{margin:0 0 16px;font-size:14px;font-weight:bold;color:${p.ink};font-family:${q(ctx.aes.headFont)};}`,
    '.ahpf-cell{padding:7px;}',
    `.ahpf-card{border:1px solid ${p.line};border-radius:14px;overflow:hidden;}`,
    `.ahpf-top{height:6px;background:${p.primary};}`,
    '.ahpf-body{padding:16px 16px 18px;}',
    `.ahpf-name{font-size:15px;font-weight:bold;color:${p.ink};margin:0 0 8px;font-family:${q(ctx.aes.bodyFont)};}`,
    `.ahpf-from{font-size:12px;color:#6b6b7b;}.ahpf-amt{font-size:21px;font-weight:bold;color:${p.primary};}`,
    `.ahpf-feat{font-size:12px;color:${p.ink};margin:7px 0;line-height:1.4;}`,
    `.ahpf-tick{color:${p.accent};font-weight:bold;margin-right:7px;}`,
    `.ahpf-cta{display:inline-block;margin-top:12px;text-decoration:none;font-size:12px;font-weight:bold;padding:10px 18px;border-radius:8px;background:${p.primary};color:${onColor(p.primary)};font-family:${q(ctx.aes.bodyFont)};}`,
  ].join('');
  const card = (prod) => {
    const amt = prod.price > 0 ? `<div><span class="ahpf-from">from </span><span class="ahpf-amt">${formatPrice(prod.price, currency)}</span><span class="ahpf-from"> / year</span></div>` : '';
    const f = feats.slice(0, 2).map((x) => `<div class="ahpf-feat"><span class="ahpf-tick">&#10003;</span>${tok(x, currency)}</div>`).join('');
    return `<td width="50%" valign="top" class="ahpf-cell"><div class="ahpf-card"><div class="ahpf-top"></div><div class="ahpf-body">` +
      `<div class="ahpf-name">${enc(prod.name)}</div>${amt}${f}` +
      `<span class="ahpf-cta">View plan</span>` +
      '</div></div></td>';
  };
  const html = '<tr><td class="ahpf"><div class="ahpf-pad">' +
    `<h2 class="ahpf-h2">${enc(STRIP_HEAD.fintech)}</h2>` +
    `<table role="presentation" width="100%"><tr>${two.map(card).join('')}</tr></table>` +
    '</div></td></tr>';
  return { html, css };
}

// ===========================================================================
//  PROMO STRIP  — value-props band + (optional) coupon band
// ===========================================================================
function promoStrip(ctx) {
  const { p, brand, currency, aesName } = ctx;
  const promo = (brand && brand.promo) || null;
  const strip = (promo && promo.strip) || [];
  const offer = promo && promo.offer;
  if (!strip.length && !offer) return { html: '', css: '' };
  const lux = (aesName === 'luxury' || aesName === 'minimal');
  const css = [
    `.ahpr-strip{background:${lux ? '#ffffff' : p.tint};border-top:1px solid ${p.line};border-bottom:1px solid ${p.line};padding:14px 16px;}`,
    `.ahpr-item{font-size:${lux ? '11px' : '12px'};font-weight:bold;color:${lux ? p.ink : p.primary};font-family:${q(ctx.aes.bodyFont)};${lux ? 'letter-spacing:0.14em;text-transform:uppercase;' : ''}}`,
    `.ahpr-sep{color:${p.accent};padding:0 4px;}`,
    `.ahpr-offer{background:${p.primary};padding:18px 20px;text-align:center;}`,
    `.ahpr-otext{font-size:14px;font-weight:bold;color:${onColor(p.primary)};margin:0 0 9px;font-family:${q(ctx.aes.bodyFont)};}`,
    `.ahpr-code{display:inline-block;border:2px dashed ${rgba(onColor(p.primary) === '#ffffff' ? '#ffffff' : '#1a1a1a', 0.7)};color:${onColor(p.primary)};font-weight:bold;letter-spacing:3px;padding:8px 18px;border-radius:8px;font-size:15px;}`,
  ].join('');
  let html = '';
  if (strip.length) {
    const cells = strip.slice(0, 3).map((s) => `<span class="ahpr-item">${tok(s, currency)}</span>`).join('<span class="ahpr-sep">&#183;</span>');
    html += `<tr><td class="ahpr-strip" align="center">${cells}</td></tr>`;
  }
  if (offer && !lux) {
    html += '<tr><td class="ahpr-offer">' +
      `<p class="ahpr-otext">${tok(offer.text, currency)}</p>` +
      `<div class="ahpr-code">${enc(offer.code)}</div>` +
      '</td></tr>';
  }
  return { html, css };
}

// ===========================================================================
//  FOOTER  — full branded footer (social · links · disclaimer · unsubscribe)
// ===========================================================================
const DISCLAIMER = {
  Finance: 'Insurance is the subject matter of solicitation. T&Cs apply. Please read the policy related documents carefully before concluding a sale.',
  Food: 'Images are for representation only. Offers are subject to availability and partner terms.',
  Travel: 'Fares and seat availability are dynamic and may change. Cancellation and travel terms apply.',
  Fashion: 'Offers are valid for a limited period and while stocks last. See site for full terms.',
  Beauty: 'Shades shown are indicative. Patch-test before use. Offers subject to terms.',
  Electronics: 'Specifications and prices are subject to change. Warranty terms apply.',
  Generic: 'Offers are subject to terms and may change without notice.',
};

function footer(ctx) {
  const { p, brand, brandName, vertical, footer: f } = ctx;
  const fy = new Date().getFullYear();
  const nets = (f && f.social && f.social.length)
    ? f.social.slice(0, 5).map((s) => s.network ? String(s.network).charAt(0).toUpperCase() + String(s.network).slice(1) : 'Social')
    : ['Instagram', 'Facebook', 'Twitter', 'YouTube'];
  const social = nets.map((n) => `<span class="ahf-soc">${enc(n)}</span>`).join('<span class="ahf-dot">&#183;</span>');
  const copyright = (f && f.copyright) ? enc(f.copyright) : `&#169; ${fy} ${enc(brandName)}. All rights reserved.`;
  const disclaimer = (ctx.terms ? ctx.terms + ' ' : '') + (DISCLAIMER[vertical] || DISCLAIMER.Generic);
  const css = [
    `.ahf{background:${mix(p.ink, '#ffffff', 0.04)};padding:26px 24px 24px;text-align:center;}`,
    `.ahf-brand{font-size:16px;font-weight:bold;color:${p.primary};margin:0 0 12px;font-family:${q(ctx.aes.headFont)};}`,
    `.ahf-soc{color:${p.ink};text-decoration:none;font-weight:bold;font-size:12px;font-family:${q(ctx.aes.bodyFont)};}`,
    '.ahf-dot{color:#c4c4cc;margin:0 8px;}',
    '.ahf-socrow{margin:0 0 14px;}',
    '.ahf-links{margin:0 0 14px;}',
    `.ahf-link{color:#8a8a96;text-decoration:none;font-size:11px;margin:0 7px;font-family:${q(ctx.aes.bodyFont)};}`,
    `.ahf-disc{color:#9aa0a6;font-size:10.5px;line-height:1.6;margin:0 auto 12px;max-width:480px;font-family:${q(ctx.aes.bodyFont)};}`,
    `.ahf-legal{color:#b6b6c0;font-size:11px;line-height:1.7;font-family:${q(ctx.aes.bodyFont)};}`,
    `.ahf-unsub{color:${p.ink};text-decoration:none;font-weight:bold;}`,
  ].join('');
  const html = '<tr><td class="ahf">' +
    `<div class="ahf-brand">${enc(brandName)}</div>` +
    `<div class="ahf-socrow">${social}</div>` +
    '<div class="ahf-links">' +
    '<span class="ahf-link">Help Centre</span><span class="ahf-link">Contact Us</span><span class="ahf-link">Privacy</span><span class="ahf-link">Terms</span>' +
    '</div>' +
    `<div class="ahf-disc">${enc(disclaimer)}</div>` +
    `<div class="ahf-legal">${copyright}<br>` +
    'You are receiving this because you opted in. ' +
    '<span class="ahf-unsub">Unsubscribe</span> &#183; <span class="ahf-unsub">Manage preferences</span> &#183; <span class="ahf-unsub">View in browser</span>' +
    '</div>' +
    '</td></tr>';
  return { html, css };
}
