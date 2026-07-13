// GET /api/examples/:id/as-doc — resolve ANY example to an editable block doc
// for the GENIE 2.0 editor: a doc example returns its stored doc; a legacy
// interactive example is synthesized into a one-block interactive doc; anything
// module-less is a 400. A SEPARATE file from examples/[id]/doc.js (which is the
// PATCH save-edit) so the two routes never clobber each other. Thin shell over
// server/pitch-api.js's exampleToDocH.

import { getPitchApi } from '../../../_lib/pitch.js';
import { applyEnv } from '../../../_lib/env.js';
import { json } from '../../../_lib/http.js';

export async function onRequestGet({ params, env }) {
  applyEnv(env);
  const out = await getPitchApi(env).exampleToDocH({ id: params.id });
  return json(out.json, out.status);
}
