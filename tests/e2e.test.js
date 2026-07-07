'use strict';

// End-to-end UI tests for the AMP Genie. These drive the real browser UI
// against the real server, which runs the real amphtml-validator and the
// real dispatch path. There is no module picker in the UI — the genie
// chooses one of the 6 modules deterministically from brand + a reroll
// counter, so tests that need a specific module click "Surprise me again"
// until it shows up (bounded, so a missing module fails loudly).

const { test, expect } = require('@playwright/test');

async function resetForm(page) {
  await page.goto('/');
  // Dropdowns are populated from /api/meta after load.
  await expect(page.locator('#vertical option')).not.toHaveCount(0);
  await expect(page.locator('#tone option')).not.toHaveCount(0);
}

async function rerollUntil(page, predicate, maxTries = 20) {
  for (let i = 0; i < maxTries; i++) {
    if (await predicate()) return i;
    await page.click('#surprise');
    await page.waitForTimeout(150);
  }
  throw new Error('Desired module did not appear within ' + maxTries + ' rerolls');
}

// The AMP code and Validation tabs are hidden by default behind the
// "Developer view" toggle (off by default, in-memory only). Tests that need
// to inspect the code editor or the validation verdict panel must flip it on
// first, since Playwright's click()/fill() auto-wait on visibility and the
// gated elements are display:none until the toggle is checked. The checkbox
// itself is visually hidden (0x0, the real switch is CSS drawn from its
// sibling spans), so — like a real user — we click the visible track, which
// natively toggles the nested input via the wrapping <label>.
async function enableDevMode(page) {
  await page.click('.devtoggle-track');
}

test('zero input still yields a complete, valid AMP4EMAIL', async ({ page }) => {
  await resetForm(page);
  await page.click('#rub');

  await expect(page.locator('#result')).toBeVisible();
  await expect(page.locator('#status')).toContainText('zero errors');
  await expect(page.locator('#valDot')).toHaveClass(/pass/);

  await enableDevMode(page);
  await page.click('.tabs button[data-tab="validation"]');
  await expect(page.locator('#verdict')).toContainText('PASS');
  await expect(page.locator('#errors li')).toHaveCount(0);

  const code = await page.locator('#code').inputValue();
  expect(code).toMatch(/<!doctype html>/i);
  expect(code).toMatch(/amp4email/i);
});

test('brand, vertical, and tone flow through to chips and code', async ({ page }) => {
  await resetForm(page);
  await page.fill('#brand', 'Nykaa');
  await page.selectOption('#vertical', 'Fashion');
  await page.selectOption('#tone', 'Playful');
  await page.click('#rub');

  await expect(page.locator('#valDot')).toHaveClass(/pass/);
  await expect(page.locator('#chips')).toContainText('Nykaa');
  await expect(page.locator('#chips')).toContainText('Fashion');
  await expect(page.locator('#chips')).toContainText('Playful');

  const code = await page.locator('#code').inputValue();
  expect(code).toContain('Nykaa');
});

test('result panel exposes exactly three tabs — no checklist tab', async ({ page }) => {
  await resetForm(page);
  await page.click('#rub');
  await expect(page.locator('#result')).toBeVisible();

  const tabs = page.locator('.tabs button');
  await expect(tabs).toHaveCount(3);
  const labels = (await tabs.allTextContents()).map((t) => t.trim());
  expect(labels.some((l) => /live preview/i.test(l))).toBeTruthy();
  expect(labels.some((l) => /amp code/i.test(l))).toBeTruthy();
  expect(labels.some((l) => /validation/i.test(l))).toBeTruthy();
  expect(labels.some((l) => /checklist/i.test(l))).toBeFalsy();
});

test('AMP code and Validation tabs are hidden by default, behind Developer view', async ({ page }) => {
  await resetForm(page);
  await page.click('#rub');
  await expect(page.locator('#result')).toBeVisible();

  await expect(page.locator('#devToggle')).not.toBeChecked();
  await expect(page.locator('.tabs button[data-tab="code"]')).toBeHidden();
  await expect(page.locator('.tabs button[data-tab="validation"]')).toBeHidden();
  await expect(page.locator('.tabs button[data-tab="preview"]')).toBeVisible();

  await enableDevMode(page);
  await expect(page.locator('.tabs button[data-tab="code"]')).toBeVisible();
  await expect(page.locator('.tabs button[data-tab="validation"]')).toBeVisible();

  await page.click('.tabs button[data-tab="code"]');
  await expect(page.locator('#code')).toBeVisible();

  // Switching Developer view back off snaps the active tab back to preview,
  // rather than leaving the user stranded on a pane that just disappeared.
  await page.click('.devtoggle-track');
  await expect(page.locator('#devToggle')).not.toBeChecked();
  await expect(page.locator('.tabs button[data-tab="code"]')).toBeHidden();
  await expect(page.locator('.pane[data-pane="preview"]')).toHaveClass(/on/);
});

