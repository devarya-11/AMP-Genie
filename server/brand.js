'use strict';

// Brand Read: paste a URL -> infer name, voice, palette, products, currency.
// Server-side, resilient: every field degrades to the Stage 1 synthetic path
// (brand library / hash colour / content library) rather than erroring.

const { derivePalette, CURRENCIES, VERTICALS } = require('./generate');
const { getContent } = require('./content');

// ---- curated brand library -------------------------------------------------
// Accurate, real brand identity. Each record is the authoritative source for a
// known brand's colours + aesthetic register so generation never cross-wires
// (the "#2c4152 for everyone" bug) and never has to guess for a marquee brand.
//   primary/accent : real brand colours (verified, on-brand)
//   aesthetic      : render register — luxury | minimal | fintech | bold | playful
//   vertical       : content theme when the site exposes nothing server-side
//   nav            : the brand's REAL top-nav items (drives the branded header)
//   heroTheme      : art-direction theme for the full-bleed hero
//                    (sport | festive | editorial | fintech | food | beauty | tech | generic)
//   tagline        : the brand's own line, used as a hero kicker / sender voice
//   promo          : value-prop strip items + an optional headline offer
//   products       : real product names (used when a JS-rendered site hides its
//                    catalogue from a server fetch — keeps the demo believable)
const BRAND_LIBRARY = {
  // ---- marquee brands (client-grade creative references) ----
  ajio: {
    name: 'AJIO', primary: '#2C4152', accent: '#C9A24B', aesthetic: 'playful', vertical: 'Fashion', currency: 'INR',
    nav: ['Shop All', 'Men', 'Women', 'Kids', 'Indie', 'Brands'],
    heroTheme: 'festive', tagline: 'Be You. Be AJIO.',
    promo: { strip: ['Free Shipping', '15-Day Returns', 'Cash on Delivery'], offer: { code: 'AJIO300', text: 'Extra {c}300 off on orders above {c}1,499' } },
    products: ['Relaxed Linen Resort Shirt', 'High-Rise Wide-Leg Jeans', 'Chunky Sole Court Sneakers', 'Oversized Graphic Tee', 'Tailored Single-Breast Blazer', 'Quilted Crossbody Bag'],
    prices: [1299, 1799, 2499, 799, 3499, 1599],
  },
  tajhotels: {
    name: 'Taj Hotels', primary: '#1C3F4A', accent: '#B08D4C', aesthetic: 'luxury', vertical: 'Food', currency: 'INR',
    nav: ['Stay', 'Dine', 'Spa', 'Offers', 'Epicure'],
    heroTheme: 'editorial', tagline: 'A tradition of flawless hospitality',
    promo: { strip: ['Epicure Privileges', 'Complimentary Valet', 'Curated by our Chefs'], offer: null },
    products: ['Chef’s Table Degustation', 'The Grand Sunday Brunch', 'High Tea at the Sea Lounge', 'Wine Pairing Dinner', 'Jiva Spa Signature Ritual', 'Heritage Suite Retreat'],
    prices: [6500, 3200, 2400, 8500, 7000, 28000],
  },
  iciciprulife: {
    name: 'ICICI Prudential', primary: '#C71A2B', accent: '#F58220', aesthetic: 'fintech', vertical: 'Finance', currency: 'INR',
    nav: ['Term Plans', 'ULIPs', 'Retirement', 'Claims', 'Support'],
    heroTheme: 'fintech', tagline: 'Protect your family’s tomorrow, today',
    promo: { strip: ['Tax Benefits u/s 80C', '99.2% Claims Settled', 'Cover up to {c}1 Cr'], offer: null },
    products: ['iProtect Smart Term Plan', 'Signature ULIP', 'Guaranteed Pension Plan', 'Smart Kid Education Plan', 'Heart & Cancer Protect', 'Easy Retirement SIP'],
    prices: [499, 2500, 5000, 3000, 800, 1000],
  },
  redbus: {
    name: 'redBus', currency: 'INR',
    primary: '#D84E55', accent: '#222A3F', aesthetic: 'bold', vertical: 'Travel',
    nav: ['Bus Tickets', 'Rail', 'Hotels', 'Offers', 'Help'],
    heroTheme: 'festive', tagline: 'Book buses the smart way',
    promo: { strip: ['Free Cancellation', 'Live Bus Tracking', 'Lowest Price Promise'], offer: { code: 'FIRST', text: 'Up to {c}250 off your first booking' } },
    products: ['Bengaluru → Goa Sleeper', 'Mumbai → Pune AC Seater', 'Delhi → Manali Volvo', 'Hyderabad → Tirupati', 'Chennai → Bengaluru', 'Pune → Shirdi'],
    prices: [1299, 450, 1100, 600, 700, 550],
  },
  zomato: {
    name: 'Zomato', currency: 'INR',
    primary: '#E23744', accent: '#1C1C1C', aesthetic: 'playful', vertical: 'Food',
    nav: ['Order Online', 'Dining Out', 'Live', 'Offers'],
    heroTheme: 'food', tagline: 'Never have a bad meal',
    promo: { strip: ['Free Delivery', 'Live Order Tracking', 'Zomato Gold'], offer: { code: 'EATNOW', text: '60% off up to {c}120 on your first order' } },
    products: ['Wood-Fired Margherita', 'Butter Chicken & Naan', 'Korean Fried Chicken', 'Death by Chocolate', 'Cold Brew Coffee', 'Loaded Nachos'],
    prices: [329, 349, 399, 199, 179, 249],
  },
  // ---- additional curated identities ----
  burberry: {
    primary: '#000000', accent: '#D5C4A1', aesthetic: 'luxury', vertical: 'Fashion', currency: 'GBP',
    nav: ['Women', 'Men', 'Bags', 'Gifts', 'The Check'], heroTheme: 'editorial', tagline: 'A British original since 1856',
    products: ['Heritage Trench Coat', 'Vintage Check Cashmere Scarf', 'Check Cotton Tote Bag', 'Lola Leather Shoulder Bag', 'Gabardine Car Coat', 'Cashmere Crew-Neck Sweater'],
    prices: [1890, 470, 590, 1290, 1690, 690],
  },
  chanel: {
    primary: '#000000', accent: '#C8A96A', aesthetic: 'luxury', vertical: 'Beauty', currency: 'EUR',
    nav: ['Fragrance', 'Makeup', 'Skincare', 'Watches', 'High Jewelry'], heroTheme: 'editorial', tagline: 'The essence of a woman',
    products: ['No.5 Eau de Parfum', 'Rouge Coco Lipstick', 'Le Lift Crème', 'Classic Quilted Flap Bag', 'Les Beiges Healthy Glow', 'Coco Mademoiselle'],
    prices: [135, 42, 165, 8800, 62, 115],
  },
  gucci: { primary: '#1B1B1B', accent: '#A67C2E', aesthetic: 'luxury', vertical: 'Fashion', currency: 'EUR', nav: ['Women', 'Men', 'Bags', 'Gifts', 'Décor'], heroTheme: 'editorial' },
  swiggy: { primary: '#FC8019', accent: '#1C1C1C', aesthetic: 'playful', vertical: 'Food', currency: 'INR', nav: ['Food', 'Instamart', 'Dineout', 'Offers'], heroTheme: 'food', tagline: 'Live it up' },
  groww: { primary: '#00B386', accent: '#0A1F44', aesthetic: 'fintech', vertical: 'Finance', currency: 'INR', nav: ['Stocks', 'Mutual Funds', 'F&O', 'Loans'], heroTheme: 'fintech', tagline: 'Invest with confidence' },
  zerodha: { primary: '#387ED1', accent: '#1C1C1C', aesthetic: 'fintech', vertical: 'Finance', currency: 'INR', nav: ['Kite', 'Console', 'Coin', 'Varsity'], heroTheme: 'fintech' },
  nykaa: { primary: '#FC2779', accent: '#1A1A1A', aesthetic: 'playful', vertical: 'Beauty', currency: 'INR', nav: ['Makeup', 'Skin', 'Hair', 'Luxe', 'Offers'], heroTheme: 'beauty', tagline: 'Your beauty, our passion' },
  allbirds: { primary: '#D8C3A5', accent: '#2E2A25', aesthetic: 'minimal', vertical: 'Fashion', currency: 'USD', nav: ['Men', 'Women', 'Shoes', 'Apparel'], heroTheme: 'editorial', tagline: 'Made with nature' },
  gymshark: { primary: '#1B1B1B', accent: '#E0FE10', aesthetic: 'bold', vertical: 'Fashion', currency: 'GBP', nav: ['Women', 'Men', 'Leggings', 'Sale'], heroTheme: 'festive', tagline: 'Be a visionary' },
  apple: { primary: '#1D1D1F', accent: '#0071E3', aesthetic: 'minimal', vertical: 'Electronics', currency: 'USD', nav: ['Mac', 'iPhone', 'iPad', 'Watch', 'Store'], heroTheme: 'tech' },
  flipkart: { primary: '#2874F0', accent: '#FFE11B', aesthetic: 'playful', vertical: 'Generic', currency: 'INR', nav: ['Electronics', 'Fashion', 'Home', 'Grocery', 'Offers'], heroTheme: 'festive', tagline: 'For every step of your journey' },
  myntra: { primary: '#FF3F6C', accent: '#3E3E3E', aesthetic: 'playful', vertical: 'Fashion', currency: 'INR', nav: ['Men', 'Women', 'Kids', 'Home', 'Studio'], heroTheme: 'festive', tagline: 'Fashion on your terms' },
};
// Aliases: name-only input resolves the registrable label, which may differ from
// the legal/site host (e.g. "taj" -> tajhotels, "icici" -> iciciprulife).
const BRAND_ALIASES = { taj: 'tajhotels', tajhotel: 'tajhotels', icici: 'iciciprulife', iciciprudential: 'iciciprulife', icicipru: 'iciciprulife', 'red-bus': 'redbus' };

