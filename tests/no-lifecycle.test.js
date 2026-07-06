'use strict';

// §1 acceptance — the Day 1/3/5 lifecycle/sequence system is gone for good.
//
// One Rub yields exactly one complete, brand-accurate email. This suite is a
// regression guard so the lifecycle concept cannot quietly creep back into the
// server, the UI, or the build output.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

test('the sequence/lifecycle server module is deleted', () => {
  assert.ok(!fs.existsSync(path.join(ROOT, 'server', 'sequence.js')), 'server/sequence.js must be removed');
});

test('the server has no lifecycle wiring', () => {
  const idx = read('server/index.js');
  assert.ok(!/require\(['"]\.\/sequence['"]\)/.test(idx), 'index.js must not require ./sequence');
  assert.ok(!/generate-sequence/.test(idx), 'index.js must not expose a /generate-sequence route');
  assert.ok(!/\blifecycles?\s*:/.test(idx), '/api/meta must not advertise lifecycles');
});

test('the UI has no lifecycle or timeline controls', () => {
  const html = read('web/index.html');
  assert.ok(!/id=["']lifecycle["']/.test(html), 'index.html must not contain a #lifecycle control');
  assert.ok(!/id=["']timeline["']/.test(html), 'index.html must not contain a #timeline element');

  const app = read('web/app.js');
  assert.ok(!/generate-sequence/.test(app), 'app.js must not call /generate-sequence');
  assert.ok(!/getElementById\(['"]lifecycle['"]\)|\$\(['"]lifecycle['"]\)/.test(app), 'app.js must not read a #lifecycle control');
});

test('a production build carries no day/lifecycle metadata', async () => {
  const { resolveAssets } = require('../server/assets');
  const { buildProduction } = require('../server/build');
  const resolved = await resolveAssets({ brandName: 'Zomato', need: { logo: true, products: 3 } });
  const built = buildProduction({ moduleId: 'reveal', resolved });

  for (const k of ['day', 'lifecycle', 'lifecycleName', 'role', 'arc']) {
    assert.ok(!(k in built), `build result must not carry a "${k}" field`);
    if (built.context) assert.ok(!(k in built.context), `context must not carry a "${k}" field`);
  }
  assert.ok(!/\bDay\s*[1-9]\b/.test(built.ampHtml), 'the email must not contain "Day N" lifecycle copy');
});
