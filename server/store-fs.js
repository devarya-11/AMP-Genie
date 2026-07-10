'use strict';

// Filesystem shim over the Cloudflare-KV subset server/store.js expects
// ({ get(key, type), put(key, value) }), so the Express dev server persists
// builds/slates/brand kits through the exact same code paths the Pages
// Functions run against the real HISTORY namespace. One file per key under
// dirPath, same best-effort voice as server/history.js: a failed read is
// null, a failed write is logged and swallowed — never an error thrown into
// the request that triggered it. Node-only (fs/path) by design; the Workers
// side never imports this module.

const fs = require('fs');
const path = require('path');

// Suggested default location; the caller passes the actual path so tests and
// deployments can point the shim anywhere (this repo git-ignores '.data/').
const DATA_DIR = '.data';

// 'build:abc' -> 'build__abc.json'. ':' is illegal in Windows filenames and
// path-separator-ambiguous on macOS, and anything outside [a-z0-9_-] could
// escape dirPath — both are mapped to safe characters before touching disk.
// ':' becomes '__' (not '_') so 'build:x' and a hypothetical 'build_x' stay
// distinct files.
function keyToFilename(key) {
  return String(key).replace(/:/g, '__').replace(/[^a-z0-9_-]/gi, '_') + '.json';
}

function createFsKv(dirPath) {
  return {
    // `type` mirrors the KV get signature; only 'json' (all store.js uses)
    // gets parsed — anything else returns the raw text, as KV would.
    async get(key, type) {
      try {
        const raw = fs.readFileSync(path.join(dirPath, keyToFilename(key)), 'utf8');
        return type === 'json' ? JSON.parse(raw) : raw;
      } catch {
        // missing file, corrupt JSON, permissions error — same null a KV miss gives
        return null;
      }
    },
    async put(key, value) {
      try {
        // Lazy mkdir on every write: {recursive:true} is a no-op when the
        // directory exists and self-heals if it was deleted mid-session.
        fs.mkdirSync(dirPath, { recursive: true });
        fs.writeFileSync(path.join(dirPath, keyToFilename(key)), String(value));
      } catch (e) {
        console.error('[store-fs] failed to persist ' + key + ':', e.message);
      }
    },
  };
}

module.exports = { createFsKv, DATA_DIR };
