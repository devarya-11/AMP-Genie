'use strict';

// DAOs for the Genie 2.0 relational model: BRAND -> many PITCHES -> many
// EXAMPLES, with brand-owned products/contacts/assets, app-wide settings and
// an activity feed. Every function takes the db handle (server/db.js) as its
// FIRST argument and holds no state, so one implementation serves both the
// Express dev server (node:sqlite) and the Pages Functions (D1).
//
// Trust boundary lives HERE: client strings are sanitised before any SQL —
// '<'/'>' stripped everywhere, http(s)-only urls, capped lengths, id/slug
// shapes enforced — and invalid input comes back as null/false, never as a
// throw into the request. The exception is amp_html/doc_json/params_json:
// those are produced by the build pipeline (generate + real validator),
// never typed by a client, and are stored verbatim.
//
// Bundling contract: requires only ./store (pure) — no fs/path/__dirname.

const { newId, brandSlug, sanitizeKitPatch } = require('./store');

// Same shapes store.js enforces for its KV keys — store.js keeps them
// private, so they are restated here rather than exported (noted in the
// phase notes; the regexes are the contract, not the constant).
const ID_SHAPE = /^[a-z0-9-]{6,64}$/;
const SLUG_SHAPE = /^[a-z0-9]{1,64}$/;

// cleanStr/cleanUrl mirror store.js's private helpers (same rules: strip
// angle brackets, refuse non-http(s) and whitespace/quote-bearing urls).
function cleanStr(v) {
  return String(v).replace(/[<>]/g, '').trim();
}
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

const NAME_MAX = 80;
const TITLE_MAX = 120;
const GOAL_MAX = 200;
const BRIEF_MAX = 4000;
const TWEAK_PROMPT_MAX = 500;
const DETAIL_MAX = 300;
const PRODUCTS_MAX = 8; // same tile cap the v2 kit editor enforced

function nowIso() {
  return new Date().toISOString();
}

// A capped, sanitised optional-text field: absent/non-string stays absent
// (undefined), '' clears (null), anything else is stripped and capped.
function optText(v, max) {
  if (typeof v !== 'string') return undefined;
  const s = cleanStr(v).slice(0, max);
  return s || null;
}

// params/doc arrive as objects from the pipeline (or as already-serialised
// JSON when replayed from another store). Anything unserialisable is null —
// a build never fails because a log field would not stringify.
function toJsonOrNull(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') {
    try { JSON.parse(value); return value; } catch { return null; }
  }
  try { return JSON.stringify(value) || null; } catch { return null; }
}

// ---- brands -------------------------------------------------------------------

// kit-field -> column map, shared by upsertBrand and setBrandKitFields so the
// v2 sanitizeKitPatch contract (validate, drop-invalid, ''-clears) drives the
// v3 brands table with ONE mapping.
const KIT_COLUMNS = {
  name: 'name',
  primary: 'primary_hex',
  accent: 'accent_hex',
  vertical: 'vertical',
  site: 'site',
  logoUrl: 'logo_url',
  heroUrl: 'hero_url',
  voiceSample: 'voice_sample',
};

function kitPatchToSets(patch) {
  const sets = [];
  const params = [];
  for (const key of Object.keys(KIT_COLUMNS)) {
    if (!(key in patch)) continue;
    sets.push(KIT_COLUMNS[key] + ' = ?');
    params.push(patch[key] === '' ? null : patch[key]); // '' is the sanitiser's clear marker
  }
  return { sets, params };
}

