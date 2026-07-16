// POST /api/brands/:id/images/upload — a real file upload into the brand's
// curated picture library. Body: { dataBase64, mime, filename, kind?, alt?,
// author? }. Thin shell over server/pitch-api.js's uploadBrandImageH: the bytes
// go to R2 (env.UPLOADS) or the KV fallback, and the picture appends to
// brand_images at source='upload' — the SAME top rung of the image ladder a
// pasted URL enters. Wire-identical to the Express route in pitch-routes-express.js.

import { getPitchApi } from '../../../../_lib/pitch.js';
import { json, readJson } from '../../../../_lib/http.js';

export async function onRequestPost({ request, params, env }) {
  const b = await readJson(request);
  const out = await getPitchApi(env).uploadBrandImageH({
    id: params.id,
    dataBase64: b.dataBase64, mime: b.mime, filename: b.filename,
    kind: b.kind, alt: b.alt, author: b.author,
    // The byte-store fallback URL (/brand-images/:id) must be absolute — an
    // email cannot embed a relative src, and cleanBrandImageRow drops one.
    origin: new URL(request.url).origin,
  });
  return json(out.json, out.status);
}
