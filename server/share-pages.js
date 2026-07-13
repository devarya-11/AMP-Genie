'use strict';

// Server-rendered public share pages: /b/<id> for a persisted build, /s/<id>
// for a slate. These are the pitch deliverable a client opens with nothing
// but the link, so unlike the app they use a light, presentation-neutral
// theme. Each phone frame embeds the build's real AMP email via
// <iframe src="/build/<id>?format=embed"> — the exact interactive markup the
// recipient's inbox renders, so a shared page and the real email can never
// drift (and the app's Live Preview tab embeds the same bytes the same way).
//
// Pure string builders, no I/O: the /b, /s and /build Pages Functions fetch
// the KV records and pass them in. Every record field that reaches the markup
// is treated as untrusted — KV contents outlive code revisions — so strings
// are escaped, colours are shape-checked and URLs are restricted to http(s)
// before interpolation.

const { enc } = require('./generate');

// enc() already escapes & < > " and entity-encodes non-ASCII; these pages
// also interpolate into single-quoted contexts, so the apostrophe must go too.
function escapeHtml(v) {
  return enc(v == null ? '' : v).replace(/'/g, '&#39;');
}

function str(v, fallback = '') {
  return (typeof v === 'string' && v.trim()) ? v.trim() : fallback;
}

// Same guards server/fallback.js applies to its own record-fed markup
// (mirrored, not imported — fallback.js keeps them private). A colour reaching
// a style="" attribute must be a real hex literal; an <img src> must be a
// plain http(s) URL, everything else is dropped.
function safeColor(v, fallback) {
  return (typeof v === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(v.trim())) ? v.trim() : fallback;
}
const DEFAULT_PALETTE = {
  primary: '#3d4a6b',
  primaryDark: '#2c3550',
  accent: '#5b6ee1',
  tint: '#f3f3f6',
  ink: '#1d1d2b',
  line: '#e6e6ec',
};
function safePalette(p) {
  const src = (p && typeof p === 'object') ? p : {};
  const out = {};
  for (const k of Object.keys(DEFAULT_PALETTE)) out[k] = safeColor(src[k], DEFAULT_PALETTE[k]);
  return out;
}
function safeUrl(v) {
  const s = (typeof v === 'string') ? v.trim() : '';
  return /^https?:\/\/[^\s"'<>]+$/i.test(s) ? s : '';
}

// The phone frame's payload is the build's real AMP email, embedded by URL
// rather than inlined: /build/<id>?format=embed serves the exact ampHtml bytes
// inline (no attachment disposition) so the iframe renders the interactive
// email. The same-origin sandbox lets the AMP runtime boot and its scripts run
// while still isolating the frame's layout from the host page.
function ampFrame(id, title) {
  return `<iframe class="amp-frame" src="/build/${escapeHtml(id)}?format=embed"`
    + ` sandbox="allow-scripts allow-same-origin" title="${escapeHtml(title)}"></iframe>`;
}

// Only the date part of the record's ISO timestamp matters on a share page;
// slicing avoids locale/timezone variance between runtimes.
function fmtDate(ts) {
  const s = String(ts || '');
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : '';
}

// The .phone / .phone-screen bezel is copied from web/style.css rather than
// linking /style.css, which would drag the whole dark app theme onto a
// client-facing page. The amp-frame rule sizes the embedded AMP iframe to fill
// the screen; the AMP document inside the iframe brings its own styling.
const PHONE_CSS = `
.phone{margin:0 auto;width:360px;max-width:100%;background:#0d0806;border:11px solid #2b1f19;border-radius:38px;padding:11px;box-shadow:0 24px 70px -28px #00000059,0 0 0 1px #00000012}
.phone-screen{background:#fff;color:#1d1d2b;border-radius:24px;overflow:hidden;min-height:540px;max-height:600px}
.phone-screen iframe.amp-frame{display:block;width:100%;height:598px;border:0;background:#fff}
`;

// Light client-facing theme — deliberately not the app's dark dev chrome.
const PAGE_CSS = `
*{box-sizing:border-box}
body{margin:0;background:#f4f4f7;color:#1d1d2b;font-family:'Inter','Helvetica Neue',Arial,sans-serif;font-size:14px;line-height:1.45;-webkit-font-smoothing:antialiased}
.page{max-width:1120px;margin:0 auto;padding:30px 22px 44px}
.hdr{display:flex;align-items:center;gap:16px;flex-wrap:wrap;margin-bottom:24px}
.hdr .logo{display:block;height:36px;width:auto;max-width:200px}
.brand-name{font-size:23px;font-weight:800;letter-spacing:-.2px}
.hdr-meta{min-width:0}
.module-name{margin:0;font-size:15px;font-weight:700}
.slate-title{margin:0;font-size:19px;font-weight:800}
.usecase{margin:2px 0 0;font-size:12px;color:#6b6b7b}
.stage{display:flex;justify-content:center;margin:6px 0 28px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:24px;margin:6px 0 28px}
.cell-hdr{display:flex;align-items:baseline;justify-content:space-between;gap:10px;margin-bottom:10px}
.cell .usecase{margin:0;font-size:13px;font-weight:700;color:#1d1d2b}
.open{font-size:12px;font-weight:600;color:#5a5a6b}
.brief{margin:0 0 24px;border:1px solid #e6e6ec;border-radius:10px;background:#fff;padding:12px 16px}
.brief summary{cursor:pointer;font-weight:600;font-size:13px;color:#3d3d4d}
.brief p{margin:10px 0 2px;font-size:13px;line-height:1.6;color:#4a4a5a;white-space:pre-wrap}
.foot{display:flex;align-items:center;justify-content:center;gap:14px;flex-wrap:wrap;font-size:12px;color:#6b6b7b;border-top:1px solid #e6e6ec;padding-top:16px}
.badge{display:inline-block;font-size:11px;font-weight:700;letter-spacing:.4px;padding:4px 10px;border-radius:20px}
.badge.pass{background:#dff5e8;color:#177a45}
.badge.fail{background:#fdeaee;color:#b32338}
.dl{color:#1d1d2b;font-weight:600}
.nf{min-height:60vh;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;gap:8px}
.nf h1{margin:0;font-size:44px}
.nf p{margin:0;color:#6b6b7b}
` + PHONE_CSS;

function pageShell({ title, body }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title>
<style>${PAGE_CSS}</style>
</head>
<body>
<div class="page">
${body}
</div>
</body>
</html>`;
}

// Brand mark shared by both pages: a real fetched logo (when brand.js found
// one) wins over the coloured brand name; both stay inside the guard rails —
// URL http(s)-only, colour hex-only.
function brandHeader({ brand, logoUrl, primary, metaHtml }) {
  const logo = safeUrl(logoUrl);
  const mark = logo
    ? `<img class="logo" src="${escapeHtml(logo)}" alt="${escapeHtml(brand)} logo">`
    : `<span class="brand-name" style="color:${primary}">${escapeHtml(brand)}</span>`;
  return `<header class="hdr">
  ${mark}
  <div class="hdr-meta">${metaHtml}</div>
</header>`;
}

function validationBadge(validation) {
  if (!validation || typeof validation !== 'object') return '';
  if (validation.pass) return '<span class="badge pass">AMP valid &#183; PASS</span>';
  const n = Math.max(0, Math.round(Number(validation.errorCount)) || 0);
  return `<span class="badge fail">${n} validation error${n === 1 ? '' : 's'}</span>`;
}

function creditLine({ ts, author }) {
  const date = fmtDate(ts);
  const by = str(author);
  return `<span>Built with AMP Genie${date ? ' &#183; ' + date : ''}${by ? ' &#183; by ' + escapeHtml(by) : ''}</span>`;
}

function buildPageHtml(build) {
  const b = (build && typeof build === 'object') ? build : {};
  const brand = str(b.brand, 'Brand');
  const moduleName = str(b.moduleName, 'Interactive email');
  const useCase = str(b.useCase);
  const p = safePalette(b.palette);
  const id = str(b.id);
  const metaHtml = `<p class="module-name">${escapeHtml(moduleName)}</p>`
    + (useCase ? `<p class="usecase">${escapeHtml(useCase)}</p>` : '');
  const body = `${brandHeader({ brand, logoUrl: b.logoUrl, primary: p.primary, metaHtml })}
<main class="stage">
  <div class="phone"><div class="phone-screen">${ampFrame(id, `${brand} — ${moduleName}`)}</div></div>
</main>
<footer class="foot">
  ${validationBadge(b.validation)}
  <a class="dl" href="/build/${escapeHtml(id)}?format=amp" download>Download AMP</a>
  ${creditLine(b)}
</footer>`;
  return pageShell({ title: `${brand} — ${moduleName} | AMP Genie`, body });
}

function slatePageHtml(slate, builds) {
  const s = (slate && typeof slate === 'object') ? slate : {};
  const list = Array.isArray(builds) ? builds.filter((b) => b && typeof b === 'object') : [];
  const brand = str(s.brand, 'Brand');
  const title = str(s.title, `${brand} — interactive email concepts`);
  const brief = str(s.brief);
  // The slate record carries no palette of its own — the first build's is the
  // closest thing to "the brand colour this pitch was generated with".
  const p = safePalette(list.length ? list[0].palette : null);
  const cells = list.map((b) => {
    const id = str(b.id);
    const label = str(b.useCase, str(b.moduleName, 'Concept'));
    return `<section class="cell">
  <div class="cell-hdr">
    <p class="usecase">${escapeHtml(label)}</p>
    <a class="open" href="/b/${escapeHtml(id)}">open &#8599;</a>
  </div>
  <div class="phone"><div class="phone-screen">${ampFrame(id, label)}</div></div>
</section>`;
  }).join('\n');
  const metaHtml = `<p class="slate-title">${escapeHtml(title)}</p>`
    + `<p class="usecase">${list.length} interactive concept${list.length === 1 ? '' : 's'}</p>`;
  const briefBlock = brief
    ? `<details class="brief" open><summary>Campaign brief</summary><p>${escapeHtml(brief)}</p></details>\n`
    : '';
  const body = `${brandHeader({ brand, logoUrl: s.logoUrl, primary: p.primary, metaHtml })}
${briefBlock}<main class="grid">
${cells}
</main>
<footer class="foot">
  ${creditLine(s)}
</footer>`;
  return pageShell({ title: `${title} | AMP Genie`, body });
}

function notFoundPageHtml(kind) {
  const what = str(kind, 'page');
  const body = `<div class="nf">
  <h1>404</h1>
  <p>The genie searched the lamp, but no such ${escapeHtml(what)} exists.</p>
  <p>The link may be mistyped &#8212; ask whoever shared it for a fresh one.</p>
</div>`;
  return pageShell({ title: 'Not found | AMP Genie', body });
}

module.exports = { buildPageHtml, slatePageHtml, notFoundPageHtml };
