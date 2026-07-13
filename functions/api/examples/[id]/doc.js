// PATCH /api/examples/:id/doc — save an EDIT to a block-email doc example in
// place (re-render + re-validate + persist, refresh the share record). An edit
// is the same example, not a new version. Thin shell over server/pitch-api.js.

import { getPitchApi } from '../../../_lib/pitch.js';
import { applyEnv } from '../../../_lib/env.js';
import { json, readJson } from '../../../_lib/http.js';

export async function onRequestPatch({ request, params, env }) {
  applyEnv(env);
  const b = await readJson(request);
  const out = await getPitchApi(env).updateDocExampleH({
    id: params.id, doc: b.doc, author: b.author,
  });
  return json(out.json, out.status);
}
