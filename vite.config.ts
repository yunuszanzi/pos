import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";

// The API this dev server forwards /api to. The browser tests run their own API on a separate port (playwright.config.ts).
const apiPort = Number(process.env.API_PORT ?? 3000);

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
  server: {
    proxy: {
      // 127.0.0.1, not localhost: on Windows localhost can resolve to ::1 while the API listens on IPv4.
      "/api": `http://127.0.0.1:${apiPort}`,
    },
  },
});
