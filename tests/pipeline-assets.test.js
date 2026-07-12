'use strict';
const { test } = require('node:test');
const assert = require('node:assert');

// Deterministic defaults: no ambient provider key may enable a real LLM
// provider during this suite (same rule as tests/build-pipeline.test.js).
// The one test that needs a provider sets a FAKE key and intercepts fetch —
// nothing here ever reads .env or touches the network.
delete process.env.ANTHROPIC_API_KEY;
delete process.env.GEMINI_API_KEY;
delete process.env.GROQ_API_KEY;
delete process.env.OLLAMA_BASE_URL;

// Fully offline by default: every live fetch (colour, logo, provider) fails
// fast. Individual tests swap in a scripted fetch (fake Google-favicon 200s,
// a fake Groq endpoint) and MUST restore this default in finally.
const offlineFetch = async () => {
  throw new Error('offline test: network disabled');
};
globalThis.fetch = offlineFetch;

const { createBuild } = require('../server/build-pipeline');
const { composeContent } = require('../server/brief-content');
const { proposeUseCases, shapeUserIdea, EXEMPLARS } = require('../server/usecase-engine');
const { validate } = require('../server/validator');
const { brandSlug } = require('../server/store');

// In-memory stand-in for the Cloudflare KV binding (same shape as
// tests/build-pipeline.test.js's), Map-backed so tests can seed kits directly
// and assert byte-exact non-overwrites.
function fakeKv() {
  const map = new Map();
  return {
    map,
    async get(key, type) {
      if (!map.has(key)) return null;
      const raw = map.get(key);
      return type === 'json' ? JSON.parse(raw) : raw;
    },
    async put(key, value) { map.set(key, String(value)); },
  };
}

// Seeded straight into the map (not through putBrandKit) so these tests pin
// the READ contract — a kit record however it got into the KV.
function seedKit(kv, kit) {
  kv.map.set('brandkit:' + kit.slug, JSON.stringify(kit));
  return kit;
}

// The v3.2 assets-only kit: products + hero + voice, deliberately NO primary
// — the canonical case of a library-colour/hash-colour brand whose kit only
// curates assets.
function assetsKit(name, overrides = {}) {
  return {
    slug: brandSlug(name),
    name,
    heroUrl: 'https://cdn.zzyzx.example/hero-band.jpg',
    voiceSample: 'Quietly confident skincare. We never shout.',
    products: [
      { name: 'Real Serum', price: 899, image: 'https://cdn.x.com/s.jpg' },
      { name: 'Crème & Co Kit', price: 1299 },
    ],
    source: 'manual',
    updatedAt: '2026-07-12T00:00:00.000Z',
    ...overrides,
  };
}

// The auto-save is intentionally fire-and-forget inside createBuild, so give
// its microtask chain one tick to land before asserting on the KV.
function settle() {
  return new Promise((resolve) => { setImmediate(resolve); });
}

// ---- assets-only kit: colour resolves live, assets thread into the email ----

test('assets-only kit (no primary): colour is NOT kit-sourced; products, hero and images land in the AMP', async () => {
  const kv = fakeKv();
  const kit = seedKit(kv, assetsKit('Zzyzx Assets Co'));
  const { response, build } = await createBuild(
    { brand: 'Zzyzx Assets Co', moduleId: 'search', counter: 0 },
    { validate, kv },
  );
  // No primary on the kit -> the colour tier must fall through (offline +
  // unknown brand = hash), never claim 'kit'.
  assert.strictEqual(response.colorSource, 'hash', 'a kit without primary must not force kit colour');
  // Kit products become copy.items — name, price AND image survive the trip.
  assert.deepStrictEqual(build.params.copy.items, [
    { name: 'Real Serum', price: 899, image: 'https://cdn.x.com/s.jpg' },
    { name: 'Crème & Co Kit', price: 1299 },
  ]);
  // Names render enc()-encoded in the AMP part; the curated image URL replaces
  // the placeholder tile; the kit hero paints the hero band.
  assert.ok(response.ampHtml.includes('Real Serum'), 'kit product name reaches the AMP');
  assert.ok(response.ampHtml.includes('Cr&#232;me &amp; Co Kit'), 'product names are entity-encoded, never raw');
  assert.ok(response.ampHtml.includes('https://cdn.x.com/s.jpg'), 'kit product image reaches the AMP tile');
  assert.ok(response.ampHtml.includes('<div class="hero">'), 'hero band is present');
  assert.ok(response.ampHtml.includes(kit.heroUrl), 'kit heroUrl is the hero band image');
  assert.strictEqual(build.params.copy.heroUrl, kit.heroUrl, 'heroUrl persists in the reproduction params');
  assert.strictEqual(response.validation.pass, true,
    `kit-assets build must still pass the real validator: ${JSON.stringify(response.validation.errors)}`);
  // Reproduction guarantee holds for asset-carrying builds too.
  const replay = await createBuild({
    brand: build.brand,
    vertical: build.vertical,
    tone: build.tone,
    currency: build.currency,
    moduleId: build.moduleId,
    counter: build.params.counter,
    colorOverride: build.params.colorOverride,
    copy: build.params.copy,
  }, { validate, kv });
  assert.strictEqual(replay.build.ampHtml, build.ampHtml, 'params-replay of a kit build is byte-identical');
});

