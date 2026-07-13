// POST /api/pitches/:id/examples — generate a real AMP example into the
// pitch through the shared build pipeline (the brands-row bridge lives in
// server/pitch-api.js's createExampleH). Thin shell only.

import { getPitchApi } from '../../../_lib/pitch.js';
import { applyEnv } from '../../../_lib/env.js';
import { json, readJson } from '../../../_lib/http.js';

export async function onRequestPost({ request, params, env }) {
  applyEnv(env); // provider API keys reach the copy engines via process.env
  const b = await readJson(request);
  const out = await getPitchApi(env).createExampleH({
    pitchId: params.id,
    title: b.title,
    moduleId: b.moduleId,
    brief: b.brief,
    contentPlan: b.contentPlan,
    author: b.author,
  });
  return json(out.json, out.status);
}
