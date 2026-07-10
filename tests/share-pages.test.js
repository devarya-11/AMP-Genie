'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { generate } = require('../server/generate');
const { buildPageHtml, slatePageHtml, notFoundPageHtml } = require('../server/share-pages');

// A real generate() call (forced module + counter, library brand) supplies
// the authentic record shape share pages must render — a hand-rolled fixture
// would silently drift the moment generate() gains or renames a field.
function makeBuild(overrides = {}, genOpts = {}) {
  const g = generate({
    brand: 'Zomato', vertical: 'Food', tone: 'Playful', currency: 'INR',
    moduleId: 'reveal', counter: 7, ...genOpts,
  });
  return {
    id: 'abc123def456',
    ts: '2026-07-10T09:30:00.000Z',
    author: 'Kalpit',
    useCase: 'Tap-to-reveal offer',
    slateId: null,
    brief: null,
    routedFromBrief: null,
    colorSource: 'library',
    validation: { pass: true, errorCount: 0, warningCount: 0 },
    fallbackHtml: '<div>FALLBACK_MARKER</div>',
    fallbackText: 'FALLBACK_TEXT_MARKER',
    ...g,
    ...overrides,
  };
}

// ---- buildPageHtml -----------------------------------------------------------

test('buildPageHtml carries the brand, phone frame, preview script and footer row', () => {
  const html = buildPageHtml(makeBuild());
  assert.ok(html.includes('Zomato'), 'brand name must appear');
  assert.ok(html.includes('id="demo"'), 'the preview container must exist');
  assert.ok(html.includes('class="phone"') && html.includes('phone-screen'), 'phone frame markup must exist');
  assert.ok(html.includes('<script src="/preview.js"></script>'), 'must load the shared preview renderer');
  assert.ok(html.includes('AmpGeniePreview.render'), 'must invoke the renderer');
  assert.ok(html.includes('/build/abc123def456?format=amp'), 'Download AMP must point at the build route');
  assert.ok(html.includes('badge pass'), 'a passing validation must show the green badge');
  assert.ok(html.includes('Built with AMP Genie'), 'credit line must exist');
  assert.ok(html.includes('2026-07-10'), 'the build date must appear');
  assert.ok(html.includes('Kalpit'), 'the author must appear when present');
  assert.ok(html.includes('Tap-to-reveal offer'), 'the use-case label must appear');
});

test('inline JSON is the light subset with every "<" escaped as \\u003c', () => {
  const build = makeBuild();
  // Force the worst case: a previewModel string that would otherwise close
  // the inline <script> element and start injecting markup.
  build.previewModel = { ...build.previewModel, head: 'Deal </script><img src=x onerror=alert(1)>' };
  const html = buildPageHtml(build);
  assert.ok(html.indexOf('</script><img') === -1, 'a raw </script> breakout must never survive');
  assert.ok(html.includes('\\u003c/script'), 'JSON "<" must be emitted as \\u003c');
  assert.ok(html.includes('"moduleId"') && html.includes('"previewModel"') && html.includes('"palette"'),
    'the inline payload carries exactly what preview.js needs');
  assert.ok(!html.includes('"ampHtml"') && !html.includes('amp4email'), 'ampHtml must never be inlined');
  assert.ok(!html.includes('FALLBACK_MARKER') && !html.includes('FALLBACK_TEXT_MARKER'),
    'fallback parts must never be inlined');
});

test('a hostile brand name is escaped everywhere on the page', () => {
  const html = buildPageHtml(makeBuild({}, { brand: '<img src=x onerror=alert(1)>' }));
  assert.ok(!html.includes('<img src=x'), 'the raw tag must never reach the markup');
  assert.ok(html.includes('&lt;img'), 'the brand must render entity-escaped');
});

test('escapeHtml also covers apostrophes and hex-guards the palette', () => {
  const build = makeBuild({ palette: { primary: 'red;}</style><script>' } }, { brand: "O'Malley" });
  const html = buildPageHtml(build);
  assert.ok(html.includes('O&#39;Malley'), 'apostrophes must be escaped, not passed through');
  assert.ok(!html.includes('red;}'), 'a non-hex palette value must never reach a style attribute');
});

