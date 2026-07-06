'use strict';

// ============================================================================
// reference/crawl.js — Phase 1 network adapter: a POLITE, incremental Trove
// crawler.  Implements the spec's crawling contract verbatim:
//
//   • Before crawling: fetch and respect /robots.txt (and require an explicit
//     human ToS opt-in via TROVE_CRAWL_OK=1 — only the operator can affirm the
//     site Terms allow this).
//   • Use a real User-Agent.
//   • 1–2s delay between requests; concurrency <= 3.
//   • Exponential backoff on 429 / Cloudflare challenge.
//   • Cache by UUID (skip already-captured emails) → incremental + resumable.
//   • Store raw HTML for reference ONLY — never redistributed; only distilled,
//     brand-agnostic patterns (Phase 2+) persist into the generator.
//
// HARD ETHICAL LINE: Trove is Cloudflare-fronted. If a Cloudflare *challenge* is
// returned, this crawler BACKS OFF and ultimately aborts with guidance. It does
// NOT attempt to solve, evade, or bypass bot-detection — doing so is prohibited.
// A real browser that passes the challenge as a human is a legitimate channel;
// this datacenter-side script is not, and it says so honestly.
//
// Run:  TROVE_CRAWL_OK=1 node reference/crawl.js --max 40 --delay 1500
// (No-op + explanation if the opt-in is absent or robots/Cloudflare disallow.)
// ============================================================================

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const BASE = 'https://trove.livingemails.com';
const CORPUS_DIR = path.join(__dirname, '..', 'corpus');
// A real, current browser UA (the spec asks for a real User-Agent, not a bot/
// empty/python one). Override with TROVE_UA if you crawl from your own browser
// session's UA.
const DEFAULT_UA = process.env.TROVE_UA ||
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

// ---- tiny robots.txt parser (group for our UA, else *) ---------------------
function parseRobots(txt, ua) {
  const lines = String(txt || '').split(/\r?\n/);
  const groups = []; let cur = null;
  for (let raw of lines) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const field = m[1].toLowerCase(); const val = m[2].trim();
    if (field === 'user-agent') {
      if (!cur || cur._hasRules) { cur = { agents: [], allow: [], disallow: [], _hasRules: false }; groups.push(cur); }
      cur.agents.push(val.toLowerCase());
    } else if (cur && field === 'disallow') { cur.disallow.push(val); cur._hasRules = true; }
    else if (cur && field === 'allow') { cur.allow.push(val); cur._hasRules = true; }
  }
  const uaLow = String(ua).toLowerCase();
  const matchToken = (tok) => tok === '*' || uaLow.includes(tok);
  let group = groups.find((g) => g.agents.some((a) => a !== '*' && matchToken(a)))
    || groups.find((g) => g.agents.includes('*'));
  const rules = group || { allow: [], disallow: [] };
  return {
    isAllowed(pathname) {
      // longest-match-wins between allow and disallow (RFC-ish, good enough)
      const test = (patterns) => patterns
        .filter((p) => p !== '' && pathname.startsWith(p))
        .reduce((best, p) => Math.max(best, p.length), -1);
      const dis = test(rules.disallow);
      const alw = test(rules.allow);
      if (dis === -1) return true;
      return alw >= dis; // an equally/longer allow overrides the disallow
    },
    raw: group,
  };
}

