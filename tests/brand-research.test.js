'use strict';
const { test } = require('node:test');
const assert = require('node:assert');

// Deterministic defaults: no ambient key may enable a real provider or a
// real network call during this suite — every test that wants tier 2 active
// injects a fake thunk via opts.providers (or a fake Claude client via
// opts.client), and every fetch is an injected fetchImpl.
delete process.env.GEMINI_API_KEY;
delete process.env.GROQ_API_KEY;
delete process.env.OLLAMA_BASE_URL;
delete process.env.ANTHROPIC_API_KEY;

const {
  buildDossier, validateDossier, heuristicDossier, extractSiteFacts, fetchBrandSite, synthesizeDossier,
} = require('../server/brand-research');

// A realistic homepage: title/meta/og in mixed attribute order, chrome nav
// links mixed with real category labels, a duplicate label in another case,
// an inline-tagged h1, an offer h2, an empty h2 and an unclosed h2.
const FIXTURE_HTML = [
  '<!doctype html>',
  '<html><head>',
  '<title> Glowly — Clean Beauty, Delivered </title>',
  '<meta name="description" content="Glowly brings clean skincare, makeup and fragrance to your door.">',
  '<meta content="Serums, lipsticks and more." property="og:description">',
  '<meta property="og:site_name" content="Glowly">',
  '<meta name="viewport" content="width=device-width">',
  '</head><body>',
  '<nav>',
  '<a href="/">Home</a>',
  '<a href="/login">Login</a>',
  '<a href="/auth">Sign in</a>',
  '<a href="/privacy">Privacy Policy</a>',
  '<a href="/skincare"><span>Skincare</span></a>',
  '<a href="/makeup">Makeup</a>',
  '<a href="/fragrance">Fragrance</a>',
  '<a href="/makeup-2">makeup</a>',
  '<a href="/x">A</a>',
  `<a href="/y">${'Very long label '.repeat(3)}</a>`,
  '</nav>',
  '<h1>Radiant <em>serum</em> season</h1>',
  '<h2>40% off Diwali beauty sale</h2>',
  '<h2>Find your lipstick shade</h2>',
  '<h2>   </h2>',
  '<h2>Broken heading',
  '<p>malformed paragraph, never closed',
  '</body></html>',
].join('\n');

const FIXTURE_FACTS = extractSiteFacts(FIXTURE_HTML, 'https://www.glowly.com');

function fakeKv(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    async get(key, type) {
      const v = store.get(key);
      if (v === undefined) return null;
      return type === 'json' ? JSON.parse(v) : v;
    },
    async put(key, value) { store.set(key, value); },
  };
}

function countingFetch(html) {
  const state = { calls: 0 };
  state.impl = async () => {
    state.calls += 1;
    return { ok: true, text: async () => html };
  };
  return state;
}

const refusingFetch = async () => { throw new Error('ECONNREFUSED'); };

// ---- extractSiteFacts: pure HTML fact scraping ------------------------------

test('extractSiteFacts pulls title, meta description, og:site_name, headings and nav labels', () => {
  const f = FIXTURE_FACTS;
  assert.strictEqual(f.title, 'Glowly — Clean Beauty, Delivered');
  assert.strictEqual(f.description, 'Glowly brings clean skincare, makeup and fragrance to your door.');
  assert.strictEqual(f.siteName, 'Glowly');
  assert.deepStrictEqual(f.headings, [
    'Radiant serum season', // inner <em> stripped, unclosed/empty h2s skipped
    '40% off Diwali beauty sale',
    'Find your lipstick shade',
  ]);
  // chrome labels skipped, 1-char and >30-char labels skipped, case-insensitive dedup
  assert.deepStrictEqual(f.navLabels, ['Skincare', 'Makeup', 'Fragrance']);
});

test('extractSiteFacts falls back to og:description (reversed attribute order) when meta name=description is absent', () => {
  const f = extractSiteFacts('<head><meta content="Only the og description here." property="og:description"></head>', 'https://x.com');
  assert.strictEqual(f.description, 'Only the og description here.');
});

