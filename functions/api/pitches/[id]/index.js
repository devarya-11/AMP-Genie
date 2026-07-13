// GET/PATCH /api/pitches/:id — one pitch with its brand + latest examples
// per version chain (GET), or a title/goal/brief/status update (PATCH; the
// patch may arrive wrapped or bare, same as the Express twin). Thin shells
// over server/pitch-api.js.

import { getPitchApi } from '../../../_lib/pitch.js';
import { json, readJson } from '../../../_lib/http.js';

export async function onRequestGet({ params, env }) {
  const out = await getPitchApi(env).getPitchH({ id: params.id });
  return json(out.json, out.status);
}

export async function onRequestPatch({ request, params, env }) {
  const b = await readJson(request);
  const out = await getPitchApi(env).updatePitchH({
    id: params.id,
    patch: b.patch !== undefined ? b.patch : b,
  });
  return json(out.json, out.status);
}