// upsertBrand(db, { slug?, name, primaryHex?, accentHex?, vertical?, site?,
// logoUrl?, heroUrl?, voiceSample?, dossier?, createdBy? }) -> row | null.
// Field validation is delegated to store.js's sanitizeKitPatch (identical
// rules to the v2 kit editor); the slug is derived from the name via
// brandSlug when not supplied. SELECT-then-write rather than ON CONFLICT so
// only the fields present update — same non-atomicity caveat (and the same
// acceptance of it) as the slate index: last team-mate wins, for a team tool.
async function upsertBrand(db, input) {
  if (!input || typeof input !== 'object') return null;
  const patch = sanitizeKitPatch({
    name: input.name,
    primary: input.primaryHex !== undefined ? input.primaryHex : input.primary,
    accent: input.accentHex !== undefined ? input.accentHex : input.accent,
    vertical: input.vertical,
    site: input.site,
    logoUrl: input.logoUrl,
    heroUrl: input.heroUrl,
    voiceSample: input.voiceSample,
  }) || {};
  const slug = SLUG_SHAPE.test(String(input.slug || ''))
    ? String(input.slug)
    : brandSlug(patch.name || '');
  if (!SLUG_SHAPE.test(slug)) return null;

  // dossier is server-built (brand-research), not client-typed: stored as
  // JSON when it serialises, dropped (not cleared) otherwise.
  const dossierJson = input.dossier !== undefined ? toJsonOrNull(input.dossier) : undefined;

  const existing = await getBrandBySlug(db, slug);
  const ts = nowIso();
  if (!existing) {
    if (!patch.name) return null; // a NEW brand must bring a valid name
    const id = newId();
    await db.run(
      'INSERT INTO brands (id, slug, name, primary_hex, accent_hex, vertical, site, logo_url, hero_url, voice_sample, dossier_json, created_by, created_at, updated_at) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [id, slug, patch.name,
        patch.primary || null, patch.accent || null, patch.vertical || null,
        patch.site || null, patch.logoUrl || null, patch.heroUrl || null,
        patch.voiceSample || null, dossierJson === undefined ? null : dossierJson,
        optText(input.createdBy, NAME_MAX) || null, ts, ts]);
    return getBrandById(db, id);
  }
  const { sets, params } = kitPatchToSets(patch);
  if (dossierJson !== undefined && dossierJson !== null) {
    sets.push('dossier_json = ?');
    params.push(dossierJson);
  }
  if (!sets.length) return existing; // nothing valid to change — not an error
  sets.push('updated_at = ?');
  params.push(ts, existing.id);
  await db.run('UPDATE brands SET ' + sets.join(', ') + ' WHERE id = ?', params);
  return getBrandById(db, existing.id);
}

async function getBrandBySlug(db, slug) {
  if (!SLUG_SHAPE.test(String(slug || ''))) return null;
  return db.first('SELECT * FROM brands WHERE slug = ?', [String(slug)]);
}

async function getBrandById(db, id) {
  if (!ID_SHAPE.test(String(id || ''))) return null;
  return db.first('SELECT * FROM brands WHERE id = ?', [String(id)]);
}

// listBrands(db) -> light rows (dossier_json excluded — it is the one column
// that can run long) plus the counters the Brands view renders. Correlated
// subqueries beat four joins here: SQLite flattens them per-row against the
// idx_*_brand indexes, and there is no group-by fan-out to deduplicate.
async function listBrands(db) {
  return db.all(
    'SELECT b.id, b.slug, b.name, b.primary_hex, b.accent_hex, b.vertical, b.site, ' +
    'b.logo_url, b.hero_url, b.voice_sample, b.created_by, b.created_at, b.updated_at, ' +
    '(SELECT COUNT(*) FROM pitches p WHERE p.brand_id = b.id) AS pitchCount, ' +
    '(SELECT COUNT(*) FROM examples e WHERE e.brand_id = b.id) AS exampleCount, ' +
    '(SELECT COUNT(*) FROM assets a WHERE a.brand_id = b.id) AS assetCount, ' +
    '(SELECT MAX(ac.ts) FROM activity ac WHERE ac.brand_id = b.id) AS lastActivityAt ' +
    'FROM brands b ORDER BY b.updated_at DESC, b.rowid DESC');
}

// setBrandKitFields(db, id, patch) -> updated row | null. The v2 kit-editor
// contract, verbatim (it IS sanitizeKitPatch): present-and-valid updates,
// present-but-invalid is dropped (a typo never wipes a saved field), '' on
// the clearable fields nulls the column. patch.products is IGNORED here —
// products are rows now, the route pairs this with replaceProducts.
async function setBrandKitFields(db, id, rawPatch) {
  if (!ID_SHAPE.test(String(id || ''))) return null;
  const patch = sanitizeKitPatch(rawPatch);
  if (!patch) return null;
  const { sets, params } = kitPatchToSets(patch);
  if (!sets.length) return getBrandById(db, id); // e.g. products-only patch
  sets.push('updated_at = ?');
  params.push(nowIso(), String(id));
  const { changes } = await db.run('UPDATE brands SET ' + sets.join(', ') + ' WHERE id = ?', params);
  return changes ? getBrandById(db, id) : null;
}

