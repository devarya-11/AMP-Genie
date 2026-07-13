'use strict';

// End-to-end UI tests for the AMP Genie v3 SaaS shell. These drive the real
// browser UI against the real server, which runs the real amphtml-validator
// (vendored — no CDN fetch) and the real fs-backed store, so a green run
// proves shell navigation, both create modes, the guided ideation wizard,
// slates, share pages and the Pitches/Brands/History views end to end.
//
// Hermeticity: playwright.config.js starts the server with every provider env
// var pre-set to '' (dotenv never overwrites an existing var, so the real
// keys in .env can't leak in), which means every request here rides the
// zero-key deterministic tier — library use-cases, heuristic dossiers,
// template copy. Several tests assert that provenance explicitly, so a key
// leaking through fails the run loudly instead of silently burning quota.
// Brand names are deliberate nonsense: no such site resolves, so brand
// colour/logo/research fetches degrade to the hash/heuristic tiers and no
// assertion ever depends on a live third-party site.

const fs = require('fs');
const path = require('path');
const { test, expect } = require('@playwright/test');

// One made-up brand per flow: distinct names keep History/Pitches assertions
// unambiguous when the fs store and .history.json carry entries from earlier
// runs (both persist across runs by design — assertions are additive only).
const QUICK_BRAND = 'Zzqgeniequickco';
const PREVIEW_BRAND = 'Zzqgeniepreviewco';
const CODE_BRAND = 'Zzqgeniecodeco';
const EDIT_BRAND = 'Zzqgenieeditco';
const DISPATCH_BRAND = 'Zzqgeniedispatchco';
const SLATE_BRAND = 'Zzqgenieslateco';
const GUIDED_BRAND = 'Zzqgenieguidedco';
const SHARE_BRAND = 'Zzqgenieshareco';
const CALC_BRAND = 'Zzqgeniecalcco';
const REPORT_BRAND = 'Zzqgeniereportco';
const BRANDS_BRAND = 'Zzqgenielookupco';

// Dossiers are cached in .data/ keyed by brand slug. A cache row written by a
// PREVIOUS session that had a real key configured would carry
// confidence:'llm' and be served verbatim, breaking the 'heuristic'
// assertions below — so the research-driven brands get their cache cleared
// up front. Mirrors store.js's brandSlug + store-fs.js's keyToFilename.
const DATA_DIR = path.join(__dirname, '..', '.data');
function dossierCacheFile(brand) {
  const slug = brand.toLowerCase().replace(/[^a-z0-9]/g, '');
  return path.join(DATA_DIR, 'dossier__' + slug + '.json');
}
test.beforeAll(() => {
  for (const brand of [GUIDED_BRAND, BRANDS_BRAND]) {
    try { fs.unlinkSync(dossierCacheFile(brand)); } catch (e) { /* no cache — fine */ }
  }
});

// The shell is entirely script-driven: nav/mode handlers bind only after
// app.js's init() has fetched /api/meta, and a click before that is a silent
// no-op. init() then loads history, which always leaves at least one child in
// #historyList (items or the empty-note) — the one DOM change that proves
// binding finished, so it is the readiness signal every test waits on.
async function openApp(page) {
  await page.goto('/');
  await expect(page.locator('#historyList > *')).not.toHaveCount(0);
}

// Guided is the default create mode; the quick (v2) flow sits behind the
// second mode tab.
async function openQuick(page) {
  await openApp(page);
  await page.click('#modeQuick');
  await expect(page.locator('#quick')).toBeVisible();
}

// One quick-mode build. The /generate JSON is captured via waitForResponse
// (registered before the click, so the response can never be missed) because
// the page's own state lives in a closure the test can't reach — the response
// is the only honest source for moduleId/sharePath.
async function quickBuild(page, { brand, brief } = {}) {
  await openQuick(page);
  if (brand) await page.fill('#brand', brand);
  if (brief) await page.fill('#campaignBrief', brief);
  const [res] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith('/generate') && r.request().method() === 'POST'),
    page.click('#rub'),
  ]);
  const out = await res.json();
  expect(out.error).toBeUndefined();
  await expect(page.locator('#result')).toBeVisible();
  await expect(page.locator('#valDot')).toHaveClass(/pass/);
  return out;
}

