import { defineConfig } from "vitest/config";

// Two projects:
// - unit: no infrastructure needed (`pnpm test:unit`, also run on Windows CI). Every HTTP request
//   goes through msw and unmocked requests fail (vitest.setup.ts), so unit tests never hit the network.
// - integration: `*.int.test.ts`, needs `docker compose up -d` (Postgres, Redis).
// `pnpm test` runs both with coverage.
const ignored = ["**/node_modules/**", "**/dist/**", "**/.next/**"];
// Secrets from the developer's shell or .env never reach tests (empty counts as unset in parseEnv).
const blankSecrets = {
  ANTHROPIC_API_KEY: "",
  BETTER_AUTH_SECRET: "",
  GITHUB_APP_PRIVATE_KEY: "",
  GITHUB_CLIENT_SECRET: "",
  GITHUB_WEBHOOK_SECRET: "",
  SMEE_URL: "",
  SENTRY_DSN: "",
};
const strictCoverage = { lines: 95, functions: 95, branches: 95, statements: 95 };

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          environment: "node",
          allowOnly: false,
          include: ["tests/**/*.test.ts", "{apps,packages}/*/src/**/*.test.{ts,tsx}"],
          exclude: [...ignored, "**/*.int.test.ts"],
          setupFiles: ["./vitest.setup.ts"],
          env: blankSecrets,
        },
      },
      {
        test: {
          name: "integration",
          environment: "node",
          allowOnly: false,
          include: ["{apps,packages}/*/src/**/*.int.test.ts"],
          exclude: ignored,
          env: blankSecrets,
        },
      },
    ],
    coverage: {
      provider: "v8",
      include: ["{apps,packages}/*/src/**/*.{ts,tsx}"],
      exclude: ["**/*.test.{ts,tsx}", "**/testing/**", "**/generated/**"],
      reporter: ["text-summary", "html"],
      // CLAUDE.md: packages/policy and the agent-core parsers keep >= 95% coverage.
      thresholds: {
        "packages/policy/src/**": strictCoverage,
        "packages/agent-core/src/**": strictCoverage,
      },
    },
  },
});
