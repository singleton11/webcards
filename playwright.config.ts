import { defineConfig } from "@playwright/test";
const https = process.env.WEBCARDS_E2E_HTTPS === "1";
const origin = `${https ? "https" : "http"}://127.0.0.1:33117`;
export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.spec.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  use: {
    baseURL: origin,
    ignoreHTTPSErrors: https,
    browserName: "chromium",
    headless: true,
  },
  webServer: {
    command: "node e2e/serve.mjs",
    url: `${origin}/api/session`,
    ignoreHTTPSErrors: https,
    timeout: 120000,
    reuseExistingServer: false,
    // Let the fixture stop PostgreSQL before Playwright force-kills its group.
    gracefulShutdown: { signal: "SIGTERM", timeout: 10000 },
  },
});
