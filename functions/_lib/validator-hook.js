// Emscripten instantiateWasm hook — MUST evaluate before the validator glue.
//
// Workers/Pages forbid compiling WebAssembly from raw bytes at any time
// ("Wasm code generation disallowed by embedder"). The only sanctioned path is
// a module compiled at deploy time via a static `import` of the .wasm file
// (wrangler turns it into a WebAssembly.Module), then instantiated with
// `WebAssembly.instantiate(module, imports)` — instantiating an already
// compiled Module is allowed.
//
// The vendored glue (validator-glue.js) was build-time patched so emscripten's
// `Module.instantiateWasm` reads `globalThis.__ampInstantiateWasm`. Providing
// that hook makes emscripten SKIP its own byte-compile path and use the
// precompiled module we hand back here.
//
// This lives in its own module (imported ABOVE the glue import in validator.js)
// so ESM's depth-first, source-order evaluation guarantees the hook is set
// before the glue is ever evaluated — independent of any bundler hoisting.

import WASM_MODULE from './validator.wasm'; // deploy-time compiled WebAssembly.Module

globalThis.__ampInstantiateWasm = function (imports, receiveInstance) {
  WebAssembly.instantiate(WASM_MODULE, imports).then(function (instance) {
    receiveInstance(instance, WASM_MODULE);
  });
  return {}; // signal async instantiation; emscripten waits for the callback
};
