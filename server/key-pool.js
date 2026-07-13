'use strict';

// Genie 2.0 — the in-app LLM key POOL. The team pastes any number of API keys
// (multiple providers, multiple keys per provider) into the app; they are
// stored under the repo settings key 'llm_keys' and become an ordered list of
// engine-ready providers that rotates PER KEY on rate limits: one exhausted
// free-tier key cools down alone (10 min) while its siblings — including
// other keys of the SAME provider — keep serving.
//
// Pool entry shape: { id, provider, key, label?, model?, addedBy?, addedAt }
// with provider one of anthropic|gemini|groq|openrouter|cerebras|mistral.
//
// Runtime-agnostic: no fs/path/env reads at module load; the Anthropic SDK is
// required lazily inside a thunk (same pattern as the engines' own
// defaultProviders), so this bundles for Workers via esbuild.
//
// PROVIDER DESCRIPTOR SHAPE — { name, call(prompt, schema, timeoutMs) }, the
// brief-content convention, NOT bare functions. Deliberate: composeContent
// invokes providers as `p.call(prompt, schema, timeoutMs)`, and on a BARE
// function that resolves to Function.prototype.call — i.e. the thunk runs
// with `this = prompt` and its arguments shifted one left. Descriptors are
// safe everywhere:
//   - brief-content  composeContent(brief, ctx, { providers }) — native
//     {name, call} support, fans out to ALL and keeps the best-scored plan.
//   - usecase-engine proposeUseCases(input, { providers }) — its
//     callFirstProvider normalizes a descriptor via first.call.bind(first)
//     and asks only the FIRST provider.
//   - tweak-engine   proposeEditPlan(input, { providers }) — same
//     callFirstProvider convention, FIRST provider only.
//   - brand-research buildDossier(args, { providers }) — currently expects
//     ZERO-ARG thunks (it builds its own prompt internally), so next phase
//     needs a small ADDITIVE change there: when injected[0] is a {name, call}
//     descriptor, wrap it as `() => injected[0].call(buildResearchPrompt(...),
//     DOSSIER_SCHEMA, timeoutMs)` — mirroring callFirstProvider's
//     normalization. Until then routes simply don't pass pool providers to
//     brand-research.
// Engines are NOT modified in this phase; routes will thread
// getMergedProviders(...) through those existing opts.providers seams next.

const {
  callClaude, callGemini, callOpenAICompat, isCoolingDown, cooldown,
} = require('./llm-providers');

const POOL_SETTINGS_KEY = 'llm_keys';

// Preference order — mirrors the engines' env-detection order (best model
// first, then the free tiers), extended with the three new OpenAI-compatible
// hosts. Multiple keys of one provider keep their insertion order.
const PROVIDER_ORDER = ['anthropic', 'gemini', 'groq', 'openrouter', 'cerebras', 'mistral'];

// Per-provider defaults. baseUrl is null where a dedicated caller owns the
// transport (anthropic → callClaude via the SDK, gemini → callGemini); the
// other four are plain OpenAI-compatible chat-completions hosts served by
// callOpenAICompat. model is only a default — a pool entry's own `model`
// wins. The non-anthropic defaults are free-tier models on their hosts.
const PROVIDER_DEFAULTS = {
  anthropic: { baseUrl: null, model: 'claude-haiku-4-5' },
  gemini: { baseUrl: null, model: 'gemini-2.5-flash' },
  groq: { baseUrl: 'https://api.groq.com/openai/v1', model: 'llama-3.1-8b-instant' },
  openrouter: { baseUrl: 'https://openrouter.ai/api/v1', model: 'meta-llama/llama-3.3-70b-instruct:free' },
  cerebras: { baseUrl: 'https://api.cerebras.ai/v1', model: 'llama-3.3-70b' },
  mistral: { baseUrl: 'https://api.mistral.ai/v1', model: 'mistral-small-latest' },
};

const KEY_MIN = 8;
const KEY_MAX = 300;
const MODEL_MAX = 60;
const LABEL_MAX = 40;
const ADDED_BY_MAX = 60;

