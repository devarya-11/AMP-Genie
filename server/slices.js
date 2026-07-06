'use strict';

// ============================================================================
// slices.js — the composed-artwork layer for production-shaped AMP emails.
//
// Real production mailers don't draw CTAs/icons/dividers with CSS — they ship
// them as flat IMAGE SLICES (PNG) so every client renders pixel-identical. This
// module AUTHORS those slices as SVG (vector source, palette-aware), rasterizes
// them to PNG with `sharp`, and hosts them under ASSET_BASE (an S3/CDN bucket in
// production, mirroring the existing rehost layer in assets.js).
//
// THE ZERO-ERROR GATE comes first. AMP4EMAIL only accepts https image URLs, so:
//   • slices are ENABLED only when sharp is installed AND ASSET_BASE is https
//     (i.e. a real CDN origin) — then `sliceUrl()` returns a CDN slice URL and
//     `prewarmSlices()` rasterizes the PNGs.
//   • otherwise (dev: ASSET_BASE = http://localhost) we DEFER to the existing
//     https placeholder (generatedUrl) so the output keeps validating with 0
//     errors. The STRUCTURE (amp-img slice in a tap button / icon cell) is
//     identical either way — only the pixels differ.
//
// This is the "all of the above" the user picked: SVG source + sharp raster +
// CDN-swap with a graceful dev fallback.
// ============================================================================

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { generatedUrl, ASSET_BASE } = require('./assets');

// sharp is optional at runtime: if it isn't installed we degrade to placeholders
// rather than crash. (It IS installed now; this keeps the module load-safe.)
let sharp = null;
try { sharp = require('sharp'); } catch { sharp = null; }

const ASSET_DIR = path.join(__dirname, '..', 'web', 'assets');
const IS_HTTPS_BASE = /^https:\/\//i.test(ASSET_BASE);
// Force-enable for local rasterization tests (writes PNGs to disk so sharp can be
// proven) WITHOUT affecting validated output — when forced in dev the URL is
// still http, so callers must only force in a controlled test, never in a send.
const FORCED = process.env.SLICES_FORCE === '1';

function slicesEnabled() { return !!sharp && (IS_HTTPS_BASE || FORCED); }
function ensureDir() { try { fs.mkdirSync(ASSET_DIR, { recursive: true }); } catch { /* ignore */ } }
function assetUrl(file) { return `${ASSET_BASE.replace(/\/+$/, '')}/assets/${file}`; }

// ---- deterministic identity per slice --------------------------------------
function hashSpec(spec) {
  const k = JSON.stringify({
    kind: spec.kind, text: spec.text || '', w: spec.w, h: spec.h, key: spec.key || '',
    pri: (spec.palette && spec.palette.primary) || '', acc: (spec.palette && spec.palette.accent) || '',
    tint: (spec.palette && spec.palette.tint) || '', ink: (spec.palette && spec.palette.ink) || '',
  });
  return crypto.createHash('sha1').update(k).digest('hex').slice(0, 16);
}

