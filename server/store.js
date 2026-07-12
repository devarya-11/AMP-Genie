'use strict';

// KV-backed persistence for v2 builds, slates and brand kits, sharing the
// namespace already bound as HISTORY (see functions/_lib/history.js). Every
// function here is a pure function of a `kv` handle implementing the
// Cloudflare-KV subset { get(key, type), put(key, value) } — the Pages
// Functions pass the real binding, the Express dev server passes the
// filesystem shim from server/store-fs.js. Same best-effort contract as
// history: a failed read is null, a failed write is false, and neither ever
// throws into the request that triggered it.

// The one dependency this module allows itself: the vertical allowlist for
// kit patches. content.js is a pure data module with no requires of its own,
// so this can never form a cycle and stays bundleable for the Workers runtime.
const { VERTICALS } = require('./content');

// "" / whitespace-only counts as "no brief given" (null), distinct from a real
// (if short) brief. Lives HERE (not server/history.js) because history.js
// touches __dirname/fs at module load — Node-only — while this pure helper is
// needed by the shared pipeline modules that must also bundle for the Workers
// runtime. history.js re-exports it so existing Node callers keep working.
function normalizeBrief(raw) {
  const trimmed = String(raw || '').trim();
  return trimmed ? trimmed : null;
}

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
// A kit carries { slug, name, primary?, accent?, vertical?, site?, logoUrl?,
// heroUrl?, products?, voiceSample?, source, updatedAt, updatedBy? } — the
// resolved-brand shape frozen at save time (plus the v3.2 editor fields), so
// a later live resolve can't silently change what a saved build renders with.
// primary became OPTIONAL in v3.2: an assets-only kit for a brand whose
// colour the library already knows is legal.
async function getBrandKit(kv, slug) {
  if (!SLUG_SHAPE.test(String(slug || ''))) return null;
  return kvGet(kv, 'brandkit:' + slug);
}
async function putBrandKit(kv, kit) {
  if (!kit || !SLUG_SHAPE.test(String(kit.slug || ''))) return false;
  // primary is optional, but a PRESENT primary that isn't a real '#rrggbb'
  // would poison every build that later trusts it as CSS — still refused at
  // save time, not at render time. Only undefined/null count as "absent";
  // '' is a malformed value, not an absence.
  if (kit.primary !== undefined && kit.primary !== null &&
      !HEX_RRGGBB.test(String(kit.primary))) return false;
  return kvPut(kv, 'brandkit:' + kit.slug, kit);
}

// ---- brand-kit patch sanitation ---------------------------------------------
// The /brandkit editor POSTs arbitrary JSON; only the contract fields may
// reach a stored kit, each scrubbed by the same rules the render side already
// enforces: no '<'/'>' in any string, http(s)-only urls, positive-int prices,
// arrays capped. Everything else in the body (slug, source, updatedAt, junk)
// is ignored — those are stamped by the route, never patched by the client.

const KIT_NAME_MAX = 80;
const KIT_PRODUCTS_MAX = 8;
const KIT_PRODUCT_NAME_MAX = 60;
const KIT_VOICE_SAMPLE_MAX = 1500;

function cleanStr(v) {
  return String(v).replace(/[<>]/g, '').trim();
}

