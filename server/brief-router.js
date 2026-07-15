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
  // Lead-capture intent. Kept last so it loses ties to the more specific
  // modules above (Object.keys order + stable sort in routeBrief). Bare "lead"
  // is deliberately excluded — it's a substring of "leader"/"leading"/"already"
  // and would misfire; every term here is a deliberate capture/opt-in phrase.
  form: ['sign up', 'signup', 'sign-up', 'waitlist', 'wait list', 'register', 'registration', 'rsvp', 'subscribe', 'opt in', 'opt-in', 'notify me', 'get notified', 'notify list', 'early access', 'join the list', 'join our list', 'join our newsletter', 'mailing list', 'lead capture', 'lead-capture', 'capture leads', 'lead form', 'lead gen', 'be the first to know'],
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

// Real products the user pasted into the brief, so the generated email can show
// the brand's ACTUAL items instead of the vertical's synthetic placeholders.
// This is the deliberate "you paste the real details and the genie lays them
// out" path — the LLM copy layer is structurally barred from setting prices, so
// a real price can only reach the render deterministically, through here. Two
// shapes are accepted: (1) name + currency-marked amount ("Vitamin C Serum
// ₹899"), taken anywhere in the text; and (2) a deliberately-pasted LIST of
// real names with prices optional ("Bao Haus, Naru Noodle Bar, Toast & Tonic"),
// for announcements that have no prices. Prose is never mistaken for a product:
// a priced name needs a real name beside a real amount, and a name-only entry
// must survive a strict grammar veto plus a majority-of-the-list rule; pure
// discount phrases ("Flat ₹200 off") are skipped outright.
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

