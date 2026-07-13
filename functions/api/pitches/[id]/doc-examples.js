// POST /api/pitches/:id/doc-examples — save a NEW block-email doc example into
// the pitch (validate + render + persist, plus a KV share record). The doc
// model + share-record bridge live in server/pitch-api.js's createDocExampleH.
// Thin shell only.

import { getPitchApi } from '../../../_lib/pitch.js';
import { applyEnv } from '../../../_lib/env.js';
import { json, readJson } from '../../../_lib/http.js';

export async function onRequestPost({ request, params, env }) {
  applyEnv(env);
  const b = await readJson(request);
  const out = await getPitchApi(env).createDocExampleH({
    pitchId: params.id,
    title: b.title,
    doc: b.doc,
    author: b.author,
  });
  return json(out.json, out.status);
}
