'use strict';

// The Supabase (PostgREST) twin of server/repo.js — Hriday's call: the shared
// system of record lives in Supabase, deployment-independent, visible in its
// dashboard. Same DAO names, same argument lists MINUS the leading db handle
// (methods come back BOUND from createSupabaseRepo), same return shapes, same
// null/[]/false-never-throw error voice. Validation is not re-implemented:
// every rule comes from repo.js's _pure export, so the two backends cannot
// drift on what counts as a valid contact, product, or kit field.
//
// PostgREST specifics (all verified against this very project):
//   - auth is the `apikey: <sb_secret_...>` header ALONE. An Authorization:
//     Bearer header makes the API try to parse the new-format key as a legacy
//     JWT and fail 403 "Invalid Compact JWS". Do not add one.
//   - inserts/updates return the row only with Prefer: return=representation.
//   - Postgres has no SQLite rowid; every rowid tie-break becomes an `id`
//     tie-break (ids are random hex — arbitrary but STABLE, which is all a
//     tie-break must be).
//   - list rows: PostgREST select= cannot compute CASE expressions, so
//     hasAmp is derived client-side (amp_html fetched, mapped to 0/1 and
//     dropped). Heavier than repo.js's projection; acceptable for a team
//     tool's gallery sizes, and the seam to optimise later is one column.
//
// Runtime-agnostic: global fetch only — bundles for Workers untouched.

const repoLocal = require('./repo');
const { newId, brandSlug } = require('./store');

const {
  ID_SHAPE, SLUG_SHAPE, KIT_COLUMNS,
  cleanStr, optText, toJsonOrNull, nowIso,
  contactPatch, cleanProductRow,
  NAME_MAX, TITLE_MAX, GOAL_MAX, BRIEF_MAX, TWEAK_PROMPT_MAX, DETAIL_MAX, PRODUCTS_MAX,
} = repoLocal._pure;

const { sanitizeKitPatch } = require('./store');

const SETTING_KEY_SHAPE = /^[a-z0-9][a-z0-9:_.-]{0,63}$/i;

// Example list rows exclude doc_json (heavy); amp_html is fetched only to be
// collapsed into hasAmp — see header.
const EXAMPLE_LIST_SELECT = 'id,pitch_id,brand_id,title,module_id,params_json,'
  + 'validation_pass,parent_id,root_id,tweak_prompt,created_by,created_at,amp_html';

function toListRow(row) {
  if (!row || typeof row !== 'object') return row;
  const { amp_html: amp, ...rest } = row;
  rest.hasAmp = amp ? 1 : 0;
  return rest;
}

