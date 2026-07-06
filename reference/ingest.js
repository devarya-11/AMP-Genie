'use strict';

// ============================================================================
// reference/ingest.js — Phase 1 disk ingestion adapter.
//
// Scans corpus/{brand}/{uuid}.html and (re)builds corpus/index.jsonl, one row
// per captured email: { uuid, brand, date, subject, body_path, fetched_at }.
//
// Design guarantees (spec acceptance #1):
//   • Idempotent  — running twice yields the same index (stable sort by uuid).
//   • Resumable   — purely derives state from disk; no external cursor.
//   • Dedup by UUID — a uuid seen under two paths is recorded once (first wins).
//
// Source-independent: rows come from whatever is on disk, whether captured by
// reference/crawl.js (which also writes {uuid}.meta.json sidecars) or dropped in
// by hand. When a sidecar is absent we derive uuid from the filename and brand
// from the parent directory, and best-effort read date/subject from the HTML.
// ============================================================================

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const CORPUS_DIR = path.join(__dirname, '..', 'corpus');
const INDEX_PATH = path.join(CORPUS_DIR, 'index.jsonl');
const UUID_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

function relPath(p) { return path.relative(path.join(__dirname, '..'), p).split(path.sep).join('/'); }

// best-effort metadata from an email body when no sidecar exists
function metaFromHtml(html) {
  const h1 = (html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || [])[1] || '';
  const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '';
  const subject = (h1 || title).replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim() || null;
  const dateM = html.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  return { subject, date: dateM ? dateM[1] : null };
}

async function* walkHtml(dir) {
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); }
  catch { return; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { yield* walkHtml(full); }
    else if (e.isFile() && e.name.toLowerCase().endsWith('.html')) { yield full; }
  }
}

async function ingest({ corpusDir = CORPUS_DIR, quiet = false } = {}) {
  const log = (...a) => { if (!quiet) console.log(...a); };
  await fsp.mkdir(corpusDir, { recursive: true });

  const rows = new Map(); // uuid → row (dedup by uuid, first wins)
  let scanned = 0, sampleSkipped = 0;

  for await (const file of walkHtml(corpusDir)) {
    const base = path.basename(file);
    const m = base.match(UUID_RE);
    const uuid = m ? m[1].toLowerCase() : null;
    // files without a uuid name (e.g. README assets) are ignored
    if (!uuid) continue;
    scanned++;
    if (rows.has(uuid)) continue; // dedup

    const brand = path.basename(path.dirname(file));
    // sidecar written by the crawler, if present
    let side = null;
    const sidecar = file.replace(/\.html$/i, '.meta.json');
    if (fs.existsSync(sidecar)) {
      try { side = JSON.parse(await fsp.readFile(sidecar, 'utf8')); } catch { side = null; }
    }
    let date = side && side.date || null;
    let subject = side && side.subject || null;
    if (date == null || subject == null) {
      try {
        const html = await fsp.readFile(file, 'utf8');
        // a clearly-labelled synthetic placeholder still ingests fine, but we
        // note it so downstream profiles can flag "not real corpus yet".
        if (/SYNTHETIC PLACEHOLDER/i.test(html.slice(0, 400))) sampleSkipped++;
        const mm = metaFromHtml(html);
        if (date == null) date = mm.date;
        if (subject == null) subject = mm.subject;
      } catch { /* unreadable — keep nulls */ }
    }
    rows.set(uuid, {
      uuid,
      brand: (side && side.brand) || brand || 'unknown',
      date: date || null,
      subject: subject || null,
      body_path: relPath(file),
      fetched_at: (side && side.fetched_at) || null,
      source: (side && side.source) || 'disk',
    });
  }

  // stable order → idempotent file
  const sorted = [...rows.values()].sort((a, b) => a.uuid.localeCompare(b.uuid));
  const out = sorted.map((r) => JSON.stringify(r)).join('\n') + (sorted.length ? '\n' : '');
  await fsp.writeFile(INDEX_PATH, out, 'utf8');

  log(`ingest: ${sorted.length} email(s) indexed from ${scanned} html file(s) → ${relPath(INDEX_PATH)}`);
  if (sampleSkipped) log(`  note: ${sampleSkipped} file(s) are synthetic placeholders (replace with real Trove captures for production profiles).`);
  return { count: sorted.length, indexPath: INDEX_PATH, rows: sorted };
}

// read index.jsonl back into an array (used by Phase 2+)
async function readIndex({ indexPath = INDEX_PATH } = {}) {
  let txt;
  try { txt = await fsp.readFile(indexPath, 'utf8'); } catch { return []; }
  return txt.split(/\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

if (require.main === module) {
  ingest().catch((e) => { console.error(e); process.exit(1); });
}

module.exports = { ingest, readIndex, CORPUS_DIR, INDEX_PATH };
