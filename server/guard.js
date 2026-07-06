'use strict';

// ============================================================================
// server/guard.js — the MAIN-PATH brand-bleed guard (Remediation Phase 1).
//
// Invariant enforced: on the primary /build path, EVERY chromatic (brand-
// identifying) colour that appears in the generated email must trace to THIS
// build's GenerationContext (context.palette). If a colour that belongs to some
// OTHER client's identity survives into this output — the "#2c4152 for everyone"
// class of bug — generation FAILS LOUDLY here rather than silently shipping the
// wrong brand's colour.
//
// This is deliberately DISTINCT from reference/assert.js:
//   reference/assert.js  → "no value from a Trove REFERENCE email bled in"
//   server/guard.js      → "every brand colour came from THIS GenerationContext"
// Keeping it in server/ preserves the one-directional seam (server/ must not know
// reference/), so the tiny hex helpers are duplicated here on purpose.
//
// What is NOT a brand fingerprint, and is therefore allowed:
//   • Grayscale / near-neutral scaffolding (#fff, #000, #1d1d2b, #e6e6ec …) —
//     every email's structural chrome; collapses below the saturation threshold.
//   • A short, code-owned set of SEMANTIC / ILLUSTRATION constants that are
//     identical for EVERY brand (so they can never be one client's identity
//     leaking into another's email). Each is enumerated and justified below.
// Everything else chromatic must be in context.palette or the guard throws.
// ============================================================================

const { enc } = require('./generate');

class BrandBleedError extends Error {
  constructor(msg) { super(msg); this.name = 'BrandBleedError'; }
}
class ProductPairingError extends Error {
  constructor(msg) { super(msg); this.name = 'ProductPairingError'; }
}

const HEX_RE = /#[0-9a-fA-F]{3,8}\b/g;

function hexChannels(hex) {
  let h = String(hex).replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  if (h.length === 8) h = h.slice(0, 6); // drop alpha
  if (h.length !== 6) return null;
  const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
  if ([r, g, b].some((n) => Number.isNaN(n))) return null;
  return [r, g, b];
}
// A colour is "chromatic" (a candidate brand identity value) when its channels
// are not near-equal. Pure grayscale scaffolding collapses to ~0 saturation and
// is never a fingerprint, so it is never guarded.
function isChromatic(hex) {
  const ch = hexChannels(hex);
  if (!ch) return false;
  const [r, g, b] = ch;
  return (Math.max(r, g, b) - Math.min(r, g, b)) > 18;
}
function normHex(hex) {
  const ch = hexChannels(hex);
  if (!ch) return null;
  return '#' + ch.map((n) => n.toString(16).padStart(2, '0')).join('');
}

// ---- code-owned semantic / illustration constants --------------------------
// These are brand-NEUTRAL: the SAME value renders for every client, so they can
// never be Client A's identity surfacing in Client B's email. They are exempt
// for exactly the same reason grayscale is — shared vocabulary, not a fingerprint.
// If you add a new hardcoded chromatic colour to a template/module, either derive
// it from context.palette or justify it here; otherwise the guard will (rightly)
// fail the build.
const SEMANTIC_COLOURS = new Set([
  '#d23b3b', // form-validation error text (prodtemplate.js .err) — universal error red
  // football-PITCH illustration gradient (build.js `game` module .pitch) — a pitch
  // is green regardless of brand; this is artwork, not identity:
  '#246b43', '#348c58', '#1a5233',
]);

// Collect the chromatic colours THIS build's GenerationContext legitimately owns.
function ownedColours(context) {
  const out = new Set();
  if (!context) return out;
  const pal = context.palette || {};
  for (const v of Object.values(pal)) {
    if (typeof v !== 'string') continue;
    const n = normHex(v);
    if (n && isChromatic(n)) out.add(n);
  }
  return out;
}

