'use strict';

// Stage 2 — production-grade AMP4EMAIL generators.
//
// Matches the real in-market structure (learned from AJIO emails):
//   - <!doctype html><html amp4email data-css-strict>
//   - <meta charset> first, then v0.js, component scripts, amp4email-boilerplate,
//     then <style amp-custom>  (CSP <meta http-equiv> is REJECTED by the real
//     validator, so it is intentionally omitted — verified empirically)
//   - table-based, 600px fixed-width, responsive amp-img
//   - amp-bind state machines; interactive "buttons" as absolutely-positioned
//     tap zones over a base image (role=button, tabindex, on="tap:...")
//   - amp-form + action-xhr for data capture, reading event.response into state
//   - all non-ASCII as HTML entities (handled by enc / formatPrice)
//
// Assets arrive already resolved + HTTPS from server/assets.js.

const { enc, formatPrice, derivePalette } = require('./generate');
const { getContent, applyBrand, TONES } = require('./content');
const { generatedUrl } = require('./assets');
const { renderFallback, renderText, subjectFor, preheaderFor, fromNameFor } = require('./fallback');
const { auditAccessibility } = require('./accessibility');
const artdirect = require('./artdirect');
const prodtemplate = require('./prodtemplate');
const { assertContextIsSoleSource, assertProductPairing } = require('./guard');

// Fulfillment paths for the Pay-in-mail (UPI) module (Remediation Phase 4).
// AMP4EMAIL is the INTERACTION layer only — none of these collect a delivery
// address inside the email; address collection (where needed) happens externally.
//   sender_known   — receiver address already on file; claim link goes to sender
//   self_claim     — shareable gift link; receiver self-claims + adds address externally
//   digital_voucher— digital SKU delivered by email; no address step at all
const FULFILLMENT_PATHS = ['sender_known', 'self_claim', 'digital_voucher'];

