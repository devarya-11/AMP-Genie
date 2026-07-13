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
  routeBrief, briefSignals, briefProducts, inferVertical, inferTone,
} = require('./brief-router');
const {
  newId, brandSlug, normalizeBrief, getBrandKit, putBrandKit, putBuild,
} = require('./store');
const { buildFallback } = require('./fallback');

// A URL from a kit (or any KV-seeded string) is only usable if it parses as a
// real http(s) URL and carries no markup characters; anything else is dropped,
// never "fixed". Returns the ORIGINAL string (not URL.toString(), which can
// normalise) so a stored asset URL round-trips byte-identical.
function httpUrl(val) {
  if (typeof val !== 'string' || !val.trim() || /[<>]/.test(val)) return null;
  try {
    const u = new URL(val);
    return (u.protocol === 'https:' || u.protocol === 'http:') ? val : null;
  } catch {
    return null;
  }
}

// The kit's curated products, mapped to the copy.items shape generate()
// consumes ({ name, price?, image? }). putBrandKit sanitises products at save
// time, but a KV record can be seeded by hand, so everything is re-checked
// here: a valid name is required (markup stripped, capped), price -> positive
// finite int or dropped, image -> http(s) URL or dropped, list capped at 8.
function kitCopyItems(kit) {
  if (!kit || !Array.isArray(kit.products)) return {};
  const items = [];
  for (const p of kit.products) {
    if (items.length >= 8) break;
    if (!p || typeof p.name !== 'string') continue;
    const name = p.name.replace(/[<>]/g, '').trim().slice(0, 60);
    if (!name) continue;
    const item = { name };
    const price = Number(p.price);
    if (Number.isFinite(price) && price > 0) item.price = Math.round(price);
    const image = httpUrl(p.image);
    if (image) item.image = image;
    items.push(item);
  }
  return items.length ? { items } : {};
}

