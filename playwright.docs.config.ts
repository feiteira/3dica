// Screenshot generator for the manual (npm run docs:shots). It drives the real app through its UI, so the tutorials are
// proven to work, and writes docs/public/shots/<name>.png. Separate from the e2e suite (tests/e2e) and from vitest.
// PW_PORT moves the dev server (default 5721, so it never collides with a dev server on 5173).
import { defineConfig, devices } from '@playwright/test'

const port = Number(process.env.PW_PORT) || 5721

export default defineConfig({
  testDir: 'tests/docs',
  outputDir: 'test-results/docs',
  timeout: 120_000,
  expect: { timeout: 15_000 },
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: 'list',
  use: {
    ...devices['Desktop Chrome'],
    baseURL: `http://localhost:${port}`,
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    colorScheme: 'dark',
    acceptDownloads: true,
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }], // Playwright's Chromium; no `channel`
  webServer: {
    command: `npx vite --config tests/docs/vite.config.ts --port ${port} --strictPort`,
    url: `http://localhost:${port}`,
    reuseExistingServer: false,
    timeout: 60_000,
  },
})
