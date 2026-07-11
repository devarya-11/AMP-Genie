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
  calc: ['calculator', 'calculate', 'emi', 'sip', 'estimate', 'savings', 'how much', 'maturity', 'premium quote', 'work out the'],
  report: ['report', 'statement', 'results', 'summary', 'lab', 'portfolio', 'order status', 'health check', 'check-in'],
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
  routeBrief, briefSignals, inferVertical, inferTone, KEYWORD_MAP,
};
