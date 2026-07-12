// GET /versions/:id — the tweak lineage of a build family, keyed by the
// family's ROOT build id (a fresh build's own id; any tweak's rootId).
// Newest-first summaries ({ id, ts, tweakPrompt, moduleId }), never full
// records — the client fetches /build/:id for the one it wants.

import tweakEngineMod from '../../server/tweak-engine.js';
import { json } from '../_lib/http.js';

const { readVersions } = tweakEngineMod;

export async function onRequestGet({ params, env }) {
  return json({ items: await readVersions(env.HISTORY, params.id) });
}
