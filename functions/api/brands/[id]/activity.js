// GET /api/brands/:id/activity — the brand's newest-first activity feed
// (capped at 50). Thin shell over server/pitch-api.js.

import { getPitchApi } from '../../../_lib/pitch.js';
import { json } from '../../../_lib/http.js';

export async function onRequestGet({ params, env }) {
  const out = await getPitchApi(env).brandActivityH({ brandId: params.id });
  return json(out.json, out.status);
}