// ---- products -------------------------------------------------------------------

// Same row rules as store.js's cleanProduct (name required, positive-int
// price, http(s) image), extended with the assets link: an id-shaped assetId
// survives, anything else is dropped with the field, never the row.
function cleanProductRow(p) {
  if (!p || typeof p !== 'object') return null;
  const name = cleanStr(p.name || '').slice(0, 60);
  if (!name) return null;
  const out = { name, price: null, imageUrl: null, assetId: null };
  const price = Math.round(Number(p.price));
  if (Number.isFinite(price) && price > 0) out.price = price;
  const image = cleanUrl(p.image !== undefined ? p.image : p.imageUrl);
  if (image) out.imageUrl = image;
  if (ID_SHAPE.test(String(p.assetId || ''))) out.assetId = String(p.assetId);
  return out;
}

// replaceProducts(db, brandId, products[]) -> stored rows | null (unknown
// brand / bad id). Whole-list semantics like the kit editor: what you post
// is what the brand has, ordered, junk rows dropped, capped at 8 AFTER the
// junk filter so a junk row never evicts a valid product. Delete+inserts go
// through db.batch: atomic on D1, transactional locally — a failure leaves
// the previous list intact.
async function replaceProducts(db, brandId, products) {
  const brand = await getBrandById(db, brandId);
  if (!brand) return null;
  const rows = (Array.isArray(products) ? products : [])
    .slice(0, 24).map(cleanProductRow).filter(Boolean).slice(0, PRODUCTS_MAX);
  const statements = [{ sql: 'DELETE FROM products WHERE brand_id = ?', params: [brand.id] }];
  rows.forEach((row, pos) => {
    statements.push({
      sql: 'INSERT INTO products (id, brand_id, name, price, image_url, asset_id, pos) VALUES (?, ?, ?, ?, ?, ?, ?)',
      params: [newId(), brand.id, row.name, row.price, row.imageUrl, row.assetId, pos],
    });
  });
  await db.batch(statements);
  return listProducts(db, brand.id);
}

async function listProducts(db, brandId) {
  if (!ID_SHAPE.test(String(brandId || ''))) return [];
  return db.all(
    'SELECT id, brand_id, name, price, image_url, asset_id, pos FROM products WHERE brand_id = ? ORDER BY pos, rowid',
    [String(brandId)]);
}

// ---- contacts -------------------------------------------------------------------

// Deliberately lite (this is a CRM nicety, not auth): something@something.tld
// with no whitespace or angle brackets. Full RFC 5322 is a famous tarpit.
const EMAIL_LITE = /^[^\s@<>]+@[^\s@<>]+\.[a-z0-9-]{2,24}$/i;

// Kit-patch stance for contact fields: absent keeps, '' clears, invalid
// email is DROPPED (keeps the saved one — a typo must not wipe a field).
// Name can be set but never cleared: a nameless contact is not a contact.
function contactPatch(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out = {};
  if (typeof raw.name === 'string') {
    const name = cleanStr(raw.name).slice(0, NAME_MAX);
    if (name) out.name = name;
  }
  const role = optText(raw.role, NAME_MAX);
  if (role !== undefined) out.role = role;
  const phone = optText(raw.phone, 40);
  if (phone !== undefined) out.phone = phone;
  const notes = optText(raw.notes, 400);
  if (notes !== undefined) out.notes = notes;
  if (typeof raw.email === 'string') {
    const email = cleanStr(raw.email).slice(0, 120);
    if (!email) out.email = null;
    else if (EMAIL_LITE.test(email)) out.email = email;
  }
  return Object.keys(out).length ? out : null;
}

