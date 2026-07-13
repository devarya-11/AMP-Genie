// GET/POST /settings/keys — the LLM key pool (Genie 2.0). Wire-identical to
// the Express routes in server/index.js: GET returns MASKED keys only (a
// stored key never travels back to a browser), POST appends one sanitized
// entry and busts the pool cache so a freshly pasted key is live immediately.

import keyPoolMod from '../../server/key-pool.js';
import { getGenie } from '../_lib/genie.js';
import { json, readJson } from '../_lib/http.js';

const {
  sanitizePoolEntry, maskKey, resetPoolCache, PROVIDER_ORDER, POOL_SETTINGS_KEY,
} = keyPoolMod;

export async function onRequestGet({ env }) {
  const { repo } = getGenie(env);
  if (!repo) return json({ error: 'database not configured' }, 503);
  const pool = (await repo.getSetting(POOL_SETTINGS_KEY)) || [];
  return json({
    keys: (Array.isArray(pool) ? pool : []).map((e) => ({
      id: e.id, provider: e.provider, key: maskKey(e.key), label: e.label || null, model: e.model || null,
      addedBy: e.addedBy || null, addedAt: e.addedAt || null,
    })),
    providers: PROVIDER_ORDER,
  });
}

export async function onRequestPost({ request, env }) {
  const body = await readJson(request);
  const entry = sanitizePoolEntry({
    provider: body.provider, key: body.key, label: body.label, model: body.model, addedBy: body.author,
  });
  if (!entry) {
    return json({ error: 'invalid key entry (provider must be one of: ' + PROVIDER_ORDER.join(', ') + ')' }, 400);
  }
  const { repo } = getGenie(env);
  if (!repo) return json({ error: 'database not configured' }, 503);
  const pool = (await repo.getSetting(POOL_SETTINGS_KEY)) || [];
  pool.push(entry);
  if (!(await repo.putSetting(POOL_SETTINGS_KEY, pool))) {
    return json({ error: 'could not persist the key' }, 500);
  }
  resetPoolCache();
  repo.logActivity({ actor: entry.addedBy, verb: 'key-added', detail: entry.provider + ' ' + maskKey(entry.key) });
  return json({ ok: true, id: entry.id });
}
