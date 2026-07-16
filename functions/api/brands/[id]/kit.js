// POST /api/brands/:id/kit — update a brand's kit fields (sanitizeKitPatch
// rules) and/or replace its product rows and/or its curated image library.
// Thin shell over server/pitch-api.js.

import { getPitchApi } from '../../../_lib/pitch.js';
import { json, readJson } from '../../../_lib/http.js';

export async function onRequestPost({ request, params, env }) {
  const b = await readJson(request);
  const out = await getPitchApi(env).updateBrandKitH({
    id: params.id, patch: b.patch, products: b.products, images: b.images, author: b.author,
  });
  return json(out.json, out.status);
}
