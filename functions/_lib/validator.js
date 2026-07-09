// Worker-native AMP4EMAIL validator. Runs the real amphtml validator wasm on
// the Cloudflare runtime — same source of truth as the Node server/validator.js,
// no regex approximations. See validator-hook.js for the wasm-compilation
// mechanism (precompiled module + emscripten instantiateWasm hook).
//
// Import order matters and is intentional: validator-hook.js sets the
// instantiateWasm hook and MUST evaluate before validator-glue.js (which,
// during emscripten startup, reads that hook to instantiate the module). ESM
// evaluates imports depth-first in source order, so hook-before-glue holds.

import './validator-hook.js'; // sets globalThis.__ampInstantiateWasm (+ imports the wasm)
import './validator-glue.js'; // defines globalThis.amp.validator

let readyPromise = null;

// The glue's init() (when present) resolves once the wasm instance is live.
// Cached so we init once. Never cache a rejection — a transient failure must
// not poison every later validate() call.
function ensureReady() {
  if (!readyPromise) {
    const v = globalThis.amp && globalThis.amp.validator;
    if (!v) throw new Error('amp validator glue did not expose globalThis.amp.validator');
    readyPromise = Promise.resolve(v.init ? v.init() : undefined)
      .catch((e) => { readyPromise = null; throw e; });
  }
  return readyPromise;
}

// Mirrors the shape returned by server/validator.js so the frontend and
// dispatch gate are unchanged: { status, pass, errors[], errorCount, warningCount }.
export async function validate(ampHtml) {
  await ensureReady();
  const v = globalThis.amp.validator;
  const result = v.validateString(ampHtml || '', 'AMP4EMAIL');

  const errors = (result.errors || []).map((e) => ({
    severity: e.severity,
    line: e.line,
    col: e.col,
    message: v.renderErrorMessage(e),
    code: e.code,
    spec: e.specUrl || null,
  }));

  // result.status is authoritative for pass/fail (PASS when only warnings).
  const pass = result.status === 'PASS';
  let errorCount = errors.filter((e) => String(e.severity) === 'ERROR').length;
  // Guard against an unexpected severity enum shape: never report 0 hard
  // errors on a failing result.
  if (!pass && errorCount === 0) errorCount = errors.length;
  const warningCount = errors.length - errorCount;

  return {
    status: pass ? 'PASS' : 'FAIL',
    pass,
    errors,
    errorCount,
    warningCount,
  };
}
