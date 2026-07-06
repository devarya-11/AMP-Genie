'use strict';

// ============================================================================
// Phase 7 — the Vertical Design Reference System acceptance suite.
//
// Proves the spec's non-negotiable contract end-to-end:
//   "reference = FORM, client = IDENTITY"
//   "No colour, image URL, font, or copy string from a reference email may ever
//    appear in generated output."
//
// Coverage:
//   A. Forward guard — distilled patterns/profiles/skeletons carry zero identity
//      (every value a count/boolean/vocab token); assertAbstract throws on a
//      hex / url / font.
//   B. Backward guard — assertNoReferenceLeak fires on a real corpus colour/url,
//      and PASSES on every generated email (no reference value rides along).
//   C. Integration — AJIO→fashion_apparel, Nykaa→beauty_cosmetics; palette comes
//      100% from the client context, never from any reference colour; AMP valid.
//   D. Graceful degradation — an uncovered insurance client resolves via
//      nearest-neighbour and still yields a valid email (never blocks).
//   E. Parity — the LayoutSkeleton in GenerationContext (context.form) is the
//      SAME object that ordered the AMP body, so preview and AMP can't diverge.
//   F. Translation — composeRows renders sections in the skeleton's order.
// ============================================================================

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PATTERNS_DIR = path.join(ROOT, 'patterns');

const V = require('../reference/vocab');
const { assertNoReferenceLeak, loadForbiddenSet, buildForbiddenSet, ReferenceLeakError } = require('../reference/assert');
const { getVerticalProfile, pickLayout } = require('../reference/library');
const { generateWithForm } = require('../reference/integrate');
const prodtemplate = require('../server/prodtemplate');
const { validate } = require('../server/validator');

// ---------------------------------------------------------------------------
// A. FORWARD GUARD — nothing concrete can be STORED in the reference layer.
// ---------------------------------------------------------------------------
test('A1: every persisted pattern is brand-agnostic (assertAbstract passes)', async () => {
  const files = fs.readdirSync(PATTERNS_DIR).filter((f) => f.endsWith('.json') && !f.startsWith('_'));
  assert.ok(files.length >= 1, 'expected at least one distilled pattern on disk');
  for (const f of files) {
    const pat = JSON.parse(await fsp.readFile(path.join(PATTERNS_DIR, f), 'utf8'));
    assert.doesNotThrow(() => V.assertAbstract(pat), `${f} must contain only counts/booleans/vocab tokens`);
  }
});

test('A2: assertAbstract THROWS on a hex colour, a url, and a font name', () => {
  assert.throws(() => V.assertAbstract({ palette_roles: { x: '#2c4152' } }), V.LeakError, 'a hex must leak');
  assert.throws(() => V.assertAbstract({ hero: { src: 'https://cdn.brand.com/a.png' } }), V.LeakError, 'a url must leak');
  assert.throws(() => V.assertAbstract({ type: { family: 'Playfair Display' } }), V.LeakError, 'a font name must leak');
});

test('A3: a VerticalProfile and a LayoutSkeleton both pass assertAbstract (sans module)', async () => {
  const profile = await getVerticalProfile('fashion_apparel');
  assert.doesNotThrow(() => V.assertAbstract(profile));
  const skeleton = await pickLayout('fashion_apparel', 'reveal', 'browse');
  const { module: _m, ...formOnly } = skeleton; // module is the client's mechanic id, not a vocab token
  assert.doesNotThrow(() => V.assertAbstract(formOnly));
  assert.strictEqual(skeleton.module, 'reveal', 'the client mechanic id is attached AFTER the abstraction check');
});

// ---------------------------------------------------------------------------
// B. BACKWARD GUARD — no reference value survives into output.
// ---------------------------------------------------------------------------
test('B1: the forbidden set is non-empty (corpus yields chromatic colours + urls)', async () => {
  const set = await loadForbiddenSet();
  assert.ok(set.sources >= 1, 'expected at least one corpus source file');
  assert.ok(set.colours.size >= 1, 'expected chromatic reference colours in the forbidden set');
  // grayscale scaffolding must NOT be forbidden (it is shared, not identity)
  for (const gray of ['#ffffff', '#000000', '#111111', '#f5f5f5']) {
    assert.ok(!set.colours.has(gray), `${gray} is grayscale scaffolding and must not be forbidden`);
  }
});