test('logoUrl renders as an <img> only when it is a plain http(s) url', () => {
  const withLogo = buildPageHtml(makeBuild({ logoUrl: 'https://cdn.zomato.com/logo.png' }));
  assert.ok(withLogo.includes('src="https://cdn.zomato.com/logo.png"'), 'a real logo must win over the text mark');
  const withBad = buildPageHtml(makeBuild({ logoUrl: 'javascript:alert(1)' }));
  assert.ok(!withBad.includes('javascript:alert(1)'), 'a non-http(s) url must be dropped');
  assert.ok(withBad.includes('brand-name'), 'the coloured brand name is the fallback mark');
});

test('a failing validation shows the error count, not PASS', () => {
  const html = buildPageHtml(makeBuild({ validation: { pass: false, errorCount: 3, warningCount: 1 } }));
  assert.ok(html.includes('badge fail'), 'must show the red badge');
  assert.ok(html.includes('3 validation errors'), 'must show the error count');
  assert.ok(!html.includes('badge pass'), 'must not also claim PASS');
});

// ---- slatePageHtml -----------------------------------------------------------

function makeSlate() {
  const builds = ['reveal', 'quiz', 'poll'].map((moduleId, i) => makeBuild(
    { id: `aaaa0000bbb${i}`, useCase: `Use case ${moduleId}` },
    { moduleId, counter: i },
  ));
  const slate = {
    id: 'slate0000001',
    ts: '2026-07-10T09:30:00.000Z',
    author: 'Kalpit',
    brand: 'Zomato',
    brief: 'Push the <script>alert(1)</script> monsoon sale',
    title: 'Zomato — monsoon pitch',
    buildIds: builds.map((b) => b.id),
    moduleIds: builds.map((b) => b.moduleId),
  };
  return { slate, builds };
}

test('slatePageHtml renders one phone container and open link per build', () => {
  const { slate, builds } = makeSlate();
  const html = slatePageHtml(slate, builds);
  for (const b of builds) {
    assert.ok(html.includes(`id="demo-${b.id}"`), `container for ${b.id} must exist`);
    assert.ok(html.includes(`href="/b/${b.id}"`), `open link for ${b.id} must exist`);
    assert.ok(html.includes(`Use case ${b.moduleId}`), `use-case label for ${b.moduleId} must exist`);
  }
  const scriptTags = html.split('<script src="/preview.js"></script>').length - 1;
  assert.strictEqual(scriptTags, 1, 'preview.js must load exactly once for the whole grid');
  assert.ok(html.includes('const BUILDS = ['), 'all builds render from one inline array');
  assert.ok(html.includes('Zomato &#8212; monsoon pitch'), 'the slate title must appear (entity-encoded dash)');
});

test('slatePageHtml escapes the brief and never inlines heavy markup fields', () => {
  const { slate, builds } = makeSlate();
  const html = slatePageHtml(slate, builds);
  assert.ok(!html.includes('<script>alert(1)'), 'the raw brief script must never survive');
  assert.ok(html.includes('&lt;script&gt;alert(1)'), 'the brief must render entity-escaped');
  assert.ok(!html.includes('"ampHtml"') && !html.includes('amp4email'), 'ampHtml must never be inlined');
  assert.ok(!html.includes('FALLBACK_MARKER'), 'fallback parts must never be inlined');
});

test('slatePageHtml tolerates an empty build list', () => {
  const { slate } = makeSlate();
  const html = slatePageHtml(slate, []);
  assert.ok(html.includes('0 interactive concepts'), 'still renders a coherent page');
  assert.ok(!html.includes('id="demo-'), 'no phantom containers');
});

// ---- notFoundPageHtml --------------------------------------------------------

test('notFoundPageHtml is a small friendly page that escapes its kind', () => {
  const html = notFoundPageHtml('build');
  assert.ok(typeof html === 'string' && html.length > 0);
  assert.ok(html.includes('404'));
  assert.ok(html.includes('build'), 'names what was missing');
  const hostile = notFoundPageHtml('<b>x</b>');
  assert.ok(!hostile.includes('<b>x</b>'), 'even the kind string is escaped');
  assert.ok(hostile.includes('&lt;b&gt;x&lt;/b&gt;'));
});
