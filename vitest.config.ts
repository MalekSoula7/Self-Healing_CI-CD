import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Two projects:
// - unit: no infrastructure needed (`pnpm test:unit`, also run on Windows CI). Every HTTP request
//   goes through msw and unmocked requests fail (vitest.setup.ts), so unit tests never hit the network.
// - integration: `*.int.test.ts`, needs `docker compose up -d` (Postgres, Redis). Runs against a
//   separate `pipeheal_test` database, recreated on every run.
// - perf: `*.perf.test.ts`, speed budgets that guard against quadratic regressions. Runs after the
//   other projects (a later `groupOrder`), so parallel test files can't eat its budgets.
// Groups run in order: unit (half the cores), then integration (6 files at a time: more starved
// Postgres and timed transactions out), then perf.
// `pnpm test` runs all three with coverage; `pnpm test:unit` runs unit and perf.
const ignored = ["**/node_modules/**", "**/dist/**", "**/.next/**"];
// Secrets from the developer's shell or .env never reach tests (empty counts as unset in parseEnv).
const blankSecrets = {
  BETTER_AUTH_SECRET: "",
  GITHUB_APP_PRIVATE_KEY: "",
  GITHUB_CLIENT_SECRET: "",
  GITHUB_WEBHOOK_SECRET: "",
  SMEE_URL: "",
  SENTRY_DSN: "",
};
// "server-only" throws unless bundled by Next.js for the server; tests run outside that bundler.
// "@/" is apps/web's import alias (apps/web/tsconfig.json).
const resolve = {
  alias: [
    {
      find: "server-only",
      replacement: fileURLToPath(new URL("./tests/stubs/server-only.ts", import.meta.url)),
    },
    { find: /^@\//, replacement: fileURLToPath(new URL("./apps/web/src/", import.meta.url)) },
  ],
};
const strictCoverage = { lines: 95, functions: 95, branches: 95, statements: 95 };

export default defineConfig({
  test: {
    projects: [
      {
        resolve,
        test: {
          name: "unit",
          environment: "node",
          allowOnly: false,
          include: [
            "tests/**/*.test.ts",
            "scripts/**/*.test.ts",
            "{apps,packages}/*/src/**/*.test.{ts,tsx}",
          ],
          exclude: [...ignored, "**/*.int.test.ts", "**/*.perf.test.ts"],
          setupFiles: ["./vitest.setup.ts"],
          env: blankSecrets,
          // Half the cores: one file per core, with coverage, starved the CPU-bound tests (key
          // generation, property tests) past their timeouts at random.
          maxWorkers: "50%",
        },
      },
      {
        resolve,
        test: {
          name: "integration",
          environment: "node",
          allowOnly: false,
          include: ["{apps,packages}/*/src/**/*.int.test.ts"],
          exclude: ignored,
          setupFiles: ["./vitest.integration.setup.ts"],
          // Recreates and migrates the pipeheal_test database once per run.
          globalSetup: ["./vitest.integration.globalSetup.ts"],
          // A few files at a time: one per core starved Postgres (in Docker) and the unit tests
          // running alongside, and transactions timed out waiting for a connection.
          maxWorkers: 6,
          // Its own group, after the unit tests (vitest requires one for a different maxWorkers).
          sequence: { groupOrder: 1 },
          env: blankSecrets,
        },
      },
      {
        resolve,
        test: {
          name: "perf",
          environment: "node",
          allowOnly: false,
          include: ["{apps,packages}/*/src/**/*.perf.test.ts"],
          exclude: ignored,
          setupFiles: ["./vitest.setup.ts"],
          env: blankSecrets,
          sequence: { groupOrder: 2 },
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
