// POST /api/docs/custom-amp — adapt pasted HTML/AMP into a validator-clean
// AMP4EMAIL body fragment for a custom block (LLM rewrite + validate/retry).
// Thin shell over server/pitch-api.js, wire-identical to the Express route.

import { getPitchApi } from '../../_lib/pitch.js';
import { applyEnv } from '../../_lib/env.js';
import { json, readJson } from '../../_lib/http.js';

export async function onRequestPost({ request, env }) {
  applyEnv(env);
  const b = await readJson(request);
  const out = await getPitchApi(env).customAmpH({ raw: b.raw });
  return json(out.json, out.status);
}