// body: the parsed /generate request body (untrusted client JSON).
// deps: {
//   validate:  async (ampHtml) -> verdict — injected because the two runtimes
//              carry different validator builds (Node wraps amphtml-validator,
//              the Worker runs the wasm glue) with the same result shape.
//   kv:        store handle (server/store.js subset) or null — null means "no
//              persistence", the build still generates and validates fully.
//   author / slateId / useCase: provenance strings (or null) recorded on the
//              build, never interpreted here.
//   parentId / rootId / tweakPrompt: tweak-lineage provenance (or null) set by
//              server/tweak-engine.js when this build is a rebuilt edit of an
//              earlier one — recorded, never interpreted here. The CALLER
//              computes rootId (the parent's root, or the parent itself), so a
//              build with no parent can never carry a stray root.
// }
// Returns { response, build }: response is the wire shape the existing UI
// already consumes (plus the new copySource/fallback/share fields), build is
// the full persisted record (returned even when kv is null, so callers can
// still derive a history entry from it).
async function createBuild(body, deps = {}) {
  const b = (body && typeof body === 'object') ? body : {};
  const {
    kv = null, author = null, slateId = null, useCase = null,
    parentId = null, rootId = null, tweakPrompt = null,
    // Genie 2.0 key pool: when the route passes descriptors they take over
    // composeContent's provider list; undefined keeps the env-key detection.
    providers = undefined,
  } = deps;
  const validate = deps.validate;
  if (typeof validate !== 'function') {
    throw new Error('createBuild requires a validate(ampHtml) dependency');
  }

  const brand = (b.brand || '').trim() || 'Acme';
  const slug = brandSlug(brand);
  const brief = normalizeBrief(b.brief);

  // Brand-kit tier: a kit is no longer only a frozen colour — it is the
  // brand's ASSETS record (logo, hero, curated products, voice sample; see
  // server/store.js), so it is ALWAYS loaded, even under an explicit
  // colorOverride: overriding the colour is the user insisting on a hue, not
  // on losing the brand's real logo/products/voice.
  const kit = await getBrandKit(kv, slug);
  // primary is OPTIONAL on a kit now (an assets-only kit for a library-colour
  // brand is legal), so the 'kit' colour tier only engages when the kit
  // actually carries a usable '#rrggbb' — anything else resolves live
  // (override/library/fetched/hash) exactly as if the kit weren't there. An
  // explicit colorOverride still bypasses the kit colour and resolves as
  // before (override wins inside resolveBrandColor anyway).
  const kitPrimary = (kit && /^#[0-9a-f]{6}$/i.test(String(kit.primary || ''))) ? kit.primary : null;
  const needsLiveColor = !!b.colorOverride || !kitPrimary;
  // The live logo fetch is skipped only when the kit fully supplies what that
  // fetch would win (logo + site); a partial kit still fetches, and the kit's
  // own fields win field-by-field over whatever the fetch found.
  const needsLiveLogo = !(kit && kit.logoUrl && kit.site);
  // Colour and logo are independent live-fetch lookups — run concurrently so
  // a real-logo lookup never adds latency on top of the colour resolver's.
  // Each has its own timeout budget and degrades to null/placeholder
  // independently.
  const [liveColor, liveLogo] = await Promise.all([
    needsLiveColor ? resolveBrandColor({ brandName: brand, hexOverride: b.colorOverride }) : null,
    needsLiveLogo ? resolveBrandLogo({ brandName: brand }) : null,
  ]);
  const colorResolved = liveColor || { primary: kitPrimary, accent: kit.accent || null, source: 'kit' };
  // Kit assets beat live-fetched ones field by field, and every URL is
  // re-validated on the way out of the KV (a hand-seeded record must not be
  // able to smuggle a non-URL into an src attribute). heroUrl layering starts
  // here — live og:image < kit.heroUrl — and manual copy.heroUrl wins below.
  const logoUrl = httpUrl(kit && kit.logoUrl) || (liveLogo ? liveLogo.logoUrl : null);
  const site = httpUrl(kit && kit.site) || (liveLogo ? liveLogo.site : null);
  const heroUrl = httpUrl(kit && kit.heroUrl) || (liveLogo ? liveLogo.heroUrl : null) || null;
  const logoResolved = (logoUrl || site || heroUrl) ? { logoUrl, site, heroUrl } : null;

  // Industry and tone are no longer supplied by the UI — infer them from the
  // brand + brief so the backend understands the brand on its own. An explicit
  // b.vertical / b.tone (e.g. from an API caller) still overrides; a kit's
  // saved vertical slots in as the inference fallback only, never above an
  // explicit choice.
  const vertical = b.vertical || (kit && kit.vertical) || inferVertical(brand, brief);
  const tone = b.tone || inferTone(brief);

  // Anything a live fetch actually won is worth freezing as the brand's kit
  // (heroUrl included) so the next build skips the fetches. Best-effort and
  // deliberately not awaited: putBrandKit validates its input and never
  // throws (a bad kit is a false, not an exception), so a slow/failed KV
  // write can neither block nor fail the build that triggered it. Spreading
  // the existing kit first keeps curated fields (products, voiceSample) the
  // pipeline doesn't recompute; a kit someone edited by hand (source
  // 'manual') is NEVER auto-overwritten.
  const liveWin = !!((liveColor && liveColor.source === 'fetched') || liveLogo);
  if (liveWin && !(kit && kit.source === 'manual')) {
    putBrandKit(kv, {
      ...(kit || {}),
      slug,
      name: brand,
      primary: colorResolved.primary,
      accent: colorResolved.accent || null,
      vertical,
      logoUrl: logoResolved ? logoResolved.logoUrl : null,
      site: logoResolved ? logoResolved.site : null,
      heroUrl: logoResolved ? logoResolved.heroUrl : null,
      source: liveColor ? liveColor.source : kit.source,
      updatedAt: new Date().toISOString(),
    });
  }
  // Real products (name + price) the user pasted into the brief — these ground
  // the email in the brand's ACTUAL items instead of the vertical's synthetic
  // placeholders. Deterministic, like briefSignals.
  const prod = brief ? briefProducts(brief) : {};
  const hasRealItems = Array.isArray(prod.items) && prod.items.length >= 2;
  // Tier-1 deterministic keyword routing: a brief's wording picks the module
  // unless the caller set an explicit b.moduleId (which always wins).
  const routed = brief ? routeBrief(brief, vertical) : null;
  const routedModule = routed && routed.moduleId;
  // If the brief lists real products, bias toward a module that actually shows
  // them (search for a catalogue-style brief, otherwise the offer reveal)
  // unless the caller forced a module or the router already picked a product
  // module.
  const PRODUCT_MODULES = new Set(['reveal', 'search']);
  let itemBias = null;
  if (hasRealItems && !b.moduleId && !(routedModule && PRODUCT_MODULES.has(routedModule))) {
    itemBias = /\b(menu|catalog|catalogue|collection|range|dishes|products|line-?up|lineup|list)\b/i.test(brief) ? 'search' : 'reveal';
  }
  const moduleId = pickModuleId({ brand, counter: b.counter, moduleId: b.moduleId || itemBias || routedModule });
  // The kit's pasted voice sample steers the LLM copy tier (prompt-only — it
  // never lands in the rendered output or the build record). Markup-stripped
  // and capped here so a hand-seeded KV record can't bloat or poison a prompt.
  const voiceSample = (kit && typeof kit.voiceSample === 'string')
    ? kit.voiceSample.replace(/[<>]/g, '').trim().slice(0, 1500) || null
    : null;
  const plan = brief
    ? await composeContent(brief, {
      moduleId, vertical, brandName: brand, tone, voiceSample,
    }, providers ? { providers } : undefined)
    : null;
  // Real fetched logo/site (plus any hero the kit or live fetch surfaced) is
  // the base layer; brief-driven plan overrides it; an explicit manual copy
  // override always wins, field by field. heroUrl joins the copy only when
  // truthy so a brand with no kit/hero keeps byte-identical output.
  const logoCopy = logoResolved
    ? {
      logoUrl: logoResolved.logoUrl,
      site: logoResolved.site,
      ...(logoResolved.heroUrl ? { heroUrl: logoResolved.heroUrl } : {}),
    }
    : {};
  // The kit's curated products: above the fetched logo layer, below the
  // brief's deterministic signals, the LLM plan, real brief-pasted items and
  // any manual override — kit.products < briefProducts < copy.items.
  const kitItems = kitCopyItems(kit);
  // Deterministic numbers the brief states outright (e.g. "40%") — the LLM
  // plan is structurally barred from setting these, so the headline it writes
  // and the big "X% OFF" the module renders would otherwise disagree.
  const briefSig = brief ? briefSignals(brief) : {};
  // Real pasted items (name + price) sit ABOVE the LLM plan (which cannot set
  // prices anyway) so a real product name is never overwritten, but below an
  // explicit manual copy override.
  const briefItems = prod.items && prod.items.length ? { items: prod.items } : {};
  const manualCopy = (b.copy && typeof b.copy === 'object' && !Array.isArray(b.copy)) ? b.copy : {};
  const copy = {
    ...logoCopy, ...kitItems, ...briefSig, ...(plan || {}), ...briefItems, ...manualCopy,
  };
  // The hero channel accepts real http(s) URLs only, whichever layer supplied
  // it — a manual override that isn't one is dropped, never rendered.
  if (copy.heroUrl !== undefined && !httpUrl(copy.heroUrl)) delete copy.heroUrl;
  const g = generate({
    brand,
    vertical,
    tone,
    // A currency stated in the pasted prices ("$999" → USD) flows through; an
    // explicit b.currency still wins, and generate() defaults to INR.
    currency: b.currency || prod.currency,
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
      moduleId: routed.moduleId, confidence: routed.confidence, matchedTerms: routed.matchedTerms, applied: !b.moduleId && !itemBias,
    }
    : null;
  // Audit: how many real products the brief supplied, the currency they
  // implied, and whether they biased the module choice.
  const productsFromBrief = prod.items && prod.items.length
    ? { count: prod.items.length, currency: prod.currency, moduleBias: itemBias }
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
    productsFromBrief,
    useCase,
    slateId,
    parentId,
    rootId: parentId ? rootId : null,
    tweakPrompt,
    // Everything needed to reproduce (or rebase) this exact build later: the
    // tweak engine re-runs createBuild from these plus its own edits, so the
    // record must capture the FINAL merged copy that actually reached
    // generate(), not the raw request fields it was merged from.
    params: {
      counter: b.counter ?? 0,
      colorOverride: b.colorOverride || null,
      copy,
    },
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
    productsFromBrief,
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
