'use strict';

// Keyless CC0 image-relevance resolver. Openverse (openverse.org) is
// Creative-Commons image search with REAL relevance ranking, so a query like
// "vitamin c serum" returns an actually-relevant photograph instead of
// loremflickr's blunt all-tags-AND match — which silently serves a grey
// default the moment a query is even slightly specific (the exact bland
// non-image the team kept seeing). We restrict to CC0 + Public Domain Mark
// (license=cc0,pdm), the ONLY license classes that carry no attribution
// obligation and so are safe to drop straight into a commercial marketing
// email with no visible credit line. mature=false keeps results brand-safe.
//
// This is the RELEVANCE FLOOR in the image ladder: better than a random
// vertical stock photo, worse than the brand's OWN og:image or a curated
// asset. It is keyed ONLY on general strings the caller passes — a vertical
// noun, a product's own name, the model's own scene description — never a
// brand literal, so it generalises to any brand in any vertical/use case.
//
// Anonymous (keyless) access is rate-limited; EVERY failure mode — a non-2xx,
// a 429, a network throw, an abort/timeout, zero results, a malformed body, a
// URL that fails the amp-img grammar — resolves to null so the caller falls to
// its own loremflickr floor. NEVER throws.

const OPENVERSE_ENDPOINT = 'https://api.openverse.org/v1/images/';
const DEFAULT_TIMEOUT_MS = 4000;
// CC0 + Public Domain Mark only: no attribution obligation, so a returned
// photo can drop straight into an email with no credit line.
const NO_ATTRIBUTION_LICENSES = 'cc0,pdm';
const UA = 'amp-genie/1.0 (+https://amp-genie.pages.dev)';

// The same https grammar every downstream sanitiser enforces (generate.js and
// doc-ai.js validImgUrl): plain https, no whitespace/quotes/brackets, bounded
// length. A result URL that does not clear this is dropped rather than risk a
// broken or unsafe amp-img src.
const MAX_URL_LEN = 500;
function validImageUrl(s) {
  return typeof s === 'string'
    && s.length > 0
    && s.length <= MAX_URL_LEN
    && /^https:\/\/[^\s"'<>]+$/i.test(s);
}

// Untrusted query text (a scraped product name, the model's scene prose) is
// reduced to a bounded, punctuation-free keyword string before it ever reaches
// the query string — the same defensive shape as brand-research's
// stockImageUrl. An empty result means "nothing to search", handled by callers.
function normalizeQuery(query) {
  return String(query || '')
    .replace(/[^a-z0-9\s]+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

// Resolve ONE real, no-attribution image URL for a keyword query, or null.
// fetchImpl is injected (defaults to the global fetch) exactly like
// brand-research's fetchBrandSite, so callers and the test suite control the
// network. Bounded by AbortSignal.timeout and wrapped so nothing here throws.
async function searchOpenverseImage(args = {}) {
  const {
    query, fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS, mature = false,
  } = args;
  const q = normalizeQuery(query);
  if (!q) return null;
  const url = `${OPENVERSE_ENDPOINT}?q=${encodeURIComponent(q)}`
    + `&license=${encodeURIComponent(NO_ATTRIBUTION_LICENSES)}`
    + `&mature=${mature ? 'true' : 'false'}`
    + '&page_size=1';
  try {
    const res = await fetchImpl(url, {
      headers: { Accept: 'application/json', 'User-Agent': UA },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res || !res.ok) return null;
    const body = await res.json();
    const results = body && Array.isArray(body.results) ? body.results : [];
    for (const item of results) {
      const candidate = item && typeof item.url === 'string' ? item.url : null;
      if (validImageUrl(candidate)) return candidate;
    }
    return null;
  } catch {
    // rate-limit throw, network error, abort, malformed json — the caller's
    // loremflickr floor takes over
    return null;
  }
}

module.exports = { searchOpenverseImage, normalizeQuery, validImageUrl };