test('extractSiteFacts caps headings at 8 and each at ~120 chars', () => {
  const html = Array.from({ length: 10 }, (_, i) => `<h2>Heading ${i} ${'x'.repeat(200)}</h2>`).join('');
  const f = extractSiteFacts(html, 'https://x.com');
  assert.strictEqual(f.headings.length, 8);
  for (const h of f.headings) assert.ok(h.length <= 120);
});

test('extractSiteFacts strips stray angle brackets so no markup ever leaves it', () => {
  const f = extractSiteFacts('<h1>5 < 7 is true</h1><title>a <b>bold</b> title</title>', 'https://x.com');
  assert.ok(!/[<>]/.test(f.headings[0] || ''));
  assert.ok(!/[<>]/.test(f.title || ''));
});

test('extractSiteFacts tolerates malformed/hostile input without throwing', () => {
  for (const junk of [null, undefined, 12345, '<<<>>>', '<meta content=', '<h1>unclosed', { not: 'a string' }, '']) {
    const f = extractSiteFacts(junk, 'https://example.com');
    assert.ok(f && Array.isArray(f.headings) && Array.isArray(f.navLabels));
  }
});

// ---- fetchBrandSite: domain-guessed scrape, injected fetch ------------------

test('fetchBrandSite returns null when every candidate fetch is refused', async () => {
  let calls = 0;
  const refused = async () => { calls += 1; throw new Error('ECONNREFUSED'); };
  assert.strictEqual(await fetchBrandSite('Glowly', refused), null);
  assert.strictEqual(calls, 2); // www.glowly.com then glowly.com
});

test('fetchBrandSite returns the answering domain and its extracted facts', async () => {
  const f = countingFetch(FIXTURE_HTML);
  const got = await fetchBrandSite('Glowly', f.impl);
  assert.strictEqual(got.site, 'https://www.glowly.com');
  assert.strictEqual(got.facts.siteName, 'Glowly');
  assert.ok(got.facts.navLabels.includes('Skincare'));
});

test('fetchBrandSite falls through a non-OK first candidate to the bare domain', async () => {
  const fetchImpl = async (url) => (url.startsWith('https://www.')
    ? { ok: false, text: async () => '' }
    : { ok: true, text: async () => FIXTURE_HTML });
  const got = await fetchBrandSite('Glowly', fetchImpl);
  assert.strictEqual(got.site, 'https://glowly.com');
});

test('fetchBrandSite returns null for an empty brand name without touching the network', async () => {
  const fetchImpl = async () => { throw new Error('should not be called'); };
  assert.strictEqual(await fetchBrandSite('', fetchImpl), null);
  assert.strictEqual(await fetchBrandSite('!!!', fetchImpl), null);
});

// ---- heuristicDossier: the deterministic floor ------------------------------

test('heuristicDossier infers Beauty from a beauty-wordy page and detects the offer heading as a campaign', () => {
  const d = heuristicDossier({ brandName: 'Glowly', facts: FIXTURE_FACTS });
  assert.strictEqual(d.vertical, 'Beauty');
  assert.deepStrictEqual(d.currentCampaigns, ['40% off Diwali beauty sale']);
  assert.strictEqual(d.summary, 'Glowly brings clean skincare, makeup and fragrance to your door.');
  assert.ok(d.categories.includes('Skincare'));
  assert.ok(d.products.includes('Radiant serum season'));
  assert.ok(!d.products.includes('40% off Diwali beauty sale'), 'offer headings belong to campaigns, not products');
  assert.ok(Array.isArray(d.voice.adjectives) && d.voice.adjectives.length >= 2);
  assert.deepStrictEqual(d.voice.donts, []);
  assert.deepStrictEqual(d.audiences, []);
});

test('heuristicDossier with no facts still lands a vertical from the brand name alone', () => {
  const known = heuristicDossier({ brandName: 'Nykaa', facts: null });
  assert.strictEqual(known.vertical, 'Beauty');
  assert.strictEqual(known.summary, '');
  assert.deepStrictEqual(known.products, []);
  const unknown = heuristicDossier({ brandName: 'Zorbulon', facts: null });
  assert.strictEqual(unknown.vertical, 'Generic');
});