// Same id discipline as server/store.js: 12 lowercase hex chars cut from
// crypto.randomUUID (a global in Node 18+ AND Workers), validated against the
// same shape ids take everywhere else in the app.
const ID_SHAPE = /^[a-z0-9-]{6,64}$/;
function newId() {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 12);
}

function cleanStr(v, max) {
  return String(v).replace(/[<>]/g, '').trim().slice(0, max);
}

// sanitizePoolEntry(e) -> a storable entry, or null when the row is junk.
// Rules: provider must be on the allowlist (case-insensitive); the key is
// 8..300 chars with no whitespace and no '<'/'>' (an API key never contains
// either — their presence means a paste accident or an injection attempt);
// model/label/addedBy are optional decorations, scrubbed and capped, dropped
// silently when empty after cleaning. id/addedAt are preserved when valid,
// stamped fresh otherwise — so re-sanitizing a stored pool is a no-op.
function sanitizePoolEntry(e) {
  if (!e || typeof e !== 'object' || Array.isArray(e)) return null;
  const provider = typeof e.provider === 'string' ? e.provider.trim().toLowerCase() : '';
  if (!PROVIDER_ORDER.includes(provider)) return null;
  const key = typeof e.key === 'string' ? e.key.trim() : '';
  if (key.length < KEY_MIN || key.length > KEY_MAX) return null;
  if (/[\s<>]/.test(key)) return null;
  const out = {
    id: ID_SHAPE.test(String(e.id || '')) ? String(e.id) : newId(),
    provider,
    key,
    addedAt: Number.isFinite(e.addedAt) ? e.addedAt : Date.now(),
  };
  if (typeof e.model === 'string') {
    const model = cleanStr(e.model, MODEL_MAX);
    if (model) out.model = model;
  }
  if (typeof e.label === 'string') {
    const label = cleanStr(e.label, LABEL_MAX);
    if (label) out.label = label;
  }
  if (typeof e.addedBy === 'string') {
    const addedBy = cleanStr(e.addedBy, ADDED_BY_MAX);
    if (addedBy) out.addedBy = addedBy;
  }
  return out;
}

// What the UI shows instead of a stored key. Always last 4 only — enough to
// tell two keys of the same provider apart, useless to an onlooker.
function maskKey(key) {
  const s = typeof key === 'string' ? key : '';
  return '····' + s.slice(-4);
}

// The cooldown identity of an entry must be STABLE across poolProviders
// calls, or a tripped key would "forget" its cooldown on the next request.
// A stored entry's id is stable; a (should-not-happen) id-less entry falls
// back to provider + key tail, which is equally stable.
function cooldownIdFor(rawId, clean) {
  return ID_SHAPE.test(String(rawId || '')) ? String(rawId) : clean.provider + '-' + clean.key.slice(-4);
}

// One engine-ready descriptor for one pool entry. The per-key cooldown lives
// in llm-providers' shared map under 'pool:<id>': callGemini/callOpenAICompat
// take it as cooldownKey (they return null fast while cooling and trip it
// themselves on looksLikeQuotaExhausted). Anthropic is the exception — the
// SDK path has no status hook and no free-tier quota wall to trip, so its
// thunk only CHECKS the cooldown (nothing sets it) and a failed call is a
// plain null the engines fall through.
function makePoolDescriptor(entry, coolId, fetchImpl) {
  const defaults = PROVIDER_DEFAULTS[entry.provider];
  const model = entry.model || defaults.model;
  const coolKey = 'pool:' + coolId;
  const name = 'pool:' + entry.provider + ':' + entry.key.slice(-4);
  const fetchOpt = fetchImpl ? { fetchImpl } : {};

  if (entry.provider === 'anthropic') {
    let client = null;
    let clientTried = false;
    return {
      name,
      call: async (prompt, schema, timeoutMs) => {
        if (isCoolingDown(coolKey)) return null;
        if (!clientTried) {
          clientTried = true; // one construction attempt per descriptor
          try {
            const Anthropic = require('@anthropic-ai/sdk'); // lazy — Workers-bundle safe
            client = new Anthropic({ apiKey: entry.key });
          } catch (e) {
            console.error('[key-pool] failed to construct Anthropic client:', e && e.message);
          }
        }
        return callClaude({ client, model, prompt, schema, timeoutMs });
      },
    };
  }

  if (entry.provider === 'gemini') {
    return {
      name,
      call: (prompt, schema, timeoutMs) => callGemini({
        apiKey: entry.key, model, prompt, schema, timeoutMs, cooldownKey: coolKey, ...fetchOpt,
      }),
    };
  }

  // groq / openrouter / cerebras / mistral — all OpenAI-compatible.
  return {
    name,
    call: (prompt, schema, timeoutMs) => callOpenAICompat({
      baseUrl: defaults.baseUrl, apiKey: entry.key, model, prompt, schema, timeoutMs,
      cooldownKey: coolKey, ...fetchOpt,
    }),
  };
}

