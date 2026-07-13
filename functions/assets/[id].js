// GET /assets/:id — resolve one uploaded image; DELETE — remove it.
// Wire-identical to the Express routes in server/index.js.
//
// GET: the Supabase row is the source of truth for "this asset exists". A
// supabase:-keyed asset 302s to its permanent public CDN URL (the same URL
// emails embed directly); a kv:-keyed one (no-Supabase dev fallback) streams
// its bytes with immutable caching — ids are random and bytes never change
// under an id, so a year-long cache is safe.
//
// DELETE removes bytes best-effort, then the row; idempotent by intent.

import assetStoreMod from '../../server/asset-store.js';
import { getGenie } from '../_lib/genie.js';
import { json } from '../_lib/http.js';

const { isAssetId, getAssetBytes, delAssetBytes } = assetStoreMod;

export async function onRequestGet({ params, env }) {
  const id = String(params.id || '');
  if (!isAssetId(id)) return json({ error: 'asset not found' }, 404);

  const { repo, storage } = getGenie(env);
  if (!repo) return json({ error: 'database not configured' }, 503);
  const row = await repo.getAsset(id);
  if (!row) return json({ error: 'asset not found' }, 404);

  const key = String(row.storage_key || '');
  if (key.startsWith('supabase:') && storage) {
    return new Response(null, {
      status: 302,
      headers: { Location: storage.publicUrl(key.slice('supabase:'.length)) },
    });
  }

  const stored = await getAssetBytes(env.HISTORY, id);
  if (!stored) return json({ error: 'asset bytes missing' }, 404);
  return new Response(stored.bytes, {
    headers: {
      'content-type': stored.mime,
      'cache-control': 'public, max-age=31536000, immutable',
      'content-disposition': 'inline',
    },
  });
}

export async function onRequestDelete({ params, env }) {
  const id = String(params.id || '');
  if (!isAssetId(id)) return json({ error: 'asset not found' }, 404);

  const { repo, storage } = getGenie(env);
  if (!repo) return json({ error: 'database not configured' }, 503);
  const row = await repo.getAsset(id);
  if (!row) return json({ error: 'no such asset' }, 404);

  const key = String(row.storage_key || '');
  if (key.startsWith('supabase:') && storage) await storage.delObject(key.slice('supabase:'.length));
  else await delAssetBytes(env.HISTORY, id);
  await repo.deleteAsset(id);
  return json({ ok: true });
}
