// GET /brand-images/:id — stream an uploaded curated picture's bytes from the
// byte store. Tries R2 (env.UPLOADS) first, then the KV byte store
// (env.HISTORY) so bytes written before R2 was bound still resolve. No DB row
// is needed: the id keys the store directly (this is the fallback for uploads
// that did NOT get a permanent Supabase CDN URL). Wire-identical to the Express
// route in server/index.js. Bytes never change under an id, so the year-long
// immutable cache is safe — the same stance as GET /assets/:id.

import assetStoreMod from '../../server/asset-store.js';
import { json } from '../_lib/http.js';

const { isAssetId, getAssetBytes } = assetStoreMod;

export async function onRequestGet({ params, env }) {
  const id = String(params.id || '');
  if (!isAssetId(id)) return json({ error: 'not found' }, 404);

  const stored = (await getAssetBytes(env.UPLOADS, id)) || (await getAssetBytes(env.HISTORY, id));
  if (!stored) return json({ error: 'not found' }, 404);

  return new Response(stored.bytes, {
    headers: {
      'content-type': stored.mime,
      'cache-control': 'public, max-age=31536000, immutable',
      'content-disposition': 'inline',
    },
  });
}
