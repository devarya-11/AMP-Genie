'use strict';

// The branded text/html + text/plain fallback for clients that don't render
// AMP (Outlook, Apple Mail, corporate gateways). Built from the SAME
// previewModel generate() produced for the interactive part, so the
// text/x-amp-html, text/html and text/plain MIME parts can never drift —
// this is the module server/dispatch.js and functions/_lib/email.js promise.
//
// Email-client constraints drive the markup: table-based outer layout, inline
// styles only, no JavaScript, no external CSS/fonts, and every non-ASCII
// codepoint as a numeric entity (via enc, the same rule as the AMP part).
// The plain-text part is for humans' pagers/previews, so it keeps real glyphs.
//
// buildFallback must never throw: sending a slightly plainer fallback always
// beats failing the whole dispatch, so malformed previewModel fields degrade
// to generic copy and catastrophic input falls back to a minimal branded shell.

const { enc, formatPrice } = require('./generate');

const FONT = "'Helvetica Neue',Arial,sans-serif";

// The one consistent interactive pointer every module variant carries, in
// both MIME parts.
const GMAIL_LINE = 'Open this email in Gmail for the interactive version.';
const GENERIC_LINE = 'Something interactive from us is waiting in this email.';

// Fixed ink/line mirror derivePalette()'s constants; the primary shades are
// neutral stand-ins used only when the caller passes no (or garbage) palette.
const DEFAULT_PALETTE = {
  primary: '#3d4a6b',
  primaryDark: '#2c3550',
  accent: '#5b6ee1',
  tint: '#f3f3f6',
  ink: '#1d1d2b',
  line: '#e6e6ec',
};

// A colour reaching a style="" attribute must be a real hex literal — the
// palette can arrive from caller-assembled JSON, and anything else could break
// out of the attribute. Bad values fall back per-key, so a half-valid palette
// still brands whatever it can.
function safeColor(v, fallback) {
  return (typeof v === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(v.trim())) ? v.trim() : fallback;
}
function safePalette(p) {
  const src = (p && typeof p === 'object') ? p : {};
  const out = {};
  for (const k of Object.keys(DEFAULT_PALETTE)) out[k] = safeColor(src[k], DEFAULT_PALETTE[k]);
  return out;
}

