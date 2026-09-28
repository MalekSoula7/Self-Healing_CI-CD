import { createLogger } from "@pipeheal/shared/logger";
import { ZodError } from "zod";
import { describe, expect, it } from "vitest";
import { processWebhookJob, type WebhookProcessorDeps } from "./webhooks";

// Deliberately unusable: validation must fail before any dependency is touched.
const unreachableDeps: WebhookProcessorDeps = {
  db: new Proxy(
    {},
    {
      get: () => {
        throw new Error("db must not be touched");
      },
    },
  ) as never,
  githubApp: new Proxy(
    {},
    {
      get: () => {
        throw new Error("githubApp must not be touched");
      },
    },
  ) as never,
  logger: createLogger({ level: "silent", service: "test" }),
  scheduleWindowClose: () => {
    throw new Error("scheduleWindowClose must not be called");
  },
};

describe("processWebhookJob", () => {
  it("rejects job data that doesn't match the schema, before touching any dependency", async () => {
    await expect(
      processWebhookJob({ id: "x", data: { event: "installation" } }, unreachableDeps),
    ).rejects.toThrow(ZodError);
  });

  it("rejects job data with no payload at all", async () => {
    await expect(
      processWebhookJob({ data: { deliveryId: "x", event: "ping" } }, unreachableDeps),
    ).rejects.toThrow(ZodError);
  });
});
