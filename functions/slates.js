// GET /slates — newest-first slate summaries for the Pitches view. Read-only
// over the single slates:index key (see server/store.js); a team review aid,
// not a system of record, same stance as /history.

import storeMod from '../server/store.js';
import { json } from './_lib/http.js';

const { readSlateIndex } = storeMod;

export async function onRequestGet({ env }) {
  return json({ items: await readSlateIndex(env.HISTORY) });
}
