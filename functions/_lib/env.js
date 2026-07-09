// Bridges Cloudflare's per-request `env` (bindings + secrets) onto the Node
// `process.env` that the reused server modules read from.
//
// server/brief-content.js and server/llm-providers.js were written for Node and
// read provider API keys via process.env.* (evaluated per-call inside
// defaultProviders / call*). Under nodejs_compat, `process.env` exists but is
// not auto-populated from Worker secrets on this compatibility date, so we copy
// the string-valued entries across at the start of each request. Non-string
// bindings (KV namespaces, etc.) are objects and are skipped — those are
// threaded explicitly to the modules that need them.
//
// Idempotent: safe to call on every request. Only string values are copied so a
// KV/DO/R2 binding can never be stringified into an env var.

export function applyEnv(env) {
  if (!env || typeof env !== 'object') return;
  if (!globalThis.process) globalThis.process = { env: {} };
  if (!globalThis.process.env) globalThis.process.env = {};
  for (const key of Object.keys(env)) {
    const val = env[key];
    if (typeof val === 'string') globalThis.process.env[key] = val;
  }
}