test('heuristicDossier treats free/sale/% wording as campaigns (max 3) and caps summary at 300 chars', () => {
  const facts = {
    title: 't',
    description: 'x'.repeat(500),
    headings: ['Free shipping weekend', 'Mega sale is live', 'New arrivals', 'Extra 10% off today', 'Offers galore, 25% off'],
    navLabels: [],
  };
  const d = heuristicDossier({ brandName: 'Acme', facts });
  assert.strictEqual(d.summary.length, 300);
  assert.deepStrictEqual(d.currentCampaigns, ['Free shipping weekend', 'Mega sale is live', 'Extra 10% off today']);
  assert.deepStrictEqual(d.products, ['New arrivals']);
});

// ---- validateDossier: allowlist re-validation of LLM output -----------------

test('validateDossier returns null only for non-objects', () => {
  assert.strictEqual(validateDossier(null), null);
  assert.strictEqual(validateDossier(undefined), null);
  assert.strictEqual(validateDossier('a string'), null);
  assert.strictEqual(validateDossier(['an', 'array']), null);
  assert.deepStrictEqual(validateDossier({}), {});
});

test('validateDossier drops any string carrying markup (< or >)', () => {
  const d = validateDossier({ summary: 'Nice brand <script>alert(1)</script>', products: ['Serum', '<b>Lipstick</b>'] });
  assert.strictEqual(d.summary, undefined);
  assert.deepStrictEqual(d.products, ['Serum']);
});

test('validateDossier drops over-long strings and non-array array fields, keeps the rest', () => {
  const d = validateDossier({ summary: 'x'.repeat(401), products: 'not an array', categories: ['Skincare'] });
  assert.deepStrictEqual(d, { categories: ['Skincare'] });
  assert.strictEqual(validateDossier({ summary: 'x'.repeat(400) }).summary.length, 400);
});

test('validateDossier drops over-long array items (80-char cap) and caps array lengths', () => {
  const d = validateDossier({
    products: Array.from({ length: 12 }, (_, i) => `Product ${i}`),
    audiences: ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7'],
    categories: ['ok', 'y'.repeat(81)],
  });
  assert.strictEqual(d.products.length, 10);
  assert.strictEqual(d.audiences.length, 5);
  assert.deepStrictEqual(d.categories, ['ok']);
});

test('validateDossier strips unknown fields without rejecting the rest', () => {
  const d = validateDossier({ summary: 'A tidy summary', bogus: 'nope', anotherUnknown: 42 });
  assert.deepStrictEqual(d, { summary: 'A tidy summary' });
});

test('validateDossier keeps only a real generator vertical', () => {
  assert.strictEqual(validateDossier({ vertical: 'Beauty' }).vertical, 'Beauty');
  assert.strictEqual(validateDossier({ vertical: 'Cryptozoology' }).vertical, undefined);
  assert.strictEqual(validateDossier({ vertical: 42 }).vertical, undefined);
});

test('validateDossier sanitises voice sub-arrays and tolerates a malformed voice', () => {
  const d = validateDossier({ voice: { adjectives: ['bold', 42, '<i>sly</i>'], donts: 'nope' } });
  assert.deepStrictEqual(d.voice, { adjectives: ['bold'] });
  assert.strictEqual(validateDossier({ voice: 'friendly' }).voice, undefined);
  assert.strictEqual(validateDossier({ voice: { adjectives: [42] } }).voice, undefined);
});

// ---- synthesizeDossier: injected provider thunks, never the network ---------

test('synthesizeDossier happy path: first injected thunk answers, result is re-validated', async () => {
  const providers = [async () => ({
    summary: 'Clean beauty D2C brand', vertical: 'Beauty', audiences: ['young urban professionals'], bogus: 'stripped',
  })];
  const d = await synthesizeDossier({ brandName: 'Glowly', facts: FIXTURE_FACTS, notes: 'note' }, { providers });
  assert.deepStrictEqual(d, { summary: 'Clean beauty D2C brand', audiences: ['young urban professionals'], vertical: 'Beauty' });
});

