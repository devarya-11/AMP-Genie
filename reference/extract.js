'use strict';

// ============================================================================
// reference/extract.js — Phase 2: brand-agnostic design fingerprint.
//
// Input : one captured email body (HTML).
// Output: patterns/{uuid}.json — an ABSTRACT structure. Every field is a count,
//         a boolean, or a token from reference/vocab.js. NO hex, NO url, NO font
//         name, NO copy string ever persists. Concrete brand values are read
//         only to COMPUTE roles (e.g. a hex → a contrast bucket) and discarded.
//
// The output is run through vocab.assertAbstract() before write, so a leak is a
// hard build failure, not a silent regression. This is the data-model boundary
// the spec demands ("reference = FORM, client = IDENTITY").
// ============================================================================

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { JSDOM } = require('jsdom');
const V = require('./vocab');
const { readIndex } = require('./ingest');

const PATTERNS_DIR = path.join(__dirname, '..', 'patterns');

// ---- colour helpers (used to derive ROLES, never stored) -------------------
function hexToRgb(hex) {
  let h = String(hex).replace('#', '').trim();
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  if (h.length !== 6) return null;
  const n = parseInt(h, 16);
  if (Number.isNaN(n)) return null;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function relLum(rgb) {
  const a = rgb.map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * a[0] + 0.7152 * a[1] + 0.0722 * a[2];
}
function contrastRatio(hex1, hex2) {
  const a = hexToRgb(hex1), b = hexToRgb(hex2);
  if (!a || !b) return null;
  const l1 = relLum(a), l2 = relLum(b);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}
function contrastRole(ratio) {
  if (ratio == null) return 'medium';
  if (ratio >= 7) return 'high';
  if (ratio >= 4) return 'medium';
  return 'low';
}
const HEX_RE = /#[0-9a-f]{3,8}\b/gi;

// ---- font role helpers (used to derive ROLES, never stored) ----------------
const SERIF_HINT = /\b(serif|georgia|times|garamond|didot|playfair|baskerville|merriweather|cambria|book antiqua|minion|caslon)\b/i;
function isSerif(fontFamily) {
  if (!fontFamily) return false;
  if (/\bsans-serif\b/i.test(fontFamily) && !SERIF_HINT.test(fontFamily.replace(/sans-serif/ig, ''))) return false;
  return SERIF_HINT.test(fontFamily);
}

// ---- emoji + copy helpers --------------------------------------------------
const EMOJI_RE = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}\u{2700}-\u{27BF}\u{FE0F}]/u;
const PRICE_RE = /[$₹€£]\s?\d|\bRs\.?\s?\d|\b\d+\s?(USD|INR|EUR|GBP)\b/i;
const BUTTONY = /\b(btn|button|cta)\b/i;

function intentOf(text) {
  const t = String(text || '').toLowerCase();
  for (const intent of V.CTA_INTENTS) {
    const kws = V.CTA_VERB_LEXICON[intent] || [];
    if (kws.some((k) => t.includes(k))) return intent;
  }
  return null;
}
function offerFramingOf(text) {
  const t = String(text || '');
  if (/\b(invitation|preview|reserved for you|exclusive access|first look|curated for you)\b/i.test(t)) return 'editorial';
  for (const [token, re] of V.OFFER_DETECTORS) { if (re.test(t)) return token; }
  return 'none';
}

