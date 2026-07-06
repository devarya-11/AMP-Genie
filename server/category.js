'use strict';

// ============================================================================
// category.js — turn a product NAME into a canonical CATEGORY, then into a
// category-CORRECT, license-safe image. This is the fix for the "Coca-Cola
// bottle under Wood-Fired Margherita / storefront under Korean Fried Chicken"
// bug: a product slot must never show a photo that contradicts its label.
//
// The old pipeline keyworded loremflickr on the last two words of the name and,
// worse, fell back to picsum — a FULLY RANDOM photo with zero relation to the
// product. Both are removed. Instead:
//
//   categorize(name, vertical) → { category, confidence, query }
//       keyword rules (specific → general) derive the real category; if nothing
//       matches we fall to the vertical's default category (medium confidence),
//       and only an unknown vertical with no match yields low confidence.
//
//   curatedImage(category, w, h, seed) → a hand-picked, proven Unsplash photo
//       for the category (deterministic, exact-dimension, https).
//
//   openverseImage(query, …) → a real CC-licensed photo from Openverse search
//       (genuine category match + license/creator metadata for provenance).
//
// The CALLER (assets.js) only uses a category image when confidence is not
// 'low' — the contradiction guard. No confident category ⇒ a labelled generated
// placeholder, which is always better than a wrong picture.
// ============================================================================

// ---- canonical category → curated, proven Unsplash photo IDs ---------------
// Arrays so distinct slots in the same category get distinct images (seeded).
// Exact dimensions + https come from the Unsplash query string. Any ID that is
// unreachable at resolve time degrades to a labelled placeholder (never wrong).
const CAT_IMG = {
  // FOOD
  'pizza': ['1513104890138-7c749659a591', '1574071318508-1cdbab80d002'],
  'fried-chicken': ['1626645738196-c2a7c87a8f58', '1562967914-608f82629710'],
  'burger': ['1568901346375-23c9450c58cd', '1571091718767-18b5b1457add'],
  'curry': ['1585937421612-70a008356fbe', '1631452180519-c014fe946bc7'],
  'pasta-risotto': ['1551183053-bf91a1d81141', '1473093295043-cdd812d0e601'],
  'dessert': ['1551024601-bec78aea704b', '1488477181946-6428a0291777'],
  'beverage': ['1461023058943-07fcbe16d735', '1514432324607-a09d9b4aefdd'],
  'sides': ['1513456852971-30c0b8199d4d', '1541592106381-b31e9677c0e5'],
  'salad-bowl': ['1512621776951-a57141f2eefd'],
  'sushi': ['1579871494447-9811cf80d66c'],
  'food-generic': ['1504674900247-0877df9cc836', '1546069901-ba9599a7e63c'],
  // FASHION
  'dress': ['1490481651871-ab68de25d43d', '1595777457583-95e059d581b8'],
  'trousers': ['1539109136881-3be0616acf4b', '1473966968600-fa801b869a1a'],
  'shirt-top': ['1521572163474-6864f9cf17ab', '1576566588028-4147f3842f27'],
  'jacket-coat': ['1551028719-00167b16eac5', '1544022613-e87ca75a784a'],
  'shoes': ['1542291026-7eec264c27ff', '1460353581641-37baddab0fa2'],
  'bag': ['1584917865442-de89df76afd3', '1548036328-c9fa89d128fa'],
  'accessory': ['1511499767150-a48a237f0083', '1523275335684-37898b6baf30'],
  'apparel-generic': ['1441984904996-e0b6ba687e04', '1483985988355-763728e1935b'],
  // FINANCE (abstract, on-theme imagery)
  'fund-invest': ['1611974789855-9c2a0a7236a3', '1590283603385-17ffb3a7f29f'],
  'gold': ['1610375461246-83df859d849d'],
  'savings': ['1554224155-6726b3ff858f', '1579621970795-87facc2f976d'],
  'insurance': ['1450101499163-c8848c66ca85'],
  'pension': ['1556742502-ec7c0e9f34b1'],
  'finance-generic': ['1579621970795-87facc2f976d', '1454165804606-c3d57bc86b40'],
  // BEAUTY
  'lipstick-makeup': ['1586495777744-4413f21062fa', '1512496015851-a90fb38ba796'],
  'skincare': ['1556228720-195a672e8a03', '1570172619644-dfd03ed5d881'],
  'fragrance': ['1541643600914-78b084683601'],
  'beauty-generic': ['1596462502278-27bfdc403348'],
  // ELECTRONICS
  'headphones': ['1505740420928-5e560c06d30e', '1583394838336-acd977736f90'],
  'smartwatch': ['1523275335684-37898b6baf30'],
  'phone': ['1511707171634-5f897ff02aa9'],
  'laptop': ['1496181133206-80ce9b88a853'],
  'camera': ['1502920917128-1aa500764cbd'],
  'powerbank-storage': ['1609091839311-d5365f9ff1c5'],
  'electronics-generic': ['1498049794561-7780e7231661'],
  // TRAVEL
  'beach': ['1507525428034-b723cf961d3e'],
  'mountains': ['1464822759023-fed622ff2c3b'],
  'city': ['1502602898657-3e91760cbb34'],
  'hotel': ['1566073771259-6a8506099945'],
  'flight': ['1436491865332-7a61a109cc05'],
  'travel-generic': ['1488646953014-85cb44e25828'],
};

