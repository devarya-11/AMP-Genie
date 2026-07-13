// GET /api/examples/:id — one example in full (amp_html included) plus its
// version chain, oldest first. Thin shell over server/pitch-api.js.

import { getPitchApi } from '../../../_lib/pitch.js';
import { json } from '../../../_lib/http.js';

export async function onRequestGet({ params, env }) {
  const out = await getPitchApi(env).getExampleH({ id: params.id });
  return json(out.json, out.status);
}
