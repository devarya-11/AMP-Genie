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
  // M5: "New example" opens the editor directly (AI drawer is inside it).
  await page.click('#exNew');
  await expect(page.locator('#view-editor')).toBeVisible({ timeout: 30000 });
}

// Read an attribute off every canvas anchor. Each debounced re-render reloads
// the srcdoc iframe, so a query can land mid-navigation and throw "context
// destroyed" — swallow that transient and let the poller try again.
async function canvasAttrs(page, attr) {
  try {
    return await page.frameLocator('#edFrame').locator('[data-bid]')
      .evaluateAll((els, a) => els.map((e) => e.getAttribute(a)), attr);
  } catch (e) {
    if (/context was destroyed|navigation|detached/i.test(e.message)) return [];
    throw e;
  }
}

// The canvas anchors appear a beat before bindCanvas (the iframe onload
// handler) injects #edg-style and wires the edit listeners. Wait for that
// tell before scripting canvas interactions.
async function waitCanvasBound(page) {
  await expect
    .poll(async () => page.evaluate(() => {
      const cd = document.getElementById('edFrame').contentDocument;
      return !!(cd && cd.getElementById('edg-style'));
    }), { timeout: 20000 })
    .toBe(true);
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
  // (M10 added "Heading size/align/colour" too, so match the exact label.)
  const heading = page.locator('#edProps .ctrl')
    .filter({ has: page.getByText('Heading', { exact: true }) }).locator('input');
  await heading.fill(HEADING);

  // Debounced render (~400ms) should land the new heading in the preview.
  await expect
    .poll(async () => (await page.locator('#edFrame').getAttribute('srcdoc')) || '', { timeout: 20000 })
    .toContain(HEADING);
  await expect(page.locator('#edChip')).toContainText('PASS', { timeout: 20000 });
});

test('reorder via the down button, then Save lands the email in the gallery', async ({ page }) => {
  await openEditorFresh(page);
  // Draft a multi-block doc via the AI drawer (a text intro + the interactive
  // module), so there is something to reorder on the canvas.
  await page.fill('#edAiIdea', 'quiz customers on their favourite with a short intro');
  await page.click('#edAiGo');

  // The email IS the canvas: click the first block IN the phone to select it,
  // then move it down one slot via the selection toolbar.
  const canvasOrder = () => canvasAttrs(page, 'data-bid');
  await expect.poll(async () => (await canvasOrder()).length, { timeout: 60000 }).toBeGreaterThan(1);
  await waitCanvasBound(page);
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

test('M4: dragging a palette block into the phone inserts it on the canvas', async ({ page }) => {
  await openEditorFresh(page);
  await page.fill('#edAiIdea', 'quiz with an intro');
  await page.click('#edAiGo');
  const canvasTypes = () => canvasAttrs(page, 'data-btype');
  await expect.poll(async () => (await canvasTypes()).length, { timeout: 60000 }).toBeGreaterThan(1);

  // palette items are draggable
  await expect(page.locator('#edPalette .ed-add-btn').first()).toHaveAttribute('draggable', 'true');

  // The canvas anchors land in the DOM a beat before bindCanvas attaches the
  // drop listeners. A real user's mouse-drag is far slower than that gap; the
  // test isn't, so wait for the tell that bindCanvas ran.
  await waitCanvasBound(page);

  const before = await canvasTypes();
  // drop a Button block onto the first canvas anchor (real DnD across the
  // iframe boundary isn't reliably scriptable, so dispatch the same events the
  // browser fires — proven equivalent to a real drag)
  await page.evaluate(() => {
    const win = document.getElementById('edFrame').contentWindow;
    const cd = win.document;
    const a = cd.querySelector('[data-bid]');
    // build the DataTransfer + event in the IFRAME realm — a parent-realm
    // DataTransfer riding an iframe DragEvent reads back empty via getData().
    const dt = new win.DataTransfer(); dt.setData('text/ed-newblock', 'button');
    const r = a.getBoundingClientRect();
    a.dispatchEvent(new win.DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, clientY: r.top + 3 }));
    a.dispatchEvent(new win.DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt, clientY: r.top + 3 }));
  });
  await expect.poll(async () => (await canvasTypes()).includes('button'), { timeout: 20000 }).toBe(true);
  await expect.poll(async () => (await canvasTypes()).length, { timeout: 20000 }).toBe(before.length + 1);
});

