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

// "" / whitespace-only counts as "no brief given" (null), distinct from a
// real (if short) brief — kept separate from the UI's own trimming so the
// server never trusts a client to have done this correctly.
function normalizeBrief(raw) {
  const trimmed = String(raw || '').trim();
  return trimmed ? trimmed : null;
}

module.exports = { readHistory, appendHistory, normalizeBrief, HISTORY_FILE, MAX_ENTRIES };
