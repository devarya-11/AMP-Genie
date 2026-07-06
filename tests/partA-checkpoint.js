'use strict';

// Part A checkpoint — generate production-shaped emails through the REAL engine
// (buildProduction → prodtemplate), validate each with the REAL amphtml-validator,
// and report the structural markers that must match the production reference.
// Writes the primary sample to web/_demo/partA-<brand>.amp.html for side-by-side
// diffing against /Users/devarya/Downloads/bajaj_health_AMP.html.

const fs = require('fs');
const path = require('path');
const { buildProduction } = require('../server/build');
const { validate } = require('../server/validator');

const OUT = path.join(__dirname, '..', 'web', '_demo');
const unsplash = (id, w, h) => `https://images.unsplash.com/photo-${id}?w=${w}&h=${h}&fit=crop&q=72`;

// Inline resolved sets (no network) — exercises the real pipeline deterministically.
function resolved({ name, vertical, tone, aesthetic, currency, primary, accent, productNames, imgs, heroImg, promo, footer }) {
  const prices = [799, 1199, 1599, 1999];
  const products = productNames.map((nm, i) => ({
    slot: 'product#' + i, url: unsplash(imgs[i % imgs.length], 300, 220), width: 300, height: 220,
    name: nm, price: prices[i % prices.length], tier: 'web', source: 'stock photo', license: 'Open-web stock', rights: 'review',
  }));
  const logo = { slot: 'logo', url: '', width: 200, height: 64, name, tier: 'generated', source: 'wordmark', license: 'Generated', rights: 'clear' };
  const hero = heroImg ? { slot: 'hero', url: unsplash(heroImg, 600, 320), width: 600, height: 320, name: name + ' hero', tier: 'web', source: 'stock photo', license: 'Open-web stock', rights: 'review' } : null;
  return {
    brand: { name, vertical, tone, currency, aesthetic, voice: null, nav: [], heroTheme: null, tagline: null, promo, footer, source: 'inline-test' },
    palette: { primary, accent },
    assets: { logo, products, hero },
    provenance: [logo, ...(hero ? [hero] : []), ...products],
    summary: {},
  };
}

const SAMPLES = [
  { moduleId: 'reveal', spec: { name: 'Lyra Studio', vertical: 'Fashion', tone: 'Playful', aesthetic: 'playful', currency: 'INR', primary: '#7b2d8f', accent: '#f5a623',
      productNames: ['Linen Shirt Dress', 'Wide-Leg Trousers'], imgs: ['1490481651871-ab68de25d43d', '1539109136881-3be0616acf4b'], heroImg: '1441984904996-e0b6ba687e04',
      promo: { head: 'Festive Edit is live', sub: 'New arrivals every week' }, footer: { site: 'www.lyrastudio.com', disclaimer: 'Offer valid on full-price styles only.' } } },
  { moduleId: 'spin', spec: { name: 'Crave Kitchen', vertical: 'Food', tone: 'Bold', aesthetic: 'bold', currency: 'INR', primary: '#d2231f', accent: '#ffb703',
      productNames: ['Wood-Fired Margherita', 'Korean Fried Chicken'], imgs: ['1513104890138-7c749659a591', '1626645738196-c2a7c87a8f58'], heroImg: '1565299624946-b28f40a0ae38',
      promo: { head: 'Free delivery this weekend' }, footer: { site: 'www.cravekitchen.in' } } },
  { moduleId: 'sip', spec: { name: 'Northbank', vertical: 'Finance', tone: 'Trustworthy', aesthetic: 'fintech', currency: 'INR', primary: '#0b3d91', accent: '#27c08a',
      productNames: ['Equity Growth Fund', 'Tax Saver ELSS'], imgs: ['1554224155-6726b3ff858f', '1579621970795-87facc2f976d'], heroImg: '1556742502-ec7c0e9f34b1',
      promo: { head: 'Start a SIP from ₹500/mo' }, footer: { site: 'www.northbank.in', disclaimer: 'Mutual fund investments are subject to market risks.' } } },
];

