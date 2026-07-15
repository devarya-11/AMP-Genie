'use strict';
const { test } = require('node:test');
const assert = require('node:assert');

// The keyless CC0 relevance resolver. Every test injects a fake fetchImpl —
// no test in this suite is allowed to touch the real Openverse network, so the
// suite stays deterministic and offline like the rest of the repo.
const { searchOpenverseImage, normalizeQuery, validImageUrl } = require('../server/openverse');

// A fetchImpl that records the request URL and returns a canned response.
function recordingFetch(response) {
  const state = { urls: [], opts: [] };
  state.impl = async (url, opts) => {
    state.urls.push(url);
    state.opts.push(opts);
    return typeof response === 'function' ? response(url, opts) : response;
  };
  return state;
}

const REAL = 'https://live.staticflickr.com/65535/abc-serum.jpg';

// ---- validImageUrl: the amp-img grammar gate --------------------------------

test('validImageUrl accepts plain https and rejects everything a sanitiser would drop', () => {
  assert.ok(validImageUrl('https://live.staticflickr.com/1/2.jpg'));
  assert.ok(validImageUrl('https://images.example.com/p/x.png?w=600'));
  // rejections
  assert.ok(!validImageUrl('http://insecure.example.com/x.jpg'), 'http:// dropped');
  assert.ok(!validImageUrl('https://x.com/has a space.jpg'), 'whitespace dropped');
  assert.ok(!validImageUrl('https://x.com/"quote.jpg'), 'quote dropped');
  assert.ok(!validImageUrl('https://x.com/<tag>.jpg'), 'angle brackets dropped');
  assert.ok(!validImageUrl('https://' + 'x'.repeat(600) + '.jpg'), 'over-long dropped');
  assert.ok(!validImageUrl(''), 'empty dropped');
  assert.ok(!validImageUrl(null), 'non-string dropped');
});

// ---- normalizeQuery: bounded, punctuation-free keywords ---------------------

test('normalizeQuery strips punctuation, collapses whitespace, caps length, keeps alnum', () => {
  assert.strictEqual(normalizeQuery("Chef's  Special — Tandoori! Platter"), 'Chef s Special Tandoori Platter');
  assert.strictEqual(normalizeQuery('   '), '');
  assert.strictEqual(normalizeQuery('!!!'), '');
  assert.strictEqual(normalizeQuery(null), '');
  assert.strictEqual(normalizeQuery(12345), '12345');
  assert.ok(normalizeQuery('x'.repeat(200)).length <= 80, 'capped at 80 chars');
});

// ---- searchOpenverseImage: happy path + request shape -----------------------

test('searchOpenverseImage returns the first real result and requests CC0/PDM, mature=false, page_size=1', async () => {
  const f = recordingFetch({ ok: true, json: async () => ({ result_count: 240, results: [{ url: REAL, license: 'cc0' }] }) });
  const got = await searchOpenverseImage({ query: 'vitamin c serum', fetchImpl: f.impl });
  assert.strictEqual(got, REAL);
  const url = f.urls[0];
  assert.ok(url.startsWith('https://api.openverse.org/v1/images/?'), 'hits the images endpoint');
  assert.ok(url.includes('q=vitamin%20c%20serum'), 'encodes the query');
  assert.ok(url.includes('license=cc0%2Cpdm'), 'no-attribution licenses only');
  assert.ok(url.includes('mature=false'), 'brand-safe by default');
  assert.ok(url.includes('page_size=1'), 'only needs the top result');
  assert.strictEqual(f.opts[0].headers.Accept, 'application/json');
});

test('searchOpenverseImage skips a result whose url fails the amp-img grammar and takes the next valid one', async () => {
  const f = recordingFetch({
    ok: true,
    json: async () => ({
      results: [
        { url: 'http://insecure.example.com/x.jpg' }, // http:// -> skipped
        { title: 'no url field' }, // missing url -> skipped
        { url: REAL }, // first valid
      ],
    }),
  });
  assert.strictEqual(await searchOpenverseImage({ query: 'serum', fetchImpl: f.impl }), REAL);
});

test('searchOpenverseImage returns null for an empty/punctuation query WITHOUT touching the network', async () => {
  const fetchImpl = async () => { throw new Error('must not be called for an empty query'); };
  assert.strictEqual(await searchOpenverseImage({ query: '   ', fetchImpl }), null);
  assert.strictEqual(await searchOpenverseImage({ query: '!!!', fetchImpl }), null);
  assert.strictEqual(await searchOpenverseImage({ query: null, fetchImpl }), null);
});

test('searchOpenverseImage returns null on a non-2xx, a 429 throw, empty results, or a malformed body', async () => {
  const cases = [
    { ok: false, status: 403, json: async () => ({}) }, // non-2xx
    { ok: true, json: async () => ({ result_count: 0, results: [] }) }, // no results
    { ok: true, json: async () => ({ nope: true }) }, // no results array
    { ok: true, json: async () => { throw new Error('bad json'); } }, // malformed body
  ];
  for (const resp of cases) {
    // eslint-disable-next-line no-await-in-loop
    assert.strictEqual(await searchOpenverseImage({ query: 'serum', fetchImpl: async () => resp }), null);
  }
  // a fetch that throws (rate-limit reset, network error, abort) -> null, never throws
  await assert.doesNotReject(async () => {
    const got = await searchOpenverseImage({ query: 'serum', fetchImpl: async () => { throw new Error('429'); } });
    assert.strictEqual(got, null);
  });
});

test('searchOpenverseImage honours mature=true when explicitly asked', async () => {
  const f = recordingFetch({ ok: true, json: async () => ({ results: [{ url: REAL }] }) });
  await searchOpenverseImage({ query: 'serum', fetchImpl: f.impl, mature: true });
  assert.ok(f.urls[0].includes('mature=true'));
});
