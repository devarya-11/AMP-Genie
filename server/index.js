'use strict';

const path = require('path');
const express = require('express');

// Loads .env (gitignored, local-only) into process.env if present — this is
// how GEMINI_API_KEY / GROQ_API_KEY / OLLAMA_BASE_URL etc. reach
// server/brief-content.js's provider auto-detection without needing to be
// exported in the shell every time. A no-op (never throws) when .env is
// absent, so nothing breaks for anyone who sets real env vars another way.
// Resolved relative to this file (not process.cwd()) so it still finds the
// repo's .env when the process is launched from a different working
// directory (e.g. an external tool that starts `node <abs-path>/server/index.js`
// from elsewhere) — dotenv's default is cwd-relative and silently loads 0
// vars in that case, degrading brief-content generation without any error.
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { MODULE_IDS, MODULES, VERTICALS, CURRENCIES, derivePalette } = require('./generate');
const { TONES } = require('./content');
const { validate } = require('./validator');
const { resolveBrandColor, libVertical } = require('./brand');
const { dispatch } = require('./dispatch');
const { readHistory, appendHistory, MAX_ENTRIES } = require('./history');
const { createBuild, buildHistoryEntry } = require('./build-pipeline');
const { createSlate } = require('./slate-core');
const { applyTweak, readVersions } = require('./tweak-engine');
const { buildDossier, hasResearchProvider } = require('./brand-research');
const { gateDecision } = require('./auth');
const { createSupabaseRepo, bindLocalRepo } = require('./repo-supabase');
const { createLocalDb, MIGRATIONS } = require('./db');
const {
  validateUpload, b64ToBytes, createSupabaseStorage,
  putAssetBytes, getAssetBytes, delAssetBytes,
} = require('./asset-store');
const {
  sanitizePoolEntry, maskKey, getMergedProviders, resetPoolCache, PROVIDER_ORDER, POOL_SETTINGS_KEY,
} = require('./key-pool');
const { proposeUseCases, shapeUserIdea } = require('./usecase-engine');
const {
  getBuild, getSlate, readSlateIndex, normalizeBrief,
  getBrandKit, putBrandKit, sanitizeKitPatch, mergeKitPatch, brandSlug,
} = require('./store');
const { createFsKv } = require('./store-fs');
const { registerPitchRoutes } = require('./pitch-routes-express');
const { buildPageHtml, slatePageHtml, notFoundPageHtml } = require('./share-pages');

// Local persistence for builds/slates/brand-kits: the same store interface the
// Pages Functions back with the HISTORY KV namespace, here backed by a
// git-ignored .data/ directory — so share links work in local dev too.
const kv = createFsKv(path.join(__dirname, '..', '.data'));

// Genie 2.0 system of record: Supabase when configured (the shared team
// database — same rows whichever runtime serves the request), else a local
// node:sqlite file so a bare checkout still fully works offline. The two
// expose one bound-object repo shape (see server/repo-supabase.js).
const supabaseCfg = {
  url: process.env.SUPABASE_URL,
  secretKey: process.env.SUPABASE_SECRET_KEY,
};
let repo = createSupabaseRepo(supabaseCfg);
let storage = createSupabaseStorage({ ...supabaseCfg, bucket: 'brand-assets' });
if (!repo) {
  const localDb = createLocalDb(path.join(__dirname, '..', '.data', 'genie.db'));
  // Fire-and-remember: routes await this once before first use.
  const migrated = localDb.applyMigrations(MIGRATIONS).catch((e) => {
    console.error('[index] local migrations failed:', e && e.message);
  });
  const bound = bindLocalRepo(localDb);
  repo = new Proxy(bound, {
    get(target, prop) {
      const fn = target[prop];
      if (typeof fn !== 'function') return fn;
      return async (...args) => { await migrated; return fn(...args); };
    },
  });
}

// Pool-aware providers for every LLM-tier call: when the team has pasted keys
// they are the explicit choice and take over; with an empty pool the engines
// keep their own env-key detection untouched (providers stays undefined).
async function llmProviders() {
  try {
    const merged = await getMergedProviders(repo, []);
    return merged.length ? merged : undefined;
  } catch {
    return undefined;
  }
}

const app = express();
app.use(express.json({ limit: '1mb' }));

