'use strict';

// GENIE 2.0 phase 1 — the pitch-workspace API, as PURE HANDLER functions.
// Everything the workspace UI needs (brands with researched dossiers, their
// products/contacts/assets, pitches, generated examples with tweak lineage,
// the activity feed) lives here exactly once: each handler takes a plain
// object of already-parsed values and returns { status, json } — no req/res
// types — so the Express routes (server/pitch-routes-express.js) and the
// Pages Functions (functions/api/**) are thin parsers over ONE implementation
// and stay wire-identical by construction, the same discipline as
// build-pipeline/tweak-engine before it.
//
// createPitchApi(ctx) with ctx = {
//   repo:         the bound DAO object (server/repo-supabase.js shape) —
//                 Supabase or bindLocalRepo, the handlers cannot tell.
//   storage:      Supabase storage handle (or null) — used only to turn
//                 asset storage_keys into public URLs, exactly the mapping
//                 server/index.js's GET /brands/:id/assets performs.
//   kv:           store handle (server/store.js subset) or null — the build
//                 pipeline's persistence + the dossier cache.
//   validate:     async (ampHtml) -> verdict, injected because the two
//                 runtimes carry different validator builds.
//   llmProviders: async () -> pool descriptors | undefined (undefined keeps
//                 the engines' own env-key detection), same contract as
//                 server/index.js llmProviders() / functions/_lib/genie.js.
// }
//
// Trust boundary: ids/slugs are shape-checked HERE before touching the repo
// (which re-checks — belt and braces), client strings are '<'/'>'-stripped
// and capped, and NOTHING throws into a request: every handler is wrapped so
// even a bug degrades to a 500 body, and a missing repo is an honest 503.
//
// Runtime-agnostic by charter: fetch/crypto only via the modules below — no
// fs, no path, no process.env reads at module load — so this bundles for
// Workers untouched.

const { buildDossier } = require('./brand-research');
const { resolveBrandColor, resolveBrandLogo } = require('./brand');
const { createBuild } = require('./build-pipeline');
const { applyTweak } = require('./tweak-engine');
const { brandSlug, putBrandKit, putBuild } = require('./store');
const emailDoc = require('./email-doc');
const { validateDoc, renderDoc } = emailDoc;
// GENIE 2.0: turning a legacy interactive example into an editable doc needs
// email-doc's interactive helpers. Required defensively (they land in the same
// phase) so pitch-api still loads if they are absent — exampleToDocH guards on
// interactiveDocForModule's presence and reports honestly rather than throwing.
// Resolved at CALL time, NOT captured at load: on the Workers esbuild bundle
// email-doc's exports may be unpopulated when pitch-api initializes, which
// would freeze INTERACTIVE_TYPES empty and make exampleToDocH synthesize
// static (non-interactive) docs on the deployment. Same fix as doc-ai.js.
const EMPTY_SET = new Set();
function interactiveDocForModule(args) {
  return typeof emailDoc.interactiveDocForModule === 'function' ? emailDoc.interactiveDocForModule(args) : null;
}
function interactiveTypes() {
  return emailDoc.INTERACTIVE_TYPES instanceof Set ? emailDoc.INTERACTIVE_TYPES : EMPTY_SET;
}
const { generateDoc } = require('./doc-ai');

// Local mirrors of the shapes repo.js/store.js enforce (kept private there —
// the regex is the contract, same restatement server/tweak-engine.js makes).
const ID_SHAPE = /^[a-z0-9-]{6,64}$/;
const SLUG_SHAPE = /^[a-z0-9]{1,64}$/;

const NAME_MAX = 80; // brand names, same cap as repo.js NAME_MAX
const TITLE_MAX = 120; // example titles, same cap as repo.js TITLE_MAX
const AUTHOR_MAX = 60; // the cap every existing route applies to `author`
const NOTES_MAX = 4000; // research notes, same cap as the /usecases routes
const MODULE_ID_MAX = 60;

function cleanStr(v) {
  return String(v == null ? '' : v).replace(/[<>]/g, '').trim();
}

function cleanAuthor(v) {
  if (typeof v !== 'string') return null;
  return cleanStr(v).slice(0, AUTHOR_MAX) || null;
}

function parseJson(text) {
  if (typeof text !== 'string' || !text) return null;
  try { return JSON.parse(text); } catch { return null; }
}

function nowIso() {
  return new Date().toISOString();
}

