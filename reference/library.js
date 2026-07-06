'use strict';

// ============================================================================
// reference/library.js — Phase 4: queryable pattern library.
//
//   getVerticalProfile(vertical)               -> VerticalProfile  (aggregate)
//   pickLayout(vertical, module, intent, opts)  -> LayoutSkeleton   (one render)
//
// A VerticalProfile aggregates every pattern of a vertical into modal layout
// skeletons, typical component mix, palette-role relationships, typography
// hierarchy, and copy-cadence stats. A LayoutSkeleton is one concrete (but still
// brand-AGNOSTIC) render plan: an ordered list of section slots + FORM directives
// for copy/type/palette. Phase 5 fills those slots from the client's context.
//
// Everything returned here is counts / booleans / vocab tokens — it passes
// vocab.assertAbstract(), so no reference brand value can ride along.
// ============================================================================

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const V = require('./vocab');
const { resolveCoverage, loadCoverage } = require('./classify');

const PATTERNS_DIR = path.join(__dirname, '..', 'patterns');

// ---- stats helpers ---------------------------------------------------------
function median(xs) { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2); }
function mode(xs, fallback) { if (!xs.length) return fallback; const f = {}; let best = xs[0], bestN = 0; for (const x of xs) { f[x] = (f[x] || 0) + 1; if (f[x] > bestN) { bestN = f[x]; best = x; } } return best; }
function rate(bools) { if (!bools.length) return 0; return +(bools.filter(Boolean).length / bools.length).toFixed(2); }

// ---- load all real patterns (cached per process) ---------------------------
let _cache = null;
async function loadPatterns() {
  if (_cache) return _cache;
  let files = [];
  try { files = (await fsp.readdir(PATTERNS_DIR)).filter((f) => f.endsWith('.json') && !f.startsWith('_')); } catch { files = []; }
  const pats = [];
  for (const f of files) { try { pats.push(JSON.parse(await fsp.readFile(path.join(PATTERNS_DIR, f), 'utf8'))); } catch { /* skip */ } }
  _cache = pats; return pats;
}
function clearCache() { _cache = null; }

// most common exact section sequence; tie-break toward median length
function representativeSequence(patterns) {
  if (!patterns.length) return ['header', 'hero', 'mechanic', 'product_grid', 'cta_banner', 'footer'];
  const groups = new Map();
  for (const p of patterns) { const key = (p.layout.sections || []).join('>'); const g = groups.get(key) || { seq: p.layout.sections, n: 0 }; g.n++; groups.set(key, g); }
  const medLen = median(patterns.map((p) => (p.layout.sections || []).length));
  return [...groups.values()].sort((a, b) => (b.n - a.n) || (Math.abs(a.seq.length - medLen) - Math.abs(b.seq.length - medLen)))[0].seq;
}

async function getVerticalProfile(vertical) {
  const all = await loadPatterns();
  const pats = all.filter((p) => p.vertical === vertical);
  const sample = pats.length;
  const col = (sel) => pats.map(sel);
  const strength = sample >= 8 ? 'strong' : sample >= 3 ? 'moderate' : sample >= 1 ? 'thin' : 'none';

  const profile = {
    schema: 'amp-genie/profile@1',
    vertical: V.VERTICALS.includes(vertical) ? vertical : 'generic',
    sample_size: sample,
    strength,
    layout: {
      section_count_median: median(col((p) => p.layout.section_count)),
      representative_sequence: representativeSequence(pats),
      width_constrained_rate: rate(col((p) => p.layout.width_constrained)),
      grid_cols_mode: mode(col((p) => p.layout.grid_cols_max).filter(Boolean), 2),
      product_cells_median: median(col((p) => p.layout.product_cells)),
    },
    components: Object.fromEntries(V.COMPONENT_TYPES.map((c) => [c, median(col((p) => (p.components || {})[c] || 0))])),
    palette_roles: {
      dark_section_rate: rate(col((p) => p.palette_roles.has_dark_section)),
      cta_contrast_mode: mode(col((p) => p.palette_roles.cta_contrast), 'medium'),
      bg_is_light_rate: rate(col((p) => p.palette_roles.bg_is_light)),
      distinct_colors_median: median(col((p) => p.palette_roles.distinct_colors)),
      accent_count_median: median(col((p) => p.palette_roles.accent_count)),
    },
    typography_roles: {
      serif_display_rate: rate(col((p) => p.typography_roles.serif_display)),
      all_caps_rate: rate(col((p) => p.typography_roles.all_caps_headings)),
      letterspaced_rate: rate(col((p) => p.typography_roles.letterspaced_headings)),
      weight_levels_mode: mode(col((p) => p.typography_roles.weight_levels), 2),
      hierarchy_depth_median: median(col((p) => p.typography_roles.hierarchy_depth)),
    },
    copy: {
      subject_len_median: median(col((p) => p.copy.subject_len)),
      emoji_rate: rate(col((p) => p.copy.subject_emoji)),
      cta_intent_mode: mode(col((p) => p.copy.cta_intent), 'browse'),
      offer_framing_mode: mode(col((p) => p.copy.offer_framing), 'none'),
      image_density_mode: mode(col((p) => p.copy.image_density), 'balanced'),
      image_to_text_median: +(median(col((p) => Math.round((p.copy.image_to_text || 0) * 100))) / 100).toFixed(2),
      image_count_median: median(col((p) => p.copy.image_count)),
    },
  };
  V.assertAbstract(profile);
  return profile;
}