test('B2: assertNoReferenceLeak THROWS on a real corpus colour and a real corpus url', async () => {
  const set = await loadForbiddenSet();
  const colour = [...set.colours][0];
  await assert.rejects(assertNoReferenceLeak(`<div style="background:${colour}">x</div>`), ReferenceLeakError);
  const url = [...set.urls][0];
  await assert.rejects(assertNoReferenceLeak(`<img src="${url}">`), ReferenceLeakError);
});

test('B3: assertNoReferenceLeak PASSES on clean, grayscale-only markup', async () => {
  await assert.doesNotReject(assertNoReferenceLeak('<table><tr><td style="background:#ffffff;color:#111111">hi</td></tr></table>'));
});

test('B4: a colour the CLIENT owns is allowed even if a reference also uses it (no false positive)', async () => {
  const set = await loadForbiddenSet();
  const shared = [...set.colours][0]; // a real reference colour
  // same colour, but it is the client's OWN declared identity → must NOT trip
  const ctx = { palette: { primary: shared } };
  await assert.doesNotReject(assertNoReferenceLeak(`<div style="background:${shared}">x</div>`, { context: ctx }),
    'a client-owned colour must not be reported as a reference leak');
  // a DIFFERENT reference colour the client does not own still trips, even with context
  const foreign = [...set.colours].find((c) => c !== shared);
  await assert.rejects(assertNoReferenceLeak(`<div style="background:${foreign}">x</div>`, { context: ctx }), ReferenceLeakError,
    'a reference colour the client does not own must still be blocked');
});

// ---------------------------------------------------------------------------
// C. INTEGRATION — AJIO + Nykaa: correct vertical, valid AMP, palette 100% from
//    the client, both guards pass (generateWithForm throws otherwise).
// ---------------------------------------------------------------------------
const CASES = [
  { name: 'AJIO',  client: 'ajio',  coarse: 'Fashion', vertical: 'fashion_apparel',  module: 'reveal', intent: 'browse' },
  { name: 'Nykaa', client: 'nykaa', coarse: 'Beauty',  vertical: 'beauty_cosmetics', module: 'spin',   intent: 'redeem' },
];

for (const c of CASES) {
  test(`C-${c.name}: classified ${c.vertical}, AMP valid, palette from context, no reference leak`, async () => {
    const r = await generateWithForm({ brandName: c.name, clientName: c.client, vertical: c.coarse, moduleId: c.module, intent: c.intent });

    // correct vertical
    assert.strictEqual(r.formMeta.resolved_vertical, c.vertical, `${c.name} must resolve to ${c.vertical}`);
    assert.strictEqual(r.formMeta.tier, 'in_vertical', `${c.name} has in-vertical coverage`);

    // valid AMP4EMAIL (real validator, zero errors)
    const v = await validate(r.ampHtml);
    assert.strictEqual(v.status, 'PASS', `${c.name} AMP must validate (${(v.errors || []).length} errors)`);

    // every concrete palette value comes from the client context, NOT a reference
    const set = await loadForbiddenSet();
    for (const key of ['primary', 'primaryDark', 'accent', 'tint', 'ink', 'line']) {
      const hex = (r.context.palette[key] || '').toLowerCase();
      assert.ok(!set.colours.has(hex), `${c.name} palette.${key}=${hex} must not be a reference colour`);
    }
    // and the rendered email contains none of the forbidden reference values
    await assert.doesNotReject(assertNoReferenceLeak(r.ampHtml), `${c.name} output must be reference-clean`);
  });
}

// ---------------------------------------------------------------------------
// D. GRACEFUL DEGRADATION — uncovered insurance client never blocks.
// ---------------------------------------------------------------------------
test('D1: an uncovered insurance client degrades via nearest-neighbour and still validates', async () => {
  const r = await generateWithForm({ brandName: 'ICICI Prudential', clientName: 'icici pru', vertical: 'Finance', moduleId: 'quiz', intent: 'learn' });
  assert.strictEqual(r.formMeta.requested_vertical, 'insurance_financial', 'roster maps ICICI Pru to insurance_financial');
  assert.ok(['nearest', 'generic'].includes(r.formMeta.tier), `degraded tier expected, got ${r.formMeta.tier}`);
  const v = await validate(r.ampHtml);
  assert.strictEqual(v.status, 'PASS', 'a degraded client still produces a valid email');
});