test('M6: the Edit/Preview toggle swaps anchored chrome for the clean AMP', async ({ page }) => {
  await openEditorFresh(page);
  // Draft an interactive doc so Preview mode has a real module to play.
  await page.fill('#edAiIdea', 'quiz customers on their favourite');
  await page.click('#edAiGo');
  const anchorCount = async () => (await canvasAttrs(page, 'data-bid')).length;
  await expect.poll(anchorCount, { timeout: 60000 }).toBeGreaterThan(0);
  await waitCanvasBound(page);

  // Edit mode (default) carries the editor anchors.
  await expect(page.locator('#edModeToggle button[data-mode="edit"]')).toHaveClass(/on/);
  const edited = await anchorCount();

  // Flip to Preview: the canvas re-renders to the shippable AMP — no data-bid
  // chrome — and the module (amp-state) is still present, i.e. playable.
  await page.click('#edModeToggle button[data-mode="preview"]');
  await expect(page.locator('#edModeToggle button[data-mode="preview"]')).toHaveClass(/on/);
  await expect.poll(anchorCount, { timeout: 20000 }).toBe(0);
  await expect
    .poll(async () => (await page.locator('#edFrame').getAttribute('srcdoc')) || '', { timeout: 20000 })
    .toContain('amp-state');
  await expect(page.locator('#edChip')).toContainText('PASS', { timeout: 20000 });

  // Back to Edit: the anchors return so blocks are addressable again.
  await page.click('#edModeToggle button[data-mode="edit"]');
  await expect.poll(anchorCount, { timeout: 20000 }).toBe(edited);
});

test('M6: dragging the resize handle changes a hero block height and stays valid', async ({ page }) => {
  await openEditorFresh(page);
  // Add a Hero from the palette; it auto-selects and mounts a resize handle.
  await page.locator('#edPalette .ed-add-btn', { hasText: 'Hero' }).first().click();
  await expect
    .poll(async () => page.frameLocator('#edFrame').locator('[data-btype="hero"]').count(), { timeout: 60000 })
    .toBeGreaterThan(0);
  await waitCanvasBound(page);

  // The Properties panel exposes the hero height; capture the starting value.
  const heightInput = page.locator('#edProps .ctrl', { hasText: 'Height' }).locator('input');
  await expect(heightInput).toBeVisible({ timeout: 20000 });
  const startH = Number(await heightInput.inputValue()) || 240;

  // Drag the handle down ~120px — dispatch the pointer sequence in the iframe
  // realm (the handle lives inside the srcdoc document).
  const moved = await page.evaluate(() => {
    const win = document.getElementById('edFrame').contentWindow;
    const cd = win.document;
    const handle = cd.querySelector('.edg-resize');
    if (!handle) return false;
    const r = handle.getBoundingClientRect();
    const at = (y) => ({ bubbles: true, cancelable: true, clientX: r.left + 20, clientY: y, pointerId: 1 });
    handle.dispatchEvent(new win.PointerEvent('pointerdown', at(r.top)));
    handle.dispatchEvent(new win.PointerEvent('pointermove', at(r.top + 120)));
    handle.dispatchEvent(new win.PointerEvent('pointerup', at(r.top + 120)));
    return true;
  });
  expect(moved, 'the resize handle was present').toBe(true);

  // The new height commits to the panel (taller than we started) and the
  // re-rendered email is still valid AMP.
  await expect.poll(async () => Number(await heightInput.inputValue()), { timeout: 20000 }).toBeGreaterThan(startH);
  await expect(page.locator('#edChip')).toContainText('PASS', { timeout: 20000 });
});