// The wire dossier — mirrors functions/usecases.js's publicDossier field for
// field, so the wizard reads one dossier shape whichever endpoint built it.
// Cache bookkeeping (notes, notesHash) never leaks into the UI contract.
function publicDossier(d) {
  return {
    name: d.name,
    slug: d.slug,
    site: d.site || null,
    summary: d.summary || '',
    products: d.products || [],
    categories: d.categories || [],
    audiences: d.audiences || [],
    voice: d.voice || { adjectives: [], donts: [] },
    currentCampaigns: d.currentCampaigns || [],
    vertical: d.vertical || 'Generic',
    confidence: d.confidence,
    researchedAt: d.researchedAt,
  };
}

// A brands row for the wire: dossier_json (a long string) becomes the parsed
// `dossier` object, and the raw json never ships.
function publicBrand(row) {
  if (!row || typeof row !== 'object') return row;
  const { dossier_json: dossierJson, ...rest } = row;
  rest.dossier = parseJson(dossierJson);
  return rest;
}

// Asset rows -> the item shape the UI renders, with the storage_key resolved
// to a fetchable URL — copied verbatim from server/index.js's
// GET /brands/:id/assets so the two asset listings can never disagree:
// supabase: keys resolve through storage.publicUrl, everything else serves
// through the runtime's own GET /assets/:id.
function assetItems(rows, storage) {
  return (Array.isArray(rows) ? rows : []).map((r) => ({
    id: r.id,
    url: String(r.storage_key || '').startsWith('supabase:') && storage
      ? storage.publicUrl(String(r.storage_key).slice('supabase:'.length))
      : '/assets/' + r.id,
    filename: r.filename,
    mime: r.mime,
    size: r.size,
    kind: r.kind,
    uploadedBy: r.uploaded_by,
    createdAt: r.created_at,
  }));
}