test('an explicit brand override colour is reflected in the chip', async ({ page }) => {
  await resetForm(page);
  await page.fill('#brand', 'Acme');
  await page.fill('#colorhex', '#123abc');
  await page.dispatchEvent('#colorhex', 'input');
  await page.click('#rub');

  await expect(page.locator('#valDot')).toHaveClass(/pass/);
  await expect(page.locator('#chips')).toContainText('#123abc');
  await expect(page.locator('#chips')).toContainText('override');
});

test('a known brand resolves to its curated library colour', async ({ page }) => {
  await resetForm(page);
  await page.fill('#brand', 'Nykaa');
  await page.click('#rub');

  await expect(page.locator('#valDot')).toHaveClass(/pass/);
  await expect(page.locator('#chips')).toContainText('#fc2779');
  await expect(page.locator('#chips')).toContainText('library');
});

// This one makes a real outbound request (server-side, in server/brand.js) to
// a brand with no library entry but a real, reachable site — exercising the
// live theme-color/dominant-colour fetch tier for real rather than mocking it,
// since the fetch happens in Node, not in the page Playwright controls.
test('an unrecognised-but-real brand resolves via a live site fetch', async ({ page }) => {
  await resetForm(page);
  await page.fill('#brand', 'Stripe');
  await page.click('#rub');

  await expect(page.locator('#valDot')).toHaveClass(/pass/, { timeout: 20_000 });
  await expect(page.locator('#chips')).toContainText('fetched');
});

test('a brand with no resolvable site falls back to a deterministic hash colour', async ({ page }) => {
  await resetForm(page);
  await page.fill('#brand', 'Zzzqqnonexistentbrandxyz123');
  await page.click('#rub');

  await expect(page.locator('#valDot')).toHaveClass(/pass/, { timeout: 20_000 });
  await expect(page.locator('#chips')).toContainText('hash');
});

test('the spin-to-win module is interactive in the live preview', async ({ page }) => {
  await resetForm(page);
  await page.fill('#brand', 'Allbirds');
  await page.click('#rub');
  await expect(page.locator('#valDot')).toHaveClass(/pass/);

  await rerollUntil(page, async () =>
    /spin/i.test((await page.locator('#conjured').textContent()) || '')
  );

  const reward = page.locator('[data-testid="spin-reward"]');
  await expect(reward).toBeHidden();
  await page.click('[data-testid="spin-btn"]');
  await expect(reward).toBeVisible();
});

test('the reveal-the-offer module is interactive in the live preview', async ({ page }) => {
  await resetForm(page);
  await page.fill('#brand', 'Zomato');
  await page.click('#rub');
  await expect(page.locator('#valDot')).toHaveClass(/pass/);

  await rerollUntil(page, async () =>
    /reveal/i.test((await page.locator('#conjured').textContent()) || '')
  );

  const offer = page.locator('[data-testid="reveal-offer"]');
  await expect(offer).toBeHidden();
  await page.click('[data-testid="reveal-btn"]');
  await expect(offer).toBeVisible();
});

test('the search & filter module filters live in the preview', async ({ page }) => {
  await resetForm(page);
  await page.fill('#brand', 'Myntra');
  await page.click('#rub');
  await expect(page.locator('#valDot')).toHaveClass(/pass/);

  await rerollUntil(page, async () =>
    /search/i.test((await page.locator('#conjured').textContent()) || '')
  );

  const grid = page.locator('[data-testid="search-grid"]');
  await expect(grid.locator('.pv-card')).not.toHaveCount(0);
  await page.fill('[data-testid="search-input"]', 'zzz-no-such-product-zzz');
  await expect(grid).toContainText('No products match.');
  await page.fill('[data-testid="search-input"]', '');
  await expect(grid.locator('.pv-card')).not.toHaveCount(0);
});

test('the quiz & match module reveals a personalised result on tap', async ({ page }) => {
  await resetForm(page);
  await page.fill('#brand', 'Groww');
  await page.click('#rub');
  await expect(page.locator('#valDot')).toHaveClass(/pass/);

  await rerollUntil(page, async () =>
    /quiz/i.test((await page.locator('#conjured').textContent()) || '')
  );

  const result = page.locator('[data-testid="quiz-result"]');
  await expect(result).toBeHidden();
  await page.locator('[data-testid^="quiz-opt-"]').first().click();
  await expect(result).toBeVisible();
  await expect(result).not.toBeEmpty();
});

