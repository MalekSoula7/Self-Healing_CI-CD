// Single flat config for the whole workspace.
// Several CLAUDE.md rules are enforced here rather than trusted:
// no `any`, no @ts-* suppression comments, no eslint-disable comments, no skipped or focused tests.
import js from "@eslint/js";
import nextPlugin from "@next/eslint-plugin-next";
import vitest from "@vitest/eslint-plugin";
import prettier from "eslint-config-prettier";
import { defineConfig, globalIgnores } from "eslint/config";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

export default defineConfig(
  globalIgnores([
    "**/node_modules/**",
    "**/dist/**",
    "**/.next/**",
    "**/.turbo/**",
    "**/coverage/**",
    "**/playwright-report/**",
    "**/test-results/**",
    "**/generated/**",
    "**/next-env.d.ts",
  ]),
  {
    linterOptions: {
      // Inline `eslint-disable` comments are ignored and reported; fix the code instead.
      noInlineConfig: true,
      reportUnusedDisableDirectives: "error",
    },
  },
  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      globals: globals.node,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/ban-ts-comment": [
        "error",
        {
          "ts-check": false,
          "ts-expect-error": true,
          "ts-ignore": true,
          "ts-nocheck": true,
        },
      ],
      "@typescript-eslint/consistent-type-imports": "error",
      "no-console": "error",
    },
  },
  {
    // Test helpers (msw, the network guard) never ship in runtime code.
    files: ["**/*.{ts,tsx}"],
    ignores: [
      "**/*.test.{ts,tsx}",
      "vitest.setup.ts",
      "vitest.integration.setup.ts",
      "packages/shared/src/testing/**",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@pipeheal/shared/testing",
              message: "Test-only helpers: import them from tests only.",
            },
          ],
        },
      ],
    },
  },
  {
    // packages/policy is pure: no I/O, no network, no process access.
    files: ["packages/policy/src/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "node:*",
                "fs",
                "fs/*",
                "path",
                "os",
                "child_process",
                "http",
                "https",
                "net",
                "dns",
                "tls",
                "worker_threads",
              ],
              message: "packages/policy must stay pure: no I/O, network or process access.",
            },
          ],
          paths: [
            {
              name: "@pipeheal/shared/testing",
              message: "Test-only helpers: import them from tests only.",
            },
          ],
        },
      ],
      "no-restricted-globals": [
        "error",
        { name: "process", message: "packages/policy must not read process state." },
        { name: "fetch", message: "packages/policy must not do network calls." },
      ],
    },
  },
  {
    // Next.js rules and React hooks rules. eslint-config-next is not used: its react, import and
    // jsx-a11y plugins do not support ESLint 10 (SPEC §4.2).
    files: ["apps/web/**/*.{ts,tsx}"],
    extends: [nextPlugin.configs["core-web-vitals"], reactHooks.configs.flat["recommended-latest"]],
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
    settings: { next: { rootDir: "apps/web/" } },
  },
  {
    files: ["**/*.test.ts", "**/*.test.tsx"],
    plugins: { vitest },
    rules: {
      ...vitest.configs.recommended.rules,
      "vitest/no-disabled-tests": "error",
      "vitest/no-focused-tests": "error",
    },
  },
  {
    // Playwright specs: same rule as Vitest, no skipped, focused or fixme tests.
    files: ["apps/web/e2e/**/*.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "CallExpression[callee.type='MemberExpression'][callee.property.name=/^(only|skip|fixme)$/]",
          message: "No skipped, focused or fixme tests (CLAUDE.md).",
        },
      ],
    },
  },
  {
    files: ["**/*.{js,mjs,cjs}"],
    extends: [tseslint.configs.disableTypeChecked],
  },
  prettier,
);
