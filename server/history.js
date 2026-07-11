'use strict';

// Minimal file-based history of past /generate builds, so a campaign brief
// (and the rest of a build's metadata) can be reviewed later instead of
// vanishing the moment the page reloads. Intentionally simple: a single
// JSON array on disk, newest-first, capped at MAX_ENTRIES. No database, no
// migrations — this is a review aid for a local/dev tool, not a system of
// record. A failed read/write here must never fail the /generate request
// that triggered it.

const fs = require('fs');
const path = require('path');

const HISTORY_FILE = path.join(__dirname, '..', '.history.json');
const MAX_ENTRIES = 200;

function readHistory() {
  try {
    const raw = fs.readFileSync(HISTORY_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    // missing file, corrupt JSON, permissions error — treat as empty history
    return [];
  }
}

function appendHistory(entry) {
  const list = readHistory();
  list.unshift(entry);
  if (list.length > MAX_ENTRIES) list.length = MAX_ENTRIES;
  try {
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(list, null, 2));
  } catch (e) {
    console.error('[history] failed to persist build:', e.message);
  }
  return list;
}

// normalizeBrief moved to server/store.js (runtime-agnostic) because this
// module touches __dirname/fs at load time and must never be pulled into the
// Workers bundle just for a pure string helper. Re-exported here so existing
// Node callers keep working.
const { normalizeBrief } = require('./store');

module.exports = { readHistory, appendHistory, normalizeBrief, HISTORY_FILE, MAX_ENTRIES };
