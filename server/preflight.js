'use strict';

// Phase 1.3 — pre-send checks. Cheap, honest, run before a real dispatch:
//   • total message size (Gmail clips a message past ~102 KB, hiding the foot)
//   • image weight (sum of real Content-Length via HEAD; flags heavy payloads)
//   • HTTPS guarantee (every image src must be https for AMP — belt & braces)
//   • an ESTIMATED spam score from a transparent heuristic (clearly labelled —
//     not a real SpamAssassin run, just the obvious triggers a filter dislikes)
//
// Everything here is advisory and explained; nothing blocks the user. The image
// weighing touches the network (HEAD requests), so it degrades gracefully when
// a host omits Content-Length or refuses HEAD.

const GMAIL_CLIP_BYTES = 102 * 1024;        // Gmail clips the message past ~102 KB
const AMP_DOC_LIMIT = 200 * 1024;           // AMP4EMAIL document soft ceiling
const IMG_HEAVY_TOTAL = 1024 * 1024;        // 1 MB of imagery is getting heavy
const IMG_HEAVY_ONE = 300 * 1024;           // a single >300 KB image is flagged

function bytesOf(str) { return Buffer.byteLength(String(str || ''), 'utf8'); }
function kb(n) { return (n / 1024).toFixed(n < 102400 ? 1 : 0) + ' KB'; }

// ---- image URL extraction (from the AMP itself = single source) -------------
function imageUrls(ampHtml) {
  const urls = new Set();
  const re = /<(?:amp-img|img)[^>]+\bsrc="([^"]+)"/gi;
  let m;
  while ((m = re.exec(ampHtml || '')) !== null) urls.add(m[1]);
  return [...urls];
}

// ---- real image weighing (HEAD; fall back to a ranged GET) ------------------
async function weighImage(url) {
  if (typeof fetch !== 'function') return { url, bytes: null, note: 'no fetch' };
  try {
    let r = await fetch(url, { method: 'HEAD', redirect: 'follow' });
    let len = r.headers.get('content-length');
    if (!len || !r.ok) {
      // Some CDNs don't answer HEAD with a length — ask for the first byte.
      r = await fetch(url, { headers: { Range: 'bytes=0-0' }, redirect: 'follow' });
      const cr = r.headers.get('content-range'); // bytes 0-0/12345
      if (cr && /\/(\d+)/.test(cr)) len = cr.match(/\/(\d+)/)[1];
      else len = r.headers.get('content-length');
    }
    return { url, bytes: len ? Number(len) : null };
  } catch (e) {
    return { url, bytes: null, note: e.message };
  }
}

// ---- spam heuristic (transparent, labelled as an estimate) ------------------
const SPAM_WORDS = [
  'free', 'act now', 'click here', 'limited time', 'winner', 'congratulations',
  'guarantee', 'risk-free', 'no obligation', 'cash', 'cheap', 'order now',
  'buy now', 'urgent', 'exclusive deal', '100%', 'lowest price', 'apply now',
];
function estimateSpam({ subject, html, hasUnsubscribe, textLen, imgCount }) {
  const factors = [];
  let score = 0;
  const subj = String(subject || '');
  const body = String(html || '').replace(/<[^>]+>/g, ' '); // strip tags to text
  const hay = (subj + ' ' + body).toLowerCase();

  const hits = SPAM_WORDS.filter((w) => hay.includes(w));
  if (hits.length) { const pts = Math.min(3, hits.length * 0.7); score += pts; factors.push({ pts: +pts.toFixed(1), text: `Spam-trigger phrases: ${hits.slice(0, 5).join(', ')}${hits.length > 5 ? '…' : ''}` }); }

  const excl = (subj.match(/!/g) || []).length;
  if (excl >= 2) { score += 1; factors.push({ pts: 1, text: `Subject has ${excl} exclamation marks` }); }

  const letters = subj.replace(/[^A-Za-z]/g, '');
  const caps = subj.replace(/[^A-Z]/g, '');
  if (letters.length >= 6 && caps.length / letters.length > 0.6) { score += 1.5; factors.push({ pts: 1.5, text: 'Subject is mostly UPPERCASE' }); }

  if (/\$|£|₹|€|\d+% ?off/i.test(subj)) { score += 0.5; factors.push({ pts: 0.5, text: 'Money/discount token in subject' }); }

  if (!hasUnsubscribe) { score += 1.5; factors.push({ pts: 1.5, text: 'No unsubscribe link found (bulk mail needs one)' }); }

  // Image-heavy, text-light mail is a classic spam signal.
  if (imgCount >= 2 && textLen < 120) { score += 1.5; factors.push({ pts: 1.5, text: 'Very little text relative to images' }); }

  score = Math.min(10, Math.round(score * 10) / 10);
  const level = score <= 2 ? 'low' : score <= 4.5 ? 'moderate' : 'high';
  return {
    score, max: 10, level,
    factors: factors.length ? factors : [{ pts: 0, text: 'No common spam triggers detected' }],
    detail: 'Heuristic estimate (transparent rule-of-thumb, not a SpamAssassin score). Lower is better; under ~3 is comfortable.',
  };
}

