import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";
import "dotenv/config";

// The API this dev server forwards /api to. The browser tests run their own API on a separate port (playwright.config.ts).
const apiPort = Number(process.env.API_PORT ?? 3000);

// `vite preview` (the production build, as the browser tests run it) sends the same security headers Vercel will, from vercel.json,
// so the policy is tested against the real app. The local Supabase is allowed too, where the hosted one is matched by the policy itself.
function productionHeaders(): Record<string, string> {
  const config = JSON.parse(readFileSync(new URL("./vercel.json", import.meta.url), "utf8")) as { headers: Array<{ source: string; headers: Array<{ key: string; value: string }> }> };
  const entries = config.headers.find((entry) => entry.source === "/(.*)")?.headers ?? [];
  return Object.fromEntries(entries.map(({ key, value }) => [key, key === "Content-Security-Policy" && process.env.SUPABASE_URL ? value.replace("connect-src 'self'", `connect-src 'self' ${process.env.SUPABASE_URL}`) : value]));
}

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  // Pages load on demand, so without this a library used by only some of them is found the first time one is opened,
  // re-bundled, and the page reloaded mid-visit. Bundling them when the server starts avoids that.
  optimizeDeps: {
    include: ["@hookform/resolvers/zod", "@supabase/supabase-js", "@tanstack/react-query", "bwip-js/browser", "react-hook-form", "react-router-dom", "zod", "zustand"],
  },
  preview: { headers: productionHeaders() },
  server: {
    proxy: {
      // 127.0.0.1, not localhost: on Windows localhost can resolve to ::1 while the API listens on IPv4.
      "/api": `http://127.0.0.1:${apiPort}`,
    },
  },
});
