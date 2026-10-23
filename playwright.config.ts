import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  testMatch: '**/*.e2e.spec.ts',
  timeout: 90000,
  use: {
    baseURL: 'http://localhost:5174',
    channel: 'chrome',
    headless: true,
    viewport: { width: 1280, height: 720 },
    launchOptions: {
      args: ['--enable-webgl', '--ignore-gpu-blocklist', '--use-gl=angle'],
    },
  },
  webServer: [
    {
      command: 'npm run dev:server',
      port: 2567,
      reuseExistingServer: false,
      timeout: 30000,
    },
    {
      command: 'npm run dev:client',
      port: 5174,
      reuseExistingServer: false,
      timeout: 30000,
    },
  ],
});
