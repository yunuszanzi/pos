import "dotenv/config";
import { defineConfig, devices } from "@playwright/test";

const apiPort = Number(process.env.API_PORT ?? 3000);
process.env.TEST_API_URL = `http://127.0.0.1:${apiPort}`;

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:5173",
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  // The e2e suite runs the real stack: Vite, the Hono API and local Supabase (`supabase start`).
  webServer: [
    {
      command: "npm run dev:api",
      url: `http://127.0.0.1:${apiPort}/api/health`,
      reuseExistingServer: !process.env.CI,
    },
    {
      command: "npm run dev -- --host 127.0.0.1",
      url: "http://127.0.0.1:5173",
      reuseExistingServer: !process.env.CI,
    },
  ],
});
