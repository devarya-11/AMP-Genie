// POST /api/brands/:id/contacts — add a contact to a brand. The contact may
// arrive wrapped ({ contact: {...}, author }) or bare ({ name, role, ... }) —
// same tolerance as the Express twin. Thin shell over server/pitch-api.js.

import { getPitchApi } from '../../../_lib/pitch.js';
import { json, readJson } from '../../../_lib/http.js';

export async function onRequestPost({ request, params, env }) {
  const b = await readJson(request);
  const out = await getPitchApi(env).addContactH({
    brandId: params.id,
    contact: b.contact !== undefined ? b.contact : b,
    author: b.author,
  });
  return json(out.json, out.status);
}
