'use strict';

// ============================================================================
// reference/vocab.js — the controlled vocabularies that make the
// "reference = FORM, client = IDENTITY" boundary a HARD data-model rule, not a
// convention.
//
// Governing principle (from the spec):
//   "No colour, image URL, font, or copy string from a reference email may ever
//    appear in generated output."
//
// How we enforce it: a distilled pattern may ONLY contain
//   (a) numbers (counts, ratios, medians),
//   (b) booleans (presence flags, role flags),
//   (c) tokens drawn from the fixed vocabularies BELOW, or
//   (d) provenance bookkeeping (uuid / ISO date / on-disk path / the literal
//       source name "trove") under a whitelisted `provenance` key.
// Anything else — a hex colour, an http(s) URL, a font-family name, a literal
// subject line, a CTA phrase — is a LEAK and `assertAbstract()` throws.
//
// This module is pure data + tiny pure helpers. No I/O, no brand knowledge.
// ============================================================================

// ---- spec verticals (fine-grained) -----------------------------------------
const VERTICALS = [
  'fashion_apparel', 'beauty_cosmetics', 'jewelry', 'supplements_wellness',
  'home_goods', 'eyewear', 'footwear', 'food_bev', 'fintech',
  'insurance_financial', 'travel_hospitality', 'luxury', 'generic',
];

// Coverage tiers — how much real corpus backs a vertical (drives graceful
// degradation in Phase 3). "none" never blocks generation; it logs + falls back.
const COVERAGE_TIERS = ['strong', 'moderate', 'thin', 'none', 'unknown', 'in_vertical', 'nearest', 'generic'];

// ---- layout skeleton: section TYPES (order + count are FORM) ----------------
// A distilled email's body is reduced to a sequence of these abstract section
// types. No section ever carries copy, colour or imagery — only its type.
const SECTION_TYPES = [
  'header',        // logo / nav strip
  'hero',          // dominant image + headline
  'subhero',       // secondary banner
  'value_props',   // benefit / trust icon row
  'category_nav',  // shop-by-category tiles
  'product_grid',  // 2+ column product matrix
  'product_strip', // single-row product list
  'editorial',     // text-led story block
  'mechanic',      // interactive zone (the AMP module slots here)
  'social_proof',  // reviews / ratings / UGC
  'countdown',     // urgency timer band
  'cta_banner',    // full-width call-to-action band
  'divider',       // rule / spacer separator
  'footer',        // legal / social / unsubscribe
];

// ---- component inventory: TYPES we count (frequency is FORM) ----------------
const COMPONENT_TYPES = [
  'image', 'button', 'heading', 'paragraph', 'table',
  'link', 'divider', 'list', 'anim', 'video',
];

// ---- copy CADENCE vocab (never the literal copy) ---------------------------
// CTA verbs are distilled to an INTENT category. The generator later renders a
// brand-appropriate phrase for that intent from the CLIENT's own voice — so the
// reference email's literal verb ("Shop", "Grab", "Slay") never persists.
const CTA_INTENTS = ['browse', 'purchase', 'redeem', 'learn', 'book', 'signup', 'engage'];

// Offer framing is distilled to a TEMPLATE TYPE, never the literal offer text.
const OFFER_FRAMINGS = [
  'percentage_off', 'amount_off', 'bogo', 'free_shipping', 'free_gift',
  'new_arrival', 'limited_time', 'loyalty_reward', 'price_point', 'editorial', 'none',
];

// ---- role buckets (relationships, never values) ----------------------------
const CONTRAST_ROLES = ['low', 'medium', 'high'];
const DENSITY_ROLES = ['sparse', 'balanced', 'dense'];

// ---- CTA verb lexicon → intent (used only DURING extraction, discarded) ----
// This maps observed verbs to an intent token. The verb strings live here in
// OUR code (a fixed lexicon), never in a stored pattern.
const CTA_VERB_LEXICON = {
  browse: ['shop', 'explore', 'view', 'discover', 'see', 'browse', 'find', 'meet'],
  purchase: ['buy', 'order', 'cart', 'checkout', 'add'],
  redeem: ['claim', 'unlock', 'reveal', 'redeem', 'apply', 'grab', 'get', 'use code', 'avail'],
  learn: ['learn', 'read', 'know', 'discover more', 'about'],
  book: ['book', 'reserve', 'schedule', 'plan'],
  signup: ['join', 'sign up', 'signup', 'register', 'subscribe', 'enroll'],
  engage: ['play', 'spin', 'vote', 'rate', 'answer', 'take', 'start'],
};

// ---- offer framing detectors (used only DURING extraction, discarded) ------
const OFFER_DETECTORS = [
  ['percentage_off', /\b\d{1,3}\s*%\s*(off|discount)?\b/i],
  ['amount_off', /(flat|save|upto|up to)\s*[₹$€£]\s?\d/i],
  ['bogo', /\b(bogo|buy\s*\d+\s*get|b1g1)\b/i],
  ['free_shipping', /\bfree\s*(shipping|delivery)\b/i],
  ['free_gift', /\bfree\s*(gift|sample|trial)\b/i],
  ['new_arrival', /\b(new\s*(arrival|drop|in|collection)|just\s*landed|launch)\b/i],
  ['limited_time', /\b(today only|ends|last|hurry|limited|\d+\s*hours? left|expires)\b/i],
  ['loyalty_reward', /\b(member|loyalty|points|reward|vip|exclusive for you)\b/i],
  ['price_point', /\b(starting at|from|under)\s*[₹$€£]?\s?\d/i],
];

