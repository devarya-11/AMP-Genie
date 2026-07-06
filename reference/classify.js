'use strict';

// ============================================================================
// reference/classify.js — Phase 3: vertical classification + client → vertical
// coverage map + graceful fallback.
//
//   classifyEmail({subject, body, brand, pattern}) -> vertical token
//   clientToVertical(clientName)                    -> { vertical, coverage }
//   resolveCoverage(requested, availableCounts)     -> { vertical, tier, ... }
//
// Fallback policy (spec): in-vertical → nearest-neighbour → generic conservative.
// Never blocks generation; always returns a usable vertical and logs which tier
// was used.
//
// The driver classifyCorpus() reads corpus/index.jsonl + bodies, assigns a
// `vertical` onto each patterns/{uuid}.json, and writes patterns/_coverage.json
// (how many real patterns back each vertical — drives degradation downstream).
// ============================================================================

const fsp = require('fs/promises');
const fs = require('fs');
const path = require('path');
const V = require('./vocab');
const { readIndex } = require('./ingest');

const PATTERNS_DIR = path.join(__dirname, '..', 'patterns');
const COVERAGE_PATH = path.join(PATTERNS_DIR, '_coverage.json');

// ---- keyword signals per vertical (scored; highest wins) -------------------
// Phrases (multi-word) are weighted 2, single keywords 1. Tuned to be specific
// enough that shared words ("collection", "new") don't dominate.
const SIGNALS = {
  fashion_apparel: [/\bapparel|clothing|wardrobe|outfit|\bdress\b|\bshirt|trouser|denim|linen|knit|sweater|\bjeans?\b|blazer|\btrench\b|cashmere|\bcoat\b|tailored|\bwear\b/i],
  footwear: [/\bshoes?\b|sneakers?|\bboots?\b|footwear|trainers?|loafers?|\bheels?\b|sandals?/i],
  beauty_cosmetics: [/skincare|\bserum\b|moisturis|cleanser|\bspf\b|sunscreen|makeup|lipstick|mascara|foundation|cosmetic|\bglow\b|glow-?up|derm|vegan|cruelty-?free|rosewater|fragrance|\bbeauty\b/i],
  jewelry: [/jewel|\bring\b|necklace|earring|bracelet|diamond|\bgold\b|pendant|\bcarat\b|\bgems?\b/i],
  supplements_wellness: [/supplement|\bvitamins?\b|wellness|protein|gummies|probiotic|collagen|nutrition|\bgut\b health|\bomega\b/i],
  home_goods: [/\bhome\b|furniture|\bdecor\b|kitchen|bedding|\blinen sheets|\bcandle|homeware|\bsofa\b|cookware|tableware/i],
  eyewear: [/eyewear|sunglasses|\bglasses\b|\blenses?\b|\bframes?\b|optical|blue\s*light/i],
  food_bev: [/\bfood\b|\bmeal\b|\border\b|delivery|\bmenu\b|restaurant|coffee|snack|\bdish\b|cravings?|recipe|margherita|burger|\bbucket\b|kitchen table|cold brew|tonight'?s/i],
  fintech: [/\binvest|portfolio|\bsip\b|mutual\s*fund|\bfunds?\b|account|\bfees?\b|wallet|savings?|banking|\bcrypto|stocks?|equity|returns?\b|auto-?invest|\bmoney\b/i],
  insurance_financial: [/insurance|\bpolicy\b|premium|\bcover(age)?\b|\bclaim\b|protect|life\s*cover|term\s*plan|\bulip\b|annuity|pension|retirement/i],
  travel_hospitality: [/\btravel\b|\btrips?\b|\bstays?\b|hotel|flights?|\bescape|destination|booking|getaway|\bnight\b|resort|vacation|holiday|beaches?|mountains?/i],
  luxury: [/\binvitation\b|\batelier\b|\bmaison\b|couture|exclusive\s*preview|reserved\s*for\s*you|heritage|craftsmanship|\bcurated\b|\bprivate\b\s*(sale|preview)|first\s*look/i],
};

// multi-word luxury cue phrases get extra weight
const LUX_PHRASES = [/exclusive\s*preview/i, /reserved\s*for\s*you/i, /\binvitation\b/i, /first\s*look/i, /private\s*(sale|preview)/i];

function score(text, regexes) {
  let s = 0;
  for (const re of regexes) {
    const m = String(text).match(new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g'));
    if (m) s += m.length;
  }
  return s;
}

function classifyEmail({ subject = '', body = '', brand = '', pattern = null } = {}) {
  const hay = `${brand} ${subject} ${body}`;
  const scores = {};
  for (const [vert, regexes] of Object.entries(SIGNALS)) scores[vert] = score(hay, regexes);
  // luxury phrase boost
  for (const re of LUX_PHRASES) if (re.test(hay)) scores.luxury += 2;
  // structural luxury hint: serif display + editorial offer + no emoji subject
  if (pattern) {
    const t = pattern.typography_roles || {}; const c = pattern.copy || {};
    if (t.serif_display && c.offer_framing === 'editorial' && !c.subject_emoji) scores.luxury += 2;
    // structural fintech hint: very sparse imagery + text-led + no offer
    if (c.image_density === 'sparse' && (c.offer_framing === 'none' || c.offer_framing === 'percentage_off') && (pattern.components || {}).image <= 2) scores.fintech += 1;
  }
  let best = 'generic', bestScore = 0;
  for (const [vert, s] of Object.entries(scores)) { if (s > bestScore) { best = vert; bestScore = s; } }
  return bestScore > 0 ? best : 'generic';
}

// ---- client → vertical coverage map (from the spec's roster table) ---------
const CLIENT_VERTICAL = {
  ajio: { vertical: 'fashion_apparel', coverage: 'strong' },
  nykaa: { vertical: 'beauty_cosmetics', coverage: 'strong' },
  burberry: { vertical: 'luxury', coverage: 'moderate' },
  taj: { vertical: 'travel_hospitality', coverage: 'thin' },
  'taj hotels': { vertical: 'travel_hospitality', coverage: 'thin' },
  zomato: { vertical: 'food_bev', coverage: 'thin' },
  redbus: { vertical: 'travel_hospitality', coverage: 'thin' },
  groww: { vertical: 'fintech', coverage: 'none' },
  phonepe: { vertical: 'fintech', coverage: 'none' },
  'icici pru': { vertical: 'insurance_financial', coverage: 'none' },
  'icici prudential': { vertical: 'insurance_financial', coverage: 'none' },
  'axis max life': { vertical: 'insurance_financial', coverage: 'none' },
  'hdfc': { vertical: 'insurance_financial', coverage: 'none' },
  'hdfc life': { vertical: 'insurance_financial', coverage: 'none' },
  'bajaj finserv': { vertical: 'insurance_financial', coverage: 'none' },
  // a few Trove reference brands, for completeness of the demo
  allbirds: { vertical: 'footwear', coverage: 'moderate' },
  glossier: { vertical: 'beauty_cosmetics', coverage: 'strong' },
};

// map a coarse internal vertical (server/content.js) → a spec vertical default
const COARSE_TO_SPEC = {
  Fashion: 'fashion_apparel', Beauty: 'beauty_cosmetics', Food: 'food_bev',
  Finance: 'fintech', Travel: 'travel_hospitality', Electronics: 'generic', Generic: 'generic',
};

function clientToVertical(clientName, coarseVertical) {
  const key = String(clientName || '').trim().toLowerCase();
  if (CLIENT_VERTICAL[key]) return { ...CLIENT_VERTICAL[key], client: key };
  // partial match (e.g. "ICICI Prudential Life")
  for (const k of Object.keys(CLIENT_VERTICAL)) { if (key && (key.includes(k) || k.includes(key))) return { ...CLIENT_VERTICAL[k], client: key }; }
  const spec = COARSE_TO_SPEC[coarseVertical] || 'generic';
  return { vertical: spec, coverage: 'unknown', client: key };
}

// ---- nearest-neighbour graph for fallback ----------------------------------
const NEIGHBORS = {
  fashion_apparel: ['luxury', 'footwear', 'beauty_cosmetics'],
  footwear: ['fashion_apparel', 'luxury'],
  eyewear: ['fashion_apparel', 'beauty_cosmetics'],
  jewelry: ['luxury', 'fashion_apparel'],
  luxury: ['fashion_apparel', 'beauty_cosmetics'],
  beauty_cosmetics: ['supplements_wellness', 'fashion_apparel', 'luxury'],
  supplements_wellness: ['beauty_cosmetics', 'food_bev'],
  home_goods: ['fashion_apparel', 'generic'],
  food_bev: ['travel_hospitality', 'generic'],
  fintech: ['insurance_financial', 'generic'],
  insurance_financial: ['fintech', 'generic'],
  travel_hospitality: ['luxury', 'food_bev'],
  generic: [],
};

function strengthFromCount(n) { return n >= 8 ? 'strong' : n >= 3 ? 'moderate' : n >= 1 ? 'thin' : 'none'; }

// resolveCoverage: given a requested vertical and how many real patterns back
// each vertical, decide what to actually render against. Never blocks.
function resolveCoverage(requested, availableCounts = {}) {
  const want = V.VERTICALS.includes(requested) ? requested : 'generic';
  const have = (v) => (availableCounts[v] || 0) > 0;
  if (have(want)) {
    return { vertical: want, tier: 'in_vertical', strength: strengthFromCount(availableCounts[want]), requested: want, basis: `${availableCounts[want]} in-vertical pattern(s)` };
  }
  for (const nb of (NEIGHBORS[want] || [])) {
    if (have(nb)) return { vertical: nb, tier: 'nearest', strength: strengthFromCount(availableCounts[nb]), requested: want, basis: `nearest-neighbour of ${want}` };
  }
  return { vertical: 'generic', tier: 'generic', strength: 'none', requested: want, basis: 'no in-vertical or neighbour coverage — conservative generic' };
}

// ---- driver: classify the whole corpus -------------------------------------
function stripTags(html) { return String(html).replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(); }

async function classifyCorpus({ quiet = false } = {}) {
  const log = (...a) => { if (!quiet) console.log(...a); };
  const index = await readIndex();
  const counts = {};
  for (const row of index) {
    const patPath = path.join(PATTERNS_DIR, `${row.uuid}.json`);
    if (!fs.existsSync(patPath)) continue;
    const pattern = JSON.parse(await fsp.readFile(patPath, 'utf8'));
    let body = '';
    try { body = stripTags(await fsp.readFile(path.join(__dirname, '..', row.body_path), 'utf8')).slice(0, 4000); } catch { /* ok */ }
    const vertical = classifyEmail({ subject: row.subject || '', body, brand: row.brand || '', pattern });
    pattern.vertical = vertical;
    V.assertAbstract(pattern); // still abstract after assigning a vocab vertical
    await fsp.writeFile(patPath, JSON.stringify(pattern, null, 2), 'utf8');
    counts[vertical] = (counts[vertical] || 0) + 1;
    log(`  ${row.uuid.slice(0, 8)} → ${vertical}`);
  }
  const coverage = {
    generated_at: new Date().toISOString(),
    total: index.length,
    counts,
    strength: Object.fromEntries(Object.entries(counts).map(([v, n]) => [v, strengthFromCount(n)])),
  };
  await fsp.writeFile(COVERAGE_PATH, JSON.stringify(coverage, null, 2), 'utf8');
  log(`classify: ${index.length} email(s); coverage → ${path.relative(path.join(__dirname, '..'), COVERAGE_PATH)}`);
  log('  counts:', JSON.stringify(counts));
  return coverage;
}

async function loadCoverage() {
  try { return JSON.parse(await fsp.readFile(COVERAGE_PATH, 'utf8')); } catch { return { counts: {}, strength: {} }; }
}

if (require.main === module) {
  classifyCorpus().catch((e) => { console.error(e); process.exit(1); });
}

module.exports = {
  classifyEmail, clientToVertical, resolveCoverage, classifyCorpus, loadCoverage,
  CLIENT_VERTICAL, COARSE_TO_SPEC, NEIGHBORS, strengthFromCount, COVERAGE_PATH, PATTERNS_DIR,
};