// The price-anchored scan: pull "name + currency-marked amount" pairs out of
// free text. This is the strict path — a name is only taken when it sits next
// to a real price, so prose can never be mistaken for a product.
function pricedProducts(text) {
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

// Words that betray grammatical PROSE (verbs, auxiliaries, pronouns, question
// words, common contraction stems). A phrase containing any of these is a
// sentence fragment, not a name — the veto that keeps a described campaign
// ("there are new restaurants that have been added...") from being read as a
// product list. Deliberately excludes words that legitimately appear in real
// brand/restaurant names (new, the, house, co, and, of, for, free, sale) so
// those still parse.
const PROSE_WORDS = new Set([
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'am', 'that', 'this',
  'these', 'those', 'give', 'gives', 'giving', 'present', 'presents', 'show',
  'shows', 'showing', 'showcase', 'make', 'makes', 'want', 'wants', 'need',
  'needs', 'here', 'there', 'please', 'have', 'has', 'had', 'will', 'would',
  'should', 'could', 'can', 'our', 'your', 'their', 'them', 'they', 'you',
  'we', 'best', 'interactive', 'email', 'emails', 'campaign', 'because',
  'about', 'which', 'what', 'how', 'when', 'where', 'added', 'adding',
  'introduce', 'introducing', 'same', 'following', 'get', 'gets', 'let',
  'lets', 'put', 'send', 'sending', 'tell', 'telling', 'help', 'using',
  'heres', 'theres', 'whats', 'dont', 'doesnt', 'cant', 'wont', 'isnt',
  'arent', 'wasnt', 'werent', 'im', 'ive', 'weve', 'youve', 'youre',
  'theyre', 'hes', 'shes', 'thats',
  // Common offer / legal trailer words — "T&C apply", "while stocks last",
  // "subject to" — that ride along at the end of a pasted list but are never a
  // product name themselves.
  'apply', 'applies', 'terms', 'conditions', 'while', 'stocks', 'hurry',
  'subject', 'valid',
]);

// A short phrase that reads like a real product / brand / restaurant NAME
// rather than a fragment of a sentence. Used only for the names-only list path
// (there is no price to anchor on), so it is deliberately strict: a comma or
// contraction, more than six words, or any PROSE_WORD vetoes the phrase, and at
// least one substantive word is required. This is what lets a pasted list
// through while a described campaign yields nothing.
function looksLikeName(name) {
  const raw = String(name).trim();
  if (!raw || raw.includes(',')) return false; // a comma means prose / sub-list
  const words = raw.split(/\s+/).filter(Boolean);
  if (!words.length || words.length > 6) return false;
  let substantive = 0;
  for (const w of words) {
    const lw = w.toLowerCase().replace(/[^a-z0-9&]/g, '');
    if (!lw) continue;
    if (PROSE_WORDS.has(lw)) return false; // a sentence word — not a name
    if (/[a-z]/.test(lw) && lw.length >= 3 && !NAME_STOP.has(lw)) substantive++;
  }
  return substantive >= 1;
}

// Cue words that mark a labelled list ("New restaurants: A, B, C") — the label
// before the colon must name a category of things for the inline path to fire.
const LIST_CUE = /\b(restaurants?|menu|items?|dishes|products?|brands?|stores?|outlets?|spots?|places?|featured|featuring|collection|catalogue|catalog|lineup|line-?up|arrivals|picks|launching|launches|available|options|choices|range|now on|new on)\b/i;

// Break a deliberately-pasted list into its entries. Three shapes, all things a
// person types on purpose (never free prose): one item per line (2+ lines, an
// optional "Header:" line dropped); a labelled inline list ("Featured: a, b,
// c"); or the whole brief being a single clean comma list ("a, b, c").
function splitListSegments(text) {
  const lines = text.split(/\n+/).map((s) => s.trim()).filter(Boolean);
  if (lines.length >= 2) {
    // Multi-line: each line is one entry; a leading "Header:" line is dropped.
    return lines.filter((ln, i) => !(i === 0 && /:\s*$/.test(ln)));
  }
  const line = lines[0] || '';
  const labelled = line.match(/^(.{0,40}?):\s*(.+)$/);
  if (labelled && LIST_CUE.test(labelled[1]) && labelled[2].includes(',')) {
    // Commas separate entries; a sentence-end peels off any trailing note
    // ("...Toast & Tonic. While stocks last") so it doesn't swallow a real name.
    return labelled[2].split(/[,]|[.!?]\s+/).map((s) => s.trim()).filter(Boolean);
  }
  // Bare single-line comma list — no mid-line sentence break. looksLikeName
  // does the real filtering; the majority rule below rejects prose commas.
  if (line.includes(',') && !/[.!?]\s/.test(line)) {
    return line.split(',').map((s) => s.trim()).filter(Boolean);
  }
  return [];
}

// The names-only path: pull real item NAMES (prices optional) out of a pasted
// list, so a restaurant / store / collection announcement with no prices still
// lays out the brand's ACTUAL items instead of the vertical's placeholders. A
// strong majority of the list's entries must read like names, so a prose brief
// that merely contains a comma or a line break can never masquerade as a list.
function nameListProducts(text) {
  const segs = splitListSegments(text).slice(0, 12);
  if (segs.length < 2) return {};
  const items = [];
  let currency;
  for (const seg of segs) {
    const m = seg.match(PRICE_RE);
    let price = null;
    if (m && !/^\s*(off|cashback|discount|back)\b/.test(seg.slice(m.index + m[0].length).toLowerCase())) {
      const n = parseInt(m[2].replace(/,/g, ''), 10);
      if (Number.isFinite(n) && n > 0) price = n;
    }
    const name = cleanItemName(seg);
    if (price != null && isRealItemName(name)) {
      if (!currency) currency = CUR_CODE[m[1].toLowerCase()] || 'INR';
      items.push({ name, price });
    } else if (looksLikeName(name)) {
      items.push(price != null ? { name, price } : { name });
      if (price != null && !currency) currency = CUR_CODE[m[1].toLowerCase()] || 'INR';
    }
  }
  // Majority rule: at least two entries, and 60%+ of the segments must survive.
  if (items.length >= 2 && items.length >= Math.ceil(segs.length * 0.6)) {
    const out = items.slice(0, 8);
    return currency ? { items: out, currency } : { items: out };
  }
  return {};
}

// Real products the user pasted, resolved deterministically. The price-anchored
// scan wins when it finds a proper priced list (its exact prior behaviour is
// preserved); otherwise a pasted list of real NAMES (prices optional) is taken,
// so name-only announcements still ground the email in real items.
function briefProducts(briefText) {
  // Normalise "Rs." → "Rs " up front so a rupee marker's own full stop is never
  // mistaken for a sentence break when we split below (PRICE_RE accepts either).
  const text = String(briefText || '').replace(/\brs\.\s*/ig, 'Rs ');
  if (!text.trim()) return {};
  const priced = pricedProducts(text);
  if (priced.items && priced.items.length >= 2) return priced;
  const named = nameListProducts(text);
  if (named.items && named.items.length >= 2) return named;
  return priced; // 0 or 1 priced item, exactly as before
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
