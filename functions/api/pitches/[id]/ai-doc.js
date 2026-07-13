// POST /api/pitches/:id/ai-doc — AI-draft a starter block-email doc for the
// editor to open (NOT saved — the editor edits then saves via doc-examples).
// The FIRST configured LLM provider drafts it; a keyless/offline deploy gets a
// deterministic fallback doc. The generation lives in server/doc-ai.js via
// server/pitch-api.js's aiDocH. Thin shell only.

import { getPitchApi } from '../../../_lib/pitch.js';
import { applyEnv } from '../../../_lib/env.js';
import { json, readJson } from '../../../_lib/http.js';

export async function onRequestPost({ request, params, env }) {
  applyEnv(env); // provider API keys reach doc-ai via process.env
  const b = await readJson(request);
  const out = await getPitchApi(env).aiDocH({
    pitchId: params.id, brief: b.brief, useCase: b.useCase, author: b.author,
  });
  return json(out.json, out.status);
}