// poolProviders({ pool, purpose, fetchImpl }) -> ordered array of {name, call}
// descriptors (see the header for why descriptors, not bare thunks). Order:
// PROVIDER_ORDER buckets, insertion order within a bucket. Invalid rows are
// skipped, never thrown on. `purpose` ('copy'|'ideation'|'research'|'tweak')
// is accepted but RESERVED — it is the seam where per-purpose model choices
// plug in later without reshaping any call site. fetchImpl is the test seam,
// threaded into every fetch-based call.
function poolProviders({ pool, purpose, fetchImpl } = {}) { // eslint-disable-line no-unused-vars
  const rows = Array.isArray(pool) ? pool : [];
  const buckets = new Map(PROVIDER_ORDER.map((p) => [p, []]));
  for (const raw of rows) {
    const clean = sanitizePoolEntry(raw);
    if (!clean) continue;
    const coolId = cooldownIdFor(raw && raw.id, clean);
    buckets.get(clean.provider).push(makePoolDescriptor(clean, coolId, fetchImpl));
  }
  const out = [];
  for (const provider of PROVIDER_ORDER) out.push(...buckets.get(provider));
  return out;
}

// ---- settings-backed pool with a short cache --------------------------------
// The pool is read on every LLM-tier request; a 60s module-scope TTL cache
// keeps that from being a settings read per call without making a freshly
// pasted key wait more than a minute. Module scope is fine in both runtimes
// (per-isolate on Workers). resetPoolCache() is for tests and for the
// settings-save route, which should bust the cache so a new key is live
// immediately.
const POOL_CACHE_TTL_MS = 60 * 1000;
let poolCache = { at: 0, pool: null };

function resetPoolCache() {
  poolCache = { at: 0, pool: null };
}

// Tolerant settings read. `db` is whatever the repo layer hands us:
//   - { getSetting(key) }        the Genie 2.0 settings API (sync or async)
//   - { get(key, 'json') }       a raw KV-style handle
// A missing db, a throwing read, or junk under the key all mean "no pool" —
// nothing ever throws into the request.
async function loadPool(db) {
  if (!db || typeof db !== 'object') return [];
  try {
    let raw = null;
    if (typeof db.getSetting === 'function') raw = await db.getSetting(POOL_SETTINGS_KEY);
    else if (typeof db.get === 'function') raw = await db.get(POOL_SETTINGS_KEY, 'json');
    if (typeof raw === 'string') {
      try { raw = JSON.parse(raw); } catch { raw = null; }
    }
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

// getMergedProviders(db, envFallbackProviders) -> descriptors for the pasted
// pool FIRST (pool keys are the team's explicit choice), then the env-based
// fallback providers untouched (bare thunks or descriptors — engines accept
// both), so existing ANTHROPIC_API_KEY/GEMINI_API_KEY deployments keep
// working with an empty pool. This is the ONE call routes make next phase
// before threading opts.providers into the engines listed in the header.
async function getMergedProviders(db, envFallbackProviders) {
  const fallback = Array.isArray(envFallbackProviders) ? envFallbackProviders : [];
  const now = Date.now();
  if (!poolCache.pool || now - poolCache.at > POOL_CACHE_TTL_MS) {
    poolCache = { at: now, pool: await loadPool(db) };
  }
  return poolProviders({ pool: poolCache.pool }).concat(fallback);
}

module.exports = {
  POOL_SETTINGS_KEY, PROVIDER_ORDER, PROVIDER_DEFAULTS,
  sanitizePoolEntry, maskKey, poolProviders, getMergedProviders, resetPoolCache,
};
