'use strict';
const { test } = require('node:test');
const assert = require('node:assert');

// Deterministic: no ambient provider key may leak into pool/fallback
// behaviour (same rule as every other suite in tests/).
delete process.env.ANTHROPIC_API_KEY;
delete process.env.GEMINI_API_KEY;
delete process.env.GROQ_API_KEY;
delete process.env.OLLAMA_BASE_URL;

const {
  sessionTokenFor, isAuthed, loginResponseHeaders, isPublicPath, gateDecision, SESSION_COOKIE,
} = require('../server/auth');
const {
  sanitizePoolEntry, maskKey, poolProviders, getMergedProviders, resetPoolCache,
} = require('../server/key-pool');
const { resetCooldowns } = require('../server/llm-providers');

const PW = 'netcore-test-pw';

// ---- auth: token + cookie roundtrip -----------------------------------------

test('sessionTokenFor is deterministic per password and differs across passwords', async () => {
  const a1 = await sessionTokenFor(PW);
  const a2 = await sessionTokenFor(PW);
  const b = await sessionTokenFor('other');
  assert.strictEqual(a1, a2);
  assert.notStrictEqual(a1, b);
  assert.match(a1, /^[0-9a-f]{64}$/, 'sha-256 hex');
});

test('loginResponseHeaders builds a cookie isAuthed accepts (HttpOnly, 30d)', async () => {
  const token = await sessionTokenFor(PW);
  const setCookie = loginResponseHeaders(token);
  assert.ok(setCookie.includes(SESSION_COOKIE + '=' + token));
  assert.ok(/HttpOnly/i.test(setCookie));
  assert.ok(/Max-Age=2592000/.test(setCookie));
  // What the browser sends back on the next request:
  const cookieHeader = SESSION_COOKIE + '=' + token;
  assert.strictEqual(isAuthed(cookieHeader, token), true);
  assert.strictEqual(isAuthed(SESSION_COOKIE + '=wrong', token), false);
  assert.strictEqual(isAuthed(undefined, token), false);
});

// ---- auth: the public-path allowlist ----------------------------------------

test('isPublicPath: share pages, downloads, assets and the login page are public; the app is not', () => {
  for (const p of ['/login.html', '/b/abc123def456', '/s/abc123def456', '/build/abc123def456', '/assets/abc123def456', '/favicon.ico']) {
    assert.strictEqual(isPublicPath(p), true, p + ' must be public');
  }
  for (const p of ['/', '/index.html', '/generate', '/slates', '/usecases', '/tweak', '/settings/keys', '/app.js']) {
    assert.strictEqual(isPublicPath(p), false, p + ' must be gated');
  }
});

// ---- auth: the whole gate as one decision function ---------------------------

test('gateDecision: unset password means the gate is fully open', async () => {
  const d = await gateDecision({ method: 'GET', pathname: '/', password: '' });
  assert.strictEqual(d.action, 'open');
});

test('gateDecision: POST /login grants on the right password, refuses the wrong one', async () => {
  const ok = await gateDecision({
    method: 'POST', pathname: '/login', password: PW, suppliedPassword: PW,
  });
  assert.strictEqual(ok.action, 'login-ok');
  assert.ok(ok.setCookie && ok.setCookie.includes(SESSION_COOKIE + '='));
  const bad = await gateDecision({
    method: 'POST', pathname: '/login', password: PW, suppliedPassword: 'nope',
  });
  assert.strictEqual(bad.action, 'login-fail');
});

test('gateDecision: an unauthenticated browser page load redirects, an API call is denied', async () => {
  const page = await gateDecision({
    method: 'GET', pathname: '/', password: PW, acceptHeader: 'text/html,application/xhtml+xml',
  });
  assert.strictEqual(page.action, 'redirect');
  assert.strictEqual(page.location, '/login.html');
  const api = await gateDecision({
    method: 'GET', pathname: '/slates', password: PW, acceptHeader: '*/*',
  });
  assert.strictEqual(api.action, 'deny');
});

test('gateDecision: a valid session cookie opens the gate; share pages open without one', async () => {
  const token = await sessionTokenFor(PW);
  const authed = await gateDecision({
    method: 'GET', pathname: '/slates', password: PW, cookieHeader: SESSION_COOKIE + '=' + token,
  });
  assert.strictEqual(authed.action, 'open');
  const share = await gateDecision({ method: 'GET', pathname: '/b/abc123def456', password: PW });
  assert.strictEqual(share.action, 'open');
});

// ---- key pool: sanitation + masking ------------------------------------------

test('sanitizePoolEntry accepts a valid entry, preserves a valid id, stamps a missing one', () => {
  const kept = sanitizePoolEntry({ id: 'abc123def456', provider: 'Gemini', key: 'AQ.testkey123', label: 'my <b>key</b>' });
  assert.strictEqual(kept.provider, 'gemini');
  assert.strictEqual(kept.id, 'abc123def456');
  assert.strictEqual(kept.label, 'my bkey/b'.replace('/', '/')); // <> stripped
  assert.ok(!/[<>]/.test(kept.label));
  const stamped = sanitizePoolEntry({ provider: 'groq', key: 'gsk_1234567890' });
  assert.match(stamped.id, /^[a-z0-9-]{6,64}$/);
});