// ---- precedence: brief-pasted products beat kit products --------------------

test('brief-pasted products BEAT kit products', async () => {
  const kv = fakeKv();
  seedKit(kv, assetsKit('Zzyzx Assets Co'));
  const { response, build } = await createBuild({
    brand: 'Zzyzx Assets Co',
    moduleId: 'search',
    counter: 0,
    brief: 'Chef specials tonight\nTruffle Pasta ₹499\nBerry Cheesecake ₹299',
  }, { validate, kv });
  assert.deepStrictEqual(build.params.copy.items, [
    { name: 'Truffle Pasta', price: 499 },
    { name: 'Berry Cheesecake', price: 299 },
  ], 'briefProducts replace kit.products wholesale');
  assert.ok(response.ampHtml.includes('Truffle Pasta'), 'brief items render');
  assert.ok(!response.ampHtml.includes('Real Serum'), 'kit items must not leak past the brief items');
  assert.strictEqual(build.params.copy.heroUrl, 'https://cdn.zzyzx.example/hero-band.jpg',
    'the kit hero still applies — item precedence never disturbs the hero layer');
});

// ---- precedence: manual copy.heroUrl beats kit.heroUrl -----------------------

test('manual copy.heroUrl beats kit.heroUrl; a non-URL manual hero is dropped, never rendered', async () => {
  const kv = fakeKv();
  seedKit(kv, assetsKit('Zzyzx Assets Co'));
  const manualHero = 'https://manual.example.com/campaign-hero.jpg';
  const { response, build } = await createBuild(
    { brand: 'Zzyzx Assets Co', moduleId: 'reveal', counter: 0, copy: { heroUrl: manualHero } },
    { validate, kv },
  );
  assert.strictEqual(build.params.copy.heroUrl, manualHero);
  assert.ok(response.ampHtml.includes(manualHero), 'manual hero renders');
  assert.ok(!response.ampHtml.includes('hero-band.jpg'), 'kit hero loses to the manual override');

  const bad = await createBuild(
    { brand: 'Zzyzx Assets Co', moduleId: 'reveal', counter: 0, copy: { heroUrl: 'javascript:alert(1)' } },
    { validate, kv },
  );
  assert.ok(!('heroUrl' in bad.build.params.copy), 'a heroUrl that is not http(s) is dropped from the copy');
  assert.strictEqual(bad.response.validation.pass, true);
});

// ---- auto-save: heroUrl frozen; manual kits are sacred -----------------------

// Scripted "the internet is up" fetch: Google's favicon probe answers 200 and
// the brand's own site serves an og:image — the exact conditions under which
// resolveBrandLogo wins a logo AND a hero.
function onlineFetch(url) {
  const u = String(url);
  if (u.includes('gstatic.com')) return { ok: true, text: async () => '' };
  return {
    ok: true,
    text: async () => '<meta property="og:image" content="https://cdn.zzyzxautoco.example/og-hero.jpg">',
  };
}