// ---- CORS locked to the genie's own origin ---------------------------------
const PORT = Number(process.env.PORT) || 4000;
const SELF_ORIGINS = new Set([`http://localhost:${PORT}`, `http://127.0.0.1:${PORT}`]);
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && SELF_ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ---- team gate (Genie 2.0) ---------------------------------------------------
// One shared password (env TEAM_PASSWORD; gate is fully open when unset — dev
// and test default). gateDecision (server/auth.js) owns every branch and is
// shared verbatim with the Workers runtime (functions/_middleware.js) so the
// two front doors can never drift; this middleware only translates req/res.
app.use(async (req, res, next) => {
  const decision = await gateDecision({
    method: req.method,
    pathname: req.path,
    cookieHeader: req.headers.cookie,
    acceptHeader: req.headers.accept,
    password: process.env.TEAM_PASSWORD,
    suppliedPassword: (req.method === 'POST' && req.path === '/login' && req.body)
      ? req.body.password
      : undefined,
  });
  switch (decision.action) {
    case 'open': return next();
    case 'login-ok':
      if (decision.setCookie) res.setHeader('Set-Cookie', decision.setCookie);
      return res.json({ ok: true });
    case 'login-fail': return res.status(401).json({ error: 'wrong password' });
    case 'redirect': return res.redirect(302, decision.location);
    default: return res.status(401).json({ error: 'authentication required' });
  }
});

// ---- metadata for the UI's dropdowns ---------------------------------------
app.get('/api/meta', (req, res) => {
  res.json({
    verticals: VERTICALS,
    tones: Object.keys(TONES),
    currencies: Object.keys(CURRENCIES),
    modules: MODULE_IDS.map((id) => ({ id, name: MODULES[id].name, kind: MODULES[id].kind })),
  });
});

