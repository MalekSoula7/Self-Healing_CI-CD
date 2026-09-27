import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { EnvValidationError } from "@pipeheal/shared";
import { describe, expect, it } from "vitest";
import { loadWebEnv, webEnvSchema } from "./env";

describe("web env", () => {
  it("starts with local-dev defaults when nothing is set", () => {
    expect(loadWebEnv({})).toEqual({ NODE_ENV: "development", APP_URL: "http://localhost:3000" });
  });

  it("requires an https APP_URL in production (loopback excepted)", () => {
    expect(() => loadWebEnv({ NODE_ENV: "production" })).toThrow(EnvValidationError);
    expect(() =>
      loadWebEnv({ NODE_ENV: "production", APP_URL: "http://pipeheal.example" }),
    ).toThrow(EnvValidationError);
    expect(
      loadWebEnv({ NODE_ENV: "production", APP_URL: "https://pipeheal.example" }).APP_URL,
    ).toBe("https://pipeheal.example");
    expect(loadWebEnv({ NODE_ENV: "production", APP_URL: "http://127.0.0.1:3100" }).APP_URL).toBe(
      "http://127.0.0.1:3100",
    );
  });

  it("refuses NEXT_PUBLIC_ variables that look like secrets", () => {
    expect(() => loadWebEnv({ NEXT_PUBLIC_GITHUB_CLIENT_SECRET: "x" })).toThrow(
      /NEXT_PUBLIC_GITHUB_CLIENT_SECRET/,
    );
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