test('save-kit-on-fetch freezes heroUrl from the live resolve, and the next build rides the kit', async () => {
  globalThis.fetch = async (url) => onlineFetch(url);
  try {
    const kv = fakeKv();
    const { response } = await createBuild({ brand: 'Zzyzx Auto Co', counter: 0 }, { validate, kv });
    await settle();
    const raw = kv.map.get('brandkit:' + brandSlug('Zzyzx Auto Co'));
    assert.ok(raw, 'a live logo win must freeze a kit');
    const saved = JSON.parse(raw);
    assert.strictEqual(saved.heroUrl, 'https://cdn.zzyzxautoco.example/og-hero.jpg', 'live og:image hero is frozen on the kit');
    assert.ok(saved.logoUrl && saved.logoUrl.includes('gstatic.com'), 'probe-won logo is frozen');
    assert.strictEqual(saved.site, 'https://www.zzyzxautoco.com');
    assert.match(String(saved.primary), /^#[0-9a-f]{6}$/i, 'frozen kit still carries the resolved colour');
    assert.ok(response.ampHtml.includes('https://cdn.zzyzxautoco.example/og-hero.jpg'), 'the winning hero rendered in this same build');

    // Next build: the frozen kit now supplies colour+logo+hero with ZERO
    // fetches (the fetch impl would throw loudly if consulted).
    globalThis.fetch = offlineFetch;
    const second = await createBuild({ brand: 'Zzyzx Auto Co', counter: 0 }, { validate, kv });
    assert.strictEqual(second.response.colorSource, 'kit');
    assert.strictEqual(second.build.params.copy.heroUrl, 'https://cdn.zzyzxautoco.example/og-hero.jpg');
  } finally {
    globalThis.fetch = offlineFetch;
  }
});

test('a manual-source kit is NEVER overwritten by the auto-save, even when a live fetch wins', async () => {
  globalThis.fetch = async (url) => onlineFetch(url);
  try {
    const kv = fakeKv();
    // Assets-only manual kit with no logo/site: the live logo fetch runs and
    // wins, which is exactly the case that used to trigger a save.
    const kit = seedKit(kv, assetsKit('Zzyzx Manual Co', { heroUrl: undefined }));
    const before = kv.map.get('brandkit:' + kit.slug);
    const { build } = await createBuild({ brand: 'Zzyzx Manual Co', counter: 0 }, { validate, kv });
    await settle();
    assert.strictEqual(kv.map.get('brandkit:' + kit.slug), before, 'manual kit record must be byte-identical after the build');
    // The build itself still benefits from the live win — only the SAVE is off.
    assert.ok(build.params.copy.logoUrl && build.params.copy.logoUrl.includes('gstatic.com'),
      'live-won logo still renders on the build');
  } finally {
    globalThis.fetch = offlineFetch;
  }
});

// ---- voice: the kit voiceSample reaches the copy-composer prompt -------------

test('createBuild threads kit.voiceSample into composeContent (asserted via a captured provider prompt)', async () => {
  const kv = fakeKv();
  seedKit(kv, assetsKit('Zzyzx Voice Co', { products: undefined }));
  let groqBody = null;
  process.env.GROQ_API_KEY = 'test-not-a-real-key';
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes('api.groq.com')) {
      groqBody = JSON.parse(opts.body);
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: '{"head":"A quiet hello from the counter"}' } }] }),
      };
    }
    throw new Error('offline test: network disabled');
  };
  try {
    const { response } = await createBuild(
      { brand: 'Zzyzx Voice Co', moduleId: 'reveal', counter: 0, brief: 'a quiet win-back note for lapsed regulars' },
      { validate, kv },
    );
    assert.ok(groqBody, 'the configured provider must have been called');
    const prompt = groqBody.messages[1].content;
    assert.ok(prompt.includes('Voice sample — match this brand voice, never copy sentences verbatim:'),
      'the voice block frames the sample');
    assert.ok(prompt.includes('Quietly confident skincare. We never shout.'), 'the kit sample itself reaches the prompt');
    assert.strictEqual(response.copySource, 'llm', 'the captured plan actually won');
    assert.ok(response.ampHtml.includes('A quiet hello from the counter'), 'the voiced plan rendered');
  } finally {
    delete process.env.GROQ_API_KEY;
    globalThis.fetch = offlineFetch;
  }
});