async function addContact(db, brandId, raw) {
  const brand = await getBrandById(db, brandId);
  if (!brand) return null;
  const patch = contactPatch(raw);
  if (!patch || !patch.name) return null; // name is the one required field
  const id = newId();
  await db.run(
    'INSERT INTO contacts (id, brand_id, name, role, email, phone, notes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [id, brand.id, patch.name, patch.role || null, patch.email || null,
      patch.phone || null, patch.notes || null, nowIso()]);
  return db.first('SELECT * FROM contacts WHERE id = ?', [id]);
}

async function updateContact(db, id, raw) {
  if (!ID_SHAPE.test(String(id || ''))) return null;
  const patch = contactPatch(raw);
  if (!patch) return null;
  const sets = [];
  const params = [];
  for (const key of ['name', 'role', 'email', 'phone', 'notes']) {
    if (!(key in patch)) continue;
    sets.push(key + ' = ?');
    params.push(patch[key]);
  }
  if (!sets.length) return null;
  params.push(String(id));
  const { changes } = await db.run('UPDATE contacts SET ' + sets.join(', ') + ' WHERE id = ?', params);
  return changes ? db.first('SELECT * FROM contacts WHERE id = ?', [String(id)]) : null;
}

async function deleteContact(db, id) {
  if (!ID_SHAPE.test(String(id || ''))) return false;
  const { changes } = await db.run('DELETE FROM contacts WHERE id = ?', [String(id)]);
  return changes > 0;
}

async function listContacts(db, brandId) {
  if (!ID_SHAPE.test(String(brandId || ''))) return [];
  return db.all(
    'SELECT * FROM contacts WHERE brand_id = ? ORDER BY created_at DESC, rowid DESC',
    [String(brandId)]);
}

// ---- pitches --------------------------------------------------------------------

// The full lifecycle is just these two; 'won'/'lost' can join the allowlist
// later without a migration (status is unconstrained TEXT).
const PITCH_STATUSES = ['active', 'archived'];

async function createPitch(db, input) {
  if (!input || typeof input !== 'object') return null;
  const brand = await getBrandById(db, input.brandId);
  if (!brand) return null;
  const title = cleanStr(input.title || '').slice(0, TITLE_MAX);
  if (!title) return null;
  const id = newId();
  const ts = nowIso();
  await db.run(
    'INSERT INTO pitches (id, brand_id, title, goal, brief, status, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [id, brand.id, title, optText(input.goal, GOAL_MAX) || null,
      optText(input.brief, BRIEF_MAX) || null, 'active',
      optText(input.createdBy, NAME_MAX) || null, ts, ts]);
  return getPitch(db, id);
}

async function getPitch(db, id) {
  if (!ID_SHAPE.test(String(id || ''))) return null;
  return db.first('SELECT * FROM pitches WHERE id = ?', [String(id)]);
}

async function listPitchesForBrand(db, brandId) {
  if (!ID_SHAPE.test(String(brandId || ''))) return [];
  return db.all(
    'SELECT p.*, (SELECT COUNT(*) FROM examples e WHERE e.pitch_id = p.id) AS exampleCount ' +
    'FROM pitches p WHERE p.brand_id = ? ORDER BY p.updated_at DESC, p.rowid DESC',
    [String(brandId)]);
}

// The cross-brand Pitches view: brand name/slug joined in so the list needs
// no second query, newest activity first.
async function listAllPitches(db) {
  return db.all(
    'SELECT p.*, b.name AS brandName, b.slug AS brandSlug, ' +
    '(SELECT COUNT(*) FROM examples e WHERE e.pitch_id = p.id) AS exampleCount ' +
    'FROM pitches p JOIN brands b ON b.id = p.brand_id ' +
    'ORDER BY p.updated_at DESC, p.rowid DESC');
}