// ---- inline-style + <style> mini resolver ----------------------------------
// Email HTML mixes inline styles, presentational attributes (bgcolor) and a
// small <style> block. jsdom's CSS cascade for <style> is unreliable, so we do
// a tiny resolver: inline wins, then matching .class rules, then tag rules.
function parseStyleBlocks(doc) {
  const rules = [];
  for (const s of doc.querySelectorAll('style')) {
    const css = s.textContent || '';
    const re = /([^{}]+)\{([^{}]*)\}/g; let m;
    while ((m = re.exec(css))) {
      const selectors = m[1].split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
      const decls = {};
      for (const d of m[2].split(';')) {
        const i = d.indexOf(':'); if (i < 0) continue;
        decls[d.slice(0, i).trim().toLowerCase()] = d.slice(i + 1).trim();
      }
      rules.push({ selectors, decls });
    }
  }
  return rules;
}
function declFromInline(el, prop) {
  const st = el.getAttribute && el.getAttribute('style');
  if (!st) return null;
  const re = new RegExp('(?:^|;)\\s*' + prop + '\\s*:\\s*([^;]+)', 'i');
  const m = st.match(re); return m ? m[1].trim() : null;
}
function styleProp(el, prop, rules) {
  const inline = declFromInline(el, prop);
  if (inline) return inline;
  const tag = el.tagName ? el.tagName.toLowerCase() : '';
  const classes = (el.getAttribute && (el.getAttribute('class') || '')).toLowerCase().split(/\s+/).filter(Boolean);
  // class rules first (more specific), then tag rules
  for (const r of rules) {
    if (r.selectors.some((s) => classes.some((c) => s === '.' + c))) { if (r.decls[prop]) return r.decls[prop]; }
  }
  for (const r of rules) {
    if (r.selectors.includes(tag)) { if (r.decls[prop]) return r.decls[prop]; }
  }
  return null;
}