test('composeContent: ctx.voiceSample lands in the prompt; absent, the prompt carries no voice block', async () => {
  let withVoice = null;
  const plan = await composeContent('win back lapsed users', {
    moduleId: 'reveal', brandName: 'Acme', tone: 'Premium', voiceSample: 'Quietly confident. No exclamation marks.',
  }, {
    providers: [{ name: 'fake', call: async (prompt) => { withVoice = prompt; return { head: 'A tidy headline here' }; } }],
    timeoutMs: 500,
  });
  assert.ok(plan && plan.head, 'the injected plan validates');
  assert.ok(withVoice.includes('Voice sample — match this brand voice, never copy sentences verbatim:'));
  assert.ok(withVoice.includes('Quietly confident. No exclamation marks.'));

  let withoutVoice = null;
  await composeContent('win back lapsed users', { moduleId: 'reveal', brandName: 'Acme', tone: 'Premium' }, {
    providers: [{ name: 'fake', call: async (prompt) => { withoutVoice = prompt; return { head: 'A tidy headline here' }; } }],
    timeoutMs: 500,
  });
  assert.ok(!withoutVoice.includes('Voice sample'), 'no sample, no block — the prompt stays as before');
});

// ---- ideation: exemplar-tuned prompts + voiceSample, prompt-only -------------

test('proposeUseCases: the caliber-bar exemplars and a sanitized voiceSample reach the prompt, never the output', async () => {
  assert.strictEqual(EXEMPLARS.length, 8, 'eight exemplars, one per winning play');
  let seen = null;
  const { useCases } = await proposeUseCases(
    { dossier: { name: 'Acme' }, count: 2, voiceSample: 'Calm, precise <b>tone</b>. Numbers over adjectives.' },
    { providers: [async (prompt) => { seen = prompt; return { useCases: [] }; }], timeoutMs: 500 },
  );
  assert.ok(seen.includes('The caliber bar — use-cases that won real pitches'), 'exemplar framing present');
  assert.ok(seen.includes('Reschedule-in-email') && seen.includes('Delivery-slot reschedule'),
    'exemplar lines reach the prompt');
  assert.ok(seen.includes('Voice sample — match this brand voice, never copy sentences verbatim:'));
  assert.ok(seen.includes('Numbers over adjectives.'), 'the sample text reaches the prompt');
  assert.ok(!seen.includes('<b>'), 'voiceSample is markup-stripped before the prompt');
  for (const uc of useCases) {
    assert.ok(!('voiceSample' in uc), 'voiceSample is prompt-only, never an output field');
  }
});

test('shapeUserIdea: voiceSample joins the shape prompt too', async () => {
  let seen = null;
  const shaped = await shapeUserIdea(
    { idea: 'price-drop reveal for saved items', dossier: { name: 'Acme' }, voiceSample: 'Short sentences. Dry wit.' },
    { providers: [async (prompt) => { seen = prompt; return { title: 'Price-drop reveal for saved items', moduleId: 'reveal' }; }], timeoutMs: 500 },
  );
  assert.ok(seen.includes('Voice sample — match this brand voice, never copy sentences verbatim:'));
  assert.ok(seen.includes('Short sentences. Dry wit.'));
  assert.ok(shaped && shaped.title && !('voiceSample' in shaped));
});

// ---- determinism guard: no kit, no hero -> nothing changed -------------------

test('no kit: a build stays byte-identical to its params-replay (determinism guard)', async () => {
  const kv = fakeKv();
  const { build } = await createBuild(
    { brand: 'Zzyzx Plain Co', counter: 3, brief: '20% off tonight', copy: { head: 'Hello Plain' } },
    { validate, kv },
  );
  assert.ok(!('heroUrl' in build.params.copy), 'no kit + offline = no hero layer at all');
  const replay = await createBuild({
    brand: build.brand,
    vertical: build.vertical,
    tone: build.tone,
    currency: build.currency,
    moduleId: build.moduleId,
    counter: build.params.counter,
    colorOverride: build.params.colorOverride,
    copy: build.params.copy,
  }, { validate, kv: null });
  assert.strictEqual(replay.build.ampHtml, build.ampHtml);
  assert.strictEqual(replay.build.fallbackHtml, build.fallbackHtml);
  assert.strictEqual(replay.build.fallbackText, build.fallbackText);
});