// ---- keyword → category rules (ORDER MATTERS: specific before general) ------
// Each entry is [category, regex, openverseQuery, vertical]. The 4th field
// SCOPES the rule to a vertical: a Finance product only tests Finance rules, a
// Fashion product only Fashion rules, etc. This is what stops cross-vertical
// contradictions — e.g. "Liquid Fund Wallet" (Finance) must NOT hit the Fashion
// 'bag' rule on the word "wallet", and a Fashion "Bifold Wallet" SHOULD. Same
// word, different vertical, correct category both ways. The Openverse QUERY is
// used when the curated image is unavailable so the long-tail still matches.
const RULES = [
  // ---- Food (note: fried-chicken BEFORE curry so "Korean Fried Chicken" wins;
  //      pizza matches the "margherita" PIZZA spelling, not the cocktail) ----
  ['pizza', /\bpizza|margherita|napoletana|pepperoni|focaccia|calzone\b/i, 'pizza food', 'Food'],
  ['fried-chicken', /fried chicken|korean.*chicken|chicken.*(wing|bucket|popcorn|nugget|broast|crispy|tender)|\bwings\b|nuggets/i, 'fried chicken food', 'Food'],
  ['burger', /burger|cheeseburger|\bslider/i, 'gourmet burger', 'Food'],
  ['curry', /curry|butter chicken|tikka|masala|biryani|\bnaan\b|\bdal\b|paneer|korma|gravy|kebab|tandoori/i, 'indian curry dish', 'Food'],
  ['pasta-risotto', /pasta|risotto|spaghetti|penne|lasagn|noodle|ramen|mac.*cheese|fettucc|carbonara|alfredo/i, 'pasta dish', 'Food'],
  ['dessert', /dessert|cake|chocolate|brownie|ice.?cream|sticky rice|gelato|pastry|tiramisu|cheesecake|donut|waffle|pudding|mousse/i, 'plated dessert', 'Food'],
  ['beverage', /coffee|cold brew|latte|\btea\b|juice|smoothie|\bbrew\b|frapp|mocha|\bcola\b|soda|lemonade|shake|flask|cappuccino|espresso|cocktail|mocktail|margarita|mojito|sangria|\bwine\b|\bbeer\b|whisky|whiskey|vodka|\bgin\b|\brum\b/i, 'drink beverage', 'Food'],
  ['sides', /nachos|fries|\bsides\b|wedges|garlic bread|spring roll|\bmomo|dumpling|samosa|tacos?\b/i, 'appetizer side dish', 'Food'],
  ['salad-bowl', /salad|poke|greens|buddha bowl|grain bowl/i, 'fresh salad bowl', 'Food'],
  ['sushi', /sushi|sashimi|\bmaki\b|nigiri|temaki/i, 'sushi platter', 'Food'],

  // ---- Fashion (jacket BEFORE trousers so "denim jacket" isn't "denim"→trousers) ----
  ['jacket-coat', /jacket|blazer|\bcoat\b|trench|parka|overcoat|outerwear|bomber/i, 'clothing jacket', 'Fashion'],
  ['dress', /dress|gown|frock|\bmidi\b|maxi|skirt/i, 'fashion dress', 'Fashion'],
  ['trousers', /trouser|\bpant|\bjean|denim|chino|legging|\bshorts?\b|culotte|joggers/i, 'trousers fashion', 'Fashion'],
  ['shirt-top', /shirt|\btee\b|t-shirt|\btop\b|blouse|sweater|\bknit|hoodie|polo|jumper|kurta|cardigan/i, 'shirt apparel', 'Fashion'],
  ['shoes', /\bshoe|sneaker|\bboot|loafer|\bheel|sandal|trainer|footwear|\bcourt\b|brogue|espadrille/i, 'shoes footwear', 'Fashion'],
  ['bag', /\bbag\b|tote|backpack|clutch|crossbody|purse|wallet|satchel|handbag|duffel/i, 'leather handbag', 'Fashion'],
  ['accessory', /scarf|\bbelt\b|\bhat\b|\bcap\b|sunglass|jewel|necklace|earring|bracelet|accessor/i, 'fashion accessory', 'Fashion'],

  // ---- Finance (abstract on-theme) ----
  ['insurance', /insur|term plan|\bcover\b|life plan|health plan|\bulip\b|protect/i, 'insurance protection', 'Finance'],
  ['pension', /pension|retire|annuity/i, 'retirement planning', 'Finance'],
  ['gold', /\bgold\b|bullion|silver|precious metal/i, 'gold bars investment', 'Finance'],
  ['savings', /deposit|\bfd\b|saving|fixed deposit|recurring|liquid fund|\bwallet\b/i, 'savings money', 'Finance'],
  ['fund-invest', /fund|\bsip\b|elss|equity|mutual|index|portfolio|invest|stock|nifty|\betf\b|booster/i, 'stock market investment chart', 'Finance'],
  ['loan', /\bloan\b|\bemi\b|credit|mortgage/i, 'finance loan', 'Finance'],

  // ---- Beauty ----
  ['lipstick-makeup', /lipstick|\blip\b|foundation|mascara|kajal|eyeliner|blush|makeup|concealer|matte|pigment|\bstick\b/i, 'lipstick makeup cosmetic', 'Beauty'],
  ['skincare', /serum|moistur|\bcream\b|cleanser|toner|\bmask\b|skincare|\bspf\b|sunscreen|lotion|repair|hydra/i, 'skincare serum bottle', 'Beauty'],
  ['fragrance', /perfume|fragrance|eau de|parfum|cologne|\bmist\b|rosewater/i, 'perfume bottle', 'Beauty'],

  // ---- Electronics ----
  ['headphones', /headphone|earbud|earphone|airpod|\bbuds\b|\baudio\b|speaker|soundbar/i, 'headphones audio', 'Electronics'],
  ['smartwatch', /smartwatch|\bwatch\b|wearable|\bband\b|fitness tracker/i, 'smartwatch wearable', 'Electronics'],
  ['phone', /smartphone|\biphone\b|android|\bmobile\b|\bphone\b/i, 'smartphone device', 'Electronics'],
  ['laptop', /laptop|macbook|notebook|ultrabook|keyboard/i, 'laptop computer', 'Electronics'],
  ['camera', /camera|gopro|action cam|\blens\b|dslr|mirrorless/i, 'camera device', 'Electronics'],
  ['powerbank-storage', /power.?bank|\bssd\b|hard drive|storage|charger|\bcable\b|adapter/i, 'tech accessory gadget', 'Electronics'],

  // ---- Travel ----
  ['mountains', /trek|himalay|mountain|trail|\bhike|\bpeak\b|\bhill/i, 'mountain landscape', 'Travel'],
  ['beach', /beach|\bgoa\b|\bbali\b|island|coast|\bsea\b|honeymoon/i, 'tropical beach', 'Travel'],
  ['hotel', /hotel|\bstay\b|\bsuite\b|\broom\b|lounge|villa|resort/i, 'luxury hotel room', 'Travel'],
  ['flight', /flight|\bair\b|airport/i, 'airplane travel', 'Travel'],
  ['city', /\bcity\b|\bbreak\b|weekend|urban|metro|escape/i, 'city skyline travel', 'Travel'],
];

