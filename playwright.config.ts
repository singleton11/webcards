import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.spec.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  use: {
    baseURL: "http://127.0.0.1:33117",
    browserName: "chromium",
    headless: true,
  },
  webServer: {
    command: "node e2e/serve.mjs",
    url: "http://127.0.0.1:33117/login",
    timeout: 120000,
    reuseExistingServer: false,
    // Let the fixture stop PostgreSQL before Playwright force-kills its group.
    gracefulShutdown: { signal: "SIGTERM", timeout: 10000 },
  },
});
