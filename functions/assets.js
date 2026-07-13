// POST /assets — desktop image upload for a brand (Genie 2.0). Body:
// { brandId, kind?, filename, mime, dataBase64, author? }. Wire-identical to
// the Express route in server/index.js: bytes land in the public Supabase
// Storage bucket (permanent CDN URL, email-safe — no serving route, no auth),
// the metadata row lands in the Supabase assets table, and the KV byte-store
// remains only as the no-Supabase dev fallback.

import assetStoreMod from '../server/asset-store.js';
import storeMod from '../server/store.js';
import { getGenie } from './_lib/genie.js';
import { json, readJson } from './_lib/http.js';

const { validateUpload, putAssetBytes, b64ToBytes } = assetStoreMod;
const { newId } = storeMod;

export async function onRequestPost({ request, env }) {
  const body = await readJson(request);
  const vetted = validateUpload(body);
  if (!vetted.ok) return json({ error: vetted.error }, 400);

  const { repo, storage } = getGenie(env);
  if (!repo) return json({ error: 'database not configured' }, 503);
  const brand = await repo.getBrandById(body.brandId);
  if (!brand) return json({ error: 'unknown brandId' }, 400);

  const id = newId();
  let storageKey;
  let url;
  // Prefer Supabase (permanent public CDN URL); fall back to the KV byte store
  // (served via /assets/:id) if Supabase is unreachable, rather than hard-failing.
  if (storage) {
    const objPath = storage.objectPath(brand.slug, id, vetted.filename);
    url = await storage.putObject(objPath, b64ToBytes(body.dataBase64), vetted.mime);
    if (url) storageKey = 'supabase:' + objPath;
  }
  if (!url) {
    if (!(await putAssetBytes(env.HISTORY, id, { base64: body.dataBase64, mime: vetted.mime }))) {
      return json({ error: 'storage upload failed' }, 502);
    }
    storageKey = 'kv:' + id;
    url = '/assets/' + id;
  }

  const row = await repo.insertAsset({
    brandId: brand.id,
    kind: body.kind,
    filename: vetted.filename,
    mime: vetted.mime,
    size: vetted.size,
    storageKey,
    uploadedBy: typeof body.author === 'string' ? body.author : null,
  });
  if (!row) {
    if (storage && storageKey.startsWith('supabase:')) await storage.delObject(storageKey.slice('supabase:'.length));
    return json({ error: 'could not record the asset' }, 500);
  }
  repo.logActivity({
    actor: typeof body.author === 'string' ? body.author : null,
    brandId: brand.id,
    verb: 'asset-uploaded',
    detail: vetted.filename,
  });
  return json({ ok: true, asset: { id: row.id, url, filename: row.filename, mime: row.mime, size: row.size } });
}