test('the star rating module fills stars and confirms the score on tap', async ({ page }) => {
  await resetForm(page);
  await page.fill('#brand', 'Nykaa');
  await page.click('#rub');
  await expect(page.locator('#valDot')).toHaveClass(/pass/);

  await rerollUntil(page, async () =>
    /rating/i.test((await page.locator('#conjured').textContent()) || '')
  );

  const confirm = page.locator('[data-testid="rating-confirm"]');
  await expect(confirm).toBeEmpty();
  // Stars are SVG elements — dispatch a real click event rather than relying
  // on Playwright's .click(), which is fine here since the handler is a plain
  // addEventListener('click', ...) either way.
  await page.locator('[data-testid="star-4"]').dispatchEvent('click');
  await expect(confirm).toContainText('You rated 4 out of 5');
});

test('the this-or-that poll reveals a result after voting', async ({ page }) => {
  await resetForm(page);
  await page.fill('#brand', 'Swiggy');
  await page.click('#rub');
  await expect(page.locator('#valDot')).toHaveClass(/pass/);

  await rerollUntil(page, async () =>
    /poll/i.test((await page.locator('#conjured').textContent()) || '')
  );

  const result = page.locator('[data-testid="poll-result"]');
  await expect(result).toBeHidden();
  await page.click('[data-testid="poll-a"]');
  await expect(result).toBeVisible();
  await expect(result).not.toBeEmpty();
});

test('editing the code flips the edited indicator, re-validates, and resets cleanly', async ({ page }) => {
  await resetForm(page);
  await page.fill('#brand', 'Acme');
  await page.click('#rub');
  await expect(page.locator('#valDot')).toHaveClass(/pass/);

  await enableDevMode(page);
  await page.click('.tabs button[data-tab="code"]');
  const original = await page.locator('#code').inputValue();
  await expect(page.locator('#editedLabel')).toBeHidden();

  await page.fill('#code', original.replace('</style>', '--x:1;}</style>'));
  await expect(page.locator('#editedLabel')).toBeVisible();

  await page.click('#revalidate');
  await expect(page.locator('#verdict')).toContainText('FAIL');
  await expect(page.locator('#errors li')).not.toHaveCount(0);

  await page.click('.tabs button[data-tab="code"]');
  await page.click('#resetCode');
  await expect(page.locator('#editedLabel')).toBeHidden();
  expect(await page.locator('#code').inputValue()).toBe(original);

  await page.click('.tabs button[data-tab="validation"]');
  await expect(page.locator('#verdict')).toContainText('PASS');
});

test('copy writes the current (possibly edited) code to the clipboard', async ({ page, context, baseURL }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: baseURL });
  await resetForm(page);
  await page.fill('#brand', 'Acme');
  await page.click('#rub');
  await expect(page.locator('#valDot')).toHaveClass(/pass/);

  await enableDevMode(page);
  await page.click('.tabs button[data-tab="code"]');
  const original = await page.locator('#code').inputValue();
  const edited = original + '\n<!-- e2e copy check -->';
  await page.fill('#code', edited);

  await page.click('#copy');
  const clipped = await page.evaluate(() => navigator.clipboard.readText());
  expect(clipped).toBe(edited);
});

test('download produces a file whose bytes match the current (possibly edited) code', async ({ page }) => {
  await resetForm(page);
  await page.fill('#brand', 'Acme');
  await page.click('#rub');
  await expect(page.locator('#valDot')).toHaveClass(/pass/);

  await enableDevMode(page);
  await page.click('.tabs button[data-tab="code"]');
  const original = await page.locator('#code').inputValue();
  const edited = original + '\n<!-- e2e download check -->';
  await page.fill('#code', edited);

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.click('#download'),
  ]);
  const stream = await download.createReadStream();
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  const bytes = Buffer.concat(chunks).toString('utf-8');
  expect(bytes).toBe(edited);
});

test('dispatch without SMTP configured fails gracefully with a clear message', async ({ page }) => {
  await resetForm(page);
  await page.fill('#brand', 'Acme');
  await page.click('#rub');
  await expect(page.locator('#valDot')).toHaveClass(/pass/);

  await page.fill('#dispatchTo', 'someone@example.com');
  await page.click('#dispatch');
  await expect(page.locator('#dispatchMsg')).toContainText(/smtp|failed/i, { timeout: 15_000 });
});

