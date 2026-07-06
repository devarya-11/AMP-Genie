'use strict';

// ============================================================================
// prodtemplate.js — the production-shaped AMP4EMAIL template engine.
//
// This is the "how real AMP is authored" layer. It reproduces the structure of
// real shipped AMP4EMAIL mailers (the Bajaj Finserv reference + the NetCore
// corpus) — NOT one brand's content, but the general production grammar:
//
//   • <html ⚡4email data-css-strict> + full CSP <meta> + webfont declaration
//   • amp-form / amp-bind / amp-list / amp-mustache scripts
//   • a hidden ASSET PRELOAD block (opacity:0;height:1px) near <body> top
//   • a 1×1 OPEN-TRACKING amp-list pinging the open endpoint with merge tokens
//   • image-driven composition: hero / CTA / dividers / icons are amp-img slices
//     (CTAs are images wrapped in <a>/<div on="tap:…">, never CSS text buttons)
//   • a hidden CLICK-EVENT form (click_form); every chrome CTA fires
//     on="tap:AMP.setState({event_type,button_name,action_desc}),click_form.submit"
//   • an amp-form LEAD CAPTURE state machine (submitting / success / error)
//     with displayNone/displayBlock toggles + hidden tracking inputs
//   • merge tokens: Hi ##User name##, value="[NAME]" / [MOBILE] / [EMAIL] /
//     [SMT_MID] / [CAMPAIGN_ID] / [CUSTOMER_ID] / $(EMAIL_ADDRESS_)
//   • a .w600 nested-<table> 600px layout + @media all and (max-width:500px)
//
// Everything here is verified against the REAL amphtml-validator (AMP4EMAIL):
// see tests/prod-pattern-probe.js. Notably AMP4EMAIL forbids <link rel=stylesheet>
// AND @font-face, so a webfont cannot actually be loaded inside the document —
// exactly as in the real mailers. We therefore DECLARE the font (CSP + font
// stack) and gracefully fall back to the system stack, which is precisely what
// production does.
//
// Image slices (hero/CTA/divider/icon) are placed as amp-img with explicit
// width/height + layout="responsive". Real brand photography arrives already
// resolved + HTTPS from server/assets.js; for slices with no first-party asset
// we emit a generated HTTPS stand-in (generatedUrl) tagged 'generated' in
// provenance. In production PUBLIC_ASSET_BASE points at the CDN/S3 that hosts
// the composed PNG slices — the STRUCTURE is identical either way.
// ============================================================================

const { enc, formatPrice, CURRENCIES } = require('./generate');
const { generatedUrl } = require('./assets');
const slices = require('./slices');

// {c} currency-token substitution (brand promo offers carry "{c}300 off" etc.)
function symbolFor(currency) { return (CURRENCIES && CURRENCIES[currency]) || (CURRENCIES && CURRENCIES.INR) || '₹'; }
function subc(text, currency) { return String(text == null ? '' : text).replace(/\{c\}/g, symbolFor(currency)); }