// Look a brand up by its registrable name (e.g. "burberry" from burberry.com).
function libGet(name) {
  const key = String(name || '').toLowerCase();
  return BRAND_LIBRARY[key] || BRAND_LIBRARY[BRAND_ALIASES[key]] || null;
}

// ---- art-direction inference (for brands not in the curated library) -------
// Every brand — known or not — gets a real branded header, a hero theme and a
// promo strip, so an unknown brand still renders a complete client-grade creative.
const NAV_BY_VERTICAL = {
  Fashion: ['Shop', 'New In', 'Men', 'Women', 'Sale'],
  Food: ['Order', 'Menu', 'Offers', 'Outlets'],
  Finance: ['Products', 'Invest', 'Insure', 'Support'],
  Beauty: ['Shop', 'Skincare', 'Makeup', 'Offers'],
  Electronics: ['Shop', 'Deals', 'Accessories', 'Support'],
  Travel: ['Book', 'Destinations', 'Offers', 'Help'],
  Generic: ['Home', 'Shop', 'About', 'Contact'],
};
function navFor(lib, vertical) {
  if (lib && Array.isArray(lib.nav)) return lib.nav;
  return NAV_BY_VERTICAL[vertical] || NAV_BY_VERTICAL.Generic;
}
function heroThemeFor(lib, vertical, aesthetic) {
  if (lib && lib.heroTheme) return lib.heroTheme;
  if (aesthetic === 'luxury' || aesthetic === 'minimal') return 'editorial';
  if (aesthetic === 'fintech' || vertical === 'Finance') return 'fintech';
  if (vertical === 'Food') return 'food';
  if (vertical === 'Beauty') return 'beauty';
  if (vertical === 'Electronics') return 'tech';
  if (aesthetic === 'bold') return 'festive';
  return 'generic';
}
const PROMO_BY_AESTHETIC = {
  luxury: ['Members’ Privileges', 'Complimentary Shipping', 'Hand-Finished'],
  minimal: ['Free Shipping', 'Easy Returns', 'Carbon Neutral'],
  fintech: ['Bank-Grade Security', 'Zero Hidden Fees', 'Trusted by Millions'],
  bold: ['Free Shipping', 'Fast Delivery', 'Easy Returns'],
  playful: ['Free Shipping', 'Easy Returns', 'Cash on Delivery'],
};
function promoFor(lib, aesthetic) {
  if (lib && lib.promo) return lib.promo;
  return { strip: PROMO_BY_AESTHETIC[aesthetic] || PROMO_BY_AESTHETIC.playful, offer: null };
}
// Real product names a known brand exposes (when the live site hides its grid).
// Curated prices ride along when the library supplies them, so a marquee brand's
// catalogue reads with believable, on-brand price points (Taj dining vs AJIO fashion).
function curatedProducts(lib) {
  if (!lib || !Array.isArray(lib.products)) return null;
  return lib.products.slice(0, 6).map((name, i) => ({
    name, price: (Array.isArray(lib.prices) && lib.prices[i] != null) ? lib.prices[i] : null,
    currency: null, imageUrl: null, url: null, curated: true,
  }));
}