// updatePitch(db, id, { title?, goal?, brief?, status? }) -> row | null.
// Same drop-invalid/''-clears stance as everywhere else; title and status
// can never clear (a pitch always has both), unknown statuses are dropped.
async function updatePitch(db, id, raw) {
  if (!ID_SHAPE.test(String(id || ''))) return null;
  if (!raw || typeof raw !== 'object') return null;
  const sets = [];
  const params = [];
  if (typeof raw.title === 'string') {
    const title = cleanStr(raw.title).slice(0, TITLE_MAX);
    if (title) { sets.push('title = ?'); params.push(title); }
  }
  const goal = optText(raw.goal, GOAL_MAX);
  if (goal !== undefined) { sets.push('goal = ?'); params.push(goal); }
  const brief = optText(raw.brief, BRIEF_MAX);
  if (brief !== undefined) { sets.push('brief = ?'); params.push(brief); }
  if (PITCH_STATUSES.includes(raw.status)) { sets.push('status = ?'); params.push(raw.status); }
  if (!sets.length) return null;
  sets.push('updated_at = ?');
  params.push(nowIso(), String(id));
  const { changes } = await db.run('UPDATE pitches SET ' + sets.join(', ') + ' WHERE id = ?', params);
  return changes ? getPitch(db, id) : null;
}

async function archivePitch(db, id) {
  return updatePitch(db, id, { status: 'archived' });
}

// ---- examples -------------------------------------------------------------------

// List rows exclude the two heavy columns (amp_html is a whole email,
// doc_json its source document) — hasAmp tells the UI whether a preview
// exists without shipping it. getExample returns everything.
const EXAMPLE_LIST_COLS =
  'id, pitch_id, brand_id, title, module_id, params_json, validation_pass, ' +
  'parent_id, root_id, tweak_prompt, created_by, created_at, ' +
  "(CASE WHEN amp_html IS NULL OR amp_html = '' THEN 0 ELSE 1 END) AS hasAmp";

// createExample(db, { pitchId, title?, moduleId?, params?, doc?, ampHtml?,
// validationPass?, parentId?, tweakPrompt?, createdBy? }) -> row | null.
// brand_id is ALWAYS stamped from the pitch (any brandId in the input is
// ignored — the parent decides). Lineage follows the v3.1 tweak contract:
// no parent -> the example roots its own chain; with a parent, the parent
// must exist IN THE SAME PITCH and the root is inherited.
async function createExample(db, input) {
  if (!input || typeof input !== 'object') return null;
  const pitch = await getPitch(db, input.pitchId);
  if (!pitch) return null;
  let parentId = null;
  let rootId = null;
  if (input.parentId !== undefined && input.parentId !== null && input.parentId !== '') {
    const parent = await getExample(db, input.parentId);
    if (!parent || parent.pitch_id !== pitch.id) return null;
    parentId = parent.id;
    rootId = parent.root_id || parent.id;
  }
  const id = newId();
  if (!rootId) rootId = id;
  // amp_html is pipeline output (already through the real validator), stored
  // verbatim — stripping '<' would destroy it. It is never client-typed.
  const ampHtml = typeof input.ampHtml === 'string' && input.ampHtml ? input.ampHtml : null;
  await db.run(
    'INSERT INTO examples (id, pitch_id, brand_id, title, module_id, params_json, doc_json, amp_html, validation_pass, parent_id, root_id, tweak_prompt, created_by, created_at) ' +
    'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [id, pitch.id, pitch.brand_id,
      optText(input.title, TITLE_MAX) || null,
      optText(input.moduleId, 60) || null,
      toJsonOrNull(input.params), toJsonOrNull(input.doc), ampHtml,
      input.validationPass ? 1 : 0, parentId, rootId,
      optText(input.tweakPrompt, TWEAK_PROMPT_MAX) || null,
      optText(input.createdBy, NAME_MAX) || null, nowIso()]);
  return getExample(db, id);
}

async function getExample(db, id) {
  if (!ID_SHAPE.test(String(id || ''))) return null;
  return db.first('SELECT * FROM examples WHERE id = ?', [String(id)]);
}

// updateExampleDoc(db, id, { doc, ampHtml, validationPass }) -> updated row |
// null (unknown/bad id). The editor's save path: re-render then persist the
// doc + its AMP + verdict IN PLACE (no new row, unlike a tweak — an edit is
// the same example, not a version). doc rides toJsonOrNull like createExample;
// amp_html is pipeline/render output stored verbatim (stripping '<' would
// destroy it), never client-typed. Null-on-failure, never a throw.
async function updateExampleDoc(db, id, input) {
  if (!ID_SHAPE.test(String(id || ''))) return null;
  const i = (input && typeof input === 'object') ? input : {};
  const ampHtml = typeof i.ampHtml === 'string' && i.ampHtml ? i.ampHtml : null;
  const { changes } = await db.run(
    'UPDATE examples SET doc_json = ?, amp_html = ?, validation_pass = ? WHERE id = ?',
    [toJsonOrNull(i.doc), ampHtml, i.validationPass ? 1 : 0, String(id)]);
  return changes ? getExample(db, id) : null;
}