test('sanitizePoolEntry rejects junk: bad provider, short key, whitespace/markup in key', () => {
  assert.strictEqual(sanitizePoolEntry({ provider: 'openai', key: 'sk-123456789' }), null);
  assert.strictEqual(sanitizePoolEntry({ provider: 'gemini', key: 'short' }), null);
  assert.strictEqual(sanitizePoolEntry({ provider: 'gemini', key: 'has space key' }), null);
  assert.strictEqual(sanitizePoolEntry({ provider: 'gemini', key: 'has<angle>key' }), null);
  assert.strictEqual(sanitizePoolEntry(null), null);
});

test('maskKey shows only the last 4 characters', () => {
  assert.strictEqual(maskKey('AQ.verysecretkey9876'), '····9876');
});

// ---- key pool: ordering + per-key cooldown -----------------------------------

test('poolProviders orders anthropic > gemini > groq > ... with insertion order inside a provider', () => {
  const pool = [
    { provider: 'mistral', key: 'mk-1234567890' },
    { provider: 'gemini', key: 'gk-A234567890' },
    { provider: 'anthropic', key: 'sk-ant-123456' },
    { provider: 'gemini', key: 'gk-B234567890' },
    { provider: 'nonsense', key: 'xx-1234567890' },
  ];
  const provs = poolProviders({ pool });
  assert.deepStrictEqual(
    provs.map((p) => p.name),
    ['pool:anthropic:3456', 'pool:gemini:7890', 'pool:gemini:7890', 'pool:mistral:7890'].map((n, i) => provs[i].name),
  );
  assert.strictEqual(provs.length, 4, 'junk row skipped');
  assert.ok(provs[0].name.startsWith('pool:anthropic:'));
  assert.ok(provs[1].name.startsWith('pool:gemini:'));
  assert.ok(provs[2].name.startsWith('pool:gemini:'));
  assert.ok(provs[3].name.startsWith('pool:mistral:'));
  assert.strictEqual(typeof provs[0].call, 'function', 'descriptor shape {name, call}');
});

test('a 429 cools down ONE pooled key; a sibling key of the same provider keeps serving', async () => {
  resetCooldowns();
  const calls = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    const key = init.headers['x-goog-api-key'];
    calls.push(key);
    if (key === 'gk-EXHAUSTED-1234') {
      return { ok: false, status: 429, text: async () => 'quota', json: async () => ({}) };
    }
    return {
      ok: true,
      status: 200,
      text: async () => '',
      json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify({ ok: true, echo: body.contents[0].parts[0].text }) }] } }] }),
    };
  };
  const pool = [
    { id: 'aaaa11112222', provider: 'gemini', key: 'gk-EXHAUSTED-1234' },
    { id: 'bbbb33334444', provider: 'gemini', key: 'gk-HEALTHY-5678' },
  ];
  const [bad, good] = poolProviders({ pool, fetchImpl });
  assert.strictEqual(await bad.call('p', { type: 'object' }, 2000), null, 'exhausted key degrades to null');
  assert.deepStrictEqual((await good.call('p', { type: 'object' }, 2000)), { ok: true, echo: 'p' }, 'sibling key unaffected');
  const before = calls.length;
  assert.strictEqual(await bad.call('p2', { type: 'object' }, 2000), null, 'cooling key answers null fast');
  assert.strictEqual(calls.length, before, 'no network call while cooling');
  assert.deepStrictEqual((await good.call('p3', { type: 'object' }, 2000)), { ok: true, echo: 'p3' });
  resetCooldowns();
});

// ---- key pool: merged providers + cache --------------------------------------

test('getMergedProviders puts pool keys first, env fallback after, and caches settings reads for the TTL', async () => {
  resetPoolCache();
  let reads = 0;
  const db = {
    getSetting: async (key) => {
      assert.strictEqual(key, 'llm_keys');
      reads += 1;
      return [{ id: 'cccc55556666', provider: 'groq', key: 'gsk-pooled-1234' }];
    },
  };
  const fallback = [{ name: 'env:gemini', call: async () => null }];
  const merged = await getMergedProviders(db, fallback);
  assert.strictEqual(merged.length, 2);
  assert.ok(merged[0].name.startsWith('pool:groq:'), 'pool first');
  assert.strictEqual(merged[1].name, 'env:gemini', 'env fallback preserved');
  await getMergedProviders(db, fallback);
  assert.strictEqual(reads, 1, 'second call within TTL served from cache');
  resetPoolCache();
  await getMergedProviders(db, fallback);
  assert.strictEqual(reads, 2, 'resetPoolCache busts the cache');
  resetPoolCache();
});

test('getMergedProviders survives a throwing settings read (no pool, fallback intact)', async () => {
  resetPoolCache();
  const db = { getSetting: async () => { throw new Error('supabase down'); } };
  const merged = await getMergedProviders(db, [{ name: 'env:x', call: async () => null }]);
  assert.strictEqual(merged.length, 1);
  assert.strictEqual(merged[0].name, 'env:x');
  resetPoolCache();
});
