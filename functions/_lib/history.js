// Cloudflare KV replacement for the Node server's file-based build history
// (server/history.js). Same contract: a single newest-first array, capped at
// MAX_ENTRIES, best-effort — a KV failure must never fail the /generate
// request that triggered the write.
//
// The KV namespace is bound as `HISTORY` (see wrangler.toml) and threaded in
// from the Pages Function's context.env, rather than reached through a module
// global, so this stays a pure function of its inputs.
//
// Note: read-modify-write of a single key isn't atomic across concurrent
// writers, and KV is eventually consistent. That's acceptable here — history is
// a single-user review aid, not a system of record — and matches the semantics
// the file-based version already had.

const KEY = 'history';
export const MAX_ENTRIES = 200;

export async function readHistory(kv) {
  if (!kv) return [];
  try {
    const parsed = await kv.get(KEY, 'json');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function appendHistory(kv, entry) {
  if (!kv) return [];
  const list = await readHistory(kv);
  list.unshift(entry);
  if (list.length > MAX_ENTRIES) list.length = MAX_ENTRIES;
  try {
    await kv.put(KEY, JSON.stringify(list));
  } catch (e) {
    console.error('[history] failed to persist build:', e && e.message);
  }
  return list;
}

// "" / whitespace-only counts as "no brief given" (null), distinct from a real
// (if short) brief. Identical to the Node version — the server never trusts the
// client to have trimmed correctly.
export function normalizeBrief(raw) {
  const trimmed = String(raw || '').trim();
  return trimmed ? trimmed : null;
}
