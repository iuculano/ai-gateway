import { defineConfig, devices } from '@playwright/test';
import { appDirectory, authStatePath } from './tests/e2e/paths';

const port = 4178;
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: './tests/e2e',
  outputDir: './test-results',
  globalSetup: './tests/e2e/global-setup.ts',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? [['line'], ['html', { open: 'never' }]] : 'list',
  timeout: 15_000,
  expect: {
    timeout: 5_000,
  },
  use: {
    baseURL: baseURL,
    storageState: authStatePath,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'off',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: `bun run build && PORT=${port} bun run start`,
    cwd: appDirectory,
    // The auth hook answers this unknown API route with 401 before the proxy
    // runs. Playwright treats 401 as ready, so startup needs no test session or
    // identity-provider request.
    url: `${baseURL}/api/e2e-ready`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
