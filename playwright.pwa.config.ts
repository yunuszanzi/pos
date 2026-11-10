import "dotenv/config";
import { defineConfig, devices } from "@playwright/test";

// The production build, served by `vite preview`, with its own API: the service worker only exists in a real build.
const apiPort = 3110;
const webPort = 5190;
process.env.TEST_API_URL = `http://127.0.0.1:${apiPort}`;
process.env.APP_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString("base64");
process.env.FBR_ADAPTER ??= "mock";
process.env.CRON_SECRET ??= "test-cron-secret-0123456789abcdef";

export default defineConfig({
  testDir: "./tests/pwa",
  fullyParallel: false,
  workers: 1,
  timeout: 120_000,
  expect: { timeout: 20_000 },
  reporter: "list",
  use: { baseURL: `http://127.0.0.1:${webPort}`, trace: "retain-on-failure", serviceWorkers: "allow" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    { command: "node --import tsx server/dev.ts", url: `http://127.0.0.1:${apiPort}/api/health`, env: { API_PORT: String(apiPort) }, reuseExistingServer: false, timeout: 180_000 },
    { command: `node node_modules/vite/bin/vite.js build && node node_modules/vite/bin/vite.js preview --host 127.0.0.1 --port ${webPort} --strictPort`, url: `http://127.0.0.1:${webPort}`, env: { API_PORT: String(apiPort) }, reuseExistingServer: false, timeout: 240_000 },
  ],
});
