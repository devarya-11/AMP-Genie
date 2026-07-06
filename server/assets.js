'use strict';

// Stage 2 — Asset-resolution engine.
//
// For every asset slot an email needs (logo, product image, hero, ...), resolve
// in strict priority order and ALWAYS end with a working HTTPS asset:
//
//   1. user-supplied   (upload buffer or URL)        -> rehost to HTTPS if needed
//   2. brand-site       (logo / product images from brandRead)
//   3. open web         (favicon service / keyworded stock image)
//   4. generated        (branded, palette-aware placeholder — never a grey box)
//
// Nothing can fail: a blocked fetch or 404 falls through to the next tier, and
// the bottom tier (generated) is always reachable HTTPS. Provenance is recorded
// per asset so the UI can show what is real vs. auto-filled.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { brandRead, hashColor } = require('./brand');
const { derivePalette, enc } = require('./generate');
const { getContent } = require('./content');
const category = require('./category');

// ---- config ----------------------------------------------------------------
const PORT = Number(process.env.PORT) || 4000;
// Where rehosted (uploaded / non-HTTPS) assets are served from. For a real
// inbox send this MUST be a public HTTPS origin (an S3/CDN bucket, mirroring
// AJIO's s3.ap-south-1 pattern). Locally it defaults to the app origin.
const ASSET_BASE = (process.env.PUBLIC_ASSET_BASE || `http://localhost:${PORT}`).replace(/\/+$/, '');
const ASSET_DIR = path.join(__dirname, '..', 'web', 'assets');

function ensureDir() {
  try { fs.mkdirSync(ASSET_DIR, { recursive: true }); } catch { /* ignore */ }
}

// ---- low-level fetch helpers ----------------------------------------------
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

async function reachableHttps(url, timeout = 4500) {
  if (!/^https:\/\//i.test(url)) return false;
  try {
    const r = await fetch(url, { method: 'HEAD', redirect: 'follow', headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(timeout) });
    if (r.ok) return true;
    const g = await fetch(url, { method: 'GET', redirect: 'follow', headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(timeout) });
    return g.ok;
  } catch { return false; }
}

// ---- rehost layer ----------------------------------------------------------
// Turn any asset reference into a guaranteed-HTTPS URL.
//  - already https            -> passthrough (optionally mirror with {mirror:true})
//  - http / data / local file -> download/decode, write to ASSET_DIR, serve it
function rehostBuffer(buf, ext) {
  ensureDir();
  const hash = crypto.createHash('sha1').update(buf).digest('hex').slice(0, 16);
  const file = `${hash}.${ext.replace(/^\./, '')}`;
  fs.writeFileSync(path.join(ASSET_DIR, file), buf);
  return `${ASSET_BASE}/assets/${file}`;
}

const EXT_BY_MIME = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/svg+xml': 'svg' };

async function ensureHttps(ref, { mirror = false } = {}) {
  if (!ref) return null;

  // data URI -> decode + rehost
  const dataM = /^data:([^;]+);base64,(.+)$/i.exec(ref);
  if (dataM) {
    const ext = EXT_BY_MIME[dataM[1].toLowerCase()] || 'png';
    return rehostBuffer(Buffer.from(dataM[2], 'base64'), ext);
  }
  // local filesystem path -> read + rehost
  if (/^(\.|\/)/.test(ref) && fs.existsSync(ref)) {
    const ext = (path.extname(ref).slice(1) || 'png').toLowerCase();
    return rehostBuffer(fs.readFileSync(ref), ext);
  }
  // already HTTPS -> passthrough (or mirror to our bucket on request)
  if (/^https:\/\//i.test(ref)) {
    if (!mirror) return ref;
    try {
      const r = await fetch(ref, { redirect: 'follow', headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(6000) });
      if (!r.ok) return ref;
      const ext = EXT_BY_MIME[(r.headers.get('content-type') || '').split(';')[0].trim()] || 'png';
      return rehostBuffer(Buffer.from(await r.arrayBuffer()), ext);
    } catch { return ref; }
  }
  // http:// -> download + rehost as HTTPS
  if (/^http:\/\//i.test(ref)) {
    try {
      const r = await fetch(ref, { redirect: 'follow', headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(6000) });
      if (r.ok) {
        const ext = EXT_BY_MIME[(r.headers.get('content-type') || '').split(';')[0].trim()] || 'png';
        return rehostBuffer(Buffer.from(await r.arrayBuffer()), ext);
      }
    } catch { /* fall through */ }
    return null;
  }
  return null;
}

// ---- tier 3: open-web image providers --------------------------------------
function hostOf(u) { try { return new URL(/^https?:/.test(u) ? u : 'https://' + u).hostname.replace(/^www\./, ''); } catch { return ''; } }

// A real favicon/logo service — good "fetched from web" source for a logo slot.
function faviconUrl(host) {
  return host ? `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=128` : null;
}
// NOTE: the old open-web tier keyworded loremflickr on the last two words of the
// product name and fell back to picsum — a FULLY RANDOM photo. That produced the
// "Coca-Cola under Wood-Fired Margherita / storefront under Korean Fried Chicken"
// class of bug. It is gone. The open-web tier is now CATEGORY-MATCHED (see
// server/category.js): the product NAME → a canonical category → a category-
// correct image, with a contradiction guard that refuses to show an unmatched
// photo. There is no random/picsum source anymore.

// ---- tier 4: generated branded placeholder ---------------------------------
// Palette-aware, labelled, intentional — not a grey "missing image" box.
// Monochrome brands (e.g. luxury black) derive a near-grey `tint`, which would
// read as a generic placeholder; for those we fall back to the warm `accent`
// so the card is unmistakably the brand's, never neutral grey.
function saturation(hex) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex || '');
  if (!m) return 1;
  const r = parseInt(m[1], 16) / 255, g = parseInt(m[2], 16) / 255, b = parseInt(m[3], 16) / 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  if (mx === mn) return 0;
  const l = (mx + mn) / 2;
  return l > 0.5 ? (mx - mn) / (2 - mx - mn) : (mx - mn) / (mx + mn);
}
function generatedUrl(text, w, h, palette, variant) {
  let bgHex, fgHex;
  if (variant === 'logo') { bgHex = palette.primary; fgHex = '#ffffff'; }
  else if (saturation(palette.tint) < 0.08) { bgHex = palette.accent; fgHex = palette.primary; }
  else { bgHex = palette.tint; fgHex = palette.primary; }
  const bg = bgHex.replace('#', ''), fg = fgHex.replace('#', '');
  const t = encodeURIComponent(String(text || 'Image').slice(0, 24)).replace(/%20/g, '+');
  return `https://placehold.co/${w}x${h}/${bg}/${fg}?text=${t}`;
}

