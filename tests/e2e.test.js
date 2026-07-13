'use strict';

// GENIE 2.0 e2e — drives the real UI (web/) against the real server
// (server/index.js) booted by playwright.config.js in HERMETIC mode: local
// sqlite repo (SUPABASE_* blanked), KV/fs byte store, gate open
// (TEAM_PASSWORD blanked), zero LLM keys — every flow rides the
// deterministic tier, so the suite needs no network and burns no quota.
//
// Data accumulates in .data/ across runs by design; every run uses a unique
// nonsense brand so assertions filter by name and never count globally.

const { test, expect } = require('@playwright/test');

const RUN = 'zeta' + Math.random().toString(36).slice(2, 8);
const BRAND = 'Zetworks ' + RUN;
const PITCH_TITLE = 'Launch pitch ' + RUN;

// A 1x1 red PNG for the upload flow.
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

test.describe.configure({ mode: 'serial' });

async function gotoHome(page) {
  await page.goto('/');
  await expect(page.locator('#view-pitches')).toBeVisible();
}

async function openPitch(page) {
  await gotoHome(page);
  await page.locator('#pitchesList .pitch-card', { hasText: PITCH_TITLE }).first().click();
  await expect(page.locator('#view-pitch')).toBeVisible();
}

// The pitch's brand id, fetched the way any API client would — the UI keeps
// its state module-private, which is correct, so tests go through the wire.
async function brandIdFor(request) {
  const pitches = await (await request.get('/api/pitches')).json();
  const pitch = pitches.items.find((p) => p.title === PITCH_TITLE);
  const full = await (await request.get('/api/pitches/' + pitch.id)).json();
  return full.pitch.brand_id;
}

test('nav shows exactly Pitches and Settings; author name persists', async ({ page }) => {
  await gotoHome(page);
  const items = page.locator('.nav .nav-item');
  await expect(items).toHaveCount(2);
  await expect(items.nth(0)).toContainText('Pitches');
  await expect(items.nth(1)).toContainText('Settings');
  await page.fill('#authorName', 'E2E Tester');
  await page.keyboard.press('Tab'); // the field persists on change, not per-keystroke
  await page.reload();
  await expect(page.locator('#authorName')).toHaveValue('E2E Tester');
});

test('old nav views are gone', async ({ page }) => {
  await gotoHome(page);
  for (const id of ['view-create', 'view-brands', 'view-history']) {
    expect(await page.locator('#' + id).count(), id + ' must not exist').toBe(0);
  }
});

test('wizard: research offline -> heuristic dossier; kit saves; pitch created -> workspace', async ({ page }) => {
  await gotoHome(page);
  await page.click('#newPitchBtn');
  await expect(page.locator('#view-newpitch')).toBeVisible();
  await page.fill('#npBrand', BRAND);
  await page.fill('#npNotes', 'A fictional devices brand for testing.');
  await page.click('#npResearch');
  await expect(page.locator('#npDossier')).toBeVisible({ timeout: 30000 });
  await expect(page.locator('#npConf')).toContainText(/heuristic/i);
  await expect(page.locator('#npStep2')).toBeVisible();

  // one product row: first two inputs are name/price whatever the row class
  await page.click('#npAddProduct');
  const rowInputs = page.locator('#npProducts input');
  await rowInputs.nth(0).fill('Zet Speaker');
  await rowInputs.nth(1).fill('2999');
  await page.fill('#npVoice', 'Crisp, techy, friendly.');
  await page.click('#npSave2');
  await expect(page.locator('#npStatus2')).toContainText(/saved|ok|✓/i, { timeout: 15000 });

  await page.fill('#npTitle', PITCH_TITLE);
  await page.selectOption('#npGoal', { index: 1 });
  await page.fill('#npBrief', 'Festive speaker push with a spin to win reward');
  await page.click('#npCreate');
  await expect(page.locator('#view-pitch')).toBeVisible({ timeout: 20000 });
  await expect(page.locator('#pwBrand')).toContainText(BRAND);
});

test('pitches home lists the new pitch with its brand', async ({ page }) => {
  await gotoHome(page);
  const card = page.locator('#pitchesList .pitch-card', { hasText: PITCH_TITLE });
  await expect(card).toHaveCount(1);
  await expect(card).toContainText(BRAND);
});

test('examples: "New example" opens the editor; the AI drawer drafts an interactive doc that saves', async ({ page }) => {
  await openPitch(page);
  await page.click('#exNew');
  // editor-first: New example opens the visual editor directly
  await expect(page.locator('#view-editor')).toBeVisible({ timeout: 30000 });
  // AI drawer INSIDE the editor drafts onto the canvas
  await page.fill('#edAiIdea', 'spin the wheel for a festive speaker discount');
  await page.click('#edAiGo');
  await expect
    .poll(async () => (await page.locator('#edFrame').getAttribute('srcdoc')) || '', { timeout: 60000 })
    .toContain('amp-bind'); // the interactive module is on the canvas
  await page.click('#edSave');
  await expect(page.locator('#edSaved')).toContainText(/saved/i, { timeout: 30000 });
  await page.click('#edBack');
  await expect(page.locator('#exGrid .ex-card')).not.toHaveCount(0, { timeout: 15000 });
});

test('examples: the editor AI drawer proposes use-cases offline', async ({ page }) => {
  await openPitch(page);
  await page.click('#exNew');
  await expect(page.locator('#view-editor')).toBeVisible({ timeout: 30000 });
  await page.click('#edAiProposeBtn');
  await expect
    .poll(async () => page.locator('#edAiList > *').count(), { timeout: 30000 })
    .toBeGreaterThan(0);
});

