'use strict';

// The one build pipeline behind both /generate front doors. The full flow —
// brand kit/colour/logo resolution, brief normalisation, vertical/tone
// inference, deterministic keyword routing, optional LLM copy composition,
// generate(), real validation, fallback MIME parts, and the persisted build
// record — lives here exactly once, so the Express route (server/index.js)
// and the Pages Function (functions/generate.js) can never drift apart again.
//
// Runtime-agnostic on purpose: no HTTP types, no waitUntil, no filesystem —
// persistence goes through the injected kv handle (server/store.js's
// { get, put } subset) and history is the CALLER's job via buildHistoryEntry,
// so each runtime decides for itself how to await (or background) writes.

const { generate, pickModuleId } = require('./generate');
const { resolveBrandColor, resolveBrandLogo } = require('./brand');
const { composeContent } = require('./brief-content');
const {
  routeBrief, briefSignals, inferVertical, inferTone,
} = require('./brief-router');
const { normalizeBrief } = require('./history');
const {
  newId, brandSlug, getBrandKit, putBrandKit, putBuild,
} = require('./store');
const { buildFallback } = require('./fallback');

// body: the parsed /generate request body (untrusted client JSON).
// deps: {
//   validate:  async (ampHtml) -> verdict — injected because the two runtimes
//              carry different validator builds (Node wraps amphtml-validator,
//              the Worker runs the wasm glue) with the same result shape.
//   kv:        store handle (server/store.js subset) or null — null means "no
//              persistence", the build still generates and validates fully.
//   author / slateId / useCase: provenance strings (or null) recorded on the
//              build, never interpreted here.
// }
// Returns { response, build }: response is the wire shape the existing UI
// already consumes (plus the new copySource/fallback/share fields), build is
// the full persisted record (returned even when kv is null, so callers can
// still derive a history entry from it).
async function createBuild(body, deps = {}) {
  const b = (body && typeof body === 'object') ? body : {};
  const { kv = null, author = null, slateId = null, useCase = null } = deps;
  const validate = deps.validate;
  if (typeof validate !== 'function') {
    throw new Error('createBuild requires a validate(ampHtml) dependency');
  }

  const brand = (b.brand || '').trim() || 'Acme';
  const slug = brandSlug(brand);
  const brief = normalizeBrief(b.brief);

  // Brand-kit tier: a kit is the resolved-brand shape frozen at a previous
  // build's save time (see server/store.js), so a kit hit skips BOTH live
  // fetches entirely — no latency, no re-resolution drift. An explicit
  // colorOverride is the user insisting on a colour, so it bypasses the kit
  // and resolves as before (override wins inside resolveBrandColor anyway).
  const kit = !b.colorOverride ? await getBrandKit(kv, slug) : null;
  let colorResolved;
  let logoResolved;
  if (kit) {
    colorResolved = { primary: kit.primary, accent: kit.accent || null, source: 'kit' };
    logoResolved = kit.logoUrl ? { logoUrl: kit.logoUrl, site: kit.site || null } : null;
  } else {
    // Colour and logo are independent live-fetch lookups — run concurrently so
    // a real-logo lookup never adds latency on top of the colour resolver's.
    // Each has its own timeout budget and degrades to null/placeholder
    // independently.
    [colorResolved, logoResolved] = await Promise.all([
      resolveBrandColor({ brandName: brand, hexOverride: b.colorOverride }),
      resolveBrandLogo({ brandName: brand }),
    ]);
  }

  // Industry and tone are no longer supplied by the UI — infer them from the
  // brand + brief so the backend understands the brand on its own. An explicit
  // b.vertical / b.tone (e.g. from an API caller) still overrides; a kit's
  // saved vertical slots in as the inference fallback only, never above an
  // explicit choice.
  const vertical = b.vertical || (kit && kit.vertical) || inferVertical(brand, brief);
  const tone = b.tone || inferTone(brief);

  // Anything a live fetch actually won is worth freezing as the brand's kit so
  // the next build skips the fetches. Best-effort and deliberately not
  // awaited: putBrandKit validates its input and never throws (a bad kit is a
  // false, not an exception), so a slow/failed KV write can neither block nor
  // fail the build that triggered it.
  if (!kit && (colorResolved.source === 'fetched' || logoResolved)) {
    putBrandKit(kv, {
      slug,
      name: brand,
      primary: colorResolved.primary,
      accent: colorResolved.accent || null,
      vertical,
      logoUrl: logoResolved ? logoResolved.logoUrl : null,
      site: logoResolved ? logoResolved.site : null,
      source: colorResolved.source,
      updatedAt: new Date().toISOString(),
    });
  }
  // Tier-1 deterministic keyword routing: a brief's wording picks the module
  // unless the caller set an explicit b.moduleId (which always wins).
  const routed = brief ? routeBrief(brief, vertical) : null;
  const moduleId = pickModuleId({ brand, counter: b.counter, moduleId: b.moduleId || (routed && routed.moduleId) });
  const plan = brief
    ? await composeContent(brief, {
      moduleId, vertical, brandName: brand, tone,
    })
    : null;
  // Real fetched logo/site is the base layer; brief-driven plan overrides it;
  // an explicit manual copy override always wins, field by field.
  const logoCopy = logoResolved ? { logoUrl: logoResolved.logoUrl, site: logoResolved.site } : {};
  // Deterministic numbers the brief states outright (e.g. "40%") — the LLM
  // plan is structurally barred from setting these, so the headline it writes
  // and the big "X% OFF" the module renders would otherwise disagree.
  const briefSig = brief ? briefSignals(brief) : {};
  const manualCopy = (b.copy && typeof b.copy === 'object' && !Array.isArray(b.copy)) ? b.copy : {};
  const copy = { ...logoCopy, ...briefSig, ...(plan || {}), ...manualCopy };
  const g = generate({
    brand,
    vertical,
    tone,
    currency: b.currency,
    color: colorResolved.primary,
    moduleId,
    counter: b.counter,
    copy,
  });
  const validation = await validate(g.ampHtml);
  // `applied: false` marks the case where an explicit b.moduleId overrode the
  // router's suggestion — kept for audit even though it didn't win.
  const routedFromBrief = routed
    ? {
      moduleId: routed.moduleId, confidence: routed.confidence, matchedTerms: routed.matchedTerms, applied: !b.moduleId,
    }
    : null;
  // Provenance of the copy that actually rendered. composeContent doesn't
  // attach a provider name today; if a plan ever carries one, surface it
  // directly instead of the generic 'llm' — no extra plumbing needed here.
  const copySource = plan
    ? ((typeof plan.provider === 'string' && plan.provider) || 'llm')
    : 'template';
  // The static text/html + text/plain siblings, built from the SAME
  // previewModel as the AMP part so the three MIME parts can never disagree.
  const fallback = buildFallback({
    brand: g.brand,
    moduleId: g.moduleId,
    moduleName: g.moduleName,
    palette: g.palette,
    previewModel: g.previewModel,
    site: copy.site,
    logoUrl: copy.logoUrl,
    currency: g.currency,
  });

  const build = {
    id: newId(),
    ts: new Date().toISOString(),
    author,
    brand: g.brand,
    vertical: g.vertical,
    tone: g.tone,
    currency: g.currency,
    moduleId: g.moduleId,
    moduleName: g.moduleName,
    kind: g.kind,
    palette: g.palette,
    colorSource: colorResolved.source,
    brief,
    routedFromBrief,
    useCase,
    slateId,
    validation: { pass: validation.pass, errorCount: validation.errorCount, warningCount: validation.warningCount },
    ampHtml: g.ampHtml,
    fallbackHtml: fallback.html,
    fallbackText: fallback.text,
    previewModel: g.previewModel,
  };

  // Today's exact response shape first, then the v2 additions — the existing
  // UI keys off ...g/colorSource/validation/brief/routedFromBrief unchanged.
  const response = {
    ...g,
    colorSource: colorResolved.source,
    validation,
    brief,
    routedFromBrief,
    copySource,
    fallbackHtml: fallback.html,
    fallbackText: fallback.text,
  };
  // Awaited (unlike the kit write) because the share link may only be handed
  // out for a build that verifiably persisted; putBuild never throws, so a
  // failed/absent kv just means no shareId, never a failed build.
  if (await putBuild(kv, build)) {
    response.shareId = build.id;
    response.sharePath = '/b/' + build.id;
  }
  return { response, build };
}

// The legacy Recent-builds panel entry, derived from a v2 build record so
// callers keep appending to the same history list the UI already reads —
// shareId is the one addition, linking a panel row to its persisted build.
function buildHistoryEntry(build) {
  return {
    id: build.id,
    ts: build.ts,
    brand: build.brand,
    vertical: build.vertical,
    tone: build.tone,
    moduleId: build.moduleId,
    moduleName: build.moduleName,
    colorSource: build.colorSource,
    palette: build.palette,
    brief: build.brief,
    routedFromBrief: build.routedFromBrief,
    validationPass: build.validation ? build.validation.pass : false,
    ampHtml: build.ampHtml,
    shareId: build.id,
  };
}

module.exports = { createBuild, buildHistoryEntry };
