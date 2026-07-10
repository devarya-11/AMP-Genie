'use strict';

// Deterministic Tier-1 keyword router: maps a free-text campaign brief to one
// of the real module ids in generate.js's MODULES, so the brief can actually
// steer which module gets built instead of only supplying copy overrides.
// LLM-assisted routing (Tier 2) is a deliberate future follow-on, not this.

const { MODULE_IDS } = require('./generate');

// Keyword -> moduleId. Keys are lowercase substrings matched against the
// lowercased brief text.
const KEYWORD_MAP = {
  reveal: ['reveal', 'discount', 'coupon', 'promo code', 'unlock', 'surprise offer', 'hidden offer'],
  search: ['catalogue', 'catalog', 'carousel', 'browse', 'search', 'filter', 'collection', 'menu', 'restaurants', 'product range', 'new arrivals', 'explore our'],
  quiz: ['quiz', 'match', 'personality', 'which one', 'find your', 'find the right'],
  rating: ['rate', 'rating', 'review', 'feedback', 'nps', 'survey', 'stars'],
  spin: ['spin', 'wheel', 'lucky draw', 'jackpot', 'spin to win'],
  poll: ['poll', 'vote', 'this or that', 'pick one', 'choose between'],
};

// If a module is ever renamed/removed in generate.js, fail loudly here
// instead of silently routing briefs to a module id that no longer exists.
for (const moduleId of Object.keys(KEYWORD_MAP)) {
  if (!MODULE_IDS.includes(moduleId)) {
    throw new Error(`brief-router: "${moduleId}" is not a real module id (${MODULE_IDS.join(', ')})`);
  }
}

// Some keywords are substrings of others in the same module's list (e.g.
// "spin" inside "spin to win", "catalog" inside "catalogue") — without this,
// a single mention would double-count and skew scores between modules.
// Drop any matched keyword that's wholly contained in another, longer
// matched keyword for that same module.
function dedupeSubsumed(keywords) {
  return keywords.filter((kw, i) => !keywords.some((other, j) => i !== j && other.length > kw.length && other.includes(kw)));
}

function routeBrief(briefText, vertical) { // eslint-disable-line no-unused-vars
  const text = String(briefText || '').toLowerCase().trim();
  if (!text) return null;

  const matched = {};
  for (const [moduleId, keywords] of Object.entries(KEYWORD_MAP)) {
    for (const kw of keywords) {
      if (text.includes(kw)) {
        (matched[moduleId] = matched[moduleId] || []).push(kw);
      }
    }
  }
  for (const moduleId of Object.keys(matched)) {
    matched[moduleId] = dedupeSubsumed(matched[moduleId]);
  }

  const ranked = Object.keys(matched).sort((a, b) => matched[b].length - matched[a].length);
  if (!ranked.length) return null;

  const moduleId = ranked[0];
  const matchedTerms = matched[moduleId];
  // Fraction of matched terms out of 3, capped at 1 — one generic keyword
  // hit shouldn't claim full confidence.
  const confidence = Math.min(1, matchedTerms.length / 3);

  return { moduleId, confidence, matchedTerms };
}

// Structured signals pulled deterministically from the brief that the LLM copy
// layer is deliberately not allowed to set — chiefly the headline offer
// percentage, which the modules render as the big "X% OFF" number. Living here
// (next to routeBrief) keeps the Express route and the Pages Function deriving
// the same number from the same brief. Only a whole percentage written with a
// literal "%" is taken, so "top 20 products" can't be misread as 20% off;
// anything outside 1-99 is dropped and left to the module's own default.
function briefSignals(briefText) {
  const out = {};
  const m = String(briefText || '').match(/(\d{1,3})\s*%/);
  if (m) {
    const pct = Math.round(Number(m[1]));
    if (Number.isFinite(pct) && pct >= 1 && pct <= 99) out.discount = pct;
  }
  return out;
}