test('M8: dragging a block onto another reorders the canvas and stays valid', async ({ page }) => {
  await openEditorFresh(page);
  await page.fill('#edAiIdea', 'quiz customers on their favourite with a short intro');
  await page.click('#edAiGo');
  const order = () => canvasAttrs(page, 'data-bid');
  await expect.poll(async () => (await order()).length, { timeout: 60000 }).toBeGreaterThan(1);
  await waitCanvasBound(page);
  const before = await order();

  // canvas anchors are draggable
  const draggable = await page.frameLocator('#edFrame').locator('[data-bid]').first().getAttribute('draggable');
  expect(draggable).toBe('true');

  // Drag the FIRST block onto the LAST, dropping below its midpoint (after it).
  // Dispatch the DnD sequence in the iframe realm (cross-iframe DnD isn't
  // scriptable), same pattern as the M4 palette-drop test.
  await page.evaluate(() => {
    const win = document.getElementById('edFrame').contentWindow;
    const cd = win.document;
    const anchors = cd.querySelectorAll('[data-bid]');
    const src = anchors[0], tgt = anchors[anchors.length - 1];
    const dt = new win.DataTransfer(); dt.setData('text/block-id', src.getAttribute('data-bid'));
    src.dispatchEvent(new win.DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
    const r = tgt.getBoundingClientRect();
    const y = r.top + r.height - 2; // below midpoint -> drop AFTER
    tgt.dispatchEvent(new win.DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, clientY: y }));
    tgt.dispatchEvent(new win.DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt, clientY: y }));
  });

  // the moved block (was first) is now last, and the email is still valid
  await expect.poll(async () => (await order()).indexOf(before[0]), { timeout: 20000 })
    .toBe((await order()).length - 1);
  await expect(page.locator('#edChip')).toContainText('PASS', { timeout: 20000 });
});

test('M9/M10: block styling controls re-render valid AMP with a scoped rule', async ({ page }) => {
  await openEditorFresh(page);
  await page.locator('#edPalette .ed-add-btn', { hasText: 'Text' }).first().click();
  await waitCanvasBound(page);
  // set a background colour on the block via the Spacing & background swatch
  await page.locator('#edProps .ctrl').filter({ hasText: 'Background' }).locator('input[type=color]').fill('#123456');
  // the re-rendered AMP carries the scoped instance rule and still PASSes
  await expect
    .poll(async () => (await page.locator('#edFrame').getAttribute('srcdoc')) || '', { timeout: 20000 })
    .toContain('background:#123456;');
  await expect(page.locator('#edChip')).toContainText('PASS', { timeout: 20000 });
});

test('M12: email settings apply a global background when nothing is selected', async ({ page }) => {
  await openEditorFresh(page);
  await page.fill('#edAiIdea', 'quiz with an intro');
  await page.click('#edAiGo');
  await expect.poll(async () => (await canvasAttrs(page, 'data-bid')).length, { timeout: 60000 }).toBeGreaterThan(0);
  await waitCanvasBound(page);
  // deselect (Escape) -> the Email settings panel shows
  await page.frameLocator('#edFrame').locator('[data-bid]').first().click();
  await page.keyboard.press('Escape');
  await expect(page.locator('#edProps')).toContainText('Email settings', { timeout: 10000 });
  await page.locator('#edProps .ctrl').filter({ hasText: 'Background' }).locator('input[type=color]').fill('#0a0a12');
  await expect
    .poll(async () => (await page.locator('#edFrame').getAttribute('srcdoc')) || '', { timeout: 20000 })
    .toContain('body{background:#0a0a12;}');
  await expect(page.locator('#edChip')).toContainText('PASS', { timeout: 20000 });
});

test('M13: undo/redo add a block via keyboard and toolbar', async ({ page }) => {
  await openEditorFresh(page);
  await page.fill('#edAiIdea', 'quiz with an intro');
  await page.click('#edAiGo');
  const count = async () => (await canvasAttrs(page, 'data-bid')).length;
  await expect.poll(count, { timeout: 60000 }).toBeGreaterThan(0);
  await waitCanvasBound(page);
  const base = await count();

  await page.locator('#edPalette .ed-add-btn', { hasText: 'Text' }).first().click();
  await expect.poll(count, { timeout: 20000 }).toBe(base + 1);

  // undo via keyboard removes it; canvas re-renders valid
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(count, { timeout: 20000 }).toBe(base);
  await expect(page.locator('#edChip')).toContainText('PASS', { timeout: 20000 });

  // redo via toolbar button brings it back
  await expect(page.locator('#edRedo')).toBeEnabled();
  await page.click('#edRedo');
  await expect.poll(count, { timeout: 20000 }).toBe(base + 1);
});

