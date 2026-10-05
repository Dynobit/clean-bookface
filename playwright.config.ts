import { randomUUID } from 'node:crypto';
import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 45_000,
  use: {
    baseURL: 'http://localhost:3199',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        ...(process.platform === 'darwin' ? { channel: 'chrome' } : {}),
      },
    },
  ],
  webServer: {
    command: 'npm run demo',
    url: 'http://localhost:3199/healthz',
    reuseExistingServer: false,
    timeout: 60_000,
    env: { PORT: '3199', DEMO_DATA_DIR: `./data/e2e-${randomUUID()}`, NODE_ENV: 'test' },
  },
});
