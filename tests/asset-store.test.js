'use strict';
const { test } = require('node:test');
const assert = require('node:assert');

const {
  MAX_ASSET_BYTES, BYTES_PREFIX,
  validateUpload, sanitizeFilename, isAssetId,
  b64ToBytes, b64ToBytesAtob,
  isR2Bucket, putAssetBytes, getAssetBytes, delAssetBytes,
} = require('../server/asset-store');

// In-memory stand-in for the Cloudflare KV binding (same shape as
// tests/slate-core.test.js's fakeKv), plus the delete() real KV has — the
// asset store is the first module that removes keys.
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
    async delete(key) { map.delete(key); },
  };
}

// 1x1 transparent PNG, 96 base64 chars -> exactly 70 decoded bytes, opening
// with the 8-byte PNG signature. Small enough to eyeball, real enough to
// prove decode correctness end to end.
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const PNG_SIZE = 70;
const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

// ---- validateUpload: the gate every desktop upload passes --------------------

test('a good png upload passes with exact size and normalised fields', () => {
  const v = validateUpload({ filename: 'Diwali Hero.png', mime: 'image/png', dataBase64: PNG_B64 });
  assert.strictEqual(v.ok, true);
  assert.strictEqual(v.size, PNG_SIZE, 'size is the exact decoded byte count, not an estimate');
  assert.strictEqual(v.mime, 'image/png');
  assert.strictEqual(v.filename, 'Diwali Hero.png');
});

test('mime allowlist: svg and html are refused, image/jpg normalises to image/jpeg', () => {
  assert.strictEqual(validateUpload({ mime: 'image/svg+xml', dataBase64: PNG_B64 }).ok, false,
    'svg can carry script — never an upload');
  assert.strictEqual(validateUpload({ mime: 'text/html', dataBase64: PNG_B64 }).ok, false);
  assert.strictEqual(validateUpload({ dataBase64: PNG_B64 }).ok, false, 'missing mime is refused');
  const jpg = validateUpload({ mime: 'IMAGE/JPG', dataBase64: PNG_B64 });
  assert.strictEqual(jpg.ok, true, 'case-insensitive allowlist');
  assert.strictEqual(jpg.mime, 'image/jpeg', 'the fake image/jpg type is normalised to the real one');
});

test('oversize: one byte past the cap is refused, the cap itself passes', () => {
  // 'A'.repeat(n) is valid base64 shape when n % 4 === 0 (no padding).
  // 2_666_668 chars * 3/4 = 2_000_001 decoded bytes: one over MAX_ASSET_BYTES.
  const over = validateUpload({ mime: 'image/png', dataBase64: 'A'.repeat(2_666_668) });
  assert.strictEqual(over.ok, false);
  assert.ok(/too large/.test(over.error), 'the error names the problem');
  // Exactly 2_000_000 bytes needs padding: 2_666_668 chars incl. one '='.
  const atCap = validateUpload({ mime: 'image/png', dataBase64: 'A'.repeat(2_666_667) + '=' });
  assert.strictEqual(atCap.ok, true, 'exactly MAX_ASSET_BYTES decoded is allowed');
  assert.strictEqual(atCap.size, MAX_ASSET_BYTES);
});

test('base64 shape: junk, bad length, data: URLs and non-strings are all refused, never thrown', () => {
  assert.strictEqual(validateUpload({ mime: 'image/png', dataBase64: 'not base64!!!' }).ok, false);
  assert.strictEqual(validateUpload({ mime: 'image/png', dataBase64: 'abc' }).ok, false, 'length % 4 must be 0');
  assert.strictEqual(validateUpload({ mime: 'image/png', dataBase64: '' }).ok, false);
  assert.strictEqual(validateUpload({ mime: 'image/png', dataBase64: 12345 }).ok, false);
  const dataUrl = validateUpload({ mime: 'image/png', dataBase64: 'data:image/png;base64,' + PNG_B64 });
  assert.strictEqual(dataUrl.ok, false);
  assert.ok(/data: URL/.test(dataUrl.error), 'the likeliest client mistake gets a pointed error');
  assert.strictEqual(validateUpload(null).ok, false, 'a null body is a refusal, not a throw');
});

