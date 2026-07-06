'use strict';

// Phase 1.4 — accessibility audit of the GENERATED email (run from the single
// GenerationContext + the AMP it produced, so the report always matches what
// ships). Three checks, each with an honest pass/warn/fail and the specifics:
//   • alt text   — every content image needs a meaningful alt
//   • contrast   — WCAG 2.1 AA on the baked palette pairs actually rendered
//   • headings   — exactly one h1, no skipped levels
//
// "Auto-fix where safe" applies to alt text only (we can fill a sensible alt
// from the product/brand name). Contrast is never auto-fixed — silently editing
// a brand's colours would violate the human-oversight rule — so it is surfaced
// with the exact ratio and the suggested direction instead.

// ---- WCAG relative luminance + contrast ratio -------------------------------
function lin(c) { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
function lum(hex) {
  const h = String(hex || '').replace('#', '');
  if (h.length < 6) return 0;
  const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}
function contrast(fg, bg) {
  const a = lum(fg), b = lum(bg);
  const hi = Math.max(a, b), lo = Math.min(a, b);
  return (hi + 0.05) / (lo + 0.05);
}
function onColor(hex) { return lum(hex) > 0.55 ? '#1a1a1a' : '#ffffff'; }

// ---- alt text ---------------------------------------------------------------
function checkAltText(ampHtml, context) {
  const tags = (ampHtml || '').match(/<amp-img\b[^>]*>/gi) || [];
  let missing = 0; const fixes = [];
  tags.forEach((t) => {
    const alt = (t.match(/\balt="([^"]*)"/i) || [])[1];
    if (!alt || !alt.trim()) missing++;
  });
  // Mirror against context assets to suggest concrete safe fills.
  (context && context.assets || []).forEach((a) => {
    if (a.slot !== 'logo' && (!a.alt || !String(a.alt).trim())) {
      fixes.push({ slot: a.slot, suggested: a.alt || a.source || 'Product image' });
    }
  });
  const total = tags.length;
  const status = missing === 0 ? 'pass' : (missing <= 1 ? 'warn' : 'fail');
  return {
    id: 'alt', label: 'Image alt text', status,
    detail: missing === 0
      ? `All ${total} image(s) carry alt text.`
      : `${missing} of ${total} image(s) are missing alt text — screen readers will skip them.`,
    autofix: fixes.length ? fixes : null,
  };
}

// ---- contrast (AA) ----------------------------------------------------------
// Pairs that are actually rendered by build.js/fallback.js. Headline + CTA are
// large/bold (AA large-text threshold 3.0); body + meta are normal text (4.5).
function checkContrast(context) {
  const p = (context && context.palette) || {};
  const primary = p.primary || '#111111';
  const ink = p.ink || '#1d1d2b';
  const bg = p.background || '#ffffff';
  const accent = p.accent || primary;
  const pairs = [
    { name: 'Headline on brand header', fg: onColor(primary), bg: primary, min: 3.0, kind: 'large' },
    { name: 'CTA label on button', fg: onColor(primary), bg: primary, min: 4.5, kind: 'normal' },
    { name: 'Body text on background', fg: ink, bg, min: 4.5, kind: 'normal' },
    { name: 'Price on background', fg: primary, bg, min: 4.5, kind: 'normal' },
    // The accent is rendered as a BUTTON/PANEL FILL (build.js .btnA / scratch cover),
    // never as text on the page — so the meaningful test is the label ON the accent,
    // which is exactly what build.js paints (color:onColor(accent)). Testing accent
    // as foreground-on-white would false-FAIL every tasteful light accent (camel,
    // gold, blush) that luxury brands rely on, which is wrong.
    { name: 'Label on accent button', fg: onColor(accent), bg: accent, min: 4.5, kind: 'normal' },
  ];
  const rows = pairs.map((pr) => {
    const ratio = Math.round(contrast(pr.fg, pr.bg) * 100) / 100;
    return { ...pr, ratio, ok: ratio >= pr.min };
  });
  const fails = rows.filter((r) => !r.ok);
  const status = fails.length === 0 ? 'pass' : (fails.every((r) => r.ratio >= 3.0) ? 'warn' : 'fail');
  return {
    id: 'contrast', label: 'Colour contrast (WCAG AA)', status,
    rows,
    detail: fails.length === 0
      ? `All ${rows.length} text/background pairs meet AA.`
      : `${fails.length} pair(s) below AA: ${fails.map((r) => `${r.name} (${r.ratio}:1, needs ${r.min}:1)`).join('; ')}.`,
  };
}

// ---- heading structure ------------------------------------------------------
function checkHeadings(ampHtml) {
  const levels = [];
  const re = /<h([1-6])\b/gi; let m;
  while ((m = re.exec(ampHtml || '')) !== null) levels.push(Number(m[1]));
  const h1 = levels.filter((l) => l === 1).length;
  let skips = false;
  for (let i = 1; i < levels.length; i++) if (levels[i] - levels[i - 1] > 1) skips = true;
  let status = 'pass', detail = `Heading order is logical (${levels.length} heading(s), one h1).`;
  if (h1 === 0) { status = 'warn'; detail = 'No <h1> found — the email should have one clear top-level heading.'; }
  else if (h1 > 1) { status = 'warn'; detail = `${h1} <h1> headings — keep a single top-level heading for clear structure.`; }
  else if (skips) { status = 'warn'; detail = 'Heading levels skip (e.g. h1 → h3) — use sequential levels.'; }
  return { id: 'headings', label: 'Heading structure', status, levels, detail };
}

function auditAccessibility({ ampHtml = '', context = {} }) {
  const alt = checkAltText(ampHtml, context);
  const contrastRes = checkContrast(context);
  const headings = checkHeadings(ampHtml);
  const checks = [alt, contrastRes, headings];
  const status = checks.some((c) => c.status === 'fail') ? 'fail'
    : checks.some((c) => c.status === 'warn') ? 'warn' : 'pass';
  const summary = status === 'fail'
    ? 'Accessibility issues that block some readers — fix before sending.'
    : status === 'warn'
      ? 'Mostly accessible, with advisories to review.'
      : 'Passes the automated accessibility checks (alt text, AA contrast, headings).';
  return { ok: true, status, summary, checks };
}

module.exports = { auditAccessibility, contrast, checkContrast, checkAltText, checkHeadings };