// Real product/price pairs the user pasted into the brief, so the generated
// email can show the brand's ACTUAL items (name + price) instead of the
// vertical's synthetic placeholders. This is the deliberate "you paste the
// real details and the genie lays them out" path — the LLM copy layer is
// structurally barred from setting prices, so a real price can only reach the
// render deterministically, through here. Only a name sitting next to an
// explicit currency-marked amount is taken (e.g. "Vitamin C Serum ₹899"), so
// prose like "40% off tonight" or "orders above ₹999" is never mistaken for a
// product; pure discount phrases ("Flat ₹200 off") are skipped outright.
const PRICE_RE = /(₹|rs\.?|inr|\$|usd|€|eur|£|gbp)\s?(\d[\d,]*)/i;
const PRICE_RE_G = /(₹|rs\.?|inr|\$|usd|€|eur|£|gbp)\s?\d[\d,]*/ig;
const CUR_CODE = {
  '₹': 'INR', rs: 'INR', 'rs.': 'INR', inr: 'INR',
  $: 'USD', usd: 'USD', '€': 'EUR', eur: 'EUR', '£': 'GBP', gbp: 'GBP',
};
// Words that don't make a product name on their own — a segment whose name is
// only these (or too short) is a discount/qualifier phrase, not an item.
const NAME_STOP = new Set([
  'flat', 'extra', 'upto', 'get', 'save', 'off', 'on', 'above', 'over',
  'minimum', 'min', 'order', 'orders', 'cashback', 'worth', 'only', 'just',
  'starting', 'from', 'and', 'the', 'a', 'an', 'use', 'code', 'coupon',
  'discount', 'was', 'now', 'mrp',
]);

function cleanItemName(s) {
  return String(s)
    .replace(PRICE_RE_G, ' ') // strip any stray price tokens
    .replace(/\((?:was|now|mrp)[^)]*\)/ig, ' ') // "(was ₹799)" price notes
    .replace(/[()]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^.{0,40}?:\s+/, '') // drop a leading "Intro label: " prefix
    .replace(/\s+(?:and|&)\s+(?:so\s+)?(?:much\s+)?more\b.*$/i, '') // trailing "and more"
    .replace(/\s+(?:each|only|onwards|per\s+\w+)\s*$/i, '') // trailing qualifiers
    .replace(/^\s*\d+[.)]\s*/, '') // leading "1." / "2)" numbering
    .replace(/^[\s\-–—:•*.]+/, '') // leading bullets / list markers
    .replace(/[\s\-–—:]+$/, '') // trailing separators (e.g. "Name -")
    .replace(/\s+/g, ' ')
    .trim();
}

function isRealItemName(name) {
  const meaningful = name.split(/\s+/)
    .filter((w) => /[a-z]/i.test(w) && !NAME_STOP.has(w.toLowerCase()));
  if (!meaningful.length) return false;
  // At least two meaningful words, or one of length >= 3 (covers single-word
  // items like "Biryani" / "Kajal" while rejecting stray initials).
  return meaningful.length >= 2 || meaningful[0].length >= 3;
}

function briefProducts(briefText) {
  // Normalise "Rs." → "Rs " up front so a rupee marker's own full stop is never
  // mistaken for a sentence break when we split below (PRICE_RE accepts either).
  const text = String(briefText || '').replace(/\brs\.\s*/ig, 'Rs ');
  if (!text.trim()) return {};
  const items = [];
  let currency;
  // Newline / comma / semicolon / sentence-end each separate a list entry, so
  // an intro sentence ("Summer sale. Serum ₹899") doesn't bleed into the first
  // product's name. "and" is deliberately NOT a separator — it would butcher
  // names like "Mac and Cheese".
  for (const seg of text.split(/[\n,;]+|[.!?]+\s+/)) {
    const m = seg.match(PRICE_RE);
    if (!m) continue;
    // "₹200 off" / "$5 cashback" — a discount phrase, not a product price.
    if (/^\s*(off|cashback|discount|back)\b/.test(seg.slice(m.index + m[0].length).toLowerCase())) continue;
    const price = parseInt(m[2].replace(/,/g, ''), 10);
    if (!Number.isFinite(price) || price <= 0) continue;
    const name = cleanItemName(seg.slice(0, m.index) + ' ' + seg.slice(m.index + m[0].length));
    if (!isRealItemName(name)) continue;
    if (!currency) currency = CUR_CODE[m[1].toLowerCase()] || 'INR';
    items.push({ name, price });
    if (items.length >= 8) break;
  }
  return items.length ? { items, currency: currency || 'INR' } : {};
}

