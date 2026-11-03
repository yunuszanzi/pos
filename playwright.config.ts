import "dotenv/config";
import { defineConfig, devices } from "@playwright/test";

// The browser tests start their own API and web server on ports of their own, so they never reuse, or collide with, a
// developer's `npm run dev` (3000 and 5173). Each server is plain `node` with no npm or file-watcher wrapper: on Windows,
// ending a wrapper could leave its child running, and a later run would silently reuse that half-dead server and stall.
const apiPort = 3100;
const webPort = 5180;
process.env.TEST_API_URL = `http://127.0.0.1:${apiPort}`;

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  reporter: "list",
  use: {
    baseURL: `http://127.0.0.1:${webPort}`,
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  // The real stack: Vite, the Hono API and local Supabase (`supabase start`).
  webServer: [
    {
      command: "node --import tsx server/dev.ts",
      url: `http://127.0.0.1:${apiPort}/api/health`,
      env: { API_PORT: String(apiPort) },
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: `node node_modules/vite/bin/vite.js --host 127.0.0.1 --port ${webPort} --strictPort`,
      url: `http://127.0.0.1:${webPort}`,
      env: { API_PORT: String(apiPort) },
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
});