test('example detail: AMP renders, share link works, download names an html file', async ({ page, request }) => {
  await openPitch(page);
  await page.locator('#exGrid .ex-card').first().click();
  await expect(page.locator('#exDetail')).toBeVisible();
  await expect
    .poll(async () => (await page.locator('#exFrame').getAttribute('srcdoc')) || '', { timeout: 20000 })
    .toContain('amp4email');
  const share = await page.locator('#exOpenShare').getAttribute('href');
  expect(share).toMatch(/^\/b\/[a-z0-9-]+/);
  const res = await request.get(share);
  expect(res.status()).toBe(200);
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.click('#exDownload'),
  ]);
  expect(download.suggestedFilename()).toMatch(/\.html$/);
});

test('tweak: an interactive example prompt-tweaks to version 2', async ({ page, request }) => {
  // New examples are editor-first (doc), which refine in the editor. The
  // prompt-tweak path is for interactive (KV-build) examples, so seed one
  // directly through the still-supported endpoint.
  const pitches = await (await request.get('/api/pitches')).json();
  const pitchId = pitches.items.find((p) => p.title === PITCH_TITLE).id;
  const made = await (await request.post('/api/pitches/' + pitchId + '/examples', {
    data: { title: 'Tweakable spin', moduleId: 'spin', author: 'E2E Tester' },
  })).json();
  expect(made.example && made.example.id).toBeTruthy();

  await openPitch(page);
  await page.locator('#exGrid .ex-card', { hasText: 'Tweakable spin' }).first().click();
  await expect(page.locator('#exDetail')).toBeVisible();
  await expect(page.locator('#exTweakBox')).toBeVisible(); // shown for interactive examples
  await page.fill('#exTweak', '#228833 and 20% off');
  await page.click('#exTweakGo');
  await expect(page.locator('#exVersions .chip')).toHaveCount(2, { timeout: 60000 });
  await expect
    .poll(async () => (await page.locator('#exFrame').getAttribute('srcdoc')) || '', { timeout: 20000 })
    .toContain('#228833');
});

test('assets tab: an uploaded image appears in the grid', async ({ page, request }) => {
  const brandId = await brandIdFor(request);
  const out = await (await request.post('/assets', {
    data: {
      brandId, kind: 'product', filename: 'e2e.png', mime: 'image/png',
      dataBase64: PNG_B64, author: 'E2E Tester',
    },
  })).json();
  expect(out.ok).toBe(true);
  await openPitch(page);
  await page.locator('[data-wtab="assets"]').first().click();
  await expect(page.locator('#assetGrid img')).not.toHaveCount(0, { timeout: 15000 });
});

test('assets tab: contacts add and list', async ({ page }) => {
  await openPitch(page);
  await page.locator('[data-wtab="assets"]').first().click();
  await page.fill('#ctName', 'Meera');
  await page.fill('#ctRole', 'CMO');
  await page.fill('#ctEmail', 'meera@zetworks.example');
  await page.click('#ctAdd');
  await expect(page.locator('#ctList')).toContainText('Meera', { timeout: 15000 });
});

test('details tab: dossier + voice save + activity trail', async ({ page }) => {
  await openPitch(page);
  await page.locator('[data-wtab="details"]').first().click();
  await expect(page.locator('#dtSummary')).toBeVisible();
  await page.fill('#dtVoice', 'Crisp, techy, friendly. Never shouty.');
  await page.click('#dtVoiceSave');
  await expect(page.locator('#dtVoiceMsg')).toContainText(/saved|ok|✓/i, { timeout: 15000 });
  await expect
    .poll(async () => (await page.locator('#dtActivity').textContent()) || '', { timeout: 15000 })
    .toMatch(/created|tweak|added|uploaded/i);
});

test('settings: add a pool key -> masked row -> delete it', async ({ page }) => {
  await gotoHome(page);
  await page.locator('.nav .nav-item', { hasText: 'Settings' }).click();
  await expect(page.locator('#view-settings')).toBeVisible();
  await page.selectOption('#keyProvider', 'groq');
  await page.fill('#keyValue', 'gsk-e2e-test-1234567890');
  await page.fill('#keyLabel', 'e2e temp key');
  await page.click('#keyAdd');
  const row = page.locator('#keysRows tr, #keysRows .key-row').filter({ hasText: 'e2e temp key' });
  await expect(row).toHaveCount(1, { timeout: 15000 });
  await expect(row).toContainText('7890');
  page.once('dialog', (d) => d.accept());
  await row.locator('button').last().click();
  await expect(row).toHaveCount(0, { timeout: 15000 });
});

test('pitches home: the delete control removes a pitch after confirm', async ({ page, request }) => {
  // a throwaway pitch so the shared serial flow's pitch is untouched
  const delTitle = 'Delete me ' + RUN;
  const brand = (await (await request.post('/api/brands', {
    data: { name: 'DelBrand ' + RUN, notes: 'x', author: 'E2E' },
  })).json());
  const bId = (brand.brand || brand).id;
  await request.post('/api/pitches', { data: { brandId: bId, title: delTitle, brief: 'x', author: 'E2E' } });

  await gotoHome(page);
  const card = page.locator('#pitchesList .pitch-card-wrap', { hasText: delTitle });
  await expect(card).toHaveCount(1, { timeout: 15000 });

  page.once('dialog', (d) => d.accept()); // the confirm()
  await card.locator('.pitch-del').click();
  await expect(card).toHaveCount(0, { timeout: 15000 });

  // and it's really gone from the API, not just the DOM
  const after = await (await request.get('/api/pitches')).json();
  expect((after.items || after.pitches || []).some((p) => p.title === delTitle)).toBe(false);
});