// ---- seeded rng (deterministic re-rolls) -----------------------------------
function hashSeed(str) { let h = 1779033703 ^ String(str).length; for (let i = 0; i < String(str).length; i++) { h = Math.imul(h ^ String(str).charCodeAt(i), 3432918353); h = (h << 13) | (h >>> 19); } return h >>> 0; }
function mulberry32(a) { return function () { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function pick(rng, arr) { return arr[Math.floor(rng() * arr.length)]; }

// ---- component script registry ---------------------------------------------
const SCRIPTS = {
  'amp-bind': 'https://cdn.ampproject.org/v0/amp-bind-0.1.js',
  'amp-form': 'https://cdn.ampproject.org/v0/amp-form-0.1.js',
  'amp-carousel': 'https://cdn.ampproject.org/v0/amp-carousel-0.1.js',
  'amp-accordion': 'https://cdn.ampproject.org/v0/amp-accordion-0.1.js',
  'amp-anim': 'https://cdn.ampproject.org/v0/amp-anim-0.1.js',
  'amp-list': 'https://cdn.ampproject.org/v0/amp-list-0.1.js',
};
function scriptTag(name) {
  return `<script async custom-element="${name}" src="${SCRIPTS[name]}"><\/script>`;
}

// ---- shell -----------------------------------------------------------------
function prodShell({ components, css, body }) {
  const comps = Array.from(new Set(['amp-bind', ...(components || [])]));
  return [
    '<!doctype html>',
    '<html amp4email data-css-strict>',
    '<head>',
    '<meta charset="utf-8">',
    '<script async src="https://cdn.ampproject.org/v0.js"><\/script>',
    ...comps.map(scriptTag),
    '<style amp4email-boilerplate>body{visibility:hidden}</style>',
    `<style amp-custom>${css}</style>`,
    '</head>',
    '<body>',
    body,
    '</body>',
    '</html>',
  ].join('\n');
}

// ---- aesthetic registers (spec §4) -----------------------------------------
// Every brand renders to its own register, derived from the resolved brand
// aesthetic. 'playful' IS the original house template (the default), so brands
// without a distinct aesthetic look exactly as before. luxury/minimal restrain
// type, spacing and CTA and suppress loud discount blocks; fintech/bold tune
// weight and emphasis. These knobs are baked into baseCss + the modules.
const AESTHETICS = {
  playful: {
    bodyFont: 'Arial, Helvetica, sans-serif', headFont: 'Arial, Helvetica, sans-serif',
    headSize: '20px', headWeight: 'bold', headLetter: 'normal', headTransform: 'none', headAlign: 'left', headPad: '20px 24px',
    pad: '24px', footPad: '18px 24px',
    btnFill: 'solid', btnRadius: '8px', btnWeight: 'bold', btnLetter: 'normal', btnTransform: 'none', btnPad: '13px 26px',
    leadSize: '32px', leadWeight: 'bold', code: 'dashed', showDiscount: true, cta: 'Reveal my offer',
  },
  bold: {
    bodyFont: '"Helvetica Neue", Arial, sans-serif', headFont: '"Helvetica Neue", Arial, sans-serif',
    headSize: '22px', headWeight: 'bold', headLetter: 'normal', headTransform: 'none', headAlign: 'left', headPad: '22px 24px',
    pad: '24px', footPad: '18px 24px',
    btnFill: 'solid', btnRadius: '10px', btnWeight: 'bold', btnLetter: '0.04em', btnTransform: 'uppercase', btnPad: '14px 28px',
    leadSize: '34px', leadWeight: 'bold', code: 'dashed', showDiscount: true, cta: 'Unlock my reward',
  },
  fintech: {
    bodyFont: '"Helvetica Neue", Arial, sans-serif', headFont: '"Helvetica Neue", Arial, sans-serif',
    headSize: '20px', headWeight: 'bold', headLetter: 'normal', headTransform: 'none', headAlign: 'left', headPad: '22px 24px',
    pad: '26px 24px', footPad: '18px 24px',
    btnFill: 'solid', btnRadius: '8px', btnWeight: 'bold', btnLetter: 'normal', btnTransform: 'none', btnPad: '13px 26px',
    leadSize: '30px', leadWeight: 'bold', code: 'dashed', showDiscount: true, cta: 'View my offer',
  },
  minimal: {
    bodyFont: '"Helvetica Neue", Arial, sans-serif', headFont: '"Helvetica Neue", Arial, sans-serif',
    headSize: '16px', headWeight: 'normal', headLetter: '0.14em', headTransform: 'uppercase', headAlign: 'center', headPad: '26px 24px',
    pad: '32px 30px', footPad: '26px 30px',
    btnFill: 'outline', btnRadius: '2px', btnWeight: 'bold', btnLetter: '0.12em', btnTransform: 'uppercase', btnPad: '13px 30px',
    leadSize: '26px', leadWeight: 'normal', code: 'thin', showDiscount: false, cta: 'Shop the edit',
  },
  luxury: {
    bodyFont: 'Georgia, "Times New Roman", serif', headFont: 'Georgia, "Times New Roman", serif',
    headSize: '18px', headWeight: 'normal', headLetter: '0.2em', headTransform: 'uppercase', headAlign: 'center', headPad: '28px 24px',
    pad: '36px 30px', footPad: '28px 30px',
    btnFill: 'solid', btnRadius: '0', btnWeight: 'normal', btnLetter: '0.18em', btnTransform: 'uppercase', btnPad: '15px 34px',
    leadSize: '26px', leadWeight: 'normal', code: 'thin', showDiscount: false, cta: 'Discover the collection',
  },
};
function aesProfile(name) { return AESTHETICS[name] || AESTHETICS.playful; }

// relative luminance -> readable text colour (white on dark, ink on light)
function lumOf(hex) {
  const h = String(hex || '').replace('#', '');
  if (h.length < 6) return 0.5;
  const ch = (i) => { const c = parseInt(h.slice(i, i + 2), 16) / 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  return 0.2126 * ch(0) + 0.7152 * ch(2) + 0.0722 * ch(4);
}
function onColor(hex) { return lumOf(hex) > 0.55 ? '#1a1a1a' : '#ffffff'; }
function cap(s) { return String(s || '').charAt(0).toUpperCase() + String(s || '').slice(1); }

// ---- base CSS (palette + aesthetic baked; strict-safe: no :root/var/!important) ----
function baseCss(p, A) {
  A = A || AESTHETICS.playful;
  const headInk = onColor(p.primary);
  const btn = A.btnFill === 'outline'
    ? `background:#ffffff;color:${p.primary};border:1px solid ${p.primary};`
    : `background:${p.primary};color:${headInk};border:0;`;
  const codeCss = A.code === 'thin'
    ? `border:1px solid ${p.line};color:${p.ink};letter-spacing:5px;border-radius:0;`
    : `border:2px dashed ${p.accent};color:${p.primary};letter-spacing:2px;border-radius:8px;`;
  const leadLetter = A.headTransform === 'uppercase' ? '0.06em' : 'normal';
  return [
    'body{margin:0;padding:0;background:#eef0f3;}',
    'table{border-collapse:collapse;}',
    'img{border:0;display:block;}',
    '.outer{background:#eef0f3;}',
    '.outercell{padding:18px 12px;}',
    `.w600{width:100%;max-width:600px;background:#ffffff;font-family:${A.bodyFont};color:${p.ink};}`,
    `.head{background:${p.primary};padding:${A.headPad};text-align:${A.headAlign};}`,
    `.h1{margin:0;font-size:${A.headSize};line-height:1.35;color:${headInk};font-weight:${A.headWeight};letter-spacing:${A.headLetter};text-transform:${A.headTransform};font-family:${A.headFont};}`,
    `.pad{padding:${A.pad};}`,
    '.center{text-align:center;}',
    `.foot{padding:${A.footPad};border-top:1px solid ${p.line};color:#9aa0a6;font-size:11px;line-height:1.7;text-align:${A.headAlign};}`,
    `.btn{display:inline-block;${btn}text-decoration:none;padding:${A.btnPad};border-radius:${A.btnRadius};font-weight:${A.btnWeight};font-size:14px;letter-spacing:${A.btnLetter};text-transform:${A.btnTransform};cursor:pointer;font-family:${A.bodyFont};}`,
    `.btnA{background:${p.accent};color:${onColor(p.accent)};border:0;}`,
    `.code{display:inline-block;${codeCss}font-weight:bold;padding:9px 18px;font-size:18px;}`,
    '.db{display:block;}', '.dn{display:none;}', '.rel{position:relative;}',
    `.lead{font-size:${A.leadSize};font-weight:${A.leadWeight};color:${p.primary};margin:0 0 6px;letter-spacing:${leadLetter};}`,
    '.logobox{display:inline-block;background:#ffffff;border-radius:6px;padding:7px 12px;margin:0 0 14px;line-height:0;}',
    '.logobox img{object-fit:contain;}',
    '.sub{color:#6b6b7b;font-size:13px;margin:0;line-height:1.6;}',
    '.pcell{padding:6px;}',
    `.pname{font-size:13px;font-weight:bold;margin:8px 0 2px;color:${p.ink};}`,
    `.pprice{font-size:14px;font-weight:bold;color:${p.primary};}`,
    '.soc{color:#9aa0a6;text-decoration:none;font-weight:bold;}',
    '.dot{color:#c4c4cc;margin:0 7px;}',
    '.socrow{margin:0 0 9px;}.fmsg{margin:0 0 7px;}.fcopy{margin:0 0 4px;color:#b6b6c0;}.funsub{margin:2px 0 0;}',
  ].join('');
}

// ---- helpers ---------------------------------------------------------------
// The resolved logo / aesthetic / footer / brand for the email currently being
// built. Set by buildProduction immediately before mod.build() (which is fully
// synchronous), so every module's headRow/footRow render consistently without
// threading them through ~30 call sites. Reset after each build.
let _activeLogo = null;
let _activeAes = AESTHETICS.playful;
let _activeFooter = null;
let _activeBrand = '';
// Part A — the header and footer are now art-directed sections composed by
// buildProduction (server/artdirect.js), so the module's headRow/footRow no
// longer emit chrome. Instead they CAPTURE the headline + footer line the module
// intended, so the hero can show the module's own headline and nothing is lost.
// (Modules are unchanged — they still call headRow(head)+…+footRow(msg).)
let _capturedHead = null;
let _capturedFootMsg = null;

function ampImg(a, o = {}) {
  const w = o.width || a.width, h = o.height || a.height;
  return `<amp-img src="${a.url}" width="${w}" height="${h}" layout="${o.layout || 'responsive'}" alt="${enc(o.alt || a.name || '')}"${o.cls ? ` class="${o.cls}"` : ''}></amp-img>`;
}
// Mechanic-only contract: capture the module's headline (becomes the hero h1)
// and emit no row — the single <h1> now lives in the art-directed hero.
function headRow(text) { if (text) _capturedHead = text; return ''; }
// Capture the module's terms/footer line; the full branded footer is composed
// separately. Returns no row.
function footRow(text) { if (text) _capturedFootMsg = text; return ''; }
function productGrid(products, currency) {
  const cells = products.slice(0, 2).map((prod) =>
    `<td width="50%" valign="top" class="pcell"><table role="presentation" width="100%"><tr><td>${ampImg(prod, { width: 300, height: 200, alt: prod.name })}</td></tr>` +
    `<tr><td><div class="pname">${enc(prod.name)}</div><div class="pprice">${formatPrice(prod.price, currency)}</div></td></tr></table></td>`
  ).join('');
  return `<table role="presentation" width="100%"><tr>${cells}</tr></table>`;
}

// ---- modules ---------------------------------------------------------------
const MODULES = {
  // Tap to Reveal -----------------------------------------------------------
  reveal: {
    name: 'Tap to Reveal Offer', kind: 'tap-to-reveal',
    build(ctx) {
      const { p, currency, products, copy, rng, aes } = ctx;
      const A = aes || AESTHETICS.playful;
      let teaser, revealed, footMsg, head;
      if (A.showDiscount) {
        // value / playful / fintech / bold — the coupon-led reward
        const discount = copy.discount || pick(rng, [10, 15, 20, 25]);
        const code = copy.code || 'REVEAL' + discount;
        head = copy.head || 'A reward is waiting behind the curtain';
        teaser =
          `<p class="lead">${discount}% OFF</p>` +
          `<p class="sub">A hand-picked reward is hidden below. Tap to reveal it.</p>` +
          `<div class="btn" style="margin-top:16px" role="button" tabindex="0" on="tap:AMP.setState({g:{revealed:true}})">${enc(A.cta)}</div>`;
        revealed =
          `<p class="sub">Use this code at checkout</p>` +
          `<div class="code" style="margin:10px 0 18px">${enc(code)}</div>` +
          productGrid(products, currency);
        footMsg = 'One reward per customer. Terms apply.';
      } else {
        // luxury / minimal — editorial, understated; no loud discount block
        head = copy.head || 'An invitation, just for you';
        teaser =
          `<p class="lead">The new edit</p>` +
          `<p class="sub">A private preview of the season, chosen with you in mind. Tap to view the pieces.</p>` +
          `<div class="btn" style="margin-top:20px" role="button" tabindex="0" on="tap:AMP.setState({g:{revealed:true}})">${enc(A.cta)}</div>`;
        revealed =
          `<p class="sub" style="margin-bottom:18px">Your preview of the collection</p>` +
          productGrid(products, currency) +
          `<p class="sub" style="margin-top:18px">Complimentary shipping and returns on every order.</p>`;
        footMsg = 'A members-only preview, with our compliments.';
      }
      const rows =
        headRow(head) +
        `<tr><td class="pad center">` +
        `<div [class]="g.revealed ? 'dn' : 'db'">${teaser}</div>` +
        `<div class="dn" [class]="g.revealed ? 'db' : 'dn'">${revealed}</div>` +
        `</td></tr>`;
      return { rows: rows + footRow(footMsg), css: '', components: [], state: { revealed: false } };
    },
  },

  // Spin the Wheel ----------------------------------------------------------
  spin: {
    name: 'Spin the Wheel', kind: 'spin-to-win',
    build(ctx) {
      const { p, copy, rng, logo } = ctx;
      const pct = copy.pct || pick(rng, [15, 20, 25, 30]);
      const code = copy.code || 'SPIN' + pct;
      const head = copy.head || 'Give the wheel a spin';
      const wheel = { url: generatedUrl('SPIN', 360, 360, p, 'logo'), width: 360, height: 360, name: 'Prize wheel' };
      const css =
        '.wheelbox{max-width:240px;margin:0 auto 16px;}' +
        '.spinner{transition:transform 2.6s cubic-bezier(.15,.6,.3,1.2);}' +
        '.spinner.go{transform:rotate(1080deg);}' +
        `.reward{background:${p.tint};border-radius:12px;padding:20px;margin-top:12px;}`;
      const rows =
        headRow(head) +
        `<tr><td class="pad center">` +
        `<div class="wheelbox"><div class="spinner" [class]="g.spun ? 'spinner go' : 'spinner'">${ampImg(wheel, { width: 360, height: 360, alt: 'Prize wheel' })}</div></div>` +
        `<div [class]="g.spun ? 'dn' : 'db'">` +
        `<p class="sub">One spin, one reward. Ready?</p>` +
        `<div class="btn btnA" style="margin-top:10px" role="button" tabindex="0" on="tap:AMP.setState({g:{spun:true}})">Spin to win</div>` +
        `</div>` +
        `<div class="reward dn" [class]="g.spun ? 'reward db' : 'reward dn'">` +
        `<p class="lead" style="font-size:24px">You won ${pct}% off!</p>` +
        `<p class="sub" style="margin-bottom:10px">Apply this code before it disappears.</p>` +
        `<div class="code">${enc(code)}</div>` +
        `</div>` +
        `</td></tr>`;
      return { rows: rows + footRow('One reward per customer. Terms apply.'), css, components: [], state: { spun: false } };
    },
  },

  // Scratch Card ------------------------------------------------------------
  scratch: {
    name: 'Scratch Card', kind: 'scratch-card',
    build(ctx) {
      const { p, copy, rng } = ctx;
      const pct = copy.pct || pick(rng, [10, 20, 30, 40]);
      const code = copy.code || 'SCRATCH' + pct;
      const head = copy.head || 'Scratch to unwrap your surprise';
      const css =
        '.card{position:relative;max-width:340px;margin:0 auto;height:180px;border-radius:14px;overflow:hidden;}' +
        `.prize{position:absolute;top:0;left:0;right:0;bottom:0;background:${p.tint};text-align:center;padding-top:46px;box-sizing:border-box;}` +
        `.cover{position:absolute;top:0;left:0;right:0;bottom:0;background:${p.accent};color:#ffffff;text-align:center;padding-top:64px;box-sizing:border-box;cursor:pointer;transition:opacity .6s;font-weight:bold;font-size:18px;}` +
        '.cover.gone{opacity:0;}';
      const rows =
        headRow(head) +
        `<tr><td class="pad center">` +
        `<div class="card">` +
        `<div class="prize"><p class="lead" style="font-size:26px">${pct}% OFF</p><div class="code">${enc(code)}</div></div>` +
        `<div class="cover" [class]="g.scratched ? 'cover gone' : 'cover'" role="button" tabindex="0" on="tap:AMP.setState({g:{scratched:true}})">Tap to scratch &amp; reveal</div>` +
        `</div>` +
        `<p class="sub" style="margin-top:14px" [text]="g.scratched ? 'Code unlocked — copy it before checkout.' : 'Your prize is hidden under the foil.'">Your prize is hidden under the foil.</p>` +
        `</td></tr>`;
      return { rows: rows + footRow('One scratch per customer. Terms apply.'), css, components: [], state: { scratched: false } };
    },
  },

  // Multi-frame Tap Game (penalty shootout) ---------------------------------
  game: {
    name: 'Penalty Shootout', kind: 'tap-game',
    build(ctx) {
      const { p, copy, endpoint } = ctx;
      const head = copy.head || 'Take your penalties — win the prize';
      const keepers = ['M', 'R', 'L']; // baked keeper dive per round
      // Art-directed penalty scene composed entirely in validator-safe CSS
      // (grass + mowing stripes, goal frame + net, brand-kit keeper, three aim
      // targets, ball on the spot) — no flat placeholder image.
      const css =
        '.frame{}' +
        '.field{max-width:440px;margin:0 auto;position:relative;}' +
        '.pitch{position:relative;height:300px;border-radius:14px;overflow:hidden;background-color:#246b43;background-image:radial-gradient(120% 90% at 50% -12%, #348c58 0%, #246b43 55%, #1a5233 100%),repeating-linear-gradient(90deg, rgba(255,255,255,.05) 0 38px, rgba(0,0,0,.05) 38px 76px);}' +
        '.gbar{position:absolute;top:20px;left:15%;right:15%;height:7px;background:#f3f6f8;border-radius:4px;}' +
        '.gpost{position:absolute;top:20px;width:7px;height:120px;background:#f3f6f8;border-radius:4px;}' +
        '.gpostL{left:15%;}.gpostR{right:15%;}' +
        '.gnet{position:absolute;top:27px;left:17%;right:17%;height:106px;background-color:rgba(255,255,255,.05);background-image:repeating-linear-gradient(90deg, rgba(255,255,255,.16) 0 1px, transparent 1px 13px),repeating-linear-gradient(0deg, rgba(255,255,255,.16) 0 1px, transparent 1px 13px);}' +
        `.keeper{position:absolute;top:64px;left:50%;width:30px;height:62px;margin-left:-15px;border-radius:14px 14px 8px 8px;background:linear-gradient(180deg, ${p.primary} 0%, ${p.primaryDark || '#10182a'} 100%);box-shadow:0 6px 12px rgba(0,0,0,.3);}` +
        '.aim{position:absolute;top:44px;width:44px;height:44px;border-radius:50%;border:2px dashed rgba(255,255,255,.6);}' +
        '.aimL{left:21%;}.aimM{left:50%;margin-left:-22px;}.aimR{right:21%;}' +
        '.ball{position:absolute;bottom:22px;left:50%;width:34px;height:34px;margin-left:-17px;border-radius:50%;background:radial-gradient(circle at 36% 30%, #ffffff 0%, #ededf2 58%, #cdcdd6 100%);box-shadow:0 7px 14px rgba(0,0,0,.32);}' +
        '.gz{position:absolute;top:0;height:100%;width:33.34%;cursor:pointer;}' +
        '.gzL{left:0;}.gzM{left:33.33%;}.gzR{left:66.66%;}' +
        `.hint{color:#6b6b7b;font-size:13px;margin:12px 0 0;}` +
        `.scorebig{font-size:30px;font-weight:bold;color:${p.primary};margin:6px 0;}` +
        `.inp{width:100%;box-sizing:border-box;padding:11px;border:1px solid ${p.line};border-radius:8px;margin:8px 0;}`;
      const goalScene =
        '<div class="pitch">' +
        '<div class="gnet"></div>' +
        '<div class="gbar"></div><div class="gpost gpostL"></div><div class="gpost gpostR"></div>' +
        '<div class="keeper"></div>' +
        '<div class="aim aimL"></div><div class="aim aimM"></div><div class="aim aimR"></div>' +
        '<div class="ball"></div>' +
        '</div>';
      const zone = (n, z) => {
        const keeper = keepers[n];
        const add = keeper === z ? 0 : 1; // goal when keeper dives elsewhere
        return `<div class="gz gz${z}" role="button" tabindex="0" on="tap:AMP.setState({g:{shot:g.shot+1,score:g.score+${add}}})"></div>`;
      };
      const frame = (n) =>
        `<div class="${n === 0 ? 'frame' : 'frame dn'}" [class]="g.shot == ${n} ? 'frame db' : 'frame dn'">` +
        `<div class="field rel">${goalScene}${zone(n, 'L')}${zone(n, 'M')}${zone(n, 'R')}</div>` +
        `<p class="hint">Round ${n + 1} of 3 — tap left, centre, or right to shoot.</p>` +
        `</div>`;
      const result =
        `<div class="frame dn" [class]="g.shot &gt;= 3 ? 'frame db' : 'frame dn'">` +
        `<p class="sub">You scored</p>` +
        `<p class="scorebig"><span [text]="g.score">0</span> / 3</p>` +
        `<p class="sub" style="margin-bottom:10px" [text]="g.score &gt;= 3 ? 'Hat-trick hero! Unlock 30% off.' : (g.score == 2 ? 'Sharp shooting! Unlock 20% off.' : (g.score == 1 ? 'On the board! Unlock 10% off.' : 'So close — here is 5% to try again.'))">Play to unlock your reward.</p>` +
        `<div class="code" [text]="g.score &gt;= 3 ? 'GOAL30' : (g.score == 2 ? 'GOAL20' : (g.score == 1 ? 'GOAL10' : 'GOAL05'))">GOAL10</div>` +
        `<form method="post" action-xhr="${endpoint}" on="submit-success:AMP.setState({g:{claimed:true}})">` +
        `<input class="inp" type="email" name="email" placeholder="Email me this code" required>` +
        `<input type="hidden" name="score" value="0" [value]="g.score">` +
        `<input type="submit" class="btn btnA" value="Claim reward">` +
        `</form>` +
        `<p class="sub dn" [class]="g.claimed ? 'sub db' : 'sub dn'">Sent! Check your inbox.</p>` +
        `</div>`;
      const rows =
        headRow(head) +
        `<tr><td class="pad center">${frame(0)}${frame(1)}${frame(2)}${result}</td></tr>`;
      return { rows: rows + footRow('One game per customer. Terms apply.'), css, components: ['amp-form'], state: { shot: 0, score: 0, claimed: false } };
    },
  },
};

// ---- broaden the library (Stage 2 · step 3) --------------------------------
Object.assign(MODULES, require('./modules-extra')({
  ampImg, headRow, footRow, productGrid, enc, formatPrice, pick, generatedUrl,
}));

// ---- assemble --------------------------------------------------------------
const PRICES = [799, 1199, 1599, 1999, 2499, 2999];

// Benefit/trust trio for the icon row when the brand library doesn't supply one.
// Vertical-appropriate so a Food brand doesn't advertise "Free returns".
const BENEFITS = {
  Fashion: [{ label: 'Free shipping', short: 'Ship' }, { label: 'Easy 15-day returns', short: 'Return' }, { label: 'Secure checkout', short: 'Secure' }],
  Food: [{ label: 'Fast delivery', short: 'Fast' }, { label: 'Fresh ingredients', short: 'Fresh' }, { label: 'Live order tracking', short: 'Track' }],
  Finance: [{ label: 'RBI-regulated', short: 'Safe' }, { label: 'Instant approval', short: 'Instant' }, { label: 'No hidden fees', short: 'Clear' }],
  Beauty: [{ label: 'Cruelty-free', short: 'Kind' }, { label: 'Dermat-tested', short: 'Tested' }, { label: 'Free samples', short: 'Gift' }],
  Electronics: [{ label: 'Brand warranty', short: 'Warranty' }, { label: 'Easy EMI', short: 'EMI' }, { label: 'Free installation', short: 'Setup' }],
  Travel: [{ label: 'Best price promise', short: 'Price' }, { label: 'Free cancellation', short: 'Flexible' }, { label: '24x7 support', short: 'Support' }],
  Generic: [{ label: 'Trusted brand', short: 'Trust' }, { label: 'Fast support', short: 'Support' }, { label: 'Secure & private', short: 'Secure' }],
};
function defaultBenefits(vertical) { return BENEFITS[vertical] || BENEFITS.Generic; }

function buildProduction(opts) {
  const resolved = opts.resolved;
  if (!resolved || !resolved.palette) throw new Error('buildProduction requires a resolved asset set');
  const p = resolved.palette.primary ? derivePalette(resolved.palette.primary) : resolved.palette;
  if (resolved.palette.accent) p.accent = resolved.palette.accent;
  const brand = resolved.brand || {};
  const brandName = brand.name || 'Acme';
  const currency = opts.currency || brand.currency || 'INR';
  const vertical = brand.vertical || 'Generic';
  const tone = brand.tone || 'Playful';
  // Aesthetic register (spec §4) — drives type, spacing, CTA tone and whether a
  // loud discount block is appropriate. Unknown brands default to 'playful' (the
  // original house look), so nothing regresses.
  //   IDENTITY-FIRST: a brand's OWN resolved aesthetic always wins. Only when the
  //   client supplies none does a FORM hint (opts.aesthetic, derived by the
  //   Vertical Reference System from a brand-agnostic LayoutSkeleton) fill in —
  //   the reference supplies form, never identity.
  const aesName = brand.aesthetic || opts.aesthetic || 'playful';
  const A = aesProfile(aesName);
  // The chosen use case is a hard input: normalise to a real module key so the
  // context, the AMP and the preview can never disagree on which module ran.
  const moduleId = MODULES[opts.moduleId] ? opts.moduleId : 'reveal';
  // Fulfillment path (Remediation Phase 4) — a first-class GenerationContext flag
  // for the Pay-in-mail (UPI) module. Normalise to one of the three supported
  // values so the module, the context and the success-state copy can never
  // disagree. Default is the most conservative (address already on file).
  const fulfillmentPath = FULFILLMENT_PATHS.includes(opts.fulfillmentPath) ? opts.fulfillmentPath : 'sender_known';
  const seed = mulberry32(hashSeed(`${brandName}|${moduleId}|${opts.reroll || 0}`));

  // Resolved products (same order + URLs the provenance list shows). The asset
  // `tier` is carried through so the art-directed hero can tell a real photo
  // (brand-site / web stock) from a generated flat placeholder.
  const products = (resolved.assets.products || []).map((a, i) => ({
    url: a.url, width: a.width, height: a.height, tier: a.tier,
    name: a.name || `Item ${i + 1}`,
    // product-page deep link + sku + real-SKU flag, carried from the asset layer
    // so modules (wishlist/cart/strip) can link to the EXACT product.
    link: a.link || null, sku: a.sku || null, real: !!a.real,
    // Price honesty: explicit copy price wins; else the resolved same-record
    // price; else — for a REAL SKU whose source exposed no price — stay null
    // (rendered as "on site"), NEVER the PRICES ladder. Only non-real
    // placeholders fall back to the ladder so the demo still reads complete.
    price: (opts.copy && opts.copy.prices && opts.copy.prices[i] != null)
      ? opts.copy.prices[i]
      : (a.price != null ? a.price
        : (a.real ? null : PRICES[i % PRICES.length])),
  }));
  const logo = resolved.assets.logo || null;
  const hero = resolved.assets.hero || null;

  // Brand + vertical content — the single copy source both renderers read, so a
  // Food brand polls about food, not "Sneakers vs Boots".
  const raw = getContent(vertical);
  const content = {
    vertical,
    items: products,
    poll: { q: applyBrand(raw.poll.q, brandName), a: raw.poll.a, b: raw.poll.b },
    quiz: { q: applyBrand(raw.quiz.q, brandName), options: raw.quiz.options.map((o) => ({ label: o.label, result: applyBrand(o.result, brandName) })) },
    rate: applyBrand(raw.rate, brandName),
  };
  // Tone-aware default headline per module (an explicit user copy.head wins).
  const T = TONES[tone] || TONES.Playful;
  const HEAD = { reveal: T.reveal, spin: T.spin, search: T.search, quiz: content.quiz.q, poll: content.poll.q, rating: T.rate };
  const copy = Object.assign({}, opts.copy);
  if (!copy.head && HEAD[moduleId]) copy.head = applyBrand(HEAD[moduleId], brandName);

  const mod = MODULES[moduleId];
  const footer = brand.footer || null;
  const ctx = { p, brand, brandName, currency, vertical, tone, aes: A, aesName, footer, products, logo, hero, content, copy, fulfillmentPath, endpoint: opts.endpoint || 'https://amp.example.com/submit', rng: seed };

  // Build the interactive mechanic. headRow/footRow now CAPTURE the module's
  // intended headline + terms line (see above) rather than emit chrome.
  _activeLogo = logo; _activeAes = A; _activeFooter = footer; _activeBrand = brandName;
  _capturedHead = null; _capturedFootMsg = null;
  let built;
  try { built = mod.build(ctx); }
  finally { _activeLogo = null; _activeAes = AESTHETICS.playful; _activeFooter = null; _activeBrand = ''; }

  // The hero surfaces the module's headline (explicit user copy wins, then the
  // module's own head, then a brand default). The module's terms line rides into
  // the branded footer.
  copy.head = copy.head || _capturedHead || `${brandName}, just for you`;
  ctx.terms = _capturedFootMsg || null;
  _capturedHead = null; _capturedFootMsg = null;

  // Compose the complete, PRODUCTION-SHAPED creative AROUND the mechanic via the
  // production template engine (server/prodtemplate.js). This is the real
  // in-market AMP4EMAIL grammar, learned from the Bajaj Finserv reference + the
  // NetCore corpus, not a CSS-shape approximation:
  //   preload block → open-track amp-list → [ header(logo+greeting) → hero image
  //   + image CTA → benefit icons → mechanic → product strip → lead-capture
  //   amp-form state machine → promo → branded footer ] → click_form
  // Every chrome CTA fires click_form.submit; forms carry merge tokens + hidden
  // tracking inputs; the head ships the ⚡4email glyph, full CSP and a webfont
  // declaration. All sections read the same ctx, so brand, palette, products and
  // copy can never disagree with the mechanic or the preview.
  const benefits = (brand.benefits && brand.benefits.length)
    ? brand.benefits
    : defaultBenefits(vertical);
  const apiBase = opts.apiBase || 'https://amp.example.com/api';
  const clientName = String(opts.clientName || `${brandName}_${moduleId}`).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
  const assembled = prodtemplate.assembleProduction({
    p, A, aesName, brandName, currency,
    products, logo, hero, copy,
    terms: ctx.terms, footerInfo: footer, promo: brand.promo, benefits,
    built, kind: mod.kind,
    moduleBaseCss: baseCss(p, A),
    leadEndpoint: opts.endpoint || `${apiBase}/lead`,
    clickEndpoint: opts.clickEndpoint || `${apiBase}/event`,
    openEndpoint: opts.openEndpoint || `${apiBase}/open`,
    clientName,
    // FORM hint: the brand-agnostic LayoutSkeleton drives section ORDER only.
    // Every concrete value rendered into those sections still comes from ctx.
    form: opts.form || null,
  });
  const ampHtml = assembled.ampHtml;

  // Phase 1.2 — the static cross-client layer, built from the SAME ctx. Every
  // generation emits three MIME bodies (text/plain, on-brand text/html, AMP) so
  // Outlook and other non-AMP clients render a real email, never a stub. Derived
  // here (not in the route) so preview, dispatch and download all agree.
  const meta = { moduleName: mod.name, kind: mod.kind };
  const email = { subject: subjectFor(ctx), preheader: preheaderFor(ctx), fromName: fromNameFor(ctx) };
  const htmlFallback = renderFallback(ctx, meta);
  const textFallback = renderText(ctx, meta);

  // The single GenerationContext that produced this email. The live preview
  // renders `ampHtml` directly, so preview, AMP code and this context are
  // guaranteed to reference the same assets, module and palette.
  const context = {
    brand: { name: brandName, voice: brand.voice || null, currency, vertical, tone, aesthetic: aesName, source: brand.source },
    palette: { primary: p.primary, primaryDark: p.primaryDark, accent: p.accent, tint: p.tint, ink: p.ink, line: p.line, background: '#ffffff' },
    module: moduleId, moduleName: mod.name, kind: mod.kind,
    vertical, tone, aesthetic: aesName,
    // Fulfillment path (Phase 4) — a first-class GenerationContext flag. The
    // Pay-in-mail module reads THIS to pick its interaction + success-state copy.
    fulfillment_path: fulfillmentPath,
    content,
    footer,
    email,
    assets: (resolved.provenance || []).map((a) => ({ slot: a.slot, url: a.url, tier: a.tier, source: a.source, alt: a.name, width: a.width, height: a.height, license: a.license, rights: a.rights, licenseNote: a.licenseNote })),
    // FORM, not identity. The brand-agnostic LayoutSkeleton (section order/count,
    // copy cadence, type/palette ROLE directives) that shaped this email rides in
    // the single GenerationContext, so preview and AMP read the same plan. It is
    // already assertAbstract()-clean — counts/booleans/vocab tokens only, never a
    // colour/url/font/copy string from any reference email.
    form: opts.form || null,
  };

  // MAIN-PATH BRAND-BLEED GUARD (Remediation Phase 1). Fail loudly, right here in
  // the primary generator, if any chromatic brand colour in the finished email is
  // NOT owned by this GenerationContext — the "#2c4152 for everyone" bug class.
  // This runs on EVERY build (the web UI's /build path included), not just the
  // reference-aware /build-vertical route. It never silently substitutes: a leak
  // throws so the wrong brand's colour can never ship.
  assertContextIsSoleSource(ampHtml, context);
  // PRODUCT PAIRING GUARD (Remediation Phase 3). Every rendered product image
  // must carry the label of the SAME GenerationContext product entry — an image
  // can never be zipped to a different product's name.
  assertProductPairing(ampHtml, context);

  // Accessibility runs on every build (cheap + synchronous) from the same ctx,
  // so the report can never drift from the email that ships. Network-bound
  // checks (deliverability DNS, image weighing) stay on-demand instead.
  const accessibility = auditAccessibility({ ampHtml, context });

  return {
    ampHtml, htmlFallback, textFallback,
    subject: email.subject, preheader: email.preheader, fromName: email.fromName,
    moduleId, moduleName: mod.name, kind: mod.kind, brand, palette: p, currency, context, accessibility,
  };
}

const PROD_MODULE_IDS = Object.keys(MODULES);

// ---- auto module selection (when the user picks "Auto") --------------------
const AUTO_BY_VERTICAL = {
  Fashion: ['reveal', 'spin', 'carousel', 'quiz', 'flip'],
  Food: ['spin', 'scratch', 'poll', 'reveal', 'game'],
  Finance: ['sip', 'emi', 'upi', 'points', 'quiz', 'nps'],
  Beauty: ['quiz', 'reveal', 'rating', 'carousel', 'scratch'],
  Electronics: ['search', 'carousel', 'reveal', 'rating', 'cart'],
  Travel: ['reveal', 'poll', 'appointment', 'scratch', 'survey'],
  Generic: ['reveal', 'spin', 'quiz', 'poll', 'rating'],
};
function chooseModule(vertical, seedStr) {
  const list = AUTO_BY_VERTICAL[vertical] || AUTO_BY_VERTICAL.Generic;
  const rng = mulberry32(hashSeed(seedStr || vertical || 'auto'));
  return list[Math.floor(rng() * list.length)];
}

module.exports = { buildProduction, MODULES, PROD_MODULE_IDS, chooseModule, AUTO_BY_VERTICAL };