// relative luminance → readable ink (white on dark, near-black on light)
function lumOf(hex) {
  const h = String(hex || '').replace('#', '');
  if (h.length < 6) return 0.5;
  const ch = (i) => { const c = parseInt(h.slice(i, i + 2), 16) / 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  return 0.2126 * ch(0) + 0.7152 * ch(2) + 0.0722 * ch(4);
}
function onColor(hex) { return lumOf(hex) > 0.55 ? '#1a1a1a' : '#ffffff'; }

// A brand link must be an ABSOLUTE https URL — AMP4EMAIL rejects a bare merge
// token (e.g. href="[BRAND_URL]") as a relative URL. Merge tokens stay valid in
// the QUERY of an absolute URL (same as the open-track amp-list src), so the CTA
// can still carry [EMAIL] for per-recipient attribution.
function siteUrl(footerInfo, brandName) {
  let s = (footerInfo && footerInfo.site) || `www.${String(brandName || 'brand').toLowerCase().replace(/[^a-z0-9]/g, '')}.com`;
  s = String(s).trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  return 'https://' + s;
}
function deepLink(base, params) {
  const q = Object.entries(params || {}).map(([k, v]) => `${k}=${v}`).join('&');
  return base + (q ? (base.includes('?') ? '&' : '?') + q : '');
}

// Per-aesthetic webfont declaration (matches what production mailers declare in
// CSP + font-family; falls back to the system stack since AMP4EMAIL can't load
// a webfont). googleFamily is the CSP style-src grant; stack is the CSS family.
const FONTS = {
  playful: { googleFamily: 'Rubik:wght@300;400;500;600;700', stack: "'Rubik', Arial, Helvetica, sans-serif" },
  bold: { googleFamily: 'Rubik:wght@400;500;600;700;800', stack: "'Rubik', 'Helvetica Neue', Arial, sans-serif" },
  fintech: { googleFamily: 'Mulish:wght@300;400;500;600;700', stack: "'Mulish', 'Helvetica Neue', Arial, sans-serif" },
  minimal: { googleFamily: 'Mulish:wght@300;400;500;600', stack: "'Mulish', 'Helvetica Neue', Arial, sans-serif" },
  luxury: { googleFamily: 'Playfair Display:wght@400;500;600;700', stack: "'Playfair Display', Georgia, 'Times New Roman', serif" },
};
function fontFor(aesName) { return FONTS[aesName] || FONTS.playful; }

// ---- component scripts -----------------------------------------------------
const CE = {
  'amp-form': 'https://cdn.ampproject.org/v0/amp-form-0.1.js',
  'amp-bind': 'https://cdn.ampproject.org/v0/amp-bind-0.1.js',
  'amp-list': 'https://cdn.ampproject.org/v0/amp-list-0.1.js',
  'amp-carousel': 'https://cdn.ampproject.org/v0/amp-carousel-0.1.js',
  'amp-accordion': 'https://cdn.ampproject.org/v0/amp-accordion-0.1.js',
  'amp-anim': 'https://cdn.ampproject.org/v0/amp-anim-0.1.js',
  'amp-selector': 'https://cdn.ampproject.org/v0/amp-selector-0.1.js',
};
function customElementTag(name) {
  return `<script async custom-element="${name}" src="${CE[name]}"><\/script>`;
}
const MUSTACHE_TAG = '<script async custom-template="amp-mustache" src="https://cdn.ampproject.org/v0/amp-mustache-0.2.js"><\/script>';

// ---- CSP -------------------------------------------------------------------
// The real mailers ship a full Content-Security-Policy <meta>. AMP4EMAIL accepts
// the bare `<meta content="…">` form (NOT http-equiv). style-src grants the
// webfont + icon hosts the brand declares. Verified: passes with 0 errors.
function cspMeta(googleFamily) {
  const fontGrant = `https://fonts.googleapis.com/css2?family=${googleFamily}&display=swap`;
  return '<meta content="' + [
    'default-src * data: blob:',
    'script-src blob: https://cdn.ampproject.org/v0.js https://cdn.ampproject.org/v0/ https://cdn.ampproject.org/viewer/ https://cdn.ampproject.org/rtv/',
    "object-src 'none'",
    "style-src 'unsafe-inline' https://cdn.ampproject.org/rtv/ https://cdn.materialdesignicons.com https://cloud.typography.com https://fonts.gstatic.com " + fontGrant,
  ].join('; ') + '">';
}

// ---- the production class system (palette baked; strict-safe) ---------------
// No :root / var() / !important (data-css-strict). Mirrors the real corpus
// class vocabulary: .w600 / .deviceWidth / .displayNone / .displayBlock /
// .heading / .sub-heading / .min-pad / .icon-text / .top-line + media queries.
function cssSystem(p, A, font) {
  const headInk = onColor(p.primary);
  return [
    'body{margin:0;padding:0;background:#eef0f3;}',
    'table{border-collapse:collapse;}',
    'td{padding:0;}',
    'img{border:0;outline:none;text-decoration:none;display:block;}',
    'a{text-decoration:none;}',
    `body,table,td,p,div,span,a{font-family:${font.stack};}`,
    '.outer{background:#eef0f3;}',
    '.outercell{padding:18px 12px;}',
    `.w600{width:600px;background:#ffffff;color:${p.ink};}`,
    '.deviceWidth{width:100%;}',
    '.displayNone{display:none;}',
    '.displayBlock{display:block;}',
    '.center{text-align:center;}',
    `.top-line{height:4px;line-height:4px;font-size:0;background:${p.primary};}`,
    `.greet{padding:16px 24px 0;font-size:14px;color:${p.ink};font-weight:500;}`,
    `.heading{margin:0;padding:6px 24px 2px;font-size:${A.headSize};line-height:1.3;font-weight:${A.headWeight};color:${p.primary};letter-spacing:${A.headLetter};text-transform:${A.headTransform};}`,
    `.sub-heading{margin:0;padding:4px 24px 0;font-size:14px;line-height:1.6;color:#5a5a5a;}`,
    '.min-pad{padding:14px 24px;}',
    '.sec-pad{padding:18px 24px;}',
    `.icon-cell{padding:10px 6px;text-align:center;vertical-align:top;}`,
    `.icon-text{margin:8px 0 0;font-size:12px;line-height:1.45;color:#5a5a5a;}`,
    // image CTA wrapper — the clickable image button (NOT a CSS text button)
    '.cta-wrap{padding:18px 24px;text-align:center;}',
    '.cta-img{display:block;width:100%;height:auto;cursor:pointer;}',
    // lead form — production form vocabulary
    `.form-wrap{padding:6px 24px 22px;}`,
    `.form-title{margin:0 0 10px;font-size:18px;font-weight:600;color:${p.primary};text-align:center;}`,
    'label{display:block;font-size:13px;font-weight:600;color:#5a5a5a;margin:8px 0 4px;}',
    `.form-control{box-sizing:border-box;width:100%;height:42px;padding:8px 12px;border:0;border-radius:6px;background:${p.tint};font-size:14px;color:${p.ink};}`,
    '.field-half{width:50%;vertical-align:top;}',
    '.err{font-size:12px;color:#d23b3b;margin:4px 0 0;}',
    `.interest-btn{display:inline-block;border:0;background:${p.primary};color:${headInk};border-radius:6px;padding:12px 30px;font-size:15px;font-weight:600;letter-spacing:.4px;cursor:pointer;}`,
    `.thanks{padding:22px;text-align:center;font-size:16px;font-weight:600;color:${p.primaryDark || p.primary};}`,
    '.loader{text-align:center;padding:10px 0;}',
    // product strip
    '.pcell{padding:8px;vertical-align:top;}',
    `.pname{margin:8px 0 2px;font-size:13px;font-weight:600;color:${p.ink};line-height:1.35;}`,
    `.pprice{margin:0;font-size:14px;font-weight:700;color:${p.primary};}`,
    // promo strip + footer
    `.promo{padding:16px 24px;background:${p.tint};text-align:center;}`,
    `.promo-h{margin:0 0 4px;font-size:16px;font-weight:700;color:${p.primary};}`,
    `.promo-s{margin:0;font-size:13px;color:#5a5a5a;}`,
    `.foot{padding:20px 24px;background:${p.primaryDark || p.primary};color:#ffffff;text-align:center;}`,
    '.foot a{color:#ffffff;}',
    '.foot-site{font-size:13px;font-weight:600;margin:0 0 8px;}',
    '.foot-follow{font-size:12px;margin:0 0 8px;}',
    '.soc-cell{padding:0 5px;}',
    '.foot-legal{font-size:11px;line-height:1.6;color:rgba(255,255,255,.78);margin:10px 0 0;}',
    '.foot-unsub{font-size:11px;color:rgba(255,255,255,.78);margin:6px 0 0;}',
    // dn/db helpers used by mechanic modules (kept for back-compat)
    '.db{display:block;}', '.dn{display:none;}', '.rel{position:relative;}',
    // mobile
    '@media all and (max-width:500px){' +
      '.w600{width:100%;}' +
      '.heading{font-size:5vw;padding:6px 5vw 2px;}' +
      '.sub-heading{padding:4px 5vw 0;}' +
      '.greet{padding:14px 5vw 0;}' +
      '.min-pad{padding:14px 5vw;}' +
      '.sec-pad{padding:16px 5vw;}' +
      '.cta-wrap{padding:16px 5vw;}' +
      '.form-wrap{padding:6px 5vw 20px;}' +
      '.field-half{display:block;width:100%;}' +
    '}',
  ].join('');
}

// ---- the document shell ----------------------------------------------------
function shell({ components, css, body, googleFamily }) {
  // amp-bind + amp-form + amp-list + amp-mustache are always present (scaffolding
  // needs them); module-specific components (amp-carousel, amp-anim…) are added.
  const ce = Array.from(new Set(['amp-bind', 'amp-form', 'amp-list', ...(components || [])]))
    .filter((c) => CE[c]);
  return [
    '<!doctype html>',
    '<html ⚡4email data-css-strict>',
    '<head>',
    '<meta charset="utf-8">',
    '<script async src="https://cdn.ampproject.org/v0.js"><\/script>',
    cspMeta(googleFamily),
    ...ce.map(customElementTag),
    MUSTACHE_TAG,
    '<style amp4email-boilerplate>body{visibility:hidden}</style>',
    `<style amp-custom>${css}</style>`,
    '</head>',
    '<body>',
    body,
    '</body>',
    '</html>',
  ].join('\n');
}

// ---- amp-img slice ---------------------------------------------------------
function img(url, w, h, alt, { layout = 'responsive', cls = '' } = {}) {
  return `<amp-img src="${url}" width="${w}" height="${h}" layout="${layout}" alt="${enc(alt || '')}"${cls ? ` class="${cls}"` : ''}></amp-img>`;
}

// ---- tap handler that fires click tracking ---------------------------------
// Produces on="tap:AMP.setState({event_type:'click',button_name:'…',action_desc:'…'[,…extra]}),click_form.submit[,…tail]".
// `extra` merges additional state (e.g. {g:{revealed:true}}); `tail` adds more
// actions (e.g. another form submit).
function tapTrack(buttonName, actionDesc, { extra = '', tail = '' } = {}) {
  const setObj = `{event_type:'click',button_name:'${jsStr(buttonName)}',action_desc:'${jsStr(actionDesc)}'${extra ? ',' + extra : ''}}`;
  return `on="tap:AMP.setState(${setObj}),click_form.submit${tail ? ',' + tail : ''}"`;
}
function jsStr(s) { return String(s || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'"); }

// ---- hidden asset preload block --------------------------------------------
// Near the top of <body>; forces the client to fetch every slice up-front so the
// creative paints without staggered image pops. opacity:0;height:1px;overflow
// hidden — identical to the corpus pattern.
function preloadBlock(urls) {
  const uniq = Array.from(new Set((urls || []).filter(Boolean)));
  if (!uniq.length) return '';
  const imgs = uniq.map((u) => `<amp-img src="${u}" width="1" height="1" layout="fixed" alt=""></amp-img>`).join('');
  return `<div class="displayBlock" style="opacity:0;height:1px;width:1px;overflow:hidden;line-height:0;font-size:0;">${imgs}</div>`;
}

// ---- open-tracking 1×1 amp-list ---------------------------------------------
// Pings the open endpoint with merge tokens the moment the AMP renders. Mirrors
// the corpus open-track list. binding/items omitted → default; template renders
// a 1×1 pixel. Validator-verified.
function openTrack({ endpoint, clientName }) {
  const src = `${endpoint}?email=[EMAIL]&smt_mid=[SMT_MID]&client_name=${encodeURIComponent(clientName)}&request_form_type=AMP`;
  return [
    `<amp-list width="1" height="1" layout="fixed" src="${src}">`,
    '<template type="amp-mustache"><amp-img src="https://cdn.ampproject.org/i/p.gif" width="1" height="1" layout="fixed" alt=""></amp-img></template>',
    '</amp-list>',
  ].join('');
}

// ---- hidden click-event capture form ---------------------------------------
// Every tracked CTA does click_form.submit; this posts the event_type /
// button_name / action_desc (bound via amp-bind) + identity merge tokens.
function clickForm({ endpoint, clientName }) {
  return [
    `<form id="click_form" method="post" action-xhr="${endpoint}" on="submit-success:AMP.setState({clickAck:event.response.status})">`,
    '<input type="hidden" name="event_type" [value]="event_type" value="">',
    '<input type="hidden" name="button_name" [value]="button_name" value="">',
    '<input type="hidden" name="action_desc" [value]="action_desc" value="">',
    '<input type="hidden" name="subscriber_email" value="[EMAIL]">',
    '<input type="hidden" name="campaign_id" value="[CAMPAIGN_ID]">',
    '<input type="hidden" name="smt_mid" value="[SMT_MID]">',
    `<input type="hidden" name="client_name" value="${enc(clientName)}">`,
    '<input type="hidden" name="request_form_type" value="AMP">',
    '</form>',
  ].join('');
}

// ---- header: logo slice + greeting merge token -----------------------------
function header({ logo, brandName, p, brandUrl }) {
  const logoUrl = (logo && logo.url) ? logo.url : generatedUrl(brandName, 200, 64, p, 'logo');
  const lw = (logo && logo.width) || 200, lh = (logo && logo.height) || 64;
  // constrain logo to a sensible max so a large source doesn't dominate
  const dw = Math.min(lw, 180), dh = Math.round((dw / lw) * lh);
  const href = deepLink(brandUrl, { utm_source: 'amp_email', utm_medium: 'logo', em: '[EMAIL]' });
  return [
    '<tr><td class="top-line">&nbsp;</td></tr>',
    `<tr><td class="sec-pad center"><a href="${href}" ${tapTrack('logo', 'Brand logo')}>${img(logoUrl, dw, dh, brandName + ' logo', { layout: 'fixed' })}</a></td></tr>`,
    `<tr><td class="greet">Hi ##User name##,</td></tr>`,
  ].join('');
}

// ---- hero: full-width image slice + headline + image CTA -------------------
function hero({ hero: heroAsset, headline, sub, ctaText, p, isReveal }) {
  const heroUrl = (heroAsset && heroAsset.url) ? heroAsset.url : generatedUrl(headline || 'Hero', 600, 320, p, 'hero');
  const hw = (heroAsset && heroAsset.width) || 600, hh = (heroAsset && heroAsset.height) || 320;
  const ctaImg = slices.sliceUrl({ kind: 'cta', text: ctaText, w: 360, h: 64, palette: p });
  // reveal-style mechanics toggle state from the hero CTA AND track the click;
  // link-style CTAs just track + (in prod) deep-link via [BRAND_URL].
  const ctaTap = isReveal
    ? tapTrack(ctaText, 'Hero CTA', { extra: 'g:{revealed:true}' })
    : tapTrack(ctaText, 'Hero CTA');
  return [
    `<tr><td>${img(heroUrl, hw, hh, headline || 'Hero', { layout: 'responsive' })}</td></tr>`,
    headline ? `<tr><td><h1 class="heading">${enc(headline)}</h1></td></tr>` : '',
    sub ? `<tr><td><p class="sub-heading">${enc(sub)}</p></td></tr>` : '',
    `<tr><td class="cta-wrap"><div role="button" tabindex="0" ${ctaTap}>${img(ctaImg, 360, 64, ctaText, { layout: 'fixed', cls: 'cta-img' })}</div></td></tr>`,
  ].join('');
}

// ---- benefit / trust icon row (image slices) -------------------------------
function iconRow({ items, p }) {
  if (!items || !items.length) return '';
  const cells = items.slice(0, 3).map((it) => {
    const iconUrl = slices.sliceUrl({ kind: 'icon', text: it.short || it.label, w: 96, h: 96, palette: p });
    return `<td class="icon-cell" width="33%">${img(iconUrl, 64, 64, it.label, { layout: 'fixed' })}<p class="icon-text">${enc(it.label)}</p></td>`;
  }).join('');
  return `<tr><td class="sec-pad"><table role="presentation" width="100%"><tr>${cells}</tr></table></td></tr>`;
}

// ---- product strip (real product images; Part B fixes correctness) ---------
function productStrip({ products, currency, p }) {
  const items = (products || []).slice(0, 2);
  if (!items.length) return '';
  const cells = items.map((prod) => {
    const url = prod.url || generatedUrl(prod.name, 300, 220, p, 'product');
    const w = prod.width || 300, h = prod.height || 220;
    return `<td width="50%" class="pcell"><table role="presentation" width="100%"><tr><td>${img(url, w, h, prod.name, { layout: 'responsive' })}</td></tr>` +
      `<tr><td><p class="pname">${enc(prod.name)}</p><p class="pprice">${formatPrice(prod.price, currency)}</p></td></tr></table></td>`;
  }).join('');
  return `<tr><td class="sec-pad"><table role="presentation" width="100%"><tr>${cells}</tr></table></td></tr>`;
}

// ---- amp-form lead capture state machine -----------------------------------
// The production data-capture pattern: name + mobile, submitting loader, success
// thank-you and error block toggled via [class]="responseData.status == …",
// merge-token prefilled inputs, hidden tracking inputs. Verified 0 errors.
function leadForm({ endpoint, clientName, p, title }) {
  const loaderImg = slices.sliceUrl({ kind: 'loader', w: 80, h: 80, palette: p });
  return [
    `<tr><td class="form-wrap"><form id="lead_form" method="post" action-xhr="${endpoint}" `,
    'on="submit-success:AMP.setState({responseData:{status:event.response.status,message:event.response.message}})" ',
    'custom-validation-reporting="interact-and-submit">',
    // ---- active form (hidden once success) ----
    `<div class="displayBlock" [class]="responseData.status == 'success' ? 'displayNone' : 'displayBlock'">`,
    `<p class="form-title">${enc(title || 'I want to know more')}</p>`,
    '<table role="presentation" width="100%"><tr>',
    '<td class="field-half" style="padding-right:6px;">',
    '<label for="lf_name">Name</label>',
    '<input type="text" id="lf_name" name="name" class="form-control" placeholder="Your name" value="[NAME]" required>',
    '<span class="err" visible-when-invalid="valueMissing" validation-for="lf_name">Please enter your name.</span>',
    '</td>',
    '<td class="field-half" style="padding-left:6px;">',
    '<label for="lf_mobile">Mobile</label>',
    '<input type="text" id="lf_mobile" name="mobile" class="form-control" placeholder="10-digit mobile" value="[MOBILE]" pattern="[0-9]{10}" required>',
    '<span class="err" visible-when-invalid="valueMissing" validation-for="lf_mobile">Please enter your mobile number.</span>',
    '<span class="err" visible-when-invalid="patternMismatch" validation-for="lf_mobile">Enter a valid 10-digit number.</span>',
    '</td>',
    '</tr></table>',
    '<div class="center" style="margin-top:14px;"><button type="submit" class="interest-btn">I am interested</button></div>',
    // submitting loader (AMP toggles [submitting] visibility)
    `<div submitting class="loader">${img(loaderImg, 56, 56, 'Submitting', { layout: 'fixed' })}</div>`,
    // error block
    `<div class="displayNone center" [class]="responseData.status == 'error' ? 'displayBlock center' : 'displayNone'" style="margin-top:10px;"><span class="err" [text]="responseData.message">Something went wrong. Please try again.</span></div>`,
    '</div>',
    // ---- success thank-you ----
    `<div class="displayNone" [class]="responseData.status == 'success' ? 'displayBlock' : 'displayNone'"><p class="thanks">Thank you — your response has been recorded.</p></div>`,
    // ---- hidden tracking inputs ----
    '<input type="hidden" name="subscriber_email" value="[EMAIL]">',
    '<input type="hidden" name="campaign_id" value="[CAMPAIGN_ID]">',
    '<input type="hidden" name="customer_id" value="[CUSTOMER_ID]">',
    '<input type="hidden" name="smt_mid" value="[SMT_MID]">',
    `<input type="hidden" name="client_name" value="${enc(clientName)}">`,
    '<input type="hidden" name="request_form_type" value="AMP">',
    '<input type="hidden" name="x_utm_source" value="EMAIL">',
    '<input type="hidden" name="x_utm_medium" value="EMAIL_AMP">',
    '<input type="hidden" name="x_utm_campaign" value="EMAIL_AMP_CAMPAIGN">',
    '</form></td></tr>',
  ].join('');
}

// ---- promo strip -----------------------------------------------------------
// The promo band carries a real OFFER headline (e.g. "Extra ₹300 off · code
// AJIO300"). Brand promos arrive as { strip:[...], offer:{code,text}|null }; the
// strip items are already surfaced as benefit icons, so we render the band ONLY
// when there's a genuine offer (luxury brands like Burberry expose none — and
// showing a discount code would be off-brand for them). We also accept a plain
// string or a {head/title,sub} object for callers that pass copy directly. A raw
// object with none of these is treated as "no promo" — never stringified into
// "[object Object]".
function promoStrip({ promo, p, currency }) {
  if (!promo) return '';
  let head = '';
  let sub = '';
  if (typeof promo === 'string') {
    head = promo;
  } else if (promo.head || promo.title) {
    head = promo.head || promo.title;
    sub = promo.sub || '';
  } else if (promo.offer && promo.offer.text) {
    head = subc(promo.offer.text, currency);
    if (promo.offer.code) sub = 'Use code ' + promo.offer.code;
  }
  head = String(head == null ? '' : head).trim();
  if (!head) return ''; // only-strip promos / empty / unknown shapes render nothing
  return `<tr><td class="promo"><p class="promo-h">${enc(head)}</p>${sub ? `<p class="promo-s">${enc(sub)}</p>` : ''}</td></tr>`;
}

// ---- branded footer: social icon slices + disclaimers + unsubscribe --------
function footer({ brandName, footerInfo, terms, p, brandUrl }) {
  const siteText = String(brandUrl).replace(/^https?:\/\//, '');
  const socials = [
    { k: 'in', label: 'LinkedIn' }, { k: 'f', label: 'Facebook' },
    { k: 'IG', label: 'Instagram' }, { k: 'YT', label: 'YouTube' }, { k: 'X', label: 'X' },
  ];
  const socCells = socials.map((s) =>
    `<td class="soc-cell"><a href="${deepLink(brandUrl, { utm_source: 'amp_email', utm_medium: 'social_' + s.label })}" ${tapTrack('social-' + s.label, 'Footer ' + s.label)}>${img(slices.sliceUrl({ kind: 'social', key: s.k, w: 64, h: 64, palette: p }), 28, 28, s.label, { layout: 'fixed' })}</a></td>`
  ).join('');
  const legal = terms ? enc(terms) : 'Terms &amp; conditions apply. This is a promotional communication.';
  const disclaimer = (footerInfo && footerInfo.disclaimer) ? enc(footerInfo.disclaimer) : '';
  const unsub = deepLink(brandUrl + '/unsubscribe', { em: '[EMAIL]', mid: '[SMT_MID]' });
  const pref = deepLink(brandUrl + '/preferences', { em: '[EMAIL]' });
  return [
    '<tr><td class="foot">',
    `<p class="foot-site"><a href="${brandUrl}">${enc(siteText)}</a></p>`,
    '<p class="foot-follow">Follow us on:</p>',
    `<table role="presentation" align="center"><tr>${socCells}</tr></table>`,
    `<p class="foot-legal">${legal}${disclaimer ? ' ' + disclaimer : ''}</p>`,
    `<p class="foot-legal">&copy; ${new Date().getFullYear()} ${enc(brandName)}. All rights reserved.</p>`,
    `<p class="foot-unsub">This email was sent to $(EMAIL_ADDRESS_). <a href="${unsub}">Unsubscribe</a> &middot; <a href="${pref}">Manage preferences</a></p>`,
    '</td></tr>',
  ].join('');
}

// ============================================================================
// composeRows — Phase 6 AMP4Email translation. Order the production chrome rows
// by a LayoutSkeleton's distilled section sequence (FORM), falling back to the
// house fixed order when no skeleton is supplied.
//
// Each abstract SECTION_TYPE maps to a LOGICAL block we can render brand-safely:
//   header→header  hero/subhero→hero  value_props→value_props
//   product_grid/product_strip/category_nav→product  editorial→editorial
//   mechanic→mechanic(+lead form)  footer→footer
// Types with no brand-safe content (social_proof, countdown, cta_banner,
// divider) intentionally degrade to NO-OPS: synthesising reviews, timers or
// extra CTA copy would either fabricate brand IDENTITY or risk AMP validity.
// The primary CTA already lives in the hero; the offer band rides in editorial.
//
// Whatever the skeleton says, three blocks are structurally required and are
// force-included if the sequence omitted them: header (top), mechanic (the
// interactive payload + lead capture), footer (legal/unsubscribe, bottom).
const SECTION_TO_BLOCK = {
  header: 'header', hero: 'hero', subhero: 'hero',
  value_props: 'value_props',
  product_grid: 'product', product_strip: 'product', category_nav: 'product',
  editorial: 'editorial', mechanic: 'mechanic', footer: 'footer',
  // explicit no-ops (documented above)
  social_proof: null, countdown: null, cta_banner: null, divider: null,
};

function composeRows({ form, blocks }) {
  const b = blocks || {};
  // No skeleton → original house order (header→hero→icons→mechanic→product→…→footer).
  if (!form || !Array.isArray(form.sections) || !form.sections.length) {
    return (b.header || '') + (b.hero || '') + (b.value_props || '') +
      (b.mechanic || '') + (b.product || '') + (b.editorial || '') + (b.footer || '');
  }
  const emitted = new Set();
  const out = [];
  const put = (logical) => {
    if (!logical || emitted.has(logical)) return;
    emitted.add(logical);
    if (b[logical]) out.push(b[logical]);
  };
  for (const sec of form.sections) {
    const type = sec && (sec.type || sec); // sections are {type,cols} or bare strings
    put(SECTION_TO_BLOCK[type]);            // undefined type → put(undefined) → ignored
  }
  // structural invariants — force-include the load-bearing blocks if skipped
  if (!emitted.has('header')) { out.unshift(b.header || ''); emitted.add('header'); }
  if (!emitted.has('mechanic')) { out.push(b.mechanic || ''); emitted.add('mechanic'); }
  if (!emitted.has('footer')) { out.push(b.footer || ''); emitted.add('footer'); }
  return out.join('');
}

// assembleProduction — compose the full production-shaped email AROUND a
// module's interactive mechanic, returning { ampHtml, preloadUrls, scaffolding }.
// ============================================================================
function assembleProduction(params) {
  const {
    p, A, aesName, brandName, currency, products, logo, hero: heroAsset, copy,
    terms, footerInfo, promo, benefits, built, kind,
    openEndpoint, clickEndpoint, leadEndpoint, clientName,
  } = params;

  const font = fontFor(aesName);
  const brandUrl = params.brandUrl || siteUrl(footerInfo, brandName);

  const headline = copy.head || `${brandName}, just for you`;
  const sub = copy.sub || (built && built.heroSub) || null;
  const ctaText = copy.cta || A.cta || 'Check it out';
  const isReveal = kind === 'tap-to-reveal' || kind === 'spin-to-win' || kind === 'scratch-card';

  // ---- chrome sections (image-driven) ----
  const headerHtml = header({ logo, brandName, p, brandUrl });
  const heroHtml = hero({ hero: heroAsset, headline, sub, ctaText, p, isReveal });
  const iconHtml = iconRow({ items: benefits, p });
  // Some mechanics (reveal/spin reward grids) already render the product grid; if
  // so, the always-on chrome strip would duplicate it — so suppress it then.
  const mechShowsProducts = !!(products && products.length && built && built.rows &&
    products.some((x) => x.url && built.rows.includes(x.url)));
  const productHtml = mechShowsProducts ? '' : productStrip({ products, currency, p });
  const promoHtml = promoStrip({ promo, p, currency });
  const footHtml = footer({ brandName, footerInfo, terms, p, brandUrl });

  // ---- the lead form appears for modules that don't already capture leads ----
  const moduleHasOwnForm = (built && built.components || []).includes('amp-form');
  const leadHtml = moduleHasOwnForm ? '' : leadForm({ endpoint: leadEndpoint, clientName, p, title: copy.formTitle });

  // ---- assemble the .w600 table body ----
  // Phase 6 — AMP4Email translation: when a brand-agnostic LayoutSkeleton rides
  // in (params.form, from the Vertical Reference System), its ORDERED section
  // types drive the row order, so AJIO renders a fashion sequence and Nykaa a
  // beauty one — while every CONCRETE value (image, colour, copy) still comes
  // from the client context. With no form, we keep the original fixed order so
  // nothing regresses.
  const mechHtml = (built ? built.rows : '') + leadHtml;
  const rows = composeRows({
    form: params.form,
    blocks: {
      header: headerHtml, hero: heroHtml, value_props: iconHtml,
      product: productHtml, editorial: promoHtml, mechanic: mechHtml, footer: footHtml,
    },
  });

  // ---- collect every slice URL for the preload block ----
  const preloadUrls = [
    logo && logo.url, heroAsset && heroAsset.url,
    ...(products || []).map((x) => x.url),
    slices.sliceUrl({ kind: 'cta', text: ctaText, w: 360, h: 64, palette: p }),
  ].filter(Boolean);

  // moduleBaseCss carries the mechanic-only class vocabulary (.btn/.lead/.sub/
  // .code/.pad…) the interactive modules emit; cssSystem (the production chrome
  // classes) comes AFTER so shared names like .w600/.center resolve to it.
  const css = (params.moduleBaseCss || '') + cssSystem(p, A, font) + (built && built.css ? built.css : '');
  const stateJson = JSON.stringify((built && built.state) || {});

  const openHtml = openTrack({ endpoint: openEndpoint, clientName });
  const clickHtml = clickForm({ endpoint: clickEndpoint, clientName });

  const body = [
    // amp-state for the mechanic + click-tracking vars
    `<amp-state id="g"><script type="application/json">${stateJson}<\/script></amp-state>`,
    // 1) hidden asset preload
    preloadBlock(preloadUrls),
    // 2) open-tracking pixel
    openHtml,
    // 3) the visible creative (.w600 nested-table layout)
    '<table role="presentation" width="100%" class="outer"><tr><td align="center" class="outercell">',
    `<table role="presentation" width="600" class="w600">${rows}</table>`,
    '</td></tr></table>',
    // 4) hidden click-event form
    clickHtml,
  ].join('\n');

  const ampHtml = shell({
    components: (built && built.components) || [],
    css, body, googleFamily: font.googleFamily,
  });

  return {
    ampHtml,
    preloadUrls,
    font: font.stack,
    scaffolding: {
      preload: true, openTrack: true, clickForm: true,
      leadForm: !!leadHtml, mergeTokens: true, csp: true, glyph: true,
    },
  };
}

module.exports = {
  assembleProduction, composeRows, shell, cssSystem, cspMeta, fontFor,
  preloadBlock, openTrack, clickForm, leadForm, header, hero, iconRow,
  productStrip, promoStrip, footer, tapTrack, img,
};