// ---- small colour utils (local, to keep brand.js standalone) ---------------
function hexNorm(h) {
  let s = String(h || '').trim().replace(/^#/, '');
  if (/^[0-9a-f]{3}$/i.test(s)) s = s.split('').map((c) => c + c).join('');
  return /^[0-9a-f]{6}$/i.test(s) ? '#' + s.toLowerCase() : null;
}
function hsl(hex) {
  const n = parseInt(hex.slice(1), 16);
  let r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  let h = 0, s = 0; const l = (mx + mn) / 2;
  if (mx !== mn) {
    const d = mx - mn;
    s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
    if (mx === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (mx === g) h = (b - r) / d + 2; else h = (r - g) / d + 4;
    h /= 6;
  }
  return { h: h * 360, s, l };
}
// A colour is a usable "brand primary" if it is reasonably saturated and not
// near-white / near-black (theme-color is often #fff which is useless as brand).
function isBrandable(hex) {
  const c = hsl(hex);
  return c.s >= 0.25 && c.l >= 0.12 && c.l <= 0.78;
}

function hashColor(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
  const hue = h % 360;
  // build a pleasant saturated hex from hue
  const s = 0.55, l = 0.45;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => {
    const k = (n + hue / 30) % 12;
    const col = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(255 * col).toString(16).padStart(2, '0');
  };
  return '#' + f(0) + f(8) + f(4);
}

// ---- fetch -----------------------------------------------------------------
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

async function safeFetch(url, opts = {}) {
  return fetch(url, {
    headers: { 'User-Agent': UA, 'Accept': 'text/html,application/json,*/*' },
    redirect: 'follow',
    signal: AbortSignal.timeout(opts.timeout || 8000),
    ...opts,
  });
}

function originOf(url) {
  try { const u = new URL(url); return u.origin; } catch { return null; }
}
function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

// ---- currency --------------------------------------------------------------
function currencyFromCode(code) {
  const c = String(code || '').toUpperCase();
  return CURRENCIES[c] ? c : null;
}
function currencyFromTld(host) {
  if (/\.in$/.test(host)) return 'INR';
  if (/\.co\.uk$|\.uk$/.test(host)) return 'GBP';
  if (/\.(de|fr|es|it|nl|eu|ie|at|be|pt|fi)$/.test(host)) return 'EUR';
  return 'USD';
}
// Infer currency from symbols/codes actually present on the page.
function currencyFromSymbols(html) {
  const counts = {
    INR: (html.match(/₹|&#8377;|\bRs\.?\b|\bINR\b/g) || []).length,
    GBP: (html.match(/£|&#163;|\bGBP\b/g) || []).length,
    EUR: (html.match(/€|&#8364;|\bEUR\b/g) || []).length,
    USD: (html.match(/\bUSD\b|US\$/g) || []).length,
  };
  let best = null, n = 0;
  for (const [k, v] of Object.entries(counts)) if (v > n) { best = k; n = v; }
  return n >= 3 ? best : null;
}

// ---- JSON-LD product extraction --------------------------------------------
function parseJsonLd(html) {
  const blocks = [];
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    try { blocks.push(JSON.parse(m[1].trim())); } catch { /* ignore malformed */ }
  }
  return blocks;
}
function collectProducts(node, out, depth = 0) {
  if (!node || depth > 6) return;
  if (Array.isArray(node)) { node.forEach((n) => collectProducts(n, out, depth + 1)); return; }
  if (typeof node !== 'object') return;
  const type = node['@type'];
  const isProduct = type === 'Product' || (Array.isArray(type) && type.includes('Product'));
  if (isProduct) {
    const offer = Array.isArray(node.offers) ? node.offers[0] : node.offers || {};
    const img = Array.isArray(node.image) ? node.image[0] : (node.image && node.image.url) || node.image;
    out.push({
      name: node.name,
      price: offer.price != null ? Number(offer.price) : null,
      currency: offer.priceCurrency || null,
      imageUrl: typeof img === 'string' ? img : null,
      url: node.url || (offer.url) || null,
      sku: node.sku || node.mpn || node.productID || null,
    });
  }
  // walk common containers
  ['@graph', 'itemListElement', 'item', 'mainEntity', 'hasPart'].forEach((k) => {
    if (node[k]) collectProducts(node[k], out, depth + 1);
  });
}

// ---- Shopify products.json -------------------------------------------------
async function shopifyProducts(origin) {
  try {
    const r = await safeFetch(origin + '/products.json?limit=8', { timeout: 7000 });
    if (!r.ok) return [];
    const ct = r.headers.get('content-type') || '';
    if (!/json/.test(ct)) return [];
    const j = await r.json();
    if (!Array.isArray(j.products)) return [];
    return j.products.map((p) => {
      const v = (p.variants || [])[0] || {};
      const img = (p.images || [])[0] || {};
      return {
        name: p.title,
        price: v.price != null ? Number(v.price) : null,
        currency: null,
        imageUrl: img.src || null,
        url: origin + '/products/' + p.handle,
      };
    });
  } catch { return []; }
}

// ---- registrable brand label (subdomain-safe) ------------------------------
// "us.burberry.com" → "burberry" (NOT "us"); "shop.gymshark.co.uk" → "gymshark".
// Used for the library lookup + currency/vertical defaults so a regional or
// shop subdomain still resolves the correct curated identity.
function registrableName(host) {
  const parts = String(host || '').replace(/^www\./, '').split('.').filter(Boolean);
  if (parts.length <= 1) return parts[0] || '';
  const SECOND = /^(co|com|net|org|gov|ac|edu)$/i; // co.uk / com.au style second-level
  let tld = parts.length - 1;
  if (parts.length >= 3 && SECOND.test(parts[parts.length - 2])) tld = parts.length - 2;
  return parts[tld - 1] || parts[0];
}

// ---- official-image sizing -------------------------------------------------
// A brand's own image CDN usually serves a huge master; request a sensible,
// display-ready crop so the email stays light. Recognises the big commerce
// image servers (Adobe Scene7 — Burberry/most luxury houses — and Shopify CDN);
// anything else is returned untouched (still the brand's OFFICIAL image).
function sizeImage(url, w, h) {
  if (!url) return url;
  try {
    const u = new URL(url);
    const host = u.hostname;
    if (/\/is\/image\//i.test(u.pathname) || /scene7|assets\.burberry/i.test(host)) {
      u.searchParams.set('wid', String(w)); u.searchParams.set('hei', String(h));
      u.searchParams.set('fit', 'crop'); u.searchParams.set('qlt', '85');
      return u.toString();
    }
    if (/cdn\.shopify\.com|myshopify/i.test(host)) {
      u.searchParams.set('width', String(w));
      return u.toString();
    }
    return url;
  } catch { return url; }
}

// Strip a brand/SEO suffix so the SKU name reads like the brand's own label.
// "Cotton Trench Jacket in Sand beige | Burberry® Official" → "Cotton Trench…"
function cleanProductName(s) {
  const n = String(s || '').replace(/\s*[|–—]\s*[^|–—]*$/, '').trim();
  return n || String(s || '').trim();
}

// ---- sitemap → PDP discovery (for JS-rendered catalogues) -------------------
// Luxury SPAs (Burberry, etc.) hide the catalogue from a homepage fetch, but the
// product DATA is server-rendered on each PDP as JSON-LD. We discover PDP URLs
// from the brand's own sitemap (declared in robots.txt → may be a sitemapindex
// whose product-detail sub-maps we follow), bounded so it stays fast.
function looksLikePdp(u) {
  return /-p\d{4,}|\/products?\/|\/product-detail|\/p\/|\/dp\/|\/pd\//i.test(String(u || ''));
}
async function discoverPdpUrls(origin, { limit = 8 } = {}) {
  if (!origin) return [];
  const sitemaps = [];
  try {
    const r = await safeFetch(origin + '/robots.txt', { timeout: 6000 });
    if (r.ok) {
      const txt = await r.text();
      (txt.match(/^\s*Sitemap:\s*(\S+)/gim) || []).forEach((line) => {
        const u = line.replace(/^\s*Sitemap:\s*/i, '').trim();
        if (u) sitemaps.push(u);
      });
    }
  } catch { /* ignore */ }
  if (!sitemaps.length) sitemaps.push(origin + '/sitemap.xml', origin + '/sitemap_index.xml');

  const pdps = [];
  const seen = new Set();
  let toVisit = sitemaps.slice(0, 3);
  let budget = 4; // total sitemap fetches (index + a couple of product sub-maps)
  while (toVisit.length && budget > 0 && pdps.length < limit) {
    const sm = toVisit.shift(); budget--;
    let xml;
    try { const r = await safeFetch(sm, { timeout: 8000 }); if (!r.ok) continue; xml = await r.text(); } catch { continue; }
    const locs = (xml.match(/<loc>([^<]+)<\/loc>/gi) || []).map((m) => m.replace(/<\/?loc>/gi, '').trim());
    if (/<sitemapindex/i.test(xml)) {
      const prod = locs.filter((u) => /product-detail|product|pdp/i.test(u));
      toVisit = (prod.length ? prod : locs).slice(0, 3).concat(toVisit);
    } else {
      for (const u of locs) {
        if (seen.has(u)) continue; seen.add(u);
        if (looksLikePdp(u)) pdps.push(u);
        if (pdps.length >= limit) break;
      }
    }
  }
  return pdps.slice(0, limit);
}

// Extract ONE complete same-SKU record from a PDP: JSON-LD Product first
// (name + official image + url + sku [+ price if present]), OG product tags as
// a fallback. Everything returned belongs to the SAME real product.
async function productFromPdp(url) {
  try {
    const r = await safeFetch(url, { timeout: 9000 });
    if (!r.ok) return null;
    const html = await r.text();
    const out = [];
    parseJsonLd(html).forEach((b) => collectProducts(b, out));
    let p = out.find((x) => x.name && x.imageUrl && /^https:/i.test(x.imageUrl || ''));
    if (!p) {
      const ogt = metaContent(html, 'property', 'og:title');
      const ogi = metaContent(html, 'property', 'og:image');
      const amt = metaContent(html, 'property', 'product:price:amount');
      const cur = metaContent(html, 'property', 'product:price:currency');
      if (ogt && ogi && /^https:/i.test(ogi)) {
        p = { name: ogt, imageUrl: ogi, price: amt != null && amt !== '' ? Number(amt) : null, currency: cur || null, url, sku: null };
      }
    }
    if (!p) return null;
    return {
      name: cleanProductName(p.name),
      price: (p.price != null && !Number.isNaN(p.price)) ? p.price : null,
      currency: p.currency || null,
      imageUrl: sizeImage(p.imageUrl, 600, 600),
      url: p.url || url,
      sku: p.sku || null,
      real: true,
      source: 'pdp-jsonld',
    };
  } catch { return null; }
}

// Orchestrator: real, same-SKU products from the brand's OWN source, in priority
// order — (1) catalogue JSON-LD on the page we already fetched, (2) Shopify
// products.json, (3) sitemap → PDP JSON-LD crawl (bounded). Returns [] when the
// brand exposes nothing usable, so the caller can fall back + label honestly.
async function realBrandProducts({ origin, html, limit = 8, crawl = true }) {
  if (!origin) return [];
  let products = [];

  if (html) {
    const out = [];
    parseJsonLd(html).forEach((b) => collectProducts(b, out));
    products = out
      .filter((p) => p.name && p.imageUrl && /^https:/i.test(p.imageUrl || ''))
      .map((p) => ({ ...p, name: cleanProductName(p.name), imageUrl: sizeImage(p.imageUrl, 600, 600), real: true, source: 'jsonld' }));
  }

  if (products.length < 2) {
    const shop = await shopifyProducts(origin);
    const httpsShop = shop
      .filter((p) => p.name && p.imageUrl && /^https:/i.test(p.imageUrl))
      .map((p) => ({ ...p, name: cleanProductName(p.name), imageUrl: sizeImage(p.imageUrl, 600, 600), real: true, source: 'shopify' }));
    if (httpsShop.length > products.length) products = httpsShop;
  }

  if (crawl && products.length < 2) {
    const urls = await discoverPdpUrls(origin, { limit: Math.max(limit, 6) });
    if (urls.length) {
      const settled = await Promise.allSettled(urls.slice(0, Math.max(limit, 6)).map((u) => productFromPdp(u)));
      const crawled = settled.filter((s) => s.status === 'fulfilled' && s.value).map((s) => s.value);
      const seen = new Set();
      const deduped = crawled.filter((p) => { const k = (p.name || '').toLowerCase(); if (!k || seen.has(k)) return false; seen.add(k); return true; });
      if (deduped.length) products = deduped;
    }
  }

  return products.slice(0, limit);
}

// ---- name / meta helpers ---------------------------------------------------
function metaContent(html, attr, val) {
  const re = new RegExp(`<meta[^>]+${attr}=["']${val}["'][^>]+content=["']([^"']+)["']`, 'i');
  const m = html.match(re) || html.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+${attr}=["']${val}["']`, 'i'));
  return m ? m[1].trim() : null;
}
function cleanName(s) {
  return String(s || '')
    .replace(/^welcome to (the )?/i, '')
    .replace(/\b(online store|official site|official store|home ?page|store)\b/ig, '')
    .replace(/[.\s|–—:·\-]+$/, '')
    .trim();
}
function titleOf(html) {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!m) return null;
  return cleanName(m[1].replace(/\s+/g, ' ').trim().split(/[|–—:·]/)[0].trim());
}

// A real favicon/logo service for a known domain (used when we can't fetch the
// page but do know the host). Returns null for a bare name with no TLD.
function faviconHint(host) {
  return /\./.test(String(host || '')) ? `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=128` : null;
}

// ---- absolute, HTTPS-preferring URL resolution -----------------------------
function absUrl(href, origin) {
  if (!href) return null;
  href = String(href).trim().replace(/&amp;/g, '&');
  if (/^https:\/\//i.test(href)) return href;
  if (/^http:\/\//i.test(href)) return href.replace(/^http:/i, 'https:'); // upgrade
  if (/^\/\//.test(href)) return 'https:' + href;                          // protocol-relative
  if (origin && /^\//.test(href)) return origin + href;                    // root-relative
  if (origin && !/^[a-z][a-z0-9+.-]*:/i.test(href)) return origin + '/' + href.replace(/^\.?\//, '');
  return null;
}

// ---- logo extraction -------------------------------------------------------
// Real logo in priority order: a markup <img> that is clearly the logo, then
// the highest-resolution declared icon (apple-touch-icon / large favicon), then
// og:image / twitter:image as a last resort. Everything resolved to an absolute
// HTTPS URL so the asset layer can rehost + render it in the header.
function extractIcons(html, origin) {
  const icons = [];
  const re = /<link\b[^>]*>/gi; let m;
  while ((m = re.exec(html))) {
    const tag = m[0];
    if (!/\brel=["'][^"']*icon[^"']*["']/i.test(tag)) continue;
    const href = (tag.match(/\bhref=["']([^"']+)["']/i) || [])[1];
    const url = absUrl(href, origin);
    if (!url) continue;
    const sizes = (tag.match(/\bsizes=["']([^"']+)["']/i) || [])[1] || '';
    const sz = Math.max(0, ...((sizes.match(/\d+/g) || ['0']).map(Number)));
    icons.push({ url, sz, apple: /apple-touch-icon/i.test(tag), svg: /\.svg(\?|$)/i.test(url) });
  }
  return icons;
}
function extractLogo(html, origin) {
  // 1) a markup <img> whose attributes say "logo" (skip sprites / payment / social)
  const imgRe = /<img\b[^>]*>/gi; let m;
  while ((m = imgRe.exec(html))) {
    const tag = m[0];
    if (!/(logo|wordmark|brandmark)/i.test(tag)) continue;
    if (/(sprite|payment|footer-|social|app-?store|google-?play|badge|flag)/i.test(tag)) continue;
    const src = (tag.match(/\bsrc=["']([^"']+)["']/i) || [])[1]
      || (tag.match(/\bdata-src=["']([^"']+)["']/i) || [])[1]
      || (tag.match(/\bsrcset=["']([^",\s]+)/i) || [])[1];
    const url = absUrl(src, origin);
    if (url && /\.(svg|png|jpe?g|webp|avif)(\?|$)/i.test(url)) return url;
  }
  // 2) declared icons — prefer apple-touch-icon, then largest, then SVG
  const icons = extractIcons(html, origin);
  if (icons.length) {
    icons.sort((a, b) => (b.apple - a.apple) || (b.sz - a.sz) || (b.svg - a.svg));
    return icons[0].url;
  }
  // 3) social card image (may be a hero, but better than nothing)
  const og = metaContent(html, 'property', 'og:image') || metaContent(html, 'name', 'twitter:image');
  return absUrl(og, origin);
}

// ---- footer extraction -----------------------------------------------------
// A brand's real footer signals: a copyright line and a social row. We pull what
// the static markup exposes and let the renderer compose an on-brand footer.
const SOCIAL_NETS = {
  instagram: /https?:\/\/(?:www\.)?instagram\.com\/[A-Za-z0-9_.][A-Za-z0-9_./]*/i,
  facebook: /https?:\/\/(?:www\.)?facebook\.com\/[A-Za-z0-9_.][A-Za-z0-9_./]*/i,
  twitter: /https?:\/\/(?:www\.)?(?:twitter|x)\.com\/[A-Za-z0-9_.][A-Za-z0-9_./]*/i,
  youtube: /https?:\/\/(?:www\.)?youtube\.com\/[A-Za-z0-9_.@][A-Za-z0-9_./@]*/i,
  tiktok: /https?:\/\/(?:www\.)?tiktok\.com\/@[A-Za-z0-9_.][A-Za-z0-9_./]*/i,
  pinterest: /https?:\/\/(?:[a-z]{2,3}\.)?pinterest\.[a-z.]+\/[A-Za-z0-9_.][A-Za-z0-9_./]*/i,
  linkedin: /https?:\/\/(?:www\.)?linkedin\.com\/(?:company|in)\/[A-Za-z0-9_.-]+/i,
};
function extractFooter(html) {
  let copyright = null;
  const cm = html.match(/(?:©|&copy;|&#169;|&#xa9;)\s*\d{0,4}[^<\n]{0,70}/i);
  if (cm) copyright = cm[0].replace(/&copy;|&#169;|&#xa9;/gi, '©').replace(/\s+/g, ' ').trim().slice(0, 90);
  const social = [];
  for (const [network, re] of Object.entries(SOCIAL_NETS)) {
    const mm = html.match(re);
    if (mm) social.push({ network, url: mm[0].replace(/[)"'<>].*$/, '') });
  }
  return { copyright, social };
}

// ---- aesthetic inference (for brands not in the curated library) -----------
function inferAesthetic(voice, vertical) {
  const v = String(voice || '').toLowerCase();
  if (/luxur|premium|curat|couture|atelier|signature|crafted|bespoke/.test(v)) return 'luxury';
  if (vertical === 'Finance') return 'fintech';
  if (/eco|natural|sustainab|minimal|conscious|organic/.test(v)) return 'minimal';
  if (/bold|power|perform|athlet|gym|strong/.test(v)) return 'bold';
  return 'playful';
}

// ---- voice heuristic -------------------------------------------------------
const VOICE_SIGNALS = [
  [/luxur|premium|curat|crafted|signature|atelier|couture/i, 'premium'],
  [/sustainab|eco|organic|natural|recycl|conscious/i, 'natural'],
  [/sale|deal|off|save|discount|lowest|bachat/i, 'value-driven'],
  [/tech|smart|pro|innovat|next-?gen|engineer/i, 'modern'],
  [/fun|play|joy|happy|vibe|love/i, 'playful'],
  [/bold|power|strong|perform|train|gym|athlet/i, 'bold'],
  [/care|gentle|glow|skin|beauty|radian/i, 'caring'],
];
function inferVoice(text) {
  const found = [];
  for (const [re, word] of VOICE_SIGNALS) {
    if (re.test(text) && !found.includes(word)) found.push(word);
    if (found.length >= 3) break;
  }
  if (!found.length) return { voice: 'warm, direct', confidence: 'low' };
  return { voice: found.join(', '), confidence: found.length >= 2 ? 'medium' : 'low' };
}
// Map a voice descriptor to a Stage 1 tone for generation.
function voiceToTone(voice) {
  const v = voice.toLowerCase();
  if (/premium|luxur|curat/.test(v)) return 'Premium';
  if (/value|deal|urgen|sale/.test(v)) return 'Urgent';
  if (/play|fun|bold/.test(v)) return 'Playful';
  return 'Informative';
}
// Guess a content vertical so synthetic fallback is on-theme.
function guessVertical(text) {
  const t = text.toLowerCase();
  const sets = {
    Beauty: /beauty|skin|makeup|cosmet|serum|fragrance|lipstick|nykaa|glow|haircare/g,
    Fashion: /shoe|apparel|cloth|wear|fashion|outfit|denim|footwear|sneaker|jacket/g,
    Food: /food|restaurant|meal|menu|recipe|kitchen|grocery|snack|beverage/g,
    Finance: /invest|fund|stock|bank|finance|loan|insur|mutual|trading/g,
    Electronics: /phone|laptop|gadget|electronic|device|audio|camera|headphone|wearable/g,
    Travel: /travel|hotel|flight|trip|holiday|tour|vacation|booking|resort/g,
  };
  let best = 'Generic', bestN = 0;
  for (const [k, re] of Object.entries(sets)) {
    const n = (t.match(re) || []).length;
    if (n > bestN) { bestN = n; best = k; }
  }
  return best;
}

// ---- palette from html -----------------------------------------------------
function dominantColor(html) {
  const counts = new Map();
  const re = /#([0-9a-fA-F]{6})\b/g;
  let m;
  while ((m = re.exec(html))) {
    const hex = '#' + m[1].toLowerCase();
    if (isBrandable(hex)) counts.set(hex, (counts.get(hex) || 0) + 1);
  }
  let best = null, bestN = 0;
  for (const [hex, n] of counts) if (n > bestN) { best = hex; bestN = n; }
  return bestN >= 3 ? best : null;
}

// ---- synthetic fallback products from content library ----------------------
function syntheticProducts(vertical, palette) {
  const c = getContent(vertical);
  return c.items.slice(0, 6).map((it) => ({
    name: it.name,
    price: it.price,
    currency: null,
    imageUrl: null, // placeholder applied at generate/visual stage
    url: null,
    synthetic: true,
  }));
}

// ---- main ------------------------------------------------------------------
async function brandRead(rawUrl, opts = {}) {
  let url = String(rawUrl || '').trim();
  if (url && !/^https?:\/\//i.test(url)) url = 'https://' + url;
  const host = hostOf(url);
  const origin = originOf(url);
  const libName = registrableName(host);

  const conf = {};
  let source = 'fetched';
  let html = '';
  let fetchOk = false;

  // Brand-name path (no dot / not a URL): skip the fetch entirely.
  const looksLikeUrl = /\./.test(String(rawUrl || ''));
  if (looksLikeUrl) {
    try {
      const r = await safeFetch(url);
      if (r.ok) { html = await r.text(); fetchOk = true; }
    } catch { /* fall through */ }
  }

  if (!fetchOk) {
    // Total fallback path (name-only, or fetch blocked) — still return a usable,
    // on-brand profile. A curated library brand keeps its real colours, accent,
    // aesthetic and product names even with no live fetch.
    const lib = libGet(libName);
    const vertical = (lib && lib.vertical) || guessVertical(libName || '');
    const primary = (lib && lib.primary) || hashColor(libName || 'brand');
    const pal = derivePalette(primary);
    const accent = (lib && lib.accent) || pal.accent;
    const aesthetic = (lib && lib.aesthetic) || inferAesthetic('', vertical);
    const currency = (lib && lib.currency) || currencyFromTld(host) || 'USD';
    const products = curatedProducts(lib) || syntheticProducts(vertical, pal);
    return {
      name: (lib && lib.name) || titleCaseHost(libName || 'Your Brand'),
      voice: aesthetic === 'luxury' ? 'premium, refined' : 'warm, direct',
      logo: lib ? faviconHint(host) : null,
      palette: { primary: pal.primary, accent, background: '#ffffff', ink: pal.ink },
      products,
      currency,
      aesthetic,
      nav: navFor(lib, vertical),
      heroTheme: heroThemeFor(lib, vertical, aesthetic),
      tagline: (lib && lib.tagline) || null,
      promo: promoFor(lib, aesthetic),
      footer: { copyright: null, social: [] },
      confidence: { name: lib ? 'medium' : 'low', voice: 'low', palette: lib ? 'high' : 'low', products: lib && lib.products ? 'medium' : 'low', currency: 'low' },
      source: lib ? 'library' : 'fallback',
      vertical,
      tone: lib && aesthetic === 'luxury' ? 'Premium' : 'Informative',
    };
  }

  // ---- name ----
  let name = metaContent(html, 'property', 'og:site_name');
  if (name) conf.name = 'high';
  if (!name) { name = titleOf(html); if (name) conf.name = 'medium'; }
  if (!name) { name = titleCaseHost(libName); conf.name = 'low'; }

  // ---- text corpus for voice / vertical ----
  const desc = metaContent(html, 'name', 'description') || metaContent(html, 'property', 'og:description') || '';
  const ogTitle = metaContent(html, 'property', 'og:title') || '';

  // ---- products (real same-SKU records from the brand's OWN source) ----
  // Priority: catalogue JSON-LD on this page → Shopify products.json → sitemap →
  // PDP JSON-LD crawl. Each carries name + official image + product URL + sku for
  // the SAME SKU. Deep PDP crawl is bounded and can be disabled via opts.
  let products = await realBrandProducts({ origin, html, limit: 8, crawl: opts.deepProducts !== false });
  let productsConf = products.length >= 3 ? 'high' : products.length >= 1 ? 'medium' : 'low';

  // ---- currency ----
  let currency = currencyFromCode(products.find((p) => p.currency)?.currency);
  let currencyConf = currency ? 'high' : null;
  if (!currency) { const og = currencyFromCode(metaContent(html, 'property', 'product:price:currency')); if (og) { currency = og; currencyConf = 'high'; } }
  if (!currency) { const sym = currencyFromSymbols(html); if (sym) { currency = sym; currencyConf = 'medium'; } }
  if (!currency) { const _lib = libGet(libName); if (_lib && _lib.currency) { currency = _lib.currency; currencyConf = 'medium'; } }
  if (!currency) { currency = currencyFromTld(host); currencyConf = 'low'; }

  // ---- curated library record (authoritative for a known brand) ----
  const lib = libGet(libName);
  // Curated display name wins over a scraped title for a known brand (correct
  // casing: "AJIO", "redBus", "Taj Hotels").
  if (lib && lib.name) { name = lib.name; conf.name = 'high'; }

  // ---- vertical (for fallback product theming + content) ----
  const corpus = [name, ogTitle, desc, products.map((p) => p.name).join(' ')].join(' ');
  const vertical = (lib && lib.vertical) || guessVertical(corpus);

  // ---- palette ----
  // Resolution order (spec): (1) curated brand library — the accurate, real
  // brand colour wins even when a site is fetched (avoids cross-wiring), then
  // (2) site-extracted theme-color, (3) dominant page colour, (4) hash fallback.
  // (User overrides are applied later, in assets.js, as tier-1.)
  let primary = null, paletteConf = 'low';
  const theme = hexNorm(metaContent(html, 'name', 'theme-color'));
  if (lib) { primary = lib.primary; paletteConf = 'high'; }
  if (!primary && theme && isBrandable(theme)) { primary = theme; paletteConf = 'high'; }
  if (!primary) { const dom = dominantColor(html); if (dom) { primary = dom; paletteConf = 'medium'; } }
  if (!primary) { primary = hashColor(libName || name); paletteConf = 'low'; }
  const pal = derivePalette(primary);
  const accent = (lib && lib.accent) || pal.accent;
  // background: prefer a near-white theme-color if present (common), else white
  let background = '#ffffff';
  if (theme && !isBrandable(theme)) { const c = hsl(theme); if (c.l > 0.85) background = theme; }

  // ---- logo (real markup logo / high-res icon / og image), absolute HTTPS ----
  let logo = extractLogo(html, origin);
  if (logo && !/^https:/i.test(logo)) logo = null;

  // ---- footer (copyright + social row from the live site) ----
  const footer = extractFooter(html);

  // ---- voice + aesthetic ----
  const v = inferVoice([desc, ogTitle, name, products.map((p) => p.name).join(' ')].join(' '));
  const aesthetic = (lib && lib.aesthetic) || inferAesthetic(v.voice, vertical);

  // ---- products fallback — curated real names, then synthetic, never empty ----
  if (!products.length) {
    const cur = curatedProducts(lib);
    if (cur) { products = cur; productsConf = 'medium'; }
    else { products = syntheticProducts(vertical, pal); productsConf = 'low'; }
  }

  // ---- source classification ----
  const usedFallback = productsConf === 'low' || paletteConf === 'low';
  source = lib ? 'fetched' : (usedFallback ? 'partial' : 'fetched');

  return {
    name,
    voice: v.voice,
    logo: logo || null,
    palette: { primary: pal.primary, accent, background, ink: pal.ink },
    products,
    currency,
    aesthetic,
    nav: navFor(lib, vertical),
    heroTheme: heroThemeFor(lib, vertical, aesthetic),
    tagline: (lib && lib.tagline) || null,
    promo: promoFor(lib, aesthetic),
    footer,
    confidence: {
      name: conf.name || 'low',
      voice: v.confidence,
      palette: paletteConf,
      products: productsConf,
      currency: currencyConf,
    },
    source,
    vertical,
    tone: (lib && aesthetic === 'luxury') ? 'Premium' : voiceToTone(v.voice),
  };
}

function titleCaseHost(s) {
  return String(s || '').replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

module.exports = {
  brandRead, BRAND_LIBRARY, hashColor, guessVertical, voiceToTone, derivePaletteFromHex: derivePalette,
  realBrandProducts, discoverPdpUrls, productFromPdp, registrableName, sizeImage, cleanProductName,
};
