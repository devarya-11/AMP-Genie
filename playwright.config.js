'use strict';

// Playwright e2e config. Drives the real UI against a real server, which in turn
// calls the real amphtml-validator — so a green run proves the whole pipeline
// (intake -> asset resolution -> production build -> validation -> preview).
const { defineConfig, devices } = require('@playwright/test');

const PORT = Number(process.env.PORT) || 4000;

module.exports = defineConfig({
  testDir: './tests',
  testMatch: /e2e\.test\.js/,
  // Asset resolution makes real network calls with timeouts; be generous.
  timeout: 60_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${PORT}`,
    headless: true,
    actionTimeout: 15_000,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'node server/index.js',
    url: `http://localhost:${PORT}/api/meta`,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
