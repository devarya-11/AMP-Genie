'use strict';

// ============================================================================
// reference/assert.js — Phase 5: the LOUD assertion layer.
//
// Two complementary guards enforce "reference = FORM, client = IDENTITY":
//
//   assertAbstract(obj)            (re-exported from vocab) — the FORWARD guard.
//     Walks a distilled pattern/profile/skeleton and throws unless every value
//     is a count, boolean, or controlled-vocab token. Nothing concrete can be
//     STORED in the reference layer in the first place.
//
//   assertNoReferenceLeak(html, opts) — the BACKWARD guard.
//     Walks the FINISHED generated email and throws if any *concrete brand
//     value lifted from a real reference email* (a non-grayscale hex colour, an
//     image URL, or a custom font-family name observed in corpus/*.html) appears
//     in the output. This is the spec's "generation fails loudly if any concrete
//     value traces back to a reference email rather than GenerationContext."
//
// The forward guard proves the reference layer is clean by construction; the
// backward guard proves the boundary held end-to-end, through the generator,
// even if a future bug tried to smuggle a reference value into the render.
// ============================================================================

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const V = require('./vocab');

const CORPUS_DIR = path.join(__dirname, '..', 'corpus');

class ReferenceLeakError extends Error {
  constructor(msg) { super(msg); this.name = 'ReferenceLeakError'; }
}

// ---- forbidden-set construction --------------------------------------------
// A hex is "chromatic" (a brand identity colour) when its channels are not all
// near-equal. Pure grayscale (#fff, #000, #111, #f5f5f5) is shared layout
// scaffolding every email uses — not a fingerprint — so we never forbid it.
function hexChannels(hex) {
  let h = hex.replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  if (h.length === 8) h = h.slice(0, 6); // drop alpha
  if (h.length !== 6) return null;
  const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
  if ([r, g, b].some((n) => Number.isNaN(n))) return null;
  return [r, g, b];
}
function isChromatic(hex) {
  const ch = hexChannels(hex);
  if (!ch) return false;
  const [r, g, b] = ch;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  return (max - min) > 18; // saturation threshold — grayscale collapses to ~0
}
function normHex(hex) {
  const ch = hexChannels(hex);
  if (!ch) return null;
  return '#' + ch.map((n) => n.toString(16).padStart(2, '0')).join('');
}