// The AMP code / Validation tabs hide behind the Developer view toggle. The
// checkbox itself is visually hidden (the switch is CSS-drawn), so — like a
// real user — click the visible track. Scoped to .nav-foot because the quick
// form's Full-slate switch reuses the same .devtoggle-track class and an
// unscoped selector would trip Playwright's strict mode.
async function enableDevMode(page) {
  await page.click('.nav-foot .devtoggle-track');
  await expect(page.locator('#devToggle')).toBeChecked();
}

// Directive 7: the preview is the exact amp4email email, rendered in a
// sandboxed <iframe> that boots the real AMP runtime from the CDN. So rather
// than driving a JS mirror (deleted) — or making this deliberately-offline
// suite depend on cdn.ampproject.org booting the runtime to flip visible state
// — we assert the embedded bytes ARE that email: the exact amp4email document,
// carrying the module's real amp-bind interactivity (an AMP.setState hook),
// byte-for-byte the source the Download AMP link serves. Live in-frame
// behaviour is covered by the AMP4EMAIL unit suite (289 structural + validator
// tests). Each signature is a control every build of that module always emits.
const MODULE_SIGNATURE = {
  reveal: 'AMP.setState({s:{r:true}})',
  search: 'AMP.setState({s:{q:event.value.toLowerCase()}})',
  quiz: 'AMP.setState({s:{sel:',
  rating: 'AMP.setState({s:{score:',
  spin: 'AMP.setState({s:{spun:true}})',
  poll: "AMP.setState({s:{v:'a'}})",
  calc: 'AMP.setState({s:{a:',
  report: 'AMP.setState({s:{open:',
};

// Read the exact document the preview iframe renders. For the app preview the
// AMP rides in srcdoc; for a share page it loads from /build/<id>?format=embed.
// Either way the serialized frame source contains the real amp4email markup
// whether or not the CDN runtime has finished booting.
async function previewFrameHtml(page, root) {
  const handle = await page.waitForSelector(`${root} iframe.amp-frame`, { timeout: 15_000 });
  const frame = await handle.contentFrame();
  await frame.waitForSelector('html[amp4email]', { state: 'attached', timeout: 15_000 });
  return frame.content();
}

// Assert the preview IS the exact interactive AMP email for the built module.
async function expectExactAmpPreview(page, moduleId, root) {
  const sig = MODULE_SIGNATURE[moduleId];
  if (!sig) throw new Error('No AMP signature defined for module "' + moduleId + '"');
  const html = await previewFrameHtml(page, root);
  expect(html.toLowerCase()).toContain('<!doctype html>');
  expect(html).toContain('amp4email');
  expect(html).toContain(sig);
}

/* ------------------------------------------------------------------ *
 * shell: nav, identity, create modes
 * ------------------------------------------------------------------ */

test('the shell offers four views with Create active by default', async ({ page }) => {
  await openApp(page);
  await expect(page.locator('.nav-item')).toHaveCount(4);
  await expect(page.locator('.nav-item[data-view="create"]')).toHaveClass(/on/);
  await expect(page.locator('#view-create')).toBeVisible();
  for (const view of ['pitches', 'brands', 'history']) {
    await expect(page.locator('#view-' + view)).toBeHidden();
  }
});

test('the left nav switches between all four views', async ({ page }) => {
  await openApp(page);
  for (const view of ['pitches', 'brands', 'history', 'create']) {
    await page.click(`.nav-item[data-view="${view}"]`);
    await expect(page.locator('#view-' + view)).toBeVisible();
    await expect(page.locator(`.nav-item[data-view="${view}"]`)).toHaveClass(/on/);
    // exactly one view on screen at a time
    await expect(page.locator('.view.on')).toHaveCount(1);
  }
});

test('the sidebar author name persists to localStorage across reloads', async ({ page }) => {
  await openApp(page);
  await page.fill('#authorName', 'E2E Genie');
  // the input saves on change, which fires when focus leaves the field
  await page.locator('#authorName').blur();
  await page.reload();
  await expect(page.locator('#historyList > *')).not.toHaveCount(0);
  await expect(page.locator('#authorName')).toHaveValue('E2E Genie');
});

test('Create switches between the guided wizard and quick generate', async ({ page }) => {
  await openApp(page);
  // guided is the default: wizard visible, quick hidden
  await expect(page.locator('#modeGuided')).toHaveClass(/on/);
  await expect(page.locator('#guided')).toBeVisible();
  await expect(page.locator('#quick')).toBeHidden();

  await page.click('#modeQuick');
  await expect(page.locator('#modeQuick')).toHaveClass(/on/);
  await expect(page.locator('#quick')).toBeVisible();
  await expect(page.locator('#guided')).toBeHidden();

  await page.click('#modeGuided');
  await expect(page.locator('#guided')).toBeVisible();
  await expect(page.locator('#quick')).toBeHidden();
});

