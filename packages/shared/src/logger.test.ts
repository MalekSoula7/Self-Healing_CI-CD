import { describe, expect, it } from "vitest";
import { createLogger } from "./logger";

const TOKEN = "ghs_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8";

function captureLogger() {
  const lines: string[] = [];
  const logger = createLogger(
    { level: "info", service: "test" },
    { write: (line) => lines.push(line) },
  );
  return { logger, output: () => lines.join("") };
}

describe("createLogger", () => {
  it("tags every line with the service name", () => {
    const { logger, output } = captureLogger();
    logger.info("hello");
    expect(JSON.parse(output())).toMatchObject({ service: "test", msg: "hello", level: 30 });
  });

  it("redacts secret keys at any depth and in any casing", () => {
    const { logger, output } = captureLogger();
    logger.info(
      {
        github: { auth: { Token: "deep-token-value" } },
        headers: { Authorization: "Bearer header-value", "x-api-key": "api-key-value" },
        oauth: { access_token: "oauth-access-value", client_secret: "client-secret-value" },
      },
      "request",
    );
    const text = output();
    for (const secret of [
      "deep-token-value",
      "header-value",
      "api-key-value",
      "oauth-access-value",
      "client-secret-value",
    ]) {
      expect(text).not.toContain(secret);
    }
  });

  it("scrubs secrets from the message, format arguments and error messages", () => {
    const { logger, output } = captureLogger();
    logger.info(`clone failed for https://x-access-token:${TOKEN}@github.com/acme/api`);
    logger.warn("retrying with %s", TOKEN);
    logger.error({ error: `upstream said ${TOKEN}` }, "failed");
    expect(output()).not.toContain(TOKEN);
  });

  it("serializes errors without their extra fields", () => {
    const { logger, output } = captureLogger();
    const err = Object.assign(new Error(`request with ${TOKEN} failed`), {
      response: { body: "raw customer log line" },
    });
    logger.error({ err }, "boom");
    const line = output();
    expect(line).not.toContain(TOKEN);
    expect(line).not.toContain("raw customer log line");
    expect(JSON.parse(line)).toMatchObject({ err: { type: "Error" } });
  });

  it("redacts child logger bindings", () => {
    const { logger, output } = captureLogger();
    logger
      .child({ sessionToken: "binding-secret", attemptId: "att_1" })
      .child({ apiKey: "grandchild-secret", step: 2 })
      .info("step");
    const line = output();
    expect(line).not.toContain("binding-secret");
    expect(line).not.toContain("grandchild-secret");
    expect(JSON.parse(line)).toMatchObject({ attemptId: "att_1", step: 2 });
  });

  it("keeps non-secret fields", () => {
    const { logger, output } = captureLogger();
    logger.info({ attemptId: "att_123", repo: "acme/api" }, "dispatched");
    expect(JSON.parse(output())).toMatchObject({ attemptId: "att_123", repo: "acme/api" });
  });
});
