'use strict';

// Side-by-side structural diff: the generated production email vs the REAL
// shipped reference (Bajaj Finserv). Proves the engine authors AMP with the same
// production grammar — not by copying content, but by matching the patterns.

const fs = require('fs');
const path = require('path');

const REF = '/Users/devarya/Downloads/bajaj_health_AMP.html';
const GEN = path.join(__dirname, '..', 'web', '_demo', 'partA-lyra-studio.amp.html');

const ref = fs.readFileSync(REF, 'utf8');
const gen = fs.readFileSync(GEN, 'utf8');

// Each row: [section, feature, test]. A test is a regex OR a function(html)->bool.
const FEATURES = [
  ['HEAD', '<!doctype html>', /<!doctype html>/i],
  ['HEAD', 'AMP4EMAIL html tag', (h) => /<html[^>]*(⚡4email|amp4email)/i.test(h)],
  ['HEAD', 'data-css-strict', /data-css-strict/],
  ['HEAD', '<meta charset>', /<meta charset/i],
  ['HEAD', 'amp v0.js runtime', /cdn\.ampproject\.org\/v0\.js/],
  ['HEAD', 'CSP <meta content> (default-src)', /<meta content="default-src/],
  ['HEAD', 'webfont host in CSP (fonts.googleapis)', /fonts\.googleapis\.com\/css2/],
  ['HEAD', 'amp-form script', /custom-element="amp-form"/],
  ['HEAD', 'amp-bind script', /custom-element="amp-bind"/],
  ['HEAD', 'amp-list script', /custom-element="amp-list"/],
  ['HEAD', 'amp-mustache template', /custom-template="amp-mustache"/],
  ['HEAD', '<style amp4email-boilerplate>', /amp4email-boilerplate/],
  ['HEAD', '<style amp-custom>', /<style amp-custom>/],

  ['BODY', 'hidden asset preload block', /opacity:\s*0[^"]*height:\s*1px/],
  ['BODY', 'open-track 1×1 amp-list', (h) => /<amp-list[^>]*width="1"[^>]*height="1"/.test(h)],
  ['BODY', 'request_form_type=AMP ping', /request_form_type=AMP/],

  ['LAYOUT', '600px fixed-width table', (h) => /width="600"/.test(h)],
  ['LAYOUT', 'nested table layout', (h) => (h.match(/<table/g) || []).length >= 3],
  ['LAYOUT', 'bgcolor / background bands', (h) => /bgcolor=|background:/i.test(h)],
  ['LAYOUT', '@media mobile query', /@media[^{]*max-width/],
  ['LAYOUT', 'displayNone/displayBlock classes', /displayNone|displayBlock/],

  ['IMAGE', 'hero image slice (amp-img, layout=responsive)', (h) => /<amp-img[^>]*layout="responsive"/.test(h)],
  ['IMAGE', 'image CTA wrapped (amp-img inside tap/anchor)', (h) => /(role="button"[^>]*on="tap:[^"]*"|<a [^>]*>)\s*<amp-img/.test(h)],
  ['IMAGE', 'explicit width/height on amp-img', (h) => /<amp-img[^>]*width="\d+"[^>]*height="\d+"/.test(h)],

  ['FORM', 'amp-form action-xhr data capture', /<form[^>]*action-xhr=/],
  ['FORM', 'submit-success → AMP.setState(responseData)', /submit-success:AMP\.setState\(\{?\s*responseData/],
  ['FORM', '[class] success/error state toggle', /\[class\]="responseData\.status/],
  ['FORM', 'submitting loader', /<div submitting/],
  ['FORM', 'error block [text]=responseData.message', /\[text\]="responseData\.message"/],
  ['FORM', 'thank-you success block', (h) => /Thank you|Response has been Recorded/i.test(h)],
  ['FORM', 'validation spans (visible-when-invalid)', /visible-when-invalid/],
  ['FORM', 'pattern validation on mobile', /pattern="\[0-9\]\{10\}"/],

  ['TRACK', 'click-capture form (tap → form.submit)', (h) => /on="tap:[^"]*(click_form\.submit|form2\.submit)/.test(h)],
  ['TRACK', 'event setState on tap', /AMP\.setState\(\{[^}]*(event_type|click_evt)/],
  ['TRACK', 'hidden subscriber_email tracking input', /name="subscriber_email"/],
  ['TRACK', 'hidden campaign_id tracking input', /name="campaign_id"/],
  ['TRACK', 'UTM hidden inputs', /name="x_utm_/],

  ['TOKEN', 'value="[NAME]" merge token', /value="\[NAME\]"/],
  ['TOKEN', 'value="[EMAIL]" merge token', /value="\[EMAIL\]"/],
  ['TOKEN', 'mobile merge token', (h) => /value="\[MOBILE(_NO)?\]"/.test(h)],
  ['TOKEN', 'campaign/customer merge token', (h) => /\[CAMPAIGN_ID\]|\[CUSTOMER_ID\]|\[SMT_MID\]/.test(h)],
  ['TOKEN', 'greeting personalization token', (h) => /##User name##|\[NAME\]/.test(h)],

  ['FOOTER', 'branded footer band', (h) => /Follow us on:|footer|foot/i.test(h)],
  ['FOOTER', 'social icon image slices', (h) => /(linkedin|facebook|instagram|social)/i.test(h)],
  ['FOOTER', 'currency entity-encoded (₹ = &#8377;)', (h) => /&#8377;/.test(h) || !/₹/.test(h)],
];

function has(test, html) { return typeof test === 'function' ? !!test(html) : test.test(html); }

const groups = [];
let cur = null;
for (const [section, feature, test] of FEATURES) {
  if (!cur || cur.section !== section) { cur = { section, rows: [] }; groups.push(cur); }
  cur.rows.push({ feature, ref: has(test, ref), gen: has(test, gen) });
}

const FW = 48;
function mark(b) { return b ? '  ✓  ' : '  –  '; }
console.log('\nSTRUCTURAL PARITY — generated (Lyra Studio) vs reference (Bajaj Finserv)\n');
console.log('  ' + 'FEATURE'.padEnd(FW) + 'REFERENCE   GENERATED');
console.log('  ' + '-'.repeat(FW + 22));
let refN = 0, genN = 0, both = 0, total = 0;
for (const g of groups) {
  console.log('  ' + g.section);
  for (const r of g.rows) {
    total++; if (r.ref) refN++; if (r.gen) genN++; if (r.ref && r.gen) both++;
    console.log('    ' + r.feature.padEnd(FW - 2) + mark(r.ref) + '     ' + mark(r.gen));
  }
}
console.log('  ' + '-'.repeat(FW + 22));
console.log(`\n  Reference exhibits : ${refN}/${total} patterns`);
console.log(`  Generated exhibits : ${genN}/${total} patterns`);
console.log(`  Shared (parity)    : ${both}/${total} patterns`);
const genOnly = [];
const refOnly = [];
for (const g of groups) for (const r of g.rows) {
  if (r.gen && !r.ref) genOnly.push(r.feature);
  if (r.ref && !r.gen) refOnly.push(r.feature);
}
if (refOnly.length) console.log(`\n  In reference, not generated: ${refOnly.join(' | ')}`);
if (genOnly.length) console.log(`  In generated, not reference: ${genOnly.join(' | ')}`);
console.log('');