/* ------------------------------------------------------------------ *
 * quick generate: the one-click v2 flow inside the v3 shell
 * ------------------------------------------------------------------ */

test('quick generate yields a validated build with provenance chips and a share link', async ({ page }) => {
  const out = await quickBuild(page, { brand: QUICK_BRAND });

  await expect(page.locator('#status')).toContainText('zero errors');
  const chips = page.locator('#chips');
  await expect(chips).toContainText(QUICK_BRAND);
  await expect(chips).toContainText('vertical');
  await expect(chips).toContainText('tone');
  // zero-key run: copy provenance must be the deterministic template tier —
  // 'llm' here means a provider key leaked into the hermetic server
  await expect(chips).toContainText('template');
  // the colour tier depends on environment (egress may be blocked entirely),
  // so assert it is one of the legitimate sources, never an exact one
  const chipText = await chips.innerText();
  expect(chipText).toMatch(/hash|fetched|kit|library/);

  // fs-backed store is live in dev, so every build persists and shares
  expect(out.sharePath).toMatch(/^\/b\/[a-z0-9]{6,}$/);
  await expect(page.locator('#share')).toBeVisible();
});

test('the phone preview is the exact interactive AMP for whichever module the genie picked', async ({ page }) => {
  const out = await quickBuild(page, { brand: PREVIEW_BRAND });
  await expect(page.locator('#conjured')).toContainText(out.moduleName);
  await expect(page.locator('#previewArea iframe.amp-frame')).toBeVisible();
  await expectExactAmpPreview(page, out.moduleId, '#previewArea');
});

test('copy and download both emit the current (edited) code byte-for-byte', async ({ page, context, baseURL }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: baseURL });
  await quickBuild(page, { brand: CODE_BRAND });

  await enableDevMode(page);
  await page.click('.tabs button[data-tab="code"]');
  const original = await page.locator('#code').inputValue();
  expect(original).toMatch(/<!doctype html>/i);
  expect(original).toMatch(/amp4email/i);

  const edited = original + '\n<!-- e2e byte check -->';
  await page.fill('#code', edited);

  await page.click('#copy');
  const clipped = await page.evaluate(() => navigator.clipboard.readText());
  expect(clipped).toBe(edited);

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.click('#download'),
  ]);
  const stream = await download.createReadStream();
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  expect(Buffer.concat(chunks).toString('utf-8')).toBe(edited);
});

test('editing the code flags the stale preview and re-validate/reset round-trips', async ({ page }) => {
  await quickBuild(page, { brand: EDIT_BRAND });

  await enableDevMode(page);
  await page.click('.tabs button[data-tab="code"]');
  const original = await page.locator('#code').inputValue();
  await expect(page.locator('#editedLabel')).toBeHidden();

  // a stray '}' inside <style> is a guaranteed AMP4EMAIL CSS error
  await page.fill('#code', original.replace('</style>', '--x:1;}</style>'));
  await expect(page.locator('#editedLabel')).toBeVisible();

  // the stale badge lives in the preview pane: the phone still shows the last
  // GENERATED version, and the badge says so
  await page.click('.tabs button[data-tab="preview"]');
  await expect(page.locator('#previewStale')).toBeVisible();

  await page.click('.tabs button[data-tab="code"]');
  await page.click('#revalidate');
  await expect(page.locator('#verdict')).toContainText('FAIL');
  await expect(page.locator('#errors li')).not.toHaveCount(0);

  await page.click('.tabs button[data-tab="code"]');
  await page.click('#resetCode');
  await expect(page.locator('#editedLabel')).toBeHidden();
  expect(await page.locator('#code').inputValue()).toBe(original);

  await page.click('.tabs button[data-tab="validation"]');
  await expect(page.locator('#verdict')).toContainText('PASS');
  await page.click('.tabs button[data-tab="preview"]');
  await expect(page.locator('#previewStale')).toBeHidden();
});

test('dispatch requires a recipient and reports missing SMTP clearly', async ({ page }) => {
  await quickBuild(page, { brand: DISPATCH_BRAND });

  // no recipient: rejected client-side, the server is never called
  await page.click('#dispatch');
  await expect(page.locator('#dispatchMsg')).toContainText(/recipient/i);

  // with a recipient: the hermetic server has no SMTP env, so the real
  // dispatch path must fail gracefully with its configuration message
  await page.fill('#dispatchTo', 'someone@example.com');
  await page.click('#dispatch');
  await expect(page.locator('#dispatchMsg')).toContainText(/smtp|failed/i, { timeout: 15_000 });
});

