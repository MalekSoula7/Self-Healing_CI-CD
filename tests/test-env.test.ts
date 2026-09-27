// Secrets exported in the developer's shell must not be visible to tests (vitest.config.ts `env`).
import { describe, expect, it } from "vitest";

describe("test environment", () => {
  it.each([
    "ANTHROPIC_API_KEY",
    "BETTER_AUTH_SECRET",
    "GITHUB_APP_PRIVATE_KEY",
    "GITHUB_CLIENT_SECRET",
    "GITHUB_WEBHOOK_SECRET",
    "SMEE_URL",
    "SENTRY_DSN",
  ])("hides %s", (key) => {
    expect(process.env[key] ?? "").toBe("");
  });
});