function createPitchApi(ctx = {}) {
  const { repo = null, storage = null, kv = null } = ctx;
  const validate = ctx.validate;

  // The provider seam never throws and never forces callers to null-check:
  // undefined means "engines keep their own env-key detection", exactly the
  // getMergedProviders contract in both runtimes.
  async function providers() {
    if (typeof ctx.llmProviders !== 'function') return undefined;
    try { return await ctx.llmProviders(); } catch { return undefined; }
  }

  const ok = (json) => ({ status: 200, json });
  const bad = (error) => ({ status: 400, json: { error } });
  const missing = (error) => ({ status: 404, json: { error } });

  // The never-throw contract, by construction: junk args coerce to {}, a
  // missing repo is a deliberate 503 (the Workers runtime without Supabase
  // configured), and anything unexpected degrades to a logged 500 body —
  // never an exception into the route.
  function guarded(fn) {
    return async (args) => {
      if (!repo) return { status: 503, json: { error: 'database not configured' } };
      try {
        return await fn(args && typeof args === 'object' ? args : {});
      } catch (e) {
        console.error('[pitch-api]', e && e.message);
        return { status: 500, json: { error: 'internal error' } };
      }
    };
  }

  // ---- brands -----------------------------------------------------------------

  async function listBrandsH() {
    return ok({ items: await repo.listBrands() });
  }

  // The wizard's research step: name in, researched brand out. The dossier,
  // the brand colour and the real logo are three independent lookups, so they
  // run CONCURRENTLY — each degrades on its own (all three never throw) and
  // the slowest one sets the latency, not the sum.
  async function createBrandH({ name, notes, author } = {}) {
    const brandName = cleanStr(name).slice(0, NAME_MAX);
    const slug = brandSlug(brandName);
    if (!brandName || !SLUG_SHAPE.test(slug)) {
      return bad('brand name required (needs at least one letter or digit)');
    }
    const noteText = typeof notes === 'string' ? notes.slice(0, NOTES_MAX) : null;
    const actor = cleanAuthor(author);
    const pool = await providers();
    const [dossier, color, logo] = await Promise.all([
      // kv keeps the dossier cache (dossier:<slug>), so re-adding a brand —
      // or the /usecases wizard hitting the same brand — reuses the research.
      buildDossier({ brandName, notes: noteText, kv }, { providers: pool }),
      resolveBrandColor({ brandName }),
      resolveBrandLogo({ brandName }),
    ]);
    const brand = await repo.upsertBrand({
      slug,
      name: brandName,
      // A hash colour is a deterministic GUESS, not brand truth — storing it
      // would assert a brand colour the brand never chose. Leave the column
      // null so the UI honestly shows "none yet" until a real source wins.
      primaryHex: color && color.source !== 'hash' ? color.primary : undefined,
      vertical: dossier.vertical,
      site: (logo && logo.site) || dossier.site || undefined,
      logoUrl: (logo && logo.logoUrl) || undefined,
      heroUrl: (logo && logo.heroUrl) || undefined,
      voiceSample: undefined,
      dossier,
      createdBy: actor,
    });
    // upsertBrand merges when the slug already exists — re-adding a brand
    // refreshes its research rather than erroring, which is what the team
    // actually means by typing a known name into the wizard.
    if (!brand) return { status: 500, json: { error: 'could not save the brand' } };
    await repo.logActivity({
      actor, brandId: brand.id, verb: 'brand-created', detail: brand.name,
    });
    return ok({ brand: publicBrand(brand), dossier: publicDossier(dossier) });
  }

  // The full workspace view for one brand: row + satellites in one response.
  async function brandDetail(row) {
    const [products, contacts, assets, pitches] = await Promise.all([
      repo.listProducts(row.id),
      repo.listContacts(row.id),
      repo.listAssets(row.id),
      repo.listPitchesForBrand(row.id),
    ]);
    return ok({
      brand: publicBrand(row),
      products,
      contacts,
      assets: assetItems(assets, storage),
      pitches,
    });
  }

  async function getBrandH({ id } = {}) {
    if (!ID_SHAPE.test(String(id || ''))) return bad('bad brand id');
    const row = await repo.getBrandById(id);
    if (!row) return missing('no such brand');
    return brandDetail(row);
  }

  async function getBrandBySlugH({ slug } = {}) {
    if (!SLUG_SHAPE.test(String(slug || ''))) return bad('bad brand slug');
    const row = await repo.getBrandBySlug(slug);
    if (!row) return missing('no such brand');
    return brandDetail(row);
  }

  // Kit fields ride setBrandKitFields (sanitizeKitPatch rules: present-and-
  // valid updates, invalid drops, '' clears); products are whole-list rows via
  // replaceProducts. products applies only when it is an ARRAY — a junk
  // non-array value is dropped like any other invalid field, because a typo
  // must never wipe a brand's saved catalogue.
  async function updateBrandKitH({
    id, patch, products, author,
  } = {}) {
    if (!ID_SHAPE.test(String(id || ''))) return bad('bad brand id');
    let brand = await repo.getBrandById(id);
    if (!brand) return missing('no such brand');
    const patchObj = (patch && typeof patch === 'object' && !Array.isArray(patch)) ? patch : null;
    const wantsProducts = Array.isArray(products);
    if (!patchObj && !wantsProducts) return bad('nothing to update');
    if (patchObj) {
      const updated = await repo.setBrandKitFields(id, patchObj);
      if (updated) brand = updated;
      else if (!wantsProducts) return bad('no valid kit fields in patch');
    }
    const rows = wantsProducts
      ? await repo.replaceProducts(id, products)
      : await repo.listProducts(id);
    await repo.logActivity({ actor: cleanAuthor(author), brandId: brand.id, verb: 'kit-updated' });
    return ok({ brand: publicBrand(brand), products: rows || [] });
  }

  // ---- contacts ---------------------------------------------------------------

  async function addContactH({ brandId, contact, author } = {}) {
    if (!ID_SHAPE.test(String(brandId || ''))) return bad('bad brand id');
    const brand = await repo.getBrandById(brandId);
    if (!brand) return missing('no such brand');
    const row = await repo.addContact(brandId, contact);
    if (!row) return bad('a contact needs at least a name');
    await repo.logActivity({
      actor: cleanAuthor(author), brandId: brand.id, verb: 'contact-added', detail: row.name,
    });
    return ok({ contact: row });
  }

  async function updateContactH({ id, contact } = {}) {
    if (!ID_SHAPE.test(String(id || ''))) return bad('bad contact id');
    const row = await repo.updateContact(id, contact);
    // The DAO folds "unknown id" and "nothing valid to change" into one null;
    // for a team tool one honest message beats a second lookup to tell them apart.
    if (!row) return missing('no such contact (or no valid contact fields)');
    return ok({ contact: row });
  }

  async function deleteContactH({ id } = {}) {
    if (!ID_SHAPE.test(String(id || ''))) return bad('bad contact id');
    const gone = await repo.deleteContact(id);
    if (!gone) return missing('no such contact');
    return ok({ ok: true });
  }

  // ---- pitches ----------------------------------------------------------------

  async function createPitchH({
    brandId, title, goal, brief, author,
  } = {}) {
    if (!ID_SHAPE.test(String(brandId || ''))) return bad('bad brand id');
    const brand = await repo.getBrandById(brandId);
    if (!brand) return missing('no such brand');
    const actor = cleanAuthor(author);
    const pitch = await repo.createPitch({
      brandId, title, goal, brief, createdBy: actor,
    });
    if (!pitch) return bad('a pitch needs a title');
    await repo.logActivity({
      actor, brandId: brand.id, pitchId: pitch.id, verb: 'pitch-created', detail: pitch.title,
    });
    return ok({ pitch });
  }

  async function listPitchesH() {
    return ok({ items: await repo.listAllPitches() });
  }

  async function getPitchH({ id } = {}) {
    if (!ID_SHAPE.test(String(id || ''))) return bad('bad pitch id');
    const pitch = await repo.getPitch(id);
    if (!pitch) return missing('no such pitch');
    const [brand, examples] = await Promise.all([
      repo.getBrandById(pitch.brand_id),
      // The gallery view: one row per version chain, tweaks collapsed.
      repo.latestExamplesPerRoot(pitch.id),
    ]);
    return ok({ pitch, brand: publicBrand(brand), examples });
  }

  async function updatePitchH({ id, patch } = {}) {
    if (!ID_SHAPE.test(String(id || ''))) return bad('bad pitch id');
    const existing = await repo.getPitch(id);
    if (!existing) return missing('no such pitch');
    const pitch = await repo.updatePitch(id, patch);
    if (!pitch) return bad('no valid pitch fields to change');
    return ok({ pitch });
  }

  // ---- examples: the bridge from the engines into the pitch space --------------

  // createExampleH is where the relational workspace meets the KV-era build
  // pipeline. The brands ROW is the source of truth for identity/assets/voice,
  // and it reaches createBuild through two channels:
  //
  //   1. The request body — colour as colorOverride, logo/hero/site/products
  //      as explicit copy fields (manual copy is the pipeline's highest-
  //      precedence layer, so the row's real assets can never lose to a
  //      live fetch or an LLM plan).
  //   2. THE KV-KIT BRIDGE — build-pipeline reads voiceSample only from the
  //      legacy KV brand kit (getBrandKit), and editing build-pipeline is out
  //      of scope, so the row is PROJECTED into that kit (source 'genie2')
  //      right before the build: the brands row stays the system of record
  //      and the KV kit becomes its derived projection. Best-effort by
  //      putBrandKit's own contract (false, never a throw) — a failed
  //      projection costs the voice steer, never the build. Projecting
  //      logoUrl+site also lets the pipeline skip its live logo fetch.
  async function createExampleH({
    pitchId, title, moduleId, brief, contentPlan, author,
  } = {}) {
    if (!ID_SHAPE.test(String(pitchId || ''))) return bad('bad pitch id');
    const pitch = await repo.getPitch(pitchId);
    if (!pitch) return missing('no such pitch');
    const brand = await repo.getBrandById(pitch.brand_id);
    if (!brand) return missing('the pitch has lost its brand row');
    const products = await repo.listProducts(brand.id);

    const actor = cleanAuthor(author);
    const exTitle = typeof title === 'string' ? cleanStr(title).slice(0, TITLE_MAX) : '';
    const modId = typeof moduleId === 'string' ? cleanStr(moduleId).slice(0, MODULE_ID_MAX) : '';
    const briefText = (typeof brief === 'string' && brief.trim()) ? brief : null;
    const plan = (contentPlan && typeof contentPlan === 'object' && !Array.isArray(contentPlan))
      ? contentPlan
      : {};

    // The KV-kit bridge (see the header comment above).
    await putBrandKit(kv, {
      slug: brand.slug,
      name: brand.name,
      ...(brand.primary_hex ? { primary: brand.primary_hex } : {}),
      logoUrl: brand.logo_url || undefined,
      heroUrl: brand.hero_url || undefined,
      site: brand.site || undefined,
      voiceSample: brand.voice_sample || undefined,
      source: 'genie2',
      updatedAt: nowIso(),
    });

    // The createBuild body, assembled from the brands row the way the old
    // kit-tier assembled it from the KV kit. Copy precedence inside the
    // pipeline is kit < briefSignals < LLM plan < brief items < THIS object
    // (manual copy) — so contentPlan (the ideation engine's draft) goes in
    // first and the row's hard assets are spread over it, field by field.
    const body = {
      brand: brand.name,
      brief: briefText || pitch.brief || undefined,
      colorOverride: brand.primary_hex || undefined,
      moduleId: modId || undefined,
      copy: {
        ...plan,
        ...(brand.logo_url ? { logoUrl: brand.logo_url, site: brand.site || undefined } : {}),
        ...(brand.hero_url ? { heroUrl: brand.hero_url } : {}),
        ...(products.length ? {
          items: products.map((p) => ({
            name: p.name,
            price: p.price ?? undefined,
            image: p.image_url || undefined,
          })),
        } : {}),
      },
      vertical: brand.vertical || undefined,
      author: actor,
    };
    const { response } = await createBuild(body, {
      validate,
      kv,
      author: actor,
      useCase: exTitle || undefined,
      providers: await providers(),
    });
    // The pipeline's output always passes today (every module validates by
    // construction); this gate exists so a future regression surfaces as an
    // honest 502 instead of a broken example row.
    if (!response.validation.pass) {
      return { status: 502, json: { error: 'generation failed validation' } };
    }
    const example = await repo.createExample({
      pitchId: pitch.id,
      title: exTitle || response.moduleName,
      moduleId: response.moduleId,
      // buildId links the example to its KV build record — the tweak engine's
      // entry point; body is kept for reproducibility/audit.
      params: { buildId: response.shareId || null, body },
      ampHtml: response.ampHtml,
      validationPass: response.validation.pass ? 1 : 0,
      createdBy: actor,
    });
    if (!example) return { status: 500, json: { error: 'could not record the example' } };
    await repo.logActivity({
      actor, brandId: pitch.brand_id, pitchId: pitch.id, verb: 'example-created', detail: example.title,
    });
    return ok({
      example,
      build: {
        sharePath: response.sharePath || null,
        moduleId: response.moduleId,
        moduleName: response.moduleName,
      },
    });
  }

  async function getExampleH({ id } = {}) {
    if (!ID_SHAPE.test(String(id || ''))) return bad('bad example id');
    const example = await repo.getExample(id);
    if (!example) return missing('no such example');
    const versions = await repo.listVersions(example.root_id || example.id);
    return ok({ example, versions });
  }

  // GET /api/examples/:id/as-doc — resolve an example TO AN EDITABLE DOC so the
  // GENIE 2.0 editor can open ANY example, not only doc ones. Three cases:
  //   1. A doc example (has doc_json): return the parsed doc as-is.
  //   2. A LEGACY interactive example (module_id ∈ INTERACTIVE_TYPES, has
  //      params_json but no doc_json): SYNTHESIZE a one-block interactive doc
  //      from the brand row + the example's stored copy, so the editor can edit
  //      it as a block document. { synthesized:true } flags this to the UI.
  //   3. Anything module-less / unknown: 400 — it cannot be edited as a doc.
  // Never throws (parseJson + interactiveDocForModule are safe).
  async function exampleToDocH({ id } = {}) {
    if (!ID_SHAPE.test(String(id || ''))) return bad('bad example id');
    const example = await repo.getExample(id);
    if (!example) return missing('no such example');

    // Case 1: a real doc example round-trips straight through validateDoc.
    const storedDoc = parseJson(example.doc_json);
    if (storedDoc && typeof storedDoc === 'object' && !Array.isArray(storedDoc)) {
      const v = validateDoc(storedDoc);
      if (v.ok) return ok({ doc: v.doc });
      // A persisted doc that no longer validates is a data problem, not a
      // client one — surface it honestly rather than silently synthesizing.
      return bad(v.error || 'the stored document is no longer valid');
    }

    // Case 2: a legacy interactive example -> synthesize an interactive doc.
    const moduleId = example.module_id;
    if (moduleId && interactiveTypes().has(moduleId)) {
      const brand = await repo.getBrandById(example.brand_id);
      const params = parseJson(example.params_json) || {};
      // The build pipeline stores copy at params.body.copy; be liberal about
      // where the copy sits so a slightly older shape still yields its copy.
      const copy = (params.body && params.body.copy && typeof params.body.copy === 'object')
        ? params.body.copy
        : (params.copy && typeof params.copy === 'object' ? params.copy : {});
      const doc = interactiveDocForModule({
        brand: brand ? {
          name: brand.name,
          primaryHex: brand.primary_hex || undefined,
          logoUrl: brand.logo_url || undefined,
        } : {},
        moduleId,
        copy,
        currency: (params.body && params.body.currency) || undefined,
      });
      return ok({ doc, synthesized: true });
    }

    // Case 3: no doc, no editable interactive module -> not editable as a doc.
    return bad('this example cannot be edited as a document');
  }

  // Tweak = applyTweak against the example's linked build, then the accepted
  // rebuild lands as a NEW example row with parent/root lineage (the v3.1
  // contract) — the original is never mutated.
  async function tweakExampleH({ id, prompt, author } = {}) {
    if (!ID_SHAPE.test(String(id || ''))) return bad('bad example id');
    const example = await repo.getExample(id);
    if (!example) return missing('no such example');
    const params = parseJson(example.params_json);
    const buildId = (params && typeof params.buildId === 'string') ? params.buildId : null;
    if (!buildId || !ID_SHAPE.test(buildId)) {
      return bad('this example predates tweak support — regenerate it first');
    }
    const actor = cleanAuthor(author);
    const promptText = typeof prompt === 'string' ? prompt : '';
    const result = await applyTweak(
      { buildId, prompt: promptText, author: actor, kv },
      { validate, providers: await providers() },
    );
    // The engine's explanatory errors ({ ok:false, error }) pass through
    // verbatim — same wire shape the /tweak front doors already speak.
    if (!result.ok) return { status: 400, json: result };
    const next = await repo.createExample({
      pitchId: example.pitch_id,
      parentId: example.id,
      title: example.title,
      moduleId: result.response.moduleId,
      params: { buildId: result.response.shareId || null, tweakOf: buildId },
      ampHtml: result.response.ampHtml,
      validationPass: 1, // applyTweak only returns ok for a validator-passing rebuild
      tweakPrompt: promptText,
      createdBy: actor,
    });
    if (!next) return { status: 500, json: { error: 'could not record the tweaked example' } };
    await repo.logActivity({
      actor,
      brandId: example.brand_id,
      pitchId: example.pitch_id,
      verb: 'example-tweaked',
      detail: promptText,
    });
    return ok({ example: next, build: { sharePath: result.response.sharePath || null } });
  }

  // ---- doc editor (phase 4): the visual block-email editor's backend --------------
  //
  // A doc is server/email-doc.js's block document; renderDoc turns it into ONE
  // AMP4EMAIL document that passes the real validator. These handlers are the
  // editor's live-preview (pure), save-new, save-edit and AI-draft endpoints.
  //
  // SHARE-PAGE DECISION: option (a). A doc example does NOT go through
  // createBuild, so it has no KV build record and /b/<id> would 404. We
  // therefore persist a MINIMAL build record (the flat fields buildPageHtml +
  // /build/:id?format=amp actually read: id, brand, moduleName, useCase,
  // palette, logoUrl, validation, ts, author, ampHtml, fallbackHtml) under
  // build:<id> via putBuild, and hand back sharePath '/b/<id>'. Best-effort by
  // putBuild's own contract (false, never a throw) — a failed/absent kv just
  // means sharePath:null and the editor uses its in-app preview, never a
  // failed save.

  // Validate + render a doc to one AMP document and run the injected validator.
  // Pure and never throws (validateDoc/renderDoc/validate are all safe); shape
  // errors surface as { ok:false }. Shared by every doc handler below.
  async function renderDocResult(doc) {
    const v = validateDoc(doc);
    if (!v.ok) return { ok: false, error: v.error };
    const r = renderDoc(v.doc);
    const verdict = await validate(r.ampHtml);
    return {
      ok: true,
      doc: v.doc,
      ampHtml: r.ampHtml,
      warnings: r.warnings || [],
      validation: {
        pass: !!(verdict && verdict.pass),
        errorCount: (verdict && Math.max(0, Math.round(Number(verdict.errorCount)) || 0)) || 0,
      },
    };
  }

  // The minimal KV build record a doc example needs for its /b/<id> share page
  // (see the option-(a) note above). buildId is the caller's chosen id (the
  // example id, so the share link is stable across edits). Returns buildId when
  // it persisted, else null — putBuild is best-effort and never throws.
  async function putDocBuild({ buildId, brand, title, doc, ampHtml, validation }) {
    const palette = derivePaletteSafe(doc);
    const record = {
      id: buildId,
      ts: nowIso(),
      brand: (brand && brand.name) || 'Brand',
      moduleName: 'Block email',
      useCase: title || undefined,
      palette,
      logoUrl: (brand && brand.logo_url) || undefined,
      validation: { pass: !!validation.pass, errorCount: validation.errorCount, warningCount: 0 },
      ampHtml,
      // The download/preview siblings the share page's amp part uses; a doc has
      // no static-html twin, so the AMP doubles as both — buildPageHtml only
      // reads fallbackHtml for the ?format=html download, which a doc email
      // does not offer, so the AMP is the honest content for both formats.
      fallbackHtml: ampHtml,
    };
    try {
      return (await putBuild(kv, record)) ? buildId : null;
    } catch {
      return null;
    }
  }

  // A doc carries its own brand.primaryHex; derive the share page's palette
  // from it the way build records do, defaulting when absent. Kept local +
  // guarded so a doc without a colour never breaks the share record.
  function derivePaletteSafe(doc) {
    try {
      // eslint-disable-next-line global-require
      const { derivePalette } = require('./generate');
      const hex = (doc && doc.brand && doc.brand.primaryHex) || '#4f46e5';
      return derivePalette(hex);
    } catch {
      return undefined;
    }
  }

  // POST /api/docs/render — the editor's live-preview endpoint. Pure: no
  // persistence, no id. A non-object doc is a 400; anything else validates,
  // renders and reports the verdict + the sanitized doc (so the editor can
  // reconcile what survived the trust boundary, e.g. a hostile string that was
  // stripped or a bad block that was dropped).
  async function renderDocH({ doc } = {}) {
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return bad('doc must be an object');
    const r = await renderDocResult(doc);
    if (!r.ok) return bad(r.error || 'invalid doc');
    return ok({
      ampHtml: r.ampHtml,
      validation: r.validation,
      warnings: r.warnings,
      doc: r.doc,
    });
  }

  // POST /api/pitches/:id/doc-examples — save a NEW doc example into a pitch.
  // Validates + renders; a doc that does not pass the validator is a 400 (the
  // editor should never be able to persist a broken email). Stores the example
  // with module_id 'doc' + doc_json + amp_html + validation_pass 1, seeds the
  // KV share record (option a), and logs example-created.
  async function createDocExampleH({
    pitchId, title, doc, author,
  } = {}) {
    if (!ID_SHAPE.test(String(pitchId || ''))) return bad('bad pitch id');
    const pitch = await repo.getPitch(pitchId);
    if (!pitch) return missing('no such pitch');
    const brand = await repo.getBrandById(pitch.brand_id);
    if (!brand) return missing('the pitch has lost its brand row');
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return bad('doc must be an object');

    const r = await renderDocResult(doc);
    if (!r.ok) return bad(r.error || 'invalid doc');
    if (!r.validation.pass) {
      return { status: 400, json: { error: 'the email did not pass AMP validation', validation: r.validation } };
    }

    const actor = cleanAuthor(author);
    const exTitle = typeof title === 'string' ? cleanStr(title).slice(0, TITLE_MAX) : '';
    const example = await repo.createExample({
      pitchId: pitch.id,
      title: exTitle || 'Block email',
      moduleId: 'doc',
      doc: r.doc,
      ampHtml: r.ampHtml,
      validationPass: 1,
      createdBy: actor,
    });
    if (!example) return { status: 500, json: { error: 'could not record the example' } };

    // Share record keyed by the example id, so the link is stable across edits.
    const shareId = await putDocBuild({
      buildId: example.id, brand, title: exTitle, doc: r.doc, ampHtml: r.ampHtml, validation: r.validation,
    });
    await repo.logActivity({
      actor, brandId: pitch.brand_id, pitchId: pitch.id, verb: 'example-created', detail: example.title,
    });
    return ok({
      example,
      build: {
        sharePath: shareId ? '/b/' + shareId : null,
        moduleId: 'doc',
        moduleName: 'Block email',
        validation: r.validation,
      },
    });
  }

  // PATCH /api/examples/:id/doc — save an EDIT to an existing doc example in
  // place (no new row — an edit is the same example, unlike a tweak). Re-renders
  // + re-validates; a doc that fails the validator is a 400; refreshes the KV
  // share record keyed to the example id; logs example-edited.
  async function updateDocExampleH({ id, doc, author } = {}) {
    if (!ID_SHAPE.test(String(id || ''))) return bad('bad example id');
    const existing = await repo.getExample(id);
    if (!existing) return missing('no such example');
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return bad('doc must be an object');

    const r = await renderDocResult(doc);
    if (!r.ok) return bad(r.error || 'invalid doc');
    if (!r.validation.pass) {
      return { status: 400, json: { error: 'the email did not pass AMP validation', validation: r.validation } };
    }

    const example = await repo.updateExampleDoc(id, {
      doc: r.doc, ampHtml: r.ampHtml, validationPass: 1,
    });
    if (!example) return { status: 500, json: { error: 'could not update the example' } };

    // Refresh the same-id share record so /b/<id> reflects the edit.
    const brand = await repo.getBrandById(example.brand_id);
    const shareId = await putDocBuild({
      buildId: example.id, brand, title: example.title, doc: r.doc, ampHtml: r.ampHtml, validation: r.validation,
    });
    await repo.logActivity({
      actor: cleanAuthor(author),
      brandId: example.brand_id,
      pitchId: example.pitch_id,
      verb: 'example-edited',
      detail: example.title,
    });
    return ok({
      example,
      build: { sharePath: shareId ? '/b/' + shareId : null, validation: r.validation },
    });
  }

  // POST /api/pitches/:id/ai-doc — AI-draft a starter doc for the editor to
  // open. NOT saved: the editor opens it, edits, then createDocExample saves.
  // generateDoc always returns a validated doc (fallback offline), so this
  // never fails once the pitch exists.
  async function aiDocH({
    pitchId, brief, useCase, moduleId, author,
  } = {}) {
    if (!ID_SHAPE.test(String(pitchId || ''))) return bad('bad pitch id');
    const pitch = await repo.getPitch(pitchId);
    if (!pitch) return missing('no such pitch');
    const brand = await repo.getBrandById(pitch.brand_id);
    if (!brand) return missing('the pitch has lost its brand row');
    const products = await repo.listProducts(brand.id);

    const briefText = (typeof brief === 'string' && brief.trim()) ? brief : (pitch.brief || '');
    // moduleId + useCase thread through to generateDoc so the returned starting
    // doc carries the interactive module the editor asked for (an unknown/absent
    // id lets doc-ai route it from the brief). Both are shape-guarded here —
    // generateDoc re-validates the module id, so a junk value simply routes.
    const reqModuleId = (typeof moduleId === 'string' && moduleId.trim())
      ? cleanStr(moduleId).slice(0, MODULE_ID_MAX)
      : undefined;
    const doc = await generateDoc({
      brand: {
        name: brand.name,
        primaryHex: brand.primary_hex || undefined,
        logoUrl: brand.logo_url || undefined,
        site: brand.site || undefined,
        voice: brand.voice_sample || undefined,
        items: products.map((p) => ({
          name: p.name, price: p.price ?? undefined, imageUrl: p.image_url || undefined,
        })),
      },
      brief: briefText,
      useCase,
      moduleId: reqModuleId,
    }, { providers: await providers(), moduleId: reqModuleId });
    // author is accepted for wire-symmetry with the other doc handlers (the
    // draft is unsaved, so it is not logged) — referenced to satisfy lint.
    void author;
    return ok({ doc });
  }

  // ---- activity -----------------------------------------------------------------

  async function brandActivityH({ brandId } = {}) {
    if (!ID_SHAPE.test(String(brandId || ''))) return bad('bad brand id');
    return ok({ items: await repo.listActivity({ brandId, limit: 50 }) });
  }

  return {
    listBrandsH: guarded(listBrandsH),
    createBrandH: guarded(createBrandH),
    getBrandH: guarded(getBrandH),
    getBrandBySlugH: guarded(getBrandBySlugH),
    updateBrandKitH: guarded(updateBrandKitH),
    addContactH: guarded(addContactH),
    updateContactH: guarded(updateContactH),
    deleteContactH: guarded(deleteContactH),
    createPitchH: guarded(createPitchH),
    listPitchesH: guarded(listPitchesH),
    getPitchH: guarded(getPitchH),
    updatePitchH: guarded(updatePitchH),
    createExampleH: guarded(createExampleH),
    getExampleH: guarded(getExampleH),
    exampleToDocH: guarded(exampleToDocH),
    tweakExampleH: guarded(tweakExampleH),
    renderDocH: guarded(renderDocH),
    createDocExampleH: guarded(createDocExampleH),
    updateDocExampleH: guarded(updateDocExampleH),
    aiDocH: guarded(aiDocH),
    brandActivityH: guarded(brandActivityH),
  };
}

module.exports = { createPitchApi };
