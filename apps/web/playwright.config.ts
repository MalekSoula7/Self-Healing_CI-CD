import { randomBytes } from "node:crypto";
import { defineConfig, devices } from "@playwright/test";

// End-to-end tests run against a production build on its own port, so they never collide with
// `pnpm dev`. Browsers come from `pnpm exec playwright install chromium`; a sandbox with a
// preinstalled Chromium can point PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH at it instead.
const port = 3100;
const baseURL = `http://127.0.0.1:${String(port)}`;
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;

export default defineConfig({
  testDir: "./e2e",
  forbidOnly: true,
  fullyParallel: true,
  // No retries: a flaky e2e test is a bug to fix, not to hide.
  retries: 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: { baseURL, trace: "retain-on-failure" },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        launchOptions: executablePath ? { executablePath } : {},
      },
    },
  ],
  webServer: {
    command: `pnpm run build && pnpm exec next start --port ${String(port)}`,
    url: `${baseURL}/api/health`,
    reuseExistingServer: false,
    // `next start` runs in production mode, which requires every setting (loopback hosts may use
    // http and no TLS). Sign-in settings are throwaway values: e2e never reaches GitHub, and only
    // covers signed-out pages, which never query the database (the e2e CI job has none).
    env: {
      APP_URL: baseURL,
      DATABASE_URL: "postgresql://pipeheal:pipeheal@localhost:5432/pipeheal",
      BETTER_AUTH_SECRET: randomBytes(32).toString("base64url"),
      GITHUB_CLIENT_ID: "e2e-client-id",
      GITHUB_CLIENT_SECRET: "e2e-not-a-secret",
    },
    timeout: 180_000,
  },
});