function level3(ok, warn) { return ok ? 'pass' : warn ? 'warn' : 'fail'; }

async function preflight({ ampHtml = '', htmlFallback = '', subject = '', textFallback = '', assets = [] }) {
  const ampBytes = bytesOf(ampHtml);
  const htmlBytes = bytesOf(htmlFallback);
  const textBytes = bytesOf(textFallback);

  // --- size ---
  const clip = ampBytes > GMAIL_CLIP_BYTES;
  const overDoc = ampBytes > AMP_DOC_LIMIT;
  const sizeStatus = level3(!clip && !overDoc, clip && !overDoc);
  const size = {
    ampBytes, htmlBytes, textBytes,
    status: sizeStatus,
    detail: overDoc
      ? `AMP document is ${kb(ampBytes)} — above the ${kb(AMP_DOC_LIMIT)} AMP4EMAIL ceiling. Trim markup/inline CSS.`
      : clip
        ? `AMP document is ${kb(ampBytes)} — past Gmail's ~${kb(GMAIL_CLIP_BYTES)} clip point, so the footer may be hidden.`
        : `AMP document is ${kb(ampBytes)} — comfortably under Gmail's ~${kb(GMAIL_CLIP_BYTES)} clip point.`,
  };

  // --- images: HTTPS + weight ---
  const urls = imageUrls(ampHtml);
  const nonHttps = urls.filter((u) => !/^https:\/\//i.test(u));
  const weighed = await Promise.all(urls.map(weighImage));
  const known = weighed.filter((w) => typeof w.bytes === 'number');
  const totalImg = known.reduce((s, w) => s + w.bytes, 0);
  const heaviest = known.slice().sort((a, b) => b.bytes - a.bytes)[0] || null;
  const tooHeavyTotal = totalImg > IMG_HEAVY_TOTAL;
  const tooHeavyOne = heaviest && heaviest.bytes > IMG_HEAVY_ONE;
  const imgStatus = nonHttps.length ? 'fail' : (tooHeavyTotal || tooHeavyOne ? 'warn' : 'pass');
  const images = {
    count: urls.length,
    weighed: known.length,
    totalBytes: totalImg,
    heaviest: heaviest ? { url: heaviest.url, bytes: heaviest.bytes } : null,
    nonHttps,
    status: imgStatus,
    detail: nonHttps.length
      ? `${nonHttps.length} image(s) are NOT https — AMP requires https and clients will block them. Re-host before sending.`
      : tooHeavyTotal
        ? `Images total ${kb(totalImg)} across ${urls.length} files — heavy; expect slow loads on mobile. Consider compressing.`
        : tooHeavyOne
          ? `Heaviest image is ${kb(heaviest.bytes)} — consider compressing it.`
          : urls.length
            ? `${urls.length} image(s), ${known.length ? kb(totalImg) + ' total' : 'size unknown'} — all https, weight is fine.`
            : 'No images in the document.',
  };

  // --- spam estimate ---
  const hasUnsub = /unsubscribe/i.test(ampHtml) || /unsubscribe/i.test(htmlFallback) || /unsubscribe/i.test(textFallback);
  const visibleText = String(htmlFallback || ampHtml).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  const spam = estimateSpam({ subject, html: htmlFallback || ampHtml, hasUnsubscribe: hasUnsub, textLen: visibleText.length, imgCount: urls.length });

  // --- asset rights (Phase 1.4): warn before a client send when unclear ---
  const review = (assets || []).filter((a) => a && a.rights === 'review');
  const missingAlt = (assets || []).filter((a) => a && a.slot !== 'logo' && !(a.alt && String(a.alt).trim()));
  const rights = {
    total: (assets || []).length,
    review: review.map((a) => ({ slot: a.slot, source: a.source, license: a.license, note: a.licenseNote })),
    status: review.length ? 'warn' : 'pass',
    detail: review.length
      ? `${review.length} of ${(assets || []).length} assets are open-web/third-party — confirm licensing before sending to customers.`
      : (assets || []).length
        ? 'All assets are first-party, user-provided or generated — rights are clear.'
        : 'No asset rights to review.',
  };

  // --- overall verdict ---
  const parts = [size.status, images.status, rights.status, spam.level === 'high' ? 'warn' : 'pass'];
  const worst = parts.includes('fail') ? 'fail' : parts.includes('warn') ? 'warn' : 'pass';
  const summary = worst === 'fail'
    ? 'Blocking issue found — fix the failing check before sending.'
    : worst === 'warn'
      ? 'Sendable, with advisories worth a look.'
      : 'All pre-send checks look good.';

  return { ok: true, status: worst, summary, size, images, rights, spam };
}

module.exports = { preflight, imageUrls, estimateSpam };
