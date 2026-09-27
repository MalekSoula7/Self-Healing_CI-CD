import { describe, expect, it } from "vitest";
import { createLogger } from "./logger";

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

  it("redacts secrets at the top level, one level down, and in request headers", () => {
    const { logger, output } = captureLogger();
    logger.info(
      {
        token: "ghs_topLevelInstallationToken",
        session: { sessionToken: "phs_nestedSessionToken" },
        github: { privateKey: "-----BEGIN PRIVATE KEY-----abc" },
        anthropic: { apiKey: "sk-ant-nestedApiKey" },
        req: { headers: { authorization: "Bearer requestBearerToken", cookie: "sid=cookieValue" } },
      },
      "request",
    );
    const text = output();
    for (const secret of [
      "ghs_topLevelInstallationToken",
      "phs_nestedSessionToken",
      "BEGIN PRIVATE KEY",
      "sk-ant-nestedApiKey",
      "requestBearerToken",
      "cookieValue",
    ]) {
      expect(text).not.toContain(secret);
    }
    expect(text).toContain("[redacted]");
  });

  it("keeps non-secret fields", () => {
    const { logger, output } = captureLogger();
    logger.info({ attemptId: "att_123", repo: "acme/api" }, "dispatched");
    expect(JSON.parse(output())).toMatchObject({ attemptId: "att_123", repo: "acme/api" });
  });
});
