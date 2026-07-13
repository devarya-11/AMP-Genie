// Genie 2.0 shared runtime wiring for Pages Functions: ONE place that turns
// env bindings/secrets into the repo (Supabase system of record), the asset
// storage backend, and the pool-aware LLM provider list — mirroring the same
// trio in server/index.js so the two runtimes cannot drift on how they reach
// the shared database.
//
// Workers isolates persist module scope between requests on a warm isolate,
// so the repo/storage handles are memoized per (url, key) — cheap, and the
// key-pool cache inside key-pool.js keeps its own 60s TTL.

import repoSupabaseMod from '../../server/repo-supabase.js';
import assetStoreMod from '../../server/asset-store.js';
import keyPoolMod from '../../server/key-pool.js';

const { createSupabaseRepo } = repoSupabaseMod;
const { createSupabaseStorage } = assetStoreMod;
const { getMergedProviders } = keyPoolMod;

let cached = { sig: null, repo: null, storage: null };

export function getGenie(env) {
  const url = env.SUPABASE_URL || '';
  const secretKey = env.SUPABASE_SECRET_KEY || '';
  const sig = url + '|' + secretKey.slice(-6);
  if (cached.sig !== sig) {
    cached = {
      sig,
      repo: createSupabaseRepo({ url, secretKey }),
      storage: createSupabaseStorage({ url, secretKey, bucket: 'brand-assets' }),
    };
  }
  return cached;
}

// Pool-aware provider descriptors, or undefined so the engines keep their own
// env-key detection when no keys are pasted (same contract as server/index.js
// llmProviders()).
export async function llmProviders(env) {
  const { repo } = getGenie(env);
  if (!repo) return undefined;
  try {
    const merged = await getMergedProviders(repo, []);
    return merged.length ? merged : undefined;
  } catch {
    return undefined;
  }
}
