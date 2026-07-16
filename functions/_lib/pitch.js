// Genie 2.0 pitch-workspace wiring for Pages Functions: ONE place that turns
// env bindings into a ready createPitchApi handler set, mirroring the trio in
// functions/_lib/genie.js (repo/storage/providers) plus the Worker validator
// and the HISTORY KV. Every functions/api/** shell calls getPitchApi(env) and
// nothing else, so the shells stay pure parsers.
//
// Memoized per isolate like genie.js: getGenie's own (url, key) cache decides
// when the repo/storage pair changes identity, and the api is rebuilt only
// when that pair — or the HISTORY binding — changes. On a warm isolate this
// is one object for the isolate's whole life.

import pitchApiMod from '../../server/pitch-api.js';
import { validate } from './validator.js';
import { getGenie, llmProviders } from './genie.js';

const { createPitchApi } = pitchApiMod;

let cached = { genie: null, kv: null, r2: null, api: null };

export function getPitchApi(env) {
  const genie = getGenie(env);
  if (!cached.api || cached.genie !== genie || cached.kv !== env.HISTORY || cached.r2 !== env.UPLOADS) {
    cached = {
      genie,
      kv: env.HISTORY,
      r2: env.UPLOADS,
      api: createPitchApi({
        repo: genie.repo,
        storage: genie.storage,
        kv: env.HISTORY,
        // R2 bucket for uploaded brand-picture bytes; absent in local dev,
        // where uploadBrandImageH falls back to the KV byte store. Named UPLOADS
        // because 'ASSETS' is a reserved binding name in Cloudflare Pages.
        r2: env.UPLOADS,
        validate,
        llmProviders: () => llmProviders(env),
      }),
    };
  }
  return cached.api;
}