// ---- bridge: spec vertical → internal coarse vertical + aesthetic register --
// The existing engine (server/content.js, server/build.js AESTHETICS) speaks a
// coarse vertical + an aesthetic register. Both are FORM. This bridge lets a
// distilled spec vertical drive the existing engine without a rewrite.
//   NOTE: a client's OWN resolved brand.aesthetic always wins as identity; the
//   vertical aesthetic here is only a FORM DEFAULT when the brand sets none.
const VERTICAL_BRIDGE = {
  fashion_apparel:      { vertical: 'Fashion',     aesthetic: 'playful' },
  footwear:             { vertical: 'Fashion',     aesthetic: 'bold' },
  eyewear:              { vertical: 'Fashion',     aesthetic: 'minimal' },
  jewelry:              { vertical: 'Fashion',     aesthetic: 'luxury' },
  luxury:               { vertical: 'Fashion',     aesthetic: 'luxury' },
  beauty_cosmetics:     { vertical: 'Beauty',      aesthetic: 'playful' },
  supplements_wellness: { vertical: 'Beauty',      aesthetic: 'minimal' },
  home_goods:           { vertical: 'Generic',     aesthetic: 'minimal' },
  food_bev:             { vertical: 'Food',        aesthetic: 'playful' },
  fintech:              { vertical: 'Finance',     aesthetic: 'fintech' },
  insurance_financial:  { vertical: 'Finance',     aesthetic: 'fintech' },
  travel_hospitality:   { vertical: 'Travel',      aesthetic: 'playful' },
  generic:              { vertical: 'Generic',     aesthetic: 'playful' },
};
function bridgeVertical(specVertical) {
  return VERTICAL_BRIDGE[specVertical] || VERTICAL_BRIDGE.generic;
}

// ---- the whitelist used by assertAbstract ----------------------------------
// Every string that may legally appear in a distilled pattern (outside the
// `provenance` block) must be a member of this set.
const ALLOWED_TOKENS = new Set([
  ...VERTICALS, ...COVERAGE_TIERS, ...SECTION_TYPES, ...COMPONENT_TYPES,
  ...CTA_INTENTS, ...OFFER_FRAMINGS, ...CONTRAST_ROLES, ...DENSITY_ROLES,
  // role-flag enumerations that read as words:
  'serif', 'sans', 'mixed', 'unknown',
  // schema id token
  'amp-genie/pattern@1', 'amp-genie/profile@1', 'amp-genie/skeleton@1',
]);

// keys under which provenance bookkeeping strings (uuid/date/path/"trove") are
// permitted. These never reach generated output — they only link a pattern back
// to its (non-redistributed) source for auditing.
const PROVENANCE_KEYS = new Set(['provenance', 'uuid', 'source', 'fetched_at', 'body_path', 'date', 'schema', 'basis']);

// ---- leak detectors (defence in depth on top of the whitelist) -------------
const LEAK_PATTERNS = [
  ['hex_colour', /#[0-9a-f]{3,8}\b/i],
  ['rgb_hsl', /\b(rgb|hsl)a?\s*\(/i],
  ['url', /\bhttps?:\/\/|\bwww\.|\bdata:/i],
  ['css_dimension', /\b\d+(px|rem|em|vh|vw)\b/i],
];

// Walk an arbitrary distilled object and throw if any value could be a concrete
// brand value. Whitelist-first (strongest), then leak-pattern scan as backup.
// `path` is threaded for a precise error message.
function assertAbstract(obj, path = '$', inProvenance = false) {
  if (obj == null) return true;
  const t = typeof obj;
  if (t === 'number' || t === 'boolean') return true;
  if (t === 'string') {
    if (inProvenance) return true; // uuid / iso date / path / "trove" allowed here
    if (ALLOWED_TOKENS.has(obj)) return true;
    // a bare integer-as-string is tolerated (defensive); everything else fails
    if (/^-?\d+(\.\d+)?$/.test(obj)) return true;
    for (const [name, re] of LEAK_PATTERNS) {
      if (re.test(obj)) {
        throw new LeakError(`reference leak (${name}) at ${path}: ${JSON.stringify(obj)}`);
      }
    }
    throw new LeakError(`non-vocab string at ${path}: ${JSON.stringify(obj)} — not a count, boolean, or controlled token`);
  }
  if (Array.isArray(obj)) {
    obj.forEach((v, i) => assertAbstract(v, `${path}[${i}]`, inProvenance));
    return true;
  }
  if (t === 'object') {
    for (const k of Object.keys(obj)) {
      const childProv = inProvenance || PROVENANCE_KEYS.has(k);
      assertAbstract(obj[k], `${path}.${k}`, childProv);
    }
    return true;
  }
  throw new LeakError(`unexpected value type ${t} at ${path}`);
}

class LeakError extends Error {
  constructor(msg) { super(msg); this.name = 'LeakError'; }
}

module.exports = {
  VERTICALS, COVERAGE_TIERS, SECTION_TYPES, COMPONENT_TYPES,
  CTA_INTENTS, OFFER_FRAMINGS, CONTRAST_ROLES, DENSITY_ROLES,
  CTA_VERB_LEXICON, OFFER_DETECTORS, VERTICAL_BRIDGE, bridgeVertical,
  ALLOWED_TOKENS, PROVENANCE_KEYS, LEAK_PATTERNS,
  assertAbstract, LeakError,
};
