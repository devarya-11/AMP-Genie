'use strict';

// KV-backed persistence for v2 builds, slates and brand kits, sharing the
// namespace already bound as HISTORY (see functions/_lib/history.js). Every
// function here is a pure function of a `kv` handle implementing the
// Cloudflare-KV subset { get(key, type), put(key, value) } — the Pages
// Functions pass the real binding, the Express dev server passes the
// filesystem shim from server/store-fs.js. Same best-effort contract as
// history: a failed read is null, a failed write is false, and neither ever
// throws into the request that triggered it.

// Ids are 12 lowercase hex chars (48 bits) cut from crypto.randomUUID(),
// which Node 18+ and Workers both expose as a global — no Date.now or
// Math.random, which are guessable and can collide under concurrency.
function newId() {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 12);
}

// Mirrors libKey in server/brand.js so a kit saved for "Taj Hotels" is found
// again by the same normalisation the brand library already uses.
function brandSlug(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Ids and slugs become KV key suffixes, so anything outside these shapes is
// junk (or hostile — '../etc') and is refused before it ever reaches the kv.
const ID_SHAPE = /^[a-z0-9-]{6,64}$/;
const SLUG_SHAPE = /^[a-z0-9]{1,64}$/;

// The strict final form hexNorm (server/brand.js) produces — hexNorm itself
// isn't exported, and a stored kit only needs the already-normalised
// '#rrggbb' shape, not the 3-digit/#-less inputs hexNorm exists to repair.
const HEX_RRGGBB = /^#[0-9a-f]{6}$/i;

async function kvGet(kv, key) {
  if (!kv) return null;
  try {
    const value = await kv.get(key, 'json');
    // A non-object under the key is junk or a corrupt write, not a record.
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

async function kvPut(kv, key, value) {
  if (!kv) return false;
  try {
    await kv.put(key, JSON.stringify(value));
    return true;
  } catch (e) {
    console.error('[store] failed to persist ' + key + ':', e && e.message);
    return false;
  }
}

// ---- builds ---------------------------------------------------------------
async function getBuild(kv, id) {
  if (!ID_SHAPE.test(String(id || ''))) return null;
  return kvGet(kv, 'build:' + id);
}
async function putBuild(kv, build) {
  if (!build || !ID_SHAPE.test(String(build.id || ''))) return false;
  return kvPut(kv, 'build:' + build.id, build);
}

// ---- slates ---------------------------------------------------------------
async function getSlate(kv, id) {
  if (!ID_SHAPE.test(String(id || ''))) return null;
  return kvGet(kv, 'slate:' + id);
}
async function putSlate(kv, slate) {
  if (!slate || !ID_SHAPE.test(String(slate.id || ''))) return false;
  return kvPut(kv, 'slate:' + slate.id, slate);
}

// ---- brand kits -----------------------------------------------------------
// A kit carries { slug, name, primary, accent, vertical, logoUrl, site,
// source, updatedAt } — the resolved-brand shape frozen at save time, so a
// later live resolve can't silently change what a saved build renders with.
async function getBrandKit(kv, slug) {
  if (!SLUG_SHAPE.test(String(slug || ''))) return null;
  return kvGet(kv, 'brandkit:' + slug);
}
async function putBrandKit(kv, kit) {
  if (!kit || !SLUG_SHAPE.test(String(kit.slug || ''))) return false;
  // A kit whose primary isn't a real '#rrggbb' would poison every build that
  // later trusts it as CSS — refuse it at save time, not at render time.
  if (!HEX_RRGGBB.test(String(kit.primary || ''))) return false;
  return kvPut(kv, 'brandkit:' + kit.slug, kit);
}

module.exports = {
  newId, brandSlug,
  getBuild, putBuild, getSlate, putSlate, getBrandKit, putBrandKit,
};
