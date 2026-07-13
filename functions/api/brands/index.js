// GET/POST /api/brands — the Brands rail (list) and the wizard's research
// step (create: dossier + colour + logo -> brands row). Thin ESM shell over
// server/pitch-api.js: parse -> handler -> { status, json }, so the Express
// twin (server/pitch-routes-express.js) stays wire-identical by construction.

import { getPitchApi } from '../../_lib/pitch.js';
import { applyEnv } from '../../_lib/env.js';
import { json, readJson } from '../../_lib/http.js';

export async function onRequestGet({ env }) {
  const out = await getPitchApi(env).listBrandsH();
  return json(out.json, out.status);
}

export async function onRequestPost({ request, env }) {
  applyEnv(env); // provider API keys reach the research engines via process.env
  const b = await readJson(request);
  const out = await getPitchApi(env).createBrandH({
    name: b.name, notes: b.notes, author: b.author,
  });
  return json(out.json, out.status);
}