// Per-vertical default when no keyword rule matches (medium confidence — still
// on-theme, never random).
const VERTICAL_DEFAULT = {
  Food: 'food-generic', Fashion: 'apparel-generic', Finance: 'finance-generic',
  Beauty: 'beauty-generic', Electronics: 'electronics-generic', Travel: 'travel-generic',
};

function strHash(s) { let h = 0; for (let i = 0; i < String(s).length; i++) h = (h * 31 + String(s).charCodeAt(i)) >>> 0; return h; }

// ---- categorize ------------------------------------------------------------
// Vertical-scoped: when the vertical is known we ONLY consider that vertical's
// rules, so a word shared across verticals ("wallet", "watch", "band", "mask")
// can never pull a product into the wrong category. An unknown vertical falls
// back to a global best-effort match (still better than random), and anything
// unmatched degrades to the vertical default (medium) or null (low) — which the
// caller's contradiction guard turns into a labelled placeholder, never a wrong
// picture.
function categorize(name, vertical) {
  const n = String(name || '').toLowerCase();
  const v = String(vertical || '');
  const known = Object.prototype.hasOwnProperty.call(VERTICAL_DEFAULT, v);
  for (const [category, re, query, ruleVertical] of RULES) {
    if (known && ruleVertical !== v) continue; // honour the vertical scope
    if (re.test(n)) return { category, confidence: 'high', query };
  }
  const def = VERTICAL_DEFAULT[v];
  if (def) {
    // build a sensible Openverse query from the vertical + a couple name words
    const words = n.replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean).slice(0, 3).join(' ');
    return { category: def, confidence: 'medium', query: (words || v.toLowerCase()) + ' product' };
  }
  return { category: null, confidence: 'low', query: null };
}