/* ------------------------------------------------------------------ *
 * full slate: one click -> every module on one pitch page
 * ------------------------------------------------------------------ */

// Serial: the slate is built once, then its share page and Pitches listing
// are verified against the captured response — no second 8-build fan-out.
test.describe.serial('full slate', () => {
  let slate = null;

  test('the full-slate toggle builds every module, all valid', async ({ page }) => {
    test.setTimeout(180_000); // 8 parallel builds through the real validator
    await openQuick(page);
    await page.fill('#brand', SLATE_BRAND);
    // same CSS-drawn switch as Developer view — click the visible track
    await page.click('.slate-ctrl .devtoggle-track');
    await expect(page.locator('#slateToggle')).toBeChecked();

    const [res] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith('/slate') && r.request().method() === 'POST', { timeout: 120_000 }),
      page.click('#rub'),
    ]);
    slate = await res.json();
    expect(slate.error).toBeUndefined();
    expect(slate.builds).toHaveLength(8);

    await expect(page.locator('#slateResult')).toBeVisible();
    await expect(page.locator('#slateTitle')).toContainText(SLATE_BRAND);
    const rows = page.locator('.slate-build');
    await expect(rows).toHaveCount(8);
    // every row carries the green 'valid' chip — a single 'invalid' means a
    // module regressed against the real validator
    await expect(page.locator('.slate-build .chip.pass')).toHaveCount(8);
    await expect(page.locator('.slate-build .chip.fail')).toHaveCount(0);
    // the two v3 modules are on the slate by name
    await expect(page.locator('#slateBuilds')).toContainText('Interactive Calculator');
    await expect(page.locator('#slateBuilds')).toContainText('Personal Report');
    await expect(page.locator('#slateOpen')).toBeVisible();
    expect(await page.locator('#slateOpen').getAttribute('href')).toBe(slate.sharePath);
  });

  test('the pitch page /s/ renders eight interactive phones', async ({ page, request }) => {
    expect(slate, 'slate build test must pass first').not.toBeNull();
    const res = await request.get(slate.sharePath);
    expect(res.status()).toBe(200);
    const body = await res.text();
    expect((body.match(/class="phone-screen"/g) || []).length).toBe(8);
    expect((body.match(/\?format=embed/g) || []).length).toBe(8);
    expect(body).toContain('8 interactive concepts');

    // and in a real browser every phone is an <iframe> embedding one build's
    // exact AMP by URL — the pitch deliverable renders the real interactive
    // emails, not a stand-in mirror
    await page.goto(slate.sharePath);
    await expect(page.locator('.phone-screen iframe.amp-frame')).toHaveCount(8);
    const srcs = await page.locator('.phone-screen iframe.amp-frame')
      .evaluateAll((els) => els.map((e) => e.getAttribute('src')));
    for (const src of srcs) expect(src).toMatch(/^\/build\/[a-z0-9]{6,}\?format=embed$/);
  });

  test('the Pitches view lists the slate with a working /s/ link', async ({ page }) => {
    expect(slate, 'slate build test must pass first').not.toBeNull();
    await openApp(page);
    await page.click('.nav-item[data-view="pitches"]');
    const row = page.locator('.pitch-row', { hasText: SLATE_BRAND }).first();
    await expect(row).toBeVisible();
    await expect(row).toContainText('8 emails');
    expect(await row.getAttribute('href')).toBe(slate.sharePath);
  });
});

/* ------------------------------------------------------------------ *
 * guided wizard: research -> propose -> refine -> build (zero-key tier)
 * ------------------------------------------------------------------ */

