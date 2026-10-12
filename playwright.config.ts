import { defineConfig } from '@playwright/test';
import { randomUUID } from 'node:crypto';

const dataDir = `/tmp/dungeonai-e2e-${randomUUID()}`;

export default defineConfig({
  testDir: './tests/e2e',
  testIgnore: 'browser.spec.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  use: {
    baseURL: 'http://127.0.0.1:3101',
    headless: true,
    launchOptions: {
      executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium',
      args: ['--no-sandbox'],
    },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: `PORT=3101 DUNGEON_AI_KEY= DUNGEON_DATA_DIR=${dataDir} npm run dev`,
    url: 'http://127.0.0.1:3101/api/health',
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
