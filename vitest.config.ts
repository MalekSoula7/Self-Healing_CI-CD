import { defineConfig } from "vitest/config";

// Two projects:
// - unit: no infrastructure needed (`pnpm test:unit`, also run on Windows CI)
// - integration: `*.int.test.ts`, needs `docker compose up -d` (Postgres, Redis)
// `pnpm test` runs both.
const ignored = ["**/node_modules/**", "**/dist/**", "**/.next/**"];

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
        },
      },
      {
        test: {
          name: "integration",
          environment: "node",
          allowOnly: false,
          include: ["{apps,packages}/*/src/**/*.int.test.ts"],
          exclude: ignored,
        },
      },
    ],
  },
});