// Same stance as fallback.js's safeUrl: only a plain http(s) URL survives,
// spelled the way the caller sent it. Whitespace/quotes/angle brackets are
// refused outright rather than percent-repaired, so what is stored is exactly
// what was vetted.
function cleanUrl(v) {
  const s = typeof v === 'string' ? v.trim() : '';
  if (!s || /[\s"'<>]/.test(s)) return '';
  try {
    const proto = new URL(s).protocol;
    return proto === 'http:' || proto === 'https:' ? s : '';
  } catch {
    return '';
  }
}

// A product without a valid name is not a product; price and image are
// dropped independently when invalid rather than sinking the whole row.
function cleanProduct(p) {
  if (!p || typeof p !== 'object') return null;
  const name = cleanStr(p.name || '').slice(0, KIT_PRODUCT_NAME_MAX);
  if (!name) return null;
  const out = { name };
  const price = Math.round(Number(p.price));
  if (Number.isFinite(price) && price > 0) out.price = price;
  const image = cleanUrl(p.image);
  if (image) out.image = image;
  return out;
}

// sanitizeKitPatch(body) -> sanitized partial kit | null when nothing valid
// remains. Two deliberate behaviours the /brandkit route (and its editor UI)
// depend on:
//   - CLEAR vs KEEP: an explicit empty string for logoUrl / heroUrl /
//     voiceSample passes through as '' — the "delete this key" marker
//     mergeKitPatch acts on. A field absent from the body never enters the
//     patch (the saved value is kept), and a present-but-INVALID value (bad
//     url, unknown vertical, junk hex) is dropped, not cleared — a typo must
//     not wipe a saved field.
//   - an over-long voiceSample is TRUNCATED to 1500 chars, not rejected:
//     pasted brand copy is exactly the input most likely to run long, and
//     losing the tail beats losing the paste.
function sanitizeKitPatch(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return null;
  const out = {};
  if (typeof patch.name === 'string') {
    const name = cleanStr(patch.name).slice(0, KIT_NAME_MAX);
    if (name) out.name = name;
  }
  if (HEX_RRGGBB.test(String(patch.primary || ''))) out.primary = String(patch.primary).toLowerCase();
  if (HEX_RRGGBB.test(String(patch.accent || ''))) out.accent = String(patch.accent).toLowerCase();
  if (VERTICALS.includes(patch.vertical)) out.vertical = patch.vertical;
  const site = cleanUrl(patch.site);
  if (site) out.site = site;
  for (const key of ['logoUrl', 'heroUrl']) {
    if (typeof patch[key] !== 'string') continue;
    if (!patch[key].trim()) { out[key] = ''; continue; } // explicit clear
    const url = cleanUrl(patch[key]);
    if (url) out[key] = url;
  }
  if (typeof patch.voiceSample === 'string') {
    if (!patch.voiceSample.trim()) {
      out.voiceSample = ''; // explicit clear
    } else {
      const sample = cleanStr(patch.voiceSample).slice(0, KIT_VOICE_SAMPLE_MAX);
      if (sample) out.voiceSample = sample;
    }
  }
  if (Array.isArray(patch.products)) {
    // The raw slice bounds a hostile payload; the contract cap of 8 is
    // applied AFTER junk rows are dropped, so a junk row never evicts a
    // valid product.
    const products = patch.products.slice(0, 24).map(cleanProduct)
      .filter(Boolean).slice(0, KIT_PRODUCTS_MAX);
    if (products.length) out.products = products;
  }
  return Object.keys(out).length ? out : null;
}

// mergeKitPatch(existing, patch) -> the record to save. Patch values win,
// '' means "clear" (the key is deleted — it is the marker sanitizeKitPatch
// emits for an explicit empty string), and anything untouched keeps its
// saved value. Lives here rather than in the route handler so the
// clear-vs-keep contract is unit-testable next to the sanitiser feeding it.
function mergeKitPatch(existing, patch) {
  const merged = { ...(existing || {}), ...(patch || {}) };
  for (const key of Object.keys(merged)) {
    if (merged[key] === '') delete merged[key];
  }
  return merged;
}

// ---- slate index ------------------------------------------------------------
// A single newest-first list of slate SUMMARIES (never full records) so the
// Pitches view can list the team's work without a KV list() scan — the same
// single-key, capped, read-modify-write pattern as the history list, with the
// same caveat: not atomic under concurrent writers, acceptable for a team
// review aid.
const SLATE_INDEX_KEY = 'slates:index';
const SLATE_INDEX_MAX = 100;

async function readSlateIndex(kv) {
  if (!kv) return [];
  try {
    const parsed = await kv.get(SLATE_INDEX_KEY, 'json');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function appendSlateIndex(kv, slate) {
  if (!kv || !slate || !ID_SHAPE.test(String(slate.id || ''))) return false;
  const list = await readSlateIndex(kv);
  list.unshift({
    id: slate.id,
    ts: slate.ts,
    author: slate.author || null,
    brand: slate.brand,
    title: slate.title,
    buildIds: slate.buildIds || [],
  });
  if (list.length > SLATE_INDEX_MAX) list.length = SLATE_INDEX_MAX;
  return kvPut(kv, SLATE_INDEX_KEY, list);
}

module.exports = {
  newId, brandSlug, normalizeBrief,
  getBuild, putBuild, getSlate, putSlate, getBrandKit, putBrandKit,
  sanitizeKitPatch, mergeKitPatch,
  readSlateIndex, appendSlateIndex,
};
