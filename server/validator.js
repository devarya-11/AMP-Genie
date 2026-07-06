'use strict';

// Wraps the official amphtml-validator in AMP4EMAIL mode.
// This is the source of truth — no regex approximations.

const path = require('path');
const fs = require('fs');
const amphtmlValidator = require('amphtml-validator');

// The validator JS/wasm is vendored locally (server/vendor/validator_wasm.js) so
// validation never depends on a live CDN fetch at request time. If the local
// copy is somehow missing we fall back to the CDN, but the local path is the
// normal case and keeps /build resilient offline.
const LOCAL_VALIDATOR = path.join(__dirname, 'vendor', 'validator_wasm.js');

let instancePromise = null;
function getValidator() {
  if (!instancePromise) {
    const src = fs.existsSync(LOCAL_VALIDATOR) ? LOCAL_VALIDATOR : undefined;
    instancePromise = amphtmlValidator.getInstance(src)
      // Never cache a rejection: a transient failure must not poison every
      // subsequent build. Reset so the next call can retry.
      .catch((e) => { instancePromise = null; throw e; });
  }
  return instancePromise;
}

async function validate(ampHtml) {
  const validator = await getValidator();
  const result = validator.validateString(ampHtml, 'AMP4EMAIL');
  const errors = result.errors.map((e) => ({
    severity: e.severity, // ERROR / WARNING
    line: e.line,
    col: e.col,
    message: e.message,
    code: e.code,
    spec: e.specUrl || null,
  }));
  const hardErrors = errors.filter((e) => e.severity === 'ERROR');
  return {
    status: hardErrors.length === 0 ? 'PASS' : 'FAIL',
    pass: hardErrors.length === 0,
    errors,
    errorCount: hardErrors.length,
    warningCount: errors.length - hardErrors.length,
  };
}

module.exports = { validate, getValidator };
