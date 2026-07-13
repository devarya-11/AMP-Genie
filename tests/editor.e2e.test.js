'use strict';

// GENIE 2.0 Phase 4 e2e — the visual block editor. Runs under the same
// hermetic playwright.config.js as e2e.test.js (SUPABASE_* + LLM keys +
// TEAM_PASSWORD blanked), so every render/save rides the deterministic
// zero-key tier: the /api/docs/render call hits the real amphtml-validator,
// proving the block-doc -> AMP -> PASS pipeline end to end, no network.
//
// Brand+pitch are created through the API (as any client would), then the
// UI is driven exactly as a user would. A unique nonsense brand keeps every
// assertion scoped — the shared .data/ never pollutes this run.

const { test, expect } = require('@playwright/test');

const RUN = 'edit' + Math.random().toString(36).slice(2, 8);
const BRAND = 'Edifice ' + RUN;
const PITCH_TITLE = 'Editor pitch ' + RUN;
const EMAIL_TITLE = 'Block email ' + RUN;
const HEADING = 'Marker heading ' + RUN;

test.describe.configure({ mode: 'serial' });

// Seed a brand + pitch straight through the API, the same shapes the wizard
// posts. Returns the pitch id so the UI can be pointed at it.
let PITCH_ID = null;
test.beforeAll(async ({ request }) => {
  const brandRes = await (await request.post('/api/brands', {
    data: { name: BRAND, notes: 'A fictional building-materials brand for editor testing.', author: 'Editor E2E' },
  })).json();
  const brand = brandRes.brand || brandRes;
  expect(brand && brand.id, 'brand created').toBeTruthy();

  const pitchRes = await (await request.post('/api/pitches', {
    data: { brandId: brand.id, title: PITCH_TITLE, brief: 'Launch email with a hero and a call to action.', author: 'Editor E2E' },
  })).json();
  const pitch = pitchRes.pitch || pitchRes;
  expect(pitch && pitch.id, 'pitch created').toBeTruthy();
  PITCH_ID = pitch.id;
});

async function openPitch(page) {
  await page.goto('/');
  await expect(page.locator('#view-pitches')).toBeVisible();
  await page.locator('#pitchesList .pitch-card', { hasText: PITCH_TITLE }).first().click();
  await expect(page.locator('#view-pitch')).toBeVisible();
}

async function openEditorFresh(page) {
  await openPitch(page);
  await page.click('#exNew');
  await expect(page.locator('#genPanel')).toBeVisible();
  await page.click('#edNew');
  await expect(page.locator('#view-editor')).toBeVisible({ timeout: 30000 });
}

test('editor opens from the Examples tab with a live, valid AMP preview', async ({ page }) => {
  await openEditorFresh(page);
  // The preview iframe is rendered server-side and must be valid AMP4EMAIL.
  await expect
    .poll(async () => (await page.locator('#edFrame').getAttribute('srcdoc')) || '', { timeout: 25000 })
    .toContain('amp4email');
  await expect(page.locator('#edChip')).toContainText('PASS', { timeout: 25000 });
  // The palette exposes every block type.
  await expect(page.locator('#edPalette .ed-add-btn')).not.toHaveCount(0);
});

test('adding a text block and editing its heading re-renders the preview', async ({ page }) => {
  await openEditorFresh(page);
  await expect(page.locator('#edChip')).toContainText('PASS', { timeout: 25000 });
  const before = await page.locator('#edBlocks .ed-block').count();

  // Add a Text block from the palette.
  await page.locator('#edPalette .ed-add-btn', { hasText: 'Text' }).first().click();
  await expect(page.locator('#edBlocks .ed-block')).toHaveCount(before + 1);

  // The newly-added block is auto-selected; its Heading field is in Properties.
  const heading = page.locator('#edProps .ctrl', { hasText: 'Heading' }).locator('input');
  await heading.fill(HEADING);

  // Debounced render (~400ms) should land the new heading in the preview.
  await expect
    .poll(async () => (await page.locator('#edFrame').getAttribute('srcdoc')) || '', { timeout: 20000 })
    .toContain(HEADING);
  await expect(page.locator('#edChip')).toContainText('PASS', { timeout: 20000 });
});

test('reorder via the down button, then Save lands the email in the gallery', async ({ page }) => {
  await openEditorFresh(page);
  await expect(page.locator('#edChip')).toContainText('PASS', { timeout: 25000 });

  // The email IS the canvas: the fresh doc already has >1 block (a text intro
  // + the interactive module). Click the first block IN the phone to select
  // it, then move it down one slot via the selection toolbar.
  const canvasOrder = () => page.frameLocator('#edFrame').locator('[data-bid]')
    .evaluateAll((els) => els.map((e) => e.getAttribute('data-bid')));
  await expect.poll(async () => (await canvasOrder()).length, { timeout: 20000 }).toBeGreaterThan(1);
  const before = await canvasOrder();
  await page.frameLocator('#edFrame').locator('[data-bid]').first().click();
  await expect(page.locator('#edSelBar button[title="Move down"]')).toBeVisible();
  await page.locator('#edSelBar button[title="Move down"]').click();
  // the moved block (was first) is now later in the canvas order
  await expect.poll(async () => (await canvasOrder()).indexOf(before[0]), { timeout: 20000 }).toBeGreaterThan(0);

  // Title + Save -> a doc example is created and the indicator flips to Saved.
  await page.fill('#edTitle', EMAIL_TITLE);
  await page.click('#edSave');
  await expect(page.locator('#edSaved')).toContainText(/saved/i, { timeout: 30000 });
  await expect(page.locator('#edSaveErr')).not.toContainText(/error/i);

  // Back to the pitch: the gallery now carries the new email as a card.
  await page.click('#edBack');
  await expect(page.locator('#view-pitch')).toBeVisible();
  await expect(page.locator('#exGrid .ex-card', { hasText: EMAIL_TITLE })).toHaveCount(1, { timeout: 15000 });
});

test('reopening the saved email in the editor loads its blocks', async ({ page }) => {
  await openPitch(page);
  await page.locator('#exGrid .ex-card', { hasText: EMAIL_TITLE }).first().click();
  await expect(page.locator('#exDetail')).toBeVisible();
  // A doc example surfaces the "Edit in editor" button.
  await expect(page.locator('#exEditDoc')).toBeVisible({ timeout: 15000 });
  await page.click('#exEditDoc');
  await expect(page.locator('#view-editor')).toBeVisible({ timeout: 15000 });

  // The doc round-trips: the title survived and the canvas re-renders the
  // saved blocks (addressable in the phone) including the interactive module.
  await expect(page.locator('#edTitle')).toHaveValue(EMAIL_TITLE);
  await expect
    .poll(async () => page.frameLocator('#edFrame').locator('[data-bid]').count(), { timeout: 25000 })
    .toBeGreaterThan(0);
  await expect
    .poll(async () => (await page.locator('#edFrame').getAttribute('srcdoc')) || '', { timeout: 25000 })
    .toContain('amp-bind');
});
