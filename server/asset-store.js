'use strict';

// Byte storage for uploaded brand assets (Genie 2.0 desktop image uploads),
// behind a deliberately tiny put/get/del interface so the backing store can
// change without touching a route handler.
//
// TODAY the bytes live in the same KV namespace as everything else (bound as
// HISTORY), JSON-wrapped as { mime, base64 } under 'assetbytes:' + id. KV's
// value cap is 25MB; our upload cap (MAX_ASSET_BYTES, 2MB decoded) sits far
// below it, so a vetted upload can never hit the KV limit.
//
// R2 (DONE): putAssetBytes/getAssetBytes/delAssetBytes now take EITHER a KV
// namespace OR an R2 bucket and branch on isR2Bucket() — R2 stores the raw
// bytes (env.ASSETS.put(key, bytes, { httpMetadata: { contentType } }) / .get /
// .delete, no base64 tax), KV keeps the JSON-wrapped { mime, base64 } record.
// The route handlers only ever see put/get/del, so which store backs the bytes
// is confined to this file; the caller picks the store by binding presence
// (r2 || kv) and never learns which one answered.
//
// Runtime-agnostic on purpose: no fs/path/__dirname, decode picks Buffer
// (Node, and Workers under nodejs_compat) or atob (Workers-native) by a
// typeof check. Same best-effort voice as server/store.js: a failed read is
// null, a failed write is false, and nothing here ever throws into the
// request that triggered it.

const BYTES_PREFIX = 'assetbytes:';

// Decoded-size cap. 2MB is generous for an email hero/logo/product shot and
// keeps the JSON-wrapped KV value (~2.7MB of base64) an order of magnitude
// under KV's 25MB ceiling.
const MAX_ASSET_BYTES = 2_000_000;
const FILENAME_MAX = 80;

// Image-only allowlist; 'image/jpg' is not a real IANA type but clients send
// it anyway, so it is accepted and normalised to image/jpeg at validate time.
const MIME_ALLOWED = ['image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp'];

// Canonical base64 only (what btoa / FileReader.readAsDataURL emit): no
// whitespace, no URL-safe alphabet, padded to a multiple of 4. Refused
// outright rather than repaired — same stance as store.js's cleanUrl — so
// what is stored is exactly what was vetted.
const BASE64_SHAPE = /^[A-Za-z0-9+/]+={0,2}$/;

// Asset ids come from store.js's newId() (12 lowercase hex chars) but the
// shape check matches store.js's ID_SHAPE so shared ids stay interchangeable.
const ID_SHAPE = /^[a-z0-9-]{6,64}$/;

function isAssetId(id) {
  return ID_SHAPE.test(String(id || ''));
}