test('synthesizeDossier only ever calls the FIRST injected provider (one expensive call, not best-of-N)', async () => {
  let secondCalled = false;
  const providers = [
    async () => ({ summary: 'From the first provider' }),
    async () => { secondCalled = true; return { summary: 'never' }; },
  ];
  const d = await synthesizeDossier({ brandName: 'Glowly' }, { providers });
  assert.deepStrictEqual(d, { summary: 'From the first provider' });
  assert.strictEqual(secondCalled, false);
});

test('synthesizeDossier accepts a JSON-string body (Gemini/Groq/Ollama style)', async () => {
  const providers = [async () => JSON.stringify({ summary: 'Stringified body' })];
  const d = await synthesizeDossier({ brandName: 'Glowly' }, { providers });
  assert.deepStrictEqual(d, { summary: 'Stringified body' });
});

test('synthesizeDossier returns null on a throwing provider (async or sync)', async () => {
  assert.strictEqual(await synthesizeDossier({ brandName: 'G' }, { providers: [async () => { throw new Error('down'); }] }), null);
  assert.strictEqual(await synthesizeDossier({ brandName: 'G' }, { providers: [() => { throw new Error('sync'); }] }), null);
});

test('synthesizeDossier resolves null once the timeout budget elapses (never hangs)', async () => {
  const start = Date.now();
  const d = await synthesizeDossier({ brandName: 'G' }, { providers: [() => new Promise(() => {})], timeoutMs: 50 });
  assert.strictEqual(d, null);
  assert.ok(Date.now() - start < 2000, 'must resolve promptly via the timeout race, not hang');
});

test('synthesizeDossier returns null when the response validates to nothing usable', async () => {
  assert.strictEqual(await synthesizeDossier({ brandName: 'G' }, { providers: [async () => ({ bogus: 'x', vertical: 'NotReal' })] }), null);
  assert.strictEqual(await synthesizeDossier({ brandName: 'G' }, { providers: [async () => 'not json {'] }), null);
  assert.strictEqual(await synthesizeDossier({ brandName: 'G' }, { providers: [async () => null] }), null);
});

test('synthesizeDossier returns null with no providers configured at all (env keys deleted above)', async () => {
  assert.strictEqual(await synthesizeDossier({ brandName: 'Glowly', facts: FIXTURE_FACTS }), null);
  assert.strictEqual(await synthesizeDossier({ brandName: 'Glowly' }, { providers: [] }), null);
});

test('synthesizeDossier (auto-detect path) drives an injected Claude client and marks notes higher-trust in the prompt', async () => {
  let seen = null;
  const client = {
    messages: {
      parse: async (req) => { seen = req; return { parsed_output: { summary: 'From Claude' } }; },
    },
  };
  const d = await synthesizeDossier({ brandName: 'Glowly', facts: FIXTURE_FACTS, notes: 'Diwali push starts Friday' }, { client });
  assert.deepStrictEqual(d, { summary: 'From Claude' });
  const prompt = seen.messages[0].content;
  assert.ok(prompt.includes('Glowly'));
  assert.ok(prompt.includes('Diwali push starts Friday'), 'pasted notes go into the prompt verbatim');
  assert.ok(/HIGHER TRUST/.test(prompt), 'notes must be marked higher-trust than the scrape');
});

// ---- buildDossier: the orchestrator ------------------------------------------

test('buildDossier merges the LLM part over the heuristic dossier and stamps identity fields', async () => {
  const kv = fakeKv();
  const f = countingFetch(FIXTURE_HTML);
  const providers = [async () => ({ summary: 'LLM summary wins', audiences: ['Gen Z beauty shoppers'] })];
  const d = await buildDossier({
    brandName: 'Glowly', notes: 'internal note', kv, fetchImpl: f.impl,
  }, { providers });
  assert.strictEqual(d.summary, 'LLM summary wins');
  assert.deepStrictEqual(d.audiences, ['Gen Z beauty shoppers']);
  assert.ok(d.categories.includes('Skincare'), 'heuristic fills the gaps the LLM left');
  assert.strictEqual(d.vertical, 'Beauty');
  assert.strictEqual(d.confidence, 'llm');
  assert.strictEqual(d.name, 'Glowly');
  assert.strictEqual(d.slug, 'glowly');
  assert.strictEqual(d.site, 'https://www.glowly.com');
  assert.strictEqual(d.notes, 'internal note');
  assert.ok(!Number.isNaN(Date.parse(d.researchedAt)), 'researchedAt must be a parseable timestamp');
  assert.ok(kv.store.has('dossier:glowly'), 'dossier persisted best-effort under dossier:<slug>');
});

