'use strict';

const { withTimeout } = require('./llm-providers');

// Brand colour + guideline resolver.
// Resolution order (spec §5): (1) user hex override, (2) curated brand
// library, (3) live fetch of the brand's own site (theme-color meta, then
// dominant saturated colour), (4) deterministic hash colour. Every path
// reports which source won, and a failed/blocked fetch falls through
// silently to the next tier rather than erroring the request.

const BRAND_LIBRARY = {
  ajio: { name: 'AJIO', primary: '#2C4152', accent: '#C9A24B', vertical: 'Fashion' },
  zomato: { name: 'Zomato', primary: '#E23744', accent: '#1C1C1C', vertical: 'Food' },
  groww: { name: 'Groww', primary: '#00B386', accent: '#0A1F44', vertical: 'Finance' },
  nykaa: { name: 'Nykaa', primary: '#FC2779', accent: '#1A1A1A', vertical: 'Beauty' },
  swiggy: { name: 'Swiggy', primary: '#FC8019', accent: '#1C1C1C', vertical: 'Food' },
  myntra: { name: 'Myntra', primary: '#FF3F6C', accent: '#3E3E3E', vertical: 'Fashion' },
  flipkart: { name: 'Flipkart', primary: '#2874F0', accent: '#FFE11B', vertical: 'Generic' },
  zerodha: { name: 'Zerodha', primary: '#387ED1', accent: '#1C1C1C', vertical: 'Finance' },
  apple: { name: 'Apple', primary: '#1D1D1F', accent: '#0071E3', vertical: 'Electronics' },
  burberry: { name: 'Burberry', primary: '#000000', accent: '#D5C4A1', vertical: 'Fashion' },
  chanel: { name: 'Chanel', primary: '#000000', accent: '#C8A96A', vertical: 'Beauty' },
  gucci: { name: 'Gucci', primary: '#1B1B1B', accent: '#A67C2E', vertical: 'Fashion' },
  allbirds: { name: 'Allbirds', primary: '#D8C3A5', accent: '#2E2A25', vertical: 'Fashion' },
  gymshark: { name: 'Gymshark', primary: '#1B1B1B', accent: '#E0FE10', vertical: 'Fashion' },
  redbus: { name: 'redBus', primary: '#D84E55', accent: '#222A3F', vertical: 'Travel' },
  tajhotels: { name: 'Taj Hotels', primary: '#1C3F4A', accent: '#B08D4C', vertical: 'Food' },
  iciciprulife: { name: 'ICICI Prudential', primary: '#C71A2B', accent: '#F58220', vertical: 'Finance' },
};
const BRAND_ALIASES = { taj: 'tajhotels', icici: 'iciciprulife', iciciprudential: 'iciciprulife', redbus2: 'redbus' };

function libKey(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}
function libGet(name) {
  const key = libKey(name);
  return BRAND_LIBRARY[key] || BRAND_LIBRARY[BRAND_ALIASES[key]] || null;
}

