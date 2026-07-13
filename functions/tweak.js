// POST /tweak — thin HTTP shell over the prompt-to-tweak engine
// (server/tweak-engine.js), which owns the whole flow: edit-plan proposal
// (LLM or deterministic), allowlist revalidation, the gated rebuild through
// createBuild, and the version-lineage bookkeeping. Only runtime concerns
// live here: env bridging, the Worker validator, KV bindings, and waitUntil
// for the history write.

import tweakEngineMod from '../server/tweak-engine.js';
import buildPipelineMod from '../server/build-pipeline.js';
import { validate } from './_lib/validator.js';
import { appendHistory } from './_lib/history.js';
import { applyEnv } from './_lib/env.js';
import { json, readJson } from './_lib/http.js';
import { llmProviders } from './_lib/genie.js';

const { applyTweak } = tweakEngineMod;
const { buildHistoryEntry } = buildPipelineMod;

export async function onRequestPost({ request, env, waitUntil }) {
  applyEnv(env); // provider API keys reach tweak-engine/llm-providers via process.env
  try {
    const b = await readJson(request);
    const result = await applyTweak({
      buildId: b.buildId,
      prompt: typeof b.prompt === 'string' ? b.prompt : '',
      author: typeof b.author === 'string' ? b.author.slice(0, 60) : null,
      kv: env.HISTORY,
    }, { validate, providers: await llmProviders(env) });
    if (result.ok) {
      // The tweaked build lands in the legacy Recent-builds panel too,
      // without blocking the response (history is a review aid; a write
      // failure must never fail the tweak) — exactly like /generate.
      const write = appendHistory(env.HISTORY, buildHistoryEntry(result.build));
      if (waitUntil) waitUntil(write); else await write;
    }
    return json(result, result.ok ? 200 : 400);
  } catch (e) {
    return json({ error: e.message }, 400);
  }
}