// Industry (vertical) and tone are no longer asked for in the UI — they are
// inferred here from the brand name + brief so the backend "understands the
// brand" on its own. Both scan brand+brief together (lowercased) and pick the
// value with the most keyword hits, mirroring routeBrief; no hit falls back to
// the same neutral default the generator already used for a blank selector
// ('Generic' vertical, 'Playful' tone), so behaviour is unchanged when there's
// nothing to go on. Hints include a handful of well-known brand names so a
// bare brand with no brief (e.g. "Nykaa") still lands in the right vertical.
const VERTICAL_HINTS = {
  Beauty: ['beauty', 'cosmetic', 'makeup', 'make-up', 'skincare', 'skin care', 'serum', 'lipstick', 'salon', 'fragrance', 'perfume', 'grooming', 'haircare', 'nykaa', 'sephora', 'lakme', 'maybelline', "sugar cosmetics", 'mamaearth'],
  Fashion: ['fashion', 'apparel', 'clothing', 'clothes', 'outfit', 'footwear', 'shoes', 'denim', 'dress', 'wardrobe', 'styling', 'ethnic wear', 'myntra', 'ajio', 'zara', 'uniqlo', 'h&m', 'fabindia'],
  Food: ['food', 'restaurant', 'meal', 'dish', 'menu', 'dining', 'kitchen', 'biryani', 'pizza', 'burger', 'grocery', 'snack', 'beverage', 'zomato', 'swiggy', 'dominos', 'mcdonald', 'starbucks', 'kfc', 'blinkit', 'zepto'],
  Finance: ['finance', 'bank', 'invest', 'loan', 'mutual fund', 'insurance', 'wallet', 'credit card', 'trading', 'stocks', 'auto-sip', 'groww', 'zerodha', 'paytm', 'phonepe', 'cred', 'upstox'],
  Electronics: ['electronic', 'gadget', 'smartphone', 'laptop', 'appliance', 'headphone', 'earbuds', 'smartwatch', 'console', 'croma', 'boat', 'oneplus', 'samsung galaxy', 'reliance digital'],
  Travel: ['travel', 'flight', 'hotel', 'trip', 'holiday', 'vacation', 'getaway', 'resort', 'itinerary', 'staycation', 'makemytrip', 'goibibo', 'airbnb', 'ixigo', 'cleartrip', 'oyo'],
};

const TONE_HINTS = {
  Urgent: ['hurry', 'tonight', 'last chance', 'sale ends', 'ends soon', 'ending soon', 'expire', 'expiring', 'today only', 'flash sale', 'limited time', "don't miss", 'final hours', 'hours left', 'act now', 'while stocks last', 'closing soon', 'deadline', 'countdown'],
  Premium: ['exclusive', 'premium', 'luxury', 'curated', 'members only', 'vip', 'handpicked', 'bespoke', 'signature', 'limited edition', 'elite', 'invitation'],
  Informative: ['update', 'announcement', 'announcing', 'new feature', 'notice', 'reminder', 'statement', 'confirm', 'how to', 'walkthrough', 'introducing'],
};

function scorePick(haystack, hintMap, fallback) {
  let best = fallback;
  let bestScore = 0;
  for (const [key, hints] of Object.entries(hintMap)) {
    const score = hints.reduce((n, h) => n + (haystack.includes(h) ? 1 : 0), 0);
    if (score > bestScore) { bestScore = score; best = key; }
  }
  return best;
}

function inferVertical(brand, briefText) {
  return scorePick(`${brand || ''} ${briefText || ''}`.toLowerCase(), VERTICAL_HINTS, 'Generic');
}

function inferTone(briefText) {
  return scorePick(String(briefText || '').toLowerCase(), TONE_HINTS, 'Playful');
}

module.exports = {
  routeBrief, briefSignals, briefProducts, inferVertical, inferTone, KEYWORD_MAP,
};