test('hostile filenames lose their markup, quotes and path separators, and are capped at 80', () => {
  const v = validateUpload({
    filename: '../../etc/<img onerror=x>"pass\\wd".png',
    mime: 'image/png',
    dataBase64: PNG_B64,
  });
  assert.strictEqual(v.ok, true, 'a hostile NAME never sinks a valid upload');
  assert.ok(!/[<>"'\\/]/.test(v.filename), 'no markup, quotes or separators survive');
  assert.ok(v.filename.length <= 80);
  assert.strictEqual(sanitizeFilename('x'.repeat(200)).length, 80, 'cap is 80');
  assert.strictEqual(sanitizeFilename('<//>'), 'image', 'a name that sanitises to nothing falls back');
});

// ---- base64 -> bytes: both runtime decode paths -------------------------------
// b64ToBytes picks Buffer here (Node); b64ToBytesAtob is the branch a Workers
// isolate without nodejs_compat would take — Node ≥16 exposes global atob, so
// the exact Workers code path runs under node --test too.

test('the png fixture decodes to its real bytes on the Buffer path and the atob path alike', () => {
  const viaBuffer = b64ToBytes(PNG_B64);
  const viaAtob = b64ToBytesAtob(PNG_B64);
  assert.ok(viaBuffer instanceof Uint8Array);
  assert.strictEqual(viaBuffer.length, PNG_SIZE);
  assert.deepStrictEqual(Array.from(viaBuffer.slice(0, 8)), PNG_SIGNATURE, 'PNG signature survives the decode');
  assert.deepStrictEqual(Array.from(viaAtob), Array.from(viaBuffer), 'both decode paths agree byte-for-byte');
  assert.deepStrictEqual(Array.from(viaBuffer), Array.from(Buffer.from(PNG_B64, 'base64')), 'and match Node\'s reference decode');
});

// ---- put/get/del roundtrip against the KV interface ---------------------------

test('put stores {mime, base64} under assetbytes:, get decodes it back, del makes it a miss', async () => {
  const kv = fakeKv();
  const id = 'abc123def456';

  assert.strictEqual(await putAssetBytes(kv, id, { base64: PNG_B64, mime: 'image/png' }), true);
  assert.ok(kv.map.has(BYTES_PREFIX + id), 'stored under the assetbytes: prefix');
  assert.deepStrictEqual(JSON.parse(kv.map.get(BYTES_PREFIX + id)), { mime: 'image/png', base64: PNG_B64 },
    'the KV value is the documented JSON wrapper');

  const got = await getAssetBytes(kv, id);
  assert.strictEqual(got.mime, 'image/png');
  assert.deepStrictEqual(Array.from(got.bytes), Array.from(Buffer.from(PNG_B64, 'base64')),
    'roundtripped bytes are byte-equal to the original image');

  assert.strictEqual(await delAssetBytes(kv, id), true);
  assert.strictEqual(kv.map.has(BYTES_PREFIX + id), false, 'delete() kv: the key is really gone');
  assert.strictEqual(await getAssetBytes(kv, id), null, 'a deleted asset reads as a miss');
});

test('a kv without delete() (the fs shim) gets a tombstone that still reads as a miss', async () => {
  const kv = fakeKv();
  delete kv.delete; // server/store-fs.js has no delete
  const id = 'abc123def456';
  await putAssetBytes(kv, id, { base64: PNG_B64, mime: 'image/png' });
  assert.strictEqual(await delAssetBytes(kv, id), true);
  assert.strictEqual(await getAssetBytes(kv, id), null, 'tombstoned bytes are gone as far as any caller can tell');
});

test('junk ids, missing kv and corrupt stored values are refusals and misses, never throws', async () => {
  const kv = fakeKv();
  assert.strictEqual(await putAssetBytes(kv, '../etc/passwd', { base64: PNG_B64, mime: 'image/png' }), false);
  assert.strictEqual(kv.map.size, 0, 'a refused put writes nothing');
  assert.strictEqual(await putAssetBytes(kv, 'abc123def456', { mime: 'image/png' }), false, 'no base64, no write');
  assert.strictEqual(await putAssetBytes(null, 'abc123def456', { base64: PNG_B64, mime: 'image/png' }), false);
  assert.strictEqual(await getAssetBytes(null, 'abc123def456'), null);
  assert.strictEqual(await getAssetBytes(kv, 'abc123def456'), null, 'a never-written id is a miss');
  assert.strictEqual(await delAssetBytes(kv, 'abc123def456'), true, 'deleting a miss is idempotent success');

  kv.map.set(BYTES_PREFIX + 'abc123def456', 'not json at all');
  assert.strictEqual(await getAssetBytes(kv, 'abc123def456'), null, 'corrupt value reads as a miss');
  kv.map.set(BYTES_PREFIX + 'abc123def456', '{"mime":"image/png"}');
  assert.strictEqual(await getAssetBytes(kv, 'abc123def456'), null, 'a wrapper without base64 is a miss');

  assert.strictEqual(isAssetId('abc123def456'), true);
  assert.strictEqual(isAssetId('ABC'), false, 'uppercase/short ids fail the shared id shape');
});

// ---- R2 backend: the same trio, raw bytes, picked by isR2Bucket() -----------
// A Map-backed stand-in for the Cloudflare R2 bucket binding: head() is the tell
// that makes putAssetBytes/getAssetBytes/delAssetBytes take the raw-bytes path,
// and get() hands back an R2ObjectBody (arrayBuffer() + httpMetadata.contentType)
// exactly as the real binding does. The point of these tests: the route handlers
// call the SAME three functions whether the store is KV or R2.
function fakeR2() {
  const map = new Map(); // key -> { bytes: Uint8Array, contentType }
  return {
    map,
    async head(key) {
      return map.has(key) ? { httpMetadata: { contentType: map.get(key).contentType } } : null;
    },
    async put(key, bytes, opts) {
      const contentType = opts && opts.httpMetadata && opts.httpMetadata.contentType;
      map.set(key, { bytes: new Uint8Array(bytes), contentType });
    },
    async get(key) {
      if (!map.has(key)) return null;
      const o = map.get(key);
      return {
        httpMetadata: { contentType: o.contentType },
        async arrayBuffer() {
          return o.bytes.buffer.slice(o.bytes.byteOffset, o.bytes.byteOffset + o.bytes.byteLength);
        },
      };
    },
    async delete(key) { map.delete(key); },
  };
}

test('isR2Bucket tells an R2 bucket (head + put) from a KV namespace and junk', () => {
  assert.strictEqual(isR2Bucket(fakeR2()), true, 'head() + put() is the R2 tell');
  assert.strictEqual(isR2Bucket(fakeKv()), false, 'a KV namespace has no head()');
  assert.strictEqual(isR2Bucket(null), false);
  assert.strictEqual(isR2Bucket({ put() {} }), false, 'put alone is not an R2 bucket');
  assert.strictEqual(isR2Bucket({ head() {} }), false, 'head without put is not a bucket');
});

test('the same trio stores RAW bytes in R2 (no base64 tax), decodes them back, and deletes', async () => {
  const r2 = fakeR2();
  const id = 'abc123def456';

  assert.strictEqual(await putAssetBytes(r2, id, { base64: PNG_B64, mime: 'image/png' }), true);
  const stored = r2.map.get(BYTES_PREFIX + id);
  assert.ok(stored.bytes instanceof Uint8Array, 'R2 holds the decoded bytes, not a JSON wrapper');
  assert.strictEqual(stored.bytes.length, PNG_SIZE, 'exactly the decoded image, no base64 inflation');
  assert.strictEqual(stored.contentType, 'image/png', 'the mime rides httpMetadata');
  assert.deepStrictEqual(Array.from(stored.bytes.slice(0, 8)), PNG_SIGNATURE, 'PNG signature intact in R2');

  const got = await getAssetBytes(r2, id);
  assert.strictEqual(got.mime, 'image/png', 'mime comes back off httpMetadata, not a wrapper');
  assert.deepStrictEqual(Array.from(got.bytes), Array.from(Buffer.from(PNG_B64, 'base64')),
    'R2 roundtrip is byte-equal to the original image');

  assert.strictEqual(await delAssetBytes(r2, id), true);
  assert.strictEqual(r2.map.has(BYTES_PREFIX + id), false, 'R2 delete really removes the object');
  assert.strictEqual(await getAssetBytes(r2, id), null, 'a deleted R2 object reads as a miss');
});

test('R2 misses and a junk id are misses/refusals, never throws', async () => {
  const r2 = fakeR2();
  assert.strictEqual(await getAssetBytes(r2, 'abc123def456'), null, 'a never-written R2 id is a miss');
  assert.strictEqual(await putAssetBytes(r2, '../etc/passwd', { base64: PNG_B64, mime: 'image/png' }), false);
  assert.strictEqual(r2.map.size, 0, 'a refused put writes nothing to R2 either');
  assert.strictEqual(await delAssetBytes(r2, 'abc123def456'), true, 'deleting a missing R2 object is idempotent success');
});
