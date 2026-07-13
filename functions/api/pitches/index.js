// GET/POST /api/pitches — the cross-brand Pitches view (list) and pitch
// creation. Thin shells over server/pitch-api.js.

import { getPitchApi } from '../../_lib/pitch.js';
import { json, readJson } from '../../_lib/http.js';

export async function onRequestGet({ env }) {
  const out = await getPitchApi(env).listPitchesH();
  return json(out.json, out.status);
}

export async function onRequestPost({ request, env }) {
  const b = await readJson(request);
  const out = await getPitchApi(env).createPitchH({
    brandId: b.brandId, title: b.title, goal: b.goal, brief: b.brief, author: b.author,
  });
  return json(out.json, out.status);
}
