'use strict';

// ============================================================================
// Regression: cross-build isolation for server/build.js's buildProduction.
//
// server/build.js keeps module-level `_activeLogo`/`_activeAes`/`_activeFooter`/
// `_activeBrand` state during a single build, set at the top of buildProduction
// and reset in a `finally` block (see PHASE0_FINDINGS.md). Today buildProduction
// is fully SYNCHRONOUS, so there is no `await` between the set and the reset —
// no other build's code can run in between and observe/overwrite that state.
// That's why the module-level state is safe right now, even though it "looks
// like" a global-mutable-state bleed risk at a glance.
//
// This test locks that safety in as an executable invariant: build client A
// (AJIO, Fashion), then client B (Zomato, Food delivery), then A again — and
// separately, kick off A and B CONCURRENTLY via Promise.all — and assert
// neither brand's colour palette nor brand name ever appears in the other's
// finished output. If buildProduction is ever refactored to be async (e.g. an
// awaited slice-rehost step added to the hot path) and that refactor
// reintroduces bleed through the shared module-level state, this test is the
// one that should catch it, not a client's production incident.
// ============================================================================

const { test } = require('node:test');
const assert = require('node:assert');
const assets = require('../server/assets');
const build = require('../server/build');
const { ownedColours } = require('../server/guard');

const CLIENT_A = { brandName: 'AJIO', vertical: 'Fashion' };
const CLIENT_B = { brandName: 'Zomato', vertical: 'Food' };

async function resolveAndBuild(spec) {
  const resolved = await assets.resolveAssets({
    brandName: spec.brandName, vertical: spec.vertical, currency: 'INR',
    user: {}, need: { logo: true, products: 3 },
  });
  const built = build.buildProduction({ moduleId: 'reveal', resolved, currency: 'INR' });
  return { resolved, built };
}

function assertIsolated(a, b, label) {
  const aColours = ownedColours(a.built.context);
  const bColours = ownedColours(b.built.context);
  const bHexes = new Set((b.built.ampHtml.match(/#[0-9a-fA-F]{3,8}\b/g) || []).map((h) => h.toLowerCase()));
  const aHexes = new Set((a.built.ampHtml.match(/#[0-9a-fA-F]{3,8}\b/g) || []).map((h) => h.toLowerCase()));

  for (const c of aColours) {
    assert.ok(!bHexes.has(c), `${label}: Client A colour ${c} must not appear in Client B output`);
  }
  for (const c of bColours) {
    assert.ok(!aHexes.has(c), `${label}: Client B colour ${c} must not appear in Client A output`);
  }
  assert.ok(!b.built.ampHtml.includes(CLIENT_A.brandName), `${label}: Client A brand name must not appear in Client B output`);
  assert.ok(!a.built.ampHtml.includes(CLIENT_B.brandName), `${label}: Client B brand name must not appear in Client A output`);
}

test('no-crossbuild-bleed: sequential A -> B -> A builds stay isolated', async () => {
  const a1 = await resolveAndBuild(CLIENT_A);
  const b = await resolveAndBuild(CLIENT_B);
  const a2 = await resolveAndBuild(CLIENT_A);

  assertIsolated(a1, b, 'A1->B');
  assertIsolated(a2, b, 'A2->B');

  // A's own output must be stable/self-consistent across both builds (same
  // brand, same owned palette) — i.e. B's build in between did not corrupt A.
  assert.deepStrictEqual(
    [...ownedColours(a1.built.context)].sort(),
    [...ownedColours(a2.built.context)].sort(),
    'Client A palette must be identical across sequential builds separated by a different client\'s build',
  );
});

test('no-crossbuild-bleed: concurrent A and B builds stay isolated', async () => {
  const [a, b] = await Promise.all([resolveAndBuild(CLIENT_A), resolveAndBuild(CLIENT_B)]);
  assertIsolated(a, b, 'concurrent A/B');
});