async function listExamplesForPitch(db, pitchId) {
  if (!ID_SHAPE.test(String(pitchId || ''))) return [];
  return db.all(
    'SELECT ' + EXAMPLE_LIST_COLS + ' FROM examples WHERE pitch_id = ? ' +
    'ORDER BY created_at DESC, rowid DESC',
    [String(pitchId)]);
}

// The version chain for one root, oldest first (the order the chips render:
// original -> tweak -> tweak). rowid breaks same-millisecond ties.
async function listVersions(db, rootId) {
  if (!ID_SHAPE.test(String(rootId || ''))) return [];
  return db.all(
    'SELECT ' + EXAMPLE_LIST_COLS + ' FROM examples WHERE root_id = ? ' +
    'ORDER BY created_at ASC, rowid ASC',
    [String(rootId)]);
}

// One row per version chain — the LATEST — for a pitch's gallery view:
// "the current state of each example", tweaks collapsed. NOT EXISTS with a
// rowid tie-break rather than MAX(created_at), because same-millisecond
// writes are routine in tests and possible in production.
async function latestExamplesPerRoot(db, pitchId) {
  if (!ID_SHAPE.test(String(pitchId || ''))) return [];
  return db.all(
    'SELECT ' + EXAMPLE_LIST_COLS + ' FROM examples e1 WHERE e1.pitch_id = ? ' +
    'AND NOT EXISTS (SELECT 1 FROM examples e2 WHERE e2.root_id = e1.root_id ' +
    'AND (e2.created_at > e1.created_at OR (e2.created_at = e1.created_at AND e2.rowid > e1.rowid))) ' +
    'ORDER BY e1.created_at DESC, e1.rowid DESC',
    [String(pitchId)]);
}

// ---- assets (metadata rows only — bytes live behind the storage interface) ------

// Minimal row DAOs so listBrands' assetCount has a writer and the storage
// layer (KV today) has somewhere to record what it stored. Byte handling,
// mime/size policy and storage_key formats belong to that layer, not here.
async function insertAsset(db, input) {
  if (!input || typeof input !== 'object') return null;
  const brand = await getBrandById(db, input.brandId);
  if (!brand) return null;
  const filename = cleanStr(input.filename || '').slice(0, 120);
  const mime = cleanStr(input.mime || '').slice(0, 80);
  const storageKey = cleanStr(input.storageKey || '').slice(0, 256);
  const size = Math.round(Number(input.size));
  if (!filename || !mime || !storageKey || !Number.isFinite(size) || size < 0) return null;
  const id = newId();
  await db.run(
    'INSERT INTO assets (id, brand_id, kind, filename, mime, size, storage_key, uploaded_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [id, brand.id, optText(input.kind, 40) || 'image', filename, mime, size,
      storageKey, optText(input.uploadedBy, NAME_MAX) || null, nowIso()]);
  return db.first('SELECT * FROM assets WHERE id = ?', [id]);
}

async function listAssets(db, brandId) {
  if (!ID_SHAPE.test(String(brandId || ''))) return [];
  return db.all(
    'SELECT * FROM assets WHERE brand_id = ? ORDER BY created_at DESC, rowid DESC',
    [String(brandId)]);
}

async function getAsset(db, id) {
  if (!ID_SHAPE.test(String(id || ''))) return null;
  return db.first('SELECT * FROM assets WHERE id = ?', [String(id)]);
}

// Deletes the metadata row only — the caller owns the byte-store cleanup
// (storage and rows are different systems; the row going first means a
// half-failed delete leaves an orphaned object, never a broken URL).
async function deleteAsset(db, id) {
  if (!ID_SHAPE.test(String(id || ''))) return false;
  const { changes } = await db.run('DELETE FROM assets WHERE id = ?', [String(id)]);
  return changes > 0;
}

