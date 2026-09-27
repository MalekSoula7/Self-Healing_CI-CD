// Single flat config for the whole workspace.
// Several CLAUDE.md rules are enforced here rather than trusted:
// no `any`, no @ts-* suppression comments, no eslint-disable comments, no skipped or focused tests.
import js from "@eslint/js";
import vitest from "@vitest/eslint-plugin";
import prettier from "eslint-config-prettier";
import { defineConfig, globalIgnores } from "eslint/config";
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
    files: ["**/*.test.ts", "**/*.test.tsx"],
    plugins: { vitest },
    rules: {
      ...vitest.configs.recommended.rules,
      "vitest/no-disabled-tests": "error",
      "vitest/no-focused-tests": "error",
    },
  },
  {
    files: ["**/*.{js,mjs,cjs}"],
    extends: [tseslint.configs.disableTypeChecked],
  },
  prettier,
);