// ---- curated category image (deterministic) --------------------------------
function curatedImage(category, w, h, seed) {
  const ids = CAT_IMG[category];
  if (!ids || !ids.length) return null;
  const id = ids[Math.abs(seed | 0) % ids.length];
  return `https://images.unsplash.com/photo-${id}?w=${w}&h=${h}&fit=crop&crop=entropy&q=72`;
}

// ---- Openverse category search (CC-licensed, real match + provenance) -------
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
// resize/crop a found image to exact dimensions via the weserv CDN (https, used
// elsewhere in the asset layer) so the slot gets correct width/height.
function weserv(srcNoScheme, w, h) {
  return `https://images.weserv.nl/?url=${encodeURIComponent(srcNoScheme)}&w=${w}&h=${h}&fit=cover&output=jpg`;
}
async function openverseImage(query, { w = 600, h = 400, seed = 0, timeout = 8000 } = {}) {
  if (!query) return null;
  try {
    const url = `https://api.openverse.org/v1/images/?q=${encodeURIComponent(query)}&page_size=8&license_type=commercial&mature=false`;
    const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(timeout) });
    if (!r.ok) return null;
    const j = await r.json();
    const results = (j.results || []).filter((x) => x && x.url && /^https:/i.test(x.url));
    if (!results.length) return null;
    const pick = results[Math.abs(seed | 0) % Math.min(results.length, 8)];
    const srcNoScheme = pick.url.replace(/^https?:\/\//, '');
    return {
      url: weserv(srcNoScheme, w, h),
      rawUrl: pick.url,
      creator: pick.creator || null,
      sourceUrl: pick.foreign_landing_url || pick.url,
      license: {
        license: `Openverse (${(pick.license || 'cc').toUpperCase()}${pick.license_version ? ' ' + pick.license_version : ''})`,
        rights: 'review',
        licenseNote: `${pick.license ? pick.license.toUpperCase() : 'CC'}-licensed via Openverse${pick.creator ? ', by ' + pick.creator : ''}. Category-matched to "${query}". Verify attribution before a customer send.`,
      },
    };
  } catch { return null; }
}

module.exports = { categorize, curatedImage, openverseImage, CAT_IMG, RULES, VERTICAL_DEFAULT, strHash };