// ---- Phase 1.4: licensing & rights per asset -------------------------------
// Every resolved asset carries where it came from AND whether it is safe to put
// in front of real recipients. `rights` is the decision input: 'clear' = fine to
// send; 'review' = open-web/third-party, confirm terms before a client send. The
// preview UI shows the license badge; the pre-send flow warns when any asset is
// 'review'. First-party (the brand's own site) is always preferred and clear.
function licenseFor(tier, source) {
  switch (tier) {
    case 'user':
      return { license: 'User-provided', rights: 'clear', licenseNote: 'You supplied this asset — you hold or have cleared the rights.' };
    case 'brand-site':
      return { license: 'First-party', rights: 'clear', licenseNote: `The brand's own asset, fetched from ${source || 'their site'}. First-party use.` };
    case 'web':
      if (/favicon/i.test(source || '')) {
        return { license: 'Brand mark (public)', rights: 'review', licenseNote: 'The brand’s own logo via a public favicon service. Trademark — fine to represent the brand, but confirm usage for a campaign.' };
      }
      return { license: 'Open-web stock', rights: 'review', licenseNote: `Open-web image (${source || 'stock'}). Permissively licensed, but verify the licence/attribution before sending to customers.` };
    case 'generated':
    default:
      return { license: 'Generated', rights: 'clear', licenseNote: 'Generated by AMP Genie from the brand palette — no third-party rights.' };
  }
}

// ---- per-slot resolution ---------------------------------------------------
function strHash(s) { let h = 0; for (let i = 0; i < String(s).length; i++) h = (h * 31 + String(s).charCodeAt(i)) >>> 0; return h; }