test('dispatch requires a recipient before calling the server', async ({ page }) => {
  await resetForm(page);
  await page.fill('#brand', 'Acme');
  await page.click('#rub');
  await expect(page.locator('#valDot')).toHaveClass(/pass/);

  await page.click('#dispatch');
  await expect(page.locator('#dispatchMsg')).toContainText(/recipient/i);
});

test('the Rub button shows the genie-lamp smoke animation while building and disables itself', async ({ page }) => {
  await resetForm(page);
  // Delay the real /generate response so the loading state is observable —
  // it otherwise resolves too fast locally to reliably catch mid-flight.
  await page.route('**/generate', async (route) => {
    await new Promise((r) => setTimeout(r, 600));
    await route.continue();
  });
  await page.fill('#brand', 'Acme');
  await page.click('#rub');

  await expect(page.locator('#rub')).toBeDisabled();
  await expect(page.locator('#rub .lamp-anim')).toBeVisible();
  await expect(page.locator('#rub .lamp-anim .wisp')).toHaveCount(3);

  await expect(page.locator('#valDot')).toHaveClass(/pass/, { timeout: 10_000 });
  // The loading affordance is fully cleaned up afterwards: back to the
  // resting label, re-enabled, no leftover lamp/burst markup.
  await expect(page.locator('#rub')).toBeEnabled();
  await expect(page.locator('#rub .lamp-anim')).toHaveCount(0);
  await expect(page.locator('#rub')).toContainText('Rub the');
});

// ---------- campaign brief: captured metadata, never interpreted ----------

test('a campaign brief is trimmed, round-tripped to the result, and never truncated', async ({ page }) => {
  await resetForm(page);
  await page.fill('#brand', 'BriefCo');
  await page.fill('#campaignBrief', '  Needs to hit our loyalty API on redeem.  ');
  await expect(page.locator('#briefCount')).toHaveText('43/2000');

  await page.click('#rub');
  await expect(page.locator('#valDot')).toHaveClass(/pass/);

  // Trimmed, and rendered (escaped) alongside the current result. Playwright's
  // text matchers normalize whitespace, so assert the exact trimmed string
  // via innerText to actually prove the leading/trailing spaces are gone.
  await expect(page.locator('#briefNote')).toBeVisible();
  const noteText = (await page.locator('#briefNote').innerText()).trim();
  expect(noteText).toBe('Brief: Needs to hit our loyalty API on redeem.');
});

test('a whitespace-only brief is treated as no brief given', async ({ page }) => {
  await resetForm(page);
  await page.fill('#brand', 'NoBriefCo');
  await page.fill('#campaignBrief', '     ');
  await page.click('#rub');
  await expect(page.locator('#valDot')).toHaveClass(/pass/);
  await expect(page.locator('#briefNote')).toBeHidden();
});

test('an empty brief does not block generation — the field is fully optional', async ({ page }) => {
  await resetForm(page);
  await page.fill('#brand', 'PlainCo');
  await page.click('#rub');
  await expect(page.locator('#valDot')).toHaveClass(/pass/);
  await expect(page.locator('#briefNote')).toBeHidden();
});

test('a brief over the soft limit disables Rub the lAMP without truncating the text', async ({ page }) => {
  await resetForm(page);
  const long = 'x'.repeat(2001);
  await page.fill('#campaignBrief', long);

  await expect(page.locator('#briefCount')).toHaveText('2001/2000');
  await expect(page.locator('#briefWarn')).toBeVisible();
  await expect(page.locator('#rub')).toBeDisabled();
  // Never a silent cutoff — every character typed is still in the field.
  expect(await page.locator('#campaignBrief').inputValue()).toHaveLength(2001);

  // Trim back down: warning clears and submit re-enables.
  await page.fill('#campaignBrief', 'short brief');
  await expect(page.locator('#briefWarn')).toBeHidden();
  await expect(page.locator('#rub')).toBeEnabled();
});

test('recent builds appear in the read-only history list with brief previews', async ({ page }) => {
  await resetForm(page);
  await page.fill('#brand', 'HistoryCo');
  await page.fill('#campaignBrief', 'Should match our Diwali sale email from last year.');
  await page.click('#rub');
  await expect(page.locator('#valDot')).toHaveClass(/pass/);

  await expect(page.locator('#historySection')).toBeVisible();
  const first = page.locator('.history-item').first();
  await expect(first).toContainText('HistoryCo');
  await expect(first).toContainText('Should match our Diwali sale email from last year.');
});