// '<'/'>' stripped everywhere (house rule), plus everything that could break
// out of a Content-Disposition header or smuggle a path: quotes, backslashes,
// forward slashes, control chars. An empty survivor falls back to 'image'
// rather than failing the upload over a junk name.
function sanitizeFilename(raw) {
  const cleaned = String(raw || '')
    .replace(/[<>"'\\/]/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, FILENAME_MAX);
  return cleaned || 'image';
}

// The exact decoded size of well-formed base64 (validated above), not an
// estimate: length*3/4 minus the padding chars.
function decodedSize(base64) {
  const pad = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  return Math.floor(base64.length * 3 / 4) - pad;
}

// validateUpload({ filename, mime, dataBase64 }) -> { ok:false, error } or
// { ok:true, filename, mime, size } with the sanitized filename, normalised
// mime and exact decoded byte size the route should trust from here on.
// Never throws, whatever the client sent.
function validateUpload(body) {
  const { filename, mime, dataBase64 } = body && typeof body === 'object' ? body : {};

  const mimeNorm = String(mime || '').toLowerCase().trim();
  if (!MIME_ALLOWED.includes(mimeNorm)) {
    return { ok: false, error: 'mime must be one of: ' + MIME_ALLOWED.join(', ') };
  }

  if (typeof dataBase64 !== 'string' || !dataBase64) {
    return { ok: false, error: 'dataBase64 (base64-encoded image bytes) is required' };
  }
  // A pasted data: URL is the most likely malformed input — name the fix
  // instead of a generic shape error.
  if (dataBase64.startsWith('data:')) {
    return { ok: false, error: 'send raw base64, not a data: URL (strip the data:...;base64, prefix)' };
  }
  if (dataBase64.length % 4 !== 0 || !BASE64_SHAPE.test(dataBase64)) {
    return { ok: false, error: 'dataBase64 is not valid base64' };
  }

  const size = decodedSize(dataBase64);
  if (size <= 0) return { ok: false, error: 'dataBase64 decodes to zero bytes' };
  if (size > MAX_ASSET_BYTES) {
    return { ok: false, error: 'image too large: ' + size + ' bytes decoded, cap is ' + MAX_ASSET_BYTES };
  }

  return {
    ok: true,
    filename: sanitizeFilename(filename),
    // 'image/jpg' normalises to the real type so downstream content-type
    // headers are always spec-legal.
    mime: mimeNorm === 'image/jpg' ? 'image/jpeg' : mimeNorm,
    size,
  };
}

// ---- base64 -> bytes ---------------------------------------------------------
// Two decoders, picked by runtime capability. Node (and Workers under the
// nodejs_compat flag this project deploys with) take the Buffer path — native
// code, no JS loop. A Workers isolate without Buffer takes the atob path,
// which is Workers-native. Both are exported so tests can exercise each
// explicitly (Node ≥16 has global atob too).

function b64ToBytesAtob(base64) {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function b64ToBytes(base64) {
  if (typeof Buffer !== 'undefined' && typeof Buffer.from === 'function') {
    const buf = Buffer.from(base64, 'base64');
    // A view over the same memory, but typed as the Uint8Array callers expect.
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  return b64ToBytesAtob(base64);
}

// ---- the swappable store -----------------------------------------------------

// R2 buckets expose head(); KV namespaces (and the tests' Map-backed fake, and
// the Express fs shim) do not. That one-method tell is the whole discriminator
// — it lets the trio serve either backing store while every route handler sees
// only put/get/del. Guarded on put() too so a stray object with a head method
// can never be mistaken for a bucket.
function isR2Bucket(store) {
  return !!store && typeof store.head === 'function' && typeof store.put === 'function';
}

// putAssetBytes(store, id, { base64, mime }) -> true/false. store is a KV
// namespace OR an R2 bucket. Assumes the caller already ran validateUpload;
// still refuses a junk id or payload so a bug upstream can't write an unkeyed
// or unreadable record. R2 gets the decoded bytes (content type on
// httpMetadata); KV keeps the JSON-wrapped { mime, base64 }.
async function putAssetBytes(store, id, payload) {
  if (!store || !isAssetId(id)) return false;
  const { base64, mime } = payload || {};
  if (typeof base64 !== 'string' || !base64 || typeof mime !== 'string' || !mime) return false;
  try {
    if (isR2Bucket(store)) {
      await store.put(BYTES_PREFIX + id, b64ToBytes(base64), { httpMetadata: { contentType: mime } });
    } else {
      await store.put(BYTES_PREFIX + id, JSON.stringify({ mime, base64 }));
    }
    return true;
  } catch (e) {
    console.error('[asset-store] failed to persist ' + id + ':', e && e.message);
    return false;
  }
}

// getAssetBytes(store, id) -> { mime, bytes: Uint8Array } | null. R2 hands back
// an R2ObjectBody (arrayBuffer() + httpMetadata.contentType); KV hands back the
// JSON record. Either way the caller gets the same { mime, bytes } shape.
async function getAssetBytes(store, id) {
  if (!store || !isAssetId(id)) return null;
  try {
    if (isR2Bucket(store)) {
      const obj = await store.get(BYTES_PREFIX + id);
      if (!obj) return null;
      const mime = (obj.httpMetadata && obj.httpMetadata.contentType) || 'application/octet-stream';
      const buf = await obj.arrayBuffer();
      return { mime: String(mime), bytes: new Uint8Array(buf) };
    }
    const value = await store.get(BYTES_PREFIX + id, 'json');
    if (!value || typeof value !== 'object' || typeof value.base64 !== 'string' || !value.base64) return null;
    return { mime: String(value.mime || 'application/octet-stream'), bytes: b64ToBytes(value.base64) };
  } catch {
    return null;
  }
}

// delAssetBytes(store, id) -> true/false. R2 and real KV (and the tests' fake)
// expose delete(); the Express dev server's fs shim (server/store-fs.js)
// predates deletes, so a kv without one gets a 'null' tombstone instead —
// getAssetBytes reads that back as a miss, which is all "deleted" means here.
async function delAssetBytes(store, id) {
  if (!store || !isAssetId(id)) return false;
  try {
    if (isR2Bucket(store) || typeof store.delete === 'function') await store.delete(BYTES_PREFIX + id);
    else await store.put(BYTES_PREFIX + id, 'null');
    return true;
  } catch (e) {
    console.error('[asset-store] failed to delete ' + id + ':', e && e.message);
    return false;
  }
}

// ---- Supabase Storage backend (the system of record for image bytes) --------
// Hriday's call: the shared data lives in Supabase, not Cloudflare — images
// included. The bucket ('brand-assets') is PUBLIC, so an uploaded image gets a
// permanent CDN URL that goes straight into emails and <img> tags with no
// serving route and no auth: {url}/storage/v1/object/public/{bucket}/{path}.
// The KV put/get/del trio above stays as the zero-config dev fallback when no
// SUPABASE_URL is configured.
//
// Auth note: the new-format sb_secret_* keys authenticate via the `apikey`
// header ALONE — an Authorization: Bearer header makes storage-api try to
// parse the value as a legacy JWT and 403 ("Invalid Compact JWS"), verified
// against this very project. Do not add one.

function createSupabaseStorage({ url, secretKey, bucket = 'brand-assets', fetchImpl = fetch } = {}) {
  const base = String(url || '').replace(/\/+$/, '');
  if (!base || !secretKey) return null;

  // Object paths are '<brandSlug>/<id>-<filename>' — readable in the
  // dashboard, unique via the id, safe via sanitizeFilename (no slashes).
  function objectPath(brandSlug, id, filename) {
    const slug = String(brandSlug || 'misc').toLowerCase().replace(/[^a-z0-9]/g, '') || 'misc';
    return slug + '/' + id + '-' + sanitizeFilename(filename);
  }

  function publicUrl(path) {
    return base + '/storage/v1/object/public/' + bucket + '/' + path;
  }

  // putObject(path, bytes, mime) -> public URL | null. x-upsert makes retries
  // idempotent (same path overwrites rather than 409ing).
  async function putObject(path, bytes, mime) {
    try {
      const res = await fetchImpl(base + '/storage/v1/object/' + bucket + '/' + path, {
        method: 'POST',
        headers: { apikey: secretKey, 'content-type': mime, 'x-upsert': 'true' },
        body: bytes,
      });
      if (!res.ok) {
        console.error('[asset-store] supabase upload failed:', res.status, (await res.text().catch(() => '')).slice(0, 120));
        return null;
      }
      return publicUrl(path);
    } catch (e) {
      console.error('[asset-store] supabase upload failed:', e && e.message);
      return null;
    }
  }

  async function delObject(path) {
    try {
      const res = await fetchImpl(base + '/storage/v1/object/' + bucket + '/' + path, {
        method: 'DELETE',
        headers: { apikey: secretKey },
      });
      return res.ok;
    } catch (e) {
      console.error('[asset-store] supabase delete failed:', e && e.message);
      return false;
    }
  }

  return { objectPath, publicUrl, putObject, delObject, bucket };
}

module.exports = {
  BYTES_PREFIX, MAX_ASSET_BYTES, FILENAME_MAX, MIME_ALLOWED,
  isAssetId, sanitizeFilename, validateUpload,
  b64ToBytes, b64ToBytesAtob,
  isR2Bucket, putAssetBytes, getAssetBytes, delAssetBytes,
  createSupabaseStorage,
};