async function resolveSlot(slot, ctx) {
  const { kind, name, width, height, query, userRef, brandRef } = slot;
  const palette = ctx.palette;

  // 1) user-supplied
  if (userRef) {
    const url = await ensureHttps(userRef, { mirror: ctx.mirror });
    if (url) return { ...meta(slot), url, tier: 'user', source: 'user-supplied', confidence: 'high', rehosted: url !== userRef };
  }

  // 2) brand-site
  if (brandRef && /^https:\/\//i.test(brandRef)) {
    if (await reachableHttps(brandRef)) {
      const url = await ensureHttps(brandRef, { mirror: ctx.mirror });
      return { ...meta(slot), url, tier: 'brand-site', source: hostOf(ctx.brandHost || brandRef), confidence: ctx.brandConf || 'high', rehosted: url !== brandRef };
    }
  }

  // 3) open web. For a logo, a public favicon service is the right "fetched"
  //    source. For a product/hero, this is CATEGORY-MATCHED, never random — the
  //    contradiction guard. We derive the product's real category from its NAME
  //    and only use a category-TARGETED image; if we can't confidently
  //    categorize (low confidence), we fall through to the labelled placeholder
  //    rather than risk a photo that contradicts the label.
  if (kind === 'logo') {
    const fav = faviconUrl(ctx.brandHost);
    if (fav && await reachableHttps(fav)) {
      return { ...meta(slot), url: fav, tier: 'web', source: 'google s2 favicons', confidence: 'low', rehosted: false };
    }
  } else {
    const seed = strHash((name || '') + kind);
    const cat = category.categorize(name || ctx.vertical, ctx.vertical);
    if (cat.category && cat.confidence !== 'low') {
      // 3a) curated, deterministic, exact-dimension category photo
      const cu = category.curatedImage(cat.category, width, height, seed);
      if (cu && await reachableHttps(cu, 7000)) {
        return { ...meta(slot), url: cu, tier: 'web', source: `category:${cat.category}`, category: cat.category, categoryConfidence: cat.confidence, confidence: cat.confidence, rehosted: false };
      }
      // 3b) Openverse search — a REAL CC-licensed photo matched to the category,
      //     carrying its own license + creator for provenance
      const ov = await category.openverseImage(cat.query, { w: width, h: height, seed });
      if (ov && await reachableHttps(ov.url, 9000)) {
        return { ...meta(slot), url: ov.url, tier: 'web', source: `openverse:${cat.category}`, category: cat.category, categoryConfidence: cat.confidence, confidence: 'medium', rehosted: false, licenseInfo: ov.license, creator: ov.creator, sourceUrl: ov.sourceUrl };
      }
    }
    // no confident category match → do NOT show a random photo; fall through.
  }

  // 4) generated (cannot fail) — an intentional, on-brand, product-LABELLED card.
  //    Better than a wrong picture: the label always matches the product name.
  const gen = generatedUrl(name || ctx.brandName || kind, width, height, palette, kind === 'logo' ? 'logo' : 'product');
  const genCat = kind === 'logo' ? null : category.categorize(name || ctx.vertical, ctx.vertical).category;
  return { ...meta(slot), url: gen, tier: 'generated', source: 'branded placeholder', category: genCat, categoryConfidence: 'n/a', confidence: 'low', rehosted: false };
}

function meta(slot) {
  return {
    slot: slot.kind + (slot.idx != null ? '#' + slot.idx : ''),
    name: slot.name || null,
    width: slot.width, height: slot.height,
    price: slot.price != null ? slot.price : null,
    // product-page deep link + sku + real-SKU flag travel with the slot so the
    // wishlist / product strip can link to the EXACT product and provenance can
    // show whether the record is a real same-SKU pull or a labelled fallback.
    link: slot.link || null,
    sku: slot.sku || null,
    real: !!slot.real,
  };
}

