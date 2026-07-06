'use strict';

// Phase 1.2 — the static cross-client layer.
//
// Every generation produces three MIME bodies from the SAME GenerationContext
// that built the AMP: text/plain, a quality text/html fallback, and the AMP
// (text/x-amp-html). Outlook and other non-AMP clients ignore the AMP part and
// render this html fallback, so it must be a real, on-brand email — logo,
// headline, products, a CTA to the site and the brand footer — not a "open this
// in Gmail" stub. Table-based + inline styles only, so it survives the Outlook
// (Word) rendering engine.
//
// Single source of truth: this reads ctx.p (palette), ctx.aes (aesthetic),
// ctx.logo, ctx.products, ctx.copy and ctx.footer — the exact objects the AMP
// modules render — so the fallback can never drift from the interactive email.

const { enc, formatPrice } = require('./generate');

function lumOf(hex) {
  const h = String(hex || '').replace('#', '');
  if (h.length < 6) return 0.5;
  const ch = (i) => { const c = parseInt(h.slice(i, i + 2), 16) / 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  return 0.2126 * ch(0) + 0.7152 * ch(2) + 0.0722 * ch(4);
}
function onColor(hex) { return lumOf(hex) > 0.55 ? '#1a1a1a' : '#ffffff'; }
function cap(s) { return String(s || '').charAt(0).toUpperCase() + String(s || '').slice(1); }

// text/plain must show real characters, not the HTML entities formatPrice/enc
// emit. Decode numeric + named entities back to Unicode (so "&#163;799" reads
// "£799" and the currency symbol survives) instead of stripping them.
function decodeEntities(s) {
  return String(s || '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}
function priceText(n, currency) { return decodeEntities(formatPrice(n, currency)); }

function ctaHref(ctx) {
  const b = ctx.brand || {};
  return b.url || b.homepage || b.site || b.host || '#';
}

// ---- subject / preheader / sender (previewed as part of the email) ----------
function subjectFor(ctx) {
  const c = ctx.copy || {};
  if (c.subject) return c.subject;
  if (c.head) return `${ctx.brandName}: ${c.head}`.replace(/\s+/g, ' ').trim().slice(0, 90);
  return `A little something from ${ctx.brandName}`;
}
function preheaderFor(ctx) {
  const c = ctx.copy || {};
  if (c.preheader) return c.preheader;
  return (ctx.aes && ctx.aes.showDiscount)
    ? 'Your reward is inside — plus this week’s picks.'
    : 'A private preview of the new season, chosen for you.';
}
function fromNameFor(ctx) { return ctx.brandName || 'AMP Genie'; }

// ---- text/plain -------------------------------------------------------------
function renderText(ctx) {
  const c = ctx.copy || {};
  const head = c.head || ctx.brandName;
  const lines = [];
  lines.push(String(ctx.brandName || '').toUpperCase());
  lines.push('');
  lines.push(head);
  lines.push(preheaderFor(ctx));
  if (c.code) lines.push(`Use code ${c.code} at checkout.`);
  lines.push('');
  const prods = (ctx.products || []).slice(0, 4);
  if (prods.length) {
    lines.push('This week’s picks:');
    prods.forEach((p) => lines.push(`  - ${p.name || 'Item'} — ${priceText(p.price, ctx.currency)}`));
    lines.push('');
  }
  const cta = (ctx.aes && ctx.aes.cta) || 'Shop now';
  lines.push(`${cta}: ${ctaHref(ctx)}`);
  lines.push('');
  const f = ctx.footer || {};
  const year = new Date().getFullYear();
  lines.push(f.copyright || `(c) ${year} ${ctx.brandName}. All rights reserved.`);
  lines.push(`Unsubscribe / View in browser: ${ctaHref(ctx)}`);
  lines.push('');
  lines.push('This email also has an interactive version. Open it in Gmail (or another AMP-capable client) to interact.');
  return lines.join('\n');
}

// ---- text/html (the real cross-client email) --------------------------------
function productGridHtml(ctx) {
  const prods = (ctx.products || []).slice(0, 4);
  if (!prods.length) return '';
  const p = ctx.p || {};
  const A = ctx.aes || {};
  const ink = p.ink || '#1d1d2b';
  const primary = p.primary || '#111';
  const bodyFont = A.bodyFont || 'Arial, Helvetica, sans-serif';
  const cell = (pr) =>
    `<td width="50%" valign="top" style="padding:6px">` +
    `<img src="${pr.url}" width="280" alt="${enc(pr.name || '')}" style="display:block;border:0;outline:none;width:100%;max-width:280px;height:auto;border-radius:8px">` +
    `<div style="font-family:${bodyFont};font-size:13px;font-weight:bold;color:${ink};margin:8px 0 2px">${enc(pr.name || '')}</div>` +
    `<div style="font-family:${bodyFont};font-size:14px;font-weight:bold;color:${primary}">${formatPrice(pr.price, ctx.currency)}</div>` +
    `</td>`;
  let rows = '';
  for (let i = 0; i < prods.length; i += 2) {
    const a = cell(prods[i]);
    const b = prods[i + 1] ? cell(prods[i + 1]) : '<td width="50%"></td>';
    rows += `<tr>${a}${b}</tr>`;
  }
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tbody>${rows}</tbody></table>`;
}

function footerHtml(ctx) {
  const f = ctx.footer || {};
  const year = new Date().getFullYear();
  const nets = (f.social && f.social.length)
    ? f.social.slice(0, 5).map((s) => cap(s.network))
    : ['Instagram', 'Facebook', 'Twitter'];
  const socials = nets.map((n) => `<span style="color:#9aa0a6;font-weight:bold">${enc(n)}</span>`).join('<span style="color:#c4c4d0">&#183;</span>');
  const copyright = f.copyright ? enc(f.copyright) : `&#169; ${year} ${enc(ctx.brandName)}. All rights reserved.`;
  return `<tr><td style="padding:22px 30px;border-top:1px solid #e7e7ee;text-align:center;font-family:Arial,sans-serif;color:#9aa0a6;font-size:11px;line-height:1.8">` +
    `<div>${socials}</div>` +
    `<div style="margin-top:6px">${copyright}</div>` +
    `<div style="margin-top:4px"><span style="color:#9aa0a6;font-weight:bold">Unsubscribe</span> <span style="color:#c4c4d0">&#183;</span> <span style="color:#9aa0a6;font-weight:bold">View in browser</span></div>` +
    `</td></tr>`;
}

function renderFallback(ctx, meta) {
  meta = meta || {};
  const p = ctx.p || {};
  const A = ctx.aes || {};
  const primary = p.primary || '#111111';
  const headInk = onColor(primary);
  const ink = p.ink || '#1d1d2b';
  const bodyFont = A.bodyFont || 'Arial, Helvetica, sans-serif';
  const headFont = A.headFont || bodyFont;
  const head = (ctx.copy && ctx.copy.head) || ctx.brandName;
  const sub = preheaderFor(ctx);
  const cta = A.cta || 'Shop now';
  const href = ctaHref(ctx);
  const subject = subjectFor(ctx);
  const headTransform = A.headTransform || 'none';
  const headLetter = A.headLetter || 'normal';
  const btnRadius = A.btnRadius || '6px';
  const code = ctx.copy && ctx.copy.code;

  const logo = ctx.logo && ctx.logo.url
    ? `<img src="${ctx.logo.url}" width="48" height="48" alt="${enc(ctx.brandName)} logo" style="display:block;border:0;outline:none;background:#ffffff;border-radius:6px;padding:6px">`
    : `<div style="font-family:${headFont};font-weight:bold;font-size:18px;color:${headInk}">${enc(ctx.brandName)}</div>`;

  const codeChip = code
    ? `<div style="margin:14px 0"><span style="display:inline-block;border:2px dashed ${p.accent || primary};color:${primary};font-family:${bodyFont};font-weight:bold;font-size:16px;letter-spacing:2px;padding:9px 18px;border-radius:8px">${enc(code)}</span></div>`
    : '';

  const body =
    `<tr><td style="background:${primary};padding:28px 30px;text-align:center">` +
    `<div style="margin-bottom:14px">${logo}</div>` +
    `<h1 style="margin:0;font-family:${headFont};font-size:22px;line-height:1.35;color:${headInk};font-weight:${A.headWeight || 'bold'};letter-spacing:${headLetter};text-transform:${headTransform}">${enc(head)}</h1>` +
    `</td></tr>` +
    `<tr><td style="padding:28px 30px;text-align:center;font-family:${bodyFont};color:${ink}">` +
    `<p style="margin:0 0 12px;font-size:15px;color:#5a5a6e;line-height:1.6">${enc(sub)}</p>` +
    codeChip +
    productGridHtml(ctx) +
    `<div style="margin-top:24px"><a href="${href}" style="display:inline-block;background:${primary};color:${headInk};text-decoration:none;font-family:${bodyFont};font-weight:bold;font-size:14px;padding:14px 30px;border-radius:${btnRadius};text-transform:${A.btnTransform || 'none'};letter-spacing:${A.btnLetter || 'normal'}">${enc(cta)}</a></div>` +
    `</td></tr>` +
    footerHtml(ctx);

  // Hidden preheader text for the inbox preview line.
  const preheaderSpan = `<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent">${enc(sub)}</div>`;

  return [
    '<!doctype html>',
    '<html lang="en"><head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${enc(subject)}</title>`,
    '</head>',
    '<body style="margin:0;padding:0;background:#eef0f3">',
    preheaderSpan,
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#eef0f3"><tbody><tr><td align="center" style="padding:18px 12px">',
    '<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;background:#ffffff;border-radius:10px;overflow:hidden"><tbody>',
    body,
    '</tbody></table>',
    '</td></tr></tbody></table>',
    '</body></html>',
  ].join('\n');
}

module.exports = { renderFallback, renderText, subjectFor, preheaderFor, fromNameFor };
