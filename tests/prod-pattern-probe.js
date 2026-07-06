'use strict';
// Probe: which production AMP4EMAIL patterns from the Bajaj/rasa references
// pass the REAL amphtml-validator. Decides what the engine can replicate verbatim.

const { validate } = require('../server/validator');

const HEAD_OPEN = [
  '<!doctype html>',
  '<html ⚡4email data-css-strict>',
  '<head>',
  '<meta charset="utf-8">',
  '<script async src="https://cdn.ampproject.org/v0.js"><\/script>',
];
const BOILER = '<style amp4email-boilerplate>body{visibility:hidden}</style>';

function doc({ extraHead = '', css = 'body{margin:0}', body = '<p>hi</p>' }) {
  return [
    ...HEAD_OPEN,
    extraHead,
    BOILER,
    `<style amp-custom>${css}</style>`,
    '</head>',
    '<body>',
    body,
    '</body>',
    '</html>',
  ].join('\n');
}

const CSP = '<meta content="default-src * data: blob:; script-src blob: https://cdn.ampproject.org/v0.js; https://cdn.ampproject.org/v0/ https://cdn.ampproject.org/viewer/ https://cdn.ampproject.org/rtv/; object-src \'none\'; style-src \'unsafe-inline\' https://cdn.ampproject.org/rtv/ https://cdn.materialdesignicons.com https://cloud.typography.com https://fonts.googleapis.com/css2?family=Rubik:wght@300;400;500;600&display=swap">';
const S_FORM = '<script async custom-element="amp-form" src="https://cdn.ampproject.org/v0/amp-form-0.1.js"><\/script>';
const S_BIND = '<script async custom-element="amp-bind" src="https://cdn.ampproject.org/v0/amp-bind-0.1.js"><\/script>';
const S_LIST = '<script async custom-element="amp-list" src="https://cdn.ampproject.org/v0/amp-list-0.1.js"><\/script>';
const S_MUST = '<script async custom-template="amp-mustache" src="https://cdn.ampproject.org/v0/amp-mustache-0.2.js"><\/script>';

const cases = [
  ['lightning-glyph html tag (⚡4email)', doc({})],
  ['bare CSP <meta content> (no http-equiv)', doc({ extraHead: CSP })],
  ['google fonts <link rel=stylesheet>', doc({ extraHead: '<link href="https://fonts.googleapis.com/css2?family=Rubik:wght@400;500;600&display=swap" rel="stylesheet">' })],
  ['@font-face in amp-custom (woff2)', doc({ css: '@font-face{font-family:Rubik;font-style:normal;font-weight:400;src:url(https://fonts.gstatic.com/s/rubik/v1/rubik.woff2) format("woff2")}body{font-family:Rubik,Arial}' })],
  ['preload block opacity:0 height:1px amp-img', doc({
    body: '<div style="opacity:0;height:1px;overflow:hidden"><amp-img src="https://placehold.co/600x276" width="600" height="276" layout="responsive"></amp-img></div><p>x</p>',
  })],
  ['open-track 1x1 amp-list + mustache template', doc({
    extraHead: [S_LIST, S_MUST].join('\n'),
    body: '<amp-list width="1" height="1" layout="fixed" src="https://example.com/open.php?e=[EMAIL]&m=[SMT_MID]&client_name=acme&request_form_type=AMP"><template type="amp-mustache"><amp-img src="https://placehold.co/1x1" width="1" height="1"></amp-img></template></amp-list>',
  })],
  ['amp-form data-capture w/ submit-success state', doc({
    extraHead: [S_FORM, S_BIND].join('\n'),
    body: '<form id="f" method="post" action-xhr="https://example.com/store.php" on="submit-success:AMP.setState({r:{status:event.response.status}})"><input type="text" name="name" value="[NAME]" required><input type="hidden" name="subscriber_email" value="[EMAIL]"><button type="submit">Go</button></form>',
  })],
  ['click_form hidden + tap:AMP.setState,click_form.submit', doc({
    extraHead: [S_FORM, S_BIND].join('\n'),
    body: '<div role="button" tabindex="0" on="tap:AMP.setState({event_type:\'click\',button_name:\'CTA\',action_desc:\'CTA\'}),click_form.submit"><amp-img src="https://placehold.co/600x120" width="600" height="120" layout="responsive"></amp-img></div><form id="click_form" method="post" action-xhr="https://example.com/event.php" on="submit-success:AMP.setState({e:event.response.status})"><input type="hidden" name="event_type" [value]="event_type"><input type="hidden" name="button_name" [value]="button_name"><input type="hidden" name="action_desc" [value]="action_desc"><input type="hidden" name="subscriber_email" value="[EMAIL]"></form>',
  })],
  ['CTA image wrapped in <a href>', doc({
    body: '<a href="https://example.com/plans"><amp-img src="https://placehold.co/600x120" width="600" height="120" layout="responsive"></amp-img></a>',
  })],
  ['merge tokens in text [NAME] ##User name## $(EMAIL_ADDRESS_)', doc({
    body: '<p>Hi ##User name##, [NAME] &#8377;999 $(EMAIL_ADDRESS_)</p>',
  })],
];

(async () => {
  for (const [label, html] of cases) {
    try {
      const r = await validate(html);
      const errs = r.errors.filter((e) => e.severity === 'ERROR');
      const tag = r.pass ? 'PASS' : 'FAIL';
      console.log(`${tag.padEnd(5)} ${label}  (${r.errorCount}E/${r.warningCount}W)`);
      for (const e of errs.slice(0, 4)) console.log(`        L${e.line}:${e.col} ${e.code} — ${e.message}`);
    } catch (e) {
      console.log(`ERROR ${label} — ${e.message}`);
    }
  }
})();
