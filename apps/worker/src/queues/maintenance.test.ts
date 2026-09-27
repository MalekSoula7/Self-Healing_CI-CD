import { UnrecoverableError } from "bullmq";
import { pino } from "pino";
import { ZodError } from "zod";
import { describe, expect, it } from "vitest";
import { processMaintenanceJob } from "./maintenance";

const logger = pino({ level: "silent" });

describe("processMaintenanceJob", () => {
  it("answers a ping", () => {
    const requestedAt = "2026-09-27T12:00:00.000Z";
    expect(processMaintenanceJob({ id: "1", name: "ping", data: { requestedAt } }, logger)).toEqual(
      {
        pong: true,
        requestedAt,
      },
    );
  });

  it("rejects a ping with invalid data", () => {
    expect(() =>
      processMaintenanceJob({ id: "2", name: "ping", data: { requestedAt: "yesterday" } }, logger),
    ).toThrow(ZodError);
  });

  it("fails unknown job types without retrying", () => {
    expect(() => processMaintenanceJob({ id: "3", name: "reindex", data: {} }, logger)).toThrow(
      UnrecoverableError,
    );
  });
});