test('buildDossier returns the cached dossier on a second call without refetching', async () => {
  const kv = fakeKv();
  const f = countingFetch(FIXTURE_HTML);
  const first = await buildDossier({ brandName: 'Glowly', kv, fetchImpl: f.impl }, { providers: [] });
  assert.strictEqual(f.calls, 1);
  const second = await buildDossier({ brandName: 'Glowly', kv, fetchImpl: f.impl }, { providers: [] });
  assert.strictEqual(f.calls, 1, 'a cache hit must not refetch the site');
  assert.deepStrictEqual(second, first);
});

test('buildDossier force:true bypasses a valid cache entry', async () => {
  const kv = fakeKv();
  const f = countingFetch(FIXTURE_HTML);
  await buildDossier({ brandName: 'Glowly', kv, fetchImpl: f.impl }, { providers: [] });
  await buildDossier({
    brandName: 'Glowly', kv, fetchImpl: f.impl, force: true,
  }, { providers: [] });
  assert.strictEqual(f.calls, 2, 'force must recompute even with a fresh cache entry');
});

test('buildDossier treats changed notes as a cache miss (notes hash comparison)', async () => {
  const kv = fakeKv();
  const f = countingFetch(FIXTURE_HTML);
  await buildDossier({
    brandName: 'Glowly', notes: 'old plan', kv, fetchImpl: f.impl,
  }, { providers: [] });
  const d = await buildDossier({
    brandName: 'Glowly', notes: 'new plan', kv, fetchImpl: f.impl,
  }, { providers: [] });
  assert.strictEqual(f.calls, 2, 'changed notes must recompute the dossier');
  assert.strictEqual(d.notes, 'new plan');
  // unchanged notes hit the refreshed cache again
  await buildDossier({
    brandName: 'Glowly', notes: 'new plan', kv, fetchImpl: f.impl,
  }, { providers: [] });
  assert.strictEqual(f.calls, 2);
});

test('buildDossier keeps the pasted notes verbatim, whitespace and all', async () => {
  const notes = '  Launching the Diwali edit NEXT week!  \n(Do not mention pricing.)';
  const d = await buildDossier({
    brandName: 'Glowly', notes, kv: fakeKv(), fetchImpl: refusingFetch,
  }, { providers: [] });
  assert.strictEqual(d.notes, notes);
});

test('buildDossier never throws and returns a minimal dossier when everything fails', async () => {
  const kv = {
    get: async () => { throw new Error('kv down'); },
    put: async () => { throw new Error('kv down'); },
  };
  const providers = [async () => { throw new Error('provider down'); }];
  await assert.doesNotReject(async () => {
    const d = await buildDossier({ brandName: 'Nykaa', kv, fetchImpl: refusingFetch }, { providers });
    assert.strictEqual(d.name, 'Nykaa');
    assert.strictEqual(d.slug, 'nykaa');
    assert.strictEqual(d.summary, '');
    assert.strictEqual(d.site, null);
    assert.strictEqual(d.confidence, 'heuristic');
    assert.strictEqual(d.vertical, 'Beauty'); // brand-name hint still lands a vertical
  });
});

test('buildDossier copes with no brand name at all (nothing to fetch, nothing to cache)', async () => {
  const d = await buildDossier({});
  assert.strictEqual(d.name, '');
  assert.strictEqual(d.slug, '');
  assert.strictEqual(d.vertical, 'Generic');
  assert.strictEqual(d.confidence, 'heuristic');
});