test('AMP code viewer: the </> modal and the left panel show the live source', async ({ page }) => {
  await openEditorFresh(page);
  await page.fill('#edAiIdea', 'quiz with an intro');
  await page.click('#edAiGo');
  await expect.poll(async () => (await canvasAttrs(page, 'data-bid')).length, { timeout: 60000 }).toBeGreaterThan(0);
  await expect(page.locator('#edChip')).toContainText('PASS', { timeout: 20000 });

  // canvas-bar </> opens the modal with the real AMP4EMAIL source
  await page.click('#edCodeBtn');
  await expect(page.locator('#edCodeModal')).toBeVisible();
  await expect.poll(async () => await page.locator('#edCodeModalText').inputValue(), { timeout: 10000 }).toContain('amp4email');
  await page.keyboard.press('Escape');
  await expect(page.locator('#edCodeModal')).toBeHidden();

  // left-column panel toggles open and mirrors the same source
  await page.click('#edCodeToggle');
  await expect(page.locator('#edCodePanel')).toBeVisible();
  await expect.poll(async () => await page.locator('#edCodeText').inputValue(), { timeout: 10000 }).toContain('<html amp4email');
});

test('Custom AMP block: paste + Fix with AI compiles a valid fragment onto the canvas', async ({ page }) => {
  await openEditorFresh(page);
  await page.locator('#edPalette .ed-add-btn', { hasText: 'Custom AMP' }).first().click();
  await waitCanvasBound(page);
  // the empty placeholder renders on the canvas
  await expect
    .poll(async () => (await page.locator('#edFrame').getAttribute('srcdoc')) || '', { timeout: 20000 })
    .toContain('Fix with AI');

  // paste a valid fragment and adapt it (hermetic env -> deterministic path)
  await page.locator('#edProps .ed-custom-raw').fill('<p style="font-size:18px">Hello from a custom AMP block</p>');
  await page.locator('#edProps button', { hasText: 'Fix with AI' }).click();
  await expect(page.locator('#edCustomStatus')).toContainText(/valid|applied/i, { timeout: 30000 });

  // the compiled fragment lands on the canvas and the email still PASSes
  await expect
    .poll(async () => (await page.locator('#edFrame').getAttribute('srcdoc')) || '', { timeout: 20000 })
    .toContain('Hello from a custom AMP block');
  await expect(page.locator('#edChip')).toContainText('PASS', { timeout: 20000 });
});

test('Custom AMP block: an executable script in the paste is stripped', async ({ page }) => {
  await openEditorFresh(page);
  await page.locator('#edPalette .ed-add-btn', { hasText: 'Custom AMP' }).first().click();
  await waitCanvasBound(page);
  await page.locator('#edProps .ed-custom-raw').fill('<div><script>window.__pwned=1</script><p>safe copy</p></div>');
  await page.locator('#edProps button', { hasText: 'Fix with AI' }).click();
  await expect(page.locator('#edCustomStatus')).toContainText(/valid|applied/i, { timeout: 30000 });
  // wait for the debounced re-render to land the sanitized fragment
  await expect
    .poll(async () => (await page.locator('#edFrame').getAttribute('srcdoc')) || '', { timeout: 20000 })
    .toContain('safe copy');
  const src = (await page.locator('#edFrame').getAttribute('srcdoc')) || '';
  expect(src).not.toContain('__pwned'); // the executable script never reaches the iframe
  await expect(page.locator('#edChip')).toContainText('PASS', { timeout: 20000 });
});

test('M14: Delete removes the selected block; Backspace in a field does not', async ({ page }) => {
  await openEditorFresh(page);
  await page.fill('#edAiIdea', 'quiz customers with a short intro');
  await page.click('#edAiGo');
  const count = async () => (await canvasAttrs(page, 'data-bid')).length;
  await expect.poll(count, { timeout: 60000 }).toBeGreaterThan(1);
  await waitCanvasBound(page);
  const base = await count();

  // Backspace while a property field holds focus must NOT delete a block
  await page.frameLocator('#edFrame').locator('[data-bid]').first().click();
  await page.locator('#edProps input[type=text], #edProps textarea').first().click();
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(300);
  expect(await count()).toBe(base);

  // Delete with the canvas focused removes the selected block
  await page.frameLocator('#edFrame').locator('[data-bid]').first().click();
  await page.keyboard.press('Delete');
  await expect.poll(count, { timeout: 20000 }).toBe(base - 1);
  await expect(page.locator('#edChip')).toContainText('PASS', { timeout: 20000 });
});