test.describe.serial('guided wizard', () => {
  let guidedSlate = null;

  test('research, propose, refine and build all run on the deterministic tier', async ({ page }) => {
    test.setTimeout(180_000); // ends in a 7-build slate fan-out
    await openApp(page);

    // step 1: research a brand no site resolves for -> heuristic dossier
    await page.fill('#gBrand', GUIDED_BRAND);
    await Promise.all([
      page.waitForResponse((r) => r.url().endsWith('/usecases') && r.request().method() === 'POST'),
      page.click('#gResearch'),
    ]);
    await expect(page.locator('#dossierCard')).toBeVisible();
    // the confidence chip is the hermeticity canary: 'LLM-researched' here
    // means a real key leaked into the supposedly keyless server
    await expect(page.locator('#dossierConf')).toHaveText('heuristic (no LLM key)');
    await expect(page.locator('#wstep2')).toBeVisible();
    // nonsense brand -> no products scraped -> the questionnaire says so
    await expect(page.locator('#qProducts')).toContainText('none found');

    // step 2 -> 3: propose. Zero keys -> exactly the 6 library use-cases.
    await Promise.all([
      page.waitForResponse((r) => r.url().endsWith('/usecases') && r.request().method() === 'POST'),
      page.click('#gPropose'),
    ]);
    await expect(page.locator('#wstep3')).toBeVisible();
    await expect(page.locator('#ucSource')).toContainText('library');
    await expect(page.locator('.uc-card')).toHaveCount(6);
    // every card carries its module chip mapped through /api/meta names
    await expect(page.locator('#ucList')).toContainText('module');
    await expect(page.locator('#ucList')).toContainText('Tap to Reveal Offer');
    await expect(page.locator('#ucCount')).toHaveText('(6)');

    // remove one -> the count follows
    await page.locator('.uc-card .uc-remove').first().click();
    await expect(page.locator('.uc-card')).toHaveCount(5);
    await expect(page.locator('#ucCount')).toHaveText('(5)');

    // feedback + reroll: the library tier accepts the steer but re-deals a
    // full hand of 6 — feedback must never error a keyless deployment
    await page.fill('#ucFeedback', 'go deeper on retention');
    await Promise.all([
      page.waitForResponse((r) => r.url().endsWith('/usecases') && r.request().method() === 'POST'),
      page.click('#ucReroll'),
    ]);
    await expect(page.locator('.uc-card')).toHaveCount(6);
    await expect(page.locator('#ucFeedback')).toHaveValue('');

    // the team's own idea becomes a 7th use-case; zero-key shaping routes it
    // deterministically ('spin' + 'wheel' -> the Spin to Win module)
    const idea = 'Spin the wheel for a birthday reward';
    await page.fill('#ucFeedback', idea);
    await Promise.all([
      page.waitForResponse((r) => r.url().endsWith('/usecases') && r.request().method() === 'POST'),
      page.click('#ucAddIdea'),
    ]);
    await expect(page.locator('.uc-card')).toHaveCount(7);
    const added = page.locator('.uc-card').last();
    await expect(added).toContainText(idea);
    await expect(added).toContainText('Spin to Win');

    // build the approved 7 into a slate
    const [res] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith('/slate') && r.request().method() === 'POST', { timeout: 120_000 }),
      page.click('#ucBuild'),
    ]);
    guidedSlate = await res.json();
    expect(guidedSlate.error).toBeUndefined();
    expect(guidedSlate.builds).toHaveLength(7);

    await expect(page.locator('#slateResult')).toBeVisible();
    await expect(page.locator('.slate-build')).toHaveCount(7);
    await expect(page.locator('.slate-build .chip.pass')).toHaveCount(7);
    await expect(page.locator('#slateBuilds')).toContainText(idea);
  });

  test('the guided slate share page is live with all seven concepts', async ({ request }) => {
    expect(guidedSlate, 'guided build test must pass first').not.toBeNull();
    const res = await request.get(guidedSlate.sharePath);
    expect(res.status()).toBe(200);
    const body = await res.text();
    expect((body.match(/class="phone-screen"/g) || []).length).toBe(7);
    expect(body).toContain('Spin the wheel for a birthday reward');
  });

  test('the History view lists the guided builds', async ({ page }) => {
    expect(guidedSlate, 'guided build test must pass first').not.toBeNull();
    await openApp(page);
    await page.click('.nav-item[data-view="history"]');
    const item = page.locator('.history-item', { hasText: GUIDED_BRAND }).first();
    await expect(item).toBeVisible();
    await expect(item.locator('.chip.pass')).toContainText('pass');
  });
});

/* ------------------------------------------------------------------ *
 * single-build share page: /b/<id> + the AMP download
 * ------------------------------------------------------------------ */

