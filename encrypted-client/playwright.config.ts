import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: './tests/browser',
  timeout: 120_000,
  workers: 1,
  retries: 0,
  use: { baseURL: 'http://127.0.0.1:5175', trace: 'off', screenshot: 'off' },
  projects: [
    {
      name: 'chrome',
      use: {
        ...devices['Desktop Chrome'],
        ...(process.platform === 'darwin' ? { channel: 'chrome' } : {}),
      },
    },
  ],
  webServer: {
    command: 'npm run build && npm run preview -- --port 5175',
    url: 'http://127.0.0.1:5175',
    reuseExistingServer: true,
    timeout: 30_000,
  },
});