// ---- element measurements --------------------------------------------------
function pxOf(v) { if (!v) return null; const m = String(v).match(/(-?\d+(?:\.\d+)?)\s*px?/i) || String(v).match(/^(-?\d+(?:\.\d+)?)$/); return m ? parseFloat(m[1]) : null; }
function imgWidth(img) {
  return pxOf(img.getAttribute('width')) || pxOf(declFromInline(img, 'width')) || null;
}
function tableWidth(t) {
  return pxOf(t.getAttribute('width')) || pxOf(declFromInline(t, 'width')) || pxOf(declFromInline(t, 'max-width')) || null;
}
function bgOf(el, rules) {
  const attr = el.getAttribute && el.getAttribute('bgcolor');
  if (attr && /^#?[0-9a-f]{3,6}$/i.test(attr)) return attr[0] === '#' ? attr : '#' + attr;
  const bg = styleProp(el, 'background-color', rules) || styleProp(el, 'background', rules);
  if (bg) { const m = bg.match(/#[0-9a-f]{3,6}\b/i); if (m) return m[0]; }
  return null;
}
function isButton(a, rules) {
  const cls = (a.getAttribute('class') || '');
  if (BUTTONY.test(cls)) return true;
  const bg = bgOf(a, rules);
  const pad = styleProp(a, 'padding', rules);
  const border = styleProp(a, 'border', rules);
  return !!((bg || border) && pad); // a styled, padded anchor reads as a button
}
const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();

// ---- section classifier ----------------------------------------------------
function classifySection(tr, idx, total, rules) {
  const txt = norm(tr.textContent);
  const imgs = [...tr.querySelectorAll('img')];
  const anchors = [...tr.querySelectorAll('a')];
  const buttons = anchors.filter((a) => isButton(a, rules));
  const headings = [...tr.querySelectorAll('h1,h2,h3,h4,h5,h6')];
  const hasH1 = !!tr.querySelector('h1');
  const bigImg = imgs.some((i) => (imgWidth(i) || 0) >= 480);
  const smallImgs = imgs.filter((i) => (imgWidth(i) || 999) <= 96);
  const innerRows = [...tr.querySelectorAll('table tr')];
  const priceHit = PRICE_RE.test(txt);

  // count "tile cells": cells in the densest inner row that contain an img
  function tileCells() {
    let max = 0;
    for (const ir of innerRows) {
      const cells = [...ir.children].filter((c) => /^t[dh]$/i.test(c.tagName) && c.querySelector('img'));
      max = Math.max(max, cells.length);
    }
    return max;
  }
  const cols = tileCells();

  // footer
  if (/unsubscribe|©|&copy;|all rights reserved|view in browser|privacy policy/i.test(txt) && idx >= total - 2) return { type: 'footer', cols: 0 };
  // social proof (note the leading \b: avoid matching "review" inside "preview")
  if (/[★⭐✩]|\breviews?\b|\bratings?\b|verified|testimonial|loved by|as seen in/i.test(txt)) return { type: 'social_proof', cols: 0 };
  // countdown / urgency timer
  if (/ends in|hours? left|countdown|\b\d{1,2}:\d{2}:\d{2}\b|sale ends/i.test(txt)) return { type: 'countdown', cols: 0 };
  // header: first row, a small logo, little else
  if (idx === 0 && imgs.length >= 1 && !bigImg && txt.length < 40 && buttons.length === 0) return { type: 'header', cols: 0 };
  // value props: 3+ small/icon cells, short labels, no price/button
  if (cols >= 3 && smallImgs.length >= 3 && !priceHit && buttons.length === 0 && txt.length < 120) return { type: 'value_props', cols };
  // product grid / strip: 2+ tiles with price or buy-button
  if (cols >= 2 && (priceHit || buttons.length >= 2)) {
    const productRows = innerRows.filter((ir) => [...ir.children].some((c) => c.querySelector && c.querySelector('img')));
    return { type: productRows.length > 1 ? 'product_grid' : 'product_strip', cols };
  }
  // category nav: 3+ tiles, short labels, no price, no buy button
  if (cols >= 3 && !priceHit && buttons.length === 0) return { type: 'category_nav', cols };
  // cta banner: a button (and maybe a heading), no product tiles, little imagery
  if (buttons.length >= 1 && cols === 0 && !bigImg) return { type: 'cta_banner', cols: 0 };
  // hero: a large image, OR a leading h1 with short supporting copy
  if (bigImg) return { type: 'hero', cols: 0 };
  if (hasH1 && txt.length < 160 && imgs.length === 0) return { type: 'hero', cols: 0 };
  // editorial: text-led block
  if (txt.length >= 120 && imgs.length <= 1) return { type: 'editorial', cols: 0 };
  // spacer / divider
  if (imgs.length === 0 && txt.length === 0) return { type: 'divider', cols: 0 };
  // fallbacks
  if (buttons.length >= 1) return { type: 'cta_banner', cols: 0 };
  if (imgs.length >= 1) return { type: 'product_strip', cols: Math.max(cols, 1) };
  return { type: 'editorial', cols: 0 };
}

function dedupeConsecutive(sections) {
  const out = [];
  for (const s of sections) { if (!out.length || out[out.length - 1].type !== s.type) out.push(s); }
  return out;
}

// ---- the extractor ---------------------------------------------------------
function extractPattern(html, { subject = '', uuid = null, source = 'trove' } = {}) {
  const dom = new JSDOM(html);
  const doc = dom.window.document;
  const rules = parseStyleBlocks(doc);

  // ---- layout: outer width + section sequence ----
  const tables = [...doc.querySelectorAll('table')];
  let outer = tables.find((t) => { const w = tableWidth(t); return w && w >= 560 && w <= 680; });
  const widthConstrained = !!outer || tables.some((t) => { const w = tableWidth(t); return w && w >= 560 && w <= 680; });
  if (!outer) outer = tables[0] || doc.body;

  let rows = [...outer.querySelectorAll(':scope > tbody > tr')];
  if (!rows.length) rows = [...outer.querySelectorAll(':scope > tr')];
  if (!rows.length) rows = [...(doc.body ? doc.body.children : [])];

  let sections = rows.map((tr, i) => classifySection(tr, i, rows.length, rules));
  // merge an immediately-following short hero-headline into the hero image
  sections = dedupeConsecutive(sections.filter((s) => s.type !== 'divider'));
  const sectionTypes = sections.map((s) => s.type);
  const gridCols = sections.filter((s) => /product_grid|product_strip|category_nav|value_props/.test(s.type)).map((s) => s.cols).filter(Boolean);
  const productCells = sections.filter((s) => /product_grid|product_strip/.test(s.type))
    .reduce((n, s) => n + Math.max(s.cols, 1), 0);

  // ---- component inventory (whole doc) ----
  const allImgs = [...doc.querySelectorAll('img')];
  const allAnchors = [...doc.querySelectorAll('a')];
  const buttons = allAnchors.filter((a) => isButton(a, rules));
  const links = allAnchors.length - buttons.length;
  const headings = [...doc.querySelectorAll('h1,h2,h3,h4,h5,h6')];
  const paragraphs = [...doc.querySelectorAll('p')];
  const components = {
    image: allImgs.length,
    button: buttons.length,
    heading: headings.length,
    paragraph: paragraphs.length,
    table: tables.length,
    link: links,
    divider: doc.querySelectorAll('hr').length,
    list: doc.querySelectorAll('ul,ol').length,
    anim: doc.querySelectorAll('amp-anim,[data-anim]').length,
    video: doc.querySelectorAll('video,amp-video').length,
  };

  // ---- palette ROLES (derive from hex, store roles only) ----
  const styleText = [...doc.querySelectorAll('style')].map((s) => s.textContent).join('\n');
  const inlineStyles = [...doc.querySelectorAll('[style]')].map((e) => e.getAttribute('style')).join(';');
  const attrColors = [...doc.querySelectorAll('[bgcolor]')].map((e) => '#' + (e.getAttribute('bgcolor') || '').replace('#', ''));
  const hexes = ((styleText + ';' + inlineStyles).match(HEX_RE) || []).concat(attrColors.filter((c) => /^#[0-9a-f]{3,6}$/i.test(c)));
  const distinctColors = new Set(hexes.map((h) => h.toLowerCase()));
  const bodyBg = bgOf(doc.body, rules) || (outer && bgOf(outer, rules)) || '#ffffff';
  const bgLight = (() => { const rgb = hexToRgb(bodyBg); return rgb ? relLum(rgb) >= 0.5 : true; })();
  // dark sections: any section row with a dark bg — the bgcolor often sits on a
  // descendant <td>, so scan the row + its cells for the darkest backdrop.
  let darkSections = 0;
  for (const tr of rows) {
    const candidates = [tr, ...tr.querySelectorAll('td,th')];
    const dark = candidates.some((el) => { const b = bgOf(el, rules); if (!b) return false; const rgb = hexToRgb(b); return rgb && relLum(rgb) < 0.3; });
    if (dark) darkSections++;
  }
  // cta contrast: first button's bg vs text colour
  let ctaContrast = 'medium';
  if (buttons.length) {
    const b = buttons[0];
    const bbg = bgOf(b, rules) || bodyBg;
    const bfg = (styleProp(b, 'color', rules) || '').match(/#[0-9a-f]{3,6}\b/i);
    ctaContrast = contrastRole(contrastRatio(bbg, bfg ? bfg[0] : (bgLight ? '#000000' : '#ffffff')));
  }
  const palette_roles = {
    distinct_colors: Math.min(distinctColors.size, 32),
    bg_is_light: bgLight,
    has_dark_section: darkSections > 0,
    dark_section_count: darkSections,
    cta_contrast: ctaContrast,
    // accent = colours beyond a small core (bg, ink, one brand) — a relationship, not a value
    accent_count: Math.max(0, Math.min(distinctColors.size - 3, 8)),
  };

  // ---- typography ROLES (derive from font-family, store roles only) ----
  const famDecls = [];
  const ffRe = /font-family\s*:\s*([^;{}]+)/gi; let fm;
  while ((fm = ffRe.exec(styleText + ';' + inlineStyles))) famDecls.push(fm[1].trim().toLowerCase());
  const distinctFamilies = new Set(famDecls.map((f) => f.split(',')[0].replace(/['"]/g, '').trim()));
  const displayEl = doc.querySelector('h1') || doc.querySelector('h2');
  const displayFam = displayEl ? (styleProp(displayEl, 'font-family', rules) || famDecls[0] || '') : (famDecls[0] || '');
  const weights = new Set();
  for (const e of [...headings, ...paragraphs, ...buttons]) { const w = styleProp(e, 'font-weight', rules); if (w) weights.add(w.trim()); }
  const headingLevels = new Set(headings.map((h) => h.tagName.toLowerCase()));
  const anyUpper = headings.some((h) => /uppercase/i.test(styleProp(h, 'text-transform', rules) || ''));
  const anyTracked = headings.some((h) => { const ls = styleProp(h, 'letter-spacing', rules); return ls && pxOf(ls) && pxOf(ls) > 0; });
  const typography_roles = {
    families: Math.min(distinctFamilies.size, 6),
    serif_display: isSerif(displayFam),
    weight_levels: Math.max(1, Math.min(weights.size, 6)),
    hierarchy_depth: Math.max(1, headingLevels.size),
    all_caps_headings: anyUpper,
    letterspaced_headings: anyTracked,
  };

  // ---- copy CADENCE (no strings stored) ----
  const subj = String(subject || '');
  const bodyText = norm(doc.body ? doc.body.textContent : '');
  const intents = buttons.map((b) => intentOf(norm(b.textContent))).filter(Boolean);
  const intentMode = intents.length
    ? intents.sort((a, b) => intents.filter((x) => x === b).length - intents.filter((x) => x === a).length)[0]
    : 'browse';
  const textBlocks = headings.length + paragraphs.length;
  const imageToText = +(allImgs.length / Math.max(1, allImgs.length + textBlocks)).toFixed(2);
  const density = allImgs.length <= 3 ? 'sparse' : allImgs.length <= 9 ? 'balanced' : 'dense';
  const copy = {
    subject_len: subj.length,
    subject_emoji: EMOJI_RE.test(subj),
    cta_intent: intentMode,
    offer_framing: offerFramingOf(subj + ' ' + bodyText),
    image_count: allImgs.length,
    image_to_text: imageToText,
    image_density: density,
    word_count: bodyText.split(/\s+/).filter(Boolean).length,
  };

  const pattern = {
    schema: 'amp-genie/pattern@1',
    vertical: null, // assigned in Phase 3
    layout: {
      width_constrained: widthConstrained,
      section_count: sectionTypes.length,
      sections: sectionTypes,
      product_cells: productCells,
      grid_cols_max: gridCols.length ? Math.max(...gridCols) : 0,
    },
    components,
    palette_roles,
    typography_roles,
    copy,
    provenance: { uuid, source, schema: 'amp-genie/pattern@1' },
  };

  // HARD boundary: throws if any concrete brand value leaked through.
  V.assertAbstract(pattern);
  dom.window.close();
  return pattern;
}

// ---- driver: index.jsonl → patterns/{uuid}.json ----------------------------
async function buildPatterns({ quiet = false } = {}) {
  const log = (...a) => { if (!quiet) console.log(...a); };
  await fsp.mkdir(PATTERNS_DIR, { recursive: true });
  const index = await readIndex();
  let ok = 0, fail = 0;
  for (const row of index) {
    try {
      const html = await fsp.readFile(path.join(__dirname, '..', row.body_path), 'utf8');
      const pat = extractPattern(html, { subject: row.subject || '', uuid: row.uuid, source: row.source || 'trove' });
      await fsp.writeFile(path.join(PATTERNS_DIR, `${row.uuid}.json`), JSON.stringify(pat, null, 2), 'utf8');
      ok++;
    } catch (e) { fail++; log(`  ! ${row.uuid}: ${e.message}`); }
  }
  log(`extract: ${ok} pattern(s) written → patterns/  (${fail} failed)`);
  return { ok, fail };
}

if (require.main === module) {
  buildPatterns().catch((e) => { console.error(e); process.exit(1); });
}

module.exports = { extractPattern, buildPatterns, PATTERNS_DIR, contrastRole, isSerif };
