// GET /api/brands/:id — the full brand workspace view (row + parsed dossier,
// products, contacts, assets with resolved URLs, pitches). Thin shell over
// server/pitch-api.js.

import { getPitchApi } from '../../../_lib/pitch.js';
import { json } from '../../../_lib/http.js';

export async function onRequestGet({ params, env }) {
  const out = await getPitchApi(env).getBrandH({ id: params.id });
  return json(out.json, out.status);
}
