'use strict';

// Playwright e2e config. Drives the real UI against a real server, which in turn
// calls the real amphtml-validator — so a green run proves the whole pipeline
// (brand resolution -> generation -> validation -> live preview -> dispatch).
const { defineConfig, devices } = require('@playwright/test');

const PORT = Number(process.env.PORT) || 4000;

module.exports = defineConfig({
  testDir: './tests',
  testMatch: /e2e\.test\.js/,
  // Brand colour resolution can make a real outbound fetch; be generous.
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
    // Never reuse a stray dev server: it may have been started with the real
    // provider keys from .env, and the env block below only governs the
    // server THIS config launches — the whole point is a hermetic run.
    reuseExistingServer: false,
    timeout: 30_000,
    // Hermeticity: server/index.js loads .env via dotenv, and dotenv never
    // overwrites a variable that is already set — even one set to ''. These
    // empty strings therefore shadow any real keys in .env, and every gate in
    // server/ is a plain truthiness check (defaultProviders in
    // brief-content/usecase-engine, detectProviderCall in brand-research, the
    // SMTP check in dispatch), so '' reads as "not configured": the e2e run
    // rides the deterministic zero-key tier — no LLM quota, no live sends.
    // Playwright merges this over process.env, so PATH/PORT still flow.
    env: {
      ANTHROPIC_API_KEY: '',
      GEMINI_API_KEY: '',
      GROQ_API_KEY: '',
      OLLAMA_BASE_URL: '',
      SMTP_HOST: '',
      SMTP_USER: '',
      SMTP_PASS: '',
    },
  },
});
