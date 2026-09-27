import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { EnvValidationError } from "@pipeheal/shared";
import { describe, expect, it } from "vitest";
import { loadWebEnv, webEnvSchema } from "./env";

describe("web env", () => {
  it("starts with local-dev defaults when nothing is set", () => {
    expect(loadWebEnv({})).toEqual({ NODE_ENV: "development", APP_URL: "http://localhost:3000" });
  });

  it("rejects an invalid APP_URL", () => {
    expect(() => loadWebEnv({ APP_URL: "localhost:3000" })).toThrow(EnvValidationError);
  });

  it("documents every variable it reads in .env.example", () => {
    const example = readFileSync(
      fileURLToPath(new URL("../../../.env.example", import.meta.url)),
      "utf8",
    );
    for (const key of Object.keys(webEnvSchema.shape)) {
      expect(example).toMatch(new RegExp(`^${key}=`, "m"));
    }
  });
});
