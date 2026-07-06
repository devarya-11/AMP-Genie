'use strict';

// ============================================================================
// reference/integrate.js — Phase 5: wire the Vertical Reference System into the
// generator WITHOUT the generator ever learning about the reference layer.
//
//   generateWithForm(spec) -> { ...buildProduction(), form }
//
// The seam (one-directional, by design):
//   reference/  KNOWS server/   (it orchestrates a build)
//   server/     does NOT know reference/  (it only accepts two FORM hints:
//                opts.aesthetic + opts.form, both already brand-agnostic)
//
// Pipeline:
//   1. resolveAssets(spec)              — IDENTITY: brand, palette, products (client)
//   2. clientToVertical(client)         — which spec vertical does this client live in
//   3. pickLayout(vertical,module,intent) — FORM: a brand-agnostic LayoutSkeleton
//   4. assertAbstract(skeleton)         — forward guard: skeleton carries no identity
//   5. derive aesthetic register        — ONLY if the brand supplies none (identity-first)
//   6. buildProduction({...,form,aesthetic}) — slots filled from the client context
//   7. assertNoReferenceLeak(ampHtml)   — backward guard: no reference value rode along
//
// The result is the spec's contract: the SAME LayoutSkeleton lands in the single
// GenerationContext (build.js context.form) that preview + AMP read, and the
// assertion layer fails loudly if any concrete value traced to a reference email.
// ============================================================================

const assets = require('../server/assets');
const build = require('../server/build');
const { pickLayout } = require('./library');
const { clientToVertical, loadCoverage } = require('./classify');
const { assertAbstract, assertNoReferenceLeak } = require('./assert');
const V = require('./vocab');

// ---- FORM directives → aesthetic register (only used when brand sets none) --
// Maps a brand-agnostic LayoutSkeleton's type/palette/copy directives onto one
// of build.js's five registers (playful/bold/fintech/minimal/luxury). This is
// FORM→FORM: no identity is invented, we just pick the house look whose grammar
// matches the vertical's distilled conventions.
function deriveAesthetic(skeleton) {
  const t = skeleton.type_directives || {};
  const pal = skeleton.palette_directives || {};
  const c = skeleton.copy_directives || {};
  // serif, letterspaced, restrained, no emoji → editorial luxury
  if (t.serif_display && t.letterspaced_headings && !c.use_emoji) return 'luxury';
  // loud all-caps headlines on high-contrast/dark bands → bold
  if (t.all_caps_headings && (pal.dark_section || pal.cta_contrast === 'high')) return 'bold';
  // sparse, text-led, offer-free/editorial → fintech (calm, informational)
  if (c.image_density === 'sparse' && (c.offer_framing === 'none' || c.offer_framing === 'editorial')) return 'fintech';
  // restrained, no emoji, shallow hierarchy → minimal
  if (!c.use_emoji && !t.all_caps_headings) return 'minimal';
  // default house look
  return 'playful';
}

// Map a coarse internal vertical (resolved.brand.vertical) to a spec vertical
// when the client roster has no entry — reuses classify's COARSE_TO_SPEC via
// clientToVertical's fallback branch.
async function resolveSpecVertical({ clientName, brandName, coarseVertical }) {
  const cv = clientToVertical(clientName || brandName || '', coarseVertical);
  return cv; // { vertical, coverage, client }
}

async function generateWithForm(spec = {}) {
  // 1) IDENTITY — resolve the client's own brand, palette, products.
  const need = spec.need || { logo: true, products: 3 };
  const resolved = await assets.resolveAssets({
    brandUrl: spec.brandUrl, brandName: spec.brandName,
    vertical: spec.vertical, tone: spec.tone, currency: spec.currency,
    user: spec.user || {}, need,
  });
  const brand = resolved.brand || {};
  const coarseVertical = brand.vertical || spec.vertical || 'Generic';

  // 2) which spec vertical does this client live in (roster → coarse fallback)
  const clientName = spec.clientName || spec.brandName || brand.name || '';
  const cv = await resolveSpecVertical({ clientName, brandName: brand.name, coarseVertical });
  const specVertical = V.VERTICALS.includes(cv.vertical) ? cv.vertical : 'generic';

  // 3) module + intent, then FORM: a brand-agnostic LayoutSkeleton
  let moduleId = spec.moduleId;
  if (!moduleId || moduleId === 'auto') moduleId = build.chooseModule(coarseVertical, (brand.name || '') + (spec.reroll || 0));
  const intent = spec.intent || null;
  const coverage = spec.coverage || await loadCoverage();
  const skeleton = await pickLayout(specVertical, moduleId, intent, { coverage });

  // 4) FORWARD GUARD — the skeleton must carry zero brand identity. We exclude
  //    `module`: it is the CLIENT's chosen AMP mechanic id (reveal/spin/quiz…),
  //    a system token, not a reference value — pickLayout deliberately attaches
  //    it AFTER its own assertion for exactly this reason.
  const { module: _moduleChoice, ...formOnly } = skeleton;
  assertAbstract(formOnly);

  // 5) aesthetic register: IDENTITY-FIRST. A brand's OWN aesthetic always wins;
  //    only when it supplies none does the FORM-derived register fill in.
  const aesthetic = brand.aesthetic || deriveAesthetic(skeleton);

  // 6) GENERATE — the skeleton rides in as opts.form (→ context.form) and the
  //    derived register as opts.aesthetic. Every CONCRETE value (colour, image,
  //    font, copy) is filled from `resolved` (the client), never the skeleton.
  const built = build.buildProduction({
    moduleId, resolved,
    currency: spec.currency, copy: spec.copy, reroll: spec.reroll,
    endpoint: spec.endpoint, apiBase: spec.apiBase, clientName,
    fulfillmentPath: spec.fulfillmentPath, // GenerationContext flag (Pay-in-mail)
    aesthetic,          // FORM hint (used only if brand.aesthetic is absent)
    form: skeleton,     // the LayoutSkeleton, written into the GenerationContext
  });

  // 7) BACKWARD GUARD — prove the boundary held end-to-end: no chromatic hex,
  //    image URL, or custom font from any reference email survived into output,
  //    EXCEPT values the client independently owns (its GenerationContext). A
  //    brand whose genuine colour happens to equal a reference colour must not
  //    trip the guard — the rule is "no reference value BLEEDS in", not "output
  //    may share no colour with any reference email".
  await assertNoReferenceLeak(built.ampHtml, { context: built.context });

  return {
    ...built,
    form: skeleton,
    formMeta: {
      requested_vertical: cv.vertical,
      resolved_vertical: skeleton.vertical,
      tier: skeleton.tier,
      strength: skeleton.strength,
      coverage_for_client: cv.coverage,
      aesthetic,
      aesthetic_source: brand.aesthetic ? 'brand' : 'form-derived',
    },
  };
}

module.exports = { generateWithForm, deriveAesthetic, resolveSpecVertical };
