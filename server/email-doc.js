'use strict';

// GENIE 2.0 PHASE 3 — the BLOCK DOCUMENT MODEL.
//
// A `doc` (JSON) of ordered STATIC layout blocks renders to ONE valid
// AMP4EMAIL document that passes the real validator, byte-deterministically.
// This is the foundation for a Mailchimp-style visual editor: the editor edits
// the doc, this module turns the doc into the exact bytes the validator sees,
// the downloaded file, and the preview — all from here, the single source of
// truth (same discipline as server/generate.js's module builders).
//
// SCOPE: v1 is STATIC blocks only. No amp-bind, no <amp-state>, no on=
// handlers, no [bound] attributes — so the rendered head carries only the AMP
// runtime v0.js + the boilerplate + <style amp-custom>, nothing else. The seam
// for interactive blocks (the next phase) is marked below at INTERACTIVE_SEAM.
//
// HOUSE RULES honoured here (match server/*): CommonJS, no new npm deps,
// runtime-agnostic (fetch/crypto globals only — bundles for Cloudflare
// Workers), '<'/'>' stripped + entity-encoded from every client string via
// enc(), http(s)-only urls (amp-img needs https specifically), and nothing
// throws into a request — a bad prop degrades to a safe default, never a crash.

// enc/formatPrice/CURRENCIES/derivePalette are the ONLY generate.js primitives
// that module exports, so they are reused directly. Everything else this module
// needs from generate.js (the AMP shell, headerBlock/footerBlock/baseCss
// semantics, ph()/validImgUrl()/siteGuess()) is NOT exported there, so it is
// REPLICATED locally below with a comment pointing at the original — a
// deviation to reconcile later by exporting those helpers from generate.js.
const {
  enc, formatPrice, CURRENCIES, derivePalette,
  buildModuleFragment, MODULE_FIELDS, MODULE_IDS,
} = require('./generate');
const { newId } = require('./store');

/* ------------------------------------------------------------------ *
 * Replicated generate.js primitives (see note above)
 * Kept byte-compatible with the originals so a doc-rendered header/footer/
 * button is indistinguishable from a generate() one.
 * ------------------------------------------------------------------ */

// generate.js:ph — a placeholder image URL (placehold.co, https, no data:).
function ph(w, h, bgHex, fgHex, text) {
  const bg = String(bgHex).replace('#', '');
  const fg = String(fgHex).replace('#', '');
  const t = encodeURIComponent(String(text)).replace(/%20/g, '+');
  return `https://placehold.co/${w}x${h}/${bg}/${fg}?text=${t}`;
}

