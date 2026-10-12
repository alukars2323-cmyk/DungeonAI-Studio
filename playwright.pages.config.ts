import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: 'browser.spec.ts',
  workers: 1,
  timeout: 30_000,
  use: {
    baseURL: 'http://127.0.0.1:3102/DungeonAI-Studio/',
    headless: true,
    launchOptions: { executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', args: ['--no-sandbox'] },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'npm run preview:pages',
    url: 'http://127.0.0.1:3102/DungeonAI-Studio/',
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
