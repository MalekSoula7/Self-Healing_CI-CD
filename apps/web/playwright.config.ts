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
    // `next start` runs in production mode, which requires APP_URL (loopback may use http).
    env: { APP_URL: baseURL },
    timeout: 180_000,
  },
});