// ---- brand colour / guideline resolution -----------------------------------
app.post('/brand', async (req, res) => {
  try {
    const { brandName, hexOverride } = req.body || {};
    const resolved = await resolveBrandColor({ brandName, hexOverride });
    const palette = derivePalette(resolved.primary);
    const vertical = libVertical(brandName);
    res.json({ ...resolved, palette, vertical });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ---- generate: the single source of truth for AMP output ------------------
// The whole flow lives once in server/build-pipeline.js (shared with the
// Pages Function in functions/generate.js); this route only parses, injects
// the Node validator + fs store, and appends the legacy history entry.
app.post('/generate', async (req, res) => {
  try {
    const b = req.body || {};
    const author = typeof b.author === 'string' ? b.author.slice(0, 60) : null;
    const { response, build } = await createBuild(b, {
      validate, kv, author, providers: await llmProviders(),
    });
    appendHistory(buildHistoryEntry(build));
    res.json(response);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ---- slate: one brief -> up to 6 distinct-module validated builds ----------
app.post('/slate', async (req, res) => {
  try {
    const b = req.body || {};
    const { builds, response } = await createSlate(b, {
      validate, kv, providers: await llmProviders(),
    });
    // Slate builds land in the Recent-builds panel too, oldest first so the
    // panel (newest-first) ends up showing them in slate order.
    for (const built of builds.slice().reverse()) appendHistory(buildHistoryEntry(built));
    res.json(response);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ---- usecases: the v3 ideation front door -----------------------------------
// One endpoint, three moves, dispatched by body shape (see functions/usecases.js
// — the two routes must stay wire-identical): research -> dossier + proposal,
// propose/reroll with feedback + prior titles, or shape the team's own idea.
app.post('/usecases', async (req, res) => {
  try {
    const b = req.body || {};
    const brandName = (b.brand || '').trim() || 'Acme';
    const notes = typeof b.notes === 'string' ? b.notes.slice(0, 4000) : null;
    const providers = await llmProviders();
    const dossier = await buildDossier({ brandName, notes, kv, force: !!b.forceResearch }, { providers });
    // The brand kit (if the team saved one) lends its pasted voice sample to
    // every ideation prompt; the response carries boolean UI hints only.
    const kit = await getBrandKit(kv, brandSlug(brandName));
    const voiceSample = (kit && typeof kit.voiceSample === 'string') ? kit.voiceSample : null;
    const kitFlags = {
      hasKit: !!kit,
      kitHasAssets: !!(kit && (kit.logoUrl || kit.heroUrl || voiceSample
        || (Array.isArray(kit.products) && kit.products.length))),
      // lets the UI tell "heuristic because no key" from "heuristic because
      // the LLM call didn't land this time" — the label was lying before.
      llmConfigured: hasResearchProvider({ providers }),
    };
    const publicDossier = {
      name: dossier.name,
      slug: dossier.slug,
      site: dossier.site || null,
      summary: dossier.summary || '',
      products: dossier.products || [],
      categories: dossier.categories || [],
      audiences: dossier.audiences || [],
      voice: dossier.voice || { adjectives: [], donts: [] },
      currentCampaigns: dossier.currentCampaigns || [],
      vertical: dossier.vertical || 'Generic',
      confidence: dossier.confidence,
      researchedAt: dossier.researchedAt,
    };
    if (typeof b.idea === 'string' && b.idea.trim()) {
      const useCase = await shapeUserIdea({ idea: b.idea, dossier, voiceSample }, { providers });
      return res.json({ useCase, dossier: { ...publicDossier, ...kitFlags } });
    }
    const { useCases, source } = await proposeUseCases({
      dossier,
      brief: normalizeBrief(b.brief),
      count: b.count,
      feedback: typeof b.feedback === 'string' ? b.feedback.slice(0, 500) : null,
      prior: Array.isArray(b.prior) ? b.prior.slice(0, 16).map(String) : null,
      voiceSample,
    }, { providers });
    res.json({ useCases, source, dossier: { ...publicDossier, ...kitFlags } });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ---- slates index: the Pitches view ----------------------------------------
app.get('/slates', async (req, res) => {
  res.json({ items: await readSlateIndex(kv) });
});

// ---- brand kit: the team-curated asset record --------------------------------
// Wire-identical to functions/brandkit/[slug].js — GET never 404s (a null kit
// is the empty-editor state), POST merges a sanitized patch ('' clears a
// field, absent keeps it) and stamps source:'manual'.
app.get('/brandkit/:slug', async (req, res) => {
  res.json({ kit: await getBrandKit(kv, req.params.slug) });
});
app.post('/brandkit/:slug', async (req, res) => {
  const body = req.body || {};
  const patch = sanitizeKitPatch(body);
  if (!patch) return res.status(400).json({ error: 'no valid kit fields in body' });
  const slug = req.params.slug;
  const existing = (await getBrandKit(kv, slug)) || { slug, name: patch.name || slug };
  const record = mergeKitPatch(existing, patch);
  record.slug = slug;
  record.source = 'manual';
  record.updatedAt = new Date().toISOString();
  record.updatedBy = typeof body.author === 'string' && body.author.trim()
    ? body.author.replace(/[<>]/g, '').trim().slice(0, 60)
    : null;
  if (!(await putBrandKit(kv, record))) {
    return res.status(400).json({ error: 'kit failed validation or could not be saved' });
  }
  res.json({ ok: true, kit: record });
});

// ---- settings: the LLM key pool ----------------------------------------------
// GET returns masked keys only — a stored key never travels back to a browser.
app.get('/settings/keys', async (req, res) => {
  const pool = (await repo.getSetting(POOL_SETTINGS_KEY)) || [];
  res.json({
    keys: (Array.isArray(pool) ? pool : []).map((e) => ({
      id: e.id, provider: e.provider, key: maskKey(e.key), label: e.label || null, model: e.model || null,
      addedBy: e.addedBy || null, addedAt: e.addedAt || null,
    })),
    providers: PROVIDER_ORDER,
  });
});

app.post('/settings/keys', async (req, res) => {
  const entry = sanitizePoolEntry({
    provider: (req.body || {}).provider,
    key: (req.body || {}).key,
    label: (req.body || {}).label,
    model: (req.body || {}).model,
    addedBy: (req.body || {}).author,
  });
  if (!entry) return res.status(400).json({ error: 'invalid key entry (provider must be one of: ' + PROVIDER_ORDER.join(', ') + ')' });
  const pool = (await repo.getSetting(POOL_SETTINGS_KEY)) || [];
  pool.push(entry);
  if (!(await repo.putSetting(POOL_SETTINGS_KEY, pool))) {
    return res.status(500).json({ error: 'could not persist the key' });
  }
  resetPoolCache(); // a freshly pasted key is live on the next request
  repo.logActivity({ actor: entry.addedBy, verb: 'key-added', detail: entry.provider + ' ' + maskKey(entry.key) });
  res.json({ ok: true, id: entry.id });
});

app.delete('/settings/keys/:id', async (req, res) => {
  const pool = (await repo.getSetting(POOL_SETTINGS_KEY)) || [];
  const next = (Array.isArray(pool) ? pool : []).filter((e) => e && e.id !== req.params.id);
  if (next.length === pool.length) return res.status(404).json({ error: 'no such key' });
  await repo.putSetting(POOL_SETTINGS_KEY, next);
  resetPoolCache();
  res.json({ ok: true });
});

// ---- assets: desktop image uploads -> Supabase Storage ------------------------
// Bytes go to the public bucket (permanent CDN URL, email-safe); the metadata
// row goes to the assets table. Without Supabase configured, bytes fall back
// to the KV/fs store and are served through GET /assets/:id instead.
app.post('/assets', async (req, res) => {
  const b = req.body || {};
  const vetted = validateUpload(b);
  if (!vetted.ok) return res.status(400).json({ error: vetted.error });
  const brand = await repo.getBrandById(b.brandId);
  if (!brand) return res.status(400).json({ error: 'unknown brandId' });

  const { newId } = require('./store');
  const id = newId();
  let storageKey;
  let url;
  // Prefer Supabase (permanent public CDN URL). But if it is unreachable — a
  // network-restricted host, a sandboxed preview, or a Supabase outage — don't
  // hard-fail the upload; fall back to the KV byte store served via /assets/:id.
  if (storage) {
    const objPath = storage.objectPath(brand.slug, id, vetted.filename);
    url = await storage.putObject(objPath, b64ToBytes(b.dataBase64), vetted.mime);
    if (url) storageKey = 'supabase:' + objPath;
  }
  if (!url) {
    if (!(await putAssetBytes(kv, id, { base64: b.dataBase64, mime: vetted.mime }))) {
      return res.status(502).json({ error: 'storage upload failed' });
    }
    storageKey = 'kv:' + id;
    url = '/assets/' + id;
  }
  const row = await repo.insertAsset({
    brandId: brand.id,
    kind: b.kind,
    filename: vetted.filename,
    mime: vetted.mime,
    size: vetted.size,
    storageKey,
    uploadedBy: typeof b.author === 'string' ? b.author : null,
  });
  if (!row) return res.status(500).json({ error: 'could not record the asset' });
  repo.logActivity({ actor: b.author, brandId: brand.id, verb: 'asset-uploaded', detail: vetted.filename });
  res.json({ ok: true, asset: { id: row.id, url, filename: row.filename, mime: row.mime, size: row.size } });
});

app.get('/assets/:id', async (req, res) => {
  const row = await repo.getAsset(req.params.id);
  if (!row) return res.status(404).json({ error: 'no such asset' });
  const key = String(row.storage_key || '');
  if (key.startsWith('supabase:') && storage) {
    return res.redirect(302, storage.publicUrl(key.slice('supabase:'.length)));
  }
  const bytes = await getAssetBytes(kv, row.id);
  if (!bytes) return res.status(404).json({ error: 'asset bytes missing' });
  res.setHeader('Content-Type', bytes.mime);
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  res.send(Buffer.from(bytes.bytes));
});

app.delete('/assets/:id', async (req, res) => {
  const row = await repo.getAsset(req.params.id);
  if (!row) return res.status(404).json({ error: 'no such asset' });
  const key = String(row.storage_key || '');
  if (key.startsWith('supabase:') && storage) await storage.delObject(key.slice('supabase:'.length));
  else await delAssetBytes(kv, row.id);
  await repo.deleteAsset(row.id);
  res.json({ ok: true });
});

app.get('/brands/:id/assets', async (req, res) => {
  const rows = await repo.listAssets(req.params.id);
  res.json({
    items: rows.map((r) => ({
      id: r.id,
      url: String(r.storage_key || '').startsWith('supabase:') && storage
        ? storage.publicUrl(String(r.storage_key).slice('supabase:'.length))
        : '/assets/' + r.id,
      filename: r.filename, mime: r.mime, size: r.size, kind: r.kind,
      uploadedBy: r.uploaded_by, createdAt: r.created_at,
    })),
  });
});

// ---- tweak: prompt-to-refine with version chains ----------------------------
// The engine turns the prompt into a schema-validated parameter edit-plan,
// rebuilds through generate() + the real validator, and persists the new
// version with parentId/rootId lineage (see server/tweak-engine.js — the
// Pages Function in functions/tweak.js must stay wire-identical).
app.post('/tweak', async (req, res) => {
  const b = req.body || {};
  const result = await applyTweak({
    buildId: b.buildId,
    prompt: typeof b.prompt === 'string' ? b.prompt.slice(0, 500) : '',
    author: typeof b.author === 'string' ? b.author.slice(0, 60) : null,
    kv,
  }, { validate, providers: await llmProviders() });
  if (result.ok) appendHistory(buildHistoryEntry(result.build));
  res.status(result.ok ? 200 : 400).json(result);
});

app.get('/versions/:id', async (req, res) => {
  res.json({ items: await readVersions(kv, req.params.id) });
});

// ---- Genie 2.0 pitch workspace API -------------------------------------------
// The whole /api/* surface lives once in server/pitch-api.js (shared with
// functions/api/* via functions/_lib/pitch.js); this registrar only maps
// Express paths onto those runtime-agnostic handlers.
registerPitchRoutes(app, {
  repo, storage, kv, validate, llmProviders,
});

// ---- share pages: the pitch deliverable ------------------------------------
app.get('/b/:id', async (req, res) => {
  const build = await getBuild(kv, req.params.id);
  res.status(build ? 200 : 404).type('html').send(build ? buildPageHtml(build) : notFoundPageHtml('build'));
});
app.get('/s/:id', async (req, res) => {
  const slate = await getSlate(kv, req.params.id);
  if (!slate) return res.status(404).type('html').send(notFoundPageHtml('slate'));
  const builds = (await Promise.all((slate.buildIds || []).map((id) => getBuild(kv, id)))).filter(Boolean);
  res.type('html').send(slatePageHtml(slate, builds));
});
app.get('/build/:id', async (req, res) => {
  const build = await getBuild(kv, req.params.id);
  if (!build) return res.status(404).json({ error: 'No such build.' });
  const fmt = req.query.format;
  if (fmt === 'amp' || fmt === 'fallback') {
    const body = fmt === 'amp' ? build.ampHtml : build.fallbackHtml;
    res.setHeader('Content-Disposition', `attachment; filename="amp-genie-${(build.brand || 'brand').toLowerCase().replace(/[^a-z0-9]/g, '')}-${build.moduleId}${fmt === 'fallback' ? '-fallback' : ''}.html"`);
    return res.type('html').send(body || '');
  }
  // Inline (no attachment) so a share-page <iframe src> renders the exact AMP
  // instead of downloading it — the /b/ and /s/ pages' interactive preview.
  if (fmt === 'embed') {
    res.setHeader('Cache-Control', 'no-store');
    return res.type('html').send(build.ampHtml || '');
  }
  // JSON view strips the heavy parts — share pages only need the model.
  const { ampHtml, fallbackHtml, fallbackText, ...meta } = build;
  res.json(meta);
});

// ---- history: past builds, newest first, for later review -----------------
// A pure review aid — read-only, capped, never affects generation.
app.get('/history', (req, res) => {
  res.json({ items: readHistory(), max: MAX_ENTRIES });
});

// ---- validate: re-run the real validator on (possibly edited) AMP ---------
app.post('/validate', async (req, res) => {
  try {
    const v = await validate(req.body.ampHtml || '');
    res.json(v);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ---- dispatch: real send-to-inbox path -------------------------------------
app.post('/dispatch', async (req, res) => {
  const result = await dispatch(req.body || {});
  res.status(result.ok ? 200 : 400).json(result);
});

// ---- static web UI ----------------------------------------------------------
app.use(express.static(path.join(__dirname, '..', 'web')));

if (require.main === module) {
  app.listen(PORT, () => console.log(`AMP Genie on http://localhost:${PORT}`));
}

module.exports = { app };
