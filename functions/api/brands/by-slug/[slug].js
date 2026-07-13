// GET /api/brands/by-slug/:slug — brand workspace lookup by slug (the shape
// share links and the wizard use before an id is known). Thin shell over
// server/pitch-api.js.

import { getPitchApi } from '../../../_lib/pitch.js';
import { json } from '../../../_lib/http.js';

export async function onRequestGet({ params, env }) {
  const out = await getPitchApi(env).getBrandBySlugH({ slug: params.slug });
  return json(out.json, out.status);
}