// ---- Cloudflare challenge / block detection (we back off, never bypass) -----
function looksLikeChallenge(status, body) {
  if (status === 429) return true;
  if (status === 503 || status === 403) {
    return /just a moment|cf-chl|challenge-platform|attention required|cloudflare|verify you are human|__cf_bm/i.test(String(body || ''));
  }
  return false;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchText(url, { ua, timeout = 15000 } = {}) {
  const r = await fetch(url, {
    headers: {
      'User-Agent': ua,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(timeout),
  });
  const body = await r.text();
  return { status: r.status, ok: r.ok, body };
}

// Single polite GET with exponential backoff on transient/challenge responses.
// Throws ChallengeError if Cloudflare keeps challenging — the caller aborts.
class ChallengeError extends Error { constructor(m) { super(m); this.name = 'ChallengeError'; } }

async function politeGet(url, { ua, delayMs, maxRetries = 4 }) {
  let attempt = 0; let backoff = Math.max(delayMs, 1000);
  for (;;) {
    let res;
    try { res = await fetchText(url, { ua }); }
    catch (e) { // network/timeout — retry with backoff
      if (attempt++ >= maxRetries) throw e;
      await sleep(backoff); backoff *= 2; continue;
    }
    if (looksLikeChallenge(res.status, res.body)) {
      if (attempt++ >= maxRetries) {
        throw new ChallengeError(
          `Cloudflare is challenging automated access to ${url} (status ${res.status}). ` +
          `This crawler will NOT bypass bot-detection. Run from an environment that passes ` +
          `the challenge legitimately (e.g. a real browser session), or drop captured ` +
          `*.html into corpus/{brand}/ and run the ingester.`);
      }
      await sleep(backoff); backoff *= 2; continue;
    }
    return res;
  }
}

// ---- link/metadata extractors (regex-level; jsdom-free for the crawl) -------
function emailUuids(html) {
  const out = new Set();
  const re = /\/email\/([0-9a-f-]{36})\b/gi; let m;
  while ((m = re.exec(html))) out.add(m[1].toLowerCase());
  return [...out];
}
function brandSlugs(html) {
  const out = new Set();
  const re = /\/brand\/([a-z0-9][a-z0-9._-]*)\b/gi; let m;
  while ((m = re.exec(html))) out.add(m[1].toLowerCase());
  return [...out];
}
function emailMeta(html) {
  const h1 = (html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || [])[1] || '';
  const subject = h1.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim() || null;
  const dateM = html.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  const brandM = html.match(/\/brand\/([a-z0-9._-]+)/i);
  return { subject, date: dateM ? dateM[1] : null, brand: brandM ? brandM[1].toLowerCase() : null };
}

function safeName(s) { return String(s || 'unknown').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'unknown'; }

// Where a captured email lives. Cache key = uuid (resumable/idempotent).
function bodyPathFor(brand, uuid) { return path.join(CORPUS_DIR, safeName(brand), `${uuid}.html`); }
function metaPathFor(brand, uuid) { return path.join(CORPUS_DIR, safeName(brand), `${uuid}.meta.json`); }
function alreadyCaptured(brand, uuid) { return fs.existsSync(bodyPathFor(brand, uuid)); }

async function captureEmail(uuid, { ua, delayMs }) {
  // 1) metadata page → brand/date/subject
  let meta = { brand: null, date: null, subject: null };
  try {
    const m = await politeGet(`${BASE}/email/${uuid}`, { ua, delayMs });
    meta = emailMeta(m.body);
  } catch (e) { if (e instanceof ChallengeError) throw e; /* metadata optional */ }
  await sleep(delayMs);
  const brand = meta.brand || 'unknown';
  if (alreadyCaptured(brand, uuid)) return { uuid, brand, skipped: true };
  // 2) raw body payload — the reference HTML (stored, never redistributed)
  const b = await politeGet(`${BASE}/email/${uuid}/body`, { ua, delayMs });
  const dir = path.join(CORPUS_DIR, safeName(brand));
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(bodyPathFor(brand, uuid), b.body, 'utf8');
  await fsp.writeFile(metaPathFor(brand, uuid), JSON.stringify({
    uuid, brand, date: meta.date, subject: meta.subject,
    source: 'trove', fetched_at: new Date().toISOString(),
  }, null, 2), 'utf8');
  return { uuid, brand, skipped: false };
}

// bounded-concurrency map (concurrency <= 3 per spec)
async function pool(items, limit, worker) {
  const results = []; let i = 0; let active = 0;
  return await new Promise((resolve, reject) => {
    const next = () => {
      if (i >= items.length && active === 0) return resolve(results);
      while (active < limit && i < items.length) {
        const idx = i++; active++;
        Promise.resolve(worker(items[idx], idx))
          .then((r) => { results[idx] = r; })
          .catch((e) => { results[idx] = { error: String(e && e.message || e) }; if (e instanceof ChallengeError) reject(e); })
          .finally(() => { active--; next(); });
      }
    };
    next();
  });
}

async function crawl(opts = {}) {
  const ua = opts.ua || DEFAULT_UA;
  const delayMs = Math.min(Math.max(opts.delayMs || 1500, 1000), 2000); // clamp to 1–2s
  const concurrency = Math.min(Math.max(opts.concurrency || 2, 1), 3);   // clamp to <=3
  const max = opts.max || 25;

  // ---- gate 1: explicit human ToS opt-in ----------------------------------
  if (process.env.TROVE_CRAWL_OK !== '1') {
    console.log([
      'Trove crawl is GATED. No request was made.',
      'Set TROVE_CRAWL_OK=1 only after you have reviewed Trove’s Terms of Service',
      'and confirmed that automated access of the volume you intend is permitted.',
      'The corpus is for reference only and source emails are never redistributed.',
      '',
      'Example:  TROVE_CRAWL_OK=1 node reference/crawl.js --max 40 --delay 1500',
    ].join('\n'));
    return { gated: true };
  }

  // ---- gate 2: robots.txt --------------------------------------------------
  let robots;
  try {
    const r = await fetchText(`${BASE}/robots.txt`, { ua });
    robots = r.status === 200 ? parseRobots(r.body, ua) : parseRobots('', ua); // 404 → no restrictions stated
    console.log(`robots.txt: HTTP ${r.status}`);
  } catch (e) { console.error('Could not fetch robots.txt — aborting out of caution:', e.message); return { error: 'robots_unreachable' }; }
  for (const p of ['/', '/email/x', '/email/x/body', '/brand/x']) {
    if (!robots.isAllowed(p)) { console.error(`robots.txt disallows ${p} for this UA — aborting.`); return { error: 'robots_disallow', path: p }; }
  }

  await fsp.mkdir(CORPUS_DIR, { recursive: true });

  // ---- discover roster → uuids (incremental: stop at `max` NEW captures) ---
  let roster;
  try { roster = await politeGet(`${BASE}/?sort=active`, { ua, delayMs }); }
  catch (e) {
    if (e instanceof ChallengeError) { console.error('\n' + e.message + '\n'); return { error: 'cloudflare_challenge' }; }
    throw e;
  }
  await sleep(delayMs);

  let uuids = emailUuids(roster.body);
  const slugs = brandSlugs(roster.body);
  console.log(`roster: ${uuids.length} email links, ${slugs.length} brand links on the active page.`);

  // If the roster page paginates brands more than emails, walk a few brand pages
  // to gather email uuids — still polite, still capped.
  for (const slug of slugs) {
    if (uuids.length >= max * 3) break;
    try {
      const bp = await politeGet(`${BASE}/brand/${slug}`, { ua, delayMs });
      uuids.push(...emailUuids(bp.body));
      await sleep(delayMs);
    } catch (e) { if (e instanceof ChallengeError) { console.error('\n' + e.message + '\n'); return { error: 'cloudflare_challenge' }; } }
  }
  uuids = [...new Set(uuids)].filter((u) => UUID_RE.test(u));

  // skip already-captured (resumable). We can only check the cache once we know
  // the brand, so we over-select then captureEmail() short-circuits known ones.
  const targets = uuids.slice(0, max);
  console.log(`capturing up to ${targets.length} emails (concurrency ${concurrency}, delay ${delayMs}ms)…`);

  let captured = 0, skipped = 0, failed = 0;
  try {
    const res = await pool(targets, concurrency, async (uuid) => {
      const r = await captureEmail(uuid, { ua, delayMs });
      await sleep(delayMs); // inter-request politeness even within the pool
      return r;
    });
    for (const r of res) { if (!r) continue; if (r.error) failed++; else if (r.skipped) skipped++; else captured++; }
  } catch (e) {
    if (e instanceof ChallengeError) { console.error('\n' + e.message + '\n'); return { error: 'cloudflare_challenge', captured }; }
    throw e;
  }
  console.log(`done. captured=${captured} skipped(cached)=${skipped} failed=${failed}`);
  console.log('Next: node reference/ingest.js   (build corpus/index.jsonl)');
  return { captured, skipped, failed };
}

// ---- CLI -------------------------------------------------------------------
function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--max') o.max = parseInt(argv[++i], 10);
    else if (argv[i] === '--delay') o.delayMs = parseInt(argv[++i], 10);
    else if (argv[i] === '--concurrency') o.concurrency = parseInt(argv[++i], 10);
  }
  return o;
}
if (require.main === module) {
  crawl(parseArgs(process.argv.slice(2))).then((r) => {
    if (r && (r.error || r.gated)) process.exit(r.gated ? 0 : 2);
  }).catch((e) => { console.error(e); process.exit(1); });
}

module.exports = { crawl, parseRobots, looksLikeChallenge, emailUuids, brandSlugs, emailMeta, bodyPathFor, safeName, ChallengeError, BASE, CORPUS_DIR };