// ---- colour helpers (self-contained; mirror prodtemplate's onColor) ---------
function lum(hex) {
  const h = String(hex || '').replace('#', '');
  if (h.length < 6) return 0.5;
  const ch = (i) => { const c = parseInt(h.slice(i, i + 2), 16) / 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  return 0.2126 * ch(0) + 0.7152 * ch(2) + 0.0722 * ch(4);
}
function ink(hex) { return lum(hex) > 0.55 ? '#1a1a1a' : '#ffffff'; }
function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

// ---- glyph library (simple, original line marks — never brand trademarks) ----
// Each returns SVG path/shape markup drawn inside a 0..24 viewBox, stroke set by
// the caller. Keyword-matched so a benefit's meaning reads at icon size.
const GLYPHS = {
  delivery: '<path d="M2 7h9v8H2zM11 10h5l3 3v2h-8z" /><circle cx="6" cy="17" r="1.6"/><circle cx="16" cy="17" r="1.6"/>',
  secure: '<path d="M12 3l7 3v5c0 4.2-2.9 7.7-7 9-4.1-1.3-7-4.8-7-9V6z"/>',
  quality: '<path d="M12 3l2.6 5.4 5.9.8-4.3 4.1 1 5.9L12 16.9 6.8 19.2l1-5.9L3.5 9.2l5.9-.8z"/>',
  price: '<path d="M3 12l8-8h8v8l-8 8z"/><circle cx="15.5" cy="8.5" r="1.4"/>',
  fast: '<circle cx="12" cy="12" r="8"/><path d="M12 7v5l4 2"/>',
  natural: '<path d="M5 18c0-7 5-12 14-12 0 9-5 14-12 14-2 0-2-2-2-2z"/><path d="M9 16c3-3 5-5 7-7"/>',
  care: '<path d="M12 20s-7-4.4-7-9.3C5 7.6 7 6 9.2 6c1.6 0 2.8 1 2.8 1s1.2-1 2.8-1C17 6 19 7.6 19 10.7 19 15.6 12 20 12 20z"/>',
  reward: '<circle cx="12" cy="9" r="5"/><path d="M9 13l-2 7 5-3 5 3-2-7"/>',
  support: '<path d="M5 13a7 7 0 0 1 14 0v3a2 2 0 0 1-2 2h-1v-5h3M5 13v3a2 2 0 0 0 2 2h1v-5H5"/>',
  check: '<path d="M5 13l4 4 10-11"/>',
};
function glyphFor(text) {
  const t = String(text || '').toLowerCase();
  if (/deliver|ship|free.?ship|dispatch/.test(t)) return GLYPHS.delivery;
  if (/secure|safe|protect|guarant|trust|insur/.test(t)) return GLYPHS.secure;
  if (/quality|premium|best|top|crafted|authentic/.test(t)) return GLYPHS.quality;
  if (/price|deal|save|discount|off|value|cashback/.test(t)) return GLYPHS.price;
  if (/fast|quick|instant|express|same.?day|24/.test(t)) return GLYPHS.fast;
  if (/natural|fresh|organic|veg|herbal|clean/.test(t)) return GLYPHS.natural;
  if (/care|love|hand|gentle|skin/.test(t)) return GLYPHS.care;
  if (/reward|points|loyal|member|exclusive|vip/.test(t)) return GLYPHS.reward;
  if (/support|help|24x7|service|assist/.test(t)) return GLYPHS.support;
  return GLYPHS.check;
}

// Simple, unmistakable social marks (generic glyphs, NOT trademark logos).
function socialGlyph(key, stroke, fg) {
  switch (key) {
    case 'in': return `<rect x="4" y="9" width="3.2" height="11" rx="0.4" fill="${fg}"/><circle cx="5.6" cy="5.4" r="1.9" fill="${fg}"/><path d="M11 9h3v1.6c.6-1 1.8-1.9 3.4-1.9 2.5 0 3.6 1.6 3.6 4.5V20h-3.2v-5.4c0-1.4-.5-2.3-1.8-2.3-1 0-1.6.7-1.8 1.4-.1.2-.1.6-.1.9V20H11z" fill="${fg}"/>`;
    case 'f': return `<path d="M14.5 8.5H17V5.3h-2.7c-2.4 0-3.8 1.5-3.8 3.9v1.6H8v3.1h2.5V21h3.2v-7.1H16l.4-3.1h-2.7V9.4c0-.6.3-.9 1-.9z" fill="${fg}"/>`;
    case 'IG': return `<rect x="4.5" y="4.5" width="15" height="15" rx="4.5" fill="none" stroke="${stroke}" stroke-width="1.8"/><circle cx="12" cy="12" r="3.6" fill="none" stroke="${stroke}" stroke-width="1.8"/><circle cx="16.4" cy="7.6" r="1.1" fill="${fg}"/>`;
    case 'YT': return `<rect x="3.5" y="6.5" width="17" height="11" rx="3" fill="${fg}"/><path d="M10.5 9.5l5 2.5-5 2.5z" fill="${esc(/* hole */ '#ffffff')}"/>`;
    case 'X': return `<path d="M5 5l14 14M19 5L5 19" stroke="${stroke}" stroke-width="2.2" stroke-linecap="round"/>`;
    default: return `<circle cx="12" cy="12" r="7" fill="none" stroke="${stroke}" stroke-width="1.8"/>`;
  }
}

// ---- SVG slice builders -----------------------------------------------------
// All return a complete <svg> document sized to spec.w × spec.h.
function svgDoc(w, h, inner, bg) {
  return `<?xml version="1.0" encoding="UTF-8"?>` +
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
    (bg ? `<rect width="${w}" height="${h}" fill="${bg}"/>` : '') + inner + `</svg>`;
}

function ctaSvg(spec) {
  const { w, h, text, palette } = spec;
  const fill = palette.primary, fg = ink(palette.primary);
  const r = Math.min(h / 2, 10);
  const fontSize = Math.round(Math.min(h * 0.42, 20));
  const label = esc(String(text || 'Shop now').toUpperCase());
  // pill + centered label + chevron
  const cx = w - h * 0.55;
  return svgDoc(w, h,
    `<rect x="1" y="1" width="${w - 2}" height="${h - 2}" rx="${r}" fill="${fill}"/>` +
    `<text x="${(w - h * 0.5) / 2 + 6}" y="${h / 2}" fill="${fg}" font-family="Arial,Helvetica,sans-serif" font-size="${fontSize}" font-weight="700" letter-spacing="0.6" text-anchor="middle" dominant-baseline="central">${label}</text>` +
    `<path d="M${cx} ${h / 2 - 5} l5 5 l-5 5" fill="none" stroke="${fg}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`
  );
}

function iconSvg(spec) {
  const { w, h, text, palette } = spec;
  const d = Math.min(w, h);
  const ring = palette.primary, plate = palette.tint || '#eef0f3';
  // scale the 24-box glyph into the badge with padding
  const pad = d * 0.28, gscale = (d - pad * 2) / 24, gx = pad, gy = pad;
  return svgDoc(w, h,
    `<circle cx="${w / 2}" cy="${h / 2}" r="${d / 2 - 1}" fill="${plate}"/>` +
    `<g transform="translate(${gx},${gy}) scale(${gscale})" fill="none" stroke="${ring}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${glyphFor(text)}</g>`
  );
}

function socialSvg(spec) {
  const { w, h, key, palette } = spec;
  // sits on the dark footer band → white plate, brand-primary glyph
  const plate = '#ffffff', stroke = palette.primary, fg = palette.primary;
  const d = Math.min(w, h);
  // glyphs are authored in a 0..24 box → scale + centre them into the badge
  const inner = d * 0.56, gscale = inner / 24, gx = (w - inner) / 2, gy = (h - inner) / 2;
  return svgDoc(w, h,
    `<circle cx="${w / 2}" cy="${h / 2}" r="${d / 2 - 1}" fill="${plate}"/>` +
    `<g transform="translate(${gx},${gy}) scale(${gscale})">${socialGlyph(key, stroke, fg)}</g>`
  );
}

function loaderSvg(spec) {
  const { w, h, palette } = spec;
  const c = palette.primary, cy = h / 2, r = Math.max(2, h * 0.12);
  const xs = [w * 0.3, w * 0.5, w * 0.7];
  const dots = xs.map((x, i) => `<circle cx="${x}" cy="${cy}" r="${r}" fill="${c}" opacity="${0.4 + i * 0.3}"/>`).join('');
  return svgDoc(w, h, dots);
}

function dividerSvg(spec) {
  const { w, h, palette } = spec;
  const c = palette.primary, a = palette.accent || palette.primary, y = h / 2;
  return svgDoc(w, h,
    `<line x1="${w * 0.12}" y1="${y}" x2="${w * 0.44}" y2="${y}" stroke="${c}" stroke-width="2"/>` +
    `<line x1="${w * 0.56}" y1="${y}" x2="${w * 0.88}" y2="${y}" stroke="${c}" stroke-width="2"/>` +
    `<circle cx="${w / 2}" cy="${y}" r="${Math.max(3, h * 0.18)}" fill="${a}"/>`
  );
}

const BUILDERS = { cta: ctaSvg, icon: iconSvg, social: socialSvg, loader: loaderSvg, divider: dividerSvg };

function buildSvg(spec) {
  const fn = BUILDERS[spec.kind] || iconSvg;
  return fn(spec);
}

// ---- placeholder mapping (the dev / disabled fallback) ----------------------
// Returns a guaranteed-https placeholder matching the slice's role, so disabled
// output keeps the SAME structure and stays validator-clean.
function placeholder(spec) {
  const variantByKind = { cta: 'cta', icon: 'icon', social: 'icon', loader: 'loader', divider: 'icon' };
  const variant = variantByKind[spec.kind] || 'icon';
  const label = spec.kind === 'cta' ? (spec.text || 'Shop now') : (spec.text || spec.key || spec.kind);
  return generatedUrl(label, spec.w, spec.h, spec.palette, variant);
}

// ---- rasterize one spec to a PNG buffer via sharp --------------------------
async function rasterize(spec) {
  if (!sharp) throw new Error('sharp not available');
  const svg = buildSvg(spec);
  // render at 2× for crisp display on retina; amp-img downsizes to w×h
  const buf = await sharp(Buffer.from(svg), { density: 192 })
    .resize(spec.w * 2, spec.h * 2, { fit: 'fill' })
    .png({ compressionLevel: 9 })
    .toBuffer();
  return buf;
}

// ---- the synchronous URL the template calls --------------------------------
// Deterministic. When enabled, returns a CDN PNG URL and registers the spec for
// prewarm; when disabled, returns the https placeholder (zero-error path).
const _pending = new Map(); // hash -> spec
function sliceUrl(spec) {
  if (!slicesEnabled()) return placeholder(spec);
  const hash = hashSpec(spec);
  const file = `slice-${hash}.png`;
  const full = path.join(ASSET_DIR, file);
  if (!fs.existsSync(full)) _pending.set(hash, { spec, file });
  return assetUrl(file);
}

// ---- rasterize everything registered since the last prewarm ----------------
// Call once after composing an email (or a batch) to materialize the PNGs. In a
// real deploy ASSET_DIR is synced to the CDN that ASSET_BASE points at.
async function prewarmSlices() {
  if (!slicesEnabled() || !_pending.size) return { written: 0, total: 0 };
  ensureDir();
  const jobs = Array.from(_pending.values());
  _pending.clear();
  let written = 0;
  for (const { spec, file } of jobs) {
    const full = path.join(ASSET_DIR, file);
    if (fs.existsSync(full)) continue;
    try { fs.writeFileSync(full, await rasterize(spec)); written++; } catch { /* leave to placeholder next build */ }
  }
  return { written, total: jobs.length };
}

module.exports = {
  sliceUrl, prewarmSlices, rasterize, buildSvg, placeholder,
  slicesEnabled, hashSpec, ASSET_DIR,
  // expose builders for tests
  _builders: BUILDERS,
};