// generate.js:validImgUrl — AMP4EMAIL rejects every amp-img src protocol except
// https (http: included — INVALID_URL_PROTOCOL). Stricter than an http(s) check:
// only a plain https URL of sane length, free of whitespace/quotes/angle
// brackets (so '<'/'>' stripping could never alter it), survives. Rejection
// means "no image" — every caller falls back to a ph() placeholder.
function validImgUrl(v) {
  const s = (typeof v === 'string') ? v.trim() : '';
  return (s.length <= 500 && /^https:\/\/[^\s"'<>]+$/i.test(s)) ? s : null;
}

// A link/CTA href. Mirrors generate.js:safeHttpUrl — http(s) both allowed for a
// destination link (unlike an image src): a plain http(s) URL of sane length,
// free of whitespace/quotes/angle brackets, else null (caller drops the link).
function safeHttpUrl(v) {
  const s = (typeof v === 'string') ? v.trim() : '';
  return (s.length <= 500 && /^https?:\/\/[^\s"'<>]+$/i.test(s)) ? s : null;
}

// generate.js:siteGuess — best-effort brand homepage for a header logo link.
function siteGuess(brand) {
  const slug = String(brand || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  return slug ? `https://www.${slug}.com` : '#';
}

// generate.js:baseCss — the shared base rules every block draws from. Emitted
// ONCE per document (deduped by CSS_ONCE below), palette baked per-rule, no
// :root/var()/!important/@import (validator + house rule). Kept verbatim so a
// header/footer/button styled from these classes matches generate() output.
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

// generate.js:shell — REPLICATED byte-for-byte (shell() is not exported). Head
// order MUST match generate.js exactly: doctype, <html amp4email
// data-css-strict>, <meta charset> FIRST, then the runtime scripts, then the
// boilerplate, then the single <style amp-custom>. For v1 `scripts` is always
// [] (no interactive components), so `heads` is just the v0.js line.
// INTERACTIVE_SEAM: interactive blocks will pass their extra custom-element
// scripts (amp-bind etc.) here via `scripts`, exactly as generate()'s modules
// already do — the shell itself needs no change for that.
function shell({ scripts, css, body }) {
  const heads = ['<script async src="https://cdn.ampproject.org/v0.js"><\/script>'].concat(scripts || []);
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

/* ------------------------------------------------------------------ *
 * Doc-level constants and small coercers
 * ------------------------------------------------------------------ */

const DOC_VERSION = 1;
const MAX_BLOCKS = 40;
const DEFAULT_PRIMARY = '#4f46e5'; // a neutral, brandable indigo when no brand colour is given
const HEX_ANY = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

// The supported STATIC block types (v1). Order here is the palette order the
// editor can show; it does not constrain block order in a doc.
const STATIC_BLOCK_TYPES = ['header', 'hero', 'text', 'image', 'button', 'products', 'divider', 'footer'];

// The INTERACTIVE block types (Genie 2.0 phase 4): the 8 interactive modules
// from server/generate.js, each addressable AS a block whose `type` is EXACTLY
// the module id. A doc may hold at most ONE (validateDoc enforces it) because
// every module builder shares the amp-state id 's' — two would collide.
// INTERACTIVE_TYPES is the fast membership test used throughout below.
const INTERACTIVE_TYPES = new Set(MODULE_IDS);

// The full palette the editor lists: the eight static layout blocks first, then
// the eight interactive modules. Registering the interactive ids here (a) lets
// the palette surface them and (b) makes validateDoc/renderDoc treat them as
// first-class block types alongside the static ones.
const BLOCK_TYPES = STATIC_BLOCK_TYPES.concat(MODULE_IDS);

// A short client string, scrubbed the same way store.js:cleanStr does before it
// is ever enc()'d into markup: strip '<'/'>' outright (the markup rule), trim,
// cap length. enc() then entity-encodes the rest; the two together guarantee no
// client text can open a tag or smuggle a multibyte glyph raw into the bytes.
function cleanStr(v, max) {
  const s = String(v == null ? '' : v).replace(/[<>]/g, '').trim();
  return typeof max === 'number' ? s.slice(0, max) : s;
}

function coerceCurrency(c) {
  return CURRENCIES[c] ? c : undefined;
}

function coerceHex(v) {
  return HEX_ANY.test(String(v || '')) ? String(v) : undefined;
}

function clampInt(n, min, max, dflt) {
  const v = Math.round(Number(n));
  return Number.isFinite(v) ? Math.max(min, Math.min(max, v)) : dflt;
}

/* ------------------------------------------------------------------ *
 * validateDoc — the trust boundary.
 * Coerces version/currency/brand and EACH block into a normalized doc the
 * renderer can trust: unknown block types are dropped (with a logged note),
 * bad props are sanitized to safe defaults, blocks are capped at MAX_BLOCKS.
 * Never throws — a fundamentally unusable input returns { ok:false, error }.
 * ------------------------------------------------------------------ */

function sanitizeBrand(brand) {
  if (!brand || typeof brand !== 'object') return undefined;
  const out = {};
  const name = cleanStr(brand.name, 80);
  if (name) out.name = name;
  const hex = coerceHex(brand.primaryHex);
  if (hex) out.primaryHex = hex;
  const logo = validImgUrl(brand.logoUrl);
  if (logo) out.logoUrl = logo;
  const site = safeHttpUrl(brand.site);
  if (site) out.site = site;
  return Object.keys(out).length ? out : undefined;
}

// Each entry sanitizes ONE block's props into a trusted shape. A missing
// required prop degrades to a safe default; a bad url is dropped so the
// renderer will placeholder it. Returns the props object (never throws).
const BLOCK_SANITIZERS = {
  header(props = {}) {
    return {
      brandName: cleanStr(props.brandName, 80),
      logoUrl: validImgUrl(props.logoUrl) || undefined,
      link: safeHttpUrl(props.link) || undefined,
    };
  },
  hero(props = {}) {
    return {
      imageUrl: validImgUrl(props.imageUrl) || undefined, // undefined -> placeholder at render
      alt: cleanStr(props.alt, 120),
      height: clampInt(props.height, 80, 600, 240),
    };
  },
  text(props = {}) {
    // PLAIN TEXT ONLY — no html/markup prop ever. heading -> <h1>, body -> <p>,
    // both enc()'d at render. '<'/'>' are stripped here and entity-encoded there.
    return {
      heading: cleanStr(props.heading, 140),
      body: cleanStr(props.body, 2000),
    };
  },
  image(props = {}) {
    return {
      imageUrl: validImgUrl(props.imageUrl) || undefined,
      alt: cleanStr(props.alt, 120),
      href: safeHttpUrl(props.href) || undefined,
      height: clampInt(props.height, 80, 600, 360),
    };
  },
  button(props = {}) {
    const align = ['left', 'center', 'right'].includes(props.align) ? props.align : 'center';
    return {
      label: cleanStr(props.label, 60) || 'Learn more',
      href: safeHttpUrl(props.href) || undefined, // no href -> non-link styled span
      align,
    };
  },
  products(props = {}) {
    const columns = clampInt(props.columns, 1, 3, 2);
    const items = Array.isArray(props.items) ? props.items : [];
    const cleanItems = items
      .map((it) => {
        if (!it || typeof it !== 'object') return null;
        const name = cleanStr(it.name, 60);
        if (!name) return null;
        const out = { name };
        const price = Math.round(Number(it.price));
        if (Number.isFinite(price) && price > 0) out.price = price;
        const img = validImgUrl(it.imageUrl);
        if (img) out.imageUrl = img;
        return out;
      })
      .filter(Boolean)
      .slice(0, 9); // 3 cols x 3 rows, a sane grid cap
    return { columns, items: cleanItems };
  },
  divider() {
    return {}; // no props; a spacer/rule row
  },
  footer(props = {}) {
    return {
      brandName: cleanStr(props.brandName, 80),
      text: cleanStr(props.text, 300),
    };
  },
};

// An interactive block's props are the module's MODULE_FIELDS keys ONLY, each a
// plain client string: '<'/'>' stripped (cleanStr) and capped at 200 chars.
// Unknown props are dropped, empty ones omitted. The module builder enc()'s
// everything again at render (defense in depth) — this keeps the stored doc
// tidy and bounds the payload. `options`/`optionA`/`optionB` are strings too
// (poll's optionA/optionB live in MODULE_FIELDS) and get the same 200-char cap;
// no MODULE_FIELDS key is an array, so there is no list to walk.
const INTERACTIVE_FIELD_CAP = 200;
function sanitizeInteractiveProps(type, props = {}) {
  const fields = MODULE_FIELDS[type] || [];
  const out = {};
  for (const key of fields) {
    const v = cleanStr(props[key], INTERACTIVE_FIELD_CAP);
    if (v) out[key] = v;
  }
  return out;
}

function validateDoc(doc) {
  try {
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
      return { ok: false, error: 'doc must be an object' };
    }
    if (!Array.isArray(doc.blocks)) {
      return { ok: false, error: 'doc.blocks must be an array' };
    }

    const out = { version: DOC_VERSION };
    const brand = sanitizeBrand(doc.brand);
    if (brand) out.brand = brand;
    const currency = coerceCurrency(doc.currency);
    if (currency) out.currency = currency;

    const notes = [];
    const blocks = [];
    // At most ONE interactive block per doc: every module builder uses the same
    // amp-state id ('s'), so two would collide. Keep the FIRST, drop the rest.
    let interactiveSeen = false;
    for (const raw of doc.blocks) {
      if (blocks.length >= MAX_BLOCKS) {
        notes.push(`blocks capped at ${MAX_BLOCKS}; extras dropped`);
        break;
      }
      if (!raw || typeof raw !== 'object') { notes.push('dropped a non-object block'); continue; }
      const type = raw.type;
      const id = (typeof raw.id === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(raw.id)) ? raw.id : newId();
      if (INTERACTIVE_TYPES.has(type)) {
        if (interactiveSeen) { notes.push('only one interactive block per email'); continue; }
        interactiveSeen = true;
        blocks.push({ id, type, props: sanitizeInteractiveProps(type, raw.props || {}) });
        continue;
      }
      const sanitize = BLOCK_SANITIZERS[type];
      if (!sanitize) { notes.push(`dropped unknown block type "${cleanStr(type, 40)}"`); continue; }
      blocks.push({ id, type, props: sanitize(raw.props || {}) });
    }
    out.blocks = blocks;
    if (notes.length) out.notes = notes;

    return { ok: true, doc: out };
  } catch (e) {
    // Nothing throws into a request: an unexpected shape is a validation
    // failure, not a 500.
    return { ok: false, error: 'invalid doc: ' + (e && e.message ? e.message : 'unknown') };
  }
}

/* ------------------------------------------------------------------ *
 * Per-block renderers.
 * Each returns { html, css } — html is the body fragment (in doc order), css is
 * the rules that block needs. Shared/base rules are emitted via CSS_ONCE so the
 * merged stylesheet carries them exactly once. Every client string is enc()'d;
 * every image is validated https or replaced by a ph() placeholder (with a
 * warning). Renderers are pure and never throw.
 * ------------------------------------------------------------------ */

// A keyed CSS block that must appear at most once in the merged stylesheet no
// matter how many blocks of a type a doc contains. renderDoc dedupes by key.
function once(key, css) { return { once: key, css }; }

function renderHeader(props, ctx) {
  const p = ctx.palette;
  const brandName = props.brandName || ctx.brandName || 'Brand';
  const site = props.link || ctx.site || siteGuess(brandName);
  // Palette-tinted logo slot (a generated placeholder) unless a real https logo
  // is supplied — mirrors generate.js:headerBlock semantics.
  const logo = props.logoUrl || ctx.logoUrl
    || ph(96, 32, p.primary, '#ffffff', (brandName || 'BRAND').trim().slice(0, 10));
  const html = `<div class="hdr">
  <a class="brand-link" href="${enc(site)}" target="_blank" rel="noopener noreferrer" aria-label="${enc(brandName)}">
    <amp-img class="logo" src="${enc(logo)}" width="96" height="32" layout="fixed" alt="${enc(brandName)} logo"></amp-img>
  </a>
  <h1>${enc(brandName)}</h1>
</div>`;
  return { html, css: [once('base', baseCss(p))] };
}

function renderHero(props, ctx, warnings) {
  const p = ctx.palette;
  const h = props.height || 240;
  let src = props.imageUrl;
  const alt = props.alt || ctx.brandName || '';
  if (!src) {
    warnings.push('hero: missing/invalid https imageUrl — used a placeholder');
    src = ph(600, h, p.primary, '#ffffff', (ctx.brandName || 'HERO').slice(0, 12));
  }
  const html = `<div class="hero"><amp-img src="${enc(src)}" width="600" height="${h}" layout="responsive" alt="${enc(alt)}"></amp-img></div>`;
  return { html, css: [once('base', baseCss(p)), once('hero', `\n.hero amp-img{display:block;}\n`)] };
}

function renderText(props, ctx) {
  const p = ctx.palette;
  const parts = [];
  if (props.heading) parts.push(`<h2 class="tx-h">${enc(props.heading)}</h2>`);
  if (props.body) parts.push(`<p class="tx-b">${enc(props.body)}</p>`);
  if (!parts.length) parts.push('<p class="tx-b"></p>'); // degrade to an empty, valid paragraph
  const html = `<div class="pad text">${parts.join('\n  ')}</div>`;
  const css = `
.text .tx-h{margin:0 0 10px;font-size:20px;line-height:1.3;font-weight:bold;color:${p.ink};}
.text .tx-b{margin:0;font-size:15px;line-height:1.6;color:${p.ink};}
.text .tx-h + .tx-b{margin-top:0;}
`;
  return { html, css: [once('base', baseCss(p)), once('text', css)] };
}

function renderImage(props, ctx, warnings) {
  const p = ctx.palette;
  let src = props.imageUrl;
  const alt = props.alt || '';
  const h = props.height || 360;
  if (!src) {
    warnings.push('image: missing/invalid https imageUrl — used a placeholder');
    src = ph(600, h, p.tint, p.primary, 'IMAGE');
  }
  const img = `<amp-img src="${enc(src)}" width="600" height="${h}" layout="responsive" alt="${enc(alt)}"></amp-img>`;
  const inner = props.href
    ? `<a href="${enc(props.href)}" target="_blank" rel="noopener noreferrer">${img}</a>`
    : img;
  const html = `<div class="pad imgblk">${inner}</div>`;
  return { html, css: [once('base', baseCss(p)), once('imgblk', `\n.imgblk amp-img{display:block;}\n.imgblk a{display:block;text-decoration:none;}\n`)] };
}

function renderButton(props, ctx, warnings) {
  const p = ctx.palette;
  const label = props.label || 'Learn more';
  const align = props.align || 'center';
  // Bulletproof email CTA: a table wrapper (not :hover-dependent) with an
  // anchor styled from the palette. When no valid href survived, render a
  // non-interactive styled span so the doc stays valid and honest.
  if (!props.href) warnings.push('button: missing/invalid http(s) href — rendered a non-link button');
  const cell = props.href
    ? `<a class="btn" href="${enc(props.href)}" target="_blank" rel="noopener noreferrer">${enc(label)}</a>`
    : `<span class="btn">${enc(label)}</span>`;
  const html = `<div class="pad btnblk btnblk-${align}">
  <table class="btnwrap" role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td>${cell}</td></tr></table>
</div>`;
  const css = `
.btnblk{font-size:0;}
.btnblk .btnwrap{border-collapse:collapse;}
.btnblk-left{text-align:left;}
.btnblk-center{text-align:center;}
.btnblk-right{text-align:right;}
.btnblk .btnwrap{display:inline-table;}
`;
  return { html, css: [once('base', baseCss(p)), once('btnblk', css)] };
}

function renderProducts(props, ctx, warnings) {
  const p = ctx.palette;
  const cols = props.columns || 2;
  const items = props.items || [];
  if (!items.length) {
    // Degrade to a single placeholder tile so the block is never empty/invalid.
    warnings.push('products: no valid items — rendered a placeholder tile');
    items.push({ name: 'Product' });
  }
  const widthPct = cols === 1 ? 100 : cols === 2 ? 48 : 31;
  const cells = items.map((it, i) => {
    const first = i % cols === 0;
    const gap = first ? '' : ' gap';
    const imgSrc = it.imageUrl || ph(300, 200, p.tint, p.primary, it.name);
    if (!it.imageUrl) warnings.push(`products: "${it.name}" has no image — used a placeholder`);
    const price = (it.price != null)
      ? `<p class="price">${formatPrice(it.price, ctx.currency)}</p>`
      : '';
    return `<div class="pcol${gap}">
      <div class="card">
        <amp-img src="${enc(imgSrc)}" width="300" height="200" layout="responsive" alt="${enc(it.name)}"></amp-img>
        <div class="body"><p class="name">${enc(it.name)}</p>${price}</div>
      </div>
    </div>`;
  }).join('\n    ');
  const html = `<div class="pad prod"><div class="row">${cells}</div></div>`;
  const css = `
.prod .pcol{display:inline-block;width:${widthPct}%;vertical-align:top;margin-bottom:12px;}
.prod .pcol.gap{margin-left:${cols === 3 ? '3.5' : '4'}%;}
.prod .card .name{font-size:13px;}
`;
  return { html, css: [once('base', baseCss(p)), once('prod-' + cols, css)] };
}

function renderDivider(props, ctx) {
  const p = ctx.palette;
  const html = `<div class="pad divblk"><div class="divrule"></div></div>`;
  const css = `
.divblk{padding-top:8px;padding-bottom:8px;}
.divrule{border-top:1px solid ${p.line};height:0;font-size:0;line-height:0;}
`;
  return { html, css: [once('base', baseCss(p)), once('divblk', css)] };
}

function renderFooter(props, ctx) {
  const p = ctx.palette;
  const brandName = props.brandName || ctx.brandName || 'Brand';
  // Static footer line — NO real unsub token/link (that would need routing);
  // a plain reassurance line, mirroring generate.js:footerBlock semantics.
  const text = props.text || 'You are receiving this email because you opted in.';
  const html = `<div class="foot"><p>${enc(brandName)} &#8226; ${enc(text)}</p></div>`;
  return { html, css: [once('base', baseCss(p))] };
}

// An interactive block: delegate to generate.js's buildModuleFragment, which
// returns the SAME { scripts, css, body } an interactive module contributes to a
// standalone generate() document. The fragment's copy is the block's sanitized
// props (the builder enc()'s each field again at render). Returns the fragment's
// html/css AND its scripts so renderDoc can dedupe the extra custom-element
// <script> tags into the head. Never throws: an unknown module id yields null,
// which renderDoc skips with a warning.
function renderInteractive(block, ctx, warnings) {
  const p = ctx.palette;
  const fragment = buildModuleFragment(block.type, {
    brand: ctx.brandName || undefined,
    color: ctx.primaryHex || undefined,
    currency: ctx.currency,
    copy: block.props || {},
  });
  if (!fragment) {
    warnings.push(`interactive: unknown module id "${block.type}" — skipped`);
    return null;
  }
  // The module css already begins with generate.js:baseCss (byte-identical to
  // this module's own baseCss for the same palette). We register it whole under
  // a per-module `once` key. mergeCss dedupes by KEY, not by rule, so it cannot
  // fold the module's inline base copy into a sibling static block's own
  // once('base') base — we ACCEPT that identical, valid duplicate: the base
  // rules are byte-for-byte the same and one interactive block keeps the merged
  // stylesheet far under the 75KB amp-custom cap.
  return {
    html: fragment.body,
    css: [once('mod-' + block.type, fragment.css)],
    scripts: fragment.scripts || [],
  };
}

const BLOCK_RENDERERS = {
  header: renderHeader,
  hero: renderHero,
  text: renderText,
  image: renderImage,
  button: renderButton,
  products: renderProducts,
  divider: renderDivider,
  footer: renderFooter,
};

/* ------------------------------------------------------------------ *
 * renderDoc — assemble ONE AMP4EMAIL document from a (trusted) doc.
 * Concatenates block bodies in order; merges + dedupes CSS (each `once` key
 * emitted a single time, base rules included); wraps in the replicated shell
 * with the exact generate.js head order and a single <style amp-custom>.
 * ------------------------------------------------------------------ */

// opts.anchors (Genie 2.0 canvas editor): wrap each top-level block body in a
// <div class="edg-a" data-bid=.. data-btype=..> so the editor's canvas overlay
// can map a click/drag anywhere in the rendered phone back to the block that
// produced it. Anchors are EDITOR-ONLY — the saved/shared amp_html is rendered
// WITHOUT them (clean), so a wrapper div can never reach a real inbox.
function anchorId(id) {
  return String(id == null ? '' : id).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
}
function wrapAnchor(block, html, index) {
  const bid = anchorId(block.id) || ('b' + index);
  const btype = anchorId(block.type);
  return `<div class="edg-a" data-bid="${bid}" data-btype="${btype}">${html}</div>`;
}

function renderDoc(doc, opts = {}) {
  const anchors = !!(opts && opts.anchors);
  const warnings = [];
  // Tolerate being handed either a raw or an already-sanitized doc: if it looks
  // untrusted, run it through the trust boundary first.
  let d = doc;
  if (!d || typeof d !== 'object' || !Array.isArray(d.blocks)) {
    const v = validateDoc(doc);
    if (!v.ok) {
      // Never throw: an unusable doc renders an empty-but-valid shell.
      const p = derivePalette(DEFAULT_PRIMARY);
      const css = mergeCss([once('base', baseCss(p))]);
      warnings.push('renderDoc: ' + v.error + ' — rendered an empty document');
      return { ampHtml: shell({ scripts: [], css, body: '' }), css, warnings };
    }
    d = v.doc;
  }
  if (Array.isArray(d.notes)) warnings.push(...d.notes);

  const primaryHex = (d.brand && d.brand.primaryHex) || DEFAULT_PRIMARY;
  const palette = derivePalette(primaryHex);
  const brandName = (d.brand && d.brand.name) || '';
  const ctx = {
    palette,
    primaryHex,
    currency: d.currency || 'INR',
    brandName,
    logoUrl: (d.brand && d.brand.logoUrl) || undefined,
    site: (d.brand && d.brand.site) || undefined,
  };

  // A doc that reached here still holding 2+ interactive blocks was rendered
  // WITHOUT going through validateDoc's one-interactive enforcement (renderDoc
  // tolerates a pre-sanitized doc). Warn, but render only the FIRST so the
  // shared amp-state id 's' never collides.
  const interactiveCount = d.blocks.filter((b) => INTERACTIVE_TYPES.has(b.type)).length;
  if (interactiveCount > 1) warnings.push('more than one interactive block; only the first was rendered');
  let interactiveRendered = false;

  const bodies = [];
  const cssParts = [];
  // Extra custom-element scripts (amp-bind for every interactive module,
  // amp-form only for search), collected here and deduped so the head lists
  // each exactly once regardless of how the (single) interactive block needs
  // them. Order preserved so the head is byte-deterministic.
  const scripts = [];
  const seenScript = new Set();
  const addScript = (s) => { if (s && !seenScript.has(s)) { seenScript.add(s); scripts.push(s); } };

  d.blocks.forEach((block, index) => {
    if (INTERACTIVE_TYPES.has(block.type)) {
      if (interactiveRendered) return; // belt-and-braces: at most one
      const out = renderInteractive(block, ctx, warnings);
      if (!out) return;
      interactiveRendered = true;
      bodies.push(anchors ? wrapAnchor(block, out.html, index) : out.html);
      for (const c of out.css) cssParts.push(c);
      for (const s of out.scripts) addScript(s);
      return;
    }
    const render = BLOCK_RENDERERS[block.type];
    if (!render) return; // validateDoc already dropped unknowns; belt-and-braces
    const out = render(block.props || {}, ctx, warnings);
    bodies.push(anchors ? wrapAnchor(block, out.html, index) : out.html);
    for (const c of out.css) cssParts.push(c);
  });

  const css = mergeCss(cssParts);
  // The head carries v0.js (always, added by shell) + the deduped
  // custom-element scripts collected above + the boilerplate + ONE
  // <style amp-custom> — exactly what shell() already emits. A static-only doc
  // keeps `scripts` empty, so its output is byte-identical to before.
  const body = bodies.join('\n');
  const ampHtml = shell({ scripts, css, body });
  return { ampHtml, css, warnings };
}

// Merge block CSS fragments, emitting each `once`-keyed rule exactly one time,
// in first-seen order — so the base rules (and any shared per-type rules) never
// duplicate across N blocks. Result is ONE stylesheet string for ONE <style>.
function mergeCss(parts) {
  const seen = new Set();
  let css = '';
  for (const part of parts) {
    if (part && part.once) {
      if (seen.has(part.once)) continue;
      seen.add(part.once);
      css += part.css;
    } else if (typeof part === 'string') {
      css += part;
    } else if (part && typeof part.css === 'string') {
      css += part.css;
    }
  }
  return css;
}

/* ------------------------------------------------------------------ *
 * docToAmp — validate then render, in one call.
 * ------------------------------------------------------------------ */

function docToAmp(doc) {
  const v = validateDoc(doc);
  if (!v.ok) {
    // Surface the failure without throwing: render an empty valid shell and a
    // warning, so a caller wiring this into a route never crashes a request.
    const r = renderDoc({ version: DOC_VERSION, blocks: [] });
    r.warnings.unshift('docToAmp: ' + v.error);
    return { ...r, ok: false, error: v.error };
  }
  const r = renderDoc(v.doc);
  return { ...r, ok: true, doc: v.doc };
}

/* ------------------------------------------------------------------ *
 * exampleDocForBrand — a sensible starter doc (header + hero + text + button +
 * footer) so the editor and the tests always have a real document to open.
 * ------------------------------------------------------------------ */

function exampleDocForBrand(brand = {}) {
  const name = cleanStr(brand.name, 80) || 'Acme';
  const primaryHex = coerceHex(brand.primaryHex) || DEFAULT_PRIMARY;
  const logoUrl = validImgUrl(brand.logoUrl) || undefined;
  const docBrand = { name, primaryHex };
  if (logoUrl) docBrand.logoUrl = logoUrl;
  return {
    version: DOC_VERSION,
    brand: docBrand,
    currency: 'INR',
    blocks: [
      { id: 'b_header', type: 'header', props: { brandName: name, logoUrl } },
      { id: 'b_hero', type: 'hero', props: { alt: `${name} hero`, height: 240 } },
      {
        id: 'b_text', type: 'text',
        props: {
          heading: `Welcome to ${name}`,
          body: 'This starter email is built from a block document. Edit any block, or add hero, image, product-grid, button, divider and footer blocks — every change re-renders to one validator-clean AMP4EMAIL document.',
        },
      },
      { id: 'b_button', type: 'button', props: { label: 'Shop now', href: `https://www.${name.toLowerCase().replace(/[^a-z0-9]+/g, '')}.com`, align: 'center' } },
      { id: 'b_footer', type: 'footer', props: { brandName: name, text: 'You are receiving this because you opted in to updates.' } },
    ],
  };
}

/* ------------------------------------------------------------------ *
 * interactiveDocForModule — a one-block doc wrapping ONE interactive module.
 * The backend uses this to turn a freshly generated interactive example into an
 * editable block document: the module's own builder already renders a header
 * (brand logo + headline) and a footer inside its body, so the doc is JUST the
 * interactive block — no static header/footer to double them up. Always
 * validates (validateDoc sanitizes the copy into the module's field keys).
 * ------------------------------------------------------------------ */

function interactiveDocForModule({ brand = {}, moduleId, copy = {}, currency } = {}) {
  const id = INTERACTIVE_TYPES.has(moduleId) ? moduleId : MODULE_IDS[0];
  const name = cleanStr(brand.name, 80) || 'Acme';
  const primaryHex = coerceHex(brand.primaryHex) || DEFAULT_PRIMARY;
  const logoUrl = validImgUrl(brand.logoUrl) || undefined;
  const docBrand = { name, primaryHex };
  if (logoUrl) docBrand.logoUrl = logoUrl;
  const cur = coerceCurrency(currency);
  const doc = {
    version: DOC_VERSION,
    brand: docBrand,
    blocks: [{ id: 'b_' + id, type: id, props: (copy && typeof copy === 'object') ? copy : {} }],
  };
  if (cur) doc.currency = cur;
  // Round-trip through the trust boundary so the returned doc is always a
  // normalized, render-safe one (copy sanitized to the module's field keys).
  const v = validateDoc(doc);
  return v.ok ? v.doc : doc;
}

// The editable copy field names for a module (the editor/backend surfaces these
// as the interactive block's inputs). Empty array for a non-module id.
function fieldsForModule(moduleId) {
  return (MODULE_FIELDS[moduleId] || []).slice();
}

module.exports = {
  validateDoc, renderDoc, docToAmp, exampleDocForBrand, BLOCK_TYPES,
  interactiveDocForModule, fieldsForModule, INTERACTIVE_TYPES,
};