// ---- settings -------------------------------------------------------------------

// App-wide JSON blobs keyed by name — this is where the pasted LLM key POOL
// will live ('llm:pool'), so keys never validate as loosely as user content:
// a bad key shape is refused outright.
const SETTING_KEY_SHAPE = /^[a-z0-9][a-z0-9:_.-]{0,63}$/i;

async function getSetting(db, key) {
  if (!SETTING_KEY_SHAPE.test(String(key || ''))) return null;
  const row = await db.first('SELECT value_json FROM settings WHERE key = ?', [String(key)]);
  if (!row || typeof row.value_json !== 'string') return null;
  try {
    return JSON.parse(row.value_json);
  } catch {
    return null; // a corrupt value reads as a miss, same stance as the KV store
  }
}

async function putSetting(db, key, value) {
  if (!SETTING_KEY_SHAPE.test(String(key || ''))) return false;
  let json;
  try {
    json = JSON.stringify(value);
  } catch {
    return false;
  }
  if (typeof json !== 'string') return false; // undefined / function / symbol
  await db.run(
    'INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?) ' +
    'ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at',
    [String(key), json, nowIso()]);
  return true;
}

// ---- activity -------------------------------------------------------------------

// Best-effort by contract, like every log path in this repo: a failed insert
// is logged to console and swallowed — the action that generated the event
// must never fail because its FOOTNOTE could not be written. activity has no
// FK constraints by design (see 0001_init.sql), so even a dangling brand id
// cannot make this throw.
async function logActivity(db, entry) {
  try {
    const verb = cleanStr((entry && entry.verb) || '').slice(0, 40);
    if (!db || !verb) return false;
    await db.run(
      'INSERT INTO activity (id, ts, actor, brand_id, pitch_id, verb, detail) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [newId(), nowIso(),
        optText(entry.actor, NAME_MAX) || null,
        ID_SHAPE.test(String(entry.brandId || '')) ? String(entry.brandId) : null,
        ID_SHAPE.test(String(entry.pitchId || '')) ? String(entry.pitchId) : null,
        verb, optText(entry.detail, DETAIL_MAX) || null]);
    return true;
  } catch (e) {
    console.error('[repo] activity entry dropped:', e && e.message);
    return false;
  }
}

async function listActivity(db, opts) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const requested = Math.round(Number(o.limit));
  const limit = Number.isFinite(requested) && requested > 0 ? Math.min(requested, 200) : 50;
  if (o.brandId !== undefined && o.brandId !== null) {
    if (!ID_SHAPE.test(String(o.brandId))) return [];
    return db.all(
      'SELECT * FROM activity WHERE brand_id = ? ORDER BY ts DESC, rowid DESC LIMIT ?',
      [String(o.brandId), limit]);
  }
  return db.all('SELECT * FROM activity ORDER BY ts DESC, rowid DESC LIMIT ?', [limit]);
}

// The pure validation/mapping helpers, exported for server/repo-supabase.js —
// the PostgREST twin must apply EXACTLY these rules or the two backends
// drift. Not public API: routes import the DAOs, never _pure.
const _pure = {
  ID_SHAPE, SLUG_SHAPE, KIT_COLUMNS,
  cleanStr, cleanUrl, optText, toJsonOrNull, nowIso,
  contactPatch, cleanProductRow,
  NAME_MAX, TITLE_MAX, GOAL_MAX, BRIEF_MAX, TWEAK_PROMPT_MAX, DETAIL_MAX, PRODUCTS_MAX,
};

module.exports = {
  _pure,
  // brands
  upsertBrand, getBrandBySlug, getBrandById, listBrands, setBrandKitFields,
  // products
  replaceProducts, listProducts,
  // contacts
  addContact, updateContact, deleteContact, listContacts,
  // pitches
  createPitch, getPitch, listPitchesForBrand, listAllPitches, updatePitch, archivePitch,
  PITCH_STATUSES,
  // examples
  createExample, getExample, updateExampleDoc, listExamplesForPitch, listVersions, latestExamplesPerRoot,
  // assets
  insertAsset, listAssets, getAsset, deleteAsset,
  // settings
  getSetting, putSetting,
  // activity
  logActivity, listActivity,
};