const HEX_RE = /#[0-9a-fA-F]{3,8}\b/g;
const URL_RE = /https?:\/\/[^\s"'()<>]+/gi;
const FONTFAM_RE = /font-family\s*:\s*([^;"'}]+)/gi;
// generic CSS font keywords are shared vocabulary, never a brand fingerprint
const GENERIC_FONTS = new Set([
  'serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui',
  'inherit', 'initial', 'unset', 'arial', 'helvetica', 'georgia', 'times',
  'times new roman', 'courier', 'courier new', 'verdana', 'tahoma', 'roboto',
  'ui-sans-serif', 'ui-serif', '-apple-system', 'blinkmacsystemfont', 'segoe ui',
]);

function extractFonts(css) {
  const out = new Set();
  let m;
  FONTFAM_RE.lastIndex = 0;
  while ((m = FONTFAM_RE.exec(css))) {
    for (const part of m[1].split(',')) {
      const name = part.trim().replace(/^["']|["']$/g, '').toLowerCase();
      if (name && !GENERIC_FONTS.has(name) && /[a-z]/.test(name)) out.add(name);
    }
  }
  return out;
}

// Scan the raw corpus once → the set of concrete values that must NEVER surface.
async function buildForbiddenSet({ corpusDir = CORPUS_DIR, includeSample = true } = {}) {
  const colours = new Set(), urls = new Set(), fonts = new Set();
  let files = [];
  try {
    const walk = async (dir) => {
      for (const ent of await fsp.readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) {
          if (!includeSample && ent.name === '_sample') continue;
          await walk(full);
        } else if (ent.name.endsWith('.html')) files.push(full);
      }
    };
    await walk(corpusDir);
  } catch { /* no corpus yet */ }

  for (const f of files) {
    let html = '';
    try { html = await fsp.readFile(f, 'utf8'); } catch { continue; }
    for (const m of html.match(HEX_RE) || []) { if (isChromatic(m)) colours.add(normHex(m)); }
    for (const m of html.match(URL_RE) || []) {
      // ignore schema/namespace URLs that legitimately appear in valid AMP too
      if (/w3\.org|ampproject\.org|schema\.org|googleapis\.com\/css/i.test(m)) continue;
      urls.add(m.replace(/[).,;]+$/, ''));
    }
    for (const fnt of extractFonts(html)) fonts.add(fnt);
  }
  return { colours, urls, fonts, sources: files.length };
}

let _forbiddenCache = null;
async function loadForbiddenSet(opts) {
  if (_forbiddenCache && !opts) return _forbiddenCache;
  const set = await buildForbiddenSet(opts || {});
  if (!opts) _forbiddenCache = set;
  return set;
}
function clearForbiddenCache() { _forbiddenCache = null; }

// Collect the client's OWN declared identity values from a GenerationContext, so
// the guard never punishes a brand for a value it independently owns. A colour
// the client genuinely uses (e.g. Zomato's #e23744) is allowed even if some
// reference email coincidentally uses the same colour — the rule is "no
// reference value BLEEDS in", not "no client value may ever equal a reference's".
function allowFromContext(context) {
  const colours = new Set(), urls = new Set(), fonts = new Set();
  if (!context) return { colours, urls, fonts };
  const pal = context.palette || {};
  for (const v of Object.values(pal)) { const n = typeof v === 'string' && normHex(v); if (n) colours.add(n); }
  for (const a of (context.assets || [])) { if (a && a.url) urls.add(a.url); }
  return { colours, urls, fonts };
}

// ---- the backward guard ----------------------------------------------------
// Throw if any forbidden concrete reference value appears in `html`, EXCEPT
// values the client independently owns (opts.allow / opts.context). The allow
// set is what makes this "no reference value rode along" rather than the far
// stronger (and wrong) "output shares no colour with any reference email".
async function assertNoReferenceLeak(html, opts = {}) {
  const forbidden = opts.forbidden || await loadForbiddenSet(opts.buildOpts);
  const allow = opts.allow || allowFromContext(opts.context);
  const allowColours = allow.colours instanceof Set ? allow.colours : new Set((allow.colours || []).map(normHex).filter(Boolean));
  const allowUrls = allow.urls instanceof Set ? allow.urls : new Set(allow.urls || []);
  const allowFonts = allow.fonts instanceof Set ? allow.fonts : new Set((allow.fonts || []).map((f) => String(f).toLowerCase()));
  const hay = String(html || '');
  const hayLower = hay.toLowerCase();

  // colours — compare normalised, case-insensitively; skip the client's own
  const outHexes = new Set((hay.match(HEX_RE) || []).map((h) => normHex(h)).filter(Boolean));
  for (const c of forbidden.colours) {
    if (allowColours.has(c)) continue; // the client genuinely owns this colour
    if (outHexes.has(c)) {
      throw new ReferenceLeakError(
        `reference colour ${c} from a source email leaked into generated output — every colour must come from GenerationContext`);
    }
  }
  // image / asset URLs — exact substring (forbidden urls already concrete)
  for (const u of forbidden.urls) {
    if (allowUrls.has(u)) continue;
    if (hay.includes(u)) {
      throw new ReferenceLeakError(
        `reference URL ${JSON.stringify(u)} from a source email leaked into generated output — assets must come from GenerationContext`);
    }
  }
  // custom font-family names
  for (const fnt of forbidden.fonts) {
    if (allowFonts.has(fnt)) continue;
    if (hayLower.includes(fnt)) {
      throw new ReferenceLeakError(
        `reference font-family ${JSON.stringify(fnt)} from a source email leaked into generated output — typography must come from GenerationContext`);
    }
  }
  return true;
}

module.exports = {
  // forward guard (re-exported so callers import one assertion module)
  assertAbstract: V.assertAbstract,
  LeakError: V.LeakError,
  // backward guard
  assertNoReferenceLeak, allowFromContext, buildForbiddenSet, loadForbiddenSet, clearForbiddenCache,
  isChromatic, normHex, ReferenceLeakError, CORPUS_DIR,
};
