import { defineConfig } from '@playwright/test'

// Never attach to a developer/live server. Both processes belong to this run.
const TEST_PORT = '8790'
const WEB_URL = 'http://127.0.0.1:5180'
const API_URL = `http://127.0.0.1:${TEST_PORT}`
process.env.BASE_URL = WEB_URL

export default defineConfig({
  testDir: './tests',
  testMatch: '*.spec.ts',
  timeout: 45_000,
  expect: { timeout: 10_000 },
  reporter: 'list',
  fullyParallel: false,
  workers: 2,
  use: {
    baseURL: WEB_URL,
    // Existing flow assertions use Vietnamese; i18n.spec overrides this with clean storage.
    storageState: { cookies: [], origins: [{ origin: WEB_URL, localStorage: [{ name: 'lumina.locale', value: 'vi' }] }] },
    launchOptions: { executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] },
  },
  webServer: [
    {
      command: 'pnpm exec tsx tests/helpers/mockServer.ts',
      env: { TEST_PORT, BASE_URL: WEB_URL, PROVIDER_MODE: 'mock' },
      url: `${API_URL}/api/health`,
      reuseExistingServer: false,
      timeout: 60_000,
      stdout: 'ignore',
      stderr: 'pipe',
    },
    {
      command: 'pnpm exec vite --host 127.0.0.1 --port 5180 --strictPort',
      env: { BASE_URL: WEB_URL, VITE_API_TARGET: API_URL },
      url: WEB_URL,
      reuseExistingServer: false,
      timeout: 60_000,
      stdout: 'ignore',
      stderr: 'pipe',
    },
  ],
})
