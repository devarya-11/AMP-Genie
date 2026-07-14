// Genie 2.0 shared runtime wiring for Pages Functions: ONE place that turns
// env bindings/secrets into the repo (system of record), the asset storage
// backend, and the pool-aware LLM provider list — mirroring the same trio in
// server/index.js so the two runtimes cannot drift on how they reach the
// shared database.
//
// Two backends, same bound-repo shape (a handler never learns which is live):
//   - Supabase (PostgREST) when SUPABASE_URL + SUPABASE_SECRET_KEY are set —
//     the shared team database, visible in its dashboard.
//   - Cloudflare D1 (env.DB) otherwise — SQLite over HTTP, entirely inside
//     Cloudflare. The Workers runtime cannot use node:sqlite, so D1 is the
//     in-account fallback that server/index.js fills with a local .db file.
//     No Supabase Storage on this path, so asset bytes take the KV route in
//     functions/assets.js (storage === null).
//
// Memoisation: Supabase handles are pure fetch wrappers, safe to cache across
// requests on a warm isolate keyed by (url, key). A D1 binding is NOT — Workers
// ties a binding's I/O to the request that produced it, so the D1 repo is
// rebuilt per request (createD1Db only allocates closures, no network at
// construction). key-pool.js keeps its own 60s TTL either way.

import repoSupabaseMod from '../../server/repo-supabase.js';
import assetStoreMod from '../../server/asset-store.js';
import keyPoolMod from '../../server/key-pool.js';
import dbMod from '../../server/db.js';

const { createSupabaseRepo, bindLocalRepo } = repoSupabaseMod;
const { createSupabaseStorage } = assetStoreMod;
const { getMergedProviders } = keyPoolMod;
const { createD1Db } = dbMod;

let cachedSupabase = { sig: null, repo: null, storage: null };

export function getGenie(env) {
  const url = env.SUPABASE_URL || '';
  const secretKey = env.SUPABASE_SECRET_KEY || '';
  // Preferred backend: Supabase (shared team DB). Memoised by (url, key-tail).
  if (url && secretKey) {
    const sig = url + '|' + secretKey.slice(-6);
    if (cachedSupabase.sig !== sig) {
      cachedSupabase = {
        sig,
        repo: createSupabaseRepo({ url, secretKey }),
        storage: createSupabaseStorage({ url, secretKey, bucket: 'brand-assets' }),
      };
    }
    return cachedSupabase;
  }
  // Fallback backend: Cloudflare D1. Same repo shape via bindLocalRepo, so every
  // handler stays backend-blind; storage is null so assets use the KV byte store.
  if (env.DB) {
    return { repo: bindLocalRepo(createD1Db(env.DB)), storage: null };
  }
  // Neither configured — handlers surface "database not configured" (503).
  return { repo: null, storage: null };
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