// Structural markers that define "production-shaped" (vs the reference).
const MARKERS = [
  ['⚡4email glyph + data-css-strict', /<html ⚡4email data-css-strict>/],
  ['full CSP <meta content>', /<meta content="default-src \* data: blob:;/],
  ['webfont declared in CSP', /fonts\.googleapis\.com\/css2\?family=/],
  ['amp-form script', /custom-element="amp-form"/],
  ['amp-bind script', /custom-element="amp-bind"/],
  ['amp-list script', /custom-element="amp-list"/],
  ['amp-mustache template', /custom-template="amp-mustache"/],
  ['hidden asset preload block', /opacity:0;height:1px;width:1px;overflow:hidden/],
  ['open-track 1×1 amp-list', /<amp-list width="1" height="1"[^>]*request_form_type=AMP/],
  ['hidden click_form', /<form id="click_form"/],
  ['tap → click_form.submit', /on="tap:AMP\.setState\(\{event_type:'click'/],
  ['amp-form lead state machine', /id="lead_form"[\s\S]*responseData\.status == 'success'/],
  ['submitting loader', /<div submitting/],
  ['error block [text]=responseData.message', /\[text\]="responseData\.message"/],
  ['merge token greeting ##User name##', /Hi ##User name##/],
  ['merge token value="[NAME]"', /value="\[NAME\]"/],
  ['merge token value="[MOBILE]"', /name="mobile"[^>]*value="\[MOBILE\]"/],
  ['merge token [EMAIL]', /name="subscriber_email" value="\[EMAIL\]"/],
  ['merge token $(EMAIL_ADDRESS_)', /\$\(EMAIL_ADDRESS_\)/],
  ['hidden tracking inputs (campaign/customer/smt)', /name="campaign_id"[\s\S]*name="customer_id"[\s\S]*name="smt_mid"/],
  ['image CTA (amp-img inside tap button)', /role="button"[^>]*on="tap:[^"]*"><amp-img/],
  ['image hero slice', /<tr><td><amp-img src="[^"]+" width="600"/],
  ['benefit icon row (image slices)', /class="icon-cell"/],
  ['social icon slices in footer', /Follow us on:/],
  ['.w600 nested table layout', /<table role="presentation" width="600" class="w600">/],
  ['displayNone/displayBlock toggles', /\[class\]="responseData\.status == 'success' \? 'displayNone' : 'displayBlock'"/],
  ['@media max-width:500px', /@media all and \(max-width:500px\)/],
];

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  let allPass = true;
  for (const s of SAMPLES) {
    const r = resolved(s.spec);
    const built = buildProduction({ moduleId: s.moduleId, resolved: r, currency: s.spec.currency, endpoint: 'https://api.acme.in/lead' });
    const v = await validate(built.ampHtml);
    const errs = v.errors.filter((e) => e.severity === 'ERROR');
    const ok = v.pass;
    allPass = allPass && ok;
    console.log(`\n=== ${s.spec.name}  [${s.spec.vertical} · ${built.moduleName}]  ${ok ? 'VALID ✓' : 'INVALID ✗'}  (${v.errorCount}E/${v.warningCount}W)  ${built.ampHtml.length}b ===`);
    for (const e of errs.slice(0, 6)) console.log(`   L${e.line}:${e.col} ${e.code} — ${e.message}`);
    // marker coverage
    let hit = 0;
    const miss = [];
    for (const [label, re] of MARKERS) { if (re.test(built.ampHtml)) hit++; else miss.push(label); }
    console.log(`   structural markers: ${hit}/${MARKERS.length}` + (miss.length ? `  MISSING: ${miss.join(' | ')}` : '  (all present)'));
    const slug = `partA-${s.spec.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
    fs.writeFileSync(path.join(OUT, `${slug}.amp.html`), built.ampHtml);
    // viewer JSON (same shape render-demo emits) so the live preview can render it
    fs.writeFileSync(path.join(OUT, `${slug}.json`), JSON.stringify({
      ampHtml: built.ampHtml, brand: s.spec.name, moduleName: built.moduleName,
      kind: built.kind, palette: built.context.palette, nav: [],
    }));
  }
  console.log(`\n${allPass ? 'ALL SAMPLES VALID (0 errors)' : 'SOME SAMPLES INVALID — see above'}`);
  console.log('wrote samples to web/_demo/partA-*.amp.html');
  process.exit(allPass ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(2); });
