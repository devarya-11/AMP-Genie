// POST /api/docs/render — the block-email editor's live-preview endpoint:
// validate + render a doc to one AMP4EMAIL document and report the verdict.
// Pure (no persistence, no id). Thin shell over server/pitch-api.js.

import { getPitchApi } from '../../_lib/pitch.js';
import { applyEnv } from '../../_lib/env.js';
import { json, readJson } from '../../_lib/http.js';

export async function onRequestPost({ request, env }) {
  applyEnv(env);
  const b = await readJson(request);
  const out = await getPitchApi(env).renderDocH({ doc: b.doc !== undefined ? b.doc : b });
  return json(out.json, out.status);
}
