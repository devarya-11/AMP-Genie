// POST /slate — thin HTTP shell over the shared slate pipeline
// (server/slate-core.js), which owns the whole fan-out: module ordering,
// per-module createBuild calls, the persisted slate record, and the response
// shape. Only runtime concerns live here: env bridging, the Worker validator,
// KV bindings, and waitUntil for the history writes.

import slateCoreMod from '../server/slate-core.js';
import buildPipelineMod from '../server/build-pipeline.js';
import { validate } from './_lib/validator.js';
import { appendHistory } from './_lib/history.js';
import { applyEnv } from './_lib/env.js';
import { json, readJson } from './_lib/http.js';

const { createSlate } = slateCoreMod;
const { buildHistoryEntry } = buildPipelineMod;

export async function onRequestPost({ request, env, waitUntil }) {
  applyEnv(env); // provider API keys reach brief-content/llm-providers via process.env
  try {
    const b = await readJson(request);
    const { builds, response } = await createSlate(b, { validate, kv: env.HISTORY });
    // Slate builds land in the legacy Recent-builds panel too. ONE combined
    // promise, appending sequentially inside it: appendHistory is a
    // read-modify-write of a single KV key (see _lib/history.js), so n
    // parallel appends would race and drop entries. Oldest first because
    // appendHistory unshifts — the panel (newest-first) ends up showing the
    // builds in slate order, same as the Express route.
    const write = (async () => {
      for (const build of builds.slice().reverse()) {
        await appendHistory(env.HISTORY, buildHistoryEntry(build));
      }
    })();
    if (waitUntil) waitUntil(write); else await write;
    return json(response);
  } catch (e) {
    return json({ error: e.message }, 400);
  }
}