// ---- colour utils -----------------------------------------------------
function hexNorm(h) {
  let s = String(h || '').trim().replace(/^#/, '');
  if (/^[0-9a-f]{3}$/i.test(s)) s = s.split('').map((c) => c + c).join('');
  return /^[0-9a-f]{6}$/i.test(s) ? '#' + s.toLowerCase() : null;
}
function hsl(hex) {
  const n = parseInt(hex.slice(1), 16);
  const r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
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
// A colour is a usable "brand primary" if reasonably saturated and not
// near-white / near-black (theme-color is often #fff, useless as a brand hue).
function isBrandable(hex) {
  const c = hsl(hex);
  return c.s >= 0.25 && c.l >= 0.12 && c.l <= 0.78;
}
function hashColor(str) {
  let h = 0;
  for (let i = 0; i < String(str).length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
  const hue = h % 360, s = 0.55, l = 0.45;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => {
    const k = (n + hue / 30) % 12;
    const col = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(255 * col).toString(16).padStart(2, '0');
  };
  return '#' + f(0) + f(8) + f(4);
}

// ---- live fetch (tier 3) -----------------------------------------------
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

async function safeFetch(url, timeout = 6000, fetchImpl = fetch) {
  return fetchImpl(url, {
    headers: { 'User-Agent': UA, Accept: 'text/html,*/*' },
    redirect: 'follow',
    signal: AbortSignal.timeout(timeout),
  });
}
function metaContent(html, attr, val) {
  const re = new RegExp(`<meta[^>]+${attr}=["']${val}["'][^>]+content=["']([^"']+)["']`, 'i');
  const m = html.match(re) || html.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+${attr}=["']${val}["']`, 'i'));
  return m ? m[1].trim() : null;
}
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
function candidateDomains(brandName) {
  const slug = String(brandName || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  if (!slug) return [];
  // .in candidates matter as much as .com for this tool's actual brands —
  // groww.in, boat-lifestyle... many Indian brands never answer on .com, and
  // the .com squatter that does answer poisons the colour/logo with someone
  // else's site. .com stays first (larger namespace), .in close behind.
  return [
    `https://www.${slug}.com`, `https://${slug}.com`,
    `https://www.${slug}.in`, `https://${slug}.in`,
  ];
}

// Google's favicon service: a crisp, square, proxy-cached brand icon for any
// domain Google has indexed — reachable even when the brand's own site
// bot-walls our scraper, and never a squashed 1200x630 social banner like
// og:image. With fallback_opts limited to TYPE,SIZE (no URL fallback) the
// endpoint answers 404 for domains Google doesn't know, which makes it
// probeable: the first candidate domain that yields a 200 is both a
// confirmed-real domain AND a usable logo.
function googleFaviconUrl(domainUrl, size = 128) {
  return 'https://t1.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&fallback_opts=TYPE,SIZE&size='
    + size + '&url=' + encodeURIComponent(domainUrl);
}
// Given a brand name (no URL in this UI — see spec §4), guess its domain and
// fetch the live site for a theme-color / dominant colour. Resilient: any
// failure at any stage returns null so the caller falls through to the next
// tier rather than erroring the whole request.
async function fetchBrandColor(brandName) {
  for (const url of candidateDomains(brandName)) {
    try {
      const r = await safeFetch(url);
      if (!r.ok) continue;
      const html = await r.text();
      const theme = hexNorm(metaContent(html, 'name', 'theme-color'));
      if (theme && isBrandable(theme)) return theme;
      const dom = dominantColor(html);
      if (dom) return dom;
    } catch {
      // blocked / DNS failure / timeout — try the next candidate, then fall through
    }
  }
  return null;
}

// ---- live fetch: real logo/hero (header image) --------------------------
// Same "never the first choice to fail loudly" contract as fetchBrandColor:
// any error at any stage falls through to the next candidate, and a total
// timeout budget (not just a per-request one) means a slow/unreachable site
// degrades to null well before it could make /generate feel stuck — the
// caller's existing placeholder-image fallback (generate.js's headerBlock)
// is always the safety net, never a thrown error.
function attrValue(tag, name) {
  const m = tag.match(new RegExp(`${name}=["']([^"']+)["']`, 'i'));
  return m ? m[1].trim() : null;
}
// content/property order is unpredictable in the wild (same issue metaContent
// already handles for theme-color), so this scans whole <meta> tags rather
// than assuming attribute order.
function ogImage(html) {
  const re = /<meta\b[^>]*>/gi;
  let m;
  while ((m = re.exec(html))) {
    const tag = m[0];
    const prop = attrValue(tag, 'property') || attrValue(tag, 'name');
    if (prop && /^og:image$/i.test(prop)) {
      const content = attrValue(tag, 'content');
      if (content) return content;
    }
  }
  return null;
}
function iconHref(html) {
  const re = /<link\b[^>]*>/gi;
  let m;
  while ((m = re.exec(html))) {
    const tag = m[0];
    const rel = attrValue(tag, 'rel');
    if (rel && /(^|\s)(shortcut icon|icon|apple-touch-icon)(\s|$)/i.test(rel)) {
      const href = attrValue(tag, 'href');
      if (href) return href;
    }
  }
  return null;
}
function absUrl(href, base) {
  // `new URL(null, base)` doesn't throw — it coerces to the literal string
  // "null" and happily resolves to `${base}/null`. Guard explicitly rather
  // than relying on the try/catch, since that failure mode is silent, not
  // an exception.
  if (!href || typeof href !== 'string') return null;
  try {
    return new URL(href, base).toString();
  } catch {
    return null;
  }
}
// Real fetch of the brand's own site for a logo/hero image: og:image first
// (usually a proper hero-quality asset), favicon/apple-touch-icon as a
// smaller-but-real fallback. Returns { logoUrl, site } — `site` is the
// domain that actually answered, so callers can link the logo to a
// confirmed-reachable URL instead of only ever guessing one. Bounded to a
// hard overall timeout (not per-request) so an unreachable/slow brand site
// can never meaningfully delay a /generate response.
async function fetchBrandLogo(brandName, fetchImpl = fetch) {
  const run = async () => {
    // Tier 1: Google's favicon service, probed per candidate domain. A 200
    // simultaneously confirms the domain is real (Google indexed it) and
    // hands back a crisp square icon that fits a logo slot — where og:image
    // is routinely a 1200x630 social banner that renders squashed. Crucially
    // this works for brands whose own sites bot-wall the direct fetch below
    // (Google's CDN never blocks us), which was the single biggest cause of
    // placeholder logos in real pitches.
    for (const url of candidateDomains(brandName)) {
      try {
        const probe = googleFaviconUrl(url);
        const r = await safeFetch(probe, 3000, fetchImpl);
        if (r.ok) {
          // og:image from the brand's own site is still worth one attempt as
          // a HERO image (not the logo) — callers may use it later; failure
          // here must not cost the already-won logo.
          let heroUrl = null;
          try {
            const site = await safeFetch(url, 3000, fetchImpl);
            if (site.ok) heroUrl = absUrl(ogImage(await site.text()), url);
          } catch { /* hero is a bonus, never a blocker */ }
          return { logoUrl: probe, site: url, heroUrl };
        }
      } catch {
        // Google unreachable (offline dev) — fall through to the direct scrape.
      }
    }
    // Tier 2: the original direct scrape — domains Google hasn't indexed but
    // that do answer us directly (staging sites, very new brands).
    for (const url of candidateDomains(brandName)) {
      try {
        const r = await safeFetch(url, 4000, fetchImpl);
        if (!r.ok) continue;
        const html = await r.text();
        const og = ogImage(html);
        if (og) {
          const abs = absUrl(og, url);
          if (abs) return { logoUrl: abs, site: url, heroUrl: abs };
        }
        const icon = iconHref(html);
        if (icon) {
          const abs = absUrl(icon, url);
          if (abs) return { logoUrl: abs, site: url, heroUrl: null };
        }
      } catch {
        // blocked / DNS failure / timeout — try the next candidate, then fall through
      }
    }
    return null;
  };
  return withTimeout(run, 6000);
}
// Public entry point mirroring resolveBrandColor's shape: never throws,
// returns null (not an error) when no real logo could be found so the
// caller's placeholder stays the true last resort, never the first choice.
async function resolveBrandLogo({ brandName, fetchImpl } = {}) {
  if (!String(brandName || '').trim()) return null;
  return fetchBrandLogo(brandName, fetchImpl);
}

// ---- main ---------------------------------------------------------------
// Resolves { primary, accent, source } for a brand name, honouring a user hex
// override first. `source` is one of: override | library | fetched | hash.
async function resolveBrandColor({ brandName, hexOverride } = {}) {
  const override = hexNorm(hexOverride);
  if (override) return { primary: override, accent: null, source: 'override' };

  const lib = libGet(brandName);
  if (lib) return { primary: lib.primary, accent: lib.accent, source: 'library' };

  const fetched = await fetchBrandColor(brandName);
  if (fetched) return { primary: fetched, accent: null, source: 'fetched' };

  return { primary: hashColor(brandName || 'brand'), accent: null, source: 'hash' };
}

function libVertical(brandName) {
  const lib = libGet(brandName);
  return lib ? lib.vertical : null;
}

module.exports = {
  resolveBrandColor, libGet, libVertical, hashColor, BRAND_LIBRARY,
  resolveBrandLogo, fetchBrandLogo, ogImage, iconHref, absUrl,
  // Exported so server/brand-research.js reuses the SAME candidate list —
  // these two modules had drifted (research still tried only .com, which is
  // why groww.in-style brands starved their LLM call on dead-domain timeouts).
  candidateDomains, googleFaviconUrl,
};