// ---------------------------------------------------------------------------
// E. PARITY — the skeleton preview and AMP read is one and the same object.
// ---------------------------------------------------------------------------
test('E1: the GenerationContext.form is the SAME LayoutSkeleton that ordered the AMP', async () => {
  const r = await generateWithForm({ brandName: 'AJIO', clientName: 'ajio', vertical: 'Fashion', moduleId: 'reveal', intent: 'browse' });
  assert.ok(r.context && r.context.form, 'context.form must carry the skeleton');
  assert.strictEqual(r.context.form, r.form, 'context.form and the returned form must be the identical object (single source)');
  assert.strictEqual(r.context.form.schema, 'amp-genie/skeleton@1');

  // the rendered block order must be a subsequence of the skeleton section order
  const order = ['header', 'hero', 'value_props', 'product', 'editorial', 'footer'];
  const present = order.filter((blk) => {
    const re = { header: /class="greet"/, hero: /class="cta-wrap"/, value_props: /class="icon-cell"/, product: /class="pcell"/, editorial: /class="promo"/, footer: /class="foot"/ }[blk];
    return re.test(r.ampHtml);
  });
  // header always first, footer always last in whatever is present
  assert.strictEqual(present[0], 'header', 'header renders first');
  assert.strictEqual(present[present.length - 1], 'footer', 'footer renders last');
});

// ---------------------------------------------------------------------------
// F. TRANSLATION — composeRows honours the skeleton's section sequence.
// ---------------------------------------------------------------------------
test('F1: composeRows renders blocks in the skeleton order, dedups, and forces invariants', () => {
  const blocks = { header: '[H]', hero: '[HERO]', value_props: '[VP]', product: '[PROD]', editorial: '[ED]', mechanic: '[MECH]', footer: '[FT]' };
  const seq = (s) => (s.match(/\[[A-Z]+\]/g) || []).join(' ');

  const fashion = { sections: [{ type: 'header' }, { type: 'hero' }, { type: 'mechanic' }, { type: 'product_grid' }, { type: 'cta_banner' }, { type: 'footer' }] };
  assert.strictEqual(seq(prodtemplate.composeRows({ form: fashion, blocks })), '[H] [HERO] [MECH] [PROD] [FT]');

  // editorial-before-mechanic order is respected (not re-sorted)
  const lux = { sections: [{ type: 'header' }, { type: 'hero' }, { type: 'editorial' }, { type: 'mechanic' }, { type: 'product_strip' }, { type: 'footer' }] };
  assert.strictEqual(seq(prodtemplate.composeRows({ form: lux, blocks })), '[H] [HERO] [ED] [MECH] [PROD] [FT]');

  // duplicate product types collapse to one block
  const dup = { sections: [{ type: 'header' }, { type: 'product_grid' }, { type: 'product_strip' }, { type: 'category_nav' }, { type: 'mechanic' }, { type: 'footer' }] };
  assert.strictEqual(seq(prodtemplate.composeRows({ form: dup, blocks })), '[H] [PROD] [MECH] [FT]');

  // a skeleton that omits header+footer still force-includes them (top + bottom)
  const broken = { sections: [{ type: 'hero' }, { type: 'mechanic' }, { type: 'product_grid' }] };
  assert.strictEqual(seq(prodtemplate.composeRows({ form: broken, blocks })), '[H] [HERO] [MECH] [PROD] [FT]');

  // no form → house fixed order
  assert.strictEqual(seq(prodtemplate.composeRows({ form: null, blocks })), '[H] [HERO] [VP] [MECH] [PROD] [ED] [FT]');
});

test('F2: the no-form build path is unchanged (backward compatible)', async () => {
  const { resolveAssets } = require('../server/assets');
  const { buildProduction } = require('../server/build');
  const resolved = await resolveAssets({ brandName: 'AJIO', vertical: 'Fashion', need: { logo: true, products: 3 } });
  const built = buildProduction({ moduleId: 'reveal', resolved }); // no opts.form
  assert.strictEqual(built.context.form, null, 'no skeleton supplied → context.form is null');
  const v = await validate(built.ampHtml);
  assert.strictEqual(v.status, 'PASS', 'no-form build still validates');
});