// ---- public: resolve a whole email's asset set -----------------------------
// spec: {
//   brandUrl?, brandName?, vertical?, tone?, currency?,
//   user?: { logo?, colors?:{primary,accent}, products?:[{name,price,imageUrl|file}] },
//   need?: { logo?:bool, products?:int, hero?:bool },
//   mirror?: bool
// }
async function resolveAssets(spec = {}) {
  const need = Object.assign({ logo: true, products: 3, hero: false }, spec.need || {});
  const user = spec.user || {};

  // ---- resolve the brand identity (reuses brand-read; degrades to synthetic) ----
  let brand = null;
  if (spec.brandUrl || spec.brandName) {
    // deepProducts (default on) lets brandRead crawl the brand's sitemap → PDPs
    // for REAL same-SKU records when a JS-rendered homepage hides the catalogue.
    brand = await brandRead(spec.brandUrl || spec.brandName || '', { deepProducts: spec.deepProducts !== false });
  }
  // Zero-input path: no URL, no name -> synthesise a plausible identity.
  if (!brand) {
    const name = spec.brandName || 'Acme';
    brand = await brandRead(name, { deepProducts: false }); // name-only: no origin to crawl
  }

  // Palette resolution (spec §3): an explicit user override wins; otherwise the
  // brand's resolved primary (curated library → site-extracted → hash) drives
  // everything. There is NO "#2c4152" default — an unknown brand hashes its own
  // name to a stable colour, so teal only ever appears for AJIO.
  const primary = (user.colors && user.colors.primary)
    || (brand.palette && brand.palette.primary)
    || hashColor(spec.brandName || spec.brandUrl || brand.name || 'brand');
  const palette = derivePalette(primary);
  // Accent: user override → brand accent (library/derived) → palette default.
  if (user.colors && user.colors.accent) palette.accent = derivePalette(user.colors.accent).primary;
  else if (brand.palette && brand.palette.accent) palette.accent = derivePalette(brand.palette.accent).primary;
  const brandName = (user.copy && user.copy.brand) || brand.name || spec.brandName || 'Acme';
  const vertical = spec.vertical || brand.vertical || 'Generic';
  const brandHost = hostOf(spec.brandUrl || brand.name || brandName);

  const ctx = {
    palette, brandName, vertical, brandHost,
    brandConf: (brand.confidence && brand.confidence.products) || 'medium',
    mirror: !!spec.mirror,
  };

  const slots = [];
  if (need.logo) {
    slots.push({
      kind: 'logo', name: brandName, width: 200, height: 60,
      userRef: user.logo || null,
      brandRef: brand.logo || null,
    });
  }
  const userProducts = Array.isArray(user.products) ? user.products : [];
  const brandProducts = Array.isArray(brand.products) ? brand.products : [];
  // Vertical-appropriate names so an auto-filled slot reads like a real product
  // (e.g. Food -> "Wood-Fired Margherita") and the provenance list matches what
  // the module renders, instead of a generic "Food pick 1".
  const contentItems = (getContent(vertical).items || []);
  for (let i = 0; i < need.products; i++) {
    const up = userProducts[i] || {};
    const bp = brandProducts[i] || {};
    const ci = contentItems[i] || {};
    const fallbackName = ci.name || `${vertical} pick ${i + 1}`;
    // A synthetic brand product (from the name-only fallback brandRead) is just a
    // Generic placeholder — it carries no real signal, so it must NOT override the
    // vertical-appropriate content fallback. A real-scraped OR curated brand name
    // does win.
    const bpUsable = !!(bp.name && !bp.synthetic);
    const name = up.name || (bpUsable ? bp.name : null) || fallbackName;
    // Price comes from the SAME RECORD as the name. CRITICAL (Part A honesty): a
    // REAL same-SKU product whose own source exposed NO price stays null — shown
    // as "on site", NEVER back-filled from the content ladder. We never staple a
    // made-up price onto a real SKU. Curated/synthetic records keep their
    // representative (clearly-labelled) price.
    let price = null;
    if (up.name) price = up.price != null ? up.price : null;
    else if (bpUsable) price = bp.price != null ? bp.price : null; // real SKU w/o price → null
    else price = ci.price != null ? ci.price : null;               // content fallback (synthetic)
    slots.push({
      kind: 'product', idx: i, name, price,
      width: 600, height: 400, query: name,
      link: up.url || (bpUsable ? bp.url : null) || null,
      sku: bpUsable ? (bp.sku || null) : null,
      real: !!(bpUsable && bp.real),
      userRef: up.imageUrl || up.file || null,
      brandRef: bp.imageUrl || null,
    });
  }
  if (need.hero) {
    slots.push({ kind: 'hero', name: brandName, width: 600, height: 300, query: vertical, userRef: (user.hero || null), brandRef: brand.logo || null });
  }

  // resolve all slots in parallel, then stamp each with its licence + rights.
  // A category source that carries its OWN license (Openverse CC) wins over the
  // tier-based default, so provenance shows the real licence + attribution.
  const resolvedRaw = await Promise.all(slots.map((s) => resolveSlot(s, ctx)));
  const resolved = resolvedRaw.map((r) => {
    const { licenseInfo, ...rest } = r;
    return { ...rest, ...(licenseInfo || licenseFor(r.tier, r.source)) };
  });

  const logo = resolved.find((r) => r.slot === 'logo') || null;
  const products = resolved.filter((r) => r.slot.startsWith('product'));
  const hero = resolved.find((r) => r.slot === 'hero') || null;

  const summary = resolved.reduce((acc, r) => { acc[r.tier] = (acc[r.tier] || 0) + 1; return acc; }, {});

  return {
    brand: {
      name: brandName, vertical,
      tone: spec.tone || brand.tone || 'Playful',
      currency: spec.currency || brand.currency || 'INR',
      aesthetic: brand.aesthetic || 'playful',
      voice: brand.voice || null,
      // Art-direction identity (Part A): the branded header nav, the hero theme,
      // the brand's own tagline and its promo strip — so build.js can compose a
      // complete, brand-authentic creative without re-reading the site.
      nav: brand.nav || null,
      heroTheme: brand.heroTheme || null,
      tagline: brand.tagline || null,
      promo: brand.promo || null,
      footer: brand.footer || null,
      source: brand.source,
    },
    palette: { primary: palette.primary, primaryDark: palette.primaryDark, accent: palette.accent, tint: palette.tint, ink: palette.ink, line: palette.line },
    assets: { logo, products, hero },
    provenance: resolved,
    summary,
    assetBase: ASSET_BASE,
  };
}

module.exports = { resolveAssets, ensureHttps, reachableHttps, faviconUrl, generatedUrl, ASSET_BASE };