test.describe.serial('single-build share page', () => {
  let build = null;

  test('a quick build persists and links its share page', async ({ page }) => {
    build = await quickBuild(page, { brand: SHARE_BRAND });
    expect(build.sharePath).toMatch(/^\/b\/[a-z0-9]{6,}$/);
  });

  test('the /b/ page embeds the build\'s exact interactive AMP inline', async ({ page, request }) => {
    expect(build, 'share build test must pass first').not.toBeNull();
    await page.goto(build.sharePath);
    const embedSrc = build.sharePath.replace('/b/', '/build/') + '?format=embed';
    const frame = page.locator('.phone-screen iframe.amp-frame');
    await expect(frame).toHaveCount(1);
    expect(await frame.getAttribute('src')).toBe(embedSrc);
    // that URL serves the exact amp4email INLINE (so it renders in the frame),
    // never as a download — the same interactive bytes the app preview shows
    const res = await request.get(embedSrc);
    expect(res.status()).toBe(200);
    expect(res.headers()['content-disposition'] || '').not.toContain('attachment');
    const bytes = await res.text();
    expect(bytes.toLowerCase().startsWith('<!doctype html>')).toBe(true);
    expect(bytes).toContain('amp4email');
    expect(bytes).toContain(MODULE_SIGNATURE[build.moduleId]);
  });

  test('the Download AMP link serves the build as a real AMP4EMAIL file', async ({ page, request }) => {
    expect(build, 'share build test must pass first').not.toBeNull();
    await page.goto(build.sharePath);
    const href = await page.locator('a.dl', { hasText: 'Download AMP' }).getAttribute('href');
    const res = await request.get(href);
    expect(res.status()).toBe(200);
    expect(res.headers()['content-disposition'] || '').toContain('attachment');
    const bytes = await res.text();
    expect(bytes.toLowerCase().startsWith('<!doctype html>')).toBe(true);
    expect(bytes).toContain('amp4email');
  });
});

/* ------------------------------------------------------------------ *
 * v3 modules routed from a brief: calculator + report
 * ------------------------------------------------------------------ */

test('a calculator brief routes to the calc module and previews the exact live-maths AMP', async ({ page }) => {
  const out = await quickBuild(page, {
    brand: CALC_BRAND,
    brief: 'EMI calculator for gold loans',
  });
  expect(out.moduleId).toBe('calc');
  await expect(page.locator('#conjured')).toContainText('Interactive Calculator');

  // the preview IS the exact calc email: real amp-bind preset pills and the +/-
  // stepper, wired to the precomputed lookup table through a bound [text]
  // readout — not a JS mirror that could drift from what ships.
  const html = await previewFrameHtml(page, '#previewArea');
  expect(html).toContain('amp4email');
  expect(html).toContain('AMP.setState({s:{a:');   // preset pills
  expect(html).toContain('AMP.setState({s:{b:');   // +/- stepper
  expect(html).toContain('[text]=');               // the live-computed readout
});

test('a lab-report brief routes to the report module and previews the exact accordion + gated-CTA AMP', async ({ page }) => {
  const out = await quickBuild(page, {
    brand: REPORT_BRAND,
    brief: 'my lab report is ready',
  });
  expect(out.moduleId).toBe('report');
  await expect(page.locator('#conjured')).toContainText('Personal Report');

  // the preview IS the exact report email: real amp-bind accordion rows, a
  // verdict reveal and a slot-gated CTA — the genuine interactivity, not a mirror.
  const html = await previewFrameHtml(page, '#previewArea');
  expect(html).toContain('amp4email');
  expect(html).toContain('AMP.setState({s:{open:');        // accordion rows
  expect(html).toContain('AMP.setState({s:{sel:');         // slot pick (arms the CTA)
  expect(html).toContain('AMP.setState({s:{rev:true}})');  // verdict reveal
});

/* ------------------------------------------------------------------ *
 * brands view
 * ------------------------------------------------------------------ */

test('the Brands view looks up a brand and shows its dossier card', async ({ page }) => {
  await openApp(page);
  await page.click('.nav-item[data-view="brands"]');
  await page.fill('#bSearch', BRANDS_BRAND);
  await Promise.all([
    page.waitForResponse((r) => r.url().endsWith('/usecases') && r.request().method() === 'POST'),
    page.click('#bShow'),
  ]);
  await expect(page.locator('#brandCard')).toBeVisible();
  // nonsense brand: no site, no summary — the card says so instead of lying
  await expect(page.locator('#bSummary')).toContainText('Nothing on file');
  // research provenance chip: heuristic on the hermetic zero-key server
  await expect(page.locator('#bChips')).toContainText('heuristic');
  await expect(page.locator('#bChips')).toContainText('vertical');
});
