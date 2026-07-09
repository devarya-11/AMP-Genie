// GET /history — past builds, newest first (KV-backed). Read-only review aid.

import { readHistory, MAX_ENTRIES } from './_lib/history.js';
import { json } from './_lib/http.js';

export async function onRequestGet({ env }) {
  return json({ items: await readHistory(env.HISTORY), max: MAX_ENTRIES });
}
