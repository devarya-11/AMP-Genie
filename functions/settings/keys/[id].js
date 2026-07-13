// DELETE /settings/keys/:id — remove one pooled LLM key. Wire-identical to
// the Express route in server/index.js.

import keyPoolMod from '../../../server/key-pool.js';
import { getGenie } from '../../_lib/genie.js';
import { json } from '../../_lib/http.js';

const { resetPoolCache, POOL_SETTINGS_KEY } = keyPoolMod;

export async function onRequestDelete({ params, env }) {
  const { repo } = getGenie(env);
  if (!repo) return json({ error: 'database not configured' }, 503);
  const pool = (await repo.getSetting(POOL_SETTINGS_KEY)) || [];
  const next = (Array.isArray(pool) ? pool : []).filter((e) => e && e.id !== params.id);
  if (next.length === pool.length) return json({ error: 'no such key' }, 404);
  await repo.putSetting(POOL_SETTINGS_KEY, next);
  resetPoolCache();
  return json({ ok: true });
}