// The guard polices TEMPLATE CHROME — the CSS, inline styles and structural
// colours the generator paints from context.palette. It must NOT police the
// interior bytes of the brand's OWN embedded assets: a rasterised/inline vector
// asset (an `<svg>` block, or a `data:image/svg+xml` URI produced when the slice
// rehost falls back to inlining) legitimately carries whatever colours the
// brand's artwork contains — first-party identity payload, exactly like the
// pixels of a raster <amp-img> the guard already ignores. Scanning inside those
// payloads would false-fail on a brand's own logo/hero colours (which need not
// appear in context.palette). We therefore excise asset payloads before scanning;
// the #2c4152-for-everyone bleed class lives in CSS/inline-style chrome, which
// remains fully covered.
function stripAssetPayloads(html) {
  return String(html || '')
    // HTML numeric character references are NOT colours: `&#163;` is £, `&#8377;`
    // is ₹, `&#127881;` is 🎉. The hex scanner would otherwise read the digits of
    // `&#163;` as "#163" and normalise it to #116633 — a phantom green that fails
    // the build for every GBP (£) campaign. Strip all character references first.
    .replace(/&#x?[0-9a-fA-F]+;/gi, ' ')            // numeric character references (&#163; &#x1F389;)
    .replace(/&[a-zA-Z][a-zA-Z0-9]+;/g, ' ')        // named character references (&pound; &amp;)
    // Asset payloads: a rasterised/inline vector asset carries whatever colours the
    // brand's artwork contains — first-party identity payload, like the pixels of a
    // raster <amp-img>. Scanning inside them would false-fail on the brand's own
    // logo/hero colours (which need not appear in context.palette).
    .replace(/=(["'])data:[\s\S]*?\1/gi, '=$1$1')  // quoted data: URI asset payloads (incl. inline SVG)
    .replace(/<svg\b[\s\S]*?<\/svg>/gi, ' ');       // inline SVG asset payloads
}

// ---- the guard -------------------------------------------------------------
// Throw BrandBleedError if any chromatic colour in `html` is neither owned by
// this GenerationContext nor a documented brand-neutral semantic constant.
function assertContextIsSoleSource(html, context, opts = {}) {
  const owned = ownedColours(context);
  const extra = opts.allowColours
    ? new Set([...opts.allowColours].map(normHex).filter(Boolean))
    : new Set();
  const chrome = stripAssetPayloads(html);
  const outHexes = new Set((chrome.match(HEX_RE) || []).map(normHex).filter(Boolean));
  for (const c of outHexes) {
    if (!isChromatic(c)) continue;             // grayscale scaffolding — never a brand value
    if (owned.has(c)) continue;                // the client's own identity colour
    if (SEMANTIC_COLOURS.has(c)) continue;     // brand-neutral semantic/illustration constant
    if (extra.has(c)) continue;                // caller-supplied allowance (tests)
    throw new BrandBleedError(
      `brand colour ${c} appears in generated output but is NOT in this build's GenerationContext ` +
      `(palette: ${[...owned].join(', ') || 'none'}) — every brand colour must come from GenerationContext, ` +
      `not a default, cache, template remnant, or another client's build`);
  }
  return true;
}

// ---- product image ↔ label pairing guard (Remediation Phase 3) -------------
// Every rendered product image must carry the label of the SAME GenerationContext
// product entry it was resolved from — an image can never be zipped to a different
// product's name. In the finished email a product record renders as
//   <amp-img src="<url>" ... alt="<enc(name)>">   +   <p class="pname"><enc(name)></p>
// both from one record. This guard walks the output: for any product image whose
// src is a context product URL and whose alt is non-empty, the alt MUST equal that
// URL's own record label. A cross-record zip (src from record i, name from record
// j) would surface as alt≠label here and fail loudly.
//
// Preload/prefetch images (1×1, alt="") legitimately reuse product URLs with an
// empty alt, so empty-alt images are skipped — they carry no label to mismatch.
//
// A single URL may back MORE THAN ONE product record: when a vertical has a thin
// image supply, several distinct records fall back to the same category-generic
// image (e.g. two bus routes both showing one stock coach photo). Each record is
// still internally consistent — its own label sits with its own image — so a URL
// maps to the SET of labels of every record that uses it. The invariant we
// enforce is the real one: a rendered image's alt must be the label of SOME
// record that actually uses that image. The zip bug we guard against (record i's
// URL paired with record j's label, where j does not share that URL) still fails
// loudly, because j's label is absent from the URL's label set.
const AMPIMG_RE = /<amp-img\b[^>]*>/gi;
function attr(tag, name) {
  const m = tag.match(new RegExp(name + '\\s*=\\s*"([^"]*)"', 'i'));
  return m ? m[1] : null;
}
function assertProductPairing(html, context) {
  const products = (context && context.assets || [])
    .filter((a) => a && a.slot && a.slot.startsWith('product') && a.url);
  if (!products.length) return true;
  const labelsByUrl = new Map();
  for (const p of products) {
    if (!labelsByUrl.has(p.url)) labelsByUrl.set(p.url, new Set());
    labelsByUrl.get(p.url).add(enc(p.alt || ''));
  }
  const hay = String(html || '');
  for (const tag of hay.match(AMPIMG_RE) || []) {
    const src = attr(tag, 'src');
    if (!src || !labelsByUrl.has(src)) continue; // not a product image
    const alt = attr(tag, 'alt');
    if (alt == null || alt === '') continue;     // preload/decorative — no label to check
    const allowed = labelsByUrl.get(src);
    if (!allowed.has(alt)) {
      throw new ProductPairingError(
        `product image ${JSON.stringify(src)} rendered with alt ${JSON.stringify(alt)} but no ` +
        `GenerationContext record using that image carries that label (records for this image: ` +
        `${JSON.stringify([...allowed])}) — image and label must come from the SAME product entry, ` +
        `never zipped from independent lists`);
    }
  }
  return true;
}

module.exports = {
  assertContextIsSoleSource,
  assertProductPairing,
  ownedColours,
  isChromatic,
  normHex,
  SEMANTIC_COLOURS,
  BrandBleedError,
  ProductPairingError,
};