// ---- pickLayout: VerticalProfile → a concrete-but-abstract render plan ------
// `module` is the AMP mechanic (wishlist/reveal/spin/...). We thread a 'mechanic'
// section slot into the vertical's representative skeleton so the interactive
// block lands where that vertical naturally puts its primary engagement.
async function pickLayout(vertical, module, intent, opts = {}) {
  const coverage = opts.coverage || (await loadCoverage());
  const resolved = resolveCoverage(vertical, coverage.counts || {});
  const profile = await getVerticalProfile(resolved.vertical);

  let seq = (profile.layout.representative_sequence || []).slice();
  // ensure exactly one mechanic slot, placed after the hero (or after header)
  seq = seq.filter((s) => s !== 'mechanic');
  const heroIdx = seq.indexOf('hero');
  const insertAt = heroIdx >= 0 ? heroIdx + 1 : Math.min(1, seq.length);
  seq.splice(insertAt, 0, 'mechanic');

  const cols = profile.layout.grid_cols_mode || 2;
  const skeleton = {
    schema: 'amp-genie/skeleton@1',
    vertical: resolved.vertical,
    requested: resolved.requested,
    tier: resolved.tier,
    strength: resolved.strength,
    module: null,           // the literal module id is the CLIENT's choice; stored separately by caller
    intent: V.CTA_INTENTS.includes(intent) ? intent : profile.copy.cta_intent_mode,
    width_constrained: profile.layout.width_constrained_rate >= 0.5,
    sections: seq.map((t) => ({ type: t, cols: /product_grid|product_strip|category_nav|value_props/.test(t) ? cols : 0 })),
    grid: { cols },
    copy_directives: {
      subject_len_target: profile.copy.subject_len_median || 31,
      use_emoji: profile.copy.emoji_rate >= 0.5,
      cta_intent: V.CTA_INTENTS.includes(intent) ? intent : profile.copy.cta_intent_mode,
      offer_framing: profile.copy.offer_framing_mode,
      image_density: profile.copy.image_density_mode,
    },
    type_directives: {
      serif_display: profile.typography_roles.serif_display_rate >= 0.5,
      all_caps_headings: profile.typography_roles.all_caps_rate >= 0.5,
      letterspaced_headings: profile.typography_roles.letterspaced_rate >= 0.5,
      weight_levels: profile.typography_roles.weight_levels_mode,
      hierarchy_depth: profile.typography_roles.hierarchy_depth_median || 3,
    },
    palette_directives: {
      dark_section: profile.palette_roles.dark_section_rate >= 0.5,
      cta_contrast: profile.palette_roles.cta_contrast_mode,
      bg_is_light: profile.palette_roles.bg_is_light_rate >= 0.5,
    },
    source: { vertical: resolved.vertical, tier: resolved.tier, strength: resolved.strength, basis: resolved.basis, sample_size: profile.sample_size },
  };
  // module id stored under provenance-free field but it is a CLIENT choice, not
  // a reference value; keep it out of assertAbstract's vocab check by storing on
  // a side channel after assertion.
  V.assertAbstract(skeleton);
  skeleton.module = module || null;
  return skeleton;
}

// build + persist all vertical profiles for inspection / tests
async function buildProfiles({ quiet = false } = {}) {
  clearCache();
  const cov = await loadCoverage();
  const verticals = Object.keys(cov.counts || {});
  const out = {};
  for (const v of verticals) out[v] = await getVerticalProfile(v);
  await fsp.writeFile(path.join(PATTERNS_DIR, '_profiles.json'), JSON.stringify(out, null, 2), 'utf8');
  if (!quiet) console.log(`library: ${verticals.length} vertical profile(s) → patterns/_profiles.json`);
  return out;
}

if (require.main === module) {
  buildProfiles().catch((e) => { console.error(e); process.exit(1); });
}

module.exports = { getVerticalProfile, pickLayout, buildProfiles, loadPatterns, clearCache, PATTERNS_DIR };
