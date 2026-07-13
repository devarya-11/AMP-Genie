// POST /api/examples/:id/tweak — prompt-to-tweak against the example's
// linked build; an accepted rebuild lands as a new example row with
// parent/root lineage. Thin shell over server/pitch-api.js.

import { getPitchApi } from '../../../_lib/pitch.js';
import { applyEnv } from '../../../_lib/env.js';
import { json, readJson } from '../../../_lib/http.js';

export async function onRequestPost({ request, params, env }) {
  applyEnv(env); // provider API keys reach the tweak engine via process.env
  const b = await readJson(request);
  const out = await getPitchApi(env).tweakExampleH({
    id: params.id, prompt: b.prompt, author: b.author,
  });
  return json(out.json, out.status);
}
