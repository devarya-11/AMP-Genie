'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const {
  resolveBrandLogo, fetchBrandLogo, ogImage, iconHref, absUrl,
} = require('../server/brand');

function fakeFetch(handler) {
  return async (url, init) => handler(url, init);
}
function htmlResponse(status, html) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => html,
  };
}

// ---- ogImage / iconHref / absUrl (pure parsing helpers) --------------------

test('ogImage finds a property="og:image" meta tag regardless of attribute order', () => {
  const a = '<meta property="og:image" content="https://x.com/logo.png">';
  const b = '<meta content="https://x.com/logo2.png" property="og:image">';
  assert.strictEqual(ogImage(a), 'https://x.com/logo.png');
  assert.strictEqual(ogImage(b), 'https://x.com/logo2.png');
  assert.strictEqual(ogImage('<meta name="description" content="no image here">'), null);
});

test('iconHref matches icon / shortcut icon / apple-touch-icon rels, ignores unrelated rels', () => {
  assert.strictEqual(iconHref('<link rel="icon" href="/favicon.ico">'), '/favicon.ico');
  assert.strictEqual(iconHref('<link rel="shortcut icon" href="/s.ico">'), '/s.ico');
  assert.strictEqual(iconHref('<link rel="apple-touch-icon" href="/a.png">'), '/a.png');
  assert.strictEqual(iconHref('<link rel="stylesheet" href="/style.css">'), null);
});

test('absUrl resolves a relative href against a base, and returns null for garbage/missing input', () => {
  assert.strictEqual(absUrl('/logo.png', 'https://www.acme.com'), 'https://www.acme.com/logo.png');
  assert.strictEqual(absUrl('https://cdn.acme.com/logo.png', 'https://www.acme.com'), 'https://cdn.acme.com/logo.png');
  assert.strictEqual(absUrl(null, 'https://www.acme.com'), null, 'a null href must not silently resolve to "<base>/null"');
  assert.strictEqual(absUrl('', 'https://www.acme.com'), null);
  assert.strictEqual(absUrl('/relative-with-no-base', null), null, 'a relative href with no base cannot resolve to an absolute URL');
});

// ---- fetchBrandLogo / resolveBrandLogo (end-to-end with injected fetch) ---

test('fetchBrandLogo prefers og:image over a favicon when both are present', async () => {
  const fetchImpl = fakeFetch(() => htmlResponse(200,
    '<meta property="og:image" content="/hero.jpg"><link rel="icon" href="/favicon.ico">'));
  const out = await fetchBrandLogo('acme', fetchImpl);
  assert.strictEqual(out.logoUrl, 'https://www.acme.com/hero.jpg');
  assert.strictEqual(out.site, 'https://www.acme.com');
});

test('fetchBrandLogo falls back to a favicon when there is no og:image', async () => {
  const fetchImpl = fakeFetch(() => htmlResponse(200, '<link rel="shortcut icon" href="/s.ico">'));
  const out = await fetchBrandLogo('acme', fetchImpl);
  assert.strictEqual(out.logoUrl, 'https://www.acme.com/s.ico');
});

test('fetchBrandLogo falls through to the next candidate domain on a non-ok response, and to null if both fail', async () => {
  let calls = 0;
  const fetchImpl = fakeFetch(() => {
    calls += 1;
    return htmlResponse(404, '');
  });
  const out = await fetchBrandLogo('acme', fetchImpl);
  assert.strictEqual(out, null);
  assert.strictEqual(calls, 2, 'should try both www. and bare candidate domains before giving up');
});

test('fetchBrandLogo degrades to null (never throws) when the fetch itself rejects', async () => {
  const fetchImpl = async () => { throw new Error('DNS failure'); };
  await assert.doesNotReject(async () => {
    const out = await fetchBrandLogo('acme', fetchImpl);
    assert.strictEqual(out, null);
  });
});

test('fetchBrandLogo returns null when the page has neither an og:image nor a recognised icon link', async () => {
  const fetchImpl = fakeFetch(() => htmlResponse(200, '<title>Acme</title>'));
  const out = await fetchBrandLogo('acme', fetchImpl);
  assert.strictEqual(out, null);
});

test('resolveBrandLogo returns null (and never calls fetch) for a blank brand name', async () => {
  const out = await resolveBrandLogo({ brandName: '   ', fetchImpl: async () => { throw new Error('should not be called'); } });
  assert.strictEqual(out, null);
});

test('resolveBrandLogo threads a custom fetchImpl through to a real result', async () => {
  const fetchImpl = fakeFetch(() => htmlResponse(200, '<meta property="og:image" content="https://cdn.acme.com/hero.jpg">'));
  const out = await resolveBrandLogo({ brandName: 'Acme', fetchImpl });
  assert.deepStrictEqual(out, { logoUrl: 'https://cdn.acme.com/hero.jpg', site: 'https://www.acme.com' });
});