function createSupabaseRepo({ url, secretKey, fetchImpl = fetch } = {}) {
  const base = String(url || '').replace(/\/+$/, '');
  if (!base || !secretKey) return null;
  const rest = base + '/rest/v1/';

  // One tolerant transport for every DAO: null on ANY failure (non-2xx,
  // network, parse), '[repo-supabase]' console.error so a misbehaving
  // database is visible in logs without ever failing a request.
  async function call(path, { method = 'GET', body, prefer } = {}) {
    try {
      const headers = { apikey: secretKey };
      if (body !== undefined) headers['content-type'] = 'application/json';
      if (prefer) headers.Prefer = prefer;
      const res = await fetchImpl(rest + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        console.error('[repo-supabase]', method, path.split('?')[0], '->', res.status, text.slice(0, 120));
        return null;
      }
      if (res.status === 204) return [];
      const text = await res.text();
      if (!text) return [];
      return JSON.parse(text);
    } catch (e) {
      console.error('[repo-supabase]', method, path.split('?')[0], 'failed:', e && e.message);
      return null;
    }
  }

  const one = (rows) => (Array.isArray(rows) && rows.length ? rows[0] : null);
  const many = (rows) => (Array.isArray(rows) ? rows : []);
  const enc = encodeURIComponent;

  // ---- brands -----------------------------------------------------------------

  async function getBrandBySlug(slug) {
    if (!SLUG_SHAPE.test(String(slug || ''))) return null;
    return one(await call('brands?slug=eq.' + enc(String(slug)) + '&limit=1'));
  }

  async function getBrandById(id) {
    if (!ID_SHAPE.test(String(id || ''))) return null;
    return one(await call('brands?id=eq.' + enc(String(id)) + '&limit=1'));
  }

  // Mirrors repo.js verbatim: sanitizeKitPatch drives the fields, SELECT-then-
  // write (PostgREST POST vs PATCH) so only provided fields ever change.
  async function upsertBrand(input) {
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
    const dossierJson = input.dossier !== undefined ? toJsonOrNull(input.dossier) : undefined;

    const existing = await getBrandBySlug(slug);
    const ts = nowIso();
    if (!existing) {
      if (!patch.name) return null; // a NEW brand must bring a valid name
      const row = {
        id: newId(),
        slug,
        name: patch.name,
        primary_hex: patch.primary || null,
        accent_hex: patch.accent || null,
        vertical: patch.vertical || null,
        site: patch.site || null,
        logo_url: patch.logoUrl || null,
        hero_url: patch.heroUrl || null,
        voice_sample: patch.voiceSample || null,
        dossier_json: dossierJson === undefined ? null : dossierJson,
        created_by: optText(input.createdBy, NAME_MAX) || null,
        created_at: ts,
        updated_at: ts,
      };
      return one(await call('brands', { method: 'POST', body: row, prefer: 'return=representation' }));
    }
    const sets = {};
    for (const key of Object.keys(KIT_COLUMNS)) {
      if (!(key in patch)) continue;
      sets[KIT_COLUMNS[key]] = patch[key] === '' ? null : patch[key]; // '' is the clear marker
    }
    if (dossierJson !== undefined && dossierJson !== null) sets.dossier_json = dossierJson;
    if (!Object.keys(sets).length) return existing; // nothing valid to change — not an error
    sets.updated_at = ts;
    return one(await call('brands?id=eq.' + enc(existing.id), {
      method: 'PATCH', body: sets, prefer: 'return=representation',
    }));
  }

  async function listBrands() {
    // Embedded counts in ONE request; dossier_json (the one long column)
    // excluded like repo.js. activity CANNOT be embedded — the table has no
    // FK by design (logging must never be able to fail on a dangling id),
    // and PostgREST only embeds across real FKs (PGRST200, learned live) —
    // so lastActivityAt comes from a second slim query reduced client-side.
    const [rows, recent] = await Promise.all([
      call('brands?select=id,slug,name,primary_hex,accent_hex,vertical,site,'
        + 'logo_url,hero_url,voice_sample,created_by,created_at,updated_at,'
        + 'pitches(count),examples(count),assets(count)'
        + '&order=updated_at.desc,id.desc'),
      call('activity?select=brand_id,ts&order=ts.desc,id.desc&limit=200'),
    ]);
    const lastByBrand = new Map();
    for (const a of many(recent)) {
      if (a.brand_id && !lastByBrand.has(a.brand_id)) lastByBrand.set(a.brand_id, a.ts);
    }
    return many(rows).map((r) => {
      const { pitches, examples, assets, ...rest } = r;
      rest.pitchCount = (pitches && pitches[0] && pitches[0].count) || 0;
      rest.exampleCount = (examples && examples[0] && examples[0].count) || 0;
      rest.assetCount = (assets && assets[0] && assets[0].count) || 0;
      rest.lastActivityAt = lastByBrand.get(r.id) || null;
      return rest;
    });
  }

  async function setBrandKitFields(id, rawPatch) {
    if (!ID_SHAPE.test(String(id || ''))) return null;
    const patch = sanitizeKitPatch(rawPatch);
    if (!patch) return null;
    const sets = {};
    for (const key of Object.keys(KIT_COLUMNS)) {
      if (!(key in patch)) continue;
      sets[KIT_COLUMNS[key]] = patch[key] === '' ? null : patch[key];
    }
    if (!Object.keys(sets).length) return getBrandById(id); // e.g. products-only patch
    sets.updated_at = nowIso();
    return one(await call('brands?id=eq.' + enc(String(id)), {
      method: 'PATCH', body: sets, prefer: 'return=representation',
    }));
  }

  // ---- products -----------------------------------------------------------------

  async function listProducts(brandId) {
    if (!ID_SHAPE.test(String(brandId || ''))) return [];
    return many(await call('products?brand_id=eq.' + enc(String(brandId))
      + '&select=id,brand_id,name,price,image_url,asset_id,pos&order=pos.asc,id.asc'));
  }

  // DELETE + one bulk POST (PostgREST inserts an array atomically). Two
  // statements rather than repo.js's one batch — the tiny window where the
  // list is empty is the price of no transactions over REST; for a team tool
  // the last-writer-wins caveat already accepted elsewhere covers it.
  async function replaceProducts(brandId, products) {
    const brand = await getBrandById(brandId);
    if (!brand) return null;
    const rows = (Array.isArray(products) ? products : [])
      .slice(0, 24).map(cleanProductRow).filter(Boolean).slice(0, PRODUCTS_MAX);
    const del = await call('products?brand_id=eq.' + enc(brand.id), { method: 'DELETE' });
    if (del === null) return null; // delete failed — leave whatever is stored
    if (rows.length) {
      const body = rows.map((row, pos) => ({
        id: newId(),
        brand_id: brand.id,
        name: row.name,
        price: row.price,
        image_url: row.imageUrl,
        asset_id: row.assetId,
        pos,
      }));
      await call('products', { method: 'POST', body, prefer: 'return=minimal' });
    }
    return listProducts(brand.id);
  }

  // ---- contacts -----------------------------------------------------------------

  async function addContact(brandId, raw) {
    const brand = await getBrandById(brandId);
    if (!brand) return null;
    const patch = contactPatch(raw);
    if (!patch || !patch.name) return null; // name is the one required field
    const row = {
      id: newId(),
      brand_id: brand.id,
      name: patch.name,
      role: patch.role || null,
      email: patch.email || null,
      phone: patch.phone || null,
      notes: patch.notes || null,
      created_at: nowIso(),
    };
    return one(await call('contacts', { method: 'POST', body: row, prefer: 'return=representation' }));
  }

  async function updateContact(id, raw) {
    if (!ID_SHAPE.test(String(id || ''))) return null;
    const patch = contactPatch(raw);
    if (!patch) return null;
    const sets = {};
    for (const key of ['name', 'role', 'email', 'phone', 'notes']) {
      if (key in patch) sets[key] = patch[key];
    }
    if (!Object.keys(sets).length) return null;
    return one(await call('contacts?id=eq.' + enc(String(id)), {
      method: 'PATCH', body: sets, prefer: 'return=representation',
    }));
  }

  async function deleteContact(id) {
    if (!ID_SHAPE.test(String(id || ''))) return false;
    const out = await call('contacts?id=eq.' + enc(String(id)), {
      method: 'DELETE', prefer: 'return=representation',
    });
    return Array.isArray(out) && out.length > 0;
  }

  async function listContacts(brandId) {
    if (!ID_SHAPE.test(String(brandId || ''))) return [];
    return many(await call('contacts?brand_id=eq.' + enc(String(brandId))
      + '&order=created_at.desc,id.desc'));
  }

  // ---- pitches ------------------------------------------------------------------

  async function createPitch(input) {
    if (!input || typeof input !== 'object') return null;
    const brand = await getBrandById(input.brandId);
    if (!brand) return null;
    const title = cleanStr(input.title || '').slice(0, TITLE_MAX);
    if (!title) return null;
    const ts = nowIso();
    const row = {
      id: newId(),
      brand_id: brand.id,
      title,
      goal: optText(input.goal, GOAL_MAX) || null,
      brief: optText(input.brief, BRIEF_MAX) || null,
      status: 'active',
      created_by: optText(input.createdBy, NAME_MAX) || null,
      created_at: ts,
      updated_at: ts,
    };
    return one(await call('pitches', { method: 'POST', body: row, prefer: 'return=representation' }));
  }

  async function getPitch(id) {
    if (!ID_SHAPE.test(String(id || ''))) return null;
    return one(await call('pitches?id=eq.' + enc(String(id)) + '&limit=1'));
  }

  async function listPitchesForBrand(brandId) {
    if (!ID_SHAPE.test(String(brandId || ''))) return [];
    const rows = await call('pitches?brand_id=eq.' + enc(String(brandId))
      + '&select=*,examples(count)&order=updated_at.desc,id.desc');
    return many(rows).map((r) => {
      const { examples, ...restRow } = r;
      restRow.exampleCount = (examples && examples[0] && examples[0].count) || 0;
      return restRow;
    });
  }

  async function listAllPitches() {
    const rows = await call('pitches?select=*,examples(count),brands(name,slug)'
      + '&order=updated_at.desc,id.desc');
    return many(rows).map((r) => {
      const { examples, brands, ...restRow } = r;
      restRow.exampleCount = (examples && examples[0] && examples[0].count) || 0;
      restRow.brandName = (brands && brands.name) || null;
      restRow.brandSlug = (brands && brands.slug) || null;
      return restRow;
    });
  }

  async function updatePitch(id, raw) {
    if (!ID_SHAPE.test(String(id || ''))) return null;
    if (!raw || typeof raw !== 'object') return null;
    const sets = {};
    if (typeof raw.title === 'string') {
      const title = cleanStr(raw.title).slice(0, TITLE_MAX);
      if (title) sets.title = title;
    }
    const goal = optText(raw.goal, GOAL_MAX);
    if (goal !== undefined) sets.goal = goal;
    const brief = optText(raw.brief, BRIEF_MAX);
    if (brief !== undefined) sets.brief = brief;
    if (repoLocal.PITCH_STATUSES.includes(raw.status)) sets.status = raw.status;
    if (!Object.keys(sets).length) return null;
    sets.updated_at = nowIso();
    return one(await call('pitches?id=eq.' + enc(String(id)), {
      method: 'PATCH', body: sets, prefer: 'return=representation',
    }));
  }

  async function archivePitch(id) {
    return updatePitch(id, { status: 'archived' });
  }

  // ---- examples -----------------------------------------------------------------

  async function getExample(id) {
    if (!ID_SHAPE.test(String(id || ''))) return null;
    return one(await call('examples?id=eq.' + enc(String(id)) + '&limit=1'));
  }

  async function createExample(input) {
    if (!input || typeof input !== 'object') return null;
    const pitch = await getPitch(input.pitchId);
    if (!pitch) return null;
    let parentId = null;
    let rootId = null;
    if (input.parentId !== undefined && input.parentId !== null && input.parentId !== '') {
      const parent = await getExample(input.parentId);
      if (!parent || parent.pitch_id !== pitch.id) return null;
      parentId = parent.id;
      rootId = parent.root_id || parent.id;
    }
    const id = newId();
    if (!rootId) rootId = id;
    const ampHtml = typeof input.ampHtml === 'string' && input.ampHtml ? input.ampHtml : null;
    const row = {
      id,
      pitch_id: pitch.id,
      brand_id: pitch.brand_id,
      title: optText(input.title, TITLE_MAX) || null,
      module_id: optText(input.moduleId, 60) || null,
      params_json: toJsonOrNull(input.params),
      doc_json: toJsonOrNull(input.doc),
      amp_html: ampHtml,
      validation_pass: input.validationPass ? 1 : 0,
      parent_id: parentId,
      root_id: rootId,
      tweak_prompt: optText(input.tweakPrompt, TWEAK_PROMPT_MAX) || null,
      created_by: optText(input.createdBy, NAME_MAX) || null,
      created_at: nowIso(),
    };
    return one(await call('examples', { method: 'POST', body: row, prefer: 'return=representation' }));
  }

  async function listExamplesForPitch(pitchId) {
    if (!ID_SHAPE.test(String(pitchId || ''))) return [];
    const rows = await call('examples?pitch_id=eq.' + enc(String(pitchId))
      + '&select=' + EXAMPLE_LIST_SELECT + '&order=created_at.desc,id.desc');
    return many(rows).map(toListRow);
  }

  async function listVersions(rootId) {
    if (!ID_SHAPE.test(String(rootId || ''))) return [];
    const rows = await call('examples?root_id=eq.' + enc(String(rootId))
      + '&select=' + EXAMPLE_LIST_SELECT + '&order=created_at.asc,id.asc');
    return many(rows).map(toListRow);
  }

  // Newest row per version chain, newest chains first — repo.js does it with
  // NOT EXISTS; here the pitch's rows arrive newest-first and the first row
  // seen per root wins. Same output, one query, client-side reduce.
  async function latestExamplesPerRoot(pitchId) {
    if (!ID_SHAPE.test(String(pitchId || ''))) return [];
    const rows = await call('examples?pitch_id=eq.' + enc(String(pitchId))
      + '&select=' + EXAMPLE_LIST_SELECT + '&order=created_at.desc,id.desc');
    const seen = new Set();
    const out = [];
    for (const row of many(rows)) {
      const family = row.root_id || row.id;
      if (seen.has(family)) continue;
      seen.add(family);
      out.push(toListRow(row));
    }
    return out;
  }

  // ---- assets (metadata rows) -----------------------------------------------------

  async function insertAsset(input) {
    if (!input || typeof input !== 'object') return null;
    const brand = await getBrandById(input.brandId);
    if (!brand) return null;
    const filename = cleanStr(input.filename || '').slice(0, 120);
    const mime = cleanStr(input.mime || '').slice(0, 80);
    const storageKey = cleanStr(input.storageKey || '').slice(0, 256);
    const size = Math.round(Number(input.size));
    if (!filename || !mime || !storageKey || !Number.isFinite(size) || size < 0) return null;
    const row = {
      id: newId(),
      brand_id: brand.id,
      kind: optText(input.kind, 40) || 'image',
      filename,
      mime,
      size,
      storage_key: storageKey,
      uploaded_by: optText(input.uploadedBy, NAME_MAX) || null,
      created_at: nowIso(),
    };
    return one(await call('assets', { method: 'POST', body: row, prefer: 'return=representation' }));
  }

  async function listAssets(brandId) {
    if (!ID_SHAPE.test(String(brandId || ''))) return [];
    return many(await call('assets?brand_id=eq.' + enc(String(brandId))
      + '&order=created_at.desc,id.desc'));
  }

  async function getAsset(id) {
    if (!ID_SHAPE.test(String(id || ''))) return null;
    return one(await call('assets?id=eq.' + enc(String(id)) + '&limit=1'));
  }

  // Row only — byte-store cleanup is the caller's job (see repo.js twin).
  async function deleteAsset(id) {
    if (!ID_SHAPE.test(String(id || ''))) return false;
    const out = await call('assets?id=eq.' + enc(String(id)), {
      method: 'DELETE', prefer: 'return=representation',
    });
    return Array.isArray(out) && out.length > 0;
  }

  // ---- settings -----------------------------------------------------------------

  async function getSetting(key) {
    if (!SETTING_KEY_SHAPE.test(String(key || ''))) return null;
    const row = one(await call('settings?key=eq.' + enc(String(key)) + '&limit=1'));
    if (!row || typeof row.value_json !== 'string') return null;
    try {
      return JSON.parse(row.value_json);
    } catch {
      return null;
    }
  }

  async function putSetting(key, value) {
    if (!SETTING_KEY_SHAPE.test(String(key || ''))) return false;
    let json;
    try {
      json = JSON.stringify(value);
    } catch {
      return false;
    }
    if (typeof json !== 'string') return false;
    const out = await call('settings?on_conflict=key', {
      method: 'POST',
      body: { key: String(key), value_json: json, updated_at: nowIso() },
      prefer: 'resolution=merge-duplicates,return=representation',
    });
    return Array.isArray(out) && out.length > 0;
  }

  // ---- activity -----------------------------------------------------------------

  async function logActivity(entry) {
    try {
      const verb = cleanStr((entry && entry.verb) || '').slice(0, 40);
      if (!verb) return false;
      const row = {
        id: newId(),
        ts: nowIso(),
        actor: optText(entry.actor, NAME_MAX) || null,
        brand_id: ID_SHAPE.test(String(entry.brandId || '')) ? String(entry.brandId) : null,
        pitch_id: ID_SHAPE.test(String(entry.pitchId || '')) ? String(entry.pitchId) : null,
        verb,
        detail: optText(entry.detail, DETAIL_MAX) || null,
      };
      const out = await call('activity', { method: 'POST', body: row, prefer: 'return=minimal' });
      return out !== null;
    } catch (e) {
      console.error('[repo-supabase] activity entry dropped:', e && e.message);
      return false;
    }
  }

  async function listActivity(opts) {
    const o = opts && typeof opts === 'object' ? opts : {};
    const requested = Math.round(Number(o.limit));
    const limit = Number.isFinite(requested) && requested > 0 ? Math.min(requested, 200) : 50;
    let path = 'activity?order=ts.desc,id.desc&limit=' + limit;
    if (o.brandId !== undefined && o.brandId !== null) {
      if (!ID_SHAPE.test(String(o.brandId))) return [];
      path = 'activity?brand_id=eq.' + enc(String(o.brandId)) + '&order=ts.desc,id.desc&limit=' + limit;
    }
    return many(await call(path));
  }

  return {
    upsertBrand,
    getBrandBySlug,
    getBrandById,
    listBrands,
    setBrandKitFields,
    replaceProducts,
    listProducts,
    addContact,
    updateContact,
    deleteContact,
    listContacts,
    createPitch,
    getPitch,
    listPitchesForBrand,
    listAllPitches,
    updatePitch,
    archivePitch,
    createExample,
    getExample,
    listExamplesForPitch,
    listVersions,
    latestExamplesPerRoot,
    insertAsset,
    listAssets,
    getAsset,
    deleteAsset,
    getSetting,
    putSetting,
    logActivity,
    listActivity,
    PITCH_STATUSES: repoLocal.PITCH_STATUSES,
  };
}

// The same bound-object shape over the local (node:sqlite / D1) path, so a
// route holds ONE repo variable whichever backend is configured.
function bindLocalRepo(db) {
  const bound = {};
  for (const [name, fn] of Object.entries(repoLocal)) {
    if (typeof fn === 'function') bound[name] = (...args) => fn(db, ...args);
  }
  bound.PITCH_STATUSES = repoLocal.PITCH_STATUSES;
  return bound;
}

module.exports = { createSupabaseRepo, bindLocalRepo };
