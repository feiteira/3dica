import { defineConfig, devices } from '@playwright/test'
const preview = process.env.PW_PREVIEW === '1'
// PW_PORT lets several runs use e2e at once on different ports. Defaults: 5173 dev, 4173 preview.
const port = Number(process.env.PW_PORT) || (preview ? 4173 : 5173)
export default defineConfig({
  testDir: 'tests/e2e', timeout: 60_000, expect: { timeout: 15_000 }, workers: 1, fullyParallel: false,
  use: { ...devices['Desktop Chrome'], baseURL: `http://localhost:${port}`, viewport: { width: 1440, height: 900 }, acceptDownloads: true },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }], // Playwright's Chromium; no `channel`
  webServer: { command: preview ? `npx vite preview --port ${port} --strictPort` : `npx vite --port ${port} --strictPort`,
               url: `http://localhost:${port}`, reuseExistingServer: false, timeout: 60_000 },
})
