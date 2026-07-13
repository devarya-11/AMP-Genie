// PATCH/DELETE /api/contacts/:id — edit or remove one contact. PATCH accepts
// the contact wrapped ({ contact: {...} }) or bare, same as the Express twin.
// Thin shell over server/pitch-api.js.

import { getPitchApi } from '../../_lib/pitch.js';
import { json, readJson } from '../../_lib/http.js';

export async function onRequestPatch({ request, params, env }) {
  const b = await readJson(request);
  const out = await getPitchApi(env).updateContactH({
    id: params.id,
    contact: b.contact !== undefined ? b.contact : b,
  });
  return json(out.json, out.status);
}

export async function onRequestDelete({ params, env }) {
  const out = await getPitchApi(env).deleteContactH({ id: params.id });
  return json(out.json, out.status);
}
