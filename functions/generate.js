// POST /generate — thin HTTP shell over the shared build pipeline
// (server/build-pipeline.js), which owns the whole flow: brand kit/colour/
// logo resolution, keyword routing, optional LLM brief composition,
// generate() + real validation, fallback parts, and the persisted build
// record. Only runtime concerns live here: env bridging, the Worker
// validator, KV bindings, and waitUntil for the history write.

import buildPipelineMod from '../server/build-pipeline.js';
import { validate } from './_lib/validator.js';
import { appendHistory } from './_lib/history.js';
import { applyEnv } from './_lib/env.js';
import { json, readJson } from './_lib/http.js';

const { createBuild, buildHistoryEntry } = buildPipelineMod;

export async function onRequestPost({ request, env, waitUntil }) {
  applyEnv(env); // provider API keys reach brief-content/llm-providers via process.env
  try {
    const b = await readJson(request);
    const { response, build } = await createBuild(b, {
      validate,
      kv: env.HISTORY,
      author: typeof b.author === 'string' ? b.author.slice(0, 60) : null,
    });
    // Persist to KV without blocking the response (history is a review aid; a
    // write failure must never fail the build).
    const write = appendHistory(env.HISTORY, buildHistoryEntry(build));
    if (waitUntil) waitUntil(write); else await write;
    return json(response);
  } catch (e) {
    return json({ error: e.message }, 400);
  }
}
