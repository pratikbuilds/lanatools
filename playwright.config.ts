import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests/e2e',
  workers: 1,
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  use: { baseURL: 'http://127.0.0.1:4173', trace: 'retain-on-failure' },
  webServer: {
    command: 'bun run --cwd apps/web preview --host 127.0.0.1',
    url: 'http://127.0.0.1:4173',
    env: { API_PROXY_TARGET: 'http://127.0.0.1:3101' },
    reuseExistingServer: false,
  },
})
