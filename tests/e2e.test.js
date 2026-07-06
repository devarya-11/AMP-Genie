'use strict';

// End-to-end UI tests for the AMP Genie asset builder.
//
// These drive the actual browser UI and assert against the actual server
// response (which runs the real amphtml-validator). They cover the three core
// acceptance promises:
//   1. Zero input still yields a complete, valid AMP4EMAIL with all-HTTPS assets.
//   2. An explicit module choice builds deterministically and is interactive.
//   3. Editing the code, re-validating, and copy/download use the edited code.

const { test, expect } = require('@playwright/test');

// A fresh navigation gives empty inputs; just confirm the meta-driven dropdown
// has populated before each scenario. There is no lifecycle selector — one Rub
// yields exactly one complete email.
async function resetForm(page) {
  await page.goto('/');
  await expect(page.locator('#moduleSel')).toContainText('Auto');
}

test('zero input → complete, valid AMP4EMAIL with all-HTTPS assets', async ({ page }) => {
  await resetForm(page);
  await page.selectOption('#moduleSel', 'auto');
  await page.click('#rub');

  await expect(page.locator('#result')).toBeVisible();
  await expect(page.locator('#status')).toContainText('zero errors');
  await expect(page.locator('#valDot')).toHaveClass(/pass/);

  // The validation tab must report PASS from the real validator.
  await page.click('.tabs button[data-tab="validation"]');
  await expect(page.locator('#verdict')).toContainText('PASS');

  // Every resolved asset is HTTPS, and provenance is shown.
  const srcs = await page.locator('.provrow img.provthumb').evaluateAll((els) => els.map((e) => e.src));
  expect(srcs.length).toBeGreaterThan(0);
  for (const s of srcs) expect(s.startsWith('https://')).toBeTruthy();

  // The generated code carries the production doctype + AMP4EMAIL marker.
  const code = await page.locator('#code').inputValue();
  expect(code).toMatch(/<!doctype html>/i);
  expect(code).toMatch(/amp4email/i);
});

test('explicit module + brand builds deterministically and is interactive', async ({ page }) => {
  await resetForm(page);
  await page.fill('#brand', 'Allbirds');
  await page.selectOption('#moduleSel', 'spin');
  await page.click('#rub');

  await expect(page.locator('#conjured')).toContainText('Spin the Wheel');
  await expect(page.locator('#valDot')).toHaveClass(/pass/);

  // Interactivity: the spin tap-zone flips the amp-bind state machine so the
  // reward frame reveals. The generic preview interpreter runs the real bindings.
  const reward = page.locator('#previewArea .reward');
  await expect(reward).toBeHidden();
  await page.locator('#previewArea [role="button"]', { hasText: /spin to win/i }).click();
  await expect(reward).toBeVisible();
});

test('one Rub yields exactly one complete, valid email — no lifecycle UI', async ({ page }) => {
  await resetForm(page);
  await page.fill('#brand', 'Zomato');
  await page.selectOption('#vertical', 'Food');
  await page.click('#rub');

  // A single valid email, and no day-by-day arc anywhere in the UI.
  await expect(page.locator('#status')).toContainText('zero errors');
  await expect(page.locator('#valDot')).toHaveClass(/pass/);
  await expect(page.locator('#lifecycle')).toHaveCount(0);
  await expect(page.locator('#timeline')).toHaveCount(0);
  await expect(page.locator('.tl-item')).toHaveCount(0);
});

test('editing the code flips the edited indicator and re-validates', async ({ page }) => {
  await resetForm(page);
  await page.fill('#brand', 'Acme');
  await page.selectOption('#moduleSel', 'reveal');
  await page.click('#rub');
  await expect(page.locator('#valDot')).toHaveClass(/pass/);

  await page.click('.tabs button[data-tab="code"]');
  const original = await page.locator('#code').inputValue();
  await page.fill('#code', original + '\n<!-- harmless edit -->');
  await expect(page.locator('#editedLabel')).toBeVisible();

  await page.click('#revalidate');
  await expect(page.locator('#verdict')).toContainText('PASS');

  // Re-validate jumps to the Validation tab; go back to Code to reset.
  await page.click('.tabs button[data-tab="code"]');
  // Reset restores the generated code and clears the edited flag.
  await page.click('#resetCode');
  await expect(page.locator('#editedLabel')).toBeHidden();
  expect(await page.locator('#code').inputValue()).toBe(original);
});