// href/src values are user-influenced (brand.js pulls them off the open web):
// only plain http(s) URLs may reach the markup, everything else is dropped.
function safeUrl(v) {
  const s = (typeof v === 'string') ? v.trim() : '';
  return /^https?:\/\/[^\s"'<>]+$/i.test(s) ? s : '';
}

function str(v, fallback = '') {
  return (typeof v === 'string' && v.trim()) ? v.trim() : fallback;
}
function list(v) {
  return Array.isArray(v) ? v : [];
}

// Same 1-99 whole-number rule as generate.js's validPct: previewModel values
// normally arrive straight from generate(), but a caller-assembled model must
// never be able to print "NaN% OFF".
function pct(n) {
  const v = Math.round(Number(n));
  return Number.isFinite(v) && v >= 1 && v <= 99 ? v : 0;
}

// previewModel prices are display strings carrying the real glyph ("₹4,799",
// see priceText in generate.js); raw numbers are accepted defensively. html
// gets entities, text gets glyphs — decode formatPrice's entities rather than
// reimplement its symbol/grouping logic.
function decodeEntities(s) {
  return String(s).replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
}
function priceHtml(price, currency) {
  if (typeof price === 'number' && Number.isFinite(price)) return formatPrice(price, currency);
  return enc(str(price));
}
function pricePlain(price, currency) {
  if (typeof price === 'number' && Number.isFinite(price)) return decodeEntities(formatPrice(price, currency));
  return str(price);
}

/* ------------------------------------------------------------------ *
 * Shared fragments
 * ------------------------------------------------------------------ */

function itemTable(items, p, currency) {
  const rows = items.map((it) => {
    const o = (it && typeof it === 'object') ? it : {};
    const name = str(o.name, 'Featured pick');
    const cat = str(o.cat);
    const cell = `padding:10px 2px;border-bottom:1px solid ${p.line};font-family:${FONT};font-size:14px;`;
    return `<tr>
<td style="${cell}color:${p.ink};">${enc(name)}${cat ? `<span style="color:#6b6b7b;font-size:12px;"> &#8226; ${enc(cat)}</span>` : ''}</td>
<td align="right" style="${cell}font-weight:bold;color:${p.primary};">${priceHtml(o.price, currency)}</td>
</tr>`;
  }).join('\n');
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:14px;">
${rows}
</table>`;
}

function itemLines(items, currency) {
  return items.map((it) => {
    const o = (it && typeof it === 'object') ? it : {};
    const name = str(o.name, 'Featured pick');
    const cat = str(o.cat);
    const price = pricePlain(o.price, currency);
    return '- ' + name + (cat ? ' (' + cat + ')' : '') + (price ? ': ' + price : '');
  });
}

function codeBox(code, p) {
  return `<p style="margin:14px 0 0;text-align:center;"><span style="display:inline-block;border:2px dashed ${p.accent};color:${p.primaryDark};font-family:${FONT};font-size:18px;font-weight:bold;letter-spacing:2px;padding:10px 18px;border-radius:8px;">${enc(code)}</span></p>`;
}

function mutedPara(text, p) {
  return `<p style="margin:0 0 6px;text-align:center;font-family:${FONT};font-size:13px;line-height:1.5;color:#6b6b7b;">${enc(text)}</p>`;
}

/* ------------------------------------------------------------------ *
 * Per-module static renderings of the previewModel. Each returns
 * { html, lines } — html for the styled part, lines for the plain-text part.
 * Every field access is guarded so a missing/malformed field just drops that
 * fragment; a renderer that ends up empty is topped up with GENERIC_LINE by
 * buildFallback.
 * ------------------------------------------------------------------ */

function renderReveal(pm, p, currency) {
  const discount = pct(pm.discount);
  const code = str(pm.code);
  const teaser = str(pm.teaserText, 'A hand-picked reward is waiting inside.');
  const items = list(pm.items).slice(0, 4);
  let html = '';
  const lines = [];
  if (discount) {
    html += `<p style="margin:0 0 6px;text-align:center;font-family:${FONT};font-size:34px;font-weight:bold;color:${p.primary};">${discount}% OFF</p>`;
    lines.push(discount + '% OFF');
  }
  html += mutedPara(teaser, p);
  lines.push(teaser);
  if (code) {
    html += mutedPara('Use this code at checkout', p) + codeBox(code, p);
    lines.push('Use this code at checkout: ' + code);
  }
  if (items.length) {
    html += itemTable(items, p, currency);
    lines.push(...itemLines(items, currency));
  }
  return { html, lines };
}

function renderSearch(pm, p, currency) {
  const cats = list(pm.catLabels)
    .map((c) => str(c))
    .filter((c) => c && c.toLowerCase() !== 'all');
  const items = list(pm.items).slice(0, 6);
  let html = '';
  const lines = [];
  if (cats.length) {
    html += `<p style="margin:0;font-family:${FONT};font-size:13px;color:#6b6b7b;">Browse: ${cats.map((c) => enc(c)).join(' &#8226; ')}</p>`;
    lines.push('Browse: ' + cats.join(', '));
  }
  if (items.length) {
    html += itemTable(items, p, currency);
    lines.push(...itemLines(items, currency));
  }
  return { html, lines };
}

function renderQuiz(pm, p) {
  const q = str(pm.q);
  const options = list(pm.options).slice(0, 4);
  let html = '';
  const lines = [];
  if (q) {
    html += `<p style="margin:0 0 14px;font-family:${FONT};font-size:18px;font-weight:bold;color:${p.ink};">${enc(q)}</p>`;
    lines.push(q);
  }
  options.forEach((o, i) => {
    const label = str(o && o.label);
    if (!label) return;
    const key = String.fromCharCode(65 + i); // A, B, C...
    html += `<p style="margin:0 0 10px;border:1px solid ${p.line};border-radius:10px;padding:13px 16px;font-family:${FONT};font-size:15px;color:${p.ink};">${key}. ${enc(label)}</p>`;
    lines.push(key + '. ' + label);
  });
  const teaser = str(options[0] && options[0].result);
  if (teaser) {
    html += `<div style="background:${p.tint};border-radius:10px;padding:16px 18px;margin-top:6px;">
<p style="margin:0 0 6px;font-family:${FONT};font-size:14px;font-weight:bold;color:${p.primaryDark};">A taste of your match</p>
<p style="margin:0;font-family:${FONT};font-size:13px;line-height:1.5;color:#6b6b7b;">${enc(teaser)}</p>
</div>`;
    lines.push('A taste of your match: ' + teaser);
  }
  return { html, lines };
}

function renderRating(pm, p) {
  const prompt = str(pm.prompt, 'How did we do?');
  const stars = `<span style="font-size:42px;line-height:1;color:${p.accent};letter-spacing:6px;">${'&#9733;'.repeat(5)}</span>`;
  const html = `<p style="margin:0 0 6px;text-align:center;font-family:${FONT};font-size:17px;color:${p.ink};">${enc(prompt)}</p>
<p style="margin:10px 0;text-align:center;">${stars}</p>
<p style="margin:14px 0 0;text-align:center;"><span style="display:inline-block;background:${p.primary};color:#ffffff;font-family:${FONT};font-size:15px;font-weight:bold;padding:13px 24px;border-radius:8px;">Rate us in Gmail</span></p>`;
  return { html, lines: [prompt, 'Rate us 1 to 5 stars by opening this email in Gmail.'] };
}

function renderSpin(pm, p) {
  const won = pct(pm.pct);
  const reward = str(pm.reward);
  const headline = won ? `You won ${won}% off!` : 'A reward is waiting on the wheel.';
  let inner = `<p style="margin:0;font-family:${FONT};font-size:26px;font-weight:bold;color:${p.primaryDark};">${enc(headline)}</p>`;
  const lines = [headline];
  if (reward) {
    inner += `<p style="margin:6px 0 0;font-family:${FONT};font-size:13px;line-height:1.5;color:#6b6b7b;">Apply this code before it disappears.</p>` + codeBox(reward, p);
    lines.push('Your code: ' + reward);
  }
  return { html: `<div style="background:${p.tint};border-radius:12px;padding:22px;text-align:center;">${inner}</div>`, lines };
}

function renderPoll(pm, p) {
  const q = str(pm.q);
  const a = str(pm.a);
  const b = str(pm.b);
  let html = '';
  const lines = [];
  if (q) {
    html += `<p style="margin:0 0 18px;text-align:center;font-family:${FONT};font-size:18px;font-weight:bold;color:${p.ink};">${enc(q)}</p>`;
    lines.push(q);
  }
  if (a || b) {
    const cell = (label) => `<td width="48%" style="border:2px solid ${p.line};border-radius:12px;padding:22px 8px;text-align:center;font-family:${FONT};font-size:16px;font-weight:bold;color:${p.ink};">${enc(label)}</td>`;
    html += `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>${a ? cell(a) : ''}${a && b ? '<td width="4%"></td>' : ''}${b ? cell(b) : ''}</tr></table>`;
    if (a) lines.push('A. ' + a);
    if (b) lines.push('B. ' + b);
  }
  return { html, lines };
}

const RENDERERS = {
  reveal: renderReveal,
  search: renderSearch,
  quiz: renderQuiz,
  rating: renderRating,
  spin: renderSpin,
  poll: renderPoll,
};

// The explicit moduleId wins; previewModel.type is the backstop when only the
// model travelled. hasOwnProperty guards against prototype names ('__proto__',
// 'constructor') masquerading as module ids.
function rendererFor(moduleId, pm) {
  for (const id of [moduleId, pm.type]) {
    if (typeof id === 'string' && Object.prototype.hasOwnProperty.call(RENDERERS, id)) return RENDERERS[id];
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * Document assembly
 * ------------------------------------------------------------------ */

function documentHtml({ brand, moduleName, head, logo, site, p, moduleHtml }) {
  const brandEl = logo
    ? `<img src="${enc(logo)}" width="96" height="32" alt="${enc(brand)} logo" style="display:block;border:0;">`
    : `<span style="font-family:${FONT};font-size:20px;font-weight:bold;letter-spacing:0.5px;color:${p.primary};">${enc(brand)}</span>`;
  const siteLink = site
    ? ` &#8226; <a href="${enc(site)}" style="color:${p.primary};text-decoration:none;">${enc(site.replace(/^https?:\/\//i, ''))}</a>`
    : '';
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${enc(brand + ' — ' + moduleName)}</title>
</head>
<body style="margin:0;padding:0;background:${p.tint};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${p.tint};">
<tr>
<td align="center" style="padding:24px 12px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:100%;background:#ffffff;border:1px solid ${p.line};border-radius:10px;">
<tr>
<td style="padding:22px 24px 0;">${brandEl}</td>
</tr>
<tr>
<td style="padding:12px 24px 18px;border-bottom:1px solid ${p.line};">
<h1 style="margin:0;font-family:${FONT};font-size:21px;line-height:1.3;color:${p.primary};">${enc(head)}</h1>
</td>
</tr>
<tr>
<td style="padding:20px 24px;">
${moduleHtml}
</td>
</tr>
<tr>
<td style="padding:0 24px 20px;">
<p style="margin:0;padding:12px 14px;background:${p.tint};border-radius:8px;font-family:${FONT};font-size:13px;line-height:1.5;color:${p.ink};text-align:center;">${enc(GMAIL_LINE)}</p>
</td>
</tr>
<tr>
<td style="padding:18px 24px;border-top:1px solid ${p.line};">
<p style="margin:0;font-family:${FONT};font-size:11px;line-height:1.6;color:#9a9aa8;">${enc(brand)}${siteLink}<br>You are seeing the static version of an interactive email.</p>
</td>
</tr>
</table>
</td>
</tr>
</table>
</body>
</html>`;
}

// Catastrophic-input escape hatch: built from two already-sanitised strings
// only, so this path itself cannot throw.
function minimalShell(brand, site) {
  const b = enc(brand);
  const html = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>${b}</title></head>
<body style="margin:0;padding:24px;background:#f3f3f6;font-family:${FONT};color:#1d1d2b;">
<p style="margin:0 0 8px;font-size:18px;font-weight:bold;">${b}</p>
<p style="margin:0;font-size:14px;line-height:1.5;">${enc(GMAIL_LINE)}</p>${site ? `\n<p style="margin:8px 0 0;font-size:13px;"><a href="${enc(site)}" style="color:#1d1d2b;">${enc(site)}</a></p>` : ''}
</body>
</html>`;
  const text = brand + '\n' + GMAIL_LINE + (site ? '\nVisit us: ' + site : '') + '\n';
  return { html, text };
}

function buildFallback(opts) {
  const o = (opts && typeof opts === 'object') ? opts : {};
  const brand = str(o.brand, 'Acme');
  const site = safeUrl(o.site);
  try {
    const p = safePalette(o.palette);
    const pm = (o.previewModel && typeof o.previewModel === 'object') ? o.previewModel : {};
    const moduleName = str(o.moduleName, 'Interactive email');
    const head = str(pm.head, brand + ' has something for you');
    const render = rendererFor(o.moduleId, pm);
    const mod = render ? render(pm, p, o.currency) : { html: '', lines: [] };
    if (!mod.html) mod.html = mutedPara(GENERIC_LINE, p);
    if (!mod.lines.length) mod.lines = [GENERIC_LINE];

    const html = documentHtml({
      brand, moduleName, head, logo: safeUrl(o.logoUrl), site, p, moduleHtml: mod.html,
    });
    const text = [brand, head, '']
      .concat(mod.lines)
      .concat(['', GMAIL_LINE])
      .concat(site ? ['Visit us: ' + site] : [])
      .join('\n') + '\n';
    return { html, text };
  } catch (e) {
    return minimalShell(brand, site);
  }
}

module.exports = { buildFallback };
